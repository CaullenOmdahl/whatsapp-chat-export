/**
 * Test harness: boots a jsdom WhatsApp page, loads the real extension scripts into it
 * and provides a chrome API mock plus download capture.
 *
 * The extension code is evaluated as-is (no bundling, no rewriting), so the tests
 * exercise exactly what ships.
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const LIB_FILES = [
  'src/lib/namespace.js',
  'src/lib/datetime.js',
  'src/lib/zip.js',
  'src/lib/formats.js',
];

export const CONTENT_FILES = [...LIB_FILES, 'src/content/extractor.js', 'src/content/media.js'];

let failures = 0;
let checks = 0;
const currentSuite = { name: '' };

export function suite(name) {
  currentSuite.name = name;
  console.log('\n\x1b[1m' + name + '\x1b[0m');
}

export function check(label, fn) {
  checks++;
  try {
    const result = fn();
    if (result === false) throw new Error('assertion returned false');
    console.log('  \x1b[32m✓\x1b[0m ' + label);
  } catch (err) {
    failures++;
    console.log('  \x1b[31m✗\x1b[0m ' + label + '\n      ' + (err && err.message ? err.message : err));
  }
}

export function checkAsync(label, fn) {
  checks++;
  return Promise.resolve()
    .then(fn)
    .then(() => console.log('  \x1b[32m✓\x1b[0m ' + label))
    .catch((err) => {
      failures++;
      console.log('  \x1b[31m✗\x1b[0m ' + label + '\n      ' + (err && err.message ? err.message : err));
    });
}

export function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what} expected ${b} but got ${a}`);
}

export function ok(value, what = 'expected truthy') {
  if (!value) throw new Error(what);
}

export function summary() {
  const color = failures ? '\x1b[31m' : '\x1b[32m';
  console.log(`\n${color}${checks - failures}/${checks} checks passed\x1b[0m`);
  return failures === 0;
}

/**
 * Create a jsdom page with the globals the extension expects.
 * `options.rows` / `options.older` are passed to the fixture builder.
 */
export function createEnv(html, options = {}) {
  const dom = new JSDOM(html, {
    url: options.url || 'https://web.whatsapp.com/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });

  const { window } = dom;

  // jsdom has no Blob/TextEncoder/CompressionStream/fetch; borrow Node's.
  window.Blob = globalThis.Blob;
  window.TextEncoder = globalThis.TextEncoder;
  window.TextDecoder = globalThis.TextDecoder;
  if (globalThis.CompressionStream) window.CompressionStream = globalThis.CompressionStream;
  if (globalThis.DecompressionStream) window.DecompressionStream = globalThis.DecompressionStream;

  // Scroll metrics: jsdom always reports 0, so make them scriptable.
  defineScrollMetrics(window);

  // Long timers (the download cleanup) would keep the test process alive.
  const realSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...args) => (ms > 5000 ? 0 : realSetTimeout(fn, ms, ...args));

  // Download capture.
  const downloads = [];
  const objectUrls = new Map();
  let urlSeq = 0;
  window.URL.createObjectURL = (blob) => {
    const id = `blob:mock-${++urlSeq}`;
    objectUrls.set(id, blob);
    return id;
  };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function click() {
    downloads.push({ filename: this.download, href: this.href, blob: objectUrls.get(this.href) });
  };

  // fetch stub, driven by options.responses (url -> { bytes, type })
  const responses = options.responses || {};
  window.fetch = async (url) => {
    const spec = responses[url];
    if (!spec) return { ok: false, status: 404, blob: async () => new window.Blob([]) };
    const body = spec.bytes || new Uint8Array([1, 2, 3, 4]);
    return { ok: true, status: 200, blob: async () => new window.Blob([body], { type: spec.type || 'image/jpeg' }) };
  };

  return { dom, window, downloads, objectUrls };
}

function defineScrollMetrics(window) {
  const proto = window.Element.prototype;
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get() {
      return this.__scrollHeight || 0;
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get() {
      return this.__clientHeight || 0;
    },
  });
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get() {
      return this.__scrollTop || 0;
    },
    set(value) {
      this.__scrollTop = value;
      if (typeof this.__onScrollTop === 'function') this.__onScrollTop(value);
    },
  });
}

