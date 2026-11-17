/**
 * WhatsApp Web DOM scraper.
 *
 * WhatsApp ships obfuscated, frequently-rotating class names, so nothing here keys
 * off a CSS class. Instead it relies on the few stable structural facts:
 *
 *   - the conversation lives in `#main`
 *   - each message is a `div[role="row"]`, message nodes carry `data-id`
 *     (`true_...` = outgoing, `false_...` = incoming)
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
    maxScrollSteps: 600,
    /** Overall time budget for loading history, in ms. */
    timeBudgetMs: 240000,
    /** A scroll round-trip is considered settled after this long without changes. */
    settleQuietMs: 140,
    settleTimeoutMs: 1200,
    /** Stop after this many consecutive empty rounds at the top. */
    topStabilityRounds: 3,
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

  function isScrollable(el) {
    if (!el || !el.ownerDocument) return false;
    try {
      var style = global.getComputedStyle(el);
      if (!style) return false;
      var overflow = (style.overflowY || '') + ' ' + (style.overflow || '');
      return /(auto|scroll|overlay)/.test(overflow) && el.scrollHeight > el.clientHeight + 24;
    } catch (err) {
      return false;
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
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
   * The message list scroll container: nearest scrollable ancestor of a message
   * row. Falls back to the deepest scrollable element inside the conversation.
   */
  function findScrollContainer(main) {
    var root = main || findMain();
    if (!root) return null;

    if (cache.scroller && cache.scroller.isConnected && root.contains(cache.scroller)) {
      return cache.scroller;
    }

    var anchor =
      root.querySelector('div[data-id]') ||
      root.querySelector('div[role="row"]') ||
      root.querySelector('.copyable-text') ||
      null;

    var candidates = [];
    var node = anchor ? anchor.parentElement : null;
    var guard = 0;
    while (node && node !== root && guard < 60) {
      if (isScrollable(node)) candidates.push(node);
      node = node.parentElement;
      guard++;
    }

    if (!candidates.length) {
      var all = root.querySelectorAll('div');
      for (var i = 0; i < all.length; i++) {
        if (isScrollable(all[i])) candidates.push(all[i]);
      }
    }

    if (!candidates.length) {
      cache.scroller = null;
      return null;
    }

    candidates.sort(function (a, b) {
      return b.scrollHeight - a.scrollHeight;
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

  function isMessageId(id) {
    return typeof id === 'string' && /^(true|false)_/.test(id);
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
    var authors = Object.create(null);
    var rows = getRows(root).slice(-80);
    for (var i = 0; i < rows.length; i++) {
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
      renderedCount: main.querySelectorAll('div[data-id]').length,
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

  /** Wait until the message list stops changing (or the timeout elapses). */
  function settle(scroller) {
    return new Promise(function (resolve) {
      var target = scroller || findMain() || document.body;
      var start = Date.now();
      var lastHeight = target.scrollHeight;
      var quietSince = Date.now();
      var observer = null;

      try {
        observer = new MutationObserver(function () {
          quietSince = Date.now();
        });
        observer.observe(target, { childList: true, subtree: true, characterData: true });
      } catch (err) {
        observer = null;
      }

      var timer = setInterval(function () {
        var height = target.scrollHeight;
        if (height !== lastHeight) {
          lastHeight = height;
          quietSince = Date.now();
        }
        var quiet = Date.now() - quietSince >= LIMITS.settleQuietMs;
        var elapsed = Date.now() - start;
        if ((quiet && elapsed >= LIMITS.settleQuietMs) || elapsed >= LIMITS.settleTimeoutMs) {
          clearInterval(timer);
          if (observer) observer.disconnect();
          resolve();
        }
      }, 60);
    });
  }

  /**
   * Scroll the conversation to the top repeatedly until no older messages load.
   *
   * `onProgress({ loaded, oldest, atTop, rounds })` is called after each round so the
   * caller can update the UI and decide whether the requested date range is covered.
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

    if (!scroller) {
      warnings.push(
        'Could not find the message list scroll container. Only the messages already on screen were captured.'
      );
    }

    var originalTop = scroller ? scroller.scrollTop : 0;
    var seen = Object.create(null);
    var seenCount = 0;
    var startedAt = Date.now();
    var rounds = 0;
    var emptyRounds = 0;
    var atTop = false;
    var cancelled = false;

    function harvest() {
      var nodes = main.querySelectorAll('div[data-id]');
      var added = 0;
      for (var i = 0; i < nodes.length; i++) {
        var id = nodes[i].getAttribute('data-id');
        if (!isMessageId(id) || seen[id]) continue;
        var parent = nodes[i].parentElement;
        if (parent && parent.closest && parent.closest('[data-id]')) continue;
        seen[id] = nodes[i];
        added++;
      }
      seenCount += added;
      return added;
    }

    harvest();

    // Prime the day/month order from the messages on screen, so the date-range stop
    // check compares real timestamps from the very first scroll round.
    resolveDateOrder(collectDateSamples(getRows(main)));

    onProgress({ loaded: seenCount, oldest: null, atTop: false, rounds: 0 });

    while (!cancelled) {
      if (shouldCancel()) {
        cancelled = true;
        break;
      }
      if (rounds >= LIMITS.maxScrollSteps) {
        warnings.push(
          'Stopped after ' +
            LIMITS.maxScrollSteps +
            ' scroll steps. The conversation may have older messages that were not loaded.'
        );
        break;
      }
      if (Date.now() - startedAt > LIMITS.timeBudgetMs) {
        warnings.push(
          'Stopped after ' +
            Math.round((Date.now() - startedAt) / 1000) +
            's to keep the export responsive. Older messages may be missing.'
        );
        break;
      }

      if (scroller) {
        scroller.scrollTop = 0;
        // Some builds only react to a real scroll event.
        try {
          scroller.dispatchEvent(new Event('scroll', { bubbles: false }));
        } catch (err) {
          /* the assignment above is usually enough */
        }
      }

      await settle(scroller);
      var added = harvest();
      rounds++;

      var oldest = oldestTimestamp(main);
      atTop = !scroller || scroller.scrollTop <= 2;

      onProgress({ loaded: seenCount, oldest: oldest, atTop: atTop, rounds: rounds });

      if (opts.dateBounds && opts.dateBounds.start) {
        if (oldest !== null && oldest < opts.dateBounds.start) break;
      }

      if (atTop && added === 0) {
        emptyRounds++;
        if (emptyRounds >= LIMITS.topStabilityRounds) break;
      } else {
        emptyRounds = 0;
      }
    }

    // Give the DOM a moment to finish painting the newly prepended nodes.
    await sleep(60);

    return {
      main: main,
      scroller: scroller,
      originalTop: originalTop,
      seen: seen,
      loaded: seenCount,
      warnings: warnings,
      cancelled: cancelled,
    };
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
    var isOutgoing = /^true_/.test(messageId);

    if (!isOutgoing) {
      var outEl = row.querySelector ? row.querySelector('.message-out') : null;
      if (outEl) isOutgoing = true;
      else if (row.classList && row.classList.contains('message-out')) isOutgoing = true;
    }

    var preEl = row.querySelector ? row.querySelector('[data-pre-plain-text]') : null;
    var pre = preEl ? dt.parsePrePlainText(preEl.getAttribute('data-pre-plain-text')) : null;

    var timestamp = null;
    var timeText = '';
    var author = '';

    if (pre) {
      timeText = pre.timeText;
      author = pre.author;
      var dateParts = dt.parseDateText(pre.dateText, ctx.order || 'dmy');
      timestamp = dt.toEpoch(dateParts, dt.parseTimeText(pre.timeText));
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
    };
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

    // System notices carry no timestamp attribute; borrow the nearest message's
    // time so exports never show a blank clock.
    var lastKnown = null;
    for (var f = 0; f < messages.length; f++) {
      if (messages[f].timestamp !== null) {
        lastKnown = messages[f].timestamp;
      } else if (lastKnown !== null) {
        messages[f].timestamp = lastKnown;
        messages[f].dateKey = dt.dateKey(lastKnown);
      }
    }
    lastKnown = null;
    for (var b2 = messages.length - 1; b2 >= 0; b2--) {
      if (messages[b2].timestamp !== null) {
        lastKnown = messages[b2].timestamp;
      } else if (lastKnown !== null) {
        messages[b2].timestamp = lastKnown;
        messages[b2].dateKey = dt.dateKey(lastKnown);
      }
    }

    // Sanity: sort by timestamp when we have them, but keep unknown-time order.
    messages.sort(function (a, b) {
      if (a.timestamp === null || b.timestamp === null) return 0;
      return a.timestamp - b.timestamp;
    });

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

    return {
      url: String(global.location && global.location.href),
      mainPanel: Boolean(main),
      messageList: rows.length > 0,
      scrollContainer: Boolean(scroller),
      renderedRows: rows.length,
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
    resolveDateOrder: resolveDateOrder,
    resetDateOrderCache: function () {
      orderCache = null;
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
