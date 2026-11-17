/**
 * Regenerates the sample exports in docs/examples/ from the test fixture.
 * Run with: node test/make-examples.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, createEnv, loadScripts, CONTENT_FILES } from './harness.mjs';
import { buildFixtureHtml } from './fixture.mjs';

const MEDIA_URL = 'blob:https://web.whatsapp.com/9f1c2d3e-media';
const OUT = path.join(ROOT, 'docs', 'examples');

const env = createEnv(buildFixtureHtml(), {
  responses: { [MEDIA_URL]: { bytes: new Uint8Array(2048).fill(7), type: 'image/jpeg' } },
});
loadScripts(env.window, CONTENT_FILES);
const WAEx = env.window.WAEx;

const scroller = env.window.document.getElementById('msg-scroller');
scroller.__scrollHeight = 1200;
scroller.__clientHeight = 600;

const order = WAEx.extractor.resolveDateOrder(
  WAEx.extractor.getRows().map((row) => {
    const pre = row.querySelector('[data-pre-plain-text]');
    return pre ? WAEx.datetime.parsePrePlainText(pre.getAttribute('data-pre-plain-text')).dateText : null;
  }).filter(Boolean)
);

const parsed = WAEx.extractor.parseMessages({ includeReactions: true });
const messages = parsed.messages.filter((message) => message.type !== 'system');

// Give the media item a plausible archive path so the HTML example shows the
// bundled-media rendering instead of a placeholder.
const image = messages.find((message) => message.type === 'image');
if (image) {
  image.media.zipPath = 'media/0001-image.jpg';
  image.media.missing = false;
}

fs.mkdirSync(OUT, { recursive: true });

const exportedAt = new Date(2026, 10, 18, 9, 30, 0).getTime();
const stats = WAEx.formats.summarize(messages);

for (const format of WAEx.FORMATS) {
  const settings = WAEx.normalizeSettings({ format: format.id, mediaMode: 'link' });
  const meta = {
    chat: { name: 'Design Team', isGroup: true },
    exportedAt,
    settings,
    stats,
  };
  const output = WAEx.formats.serialize(format.id, messages, meta);
  const file = path.join(OUT, 'example-chat.' + output.extension);
  fs.writeFileSync(file, output.text, 'utf8');
  console.log('wrote', path.relative(ROOT, file), '(' + output.text.length + ' bytes)');
}

console.log('messages:', messages.length, '· order:', order);
env.dom.window.close();
