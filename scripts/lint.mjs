#!/usr/bin/env node
/**
 * Dependency-free static checks. Runs fast, before the test suite, in CI.
 *
 *   node scripts/lint.mjs
 *
 * Verifies syntax, JSON validity, the manifest ↔ namespace contract, and the project's
 * hard rules (no network requests from the extension's own code — media is downloaded
 * by WhatsApp's own download manager through the page bridge — no remote code, no
 * innerHTML with user content, no new permissions). It deliberately does not duplicate
 * behavioural tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const problems = [];

function problem(message) {
  problems.push(message);
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function walk(relative, out = []) {
  const absolute = path.join(ROOT, relative);
  if (!fs.existsSync(absolute)) return out;
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolute).sort()) {
      walk(path.posix.join(relative, entry), out);
    }
    return out;
  }
  out.push(relative);
  return out;
}

/* ------------------------------------------------------------ syntax + JSON */

const jsFiles = walk('src').filter((file) => file.endsWith('.js'));
const scriptFiles = walk('scripts').filter((file) => file.endsWith('.mjs'));
const testFiles = walk('test').filter((file) => file.endsWith('.mjs'));

for (const file of [...jsFiles, ...scriptFiles, ...testFiles]) {
  // `node --check` understands both classic scripts and ES modules.
  const result = spawnSync(process.execPath, ['--check', path.join(ROOT, file)], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    problem(`${file}: syntax error — ${(result.stderr || '').split('\n')[0]}`);
  }
}

for (const file of ['manifest.json', 'package.json']) {
  try {
    JSON.parse(read(file));
  } catch (err) {
    problem(`${file}: invalid JSON — ${err.message}`);
  }
}

const manifest = JSON.parse(read('manifest.json'));

/* ------------------------------------------------------ manifest contract */

const namespaceSource = read('src/lib/namespace.js');
new Function(namespaceSource)();
const WAEx = globalThis.WAEx;

if (!WAEx) {
  problem('src/lib/namespace.js did not create the WAEx namespace');
} else {
  const expected = manifest.content_scripts[0].js;
  if (JSON.stringify(expected) !== JSON.stringify(WAEx.CONTENT_FILES)) {
    problem(
      'manifest.json content script list does not match WAEx.CONTENT_FILES\n' +
        '    manifest: ' +
        JSON.stringify(expected) +
        '\n    namespace: ' +
        JSON.stringify(WAEx.CONTENT_FILES)
    );
  }
}

if (WAEx && WAEx.VERSION !== manifest.version) {
  problem(`src/lib/namespace.js WAEx.VERSION (${WAEx.VERSION}) != manifest.json version (${manifest.version})`);
}
try {
  const pkg = JSON.parse(read('package.json'));
  if (pkg.version !== manifest.version) {
    problem(`package.json version (${pkg.version}) != manifest.json version (${manifest.version})`);
  }
} catch (err) {
  problem('package.json: ' + err.message);
}

const allowedPermissions = ['storage', 'scripting', 'activeTab'];
for (const permission of manifest.permissions) {
  if (!allowedPermissions.includes(permission)) {
    problem(`manifest.json asks for a permission the project does not allow: ${permission}`);
  }
}
if (manifest.host_permissions.length !== 1 || manifest.host_permissions[0] !== 'https://web.whatsapp.com/*') {
  problem('manifest.json host permissions must be exactly https://web.whatsapp.com/*');
}
if (manifest.manifest_version !== 3) problem('manifest.json must be Manifest V3');

/* ------------------------------------------------------------- hard rules */

const shipped = [...walk('src')].filter((file) => /\.(js|html|css)$/.test(file));

for (const file of shipped) {
  const source = read(file);

  if (/\beval\s*\(/.test(source)) problem(`${file}: uses eval()`);
  if (/new\s+Function\s*\(/.test(source)) problem(`${file}: uses new Function()`);
  if (/\bXMLHttpRequest\b/.test(source)) problem(`${file}: uses XMLHttpRequest`);
  if (/\bWebSocket\b/.test(source)) problem(`${file}: uses WebSocket`);
  if (/\bimportScripts\b/.test(source.replace(/src\/background\/service-worker\.js/, ''))) {
    // importScripts in the service worker is fine (local file only); flag it elsewhere.
    if (file !== 'src/background/service-worker.js') problem(`${file}: uses importScripts`);
  }
  if (/\.innerHTML\s*=/.test(source)) problem(`${file}: assigns innerHTML (use DOM nodes/textContent)`);
  if (/document\.write/.test(source)) problem(`${file}: uses document.write`);

  // No absolute remote URLs in shipped code. Everything must be relative or a blob/data URL.
  const remoteUrls = source.match(/https?:\/\/[^\s'"`)]+/g) || [];
  for (const url of remoteUrls) {
    const allowed =
      url.startsWith('https://web.whatsapp.com') ||
      url.startsWith('http://www.w3.org') || // SVG namespace, not a fetch
      url.startsWith('https://developer.chrome.com');
    if (!allowed) problem(`${file}: unexpected remote URL ${url}`);
  }
}

const mediaSource = read('src/content/media.js');
const fetchCallers = shipped.filter((file) => /\bfetch\s*\(/.test(read(file)));
for (const file of fetchCallers) {
  // The page bridge may read a media object URL WhatsApp created, and nothing else.
  const bridgeBlobOnly = file === 'src/page/bridge.js' && /\/\^blob:\/\.test\(url\)/.test(read(file)) &&
    (read(file).match(/\bfetch\s*\(/g) || []).length === 1;
  if (file !== 'src/content/media.js' && !bridgeBlobOnly) {
    problem(`${file}: calls fetch(); only src/content/media.js (blob:/data:) and the page bridge (one blob: read) may`);
  }
}
if (fetchCallers.length && !/^(blob|data):/.test(mediaSource) && !/blob|data/.test(mediaSource)) {
  problem('src/content/media.js must restrict fetch to blob:/data: URLs');
}

/* --------------------------------------------------------------- packaging */

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((entry) => entry.js),
];
for (const relative of referenced) {
  if (!fs.existsSync(path.join(ROOT, relative))) problem(`manifest references a missing file: ${relative}`);
}

for (const file of ['README.md', 'LICENSE', 'PRIVACY.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md']) {
  if (!fs.existsSync(path.join(ROOT, file))) problem(`missing repository document: ${file}`);
}

/* ------------------------------------------------------------------ report */

if (problems.length) {
  console.error('\x1b[31m✗ lint failed\x1b[0m\n');
  for (const message of problems) console.error('  • ' + message);
  console.error('');
  process.exit(1);
}

console.log(
  `\x1b[32m✓ lint passed\x1b[0m — ${jsFiles.length} shipped scripts, ${testFiles.length} test files, ` +
    `${manifest.content_scripts[0].js.length} content-script files, permissions ${manifest.permissions.join(', ')}`
);
