/**
 * The primary export path: WhatsApp's message store, read through the page bridge.
 *
 * A mock of the internals found on WhatsApp Web 2026-11 (scripts/wa-internals-probe.js):
 * `require('WAWebCollections').Chat.getActive()`, `chat.msgs` with `msgLoadState`,
 * models storing attributes as `__x_<name>`, `WAWebChatLoadMessages.loadEarlierMsgs`
 * and `WAWebDownloadManager.downloadManager.downloadAndMaybeDecrypt`.
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

function buildStore({ downloads, failLoader = false, idleLoader = false } = {}) {
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
    WAWebDownloadManager: {
      downloadManager: {
        downloadAndMaybeDecrypt: async (args) => {
          downloads.push(args.directPath);
          ok(args.mediaKey && args.type, 'download request carries the media key and type');
          return new Uint8Array(512).fill(downloads.length).buffer;
        },
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

await checkAsync('downloads media that was never opened, through WhatsApp', async () => {
  const page = bootStorePage();
  const result = await runExport(page, { format: 'html', mediaMode: 'download', includeSystem: false });
  ok(result.ok, JSON.stringify(result.error));
  eq(result.mediaCaptured, 7, '5 photos, 1 sticker, 1 document: ' + JSON.stringify(result.warnings));
  eq(page.mediaRequests.length, 7, 'each one asked WhatsApp for its media');
  eq(page.downloads.length, 1);
  ok(page.downloads[0].filename.endsWith('.zip'), page.downloads[0].filename);
  eq(page.downloads.length && page.downloads[0].blob.size > 7 * 512, true, 'the zip holds the media bytes');
  const file = await saveDownload(OUT, page.downloads[0]);
  const names = execFileSync(
    'python3',
    ['-I', '-c', 'import sys,zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', file],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n');
  fs.rmSync(file, { force: true });
  eq(names.filter((n) => n.startsWith('media/')).length, 7, JSON.stringify(names));
  ok(names.some((n) => /report\.pdf$/.test(n)), 'documents keep their file name');
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

process.exit(summary() ? 0 : 1);
