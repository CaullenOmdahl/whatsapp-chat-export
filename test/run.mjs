/**
 * Runs every test file in its own process (so module state never leaks between
 * suites) and prints a combined summary.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const FILES = [
  'test/manifest.test.mjs',
  'test/datetime.test.mjs',
  'test/formats.test.mjs',
  'test/zip.test.mjs',
  'test/extractor.test.mjs',
  'test/e2e.test.mjs',
  'test/popup.test.mjs',
].filter((file) => fs.existsSync(path.join(ROOT, file)));

const results = [];

for (const file of FILES) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [file], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  results.push({ file, status: run.status, ms: Date.now() - started });
}

console.log('\n' + new Array(60).join('-'));
let failed = 0;
for (const result of results) {
  const ok = result.status === 0;
  if (!ok) failed++;
  const mark = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${mark}  ${result.file}  (${(result.ms / 1000).toFixed(1)}s)`);
}

console.log(
  failed === 0
    ? `\n\x1b[32mAll ${results.length} test files passed.\x1b[0m\n`
    : `\n\x1b[31m${failed} of ${results.length} test files failed.\x1b[0m\n`
);

process.exit(failed === 0 ? 0 : 1);
