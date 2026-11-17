#!/usr/bin/env node
/**
 * Builds the uploadable Chrome extension package.
 *
 * Only runtime files go in: the manifest, src/, icons/ and the licence/privacy
 * documents. Tests, docs, CI config and node_modules are deliberately excluded so the
 * Chrome Web Store review sees exactly what runs.
 *
 * Usage:
 *   node scripts/build.mjs
 *   node scripts/build.mjs --verify-tag v1.0.0   # fails if the tag != manifest version
 *
 * The archive is written with the project's own ZIP writer (src/lib/zip.js), so the
 * packaging path is exercised by the same code users rely on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = path.join(ROOT, 'dist');

const INCLUDE = ['manifest.json', 'src', 'icons', 'README.md', 'LICENSE', 'PRIVACY.md', 'CHANGELOG.md'];

function fail(message) {
  console.error('\x1b[31m✗\x1b[0m ' + message);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;

// --- optional release-tag verification -------------------------------------
const tagIndex = process.argv.indexOf('--verify-tag');
if (tagIndex !== -1) {
  const tag = process.argv[tagIndex + 1];
  if (!tag) fail('--verify-tag needs a tag, e.g. --verify-tag v1.0.0');
  if (tag !== 'v' + version) {
    fail(`git tag ${tag} does not match manifest version ${version} (expected v${version})`);
  }
  console.log('✓ tag ' + tag + ' matches manifest version ' + version);
}

// --- collect files ----------------------------------------------------------
function walk(relative, out) {
  const absolute = path.join(ROOT, relative);
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolute).sort()) {
      if (entry.startsWith('.')) continue;
      walk(path.posix.join(relative, entry), out);
    }
    return;
  }
  out.push(relative);
}

const files = [];
for (const entry of INCLUDE) {
  if (!fs.existsSync(path.join(ROOT, entry))) fail('missing required file: ' + entry);
  walk(entry, files);
}

const forbidden = files.filter((file) =>
  /(^|\/)(node_modules|test|docs|scripts|dist|\.github)(\/|$)/.test(file)
);
if (forbidden.length) fail('refusing to package non-runtime files: ' + forbidden.join(', '));

// --- build the archive -------------------------------------------------------
new Function(fs.readFileSync(path.join(ROOT, 'src/lib/zip.js'), 'utf8'))();
const zip = globalThis.WAEx && globalThis.WAEx.zip;
if (!zip) fail('could not load the project ZIP writer');

const archive = zip.create();
let rawBytes = 0;

for (const file of files) {
  const bytes = fs.readFileSync(path.join(ROOT, file));
  rawBytes += bytes.length;
  const compress = !/\.(png|jpg|jpeg|webp|gif|zip)$/i.test(file);
  await archive.add(file, bytes, { compress, date: new Date() });
}

const blob = archive.generate();
const buffer = Buffer.from(await blob.arrayBuffer());

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const outName = `whatsapp-chat-export-v${version}.zip`;
const outPath = path.join(DIST, outName);
fs.writeFileSync(outPath, buffer);

// --- verify the archive structurally ----------------------------------------
function u16(offset) {
  return buffer.readUInt16LE(offset);
}
function u32(offset) {
  return buffer.readUInt32LE(offset);
}

const eocdSignature = 0x06054b50;
let eocd = -1;
for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 65558; i--) {
  if (u32(i) === eocdSignature) {
    eocd = i;
    break;
  }
}
if (eocd === -1) fail('generated archive has no end-of-central-directory record');

const entryCount = u16(eocd + 10);
const centralSize = u32(eocd + 12);
const centralOffset = u32(eocd + 16);

if (entryCount !== files.length) {
  fail(`archive declares ${entryCount} entries but ${files.length} were added`);
}
if (centralOffset + centralSize !== eocd) {
  fail('central directory does not end where the end record begins');
}
if (u32(centralOffset) !== 0x02014b50) {
  fail('central directory signature is wrong');
}
if (buffer.subarray(0, 4).toString('hex') !== '504b0304') fail('local file header signature is wrong');

// The manifest must be the first entry so the store reads it without guessing.
const firstNameLength = u16(26);
const firstName = buffer.subarray(30, 30 + firstNameLength).toString('utf8');
if (firstName !== 'manifest.json') fail('manifest.json must be the first archive entry, found ' + firstName);

console.log(
  '\x1b[32m✓\x1b[0m packaged ' +
    files.length +
    ' files · ' +
    (buffer.length / 1024).toFixed(1) +
    ' KB compressed (' +
    (rawBytes / 1024).toFixed(1) +
    ' KB raw) · v' +
    version
);
console.log('  ' + files.join('\n  '));
console.log('\n  → ' + path.relative(ROOT, outPath));
