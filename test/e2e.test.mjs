/**
 * End-to-end: real content script against a simulated WhatsApp page, with the
 * downloaded file validated on disk. This is the test that proves the extension
 * actually produces usable output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  check,
  checkAsync,
  eq,
  ok,
  summary,
} from './harness.mjs';
import { buildFixtureHtml, buildEmptyFixtureHtml } from './fixture.mjs';

const MEDIA_URL = 'blob:https://web.whatsapp.com/9f1c2d3e-media';
const OUT = path.join(ROOT, 'test', 'out');

function bootPage(html) {
  const env = createEnv(html, {
    responses: {
      [MEDIA_URL]: { bytes: new Uint8Array(2048).fill(7), type: 'image/jpeg' },
    },
  });
  const mock = makeChrome(env.window);
  loadScripts(env.window, [...CONTENT_FILES, 'src/content/content.js']);
  fastHistoryLimits(env.window);
  const scroller = env.window.document.getElementById('msg-scroller');
  if (scroller) {
    scroller.__scrollHeight = 1200;
    scroller.__clientHeight = 600;
  }
  return { ...env, mock, WAEx: env.window.WAEx };
}

/** Send a message and wait for the next WAX:RESULT broadcast. */
async function runExport(page, settings) {
  const before = page.mock.sent.filter((m) => m.type === 'WAX:RESULT').length;
  const accepted = await page.mock.dispatch({ type: 'WAX:EXPORT', settings });
  eq(accepted, { accepted: true }, 'export should be accepted');
  return waitFor(
    () => page.mock.sent.filter((m) => m.type === 'WAX:RESULT')[before],
    30000,
    'export result'
  );
}

function zipNames(file) {
  const out = execFileSync(
    'python3',
    [
      '-c',
      `import zipfile,json;z=zipfile.ZipFile(${JSON.stringify(file)});print(json.dumps({"names":z.namelist(),"bad":z.testzip()}))`,
    ],
    { encoding: 'utf8' }
  );
  return JSON.parse(out);
}

function unzipEntry(file, entry) {
  return execFileSync(
    'python3',
    ['-c', `import zipfile,sys;sys.stdout.write(zipfile.ZipFile(${JSON.stringify(file)}).read(${JSON.stringify(entry)}).decode("utf-8"))`],
    { encoding: 'utf8' }
  );
}

/* ------------------------------------------------------------------------ */

const page = bootPage(buildFixtureHtml());

suite('e2e: health check and diagnostics');

await checkAsync('ping reports the open chat', async () => {
  const reply = await page.mock.dispatch({ type: 'WAX:PING' });
  eq(reply.ok, true);
  eq(reply.chat.name, 'Design Team');
  eq(reply.chat.found, true);
  eq(reply.chat.isGroup, true);
  eq(reply.state, null, 'no export has run yet');
  eq(reply.running, false);
});

await checkAsync('diagnose returns a healthy report', async () => {
  const report = await page.mock.dispatch({ type: 'WAX:DIAGNOSE' });
  eq(report.mainPanel, true);
  eq(report.parsedMessages, 11);
  eq(report.warnings, []);
});

suite('e2e: HTML export with media');

let htmlResult;
let htmlFile;

await checkAsync('exports a zip with the report and media', async () => {
  htmlResult = await runExport(page, {
    format: 'html',
    mediaMode: 'download',
    includeSystem: false,
    includeReactions: true,
    senderLabels: true,
  });

  eq(htmlResult.ok, true, JSON.stringify(htmlResult.error || {}));
  eq(htmlResult.messageCount, 10, 'system messages are excluded by default');
  eq(htmlResult.zipped, true);
  eq(htmlResult.mediaCaptured, 1);
  ok(htmlResult.filename.endsWith('.zip'), 'expected a zip, got ' + htmlResult.filename);
  ok(htmlResult.bytes > 1000, 'archive should not be empty');
  ok(htmlResult.warnings.length === 0, 'unexpected warnings: ' + JSON.stringify(htmlResult.warnings));

  eq(page.downloads.length, 1);
  eq(page.downloads[0].filename, htmlResult.filename);
  htmlFile = await saveDownload(OUT, page.downloads[0]);
  ok(fs.existsSync(htmlFile));
});

await checkAsync('archive contents are valid and complete', async () => {
  const info = zipNames(htmlFile);
  eq(info.bad, null, 'every zip entry must pass its CRC check');
  eq(info.names.length, 2);
  ok(info.names[0].startsWith('WhatsApp Chat with Design Team - '), info.names[0]);
  ok(info.names[0].endsWith('.html'));
  eq(info.names[1], 'media/0001-image.jpg');

  const html = unzipEntry(htmlFile, info.names[0]);
  ok(html.startsWith('<!DOCTYPE html>'));
  ok(html.includes('<h1>Design Team</h1>'));
  ok(html.includes('<img loading="lazy" src="media/0001-image.jpg"'));
  ok(html.includes('Are we still on for Friday?'), 'quoted reply should be present');
  ok(html.includes('Great 👍'), 'emoji should survive');
  ok(html.includes("Perfect.\nI&#39;ll bring coffee ☕"), 'line breaks and escaped quotes should survive');
  ok(html.includes('Q4-plan.pdf'), 'document name should be present');
  ok(!html.includes('end-to-end encrypted'), 'system notice excluded by default');
  ok(!html.includes('<script>'), 'no scripts in the report');
});

