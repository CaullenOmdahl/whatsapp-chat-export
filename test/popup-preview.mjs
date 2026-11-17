/**
 * Reproduces every screenshot in test/screenshots/ from test/popup-preview.html.
 *
 * Usage:
 *   node test/popup-preview.mjs
 *   CHROME_PATH=/usr/bin/google-chrome node test/popup-preview.mjs
 *
 * Requires headless-capable Chrome/Chromium. No npm dependencies.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PREVIEW_URL = pathToFileURL(path.join(ROOT, 'test', 'popup-preview.html')).href;
const OUT_DIR = path.join(ROOT, 'test', 'screenshots');

const SHOTS = [
  { name: 'loading', query: 'state=loading' },
  { name: 'ready', query: 'state=ready' },
  { name: 'ready-long', query: 'state=ready&long=1' },
  { name: 'ready-full', query: 'state=ready&full=1', size: '380,1100' },
  { name: 'ready-dark', query: 'state=ready&theme=dark' },
  { name: 'ready-download', query: 'state=ready&media=download&full=1', size: '380,1100' },
  { name: 'ready-download-dark', query: 'state=ready&media=download&theme=dark&full=1', size: '380,1100' },
  { name: 'ready-auto-dark', query: 'state=ready', extra: ['--force-dark-mode'] },
  { name: 'no-chat', query: 'state=no-chat' },
  { name: 'no-tab', query: 'state=no-tab' },
  { name: 'not-ready', query: 'state=not-ready' },
  { name: 'exporting', query: 'state=exporting' },
  { name: 'exporting-media', query: 'state=exporting&phase=media' },
  { name: 'exporting-indeterminate', query: 'state=exporting&phase=indeterminate' },
  { name: 'exporting-dark', query: 'state=exporting&theme=dark' },
  { name: 'done', query: 'state=done' },
  { name: 'done-long', query: 'state=done&long=1' },
  { name: 'done-dark', query: 'state=done&theme=dark' },
  { name: 'error', query: 'state=error' },
  { name: 'error-dark', query: 'state=error&theme=dark' },
  { name: 'diag', query: 'state=ready&diag=1' },
  { name: 'diag-bottom', query: 'state=ready&action=diagbottom', budget: 2500 },
  { name: 'diag-copied', query: 'state=ready&action=diagcopy', budget: 1800 },
  { name: 'action-custombad', query: 'state=ready&action=custombad&full=1', size: '380,1200', budget: 3000 },
  { name: 'action-export-done', query: 'state=ready&action=export', budget: 8000 },
  { name: 'action-cancel', query: 'state=ready&action=cancel', budget: 4000 },
];

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  throw new Error('Could not find Chrome/Chromium. Set CHROME_PATH to its executable.');
}

function main() {
  const chrome = findChrome();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wax-popup-preview-'));
  const failures = [];

  try {
    for (const shot of SHOTS) {
      const output = path.join(OUT_DIR, `${shot.name}.png`);
      const args = [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        `--window-size=${shot.size || '380,640'}`,
        `--virtual-time-budget=${shot.budget || 3000}`,
        `--user-data-dir=${profileDir}`,
        `--screenshot=${output}`,
        ...(shot.extra || []),
        `${PREVIEW_URL}?${shot.query}`,
      ];
      const result = spawnSync(chrome, args, { timeout: 60000, stdio: 'ignore' });
      const exists = fs.existsSync(output);
      const bytes = exists ? fs.statSync(output).size : 0;
      const ok = result.status === 0 && exists && bytes > 1000;
      if (!ok) failures.push(shot.name);
      console.log(`${ok ? '✓' : '✗'} ${shot.name.padEnd(24)} ${bytes} bytes  ${shot.query}`);
    }
  } finally {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`\n${failures.length} screenshot(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`\nWrote ${SHOTS.length} screenshots to ${path.relative(ROOT, OUT_DIR)}/`);
}

main();
