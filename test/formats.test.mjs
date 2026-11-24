import { suite, check, eq, ok, summary, loadLibsInNode } from './harness.mjs';

loadLibsInNode(['src/lib/namespace.js', 'src/lib/datetime.js', 'src/lib/formats.js']);
const WAEx = globalThis.WAEx;
const formats = WAEx.formats;
const dt = WAEx.datetime;

const AT = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

function sampleMessages() {
  return [
    {
      id: 'true_1@g.us_A1',
      timestamp: AT(2023, 11, 14, 9, 15),
      dateKey: '2023-11-14',
      author: 'You',
      isOutgoing: true,
      type: 'text',
      text: 'Morning! <script>alert("xss")</script> & "quotes"',
      quoted: null,
      reactions: [],
      media: null,
    },
    {
      id: 'false_1@g.us_A2',
      timestamp: AT(2023, 11, 14, 9, 16),
      dateKey: '2023-11-14',
      author: 'Bob',
      isOutgoing: false,
      type: 'text',
      text: 'Line one\nLine two, with a comma',
      quoted: { author: 'You', text: 'Morning!' },
      reactions: [{ emoji: '👍', count: 2 }],
      media: null,
    },
    {
      id: 'false_1@g.us_A3',
      timestamp: AT(2023, 11, 15, 10, 0),
      dateKey: '2023-11-15',
      author: 'Bob',
      isOutgoing: false,
      type: 'image',
      text: "Here's the deck",
      quoted: null,
      reactions: [],
      media: {
        kind: 'image',
        fileName: 'deck.png',
        mime: 'image/png',
        bytes: 2048,
        url: 'blob:x',
        missing: false,
        zipPath: 'media/0001-deck.png',
      },
    },
    {
      id: 'false_1@g.us_A4',
      timestamp: AT(2023, 11, 15, 10, 5),
      dateKey: '2023-11-15',
      author: 'Bob',
      isOutgoing: false,
      type: 'voice',
      text: '',
      quoted: null,
      reactions: [],
      media: { kind: 'voice', fileName: '', mime: 'audio/ogg', bytes: 0, url: '', missing: true, zipPath: '' },
    },
    {
      id: 'system_1',
      timestamp: AT(2023, 11, 15, 10, 6),
      dateKey: '2023-11-15',
      author: '',
      isOutgoing: false,
      type: 'system',
      text: 'Alice added Carol',
      quoted: null,
      reactions: [],
      media: null,
    },
  ];
}

const settings = WAEx.normalizeSettings({ format: 'html', mediaMode: 'link' });
const meta = (extra) =>
  Object.assign(
    {
      chat: { name: 'Design Team', isGroup: true },
      exportedAt: AT(2023, 11, 18, 12, 0),
      settings: settings,
    },
    extra || {}
  );

suite('formats: summary and grouping');

check('summarize counts, participants and range', () => {
  const stats = formats.summarize(sampleMessages());
  eq(stats.total, 5);
  eq(stats.outgoing, 1);
  eq(stats.incoming, 4);
  eq(stats.authors, [
    { name: 'Bob', count: 3 },
    { name: 'You', count: 1 },
  ]);
  eq(stats.range.start, AT(2023, 11, 14, 9, 15));
  eq(stats.range.end, AT(2023, 11, 15, 10, 6));
});

check('groupByDay splits on the day key', () => {
  const groups = formats.groupByDay(sampleMessages(), dt);
  eq(groups.length, 2);
  eq(groups[0].key, '2023-11-14');
  eq(groups[0].label, '14 Nov 2023');
  eq(groups[0].messages.length, 2);
  eq(groups[1].messages.length, 3);
});

suite('formats: plain text');

check('text export has header, participants and messages', () => {
  const out = formats.serialize('txt', sampleMessages(), meta());
  eq(out.extension, 'txt');
  ok(out.text.includes('WhatsApp Chat with Design Team'));
  ok(out.text.includes('[2023-11-14 09:15:00] You: Morning!'));
  ok(out.text.includes('> You: Morning!'), 'quoted reply should be indented');
  ok(out.text.includes('reactions: 👍 2'));
  ok(out.text.includes('[Voice message'));
  ok(out.text.includes('Alice added Carol'), 'system messages included in raw text');
  ok(out.text.includes('--- 14 Nov 2023 ---'));
  ok(out.text.includes('Not affiliated with WhatsApp'));
});

