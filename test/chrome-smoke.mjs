/**
 * Real-browser smoke test.
 *
 * Loads the unpacked extension into headless Chrome (via the CDP Extensions domain,
 * which is the only way branded Google Chrome allows this), opens the popup as a real
 * extension page, and checks that:
 *   - the manifest is accepted and the MV3 service worker starts
 *   - the popup page renders with no CSP violations or console errors
 *   - the content script is injected into a real https://web.whatsapp.com page and
 *     the extractor runs there without throwing
 *
 * Usage: node test/chrome-smoke.mjs
 *
 * Anything that depends on the live network (WhatsApp Web itself) is reported as a
 * skip, never a failure.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CHROME = process.env.CHROME_BIN || 'google-chrome';
const PORT = Number(process.env.CHROME_PORT || 9229);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wax-chrome-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const problems = [];
let skips = 0;

function pass(ok, label, detail) {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) problems.push(label + (detail ? ': ' + detail : ''));
}

function skip(label, detail) {
  skips++;
  console.log(`  \x1b[33m∅\x1b[0m ${label}${detail ? ' — ' + detail : ''}`);
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || 'CDP error'));
        else resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 30000);
    });
  }

  eventsFor(sessionId, method) {
    return this.events.filter((event) => event.sessionId === sessionId && event.method === method);
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('DevTools websocket failed')));
  });
}

let chrome = null;
let cdp = null;
const openedSessions = [];

try {
  console.log('Launching headless Chrome…');
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-unsafe-extension-debugging',
      '--window-size=380,640',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let chromeLog = '';
  chrome.stdout.on('data', (data) => (chromeLog += data));
  chrome.stderr.on('data', (data) => (chromeLog += data));

  let version = null;
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) {
        version = await response.json();
        break;
      }
    } catch (err) {
      /* not ready */
    }
    await sleep(150);
  }
  if (!version) throw new Error('DevTools endpoint never came up:\n' + chromeLog.slice(-2000));

  const ws = await connect(version.webSocketDebuggerUrl);
  cdp = new CDP(ws);
  console.log('  Chrome:', version.Browser);

  console.log('\n\x1b[1mExtension load\x1b[0m');

  /** Load the unpacked extension. Branded Chrome needs the CDP Extensions domain. */
  async function loadExtension() {
    try {
      const result = await cdp.send('Extensions.loadUnpacked', { path: ROOT });
      if (result && result.id) return result.id;
    } catch (err) {
      /* fall through to the command-line switch (Chromium builds) */
    }
    return null;
  }

  let extensionId = await loadExtension();
  if (!extensionId) {
    // Chromium accepts --load-extension; Chrome branded does not. Last resort only.
    skip('Extensions.loadUnpacked unavailable', 'trying --load-extension');
    extensionId = null;
  }
  pass(Boolean(extensionId), 'manifest accepted by Chrome, extension loaded', extensionId || 'not loaded');
  if (!extensionId) throw new Error('Could not load the extension in this Chrome build');

  // The MV3 service worker should register shortly after load.
  let worker = null;
  for (let i = 0; i < 60; i++) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    worker = targetInfos.find(
      (target) =>
        target.url.includes(extensionId) && target.url.includes('src/background/service-worker.js')
    );
    if (worker) break;
    await sleep(200);
  }
  pass(Boolean(worker), 'MV3 service worker registered', worker ? worker.type : 'missing');

  /* -------------------------------------------------- popup page in Chrome */

  console.log('\n\x1b[1mPopup page\x1b[0m');

  const { targetId: popupTargetId } = await cdp.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/src/popup/popup.html`,
  });
  const { sessionId: popupSession } = await cdp.send('Target.attachToTarget', {
    targetId: popupTargetId,
    flatten: true,
  });
  openedSessions.push(popupSession);
  await cdp.send('Runtime.enable', {}, popupSession);
  await cdp.send('Log.enable', {}, popupSession);
  await cdp.send('Page.enable', {}, popupSession);
  await sleep(2500);

  const popupEval = await cdp.send(
    'Runtime.evaluate',
    {
      expression: `(() => {
        const app = document.getElementById('app');
        return {
          ready: document.readyState,
          sections: app ? app.children.length : 0,
          text: document.body.innerText || '',
        };
      })()`,
      returnByValue: true,
    },
    popupSession
  );
  const popup = popupEval.result.value;
  pass(popup.ready === 'complete', 'popup page loads', popup.ready);
  pass(popup.sections > 0, 'popup renders its UI', popup.sections + ' root sections');
  pass(/Chat Export/i.test(popup.text), 'header and title are visible');

  const popupErrors = cdp
    .eventsFor(popupSession, 'Runtime.exceptionThrown')
    .map((event) => event.params.exceptionDetails.text + ' ' + (event.params.exceptionDetails.exception?.description || ''));
  const popupLogErrors = cdp
    .eventsFor(popupSession, 'Log.entryAdded')
    .map((event) => event.params.entry)
    .filter((entry) => entry.level === 'error' || entry.level === 'warning')
    .map((entry) => entry.text);
  const realErrors = [...popupErrors, ...popupLogErrors].filter(
    (text) => !/favicon|ERR_FILE_NOT_FOUND|net::ERR_/i.test(text)
  );
  pass(realErrors.length === 0, 'no console errors or CSP violations', realErrors.join(' | ').slice(0, 400));

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, popupSession);
  const shotDir = path.join(ROOT, 'test', 'screenshots');
  fs.mkdirSync(shotDir, { recursive: true });
  const shotPath = path.join(shotDir, 'chrome-real-popup.png');
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('  screenshot: ' + path.relative(ROOT, shotPath));

  /* ---------------------------------------- content script on real WhatsApp */

  console.log('\n\x1b[1mContent script on web.whatsapp.com\x1b[0m');

  const whatsapp = await openWhatsApp();
  if (!whatsapp) {
    skip('live WhatsApp Web page', 'network unavailable, skipped');
  } else {
    const world = await findIsolatedWorld(whatsapp.sessionId);
    if (!world) {
      pass(false, 'content script injected into the WhatsApp page', 'no isolated world found');
    } else {
      pass(true, 'content script injected into the WhatsApp page', 'frame ' + world.frameId);

      const probe = await cdp.send(
        'Runtime.evaluate',
        {
          contextId: world.id,
          expression: `(() => {
            try {
              if (typeof WAEx === 'undefined') return { ok: false, error: 'WAEx missing' };
              const extractor = WAEx.extractor;
              const info = extractor.getChatInfo();
              const report = extractor.diagnose();
              return {
                ok: true,
                version: WAEx.VERSION,
                found: info.found,
                reason: info.reason,
                mainPanel: report.mainPanel,
                renderedRows: report.renderedRows,
                scrollContainer: report.scrollContainer,
                warnings: report.warnings,
                // Set by src/page/bridge.js from WhatsApp's own page world.
                bridge: document.documentElement.getAttribute('data-wax-bridge'),
                bridgeApi: Boolean(WAEx.pageBridge && WAEx.internal),
              };
            } catch (err) {
              return { ok: false, error: String(err && err.message ? err.message : err) };
            }
          })()`,
          returnByValue: true,
        },
        whatsapp.sessionId
      );
      const result = probe.result.value || {};
      pass(result.ok === true, 'extractor runs on the live page without throwing', result.error || '');
      pass(
        Boolean(result.version),
        'content-script modules all loaded',
        'version ' + (result.version || 'unknown')
      );
      pass(
        Boolean(result.bridge) && result.bridgeApi === true,
        'page bridge installed in the WhatsApp page world',
        result.bridge ? 'version ' + result.bridge : 'data-wax-bridge missing'
      );
      console.log(
        '    chat found: ' +
          result.found +
          (result.reason ? ' (' + result.reason + ')' : '') +
          ' · rows: ' +
          result.renderedRows +
          ' · scroll container: ' +
          result.scrollContainer
      );
      if (result.mainPanel === false) {
        skip('conversation panel', 'not signed in to WhatsApp Web in this fresh profile');
      }
      if (Array.isArray(result.warnings) && result.warnings.length) {
        console.log('    warnings: ' + result.warnings.slice(0, 3).join(' | '));
      }
    }
  }
} catch (err) {
  console.error('\nSmoke test failed: ' + (err && err.message ? err.message : err));
  problems.push('fatal');
} finally {
  try {
    if (cdp) cdp.ws.close();
  } catch (err) {
    /* ignore */
  }
  if (chrome) chrome.kill('SIGKILL');
  await sleep(200);
  fs.rmSync(profile, { recursive: true, force: true });
}

async function openWhatsApp() {
  try {
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'https://web.whatsapp.com/',
    });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    openedSessions.push(sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);

    // Wait for the document to reach a usable state (or give up quietly).
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const state = await cdp
        .send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sessionId)
        .catch(() => null);
      if (state && state.result.value === 'complete') return { sessionId };
    }
    return { sessionId };
  } catch (err) {
    return null;
  }
}

async function findIsolatedWorld(sessionId) {
  for (let i = 0; i < 40; i++) {
    const contexts = cdp.eventsFor(sessionId, 'Runtime.executionContextCreated');
    for (const event of contexts) {
      const context = event.params.context;
      const aux = context.auxData || {};
      if (aux.type !== 'isolated') continue;
      if (context.origin === 'chrome-extension://' || /chrome-extension/.test(context.origin || '')) {
        return { id: context.id, frameId: aux.frameId };
      }
      // Newer Chrome reports the extension origin directly.
      if (context.name && /chat export/i.test(context.name)) {
        return { id: context.id, frameId: aux.frameId };
      }
    }
    await sleep(250);
  }
  return null;
}

console.log(
  problems.length === 0
    ? `\n\x1b[32mChrome smoke test passed${skips ? ` (${skips} skipped)` : ''}.\x1b[0m`
    : '\n\x1b[31mChrome smoke test found problems.\x1b[0m'
);
process.exit(problems.length === 0 ? 0 : 1);
