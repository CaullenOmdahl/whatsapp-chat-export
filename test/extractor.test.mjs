import {
  createEnv,
  loadScripts,
  CONTENT_FILES,
  fastHistoryLimits,
  suite,
  check,
  checkAsync,
  eq,
  ok,
  summary,
} from './harness.mjs';
import { buildFixtureHtml, buildEmptyFixtureHtml, olderRows, conversationRows } from './fixture.mjs';

const AT = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s || 0, 0).getTime();

function boot(html, options = {}) {
  const env = createEnv(html, options);
  loadScripts(env.window, CONTENT_FILES);
  fastHistoryLimits(env.window);
  const document = env.window.document;
  const scroller = document.getElementById('msg-scroller');
  if (scroller) {
    scroller.__scrollHeight = options.scrollHeight || 1200;
    scroller.__clientHeight = 600;
  }
  return { ...env, document, scroller, WAEx: env.window.WAEx };
}

/* ------------------------------------------------------------------ main */

const main = boot(buildFixtureHtml());

suite('extractor: page discovery');

check('finds the conversation panel', () => {
  const panel = main.WAEx.extractor.findMain();
  ok(panel, 'expected #main');
  eq(panel.id, 'main');
});

check('finds the message list scroll container', () => {
  const scroller = main.WAEx.extractor.findScrollContainer();
  eq(scroller && scroller.id, 'msg-scroller');
});

check('reads the rendered rows in DOM order', () => {
  const rows = main.WAEx.extractor.getRows();
  eq(rows.length, 13);
});

check('reads chat name, group flag and initials', () => {
  const info = main.WAEx.extractor.getChatInfo();
  eq(info.found, true);
  eq(info.name, 'Design Team');
  eq(info.initials, 'DT');
  eq(info.isGroup, true);
  eq(info.renderedCount, 10);
});

check('rendered date range uses inferred day/month order', () => {
  const info = main.WAEx.extractor.getChatInfo();
  ok(info.dateRange, 'expected a date range');
  eq(main.WAEx.datetime.dateKey(info.dateRange.start), '2023-11-12');
  eq(main.WAEx.datetime.dateKey(info.dateRange.end), '2023-12-25');
});

check('no open conversation is reported cleanly', () => {
  const empty = boot(buildEmptyFixtureHtml());
  const info = empty.WAEx.extractor.getChatInfo();
  eq(info.found, false);
  ok(/No conversation is open/.test(info.reason), 'expected a helpful reason, got: ' + info.reason);
  eq(info.renderedCount, 0);
});

/* --------------------------------------------------------------- parsing */

suite('extractor: message parsing');

const parsed = main.WAEx.extractor.parseMessages();
const byId = Object.fromEntries(parsed.messages.map((m) => [m.id.split('_').pop(), m]));

check('parses every message plus system notices', () => {
  eq(parsed.messages.length, 11);
  eq(parsed.warnings.length, 0, 'no warnings expected: ' + JSON.stringify(parsed.warnings));
});

check('infers day-first date order from an unambiguous date', () => {
  eq(parsed.order, 'dmy');
  eq(byId.AAA1.timestamp, AT(2023, 11, 12, 9, 15));
  eq(byId.AAA1.dateKey, '2023-11-12');
});

check('messages are in chronological order', () => {
  const stamps = parsed.messages.filter((m) => m.timestamp).map((m) => m.timestamp);
  for (let i = 1; i < stamps.length; i++) {
    ok(stamps[i] >= stamps[i - 1], `message ${i} is out of order`);
  }
});

check('incoming message: author, direction and text', () => {
  eq(byId.AAA1.author, 'Alice');
  eq(byId.AAA1.isOutgoing, false);
  eq(byId.AAA1.text, "Yes! Let's do 10am");
  eq(byId.AAA1.type, 'text');
});

check('outgoing message is detected from the data-id prefix', () => {
  eq(byId.AAA3.isOutgoing, true);
  eq(byId.AAA3.text, 'Great 👍');
});

check('quoted replies are split from the body', () => {
  eq(byId.AAA1.quoted, { author: 'Bob', text: 'Are we still on for Friday?' });
});

check('line breaks survive', () => {
  eq(byId.AAA2.text, "Perfect.\nI'll bring coffee ☕");
  eq(byId.BBB3.text, 'See you in January.\n\nHappy holidays!');
});

check('emoji rendered as images are kept in the text', () => {
  eq(byId.BBB1.text, 'Merry Christmas! 🎄');
  eq(byId.AAA2.text.includes('☕'), true);
});

check('image message: caption, media kind, blob url', () => {
  const m = byId.AAA4;
  eq(m.type, 'image');
  eq(m.text, "Here's the deck");
  eq(m.media.kind, 'image');
  eq(m.media.missing, false);
  eq(m.media.url, 'blob:https://web.whatsapp.com/9f1c2d3e-media');
});

