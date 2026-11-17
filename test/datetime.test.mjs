import { suite, check, eq, ok, summary, loadLibsInNode } from './harness.mjs';

loadLibsInNode(['src/lib/namespace.js', 'src/lib/datetime.js']);
const dt = globalThis.WAEx.datetime;
const MS_DAY = 86400000;

suite('datetime: data-pre-plain-text parsing');

check('US format with AM/PM', () => {
  const parsed = dt.parsePrePlainText('[10:30 AM, 11/14/2023] Alice: ');
  eq(parsed, { timeText: '10:30 AM', dateText: '11/14/2023', author: 'Alice' });
});

check('European format, dotted date', () => {
  const parsed = dt.parsePrePlainText('[10:30, 14.11.2023] Bob: ');
  eq(parsed, { timeText: '10:30', dateText: '14.11.2023', author: 'Bob' });
});

check('ISO date and seconds', () => {
  const parsed = dt.parsePrePlainText('[22:05:12, 2023-11-14] Carol: ');
  eq(parsed, { timeText: '22:05:12', dateText: '2023-11-14', author: 'Carol' });
});

check('author names keep punctuation', () => {
  const parsed = dt.parsePrePlainText('[09:00, 01/02/2024] Dr. Smith: ');
  eq(parsed.author, 'Dr. Smith');
});

check('phone-number author', () => {
  const parsed = dt.parsePrePlainText('[09:00, 01/02/2024] +49 151 2345: ');
  eq(parsed.author, '+49 151 2345');
});

check('rejects malformed input', () => {
  eq(dt.parsePrePlainText('no brackets here'), null);
  eq(dt.parsePrePlainText('[10:30] Alice: '), null);
  eq(dt.parsePrePlainText(''), null);
});

suite('datetime: time parsing');

check('12 AM is midnight', () => {
  eq(dt.parseTimeText('12:00 AM'), { hours: 0, minutes: 0, seconds: 0 });
});

check('12 PM is noon', () => {
  eq(dt.parseTimeText('12:30 PM'), { hours: 12, minutes: 30, seconds: 0 });
});

check('24h with seconds', () => {
  eq(dt.parseTimeText('22:05:12'), { hours: 22, minutes: 5, seconds: 12 });
});

check('lowercase meridiem with dots', () => {
  eq(dt.parseTimeText('7:05 p.m.'), { hours: 19, minutes: 5, seconds: 0 });
});

check('invalid clock values rejected', () => {
  eq(dt.parseTimeText('25:00'), null);
  eq(dt.parseTimeText('not a time'), null);
});

suite('datetime: date parsing and day/month order');

check('day-first explicit', () => {
  eq(dt.parseDateText('14/11/2023', 'dmy'), { year: 2023, month: 11, day: 14 });
});

check('month-first explicit', () => {
  eq(dt.parseDateText('11/14/2023', 'mdy'), { year: 2023, month: 11, day: 14 });
});

check('ambiguous follows requested order', () => {
  eq(dt.parseDateText('03/04/2023', 'dmy'), { year: 2023, month: 4, day: 3 });
  eq(dt.parseDateText('03/04/2023', 'mdy'), { year: 2023, month: 3, day: 4 });
});

check('ISO-first is unambiguous', () => {
  eq(dt.parseDateText('2023-11-14', 'dmy'), { year: 2023, month: 11, day: 14 });
});

check('month-name formats', () => {
  eq(dt.parseDateText('14 Nov 2023', 'dmy'), { year: 2023, month: 11, day: 14 });
  eq(dt.parseDateText('November 14, 2023', 'dmy'), { year: 2023, month: 11, day: 14 });
});

check('two-digit years', () => {
  eq(dt.parseDateText('14/11/23', 'dmy'), { year: 2023, month: 11, day: 14 });
});

check('impossible dates rejected', () => {
  eq(dt.parseDateText('31/02/2023', 'dmy'), null);
  eq(dt.parseDateText('00/11/2023', 'dmy'), null);
});

