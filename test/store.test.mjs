/**
 * The primary export path: WhatsApp's message store, read through the page bridge.
 *
 * A mock of the internals found on WhatsApp Web 2026-11 (scripts/wa-internals-probe.js):
 * `require('WAWebCollections').Chat.getActive()`, `chat.msgs` with `msgLoadState`,
 * models storing attributes as `__x_<name>`, `WAWebChatLoadMessages.loadEarlierMsgs`,
 * and media downloaded the way a click does (`msg.forceDownloadMediaEvenIfExpensive()`,
 * then `mediaData.mediaBlob.forceToBlob()`; scripts/wa-download-probe.js).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  createEnv,
  loadScripts,
  CONTENT_FILES,
  fastHistoryLimits,
  makeChrome,
  waitFor,
  saveDownload,
  suite,
  checkAsync,
  eq,
  ok,
  summary,
} from './harness.mjs';
import { buildFixtureHtml } from './fixture.mjs';

const OUT = path.join(ROOT, 'test', 'out');
const T0 = Date.UTC(2026, 9, 14, 7, 14) / 1000; // 14 Oct 2026, seconds

class Model {
  constructor(attrs) {
    for (const [k, v] of Object.entries(attrs)) this['__x_' + k] = v;
  }
}

const RICHARD = { user: '15550001111', server: 'c.us', _serialized: '15550001111@c.us' };
const ME = { user: '15550002222', server: 'c.us', _serialized: '15550002222@c.us' };

function msg(n, attrs) {
  const fromMe = Boolean(attrs.fromMe);
  return new Model({
    id: { fromMe, remote: RICHARD, id: 'M' + n, _serialized: `${fromMe}_15550001111@c.us_M${n}` },
    t: T0 + n * 60,
    from: fromMe ? ME : RICHARD,
    ...attrs,
  });
}

function buildStore({ downloads, failLoader = false, idleLoader = false, allStuck = false } = {}) {
  const older = [
    msg(1, { type: 'e2e_notification' }),
    msg(2, { type: 'chat', body: 'First message, loaded only on request.' }),
  ];
  const loaded = [
    msg(3, { type: 'chat', body: 'Line one\nLine two\nLine three', fromMe: true }),
    // An album is separate image messages in the store; never opened, so no blob URL.
    msg(4, { type: 'image', caption: 'Album 1', mediaKey: 'k4', directPath: '/p4', mimetype: 'image/jpeg', body: '/9j/THUMBNAIL' }),
    msg(5, { type: 'image', mediaKey: 'k5', directPath: '/p5', mimetype: 'image/jpeg', body: '/9j/THUMBNAIL' }),
    msg(6, { type: 'image', mediaKey: 'k6', directPath: '/p6', mimetype: 'image/jpeg' }),
    msg(7, { type: 'image', mediaKey: 'k7', directPath: '/p7', mimetype: 'image/jpeg' }),
    msg(8, { type: 'image', mediaKey: 'k8', directPath: '/p8', mimetype: 'image/jpeg' }),
    msg(9, { type: 'sticker', mediaKey: 'k9', directPath: '/p9', mimetype: 'image/webp' }),
    msg(10, { type: 'revoked' }),
    msg(11, {
      type: 'chat',
      body: 'Replying to you',
      quotedMsg: new Model({ type: 'chat', body: 'Line one\nLine two\nLine three' }),
      quotedParticipant: ME,
      hasReaction: true,
    }),
    msg(12, { type: 'document', filename: 'report.pdf', mimetype: 'application/pdf', mediaKey: 'k12', directPath: '/p12', fromMe: true }),
    msg(13, { type: 'call_log', isVideoCall: false }),
  ];

  // Media, as on the live build: one already opened (RESOLVED), the rest downloaded on
  // request, one stuck waiting for the phone to re-send it (NEED_POKE).
  const blobFor = (n) => ({ forceToBlob: () => new Blob([new Uint8Array(512).fill(n)], { type: 'application/octet-stream' }) });
  for (const m of loaded) {
    if (!m.__x_mediaKey) continue;
    const n = Number(m.__x_id.id.slice(1));
    m.__x_mediaData = new Model({ mediaStage: n === 4 ? 'RESOLVED' : 'INIT', mediaBlob: n === 4 ? blobFor(n) : null });
    m.forceDownloadMediaEvenIfExpensive = async () => {
      downloads.push(n);
      if (n === 8 || allStuck) {
        // Waiting on the phone: WhatsApp's call never settles. The bridge must not hang.
        m.__x_mediaData.__x_mediaStage = 'NEED_POKE';
        return new Promise(() => {});
      }
      m.__x_mediaData.__x_mediaStage = 'RESOLVED';
      m.__x_mediaData.__x_mediaBlob = blobFor(n);
    };
  }

  const state = new Model({ noEarlierMsgs: false, isLoadingEarlierMsgs: false });
  const list = [...loaded];
  const msgs = { getModelsArray: () => list, msgLoadState: state };
  const chat = new Model({ id: RICHARD, formattedTitle: 'Richard Roe', isGroup: false });
  chat.msgs = msgs;

  const modules = {
    WAWebCollections: {
      Chat: { getActive: () => chat },
      Contact: {
        get: (wid) => (wid === RICHARD ? new Model({ name: 'Richard Roe' }) : new Model({ pushname: 'Sam' })),
        getMeContact: () => new Model({ id: ME }),
      },
      Reactions: {
        get: (id) =>
          /_M11$/.test(id)
            ? new Model({ reactions: [new Model({ aggregateEmoji: '👍', senders: [1, 2] })] })
            : null,
      },
    },
    WAWebChatLoadMessages: {
      loadEarlierMsgs: async (c) => {
        if (failLoader) throw new Error('loader changed');
        if (idleLoader) return;
        if (c !== chat) throw new Error('wrong argument');
        list.unshift(...older);
        state.__x_noEarlierMsgs = true;
      },
    },
  };
  return {
    chat,
    require: (name) => {
      if (modules[name]) return modules[name];
      throw new Error(`Requiring unknown module "${name}"`);
    },
  };
}

function bootStorePage(options = {}) {
  const mediaRequests = [];
  const env = createEnv(buildFixtureHtml({ title: 'Richard Roe' }));
  const store = buildStore({ downloads: mediaRequests, ...options });
  if (!options.noRequire) env.window.require = store.require;
  env.window.__waxMediaWaitMs = 200;
  const mock = makeChrome(env.window);
  loadScripts(env.window, [...CONTENT_FILES, 'src/page/bridge.js', 'src/content/content.js']);
  fastHistoryLimits(env.window);
  env.window.WAEx.internal.LIMITS.scrollWaitMs = 20;
  const scroller = env.window.document.getElementById('msg-scroller');
  scroller.__scrollHeight = 1200;
  scroller.__clientHeight = 600;
  return { ...env, mock, mediaRequests, WAEx: env.window.WAEx };
}

async function runExport(page, settings) {
  const before = page.mock.sent.filter((m) => m.type === 'WAX:RESULT').length;
  const accepted = await page.mock.dispatch({ type: 'WAX:EXPORT', settings });
  eq(accepted, { accepted: true });
  return waitFor(() => page.mock.sent.filter((m) => m.type === 'WAX:RESULT')[before], 30000, 'export result');
}

suite('store: WhatsApp message store via the page bridge');

let jsonExport;
await checkAsync('exports every message from the store, loading earlier history first', async () => {
  const page = bootStorePage();
  const result = await runExport(page, { format: 'json', mediaMode: 'link', includeSystem: true });
  ok(result.ok, JSON.stringify(result.error));
  ok(!result.warnings.some((w) => /from the screen/.test(w)), 'no fallback: ' + JSON.stringify(result.warnings));
  jsonExport = JSON.parse(await page.downloads[0].blob.text());
  eq(jsonExport.messages.length, 13, 'all 13, including the 2 loaded on request');
  eq(jsonExport.chat.isGroup, false);
  page.dom.window.close();
});

await checkAsync('direction, authors, text and types come from the store', async () => {
  const byId = (n) => jsonExport.messages.find((m) => m.id.endsWith('_M' + n));
  eq(byId(2).author, 'Richard Roe');
  eq(byId(2).direction, 'incoming');
  eq(byId(3).author, 'You');
  eq(byId(3).direction, 'outgoing');
  eq(byId(3).text, 'Line one\nLine two\nLine three', 'multi-line text is whole');
  eq(jsonExport.messages.filter((m) => m.type === 'image').length, 5, 'each album photo is its own message');
  eq(byId(4).text, 'Album 1', 'caption, not the base64 thumbnail in body');
  eq(byId(5).text, '', 'no caption: no text');
  eq(byId(10).type, 'deleted');
  eq(byId(10).text, 'This message was deleted');
  eq(byId(11).quoted, { author: 'You', text: 'Line one\nLine two\nLine three' });
  eq(byId(11).reactions, [{ emoji: '👍', count: 2 }]);
  eq(byId(13).type, 'system');
  eq(byId(13).text, 'Voice call');
  eq(
    jsonExport.messages.map((m) => m.id.replace(/.*_M/, '')),
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'],
    'in time order'
  );
});

await checkAsync('downloads media that was never opened, the way a click does', async () => {
  const page = bootStorePage();
  const result = await runExport(page, { format: 'html', mediaMode: 'download', includeSystem: false });
  ok(result.ok, JSON.stringify(result.error));
  eq(result.mediaCaptured, 6, '4 photos, 1 sticker, 1 document: ' + JSON.stringify(result.warnings));
  eq(page.mediaRequests.sort((a, b) => a - b), [5, 6, 7, 8, 9, 12], 'the opened photo is read, not downloaded again');
  // Live bug: "Saving media 943 of 71" — the message count leaked into the media counter.
  const mediaProgress = page.mock.sent.filter((m) => m.type === 'WAX:PROGRESS' && m.phase === 'media');
  ok(mediaProgress.length > 1, 'media progress was reported');
  eq(mediaProgress.filter((m) => m.loaded > m.total).map((m) => `${m.loaded} of ${m.total}`), [], 'never more done than total');
  eq(mediaProgress[0].loaded, 0, 'the media counter starts at 0');
  eq(mediaProgress[mediaProgress.length - 1].loaded, 7, 'and ends at the number of items');
  ok(
    result.warnings.some((w) => /^Could not save one image file: WhatsApp could not download it \(timed out \(stage NEED_POKE/.test(w)),
    'the stuck one is reported: ' + JSON.stringify(result.warnings)
  );
  eq(page.downloads.length, 1);
  ok(page.downloads[0].filename.endsWith('.zip'), page.downloads[0].filename);
  eq(page.downloads.length && page.downloads[0].blob.size > 6 * 512, true, 'the zip holds the media bytes');
  const file = await saveDownload(OUT, page.downloads[0]);
  const names = execFileSync(
    'python3',
    ['-I', '-c', 'import sys,zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', file],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n');
  fs.rmSync(file, { force: true });
  eq(names.filter((n) => n.startsWith('media/')).length, 6, JSON.stringify(names));
  ok(names.some((n) => /report\.pdf$/.test(n)), 'documents keep their file name');
  eq(names.filter((n) => /\.bin$/.test(n)), [], 'a generic blob type still gives a real extension');
  ok(names.some((n) => /-sticker\.webp$/.test(n)), JSON.stringify(names));
  page.dom.window.close();
});

await checkAsync('when the store is unreachable, the screen is read instead', async () => {
  const page = bootStorePage({ noRequire: true });
  const result = await runExport(page, { format: 'json', mediaMode: 'skip' });
  ok(result.ok, JSON.stringify(result.error));
  const data = JSON.parse(await page.downloads[0].blob.text());
  eq(data.messages.length, 10, 'the fixture page messages');
  page.dom.window.close();
});

await checkAsync('when WhatsApp renamed its loader, history still loads by scrolling', async () => {
  const page = bootStorePage({ failLoader: true });
  const scroller = page.window.document.getElementById('msg-scroller');
  let scrolledToTop = 0;
  scroller.__onScrollTop = (v) => {
    if (v === 0) scrolledToTop++;
  };
  const result = await runExport(page, { format: 'json', mediaMode: 'skip', includeSystem: true });
  ok(result.ok, JSON.stringify(result.error));
  ok(scrolledToTop > 0, 'fell back to scrolling the list');
  ok(
    result.warnings.some((w) => /stopped returning older messages/.test(w)),
    'the mock never loads on scroll, so the stall is reported: ' + JSON.stringify(result.warnings)
  );
  const data = JSON.parse(await page.downloads[0].blob.text());
  eq(data.messages.length, 11, 'everything that was loaded is still exported from the store');
  page.dom.window.close();
});

await checkAsync('a loader that runs but loads nothing gives way to scrolling', async () => {
  const page = bootStorePage({ idleLoader: true });
  const scroller = page.window.document.getElementById('msg-scroller');
  let scrolledToTop = 0;
  scroller.__onScrollTop = (v) => {
    if (v === 0) scrolledToTop++;
  };
  const result = await runExport(page, { format: 'json', mediaMode: 'skip' });
  ok(result.ok, JSON.stringify(result.error));
  ok(scrolledToTop > 0, 'switched to scrolling after the loader brought nothing');
});

await checkAsync('the popup card counts what WhatsApp has loaded, not what is on screen', async () => {
  // Live: "96 messages loaded" for a chat with 941 loaded (the page renders a window).
  const page = bootStorePage();
  const before = await page.mock.dispatch({ type: 'WAX:PING' });
  eq(before.chat.renderedCount, 11, 'the 11 messages in the store, not the 10 rows on the page');
  eq(before.chat.isGroup, false);
  eq(before.chat.fullHistory, false, 'earlier messages remain');
  ok(before.chat.dateRange && before.chat.dateRange.start < before.chat.dateRange.end, JSON.stringify(before.chat.dateRange));
  await runExport(page, { format: 'json', mediaMode: 'skip' });
  const after = await page.mock.dispatch({ type: 'WAX:PING' });
  eq(after.chat.renderedCount, 13, 'history loaded by the export is counted');
  eq(after.chat.fullHistory, true, 'and the popup can say it is the whole chat');
  page.dom.window.close();
});

await checkAsync('every download is started at once, before any is read', async () => {
  const page = bootStorePage();
  const prefetched = [];
  const real = page.WAEx.internal.prefetchMedia;
  page.WAEx.internal.prefetchMedia = async (ids) => {
    prefetched.push(...ids);
    const result = await real(ids);
    eq(page.mediaRequests.length, 6, 'all downloads started together (the opened photo needs none)');
    eq(result.started, 6);
    return result;
  };
  const result = await runExport(page, { format: 'json', mediaMode: 'download' });
  ok(result.ok, JSON.stringify(result.error));
  eq(prefetched.length, 7, 'every media message was handed to the prefetch');
  eq(page.mediaRequests.length, 6, 'each download started once, not again when read');
  page.dom.window.close();
});

await checkAsync('stuck downloads overlap instead of queueing', async () => {
  // Live: 20 of 74 media items wait on the phone. Started three at a time with 30 s each,
  // they alone took minutes. Started together, later ones only wait out the remainder.
  const page = bootStorePage({ allStuck: true });
  page.window.__waxMediaWaitMs = 600;
  const startedAt = Date.now();
  const result = await runExport(page, { format: 'json', mediaMode: 'download' });
  const elapsed = Date.now() - startedAt;
  ok(result.ok, JSON.stringify(result.error));
  eq(result.mediaCaptured, 1, 'only the already-opened photo');
  // Measured: ~770 ms started together, ~1,500 ms started three at a time.
  ok(elapsed < 2 * 600, `6 stuck items took ${elapsed} ms; started three at a time they take ~1,500 ms`);
  page.dom.window.close();
});

process.exit(summary() ? 0 : 1);
