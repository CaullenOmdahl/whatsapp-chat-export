/**
 * Contract test: the real popup UI wired to the real content script.
 *
 * Both halves were developed independently against docs/PROTOCOL.md. This boots the
 * actual popup.html in jsdom with a chrome API shim that forwards `tabs.sendMessage`
 * to the content script and re-broadcasts content-script events back into the popup,
 * then drives a full export through the UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  ROOT,
  createEnv,
  loadScripts,
  CONTENT_FILES,
  makeChrome,
  waitFor,
  suite,
  checkAsync,
  eq,
  ok,
  summary,
} from './harness.mjs';
import { buildFixtureHtml } from './fixture.mjs';

const MEDIA_URL = 'blob:https://web.whatsapp.com/9f1c2d3e-media';

/* ---------------------------------------------------- content-script side */

const contentEnv = createEnv(buildFixtureHtml(), {
  responses: { [MEDIA_URL]: { bytes: new Uint8Array(1024).fill(3), type: 'image/jpeg' } },
});
const contentMock = makeChrome(contentEnv.window);
loadScripts(contentEnv.window, [...CONTENT_FILES, 'src/content/content.js']);
const scroller = contentEnv.window.document.getElementById('msg-scroller');
scroller.__scrollHeight = 1200;
scroller.__clientHeight = 600;

/* ------------------------------------------------------------ popup side */

const popupListeners = [];
// Storage is shared with the content script, exactly like the real extension.
const localStore = contentMock.local;
const sessionStore = contentMock.session;
const dispatched = [];

function readStore(store, keys) {
  if (keys === null || keys === undefined) return Object.assign({}, store);
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const key of list) if (key in store) out[key] = store[key];
  return out;
}

// Content script broadcasts are forwarded into the popup's onMessage listeners.
contentMock.chrome.runtime.sendMessage = function (message, callback) {
  contentMock.sent.push(message);
  for (const listener of popupListeners) {
    try {
      listener(message, { id: 'content' });
    } catch (err) {
      /* one bad listener must not break the broadcast */
    }
  }
  if (typeof callback === 'function') callback();
};

function popupChrome() {
  return {
    runtime: {
      lastError: undefined,
      getURL: (relative) => 'chrome-extension://test/' + relative,
      onMessage: {
        addListener(fn) {
          popupListeners.push(fn);
        },
        removeListener(fn) {
          const i = popupListeners.indexOf(fn);
          if (i >= 0) popupListeners.splice(i, 1);
        },
      },
      sendMessage(_message, cb) {
        if (cb) cb();
      },
    },
    tabs: {
      query(_query, cb) {
        cb([{ id: 7, active: true, windowId: 1, url: 'https://web.whatsapp.com/' }]);
      },
      sendMessage(tabId, message, cb) {
        dispatched.push(message);
        contentMock.dispatch(message).then((reply) => {
          if (cb) cb(reply);
        });
      },
      create(_options, cb) {
        if (cb) cb({ id: 8 });
      },
      reload(_tabId, _options, cb) {
        if (cb) cb();
      },
    },
    scripting: {
      executeScript(_options, cb) {
        if (cb) cb([]);
      },
    },
    storage: {
      local: {
        get(keys, cb) {
          if (cb) cb(readStore(localStore, keys));
        },
        set(patch, cb) {
          Object.assign(localStore, patch);
          if (cb) cb();
        },
        remove(keys, cb) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete localStore[key];
          if (cb) cb();
        },
      },
      session: {
        get(keys, cb) {
          if (cb) cb(readStore(sessionStore, keys));
        },
        set(patch, cb) {
          Object.assign(sessionStore, patch);
          if (cb) cb();
        },
        remove(keys, cb) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionStore[key];
          if (cb) cb();
        },
      },
    },
  };
}

const popupPath = path.join(ROOT, 'src/popup/popup.html');
const popupHtml = fs.readFileSync(popupPath, 'utf8');
const popupDom = new JSDOM(popupHtml, {
  url: pathToFileURL(popupPath).href,
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.chrome = popupChrome();
  },
});
const popupWindow = popupDom.window;
const popupDocument = popupWindow.document;

function buttonByText(regex) {
  return Array.from(popupDocument.querySelectorAll('button')).find((b) => regex.test(b.textContent || ''));
}

function bodyText() {
  return popupDocument.body.textContent || '';
}

/* ------------------------------------------------------------------ tests */

suite('popup: boots against a live WhatsApp tab');

await checkAsync('renders the open chat and settings', async () => {
  await waitFor(() => /Design Team/.test(bodyText()), 15000, 'chat name in popup');
  ok(/10 messages loaded/.test(bodyText()), 'expected the rendered message count');
  ok(/Export chat/i.test(bodyText()), 'expected the primary action');
  ok(/Files are created on your device/.test(bodyText()), 'expected the privacy footer');
});

await checkAsync('shows the default options on first run', async () => {
  eq(popupDocument.getElementById('fmt-html').checked, true, 'HTML is the default format');
  ok(
    /Styled transcript that opens in any browser/.test(bodyText()),
    'expected the format blurb for the selected format'
  );
  eq(popupDocument.getElementById('date-range').value, 'all');
  const mediaSelect = popupDocument.getElementById('media-mode');
  ok(mediaSelect, 'media select missing');
  eq(mediaSelect.value, 'link');
});