/** Evaluate extension scripts inside the jsdom window, in order. */
export function loadScripts(window, files = CONTENT_FILES) {
  for (const relative of files) {
    const code = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    try {
      window.eval(code);
    } catch (err) {
      throw new Error(`Failed loading ${relative}: ${err && err.message ? err.message : err}`);
    }
  }
  if (!window.WAEx) throw new Error('WAEx namespace was not created');
  return window.WAEx;
}

/** chrome API mock good enough for the content script and popup. */
export function makeChrome(window, options = {}) {
  const local = Object.assign({}, options.local || {});
  const session = Object.assign({}, options.session || {});
  const sent = [];
  const listeners = [];
  let runtimeError = undefined;

  function read(store, keys) {
    if (keys === null || keys === undefined) return Object.assign({}, store);
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const key of list) {
      if (key in store) out[key] = store[key];
    }
    return out;
  }

  const chrome = {
    runtime: {
      get lastError() {
        return runtimeError;
      },
      onMessage: {
        addListener(fn) {
          listeners.push(fn);
        },
        removeListener(fn) {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
      sendMessage(message, callback) {
        sent.push(message);
        runtimeError = undefined;
        if (typeof callback === 'function') callback();
      },
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    storage: {
      local: {
        get(keys, cb) {
          const value = read(local, keys);
          if (cb) cb(value);
        },
        set(patch, cb) {
          Object.assign(local, patch);
          if (cb) cb();
        },
        remove(keys, cb) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete local[key];
          if (cb) cb();
        },
      },
      session: {
        get(keys, cb) {
          if (cb) cb(read(session, keys));
        },
        set(patch, cb) {
          Object.assign(session, patch);
          if (cb) cb();
        },
        remove(keys, cb) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key];
          if (cb) cb();
        },
        setAccessLevel() {},
      },
    },
  };

  window.chrome = chrome;

  return {
    chrome,
    local,
    session,
    sent,
    listeners,
    /** Deliver a runtime message to the content script; resolves the response. */
    dispatch(message) {
      return new Promise((resolve) => {
        let answered = false;
        const sendResponse = (value) => {
          if (!answered) {
            answered = true;
            resolve(value);
          }
        };
        for (const listener of listeners) {
          const keepAlive = listener(message, { id: 'test' }, sendResponse);
          void keepAlive;
        }
        // Handler may be synchronous or choose to answer later.
        setTimeout(() => {
          if (!answered) resolve(undefined);
        }, 0);
      });
    },
  };
}

export function waitFor(predicate, timeoutMs = 15000, label = 'condition') {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (err) {
        value = undefined;
      }
      if (value) return resolve(value);
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`Timed out waiting for ${label}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

/** Write a downloaded blob to disk and return the path. */
export async function saveDownload(dir, download) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, download.filename);
  const bytes = new Uint8Array(await download.blob.arrayBuffer());
  fs.writeFileSync(target, bytes);
  return target;
}

export function readFile(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/** Load library scripts into the Node global scope (for pure-logic tests). */
export function loadLibsInNode(files = LIB_FILES) {
  for (const relative of files) {
    const code = readFile(relative);
    // eslint-disable-next-line no-new-func
    new Function(code)();
  }
  if (!globalThis.WAEx) throw new Error('WAEx namespace was not created');
  return globalThis.WAEx;
}

/**
 * Make the history-loading loop fast for tests.
 *
 * The real limits wait seconds for WhatsApp to fetch a page of older messages;
 * jsdom never grows the list, so those waits would only slow the suite down.
 */
export function fastHistoryLimits(window) {
  const extractor = window.WAEx && window.WAEx.extractor;
  if (!extractor) return;
  const limits = extractor.LIMITS;
  limits.growthTimeoutMs = 60;
  limits.growthHardCapMs = 120;
  limits.topIdleRounds = 1;
  limits.activityQuietMs = 20;
  limits.pollMs = 10;
  limits.settleAfterLoadMs = 0;
  limits.maxIdleRounds = 2;
  limits.nudgeSteps = 1;
  limits.downIdleRounds = 1;
  limits.stepDelayMs = 0;
  limits.maxScrollSteps = 200;
  limits.timeBudgetMs = 30000;
}
