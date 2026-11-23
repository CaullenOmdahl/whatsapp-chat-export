/**
 * Export from WhatsApp's own message store, through the page bridge.
 *
 * This is the primary path: it reads every loaded message as structured data (no
 * placeholders, no split paragraphs, exact direction and time), asks WhatsApp to load
 * earlier history until the start of the chat (or of the date range), and lets the
 * media collector download any message's media through WhatsApp's download manager.
 *
 * If the bridge is missing or a step fails, `content.js` falls back to reading the
 * rendered page (extractor.js).
 */
(function (global) {
  'use strict';

  var WAEx = (global.WAEx = global.WAEx || {});
  var dt = WAEx.datetime;
  var T = WAEx.MESSAGE_TYPES;

  var LIMITS = {
    /** Overall budget for loading earlier history. */
    timeBudgetMs: 10 * 60 * 1000,
    /** Rounds in a row without new messages before giving up. */
    idleRounds: 4,
    /** Wait after a scroll nudge when no loader function is available. */
    scrollWaitMs: 1500,
    /** One loadEarlier request. */
    loadTimeoutMs: 60000,
    /** One media download: the bridge's own 30 s deadline plus room to read the file. */
    mediaTimeoutMs: 45000,
  };

  var MEDIA_KIND = {
    image: T.IMAGE,
    video: T.VIDEO,
    ptv: T.VIDEO,
    audio: T.AUDIO,
    ptt: T.VOICE,
    document: T.DOCUMENT,
    sticker: T.STICKER,
  };

  var SYSTEM_TYPES = {
    e2e_notification: 'Messages and calls are end-to-end encrypted.',
    call_log: '',
    gp2: '',
    notification: '',
    notification_template: '',
    broadcast_notification: '',
    protocol: '',
  };

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function bridge() {
    return WAEx.pageBridge;
  }

  /** Is the store path usable for the open chat? Returns the ping result or null. */
  async function probe() {
    var b = bridge();
    if (!b || !b.available()) return null;
    try {
      var ping = await b.call('ping', null, 4000);
      return ping && ping.store && ping.chat ? ping : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Load earlier history until the chat's start, the date range's start, or a limit.
   * Uses WhatsApp's own loader when it can be found, otherwise scrolls the list to the
   * top (which makes WhatsApp load the previous page into the same store).
   */
  async function loadHistory(options) {
    var opts = options || {};
    var b = bridge();
    var warnings = [];
    var startBound = opts.dateBounds && opts.dateBounds.start;
    var shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : function () {
      return false;
    };
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var startedAt = Date.now();
    var idle = 0;
    var useLoader = Boolean(opts.canLoadEarlier);
    var scroller = null;
    var originalTop = null;
    var state = await b.call('state');
    var ended = '';

    while (true) {
      onProgress({ loaded: state.loaded, oldest: state.oldest ? state.oldest * 1000 : null });
      if (state.state && state.state.noEarlierMsgs) {
        ended = 'start';
        break;
      }
      if (shouldCancel()) {
        ended = 'cancelled';
        break;
      }
      if (startBound && state.oldest && state.oldest * 1000 < startBound) {
        ended = 'date';
        break;
      }
      if (Date.now() - startedAt > LIMITS.timeBudgetMs) {
        warnings.push(
          'Stopped loading older messages after ' + Math.round(LIMITS.timeBudgetMs / 60000) +
            ' minutes. The oldest messages may be missing.'
        );
        ended = 'budget';
        break;
      }

      var before = state.loaded;
      var loaded = false;
      if (useLoader) {
        try {
          var result = await b.call('loadEarlier', null, LIMITS.loadTimeoutMs);
          loaded = Boolean(result && result.ok);
          if (!loaded) useLoader = false;
        } catch (err) {
          useLoader = false;
        }
      }
      if (!loaded) {
        // No usable loader: scrolling to the top makes WhatsApp fetch the previous page.
        var extractor = WAEx.extractor;
        scroller = scroller || (extractor && extractor.findScrollContainer());
        if (!scroller) {
          warnings.push('Could not ask WhatsApp for older messages; only the messages already loaded were exported.');
          ended = 'no-loader';
          break;
        }
        if (originalTop === null) originalTop = scroller.scrollTop || 0;
        if ((scroller.scrollTop || 0) <= 2) {
          scroller.scrollTop = Math.min(300, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
          await sleep(60);
        }
        scroller.scrollTop = 0;
        await sleep(LIMITS.scrollWaitMs);
      }

      state = await b.call('state');
      if (state.loaded <= before && loaded) {
        // The loader ran but brought nothing: try scrolling before calling it a stall.
        useLoader = false;
        continue;
      }
      if (state.loaded <= before) {
        idle++;
        if (idle >= LIMITS.idleRounds) {
          warnings.push(
            'WhatsApp stopped returning older messages before the start of the chat. ' +
              'If WhatsApp offers to load older messages from your phone, do that and export again.'
          );
          ended = 'stalled';
          break;
        }
      } else {
        idle = 0;
      }
    }

    if (scroller && originalTop !== null) {
      try {
        scroller.scrollTop = originalTop;
      } catch (err) {
        /* non-fatal */
      }
    }
    return { ended: ended, loaded: state.loaded, warnings: warnings, cancelled: ended === 'cancelled' };
  }

  function systemText(raw) {
    if (raw.type === 'call_log') return (raw.isVideoCall ? 'Video call' : 'Voice call');
    if (SYSTEM_TYPES[raw.type]) return SYSTEM_TYPES[raw.type];
    return raw.subtype ? raw.type + ': ' + raw.subtype : raw.type;
  }

  /** One store message as the extension's Message model. */
  function toMessage(raw) {
    var timestamp = raw.t ? raw.t * 1000 : null;
    var type = T.UNKNOWN;
    var text = '';
    var media = null;
    var kind = MEDIA_KIND[raw.type];

    if (raw.type === 'chat') {
      type = T.TEXT;
      text = raw.body;
    } else if (kind) {
      type = (raw.type === 'image' || raw.type === 'video') && raw.isGif ? T.GIF : kind;
      text = raw.caption;
      media = {
        kind: type,
        fileName: raw.filename || '',
        mime: raw.mimetype || '',
        bytes: raw.size || 0,
        url: raw.hasMedia ? 'wax-msg:' + raw.id : '',
        missing: true,
        zipPath: '',
      };
    } else if (raw.type === 'revoked') {
      type = T.DELETED;
      text = raw.fromMe ? 'You deleted this message' : 'This message was deleted';
    } else if (raw.type === 'vcard' || raw.type === 'multi_vcard') {
      type = T.CONTACT;
      text = raw.vcardName ? 'Contact: ' + raw.vcardName : 'Contact card';
    } else if (raw.type === 'location' || raw.type === 'live_location') {
      type = T.LOCATION;
      text =
        typeof raw.lat === 'number' && typeof raw.lng === 'number'
          ? 'Location: ' + raw.lat + ', ' + raw.lng
          : 'Location';
    } else if (raw.type === 'poll_creation') {
      type = T.POLL;
      text = 'Poll: ' + raw.pollName + (raw.pollOptions.length ? '\n' + raw.pollOptions.map(function (o) {
        return '• ' + o;
      }).join('\n') : '');
    } else if (Object.prototype.hasOwnProperty.call(SYSTEM_TYPES, raw.type)) {
      type = T.SYSTEM;
      text = systemText(raw);
    } else {
      text = raw.body || raw.caption || '';
    }

    return {
      id: raw.id,
      timestamp: timestamp,
      dateKey: timestamp ? dt.dateKey(timestamp) : '',
      timeText: timestamp ? dt.formatTime(timestamp) : '',
      author: raw.fromMe ? 'You' : raw.author || '',
      isOutgoing: raw.fromMe,
      type: type,
      text: text || '',
      quoted: raw.quoted ? { author: raw.quoted.author || '', text: raw.quoted.text || '' } : null,
      reactions: Array.isArray(raw.reactions) ? raw.reactions : [],
      media: media,
    };
  }

  /** Every loaded message of the open chat, normalised and in time order. */
  async function readMessages() {
    var b = bridge();
    var result = await b.call('messages', null, 60000);
    var warnings = [];
    var unreadable = 0;
    var reactionsUnknown = 0;
    var messages = [];
    for (var i = 0; i < result.messages.length; i++) {
      var raw = result.messages[i];
      if (raw.error) {
        unreadable++;
        continue;
      }
      if (raw.hasReaction && raw.reactions === null) reactionsUnknown++;
      messages.push(toMessage(raw));
    }
    messages.sort(function (a, b) {
      return (a.timestamp || 0) - (b.timestamp || 0);
    });
    if (unreadable) warnings.push(WAEx.plural(unreadable, 'message') + ' could not be read and were left out.');
    if (reactionsUnknown) {
      warnings.push('Reactions on ' + WAEx.plural(reactionsUnknown, 'message') + ' could not be read.');
    }
    return { chatName: result.chatName, isGroup: result.isGroup, messages: messages, warnings: warnings };
  }

  /** Decrypted media of one message, for the media collector. */
  async function readMedia(id) {
    return bridge().call('media', { id: id }, LIMITS.mediaTimeoutMs);
  }

  WAEx.internal = {
    LIMITS: LIMITS,
    probe: probe,
    loadHistory: loadHistory,
    readMessages: readMessages,
    readMedia: readMedia,
    toMessage: toMessage,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
