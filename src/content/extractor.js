/**
 * WhatsApp Web DOM scraper.
 *
 * WhatsApp ships obfuscated, frequently-rotating class names, so nothing here keys
 * off a CSS class. Instead it relies on the few stable structural facts:
 *
 *   - the conversation lives in `#main`
 *   - each message is a `div[role="row"]`, message nodes carry `data-id`
 *     (older builds: `true_...` = outgoing, `false_...` = incoming; current builds:
 *     an opaque token, with direction on a `.message-out` / `.message-in` element)
 *   - the localised timestamp + author live in `data-pre-plain-text`
 *   - the message list is a scroll container that loads older history on scroll
 *   - text lives in `.selectable-text` / `.copyable-text`
 *
 * Every lookup has a fallback chain, and failures degrade to a warning instead of
 * throwing, so a WhatsApp UI change never loses an entire export.
 */
(function (global) {
  'use strict';

  var WAEx = (global.WAEx = global.WAEx || {});
  var dt = WAEx.datetime;
  var T = WAEx.MESSAGE_TYPES;

  var LIMITS = {
    /** Hard cap on scroll round-trips. */
    maxScrollSteps: 4000,
    /** Overall time budget for loading history, in ms (10 minutes). */
    timeBudgetMs: 10 * 60 * 1000,
    /**
     * How long one round waits for a page of messages before calling it idle. A fetch
     * from the phone or server can be pending with no DOM change at all, so a quiet DOM
     * alone never ends a round early.
     */
    growthTimeoutMs: 4000,
    /** A round that keeps seeing unrelated DOM activity still ends after this. */
    growthHardCapMs: 8000,
    /** A DOM mutation this recent counts as "still loading". */
    activityQuietMs: 450,
    pollMs: 120,
    /** Idle rounds in jump mode before switching to incremental scrolling. */
    maxIdleRounds: 4,
    /** Incremental rounds before we conclude the chat is fully loaded. */
    nudgeSteps: 3,
    /** Idle rounds at the very top before one retry, then the start of the chat. */
    topIdleRounds: 2,
    /** Idle rounds at the bottom before we conclude the newest message is reached. */
    downIdleRounds: 3,
    /** Delay between fast downward steps through already-rendered messages. */
    stepDelayMs: 30,
    /**
     * WhatsApp keeps messages away from the viewport as empty shells (a data-id and a
     * height) and fills them in when they scroll into view. After each sweep step, wait
     * up to this long for the on-screen shells to be filled in.
     */
    hydrateTimeoutMs: 1500,
    settleAfterLoadMs: 80,
    /** Absolute ceiling, so a runaway loop cannot exhaust memory. */
    maxMessages: 150000,
  };
  /* ------------------------------------------------------------ selectors */

  var SELECTORS = {
    main: [
      '#main',
      '[data-testid="conversation-panel-wrapper"]',
      'div[role="main"]',
      '#app .two > div:nth-child(3)',
    ],
    chatTitle: [
      'header [data-testid="conversation-info-header-chat-title"]',
      'header span[dir="auto"][title]',
      'header span[title]',
      'header h1',
    ],
    messageNode: ['div[data-id]'],
    row: ['div[role="row"]'],
    prePlain: ['[data-pre-plain-text]'],
    textSpan: ['.selectable-text'],
    copyable: ['.copyable-text'],
    quote: [
      '[data-testid="quoted-message"]',
      '.quoted-mention',
      '[aria-label*="Quoted" i]',
      '[aria-label*="Antwort" i]',
      '[aria-label*="Citazione" i]',
    ],
    dateDivider: ['[data-testid="date-divider"]', 'div[role="row"] > div > span[dir="auto"]'],
  };

  /* -------------------------------------------------------------- helpers */

  function firstMatch(root, selectorList) {
    if (!root) return null;
    for (var i = 0; i < selectorList.length; i++) {
      var el = root.querySelector(selectorList[i]);
      if (el) return el;
    }
    return null;
  }

  /** Text content of an element, preserving line breaks and emoji alt text. */
  function readText(el) {
    if (!el) return '';

    // Chrome gives us innerText, which already handles <br> and block layout.
    if (typeof el.innerText === 'string' && el.innerText !== undefined) {
      var quick = el.innerText;
      if (quick && quick.trim()) {
        // innerText drops <img alt> emoji; only fall back to the walker if needed.
        if (!el.querySelector('img[alt]')) return normalize(quick);
      }
    }

    var out = [];
    walk(el, out);
    return normalize(out.join(''));
  }

  function walk(node, out) {
    var children = node.childNodes || [];
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.nodeType === 3) {
        out.push(child.nodeValue || '');
        continue;
      }
      if (child.nodeType !== 1) continue;
      var tag = (child.tagName || '').toUpperCase();
      if (tag === 'BR') {
        out.push('\n');
      } else if (tag === 'IMG') {
        var alt = child.getAttribute('alt');
        if (alt) out.push(alt);
      } else if (tag === 'SCRIPT' || tag === 'STYLE') {
        continue;
      } else {
        walk(child, out);
      }
    }
  }

  function normalize(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * True when the element has more content than it can display.
   *
   * Deliberately does NOT require `overflow: auto`. WhatsApp hides the scrollbar
   * (overflow: hidden) while still letting the list be scrolled programmatically, so
   * filtering on computed overflow is the easiest way to miss the real container and
   * export only the messages that happen to be on screen.
   */
  function isScrollable(el) {
    if (!el || !el.ownerDocument) return false;
    return el.scrollHeight > el.clientHeight + 24;
  }

  /** Verify the element really moves when asked to scroll (not an overflow shell). */
  function canScroll(el) {
    if (!el) return false;
    try {
      var before = el.scrollTop;
      var probe = Math.min(60, el.scrollHeight - el.clientHeight);
      if (probe <= 0) return false;
      el.scrollTop = before + probe;
      var moved = el.scrollTop !== before;
      el.scrollTop = before;
      return moved;
    } catch (err) {
      return false;
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function countKeys(object) {
    var total = 0;
    for (var key in object) {
      if (hasOwn(object, key)) total++;
    }
    return total;
  }

  /** Small summary of the scroller, shown by the diagnostics panel. */
  function scrollInfo(scroller) {
    if (!scroller) {
      return { found: false, scrollTop: 0, scrollHeight: 0, clientHeight: 0, scrollable: false };
    }
    return {
      found: true,
      scrollTop: scroller.scrollTop || 0,
      scrollHeight: scroller.scrollHeight || 0,
      clientHeight: scroller.clientHeight || 0,
      scrollable: (scroller.scrollHeight || 0) > (scroller.clientHeight || 0) + 24,
    };
  }

  /* ----------------------------------------------------------- discovery */

  var cache = { main: null, scroller: null };

  function findMain() {
    if (cache.main && cache.main.isConnected && cache.main.querySelector) {
      return cache.main;
    }
    var main = firstMatch(document, SELECTORS.main);
    cache.main = main || null;
    return cache.main;
  }

  /**
   * Every message node in DOM order, one per unique `data-id`.
   * Nested `data-id` wrappers (if WhatsApp adds them) are collapsed to one message.
   */
  function messageNodes(root) {
    var scope = root || findMain();
    if (!scope || !scope.querySelectorAll) return [];
    var nodes = scope.querySelectorAll('div[data-id]');
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var id = node.getAttribute('data-id');
      if (!isMessageNode(node, id) || seen[id]) continue;
      var parent = node.parentElement;
      if (parent && parent.closest && parent.closest('[data-id]')) continue;
      seen[id] = true;
      out.push(node);
    }
    return out;
  }

  /**
   * The message list scroll container.
   *
   * Walk up from a message node and take every ancestor whose content overflows and
   * which actually scrolls. The outermost such element (largest content height) is the
   * message list. If that finds nothing, scan inside the conversation panel for any
   * scrolling element that contains messages.
   */
  function findScrollContainer(main) {
    var root = main || findMain();
    if (!root) return null;

    // Revalidate the cached element every time: React remounts the list on some
    // navigation and a stale node silently swallows every scrollTop assignment.
    if (cache.scroller && cache.scroller.isConnected && root.contains(cache.scroller)) {
      return cache.scroller;
    }

    /**
     * Accept an element as the scroller.
     *
     * Only ambiguous elements (overflow hidden, no visible scrollbar) get probed with a
     * real scrollTop change. Probing a normal scroller would nudge the conversation and
     * make WhatsApp load a page of history before the export has even started.
     */
    function consider(list, el) {
      if (!el || el === root || !isScrollable(el)) return;
      var declared = false;
      try {
        var style = global.getComputedStyle(el);
        declared = /(auto|scroll|overlay)/.test(
          String((style && style.overflowY) || '') + ' ' + String((style && style.overflow) || '')
        );
      } catch (err) {
        declared = false;
      }
      if (!declared && !canScroll(el)) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i] === el) return;
      }
      list.push(el);
    }

    var candidates = [];
    var anchor =
      root.querySelector('div[data-id]') ||
      root.querySelector('div[role="row"]') ||
      root.querySelector('.copyable-text') ||
      null;

    var node = anchor ? anchor.parentElement : null;
    var guard = 0;
    while (node && node !== root && guard < 80) {
      consider(candidates, node);
      node = node.parentElement;
      guard++;
    }

    if (!candidates.length) {
      var all = root.querySelectorAll('div');
      for (var i = 0; i < all.length && candidates.length < 4; i++) {
        var el = all[i];
        if (el.scrollHeight <= el.clientHeight + 24) continue;
        if (!el.querySelector('div[data-id], div[role="row"]')) continue;
        consider(candidates, el);
      }
    }

    if (!candidates.length) {
      cache.scroller = null;
      return null;
    }

    // Outermost scrolling element wins; ties break towards the higher one in the tree.
    candidates.sort(function (a, b) {
      var delta = b.scrollHeight - a.scrollHeight;
      if (delta !== 0) return delta;
      if (a === b) return 0;
      return a.contains(b) ? 1 : -1;
    });

    cache.scroller = candidates[0];
    return cache.scroller;
  }

  /** Rows currently rendered in the message list, in DOM order. */
  function getRows(main) {
    var root = main || findMain();
    if (!root) return [];
    var app = root.querySelector('div[role="application"]');
    var scope = app && app.querySelector('div[role="row"]') ? app : root;
    var rows = scope.querySelectorAll('div[role="row"]');
    return Array.prototype.slice.call(rows);
  }

  /** `data-id` of a row, or of the nearest descendant that has one. */
  function rowMessageId(row) {
    if (!row || !row.getAttribute) return '';
    var direct = row.getAttribute('data-id');
    if (direct) return direct;
    var inner = row.querySelector('[data-id]');
    return inner ? inner.getAttribute('data-id') || '' : '';
  }

  /**
   * Older WhatsApp builds used `true_<chat>_<id>` / `false_<chat>_<id>`, which also
   * encoded direction. Current builds (seen 2026-11) use a single opaque token with no
   * prefix, so any non-empty, whitespace-free value counts; direction comes from
   * `isOutgoingNode` instead.
   */
  function isLegacyMessageId(id) {
    return typeof id === 'string' && /^(true|false)_/.test(id);
  }

  function isMessageId(id) {
    return typeof id === 'string' && /^\S+$/.test(id);
  }

  /**
   * A `data-id` node that is a message: legacy ids anywhere, opaque ids only inside a
   * message row, so unrelated `data-id` elements in the panel are not mistaken for one.
   */
  function isMessageNode(node, id) {
    if (!isMessageId(id)) return false;
    if (isLegacyMessageId(id)) return true;
    return Boolean(node && node.closest && node.closest('div[role="row"]'));
  }

  function isOutgoingNode(node, id) {
    if (isLegacyMessageId(id)) return /^true_/.test(id);
    if (!node) return false;
    if (node.classList && node.classList.contains('message-out')) return true;
    if (!node.querySelector) return false;
    if (node.querySelector('.message-out')) return true;
    if (node.querySelector('.message-in')) return false;
    // No direction class at all: delivery ticks and the pending clock only appear on
    // messages the user sent.
    return Boolean(
      node.querySelector('[data-icon^="msg-check"], [data-icon^="msg-dblcheck"], [data-icon="msg-time"]')
    );
  }

  /* ------------------------------------------------------------ chat info */

  function titleFromHeader(header) {
    if (!header) return '';
    var el = firstMatch(header, SELECTORS.chatTitle);
    if (el) {
      var title = el.getAttribute('title');
      if (title && title.trim()) return title.trim();
      var text = readText(el);
      if (text) return text;
    }
    // Last resort: the first dir="auto" element in the header.
    var fallback = header.querySelector('span[dir="auto"]');
    return fallback ? readText(fallback) : '';
  }

  function initialsFor(name) {
    var clean = String(name || '').trim();
    if (!clean) return '?';
    var parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function inferIsGroup(main) {
    var root = main || findMain();
    if (!root) return false;
    // Distinct incoming authors among the rendered rows is the most reliable signal.
    // Outgoing rows carry the user's own name, which would make every 1:1 chat a group.
    var authors = Object.create(null);
    var rows = getRows(root).slice(-80);
    for (var i = 0; i < rows.length; i++) {
      if (isOutgoingNode(rows[i], rowMessageId(rows[i]))) continue;
      var pre = rows[i].querySelector('[data-pre-plain-text]');
      if (!pre) continue;
      var parsed = dt.parsePrePlainText(pre.getAttribute('data-pre-plain-text'));
      if (!parsed || !parsed.author) continue;
      if (/^\+?\d[\d\s()-]{5,}$/.test(parsed.author.replace(/^~/, ''))) continue;
      authors[parsed.author] = true;
    }
    return Object.keys(authors).length > 1;
  }

  function getChatInfo() {
    var main = findMain();
    if (!main) {
      return {
        found: false,
        reason: 'The conversation panel was not found. Is WhatsApp Web fully loaded?',
        name: '',
        isGroup: false,
        initials: '?',
        renderedCount: 0,
        dateRange: null,
      };
    }

    var header = main.querySelector('header');
    var name = titleFromHeader(header);

    if (!name) {
      // The panel can exist while the chat list is loading; treat it as "no chat".
      var hasComposer = Boolean(main.querySelector('footer'));
      var hasRows = getRows(main).length > 0;
      if (!hasComposer && !hasRows) {
        return {
          found: false,
          reason: 'No conversation is open. Pick a chat in WhatsApp Web first.',
          name: '',
          isGroup: false,
          initials: '?',
          renderedCount: 0,
          dateRange: null,
        };
      }
      name = 'Unknown chat';
    }

    var range = renderedDateRange(main);

    var info = {
      found: true,
      reason: '',
      name: name,
      isGroup: inferIsGroup(main),
      initials: initialsFor(name),
      renderedCount: messageNodes(main).length,
      dateRange: range,
    };
    return info;
  }

  /** Best-effort date span of the rows currently in the DOM. */
  function renderedDateRange(main) {
    var rows = getRows(main);
    if (!rows.length) return null;
    // Infer day/month order from the rendered rows, without touching the shared cache.
    var order = dt.inferDateOrder(
      collectDateSamples(rows),
      dt.suggestOrderFromLocale(global.navigator && global.navigator.language)
    );
    var firstTs = null;
    var lastTs = null;

    function tsOf(row) {
      var pre = row.querySelector('[data-pre-plain-text]');
      if (!pre) return null;
      var parsed = dt.parsePrePlainText(pre.getAttribute('data-pre-plain-text'));
      if (!parsed) return null;
      var dateParts = dt.parseDateText(parsed.dateText, order);
      var timeParts = dt.parseTimeText(parsed.timeText);
      return dt.toEpoch(dateParts, timeParts);
    }

    for (var i = 0; i < rows.length && i < 6; i++) {
      var ts = tsOf(rows[i]);
      if (ts !== null) {
        firstTs = ts;
        break;
      }
    }
    for (var j = rows.length - 1; j >= 0 && j > rows.length - 7; j--) {
      var ts2 = tsOf(rows[j]);
      if (ts2 !== null) {
        lastTs = ts2;
        break;
      }
    }

    if (firstTs === null && lastTs === null) return null;
    if (firstTs === null) firstTs = lastTs;
    if (lastTs === null) lastTs = firstTs;
    if (firstTs > lastTs) {
      var swap = firstTs;
      firstTs = lastTs;
      lastTs = swap;
    }
    return { start: firstTs, end: lastTs };
  }

  /* --------------------------------------------------------- history load */

  /** Tell the page it was scrolled; some builds only react to the event, not scrollTop. */
  function nudgeScroll(scroller, direction) {
    if (!scroller) return;
    var sign = direction === 'down' ? 1 : -1;
    try {
      scroller.dispatchEvent(new Event('scroll', { bubbles: false }));
    } catch (err) {
      /* the assignment is usually enough */
    }
    try {
      if (typeof global.WheelEvent !== 'function') return;
      var box = scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : null;
      scroller.dispatchEvent(
        new global.WheelEvent('wheel', {
          deltaY: sign * Math.round((scroller.clientHeight || 600) * 0.8),
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
          clientX: box ? box.left + box.width / 2 : 0,
          clientY: box ? box.top + box.height / 2 : 0,
        })
      );
    } catch (err) {
      /* non-fatal */
    }
  }

  /** Node count, height and edge message ids of the list: what "a page arrived" changes. */
  function measureList(main, scroller) {
    var nodes = messageNodes(main);
    return {
      nodes: nodes.length,
      height: scroller && scroller.isConnected ? scroller.scrollHeight || 0 : 0,
      firstId: nodes.length ? nodes[0].getAttribute('data-id') : '',
      lastId: nodes.length ? nodes[nodes.length - 1].getAttribute('data-id') : '',
    };
  }

  /**
   * Wait for the next page of messages.
   *
   * Resolves as soon as the list grows or its first/last message changes (a virtualised
   * list can swap a page in without growing). A round is only called idle after the full
   * `growthTimeoutMs` with no recent DOM activity, so a slow fetch with no spinner is
   * not mistaken for the end of the conversation.
   */
  function waitForDomChange(scroller, baseline) {
    var main = findMain() || document.body;
    return new Promise(function (resolve) {
      var started = Date.now();
      var lastActivity = started;
      var observer = null;

      function measure() {
        return measureList(main, scroller);
      }

      function finish(grew) {
        clearInterval(timer);
        if (observer) observer.disconnect();
        resolve({ grew: grew, measure: measure() });
      }

      try {
        observer = new MutationObserver(function () {
          lastActivity = Date.now();
        });
        observer.observe(main, { childList: true, subtree: true, characterData: true });
      } catch (err) {
        observer = null;
      }

      var timer = setInterval(function () {
        var now = measure();
        var elapsed = Date.now() - started;
        if (
          now.nodes > baseline.nodes ||
          now.height > baseline.height + 20 ||
          (baseline.firstId !== undefined && now.firstId !== baseline.firstId) ||
          (baseline.lastId !== undefined && now.lastId !== baseline.lastId)
        ) {
          finish(true);
          return;
        }
        if (elapsed >= LIMITS.growthHardCapMs) {
          finish(false);
          return;
        }
        var busy = Date.now() - lastActivity < LIMITS.activityQuietMs;
        if (!busy && elapsed >= LIMITS.growthTimeoutMs) finish(false);
      }, LIMITS.pollMs);
    });
  }

  /** Oldest timestamp among the messages parsed so far. */
  function collectedOldest(collected) {
    var oldest = null;
    for (var id in collected) {
      if (!hasOwn(collected, id)) continue;
      var timestamp = collected[id].timestamp;
      if (timestamp === null || timestamp === undefined) continue;
      if (oldest === null || timestamp < oldest) oldest = timestamp;
    }
    return oldest;
  }

  /**
   * Load the whole conversation, whichever direction it needs.
   *
   * The list is parsed as it renders, so messages stay even if WhatsApp removes their
   * nodes later, and the progress counter is exact.
   *
   * Two passes:
   *
   *   1. **Older.** Repeatedly scroll to the top so WhatsApp fetches earlier pages,
   *      with viewport-sized steps when jumping stops helping. Stops at the first
   *      message or when the selected start date is covered.
   *   2. **Newer.** If the conversation was not already showing its newest message
   *      when the export started (WhatsApp restores the last scroll position, so it
   *      can be anywhere), walk down the list a viewport at a time until the newest
   *      message is reached, loading each page WhatsApp appends.
   *
   * Pass 2 is what makes an export complete when the chat happens to be scrolled to
   * the beginning: pass 1 correctly finds nothing older, and without walking forward
   * the rest of the conversation would never be seen.
   */
  async function loadAllHistory(options) {
    var opts = options || {};
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : function () {
      return false;
    };

    var main = findMain();
    if (!main) {
      throw new ExportError(
        'NO_CONVERSATION',
        'The WhatsApp conversation panel was not found.',
        'Open a chat in WhatsApp Web, wait for it to finish loading, then try again.'
      );
    }

    var scroller = findScrollContainer(main);
    var warnings = [];
    var originalTop = scroller ? scroller.scrollTop || 0 : 0;
    var originalHeight = scroller ? scroller.scrollHeight || 0 : 0;
    var originalClient = scroller ? scroller.clientHeight || 0 : 0;
    // Was the newest message already on screen when the export started?
    var startedAtNewest = Boolean(scroller) && originalTop + originalClient >= originalHeight - 8;

    var collected = Object.create(null); // message id -> parsed Message
    var hollow = Object.create(null); // message id -> true while only an empty shell was seen
    var hollowNodes = []; // shells found by the latest collect()
    var seen = Object.create(null); // message id -> node, kept for recovery/diagnostics
    var parseIndex = 0;
    var ctx = {
      order: resolveDateOrder(collectDateSamples(getRows(main))),
      includeReactions: opts.includeReactions !== false,
      lastTimestamp: null,
    };

    var startedAt = Date.now();
    var rounds = 0;
    var cancelled = false;

    function listMetrics() {
      return measureList(main, scroller);
    }

    /**
     * Parse every message node not collected yet, in DOM order. Empty shells are left
     * uncollected so they are parsed again once WhatsApp fills them in. A message with
     * no timestamp of its own (media, for instance) borrows the one of the message just
     * above it on the page, not of whatever was parsed last.
     */
    function collect() {
      var nodes = messageNodes(main);
      var added = 0;
      ctx.lastTimestamp = null;
      hollowNodes = [];
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var id = node.getAttribute('data-id');
        if (!id) continue;
        if (collected[id]) {
          if (collected[id]._ownTime) ctx.lastTimestamp = collected[id].timestamp;
          continue;
        }
        ctx.index = parseIndex++;
        var message = parseRow(node, ctx);
        if (!message) continue;
        if (message._hollow) {
          hollow[id] = true;
          hollowNodes.push(node);
          continue;
        }
        seen[id] = node;
        delete hollow[id];
        if (message._ownTime) ctx.lastTimestamp = message.timestamp;
        collected[id] = message;
        added++;
      }
      return added;
    }

    /** Shells currently inside the viewport (all of them when layout is unavailable). */
    function visibleHollowCount() {
      if (!hollowNodes.length) return 0;
      var box = scroller && scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : null;
      var count = 0;
      for (var i = 0; i < hollowNodes.length; i++) {
        var node = hollowNodes[i];
        if (!node.isConnected) continue;
        var rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
        if (!box || !rect || (!box.height && !rect.height)) {
          count++;
          continue;
        }
        if (rect.bottom >= box.top && rect.top <= box.bottom) count++;
      }
      return count;
    }

    /** Collect, then give on-screen shells time to be filled in. */
    async function collectHydrated() {
      var added = collect();
      var waited = 0;
      while (visibleHollowCount() > 0 && waited < LIMITS.hydrateTimeoutMs && !shouldCancel()) {
        await sleep(LIMITS.pollMs);
        waited += LIMITS.pollMs;
        added += collect();
      }
      return added;
    }

    function extent() {
      var oldest = null;
      var newest = null;
      for (var id in collected) {
        if (!hasOwn(collected, id)) continue;
        var timestamp = collected[id].timestamp;
        if (timestamp === null || timestamp === undefined) continue;
        if (oldest === null || timestamp < oldest) oldest = timestamp;
        if (newest === null || timestamp > newest) newest = timestamp;
      }
      return { oldest: oldest, newest: newest };
    }

    function report(direction) {
      var bounds = extent();
      var atTop = !scroller || (scroller.scrollTop || 0) <= 2;
      var atBottom = !scroller || (scroller.scrollTop || 0) + (scroller.clientHeight || 0) >= (scroller.scrollHeight || 0) - 4;
      onProgress({
        loaded: countKeys(collected),
        oldest: bounds.oldest,
        newest: bounds.newest,
        atTop: atTop,
        atBottom: atBottom,
        direction: direction,
        rounds: rounds,
      });
    }

    /** Shared stop conditions. Returns true when the loop must end. */
    function finished() {
      if (shouldCancel()) {
        cancelled = true;
        return true;
      }
      if (rounds >= LIMITS.maxScrollSteps) {
        warnings.push(
          'Stopped after ' +
            LIMITS.maxScrollSteps +
            ' scroll steps. The conversation may have messages that were not loaded.'
        );
        return true;
      }
      if (Date.now() - startedAt > LIMITS.timeBudgetMs) {
        warnings.push(
          'Stopped after ' +
            Math.round((Date.now() - startedAt) / 1000) +
            's so the export would finish. Messages may be missing.'
        );
        return true;
      }
      if (countKeys(collected) >= LIMITS.maxMessages) {
        warnings.push(
          'Stopped at ' +
            WAEx.plural(LIMITS.maxMessages, 'message') +
            '. The rest of the conversation was not loaded.'
        );
        return true;
      }
      return false;
    }

    function startDateCovered() {
      if (!opts.dateBounds || !opts.dateBounds.start) return false;
      var oldest = extent().oldest;
      return oldest !== null && oldest < opts.dateBounds.start;
    }

    function endDateCovered() {
      if (!opts.dateBounds || !opts.dateBounds.end) return false;
      var newest = extent().newest;
      return newest !== null && newest > opts.dateBounds.end;
    }

    var parsedCount = collect();
    report('idle');

    if (!scroller) {
      warnings.push(
        'Could not find a scrollable message list, so only the messages already on screen were captured. ' +
          'Please open Diagnostics in the popup and include the report when reporting this.'
      );
    }

    /* ---------------------------------------------------- pass 1: older */

    if (scroller && !finished()) {
      var idleAtTop = 0;
      var idleRounds = 0;
      var mode = 'jump';
      var retriedAtTop = false;
      var olderEnd = '';

      while (!finished()) {
        var atTopBefore = (scroller.scrollTop || 0) <= 2;
        var baseline = listMetrics();

        if (mode === 'jump') {
          scroller.scrollTop = 0;
        } else {
          var stepUp = Math.max(160, Math.round((scroller.clientHeight || 600) * 0.8));
          scroller.scrollTop = Math.max(0, (scroller.scrollTop || 0) - stepUp);
        }
        nudgeScroll(scroller, 'up');

        var changeUp = await waitForDomChange(scroller, baseline);
        var addedUp = collect();
        parsedCount += addedUp;
        rounds++;
        report('up');

        if (startDateCovered()) {
          olderEnd = 'date';
          break;
        }

        if (changeUp.grew || addedUp > 0) {
          idleRounds = 0;
          idleAtTop = 0;
          retriedAtTop = false;
          mode = 'jump';
        } else if (retriedAtTop && (scroller.scrollTop || 0) <= 2) {
          // The retry's fresh jump to the top brought nothing either.
          olderEnd = 'top';
          break;
        } else if (atTopBefore && (scroller.scrollTop || 0) <= 2) {
          // Showing the top of the list and nothing older arrived.
          idleAtTop++;
          if (idleAtTop >= LIMITS.topIdleRounds) {
            if (!retriedAtTop) {
              // Before accepting this as the start, move away and come back once:
              // WhatsApp loads on a real change of scroll position, and a request that
              // was dropped or is still pending gets a fresh trigger.
              retriedAtTop = true;
              idleAtTop = 0;
              var away = Math.max(160, Math.round((scroller.clientHeight || 600) * 0.8));
              scroller.scrollTop = Math.min(
                Math.max(0, (scroller.scrollHeight || 0) - (scroller.clientHeight || 0)),
                away
              );
              nudgeScroll(scroller, 'down');
              await sleep(LIMITS.stepDelayMs);
              continue;
            }
            olderEnd = 'top';
            break;
          }
        } else {
          idleRounds++;
          if (mode === 'jump' && idleRounds >= LIMITS.maxIdleRounds) {
            mode = 'nudge';
            idleRounds = 0;
          } else if (mode === 'nudge' && idleRounds >= LIMITS.nudgeSteps) {
            olderEnd = 'stalled';
            break;
          }
        }
      }

      if (!cancelled && olderEnd === 'stalled') {
        warnings.push(
          'Loading older messages stopped before the top of the conversation was reached. ' +
            'The oldest messages may be missing; scroll up in the chat and export again.'
        );
      } else if (!cancelled && olderEnd === 'top' && !startOfChatVisible(main)) {
        warnings.push(
          'Could not confirm that the first message of the conversation was reached. ' +
            'If older messages are missing, scroll to the top of the chat in WhatsApp ' +
            '(and load older messages from your phone if WhatsApp offers it), then export again.'
        );
      }
    }

    /* ------------------------------------------- pass 2: sweep down, newer */

    // Always walk the loaded history from the top, a viewport at a time: WhatsApp only
    // fills in messages that come on screen, so jumping to the top in pass 1 leaves
    // everything in between as empty shells. If the conversation did not start at its
    // newest message, keep loading below the bottom until nothing newer arrives.
    if (scroller && !cancelled) {
      var idleAtBottom = 0;
      if ((scroller.scrollTop || 0) > 0) scroller.scrollTop = 0;
      parsedCount += await collectHydrated();

      while (!finished()) {
        var remaining =
          (scroller.scrollHeight || 0) - ((scroller.scrollTop || 0) + (scroller.clientHeight || 0));
        var atBottom = remaining <= 4;

        if (atBottom) {
          // Started at the newest message: the bottom is already known.
          if (startedAtNewest) break;
          if (endDateCovered()) break;
          var baselineDown = listMetrics();
          nudgeScroll(scroller, 'down');
          var changeDown = await waitForDomChange(scroller, baselineDown);
          var addedDown = collect();
          parsedCount += addedDown;
          rounds++;
          report('down');

          if (endDateCovered()) break;

          if (changeDown.grew || addedDown > 0) {
            idleAtBottom = 0;
          } else {
            idleAtBottom++;
            if (idleAtBottom >= LIMITS.downIdleRounds) break;
          }
        } else {
          // Content below is already rendered: step through it without waiting.
          var stepDown = Math.max(120, Math.round((scroller.clientHeight || 600) * 0.9));
          scroller.scrollTop = Math.min(
            scroller.scrollHeight || 0,
            (scroller.scrollTop || 0) + stepDown
          );
          nudgeScroll(scroller, 'down');
          await sleep(LIMITS.stepDelayMs);

          var addedStep = await collectHydrated();
          parsedCount += addedStep;
          rounds++;
          report('down');
          idleAtBottom = 0;
        }
      }
    }

    await sleep(LIMITS.settleAfterLoadMs);

    // Final pass over the DOM: picks up system notices and anything rendered since the
    // last collect, and merges messages that were virtualised away while scrolling.
    var domResult = parseMessages({
      main: main,
      harvested: seen,
      includeReactions: opts.includeReactions,
    });
    // DOM order of the final pass first, then anything collected while scrolling that is
    // no longer rendered. Collected copies win: they were parsed in page order, so their
    // borrowed timestamps come from the right neighbour.
    var merged = [];
    var known = Object.create(null);
    for (var i = 0; i < domResult.messages.length; i++) {
      var domMessage = domResult.messages[i];
      merged.push(collected[domMessage.id] || domMessage);
      known[domMessage.id] = true;
    }
    for (var id in collected) {
      if (!hasOwn(collected, id) || known[id]) continue;
      merged.push(collected[id]);
      known[id] = true;
    }
    merged = backfillAndSort(merged);

    var unread = 0;
    for (var hollowId in hollow) {
      if (hasOwn(hollow, hollowId) && !known[hollowId]) unread++;
    }
    if (unread > 0) {
      warnings.push(
        WAEx.plural(unread, 'message') +
          ' could not be read because WhatsApp never filled in their content. ' +
          'Keep the WhatsApp tab in the foreground while exporting, then export again.'
      );
    }

    warnings = warnings.concat(domResult.warnings || []);
    if (cancelled) warnings.push('Export cancelled while messages were still loading.');
    if (!startedAtNewest && scroller && !cancelled) {
      var all = extent();
      if (all.newest !== null && domResult.messages.length) {
        var lastKnown = domResult.messages[domResult.messages.length - 1];
        if (lastKnown.timestamp !== null && lastKnown.timestamp < all.newest) {
          warnings.push(
            'The newest message may not have been reached. Please report this with the Diagnostics output.'
          );
        }
      }
    }

    return {
      main: main,
      scroller: scroller,
      originalTop: originalTop,
      seen: seen,
      collected: collected,
      messages: merged,
      loaded: countKeys(collected),
      rounds: rounds,
      passes: { older: Boolean(scroller), newer: Boolean(scroller) && !startedAtNewest },
      startedAtNewest: startedAtNewest,
      scroll: scrollInfo(scroller),
      warnings: warnings,
      cancelled: cancelled,
    };
  }

  /**
   * True when the top of the rendered list is a system notice (WhatsApp opens every
   * conversation with one, such as the encryption notice) rather than a message.
   * Date dividers are skipped. Language-independent: it checks structure, not text.
   */
  function startOfChatVisible(main) {
    var rows = getRows(main);
    for (var i = 0; i < rows.length && i < 6; i++) {
      if (rowMessageId(rows[i])) return false;
      if (isSystemRow(rows[i])) return true;
    }
    return false;
  }

  /** Timestamp of the oldest row currently rendered, or null. */
  function oldestTimestamp(main) {
    var rows = getRows(main);
    for (var i = 0; i < rows.length && i < 4; i++) {
      var ts = rowTimestamp(rows[i]);
      if (ts !== null) return ts;
    }
    return null;
  }

  var orderCache = null;

  function resolveDateOrder(samples) {
    var localeGuess = dt.suggestOrderFromLocale(global.navigator && global.navigator.language);

    // Only real observations are cached. An empty call (for example while probing a
    // single row during scrolling) must not lock in the locale guess, or a US-style
    // locale would misread day-first dates for the rest of the export.
    if (samples && samples.length) {
      orderCache = dt.inferDateOrder(samples, localeGuess);
      return orderCache;
    }
    return orderCache || localeGuess;
  }

  /** Collect the raw `[time, date]` date halves from a set of rows. */
  function collectDateSamples(rows) {
    var samples = [];
    for (var i = 0; i < rows.length; i++) {
      var pre = rows[i].querySelector && rows[i].querySelector('[data-pre-plain-text]');
      if (!pre) continue;
      var parsed = dt.parsePrePlainText(pre.getAttribute('data-pre-plain-text'));
      if (parsed) samples.push(parsed.dateText);
    }
    return samples;
  }

  function rowTimestamp(row) {
    var pre = row.querySelector && row.querySelector('[data-pre-plain-text]');
    if (!pre) return null;
    var parsed = dt.parsePrePlainText(pre.getAttribute('data-pre-plain-text'));
    if (!parsed) return null;
    var dateParts = dt.parseDateText(parsed.dateText, resolveDateOrder([]));
    if (!dateParts) return null;
    return dt.toEpoch(dateParts, dt.parseTimeText(parsed.timeText));
  }

  /* -------------------------------------------------------------- parsing */

  function detectMedia(row) {
    var media = null;

    function finish(kind, extra) {
      var result = extra || {};
      result.kind = kind;
      return result;
    }

    // Stickers are images with a sticker marker; check before generic images.
    var sticker =
      row.querySelector('[data-testid="sticker"]') ||
      row.querySelector('img[alt*="sticker" i]') ||
      row.querySelector('img[class*="sticker" i]');
    if (sticker) {
      var stickerImg = sticker.tagName === 'IMG' ? sticker : sticker.querySelector('img');
      return finish('sticker', {
        url: stickerImg ? usableUrl(stickerImg) : '',
        mime: 'image/webp',
        fileName: '',
        missing: !(stickerImg && usableUrl(stickerImg)),
      });
    }

    var gif = row.querySelector('[data-testid="gif"]') || row.querySelector('img[alt*="gif" i]');
    if (gif) {
      var gifImg = gif.tagName === 'IMG' ? gif : gif.querySelector('img');
      return finish('gif', {
        url: gifImg ? usableUrl(gifImg) : '',
        mime: 'image/gif',
        fileName: '',
        missing: !(gifImg && usableUrl(gifImg)),
      });
    }

    var doc =
      row.querySelector('[data-testid="document-thumb"]') ||
      row.querySelector('[data-testid="document"]') ||
      row.querySelector('[data-testid="media-document"]');
    if (doc) {
      var nameEl =
        doc.querySelector('span[title]') ||
        row.querySelector('[data-testid="document-thumb"] span[title]');
      var fileName = nameEl ? nameEl.getAttribute('title') || readText(nameEl) : '';
      var sizeText = '';
      var metaEl = doc.querySelector('span[dir="auto"]');
      if (metaEl) sizeText = readText(metaEl);
      return finish('document', {
        url: '',
        mime: '',
        fileName: fileName,
        sizeText: sizeText,
        missing: true,
      });
    }

    var video = row.querySelector('video');
    if (video) {
      var videoUrl = video.getAttribute('src') || usableUrl(video) || '';
      return finish('video', {
        url: videoUrl,
        mime: 'video/mp4',
        fileName: '',
        missing: !videoUrl,
      });
    }

    var audio = row.querySelector('audio');
    var ptt =
      row.querySelector('[data-testid="audio-play"]') ||
      row.querySelector('[data-testid="ptt"]') ||
      row.querySelector('[data-testid="audio-download"]');
    if (audio || ptt) {
      var audioEl = audio || ptt;
      var audioUrl = audio ? audio.getAttribute('src') || '' : '';
      var isVoice = Boolean(
        row.querySelector('[data-testid="audio-play"]') ||
          row.querySelector('[data-testid="ptt"]')
      );
      return finish(isVoice ? 'voice' : 'audio', {
        url: audioUrl,
        mime: isVoice ? 'audio/ogg' : 'audio/mpeg',
        fileName: '',
        missing: !audioUrl,
      });
    }

    if (row.querySelector('[data-testid="location"]') || row.querySelector('[data-testid="live-location"]')) {
      return finish('location', { url: '', mime: '', fileName: '', missing: true });
    }

    if (row.querySelector('[data-testid="contact-card"]')) {
      return finish('contact', { url: '', mime: '', fileName: '', missing: true });
    }

    if (row.querySelector('[data-testid="poll"]') || row.querySelector('[data-testid="poll-message"]')) {
      return finish('poll', { url: '', mime: '', fileName: '', missing: true });
    }

    var linkPreview = row.querySelector('[data-testid="link-preview"]');
    if (linkPreview) {
      var previewLink = linkPreview.querySelector('a[href]');
      return finish('link', {
        url: previewLink ? previewLink.getAttribute('href') : '',
        mime: 'text/uri-list',
        fileName: '',
        missing: true,
        href: previewLink ? previewLink.getAttribute('href') : '',
      });
    }

    // Generic image fallback: ignore avatars and tiny icons.
    var imgs = row.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (img.closest('[data-testid="avatar"]')) continue;
      // Emoji are rendered as <img alt="😀"> inside the text span.
      if (img.closest('.selectable-text') || img.closest('[data-testid="emoji"]')) continue;
      if (/emoji/i.test(img.getAttribute('class') || '')) continue;
      var src = usableUrl(img);
      var width = img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10) || 0;
      if (!src) continue;
      if (!/^blob:|^data:image/.test(src) && width > 0 && width < 48) continue;
      if (/avatar|emoji|profile/i.test(img.getAttribute('class') || '')) continue;
      var usable = /^blob:/.test(src) || /^data:image\//.test(src);
      return finish('image', {
        url: usable ? src : '',
        mime: 'image/jpeg',
        fileName: '',
        missing: !usable,
      });
    }

    return media;
  }

  function usableUrl(el) {
    if (!el) return '';
    var src = el.getAttribute && el.getAttribute('src');
    if (src && src.trim() && src !== 'about:blank') return src;
    if (el.currentSrc) return el.currentSrc;
    return '';
  }

  function findQuote(row, textEls) {
    var quoteRoot = firstMatch(row, SELECTORS.quote);

    if (!quoteRoot && textEls.length >= 2) {
      // Two selectable-text blocks inside one message means quote-then-body.
      var first = textEls[0];
      var candidate = first.closest('div[role="button"]') || first.parentElement;
      if (candidate && candidate !== row) {
        var nestedTexts = candidate.querySelectorAll('.selectable-text');
        if (nestedTexts.length <= 1) quoteRoot = candidate;
      }
    }

    if (!quoteRoot) return null;

    var authorEl = quoteRoot.querySelector('span[title]') || quoteRoot.querySelector('[data-testid="quoted-author"]');
    var author = authorEl ? authorEl.getAttribute('title') || readText(authorEl) : '';
    var quoteTextEl = quoteRoot.querySelector('.selectable-text');
    var text = quoteTextEl ? readText(quoteTextEl) : '';
    if (!text) {
      text = readText(quoteRoot);
      if (author && text.indexOf(author) === 0) text = text.slice(author.length).trim();
    }
    if (!author && !text) return null;
    return { author: author, text: text.slice(0, 2000), isRoot: quoteRoot };
  }

  function findReactions(row) {
    var found = [];
    var nodes = row.querySelectorAll(
      '[data-testid="reaction-bubble"], [data-testid="reactions"], [aria-label*="reaction" i]'
    );
    if (!nodes.length) {
      // Structural fallback: small emoji-only chips sitting under the bubble.
      var chips = row.querySelectorAll('div[role="button"] > span, span');
      for (var i = 0; i < chips.length && found.length < 8; i++) {
        var text = readText(chips[i]);
        if (text && text.length <= 6 && /^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s\d+]+$/u.test(text)) {
          var chipParent = chips[i].closest('div[role="button"]');
          if (chipParent && chipParent.querySelectorAll('.selectable-text').length === 0) {
            found.push(text);
          }
        }
      }
      return dedupeReactions(found);
    }

    for (var j = 0; j < nodes.length; j++) {
      var label = nodes[j].getAttribute('aria-label') || '';
      var text = readText(nodes[j]);
      if (!text && label) text = label;
      var emojiMatch = String(text).match(
        /([\p{Extended_Pictographic}\u200d\ufe0f]+)\s*(\d+)?/u
      );
      if (emojiMatch) found.push(emojiMatch[1] + (emojiMatch[2] ? ' ' + emojiMatch[2] : ''));
    }
    return dedupeReactions(found);
  }

  function dedupeReactions(list) {
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var raw = String(list[i] || '').trim();
      if (!raw || seen[raw]) continue;
      seen[raw] = true;
      var parts = raw.split(/\s+/);
      var count = parts.length > 1 ? parseInt(parts[parts.length - 1], 10) : 1;
      out.push({
        emoji: count > 1 ? parts.slice(0, -1).join(' ') : raw,
        count: isNaN(count) ? 1 : count,
      });
    }
    return out;
  }

  function isDeletedRow(row) {
    var text = readText(row);
    return /this message was deleted|you deleted this message/i.test(text);
  }

  /**
   * Parse one `div[role="row"]` (or a data-id node) into a Message.
   * Returns null when the row is a date divider or otherwise not a message.
   */
  function parseRow(row, context) {
    var ctx = context || {};
    var id = rowMessageId(row);
    var messageId = isMessageId(id) ? id : '';
    var isOutgoing = isOutgoingNode(row, messageId);

    var preEl = row.querySelector ? row.querySelector('[data-pre-plain-text]') : null;
    var pre = preEl ? dt.parsePrePlainText(preEl.getAttribute('data-pre-plain-text')) : null;

    var timestamp = null;
    var ownTime = false;
    var timeText = '';
    var author = '';

    if (pre) {
      timeText = pre.timeText;
      author = pre.author;
      var dateParts = dt.parseDateText(pre.dateText, ctx.order || 'dmy');
      timestamp = dt.toEpoch(dateParts, dt.parseTimeText(pre.timeText));
      ownTime = timestamp !== null;
      if (timestamp === null && ctx.lastTimestamp) timestamp = ctx.lastTimestamp;
    } else if (ctx.lastTimestamp) {
      timestamp = ctx.lastTimestamp;
    }

    var textEls = row.querySelectorAll ? Array.prototype.slice.call(row.querySelectorAll('.selectable-text')) : [];
    var quote = findQuote(row, textEls);

    var bodyText = '';
    for (var i = textEls.length - 1; i >= 0; i--) {
      var el = textEls[i];
      if (quote && quote.isRoot && quote.isRoot.contains(el)) continue;
      bodyText = readText(el);
      if (bodyText) break;
    }

    var media = detectMedia(row);
    var reactions = ctx.includeReactions === false ? [] : findReactions(row);
    var deleted = isDeletedRow(row);

    if (!messageId && !pre && !bodyText && !media && !reactions.length) {
      // Probably a date divider or an empty layout row.
      return null;
    }

    // A link preview is decoration on top of a text message, not the message itself.
    if (media && media.kind === 'link' && bodyText) media = null;

    var type = T.TEXT;
    if (deleted) type = T.DELETED;
    else if (media) type = media.kind || T.UNKNOWN;
    else if (quote && !bodyText) type = T.UNKNOWN;
    if (type === T.TEXT && !bodyText) type = T.UNKNOWN;

    return {
      id: messageId || 'row_' + (ctx.index || 0),
      timestamp: timestamp,
      dateKey: timestamp ? dt.dateKey(timestamp) : '',
      timeText: timeText,
      author: author || (isOutgoing ? 'You' : ''),
      isOutgoing: isOutgoing,
      type: type,
      text: bodyText,
      quoted: quote ? { author: quote.author, text: quote.text } : null,
      reactions: reactions,
      media: media
        ? {
            kind: media.kind || '',
            fileName: media.fileName || '',
            mime: media.mime || '',
            bytes: 0,
            url: media.url || '',
            missing: media.missing !== false,
            zipPath: '',
          }
        : null,
      _quoteRoot: quote ? quote.isRoot : null,
      _ownTime: ownTime,
      // An off-screen placeholder WhatsApp has not filled in yet: nothing to export.
      _hollow: Boolean(messageId) && !pre && !bodyText && !media && !quote && !deleted && !reactions.length,
    };
  }

  /**
   * System notices carry no timestamp attribute; borrow the nearest message's time so
   * exports never show a blank clock. Then sort by timestamp, keeping unknown-time
   * messages in their original relative order.
   */
  function backfillAndSort(messages) {
    var lastKnown = null;
    var i;

    for (i = 0; i < messages.length; i++) {
      if (messages[i].timestamp !== null && messages[i].timestamp !== undefined) {
        lastKnown = messages[i].timestamp;
      } else if (lastKnown !== null) {
        messages[i].timestamp = lastKnown;
        messages[i].dateKey = dt.dateKey(lastKnown);
      }
    }

    lastKnown = null;
    for (i = messages.length - 1; i >= 0; i--) {
      if (messages[i].timestamp !== null && messages[i].timestamp !== undefined) {
        lastKnown = messages[i].timestamp;
      } else if (lastKnown !== null) {
        messages[i].timestamp = lastKnown;
        messages[i].dateKey = dt.dateKey(lastKnown);
      }
    }

    messages.sort(function (a, b) {
      if (a.timestamp === null || a.timestamp === undefined) return 0;
      if (b.timestamp === null || b.timestamp === undefined) return 0;
      return a.timestamp - b.timestamp;
    });

    return messages;
  }

  /**
   * Parse every message currently reachable in the conversation, in DOM order.
   * `harvested` is the id -> node map collected while scrolling (fills gaps when
   * WhatsApp removes off-screen nodes).
   */
  function parseMessages(options) {
    var opts = options || {};
    var main = opts.main || findMain();
    if (!main) return { messages: [], warnings: ['Conversation panel not found.'] };

    var rows = getRows(main);
    var warnings = [];

    // A data-id node may live inside a row; normalise to one node per message.
    var candidates = [];
    var seenIds = Object.create(null);

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var id = rowMessageId(row);
      if (id && seenIds[id]) continue;
      if (id) seenIds[id] = true;
      candidates.push(row);
    }

    // Include harvested nodes that are no longer in the DOM (virtualised away).
    var harvested = opts.harvested || null;
    if (harvested) {
      var orphanCount = 0;
      for (var harvId in harvested) {
        if (!Object.prototype.hasOwnProperty.call(harvested, harvId)) continue;
        if (seenIds[harvId]) continue;
        var node = harvested[harvId];
        if (!node) continue;
        candidates.push(node);
        seenIds[harvId] = true;
        orphanCount++;
      }
      if (orphanCount > 0) {
        warnings.push(
          orphanCount + ' message(s) were recovered from nodes that left the screen while scrolling.'
        );
      }
    }

    var order = resolveDateOrder(collectDateSamples(candidates.slice(0, 400)));

    var messages = [];
    var ctx = {
      order: order,
      includeReactions: opts.includeReactions !== false,
      lastTimestamp: null,
    };

    for (var c = 0; c < candidates.length; c++) {
      ctx.index = c;
      var parsed = parseRow(candidates[c], ctx);
      // Unfilled placeholders: loadAllHistory reports the ones never resolved.
      if (parsed && parsed._hollow) continue;
      if (parsed) {
        if (parsed.timestamp) ctx.lastTimestamp = parsed.timestamp;
        messages.push(parsed);
      } else if (candidates[c].querySelector && !candidates[c].querySelector('[data-pre-plain-text]')) {
        var systemText = readText(candidates[c]);
        if (systemText && isSystemRow(candidates[c])) {
          messages.push({
            id: 'system_' + c,
            timestamp: ctx.lastTimestamp,
            dateKey: ctx.lastTimestamp ? dt.dateKey(ctx.lastTimestamp) : '',
            timeText: '',
            author: '',
            isOutgoing: false,
            type: T.SYSTEM,
            text: systemText,
            quoted: null,
            reactions: [],
            media: null,
          });
        }
      }
    }

    messages = backfillAndSort(messages);

    var noTimestamp = messages.filter(function (m) {
      return m.timestamp === null;
    }).length;
    if (noTimestamp > 0 && noTimestamp === messages.length) {
      warnings.push(
        'Could not read timestamps from this conversation. Times may be missing in the export.'
      );
    } else if (noTimestamp > 0) {
      warnings.push(noTimestamp + ' message(s) had no readable timestamp.');
    }

    return { messages: messages, warnings: warnings, order: order };
  }

  function isSystemRow(row) {
    if (!row || !row.querySelector) return false;
    if (row.querySelector('[data-pre-plain-text]')) return false;
    if (row.querySelector('.copyable-text')) return false;
    var text = readText(row);
    if (!text || text.length > 400) return false;
    // Date dividers look like "TODAY", "14/11/2023", "NOVEMBER 14, 2023".
    if (/^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|today|yesterday|[\w\s,]+ \d{4})$/i.test(text)) {
      return false;
    }
    if (row.querySelector('[data-id]')) return false;
    return true;
  }

  /**
   * Format sanity report used by the popup's diagnostics panel.
   * It answers one question: "do the selectors still match the live page?"
   */
  function diagnose() {
    var main = findMain();
    var rows = main ? getRows(main) : [];
    var selectors = [];
    var warnings = [];

    function probe(name, list) {
      var selector = list[0];
      var matches = 0;
      for (var i = 0; i < list.length; i++) {
        try {
          var found = document.querySelectorAll(list[i]).length;
          if (found > 0 && matches === 0) {
            selector = list[i];
            matches = found;
          }
          if (i === 0) matches = found;
        } catch (err) {
          /* selector not supported in this Chrome version */
        }
      }
      selectors.push({ name: name, selector: selector, matches: matches, alternatives: list.length });
    }

    probe('Conversation panel', SELECTORS.main);
    probe('Chat title', SELECTORS.chatTitle);
    probe('Message rows', SELECTORS.row);
    probe('Message nodes', SELECTORS.messageNode);
    probe('Timestamp attributes', SELECTORS.prePlain);
    probe('Message text', SELECTORS.textSpan);
    probe('Quoted replies', SELECTORS.quote);

    var info = getChatInfo();
    var scroller = findScrollContainer(main);
    var scroll = scrollInfo(scroller);
    var renderedMessages = main ? messageNodes(main).length : 0;
    var parsed = 0;
    try {
      parsed = main ? parseMessages({ main: main, includeReactions: false }).messages.length : 0;
    } catch (err) {
      warnings.push('Parser threw while probing: ' + (err && err.message ? err.message : err));
    }

    if (!main) warnings.push('`#main` not found. WhatsApp Web may still be loading.');
    if (main && !rows.length) warnings.push('No `div[role="row"]` elements. Open a conversation.');
    if (main && rows.length && parsed === 0) {
      warnings.push(
        'Rows exist but none parsed into messages. The DOM structure likely changed; see docs/TROUBLESHOOTING.md.'
      );
    }
    if (main && scroll.found && !scroll.scrollable) {
      warnings.push(
        'The message list is not scrollable right now, so history cannot be loaded until it is (is the chat still opening?).'
      );
    }

    return {
      url: String(global.location && global.location.href),
      mainPanel: Boolean(main),
      messageList: rows.length > 0,
      scrollContainer: Boolean(scroller),
      scroll: scroll,
      renderedRows: rows.length,
      renderedMessages: renderedMessages,
      parsedMessages: parsed,
      chat: info,
      selectors: selectors,
      warnings: warnings,
      version: WAEx.VERSION || '',
      userAgent: String((global.navigator && global.navigator.userAgent) || ''),
    };
  }

  /** Put the conversation back where the user left it. */
  function restoreScroll(result) {
    if (!result || !result.scroller || !result.scroller.isConnected) return;
    try {
      result.scroller.scrollTop = result.originalTop || 0;
    } catch (err) {
      /* non-fatal */
    }
  }

  /** Error type with an actionable hint, surfaced verbatim in the popup. */
  function ExportError(code, message, hint) {
    this.name = 'ExportError';
    this.code = code;
    this.message = message;
    this.hint = hint || '';
  }
  ExportError.prototype = Object.create(Error.prototype);
  ExportError.prototype.constructor = ExportError;

  WAEx.extractor = {
    LIMITS: LIMITS,
    SELECTORS: SELECTORS,
    ExportError: ExportError,
    findMain: findMain,
    findScrollContainer: findScrollContainer,
    getRows: getRows,
    getChatInfo: getChatInfo,
    loadAllHistory: loadAllHistory,
    parseMessages: parseMessages,
    parseRow: parseRow,
    diagnose: diagnose,
    restoreScroll: restoreScroll,
    readText: readText,
    initialsFor: initialsFor,
    messageNodes: messageNodes,
    scrollInfo: scrollInfo,
    backfillAndSort: backfillAndSort,
    resolveDateOrder: resolveDateOrder,
    resetDateOrderCache: function () {
      orderCache = null;
      cache.scroller = null;
    },
    _internal: {
      detectMedia: detectMedia,
      findQuote: findQuote,
      findReactions: findReactions,
      isSystemRow: isSystemRow,
      usableUrl: usableUrl,
      readText: readText,
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WAEx.extractor;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
