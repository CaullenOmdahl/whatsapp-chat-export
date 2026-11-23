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

/* ------------------------------------- regression: chat not at the newest end */

suite('extractor: bidirectional loading');

await checkAsync('loads the rest of the chat when it starts at the oldest message', async () => {
  // The real-world failure: WhatsApp restores the last scroll position, which can be
  // the very beginning of the conversation. Only scrolling up would find nothing and
  // export just the opening page.
  const rows = conversationRows();
  const initial = rows.slice(0, 5);
  const pages = [rows.slice(5, 9), rows.slice(9)];

  const env = boot(buildFixtureHtml({ rows: initial }));
  const app = env.document.querySelector('div[role="application"]');
  const scroller = env.scroller;
  scroller.__scrollHeight = 700;

  let page = 0;
  scroller.__onScrollTop = (value) => {
    const max = scroller.__scrollHeight - scroller.__clientHeight;
    if (value >= max - 2 && page < pages.length) {
      const holder = env.document.createElement('div');
      holder.innerHTML = pages[page++].join('');
      for (const node of Array.from(holder.children)) app.appendChild(node);
      scroller.__scrollHeight += 500;
    }
  };

  const result = await env.WAEx.extractor.loadAllHistory();
  eq(result.loaded, 10, 'every message must be collected');
  eq(result.messages.length, 11, 'plus the encryption notice');
  eq(result.passes.newer, true, 'the downward pass must run');
  ok(
    result.messages.some((message) => /AAA7$/.test(message.id)),
    'must reach the last message of the chat'
  );
});

await checkAsync('loads in both directions when the chat starts mid-history', async () => {
  const rows = conversationRows();
  const initial = rows.slice(4, 9);
  const above = rows.slice(0, 4);
  const below = [rows.slice(9)];

  const env = boot(buildFixtureHtml({ rows: initial }));
  const app = env.document.querySelector('div[role="application"]');
  const scroller = env.scroller;
  scroller.__scrollHeight = 900;

  let loadedAbove = false;
  let page = 0;
  scroller.__onScrollTop = (value) => {
    const max = scroller.__scrollHeight - scroller.__clientHeight;
    if (value <= 2 && !loadedAbove) {
      loadedAbove = true;
      const holder = env.document.createElement('div');
      holder.innerHTML = above.join('');
      const nodes = Array.from(holder.children);
      for (const node of nodes.reverse()) app.insertBefore(node, app.firstChild);
      scroller.__scrollHeight += 400;
    }
    if (value >= max - 2 && page < below.length) {
      const holder = env.document.createElement('div');
      holder.innerHTML = below[page++].join('');
      for (const node of Array.from(holder.children)) app.appendChild(node);
      scroller.__scrollHeight += 400;
    }
  };

  const result = await env.WAEx.extractor.loadAllHistory();
  eq(result.loaded, 10, 'messages above and below must both be collected');
  ok(result.passes.older && result.passes.newer, 'both passes must run');
});

