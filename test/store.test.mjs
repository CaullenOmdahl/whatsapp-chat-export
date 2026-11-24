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

function buildStore({
  downloads,
  failLoader = false,
  idleLoader = false,
  allStuck = false,
  loaderNeedsMsgs = false,
  preloaded = false,
  emptyLoaderCalls = 0,
  loaderDelayMs = 0,
} = {}) {
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

  // Media, as on the live build (scripts/wa-full-probe.js, 2026-11): a finished download is
  // put on mediaObject.mediaBlob and freed (autoreleased) soon after; the file stays in the
  // media cache (WAWebMediaStore.LruMediaStore) under its filehash. The photo opened before
  // the export is only in the cache. One item waits on the phone forever, one is re-sent
  // slowly, and the document only comes through as the download promise's result.
  const cache = new Map();
  const bytes = (n) => new Uint8Array(512).fill(n).buffer;
  const mediaBlobFor = (n) => ({
    released: false,
    forceToBlob() {
      if (this.released) throw new Error('MediaBlob released');
      return new Blob([bytes(n)], { type: 'application/octet-stream' });
    },
    autorelease() {
      this.released = true;
    },
  });
  for (const m of loaded) {
    if (!m.__x_mediaKey) continue;
    const n = Number(m.__x_id.id.slice(1));
    const filehash = 'hash' + n;
    m.__x_mediaData = new Model({ mediaStage: n === 4 ? 'RESOLVED' : 'INIT', mediaBlob: null, filehash });
    m.__x_mediaObject = { mediaBlob: null, downloadPromise: null, getDownloadPromise() { return this.downloadPromise; } };
    if (n === 4) cache.set(filehash, { key: filehash, value: bytes(n) });
    const finish = () => {
      // As WhatsApp does: consolidate, render, then free the in-memory copy.
      const blob = mediaBlobFor(n);
      m.__x_mediaObject.mediaBlob = blob;
      m.__x_mediaData.__x_mediaStage = 'RESOLVED';
      if (n !== 12) cache.set(filehash, { key: filehash, value: bytes(n) });
      setTimeout(() => {
        blob.autorelease();
        m.__x_mediaObject.mediaBlob = null;
      }, 30);
      return blob;
    };
    m.forceDownloadMediaEvenIfExpensive = async () => {
      downloads.push(n);
      if (n === 8 || allStuck) {
        // n 8: expired on WhatsApp's servers (NEED_POKE); live, a click from the web never
        // fetches it. allStuck: downloads that hang for another reason (stage stays INIT).
        // Either way WhatsApp's call never settles, and the bridge must not hang.
        if (!allStuck) m.__x_mediaData.__x_mediaStage = 'NEED_POKE';
        return new Promise(() => {});
      }
      if (n === 6) {
        // Expired on the server: the phone re-sends it, slower than the base time limit,
        // but each stage change shows progress.
        m.__x_mediaData.__x_mediaStage = 'NEED_POKE';
        setTimeout(() => (m.__x_mediaData.__x_mediaStage = 'REUPLOADING'), 250);
        setTimeout(finish, 620);
        return;
      }
      if (n === 12) {
        // Not cached: only the download promise's own result carries the file.
        m.__x_mediaObject.downloadPromise = new Promise((resolve) => setTimeout(() => resolve(finish()), 20));
        return;
      }
      finish();
    };
  }

  // preloaded: the whole chat is already in memory (scrolled through beforehand).
  const state = new Model({ noEarlierMsgs: preloaded, isLoadingEarlierMsgs: false });
  const list = preloaded ? [...older, ...loaded] : [...loaded];
  let loaderCalls = 0;
  const msgs = { getModelsArray: () => list, msgLoadState: state };
  const chat = new Model({ id: RICHARD, formattedTitle: 'Jordan Roe', isGroup: false });
  chat.msgs = msgs;

  const modules = {
    WAWebCollections: {
      Chat: { getActive: () => chat },
      Contact: {
        get: (wid) => (wid === RICHARD ? new Model({ name: 'Jordan Roe' }) : new Model({ pushname: 'Sam' })),
        getMeContact: () => new Model({ id: ME }),
      },
      Reactions: {
        get: (id) =>
          /_M11$/.test(id)
            ? new Model({ reactions: [new Model({ aggregateEmoji: '👍', senders: [1, 2] })] })
            : null,
      },
    },
    WAWebMediaStore: { LruMediaStore: { get: async (key) => cache.get(key) || null } },
    WAWebChatLoadMessages: {
      loadEarlierMsgs: async function (c) {
        if (failLoader) throw new Error('loader changed');
        if (idleLoader) return;
        if (c !== chat) throw new Error('wrong argument');
        if (loaderNeedsMsgs && arguments[1] !== msgs) return []; // runs, loads nothing
        // A fresh tab: older history is still on its way from WhatsApp's servers.
        if (loaderCalls++ < emptyLoaderCalls) return [];
        if (loaderDelayMs) await new Promise((r) => setTimeout(r, loaderDelayMs));
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
  const env = createEnv(buildFixtureHtml({ title: 'Jordan Roe' }));
  const store = buildStore({ downloads: mediaRequests, ...options });
  if (!options.noRequire) env.window.require = store.require;
  // Media time limit for tests. The slow re-sent photo below needs longer than this, so it
  // only arrives if progress (stage changes) extends the limit.
  env.window.__waxMediaWaitMs = 400;
  const mock = makeChrome(env.window);
  loadScripts(env.window, [...CONTENT_FILES, 'src/page/bridge.js', 'src/content/content.js']);
  fastHistoryLimits(env.window);
  env.window.WAEx.internal.LIMITS.scrollWaitMs = 20;
  env.window.WAEx.internal.LIMITS.retryWaitMs = 20;
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
  eq(byId(2).author, 'Jordan Roe');
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
    result.warnings.some((w) => /^One image file wasn't available to WhatsApp Web: .*save it from the phone/.test(w)),
    'the expired one comes with what to do about it: ' + JSON.stringify(result.warnings)
  );
  eq(result.completeness.mediaExpired, 1);
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
  ok(
    result.warnings.some((w) => /^Loading details: 11 messages .* WhatsApp's loader: chat threw .*Scrolling: \d+ rounds, 0 added/.test(w)),
    'and says what loading did: ' + JSON.stringify(result.warnings)
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
  ok(
    result.warnings.some((w) => /timed out \(stage INIT, mediaObject\.mediaBlob=null.*cache=null/.test(w)),
    'a hang that is not expiry says what each place returned, so no extra probe is needed: ' + JSON.stringify(result.warnings)
  );
  // Measured: ~770 ms started together, ~1,500 ms started three at a time.
  ok(elapsed < 2 * 600, `6 stuck items took ${elapsed} ms; started three at a time they take ~1,500 ms`);
  page.dom.window.close();
});

await checkAsync("finds the argument form WhatsApp's loader needs", async () => {
  // Live: with only 51 messages in memory, the export stopped at 151 — calling the loader
  // with just the chat may run without loading anything.
  const page = bootStorePage({ loaderNeedsMsgs: true });
  const result = await runExport(page, { format: 'json', mediaMode: 'skip', includeSystem: true });
  ok(result.ok, JSON.stringify(result.error));
  ok(!result.warnings.some((w) => /Loading details/.test(w)), 'loading reached the start: ' + JSON.stringify(result.warnings));
  const data = JSON.parse(await page.downloads[0].blob.text());
  eq(data.messages.length, 13, 'the earlier messages were loaded with (chat, msgs)');
  page.dom.window.close();
});

await checkAsync('the export file carries its date range and warnings', async () => {
  // Live: an export stopped early and the reason was only in the popup.
  const page = bootStorePage({ failLoader: true });
  const result = await runExport(page, { format: 'txt', mediaMode: 'skip' });
  ok(result.ok, JSON.stringify(result.error));
  const text = await page.downloads[0].blob.text();
  ok(/^Date range: All time$/m.test(text), 'date range in the header');
  ok(/^Warnings:\n  - /m.test(text), 'warnings in the header');
  ok(/^  - Loading details: /m.test(text), 'including the loading details');
  page.dom.window.close();

  const jsonPage = bootStorePage({ failLoader: true });
  await runExport(jsonPage, { format: 'json', mediaMode: 'skip', dateRange: '90d' });
  const data = JSON.parse(await jsonPage.downloads[0].blob.text());
  eq(data.settings.dateRangeLabel, 'Last 90 days');
  ok(data.warnings.some((w) => /^Loading details: /.test(w)), JSON.stringify(data.warnings));
  jsonPage.dom.window.close();
});

suite('store: history completeness (issue #8)');

/** The 13 messages of the mock chat, oldest first: the known reference. */
const REFERENCE = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13'];
const exportedIds = (data) => data.messages.map((m) => m.id.replace(/.*_M/, ''));

async function exportJson(options, settings = {}) {
  const page = bootStorePage(options);
  const result = await runExport(page, { format: 'json', mediaMode: 'skip', includeSystem: true, ...settings });
  const data = result.ok ? JSON.parse(await page.downloads[0].blob.text()) : null;
  page.dom.window.close();
  return { result, data };
}

await checkAsync('preloaded history: complete, matches the reference', async () => {
  const { result, data } = await exportJson({ preloaded: true });
  ok(result.ok, JSON.stringify(result.error));
  eq(result.completeness.status, 'complete', result.completeness.reason);
  eq(exportedIds(data), REFERENCE);
  eq(result.completeness.loadedMessages, 13);
  eq(result.completeness.exportedMessages, 13);
  eq(result.completeness.method, 'message-store');
});

await checkAsync('fresh tab, older history slow to arrive: patience reaches the start', async () => {
  // Live: a fresh-tab export stopped at 201 of 941. Empty loader rounds are now retried with
  // growing waits before switching to scrolling.
  const { result, data } = await exportJson({ emptyLoaderCalls: 4, loaderDelayMs: 30 });
  ok(result.ok, JSON.stringify(result.error));
  eq(result.completeness.status, 'complete', result.completeness.reason);
  eq(exportedIds(data), REFERENCE, 'the same messages as the preloaded export');
  ok(!result.warnings.some((w) => /Loading details/.test(w)), JSON.stringify(result.warnings));
});

await checkAsync('WhatsApp-side limit: partial, never complete', async () => {
  const { result, data } = await exportJson({ idleLoader: true });
  ok(result.ok, JSON.stringify(result.error));
  eq(result.completeness.status, 'partial');
  ok(/stopped returning older messages/.test(result.completeness.reason), result.completeness.reason);
  eq(result.completeness.exportedMessages, 11, 'what was loaded is still exported');
  eq(data.completeness.status, 'partial', 'and the file says so');
});

await checkAsync('safety budget: partial, with the limit named', async () => {
  const page = bootStorePage({ idleLoader: true });
  page.WAEx.internal.LIMITS.timeBudgetMs = 1;
  const result = await runExport(page, { format: 'json', mediaMode: 'skip' });
  ok(result.ok, JSON.stringify(result.error));
  eq(result.completeness.status, 'partial');
  ok(/time limit/.test(result.completeness.reason), result.completeness.reason);
  page.dom.window.close();
});

await checkAsync('internals unavailable: the screen fallback reports its own outcome', async () => {
  const { result } = await exportJson({ noRequire: true });
  ok(result.ok, JSON.stringify(result.error));
  eq(result.completeness.method, 'screen');
  eq(result.completeness.status, 'complete', 'the fixture page opens with its encryption notice: ' + result.completeness.reason);
});

await checkAsync('cancelled while loading: an error, not a success', async () => {
  const page = bootStorePage({ emptyLoaderCalls: 1000 });
  page.WAEx.internal.LIMITS.retryWaitMs = 200;
  const before = page.mock.sent.filter((m) => m.type === 'WAX:RESULT').length;
  await page.mock.dispatch({ type: 'WAX:EXPORT', settings: { format: 'json', mediaMode: 'skip' } });
  await new Promise((r) => setTimeout(r, 150));
  await page.mock.dispatch({ type: 'WAX:CANCEL' });
  const result = await waitFor(() => page.mock.sent.filter((m) => m.type === 'WAX:RESULT')[before], 30000, 'result');
  eq(result.ok, false);
  eq(result.error.code, 'CANCELLED');
  eq(result.completeness, undefined, 'no outcome claimed');
  eq(page.downloads.length, 0, 'nothing saved');
  page.dom.window.close();
});

process.exit(summary() ? 0 : 1);