check('reactions are parsed with counts', () => {
  eq(byId.AAA4.reactions, [{ emoji: '👍', count: 2 }]);
});

check('document message: file name and missing flag', () => {
  const m = byId.AAA6;
  eq(m.type, 'document');
  eq(m.media.kind, 'document');
  eq(m.media.fileName, 'Q4-plan.pdf');
  eq(m.media.missing, true);
});

check('voice message: type and missing media', () => {
  const m = byId.AAA7;
  eq(m.type, 'voice');
  eq(m.media.missing, true);
  eq(m.media.url, '');
});

check('deleted messages are typed as deleted', () => {
  eq(byId.BBB2.type, 'deleted');
});

check('date dividers are not messages', () => {
  const texts = parsed.messages.map((m) => m.text);
  ok(!texts.some((t) => /^12 November 2023$/.test(t)), 'date divider leaked into messages');
  ok(!texts.some((t) => /^25 December 2023$/.test(t)), 'date divider leaked into messages');
});

check('system notices are captured as system messages', () => {
  const system = parsed.messages.filter((m) => m.type === 'system');
  eq(system.length, 1);
  ok(/end-to-end encrypted/.test(system[0].text));
});

check('emoji-only images are not mistaken for media', () => {
  eq(byId.AAA3.media, null);
  eq(byId.BBB1.media, null);
});

/* ----------------------------------------------------------- diagnostics */

suite('extractor: diagnostics');

check('diagnostics report healthy selectors', () => {
  const report = main.WAEx.extractor.diagnose();
  eq(report.mainPanel, true);
  eq(report.messageList, true);
  eq(report.scrollContainer, true);
  eq(report.renderedRows, 13);
  eq(report.parsedMessages, 11);
  eq(report.warnings, []);
  ok(report.selectors.length >= 6);
  const panelSelector = report.selectors.find((s) => s.name === 'Conversation panel');
  eq(panelSelector.matches, 1);
});

/* --------------------------------------------------------- history loader */

suite('extractor: history loading');

await checkAsync('scrolls up and stops when history is exhausted', async () => {
  const env = boot(buildFixtureHtml());
  const app = env.document.querySelector('div[role="application"]');
  const scroller = env.scroller;
  let loads = 0;
  scroller.__onScrollTop = (value) => {
    if (value === 0 && loads < 2) {
      loads++;
      const holder = env.document.createElement('div');
      holder.innerHTML = olderRows('L' + loads).join('');
      const nodes = Array.from(holder.children);
      for (const node of nodes.reverse()) app.insertBefore(node, app.firstChild);
      scroller.__scrollHeight += 400;
    }
  };

  const progress = [];
  const result = await env.WAEx.extractor.loadAllHistory({
    onProgress: (p) => progress.push(p),
  });

  eq(loads, 2, 'should have simulated two history loads');
  eq(result.loaded, 14, '11 rows + 4 older messages harvested');
  eq(result.cancelled, false);
  eq(result.scroller.id, 'msg-scroller');
  ok(progress.length >= 3, 'progress should have been reported');
  ok(progress[progress.length - 1].loaded >= progress[0].loaded, 'progress must be monotonic');
});

await checkAsync('stops once the requested date range is covered', async () => {
  const env = boot(buildFixtureHtml());
  const app = env.document.querySelector('div[role="application"]');
  const scroller = env.scroller;
  let loads = 0;
  scroller.__onScrollTop = (value) => {
    if (value === 0 && loads < 5) {
      loads++;
      const holder = env.document.createElement('div');
      holder.innerHTML = olderRows('L' + loads).join('');
      const nodes = Array.from(holder.children);
      for (const node of nodes.reverse()) app.insertBefore(node, app.firstChild);
      scroller.__scrollHeight += 200;
    }
  };

  const result = await env.WAEx.extractor.loadAllHistory({
    dateBounds: { start: AT(2023, 11, 12, 0, 0), end: null },
  });

  eq(loads, 1, 'one older page is enough to cross a 12 Nov boundary');
  eq(result.loaded, 12);
});

await checkAsync('honours cancellation', async () => {
  const env = boot(buildFixtureHtml());
  const result = await env.WAEx.extractor.loadAllHistory({
    shouldCancel: () => true,
  });
  eq(result.cancelled, true);
  eq(result.loaded, 10, 'initial harvest still happens before the first cancel check');
});

await checkAsync('restores the original scroll position', async () => {
  const env = boot(buildFixtureHtml());
  env.scroller.__scrollTop = 350;
  const result = await env.WAEx.extractor.loadAllHistory();
  eq(result.originalTop, 350);
  env.WAEx.extractor.restoreScroll(result);
  eq(env.scroller.scrollTop, 350);
});

