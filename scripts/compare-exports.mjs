#!/usr/bin/env node
/**
 * Compares one of this extension's exports against another source's export of the same
 * chat (for example the "Export chat" archive from the WhatsApp phone app).
 *
 *   node scripts/compare-exports.mjs <our-export.zip|.html|.json> <their-export.zip|.txt|.json>
 *
 * Prints aggregate numbers only: message counts, date ranges, media counts, and how much
 * of one export overlaps the other. Message text is never printed, so this is safe to run
 * on a private conversation — but treat the inputs themselves as private and do not
 * commit them.
 *
 * Requires `unzip` on PATH when given .zip inputs. No npm dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/* ------------------------------------------------------------------ input */

function readArchive(file) {
  const buffer = fs.readFileSync(file);
  const isZip = buffer.subarray(0, 2).toString('latin1') === 'PK';
  if (!isZip) return [{ name: path.basename(file), text: buffer.toString('utf8') }];

  const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return names
    .filter((name) => /\.(html|htm|txt|json|csv)$/i.test(name))
    .map((name) => ({
      name,
      text: execFileSync('unzip', ['-p', file, name], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
    }));
}

const MEDIA_FILE = /\.(jpg|jpeg|png|webp|gif|mp4|mov|opus|ogg|mp3|m4a|pdf|docx?|xlsx?|pptx?|vcf)$/i;

/** Count media files inside a zip (0 for plain files). */
function archiveMediaCount(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 2).toString('latin1') !== 'PK') return 0;
  try {
    return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => MEDIA_FILE.test(name)).length;
  } catch (err) {
    return 0;
  }
}

/* --------------------------------------------------------------- text utils */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };

function stripTags(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (match, entity) => ENTITIES[entity] || match);
}

const ATTACHED = /([^\s\u200e]+\.(?:jpg|jpeg|png|webp|gif|mp4|mov|opus|ogg|mp3|m4a|pdf|docx?|xlsx?|pptx?|vcf))\s*\(file attached\)/gi;
const OMITTED = /<Media omitted>|[\u200e]?(?:image|video|sticker|GIF|audio|document|Contact card) omitted/gi;