await checkAsync('popup state is restored after completion', async () => {
  const reply = await page.mock.dispatch({ type: 'WAX:PING' });
  ok(reply.state, 'a recently finished export should still be visible');
  eq(reply.state.phase, 'done');
  eq(reply.state.filename, htmlResult.filename);
  eq(reply.state.messageCount, 10);
});

await checkAsync('history is recorded', async () => {
  const history = page.mock.local['wax:history'];
  ok(Array.isArray(history) && history.length === 1, 'expected one history entry');
  eq(history[0].filename, htmlResult.filename);
  eq(history[0].messageCount, 10);
  eq(history[0].format, 'html');
  eq(history[0].mediaMode, 'download');
});

suite('e2e: CSV export without media');

await checkAsync('exports a plain csv', async () => {
  const before = page.mock.sent.length;
  const result = await runExport(page, {
    format: 'csv',
    mediaMode: 'skip',
    includeSystem: true,
  });

  eq(result.ok, true);
  eq(result.messageCount, 11, 'system messages included on request');
  eq(result.zipped, false);
  ok(result.filename.endsWith('.csv'));
  ok(result.filename.includes('WhatsApp Chat with Design Team - '));

  const latest = page.mock.sent.slice(before).filter((m) => m.type === 'WAX:RESULT');
  eq(latest.length, 1);
  eq(page.downloads.length, 2);
  const file = await saveDownload(OUT, page.downloads[1]);
  const rawBytes = fs.readFileSync(file);
  eq([...rawBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'csv must start with a UTF-8 BOM');
  const csv = rawBytes.toString('utf8').replace(/^\ufeff/, '');
  ok(csv.startsWith('timestamp_iso'));
  eq(csv.split('\r\n').length, 12);
  ok(csv.includes(",Yes! Let's do 10am,"), 'plain cells are not quoted');
  ok(csv.includes(',text,'));
});

suite('e2e: date range filtering');

await checkAsync('custom range keeps only matching messages', async () => {
  const result = await runExport(page, {
    format: 'json',
    mediaMode: 'link',
    dateRange: 'custom',
    customStart: '2023-12-01',
    customEnd: '2023-12-31',
  });

  eq(result.ok, true);
  eq(result.messageCount, 3, 'only the three December messages');

  eq(page.downloads.length, 3);
  const file = await saveDownload(OUT, page.downloads[2]);
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq(payload.messages.length, 3);
  eq(payload.messages.map((m) => m.date), ['2023-12-25', '2023-12-25', '2023-12-25']);
});

await checkAsync('an empty range fails with a helpful error', async () => {
  const before = page.mock.sent.filter((m) => m.type === 'WAX:RESULT').length;
  await page.mock.dispatch({
    type: 'WAX:EXPORT',
    settings: { format: 'txt', dateRange: 'custom', customStart: '2020-01-01', customEnd: '2020-01-02' },
  });
  const result = await waitFor(
    () => page.mock.sent.filter((m) => m.type === 'WAX:RESULT')[before],
    30000,
    'empty-range result'
  );
  eq(result.ok, false);
  eq(result.error.code, 'NO_MESSAGES');
  ok(result.error.hint.length > 0);
});

suite('e2e: failure handling');

await checkAsync('export without an open conversation explains itself', async () => {
  const empty = bootPage(buildEmptyFixtureHtml());
  const result = await runExport(empty, { format: 'html' });
  eq(result.ok, false);
  eq(result.error.code, 'NO_CONVERSATION');
  ok(/No conversation is open/.test(result.error.message), result.error.message);
  eq(empty.downloads.length, 0);
  empty.dom.window.close();
});

await checkAsync('cancel when idle is a no-op', async () => {
  const reply = await page.mock.dispatch({ type: 'WAX:CANCEL' });
  eq(reply.ok, true);
  eq(reply.cancelling, false);
});

await checkAsync('settings are normalised before use', async () => {
  const before = page.mock.sent.filter((m) => m.type === 'WAX:RESULT').length;
  await page.mock.dispatch({
    type: 'WAX:EXPORT',
    settings: { format: 'not-a-format', mediaMode: 'nope', dateRange: 'bogus', maxMediaMb: -5 },
  });
  const result = await waitFor(
    () => page.mock.sent.filter((m) => m.type === 'WAX:RESULT')[before],
    30000,
    'normalised export result'
  );
  eq(result.ok, true, 'invalid settings should fall back to defaults, not fail');
  ok(result.filename.endsWith('.html'));
});

suite('e2e: renders');

await checkAsync('writes an HTML report for manual review', async () => {
  const out = path.join(OUT, 'preview-report.html');
  fs.mkdirSync(OUT, { recursive: true });
  const result = await runExport(page, {
    format: 'html',
    mediaMode: 'link',
    includeSystem: true,
  });
  eq(result.ok, true);
  const latestDownload = page.downloads[page.downloads.length - 1];
  const bytes = new Uint8Array(await latestDownload.blob.arrayBuffer());
  fs.writeFileSync(out, bytes);
  ok(fs.statSync(out).size > 900, 'report should have real content');
  console.log('      report: ' + path.relative(ROOT, out));
});

page.dom.window.close();
process.exit(summary() ? 0 : 1);