await checkAsync('skips the downward pass when the newest message is already visible', async () => {
  const env = boot(buildFixtureHtml());
  env.scroller.__scrollTop = 600; // bottom of a 1200px list in a 600px viewport

  const result = await env.WAEx.extractor.loadAllHistory();
  eq(result.startedAtNewest, true);
  eq(result.passes.newer, false, 'no need to walk forward');
  eq(result.loaded, 10);
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

suite('extractor: current WhatsApp data-id format');

/**
 * WhatsApp Web (seen 2026-11) renders `data-id` as one opaque token: no `true_`/`false_`
 * prefix, no chat jid. The extractor used to reject every such node, so nothing was
 * collected while scrolling and an export held only the final screen of messages.
 */
const opaque = (row) =>
  row.replace(/data-id="(?:true|false)_[^"]*_([A-Z0-9]+)"/g, (_, tail) => `data-id="3EB0${tail}C0FFEE"`);

check('opaque data-ids are message nodes, direction comes from .message-out', () => {
  const env = boot(buildFixtureHtml({ rows: conversationRows().map(opaque) }));
  eq(env.WAEx.extractor.messageNodes().length, 10, 'every message node is counted');
  const parsed = env.WAEx.extractor.parseMessages({}).messages;
  const out = parsed.find((m) => m.id === '3EB0AAA3C0FFEE');
  ok(out, 'opaque id is kept as the message id');
  eq(out.isOutgoing, true);
  eq(parsed.find((m) => m.id === '3EB0AAA1C0FFEE').isOutgoing, false);
});

check('a 1:1 chat is not a group just because the user also posted', () => {
  const rows = conversationRows()
    .map(opaque)
    .filter((row) => !/Alice|Carol/.test(row) || /message-out/.test(row));
  const env = boot(buildFixtureHtml({ rows }));
  eq(env.WAEx.extractor.getChatInfo().isGroup, false);
});

await checkAsync('opaque ids: messages that WhatsApp unloads while scrolling are kept', async () => {
  // Start at the oldest message; each page appended below replaces the rows above it,
  // like a virtualised list. Only collection during scrolling can see every message.
  const rows = conversationRows().map(opaque);
  const env = boot(buildFixtureHtml({ rows: rows.slice(0, 5) }));
  const app = env.document.querySelector('div[role="application"]');
  const scroller = env.scroller;
  scroller.__scrollHeight = 700;
  const pages = [rows.slice(5, 9), rows.slice(9)];
  let page = 0;
  scroller.__onScrollTop = (value) => {
    const max = scroller.__scrollHeight - scroller.__clientHeight;
    if (value >= max - 2 && page < pages.length) {
      for (const old of Array.from(app.children)) old.remove();
      const holder = env.document.createElement('div');
      holder.innerHTML = pages[page++].join('');
      for (const node of Array.from(holder.children)) app.appendChild(node);
      scroller.__scrollHeight += 500;
    }
  };

  const result = await env.WAEx.extractor.loadAllHistory();
  eq(result.loaded, 10, 'every message is collected during scrolling');
  const ids = result.messages.map((m) => m.id).filter((id) => id.startsWith('3EB0'));
  eq(
    ids,
    ['AAA1', 'AAA2', 'AAA3', 'AAA4', 'AAA5', 'AAA6', 'AAA7', 'BBB1', 'BBB2', 'BBB3'].map((t) => `3EB0${t}C0FFEE`),
    'exported ids, in order'
  );
});

suite('extractor: slow pages and completeness (issue #6)');

await checkAsync('waits for an older page that arrives late with no interim DOM activity', async () => {
  // Issue #6: a page that took longer than the old 1.1s "quiet DOM" grace was treated
  // as the start of the chat and silently dropped. Same shape, scaled to test timings:
  // the page arrives after several quiet-DOM windows but within one growth timeout.
  const env = boot(buildFixtureHtml());
  const limits = env.WAEx.extractor.LIMITS;
  limits.growthTimeoutMs = 400;
  limits.growthHardCapMs = 800;
  const app = env.document.querySelector('div[role="application"]');
  const scroller = env.scroller;
  scroller.__scrollTop = 600; // starts at the newest message: no downward pass to help
  let fired = false;
  scroller.__onScrollTop = (value) => {
    if (value > 2 || fired) return;
    fired = true;
    setTimeout(() => {
      const holder = env.document.createElement('div');
      holder.innerHTML = olderRows('L').join('');
      for (const node of Array.from(holder.children).reverse()) app.insertBefore(node, app.firstChild);
      scroller.__scrollHeight += 400;
    }, 250);
  };

  const result = await env.WAEx.extractor.loadAllHistory();
  eq(result.loaded, 12, 'the late page is collected');
  ok(
    result.messages.some((m) => /OLD1L$/.test(m.id)) && result.messages.some((m) => /OLD2L$/.test(m.id)),
    'the late page is in the exported messages'
  );
});

await checkAsync('warns when the top of the list is a message, not the start of the chat', async () => {
  const rows = conversationRows().filter((row) => !/end-to-end encrypted/.test(row));
  const env = boot(buildFixtureHtml({ rows }));
  const result = await env.WAEx.extractor.loadAllHistory();
  ok(
    result.warnings.some((w) => /first message of the conversation was reached/.test(w)),
    'expected a completeness warning: ' + JSON.stringify(result.warnings)
  );
});

await checkAsync('no completeness warning when the chat opens with its system notice', async () => {
  const env = boot(buildFixtureHtml());
  const result = await env.WAEx.extractor.loadAllHistory();
  eq(result.warnings, []);
});

await checkAsync('the "include reactions" setting is honoured while scrolling', async () => {
  const env = boot(buildFixtureHtml());
  const result = await env.WAEx.extractor.loadAllHistory({ includeReactions: false });
  const deck = result.messages.find((m) => /AAA4$/.test(m.id));
  eq(deck.reactions, [], 'reactions must be dropped when the option is off');
});

check('without direction classes, delivery ticks mark outgoing messages', () => {
  const rows = conversationRows()
    .map(opaque)
    .map((row) => row.replace(/message-(?:out|in) /, ''))
    .map((row) =>
      /AAA3/.test(row) ? row.replace('</span></span></div>', '</span></span><span data-icon="msg-dblcheck"></span></div>') : row
    );
  const env = boot(buildFixtureHtml({ rows }));
  const parsed = env.WAEx.extractor.parseMessages({}).messages;
  eq(parsed.find((m) => m.id === '3EB0AAA3C0FFEE').isOutgoing, true);
  eq(parsed.find((m) => m.id === '3EB0AAA1C0FFEE').isOutgoing, false);
});

suite('extractor: off-screen placeholders (v1.0.3 live failure)');

/**
 * Live WhatsApp (2026-11) keeps messages away from the viewport as empty shells: the
 * data-id node with no timestamp attribute, text or media. It fills them in shortly
 * after they scroll into view. v1.0.3 collected the shells as empty messages and never
 * looked again: 883 of 932 exported messages had no author, text or date.
 */
await checkAsync('shells are not exported empty; the sweep fills every message in', async () => {
  const env = boot(buildFixtureHtml({ rows: conversationRows().map(opaque) }));
  env.WAEx.extractor.LIMITS.hydrateTimeoutMs = 300;
  const scroller = env.scroller;
  const ROW = 100;
  const nodes = Array.from(env.document.querySelectorAll('#main div[data-id]'));
  const full = new Map(nodes.map((n) => [n, n.innerHTML]));
  scroller.__scrollHeight = nodes.length * ROW;
  scroller.__clientHeight = 300;

  const render = (top) => {
    nodes.forEach((node, i) => {
      const visible = i * ROW + ROW > top && i * ROW < top + 300;
      if (!visible) node.innerHTML = '';
      else if (!node.innerHTML) setTimeout(() => (node.innerHTML = full.get(node)), 20);
    });
  };
  scroller.__scrollTop = nodes.length * ROW - 300; // opened at the newest message
  render(scroller.__scrollTop);
  await new Promise((r) => setTimeout(r, 40));
  scroller.__onScrollTop = (value) => render(value);

  const result = await env.WAEx.extractor.loadAllHistory();
  const messages = result.messages.filter((m) => m.id.startsWith('3EB0'));
  eq(
    messages.map((m) => m.id),
    ['AAA1', 'AAA2', 'AAA3', 'AAA4', 'AAA5', 'AAA6', 'AAA7', 'BBB1', 'BBB2', 'BBB3'].map((t) => `3EB0${t}C0FFEE`),
    'every message, in order'
  );
  eq(messages.filter((m) => !m.author).length, 0, 'every message has an author');
  eq(messages.filter((m) => m.timestamp === null).length, 0, 'every message has a time');
  eq(byIdOf(messages, 'BBB1').timestamp, AT(2023, 12, 25, 18, 0), 'times come from the message itself');
  eq(byIdOf(messages, 'AAA2').text, "Perfect.\nI'll bring coffee ☕");
  ok(!result.warnings.some((w) => /never filled in/.test(w)), JSON.stringify(result.warnings));
});

await checkAsync('shells that are never filled in are reported, not exported', async () => {
  const env = boot(buildFixtureHtml({ rows: conversationRows().map(opaque) }));
  const shells = Array.from(env.document.querySelectorAll('#main div[data-id]')).slice(0, 3);
  for (const node of shells) node.innerHTML = '';
  const result = await env.WAEx.extractor.loadAllHistory();
  eq(result.messages.filter((m) => m.id.startsWith('3EB0')).length, 7, 'shells are left out');
  ok(
    result.warnings.some((w) => /^3 messages could not be read/.test(w)),
    'expected an unread-messages warning: ' + JSON.stringify(result.warnings)
  );
});

function byIdOf(list, tail) {
  return list.find((m) => m.id === `3EB0${tail}C0FFEE`);
}

process.exit(summary() ? 0 : 1);