await checkAsync('recovers harvested nodes that left the DOM', async () => {
  const env = boot(buildFixtureHtml());
  const result = await env.WAEx.extractor.loadAllHistory();
  // Simulate WhatsApp unmounting an off-screen message.
  const victim = env.document.querySelector('div[data-id$="AAA1"]');
  victim.remove();
  eq(env.document.querySelectorAll('#main div[data-id]').length, 9);

  const recovered = env.WAEx.extractor.parseMessages({ harvested: result.seen });
  eq(recovered.messages.length, 11);
  ok(recovered.warnings.some((w) => /recovered from nodes/.test(w)));
});

/* ---------------------------------------- regression: the 26-of-96 bug */

suite('extractor: history regression');

check('finds a message list that hides its scrollbar', () => {
  const env = boot(buildFixtureHtml({ overflow: 'hidden' }));
  const scroller = env.WAEx.extractor.findScrollContainer();
  eq(scroller && scroller.id, 'msg-scroller', 'overflow:hidden lists must still be found');
  eq(env.WAEx.extractor.scrollInfo(scroller).scrollable, true);
});

check('counts unique messages instead of raw data-id nodes', () => {
  const env = boot(buildFixtureHtml());
  const node = env.document.querySelector('div[data-id$="AAA1"]');
  const duplicate = node.cloneNode(true);
  node.parentElement.appendChild(duplicate); // same data-id rendered twice

  eq(env.WAEx.extractor.getChatInfo().renderedCount, 10);
  eq(env.WAEx.extractor.messageNodes().length, 10);
  eq(env.WAEx.extractor.parseMessages().messages.length, 11, 'no duplicated messages');
});

await checkAsync('loads older pages even when the list hides its scrollbar', async () => {
  const env = boot(buildFixtureHtml({ overflow: 'hidden' }));
  const app = env.document.querySelector('div[role="application"]');
  const scroller = env.scroller;
  let loads = 0;
  scroller.__onScrollTop = (value) => {
    if (value === 0 && loads < 2) {
      loads++;
      const holder = env.document.createElement('div');
      holder.innerHTML = olderRows('H' + loads).join('');
      const nodes = Array.from(holder.children);
      for (const node of nodes.reverse()) app.insertBefore(node, app.firstChild);
      scroller.__scrollHeight += 400;
    }
  };

  const result = await env.WAEx.extractor.loadAllHistory();
  ok(result.loaded > 10, 'should have loaded messages older than the initial view, got ' + result.loaded);
  eq(result.scroll.found, true);
  eq(result.scroll.scrollable, true);
  ok(result.messages.length >= result.loaded, 'every loaded message must be exported');
});

await checkAsync('keeps messages that WhatsApp removes from the DOM mid-scroll', async () => {
  const env = boot(buildFixtureHtml());
  const app = env.document.querySelector('div[role="application"]');
  const scroller = env.scroller;
  let loads = 0;
  scroller.__onScrollTop = (value) => {
    if (value === 0 && loads < 1) {
      loads++;
      const holder = env.document.createElement('div');
      holder.innerHTML = olderRows('R1').join('');
      const nodes = Array.from(holder.children);
      for (const node of nodes.reverse()) app.insertBefore(node, app.firstChild);
      scroller.__scrollHeight += 200;
      // WhatsApp unmounts an off-screen message while we scroll.
      const victim = env.document.querySelector('div[data-id$="AAA1"]');
      if (victim) victim.remove();
    }
  };

  const result = await env.WAEx.extractor.loadAllHistory();
  eq(result.loaded, 12);
  ok(
    result.messages.some((message) => /AAA1$/.test(message.id)),
    'a message removed from the DOM must still appear in the export'
  );
  ok(
    result.messages.some((message) => /OLD1R1$/.test(message.id)),
    'older messages must be included'
  );
});

/* ------------------------------------------------------------ edge cases */

suite('extractor: robustness');

check('a page with no conversation panel fails predictably', () => {
  const env = createEnv('<!DOCTYPE html><html><body><div>loading</div></body></html>');
  loadScripts(env.window, CONTENT_FILES);
  const info = env.window.WAEx.extractor.getChatInfo();
  eq(info.found, false);
  let threw = false;
  try {
    env.window.WAEx.extractor.parseMessages();
  } catch (err) {
    threw = true;
  }
  eq(threw, false, 'parseMessages must not throw without a panel');
  eq(env.window.WAEx.extractor.parseMessages().messages, []);
});

check('date order cache can be reset between chats', () => {
  main.WAEx.extractor.resolveDateOrder(['25/12/2023']);
  eq(main.WAEx.extractor.resolveDateOrder([]), 'dmy');
  main.WAEx.extractor.resetDateOrderCache();
  // After reset the locale fallback applies again (jsdom reports en-US).
  eq(main.WAEx.extractor.resolveDateOrder([]), 'mdy');
  main.WAEx.extractor.resetDateOrderCache();
  main.WAEx.extractor.resolveDateOrder(conversationRows().map((r) => (r.match(/\[[^\]]*\]/) || [''])[0]));
});

process.exit(summary() ? 0 : 1);