function normalise(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(ATTACHED, ' ')
    .replace(OMITTED, ' ')
    .replace(/[\u200e\u202f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseShortDate(label) {
  const m = String(label || '').match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  return month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/* ------------------------------------------------------------ our HTML format */

function parseOurHtml(text) {
  const messages = [];
  let day = null;
  for (const segment of text.split(/(<div class="day"><span>[^<]*<\/span><\/div>)/)) {
    const dayMatch = segment.match(/<div class="day"><span>([^<]*)<\/span><\/div>/);
    if (dayMatch) {
      day = parseShortDate(dayMatch[1]) || dayMatch[1];
      continue;
    }
    for (const block of segment.split(/(?=<div class="msg (?:in|out)">)/)) {
      if (!/^<div class="msg (?:in|out)">/.test(block)) continue;
      const body = block.match(/<div class="text">([\s\S]*?)<\/div>/);
      const meta = block.match(/<div class="meta">\s*<span>([^<]*)<\/span>/);
      messages.push({
        at: `${day || '????-??-??'} ${(meta && meta[1]) || '00:00'}`,
        text: body ? stripTags(body[1]).trim() : '',
        media: /<div class="media">/.test(block),
        quote: /<div class="quote">/.test(block),
        reactions: (block.match(/class="reaction"/g) || []).length,
      });
    }
  }
  return { messages, kind: 'html' };
}

/* ------------------------------------------------------- phone text export */

function parsePhoneText(text) {
  const lineRe =
    /^(?:\[)?(\d{1,4}[./-]\d{1,2}[./-]\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AP]M))?\]?\s*(?:[-–]\s*)?(.*)$/i;

  const messages = [];
  let current = null;

  // WhatsApp writes dates in the phone's locale. Infer the order from the file itself:
  // a component above 12 proves which side is the month.
  let monthFirstVotes = 0;
  let dayFirstVotes = 0;
  const allLines = text.split('\n');
  for (const line of allLines) {
    const probe = line.match(lineRe);
    if (!probe) continue;
    const parts = probe[1].split(/[./-]/).map(Number);
    if (parts[1] > 12 && parts[0] <= 12) monthFirstVotes++;
    else if (parts[0] > 12 && parts[1] <= 12) dayFirstVotes++;
  }
  const monthFirst = monthFirstVotes >= dayFirstVotes;

  for (const line of allLines) {
    const match = line.match(lineRe);
    if (!match) {
      if (line.trim() && current) current.text += '\n' + line;
      continue;
    }
    const [, dateText, hourText, minuteText, secondText, meridiem, rest] = match;
    const parts = dateText.split(/[./-]/).map(Number);
    let year = parts[2];
    if (year < 100) year += 2000;
    const month = monthFirst ? parts[0] : parts[1];
    const dayOfMonth = monthFirst ? parts[1] : parts[0];
    let hour = Number(hourText);
    if (meridiem) hour = (hour % 12) + (/pm/i.test(meridiem) ? 12 : 0);
    const at = `${year}-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')} ` +
      `${String(hour).padStart(2, '0')}:${minuteText}`;

    const split = rest.match(/^(.*?):\s([\s\S]*)$/);
    const sender = split ? split[1] : '';
    const body = split ? split[2] : rest;
    current = { at, text: body, sender, system: !sender };
    messages.push(current);
    void secondText;
  }
  return { messages, kind: 'text' };
}

/* ------------------------------------------------------------------- report */

function summarise(label, parsed, mediaFiles) {
  const messages = parsed.messages.filter((message) => !message.system);
  const times = messages.map((message) => message.at).filter(Boolean).sort();
  const days = new Set(times.map((time) => time.slice(0, 10)));
  const mediaRefs =
    parsed.kind === 'html'
      ? messages.filter((message) => message.media).length
      : messages.filter((message) => /\(file attached\)|<Media omitted>/i.test(message.text)).length;
  return {
    label,
    messages: messages.length,
    days: days.size,
    from: times[0] || '—',
    to: times[times.length - 1] || '—',
    mediaRefs,
    mediaFiles,
    quotes: parsed.kind === 'html' ? messages.filter((message) => message.quote).length : 0,
    reactions: parsed.kind === 'html' ? messages.reduce((total, message) => total + message.reactions, 0) : 0,
    multiline: messages.filter((message) => message.text.includes('\n')).length,
  };
}

function pick(entries, extension) {
  return entries.find((entry) => entry.name.toLowerCase().endsWith(extension));
}

function main() {
  const [oursPath, theirsPath] = process.argv.slice(2);
  if (!oursPath || !theirsPath) {
    console.error('usage: node scripts/compare-exports.mjs <our-export> <their-export>');
    process.exit(2);
  }

  const oursEntries = readArchive(oursPath);
  const theirsEntries = readArchive(theirsPath);

  const oursFile = pick(oursEntries, '.html') || pick(oursEntries, '.json') || oursEntries[0];
  const theirsFile = pick(theirsEntries, '.txt') || pick(theirsEntries, '.json') || theirsEntries[0];

  const ours = oursFile.name.endsWith('.json')
    ? { kind: 'json', messages: JSON.parse(oursFile.text).messages.map((message) => ({
        at: message.timestampISO ? message.timestampISO.replace('T', ' ').slice(0, 16) : '',
        text: message.text || '',
        media: Boolean(message.media),
        quote: Boolean(message.quoted),
        reactions: (message.reactions || []).length,
      })) }
    : parseOurHtml(oursFile.text);

  const theirs = theirsFile.name.endsWith('.json')
    ? { kind: 'json', messages: JSON.parse(theirsFile.text).messages.map((message) => ({
        at: message.timestampISO ? message.timestampISO.replace('T', ' ').slice(0, 16) : '',
        text: message.text || '',
      })) }
    : parsePhoneText(theirsFile.text);

  const oursSummary = summarise('ours', ours, archiveMediaCount(oursPath));
  const theirsSummary = summarise('theirs', theirs, archiveMediaCount(theirsPath));

  const [a, b] = [oursSummary, theirsSummary].sort((x, y) => x.messages - y.messages);

  // Match by timestamp+text (minute resolution) where both sides have a timestamp;
  // otherwise fall back to text alone. Counts only, no text is printed.
  const theirsKeys = new Map();
  for (const message of theirs.messages) {
    if (message.system) continue;
    const text = normalise(message.text);
    if (!text) continue;
    const key = `${String(message.at).slice(0, 16)}|${text}`;
    theirsKeys.set(key, (theirsKeys.get(key) || 0) + 1);
  }
  let matched = 0;
  let comparable = 0;
  for (const message of ours.messages) {
    if (message.system) continue;
    const text = normalise(message.text);
    if (!text) continue;
    comparable++;
    const key = `${String(message.at).slice(0, 16)}|${text}`;
    const remaining = theirsKeys.get(key) || 0;
    if (remaining > 0) {
      matched++;
      theirsKeys.set(key, remaining - 1);
    }
  }
  const coverage = b.messages === 0 ? 0 : Math.round((a.messages / b.messages) * 100);
  const textCoverage = comparable === 0 ? 0 : Math.round((matched / comparable) * 100);

  console.log('');
  console.log('                 ours                         theirs');
  console.log('messages         ' + String(oursSummary.messages).padEnd(29) + theirsSummary.messages);
  console.log('days             ' + String(oursSummary.days).padEnd(29) + theirsSummary.days);
  console.log('from             ' + oursSummary.from.padEnd(29) + theirsSummary.from);
  console.log('to               ' + oursSummary.to.padEnd(29) + theirsSummary.to);
  console.log('media refs       ' + String(oursSummary.mediaRefs).padEnd(29) + theirsSummary.mediaRefs);
  console.log('media files      ' + String(oursSummary.mediaFiles).padEnd(29) + theirsSummary.mediaFiles);
  console.log('quoted messages  ' + String(oursSummary.quotes).padEnd(29) + theirsSummary.quotes);
  console.log('reactions        ' + String(oursSummary.reactions).padEnd(29) + theirsSummary.reactions);
  console.log('multiline msgs   ' + String(oursSummary.multiline).padEnd(29) + theirsSummary.multiline);
  console.log('');
  console.log(`text messages: ${matched}/${comparable} of the smaller export found verbatim in the larger one (${textCoverage}%).`);
  console.log(`conversation: ${a.messages} of ${b.messages} messages (${coverage}%).`);
  if (coverage < 95) {
    console.log('→ The smaller export is incomplete. Check the date range and whether history loading stopped early.');
  }
  console.log('');
}

main();