await checkAsync('diagnostics panel renders the selector report', async () => {
  const link = Array.from(popupDocument.querySelectorAll('button, a')).find((node) =>
    /Diagnostics/i.test(node.textContent || '')
  );
  ok(link, 'expected a diagnostics control');
  link.click();
  await waitFor(() => /Conversation panel/.test(bodyText()), 15000, 'diagnostics report');
  ok(/Message rows/.test(bodyText()));
  ok(/parsed/i.test(bodyText()), 'expected parsed message count');
});

suite('popup: full export through the UI');

await checkAsync('clicking Export chat produces a downloadable file', async () => {
  // Close the diagnostics overlay if it is still open.
  const close = popupDocument.querySelector('[aria-label="Close diagnostics"]');
  if (close) close.click();

  const exportButton = buttonByText(/Export chat/i);
  ok(exportButton, 'export button not found');
  exportButton.click();

  await waitFor(
    () => dispatched.some((m) => m.type === 'WAX:EXPORT'),
    10000,
    'export request to the content script'
  );
  await waitFor(() => /Export complete/i.test(bodyText()), 30000, 'success panel');
  ok(/Design Team/.test(bodyText()));
});

await checkAsync('the file reached the download layer', async () => {
  eq(contentEnv.downloads.length, 1);
  ok(contentEnv.downloads[0].filename.endsWith('.html'), contentEnv.downloads[0].filename);
  eq(contentMock.session['wax:state'].phase, 'done');
});

await checkAsync('history is shown in the popup', async () => {
  ok(Array.isArray(localStore['wax:history']), 'history should be stored');
  eq(localStore['wax:history'].length, 1);
  await waitFor(
    () => /WhatsApp Chat with Design Team/.test(bodyText()),
    15000,
    'history filename in popup'
  );
});

await checkAsync('changing format persists and is used by the next export', async () => {
  const csvTab = popupDocument.getElementById('fmt-csv');
  ok(csvTab, 'CSV format control not found');
  csvTab.click();
  await waitFor(
    () => localStore['wax:settings'] && localStore['wax:settings'].format === 'csv',
    10000,
    'saved format'
  );

  const change = Array.from(popupDocument.querySelectorAll('button')).find((b) =>
    /Change options/i.test(b.textContent || '')
  );
  if (change) change.click();

  const exportButton = buttonByText(/Export chat|Export again/i);
  ok(exportButton, 'export control missing after completion');
  exportButton.click();

  await waitFor(() => contentEnv.downloads.length === 2, 30000, 'second download');
  ok(contentEnv.downloads[1].filename.endsWith('.csv'), contentEnv.downloads[1].filename);
});

suite('popup: media size limit option');

await checkAsync('size limit appears only for media downloads', async () => {
  eq(popupDocument.getElementById('media-limit-wrap').hidden, true, 'hidden while media is placeholders');

  const mediaSelect = popupDocument.getElementById('media-mode');
  mediaSelect.value = 'download';
  mediaSelect.dispatchEvent(new popupWindow.Event('change', { bubbles: true }));

  await waitFor(() => popupDocument.getElementById('media-limit-wrap').hidden === false, 10000, 'size limit row');
  const input = popupDocument.getElementById('media-limit');
  ok(input, 'size limit input missing');
  eq(input.value, '250');
  eq(input.getAttribute('min'), '10');
  eq(input.getAttribute('max'), '2048');
});

await checkAsync('custom size limit is persisted and sent with the export', async () => {
  const input = popupDocument.getElementById('media-limit');
  input.value = '120';
  input.dispatchEvent(new popupWindow.Event('input', { bubbles: true }));
  input.dispatchEvent(new popupWindow.Event('change', { bubbles: true }));

  await waitFor(
    () => localStore['wax:settings'] && localStore['wax:settings'].maxMediaMb === 120,
    10000,
    'persisted media limit'
  );

  const change = Array.from(popupDocument.querySelectorAll('button')).find((b) =>
    /Change options/i.test(b.textContent || '')
  );
  if (change) change.click();

  const downloadsBefore = contentEnv.downloads.length;
  const exportButton = buttonByText(/Export chat|Export again/i);
  ok(exportButton, 'export control missing');
  exportButton.click();
  await waitFor(() => contentEnv.downloads.length > downloadsBefore, 30000, 'media export download');

  const exportMessage = dispatched.filter((m) => m.type === 'WAX:EXPORT').pop();
  eq(exportMessage.settings.maxMediaMb, 120, 'export must carry the chosen limit');
  ok(contentEnv.downloads[contentEnv.downloads.length - 1].filename.endsWith('.zip'));
});

suite('popup: degraded states');

await checkAsync('no WhatsApp tab shows a clear empty state', async () => {
  const chrome = popupChrome();
  chrome.tabs.query = (_q, cb) => cb([{ id: 3, active: true, url: 'https://example.com/' }]);
  const dom = new JSDOM(popupHtml, {
    url: pathToFileURL(popupPath).href,
    runScripts: 'dangerously',
    resources: 'usable',
    beforeParse(window) {
      window.chrome = chrome;
      chrome.runtime.onMessage.addListener = () => {};
    },
  });
  await waitFor(() => /WhatsApp Web/i.test(dom.window.document.body.textContent || ''), 15000, 'no-tab view');
  const text = dom.window.document.body.textContent || '';
  ok(/Open WhatsApp Web/i.test(text), 'expected a call to action');
  dom.window.close();
});

popupWindow.close();
contentEnv.dom.window.close();
process.exit(summary() ? 0 : 1);
