/**
 * Manifest and packaging checks: the things that only fail at `Load unpacked` time.
 * No browser needed, so this runs in the normal test suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadLibsInNode, suite, check, eq, ok, summary } from './harness.mjs';

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

suite('manifest: structure');

check('is Manifest V3 with a service worker', () => {
  eq(manifest.manifest_version, 3);
  eq(manifest.background.service_worker, 'src/background/service-worker.js');
});

check('has a unique, store-ready identity', () => {
  ok(manifest.name && manifest.name.length <= 45, 'name must be <= 45 chars');
  ok(/^\d+\.\d+\.\d+$/.test(manifest.version), 'version must be semver-ish');
  ok(manifest.description.length > 20 && manifest.description.length <= 132, 'description 20-132 chars');
  ok(manifest.minimum_chrome_version, 'minimum_chrome_version is set');
});

check('permissions stay minimal and justified', () => {
  eq(manifest.permissions.slice().sort(), ['activeTab', 'scripting', 'storage']);
  eq(manifest.host_permissions, ['https://web.whatsapp.com/*']);
  ok(!manifest.permissions.includes('<all_urls>'), 'must not request all_urls');
  ok(!manifest.permissions.includes('tabs'), 'tabs permission is not needed');
  ok(!manifest.permissions.includes('downloads'), 'downloads permission is not needed');
});

suite('manifest: referenced files exist');

check('background, popup and icons resolve', () => {
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  const missing = referenced.filter((relative) => !exists(relative));
  eq(missing, []);
});

check('content script matches only WhatsApp Web', () => {
  eq(manifest.content_scripts.length, 1);
  eq(manifest.content_scripts[0].matches, ['https://web.whatsapp.com/*']);
  eq(manifest.content_scripts[0].run_at, 'document_idle');
  eq(manifest.content_scripts[0].all_frames, false);
});

check('content script list matches WAEx.CONTENT_FILES exactly', () => {
  loadLibsInNode(['src/lib/namespace.js']);
  eq(manifest.content_scripts[0].js, globalThis.WAEx.CONTENT_FILES);
});

check('every listed content script file exists', () => {
  const missing = manifest.content_scripts[0].js.filter((relative) => !exists(relative));
  eq(missing, []);
});

suite('manifest: assets');

check('icons are PNGs with the right dimensions', () => {
  const expected = { 'icons/icon16.png': 16, 'icons/icon32.png': 32, 'icons/icon48.png': 48, 'icons/icon128.png': 128 };
  for (const [relative, size] of Object.entries(expected)) {
    const buffer = fs.readFileSync(path.join(ROOT, relative));
    eq(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', relative + ' must be a PNG');
    // IHDR width/height live at bytes 16-23 of a PNG.
    eq(buffer.readUInt32BE(16), size, relative + ' width');
    eq(buffer.readUInt32BE(20), size, relative + ' height');
  }
});

check('popup page has no inline script and no remote resources', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/popup/popup.html'), 'utf8');
  ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i.test(html), 'inline script found');
  ok(!/https?:\/\//i.test(html.replace(/https:\/\/web\.whatsapp\.com/g, '')), 'remote URL in popup');
  ok(/<script src="\.\.\/lib\/namespace\.js"><\/script>/.test(html), 'namespace must load first');
  ok(/<script src="\.\.\/lib\/datetime\.js"><\/script>/.test(html), 'datetime must load');
  ok(/<script src="popup\.js"><\/script>/.test(html), 'popup.js must load last');
});

check('no shipped file uses eval or remote code', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (/\.(js|html)$/.test(entry.name)) files.push(relative);
    }
  };
  walk('src');
  const offenders = [];
  for (const relative of files) {
    const text = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    if (/\beval\s*\(/.test(text) || /new\s+Function\s*\(/.test(text)) offenders.push(relative);
    if (/\.innerHTML\s*=/.test(text) && relative !== 'src/content/extractor.js') offenders.push(relative + ' (innerHTML)');
  }
  eq(offenders, []);
});

check('settings defaults are complete and typed', () => {
  loadLibsInNode(['src/lib/namespace.js']);
  const settings = globalThis.WAEx.DEFAULT_SETTINGS;
  for (const key of [
    'format',
    'dateRange',
    'customStart',
    'customEnd',
    'mediaMode',
    'includeSystem',
    'includeReactions',
    'senderLabels',
    'maxMediaMb',
    'restoreScroll',
  ]) {
    ok(key in settings, 'missing default: ' + key);
  }
  eq(settings.format, 'html');
  eq(settings.mediaMode, 'link');
  eq(settings.maxMediaMb, 250);
});

process.exit(summary() ? 0 : 1);