check('text media placeholder points at the archive path', () => {
  const out = formats.serialize('txt', sampleMessages(), meta());
  ok(out.text.includes('[Photo -> media/0001-deck.png]'));
});

suite('formats: csv');

check('csv has a stable header and a BOM', () => {
  const out = formats.serialize('csv', sampleMessages(), meta());
  eq(out.extension, 'csv');
  ok(out.text.startsWith('\ufeff'));
  const header = out.text.replace('\ufeff', '').split('\r\n')[0];
  eq(header.split(','), [
    'timestamp_iso',
    'timestamp_ms',
    'date',
    'time',
    'author',
    'direction',
    'type',
    'text',
    'quoted_author',
    'quoted_text',
    'reactions',
    'media_kind',
    'media_file',
    'media_missing',
    'message_id',
  ]);
});

check('csv quotes commas, quotes and newlines', () => {
  const out = formats.serialize('csv', sampleMessages(), meta());
  const lines = out.text.split('\r\n');
  eq(lines.length, 6, 'header plus five rows');
  ok(out.text.includes('"Line one\nLine two, with a comma"'));
  ok(out.text.includes('"Morning! <script>alert(""xss"")</script> & ""quotes"""'));
  ok(out.text.includes(',outgoing,'));
  ok(out.text.includes(',incoming,'));
});

check('csv media columns', () => {
  const out = formats.serialize('csv', sampleMessages(), meta());
  ok(out.text.includes('media/0001-deck.png'));
  ok(out.text.includes(',voice,,true,'));
});

suite('formats: json');

check('json payload is valid and complete', () => {
  const out = formats.serialize('json', sampleMessages(), meta());
  eq(out.extension, 'json');
  const payload = JSON.parse(out.text);
  eq(payload.schema, 'chat-export/v1');
  eq(payload.chat, { name: 'Design Team', isGroup: true });
  eq(payload.stats.total, 5);
  eq(payload.stats.days.length, 2);
  eq(payload.messages.length, 5);
  eq(payload.messages[1].quoted, { author: 'You', text: 'Morning!' });
  eq(payload.messages[2].media.file, 'media/0001-deck.png');
  eq(payload.messages[0].timestampISO, new Date(AT(2023, 11, 14, 9, 15)).toISOString());
});

suite('formats: html');

