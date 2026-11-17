/**
 * Generates the Chrome Web Store artwork into docs/store/.
 *
 *   node test/store-shots.mjs
 *
 * Produces:
 *   - five 1280x800 screenshots (store limit is five, min 1280x800 or 640x400)
 *   - a 440x280 small promo tile
 *   - a 1400x560 marquee tile
 *
 * Uses the popup screenshots in test/screenshots/ as the product shot, so regenerate
 * those first if the UI changed: npm run screenshots && npm run store-shots
 *
 * Chrome's screenshot output is opaque RGB PNG, which is what the store requires.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CHROME = process.env.CHROME_BIN || 'google-chrome';
const OUT = path.join(ROOT, 'docs', 'store');
const PAGE = pathToFileURL(path.join(ROOT, 'test', 'store-shots.html')).href;

const jobs = [
  { file: 'screenshot-1-export.png', width: 1280, height: 800, query: 'shot=1' },
  { file: 'screenshot-2-formats.png', width: 1280, height: 800, query: 'shot=2' },
  { file: 'screenshot-3-media.png', width: 1280, height: 800, query: 'shot=3' },
  { file: 'screenshot-4-progress.png', width: 1280, height: 800, query: 'shot=4' },
  { file: 'screenshot-5-privacy.png', width: 1280, height: 800, query: 'shot=5' },
  { file: 'promo-tile-440x280.png', width: 440, height: 280, query: 'tile=1' },
  { file: 'marquee-1400x560.png', width: 1400, height: 560, query: 'marquee=1' },
];

function run(job) {
  return new Promise((resolve, reject) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wax-store-'));
    const target = path.join(OUT, job.file);
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--force-color-profile=srgb',
      '--virtual-time-budget=3000',
      `--user-data-dir=${profile}`,
      `--window-size=${job.width},${job.height}`,
      `--screenshot=${target}`,
      `${PAGE}?${job.query}`,
    ];
    const chrome = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    chrome.stderr.on('data', (data) => (stderr += data));
    chrome.on('error', reject);
    chrome.on('exit', (code) => {
      fs.rmSync(profile, { recursive: true, force: true });
      if (code !== 0 || !fs.existsSync(target)) {
        reject(new Error(`${job.file}: Chrome exited ${code}\n${stderr.slice(-800)}`));
        return;
      }
      resolve(target);
    });
  });
}

fs.mkdirSync(OUT, { recursive: true });

for (const job of jobs) {
  const file = await run(job);
  const bytes = fs.statSync(file).size;
  console.log(
    `  \x1b[32m✓\x1b[0m ${path.relative(ROOT, file)} — ${job.width}x${job.height}, ${(bytes / 1024).toFixed(0)} KB`
  );
}

console.log('\nStore artwork written to ' + path.relative(ROOT, OUT) + '.');
console.log('Check each image by eye before uploading: docs/RELEASING.md lists the rules.');