check('order inference from unambiguous samples', () => {
  eq(dt.inferDateOrder(['25/12/2023', '12/11/2023']), 'dmy');
  eq(dt.inferDateOrder(['12/25/2023', '11/12/2023']), 'mdy');
});

check('order inference falls back when samples are ambiguous', () => {
  eq(dt.inferDateOrder(['03/04/2023', '05/06/2023'], 'mdy'), 'mdy');
});

check('locale guess', () => {
  eq(dt.suggestOrderFromLocale('en-US'), 'mdy');
  eq(dt.suggestOrderFromLocale('en-GB'), 'dmy');
  eq(dt.suggestOrderFromLocale('de-DE'), 'dmy');
  eq(dt.suggestOrderFromLocale(''), 'dmy');
});

suite('datetime: epochs and formatting');

check('round-trips through local time', () => {
  const ts = dt.toEpoch({ year: 2023, month: 11, day: 14 }, { hours: 10, minutes: 30, seconds: 5 });
  eq(dt.dateKey(ts), '2023-11-14');
  eq(dt.formatTime(ts, true), '10:30:05');
  eq(dt.formatDate(ts), '14 Nov 2023');
  eq(dt.formatDateTime(ts), '2023-11-14 10:30:05');
});

check('defaults missing time to midnight', () => {
  const ts = dt.toEpoch({ year: 2023, month: 1, day: 2 }, null);
  eq(dt.formatTime(ts), '00:00');
});

check('parseIsoDate start and end of day', () => {
  const start = dt.parseIsoDate('2023-11-14', false);
  const end = dt.parseIsoDate('2023-11-14', true);
  eq(dt.formatTime(start), '00:00');
  eq(dt.formatTime(end), '23:59');
  ok(end - start > MS_DAY - 2000, 'end-of-day should be within one day');
  eq(dt.parseIsoDate('nope', false), null);
});

check('relative time buckets', () => {
  const now = Date.now();
  eq(dt.relativeTime(now - 1000, now), 'just now');
  eq(dt.relativeTime(now - 5 * 60000, now), '5m ago');
  eq(dt.relativeTime(now - 3 * 3600000, now), '3h ago');
  eq(dt.relativeTime(now - 4 * MS_DAY, now), '4d ago');
});

suite('datetime: settings date ranges');

check('all time is unbounded', () => {
  eq(dt.rangeForSettings({ dateRange: 'all' }), { start: null, end: null });
});

check('7 days starts at local midnight', () => {
  const now = Date.now();
  const bounds = dt.rangeForSettings({ dateRange: '7d' }, now);
  ok(bounds.start !== null && bounds.end === null, 'expected a bounded start');
  const startDate = new Date(bounds.start);
  eq(startDate.getHours(), 0);
  eq(startDate.getMinutes(), 0);
  const drift = Math.abs(now - 7 * MS_DAY - bounds.start);
  ok(drift < MS_DAY, 'start should be within a day of seven days ago');
});

check('custom range respects both ends', () => {
  const bounds = dt.rangeForSettings({
    dateRange: 'custom',
    customStart: '2023-11-14',
    customEnd: '2023-11-16',
  });
  eq(dt.formatDateTime(bounds.start), '2023-11-14 00:00:00');
  eq(dt.formatDateTime(bounds.end), '2023-11-16 23:59:59');
});

check('custom range with empty bounds is unbounded', () => {
  eq(dt.rangeForSettings({ dateRange: 'custom', customStart: '', customEnd: '' }), {
    start: null,
    end: null,
  });
});

check('inRange respects both bounds', () => {
  const bounds = { start: 1000, end: 2000 };
  ok(dt.inRange(1500, bounds));
  ok(!dt.inRange(500, bounds));
  ok(!dt.inRange(2500, bounds));
  ok(dt.inRange(999999, null));
});

process.exit(summary() ? 0 : 1);