check('html escapes user content', () => {
  const out = formats.serialize('html', sampleMessages(), meta());
  eq(out.extension, 'html');
  ok(!out.text.includes('<script>alert("xss")</script>'), 'script tag must not survive');
  ok(out.text.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
  ok(out.text.includes('&amp; &quot;quotes&quot;'));
});

check('html structure: bubbles, day dividers, sender labels', () => {
  const out = formats.serialize('html', sampleMessages(), meta());
  ok(out.text.startsWith('<!DOCTYPE html>'));
  ok(out.text.includes('<div class="day"><span>14 Nov 2023</span></div>'));
  ok(out.text.includes('<div class="msg out">'));
  ok(out.text.includes('<div class="msg in">'));
  ok(out.text.includes('<div class="author">Bob</div>'), 'incoming messages are labelled');
  ok(!out.text.includes('<div class="author">You</div>'), 'outgoing messages are not labelled');
  ok(out.text.includes('<div class="quote">'));
  ok(out.text.includes('<span class="reaction">👍 2</span>'));
  ok(out.text.includes('<div class="system"><span>Alice added Carol</span></div>'));
  ok(out.text.includes('Not affiliated with, endorsed by, or sponsored by WhatsApp LLC or Meta.'));
});

check('html embeds media via relative path', () => {
  const out = formats.serialize('html', sampleMessages(), meta());
  ok(out.text.includes('<img loading="lazy" src="media/0001-deck.png" alt="deck.png">'));
});

check('html marks uncaptured media as missing', () => {
  const out = formats.serialize('html', sampleMessages(), meta());
  ok(out.text.includes('[Voice message — not loaded in WhatsApp, so it was not saved]'));
});

check('html honours mediaMode skip', () => {
  const skipSettings = WAEx.normalizeSettings({ mediaMode: 'skip' });
  const out = formats.serialize(
    'html',
    sampleMessages(),
    meta({ settings: skipSettings })
  );
  ok(!out.text.includes('not loaded in WhatsApp'));
  ok(!out.text.includes('media/0001-deck.png'));
});

check('html sender labels can be disabled', () => {
  const noLabels = WAEx.normalizeSettings({ senderLabels: false });
  const out = formats.serialize('html', sampleMessages(), meta({ settings: noLabels }));
  ok(!out.text.includes('<div class="author">Bob</div>'));
});

check('html reactions can be disabled', () => {
  const noReactions = WAEx.normalizeSettings({ includeReactions: false });
  const out = formats.serialize('html', sampleMessages(), meta({ settings: noReactions }));
  ok(!out.text.includes('class="reaction"'));
});

suite('formats: file names');

check('base name uses the chat name and export day', () => {
  const name = formats.buildBaseName('Design Team', AT(2023, 11, 18, 12, 0));
  eq(name, 'WhatsApp Chat with Design Team - 2023-11-18');
});

check('unsafe characters are stripped from chat names', () => {
  eq(formats.sanitizeFileName('a/b:c*?"<>|'), 'a b c');
  eq(formats.sanitizeFileName('   '), 'chat');
  eq(formats.sanitizeFileName('x'.repeat(200)).length, 80);
});

check('unknown formats fall back to html', () => {
  const out = formats.serialize('nonsense', sampleMessages(), meta());
  eq(out.extension, 'html');
});

suite('formats: completeness outcome (issue #8)');

const outcome = (status, extra) =>
  Object.assign(
    {
      status: status,
      reason: status === 'complete' ? 'Reached the first message of the chat.' : 'WhatsApp stopped returning older messages.',
      method: 'message-store',
      loadedMessages: 5,
      exportedMessages: 3,
      mediaItems: 4,
      mediaSaved: 3,
      mediaMissing: 1,
    },
    extra || {}
  );
const downloadMeta = (c) => meta({ completeness: c, settings: Object.assign({}, settings, { mediaMode: 'download' }) });

check('TXT states the outcome and the separate counts', () => {
  const text = formats.serialize('txt', sampleMessages(), downloadMeta(outcome('partial'))).text;
  ok(/^History: PARTIAL — WhatsApp stopped returning older messages\.$/m.test(text), text.slice(0, 400));
  ok(/^Messages: 3 exported \(5 loaded from WhatsApp\)$/m.test(text));
  ok(/^Media: 3 of 4 saved, 1 not saved$/m.test(text));
  const complete = formats.serialize('txt', sampleMessages(), downloadMeta(outcome('complete'))).text;
  ok(/^History: Complete — Reached the first message of the chat\.$/m.test(complete));
});

check('JSON carries the outcome as data', () => {
  const data = JSON.parse(formats.serialize('json', sampleMessages(), downloadMeta(outcome('unknown'))).text);
  eq(data.completeness.status, 'unknown');
  eq(data.completeness.mediaMissing, 1);
});

check('HTML warns at the top only when the export is not known to be complete', () => {
  const partial = formats.serialize('html', sampleMessages(), downloadMeta(outcome('partial'))).text;
  ok(/<div class="outcome">History: PARTIAL — /.test(partial), 'partial: notice at the top');
  const complete = formats.serialize('html', sampleMessages(), downloadMeta(outcome('complete'))).text;
  ok(!/<div class="outcome">/.test(complete), 'complete: no notice');
  ok(/History: Complete — /.test(complete), 'complete: stated in the footer');
});

check('media WhatsApp Web could not get is labelled as such', () => {
  const messages = sampleMessages();
  const withMedia = messages.find((m) => m.media) || messages[0];
  withMedia.media = { kind: 'image', fileName: '', mime: 'image/jpeg', bytes: 0, missing: true, unavailable: true, zipPath: '' };
  withMedia.type = 'image';
  const text = formats.serialize('txt', messages, meta()).text;
  ok(/\[Photo \(not available to WhatsApp Web\)\]/.test(text), text);
  const data = JSON.parse(formats.serialize('json', messages, meta()).text);
  ok(data.messages.some((m) => m.media && m.media.unavailable === true));
});

check('no outcome recorded: nothing is claimed', () => {
  const text = formats.serialize('txt', sampleMessages(), meta()).text;
  ok(!/^History: /m.test(text));
  eq(JSON.parse(formats.serialize('json', sampleMessages(), meta()).text).completeness, null);
});

process.exit(summary() ? 0 : 1);
