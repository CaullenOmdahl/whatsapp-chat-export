/**
 * Page bridge: runs in WhatsApp Web's own JavaScript world (manifest `world: "MAIN"`).
 *
 * The content script lives in an isolated world and can only see the rendered page,
 * which WhatsApp virtualises (off-screen messages are empty placeholders). WhatsApp's
 * own message store has every loaded message as structured data, and its download
 * manager can fetch and decrypt any media in the chat, opened or not. This bridge
 * exposes a small, read-only slice of that to the content script over
 * `window.postMessage`:
 *
 *   ping      is the store reachable, which chat is open, how much is loaded
 *   state     loaded count, oldest timestamp, whether earlier history remains
 *   loadEarlier  ask WhatsApp to load the previous page of history (as scrolling up does)
 *   messages  every loaded message of the open chat, as plain data
 *   media     the decrypted bytes of one message's media
 *
 * Nothing here sends, edits, deletes or marks anything. WhatsApp's internal module
 * names are not public and change between releases; every lookup is defensive and a
 * miss makes the content script fall back to reading the page.
 */
(function () {
  'use strict';

  if (window.__waxBridgeInstalled) return;
  window.__waxBridgeInstalled = true;

  var VERSION = 1;
  var IN = 'wax-content';
  var OUT = 'wax-page';

  /* ------------------------------------------------------------- lookups */

  function req(name) {
    try {
      return typeof window.require === 'function' ? window.require(name) : null;
    } catch (err) {
      return null;
    }
  }

  /** Model attribute, whichever way this WhatsApp build stores it. */
  function get(model, key) {
    if (!model) return undefined;
    try {
      var value = model[key];
      if (value !== undefined) return value;
      value = model['__x_' + key];
      if (value !== undefined) return value;
      if (model.attributes && model.attributes[key] !== undefined) return model.attributes[key];
    } catch (err) {
      /* getter threw */
    }
    return undefined;
  }

  function collections() {
    return req('WAWebCollections') || {};
  }

  function activeChat() {
    var coll = collections();
    var Chat = coll.Chat || (req('WAWebChatCollection') || {}).ChatCollection;
    if (!Chat) return null;
    try {
      if (typeof Chat.getActive === 'function') {
        var active = Chat.getActive();
        if (active) return active;
      }
    } catch (err) {
      /* fall through */
    }
    try {
      var all = typeof Chat.getModelsArray === 'function' ? Chat.getModelsArray() : Chat.models || [];
      for (var i = 0; i < all.length; i++) {
        if (get(all[i], 'active')) return all[i];
      }
    } catch (err) {
      /* none */
    }
    return null;
  }

  function msgsOf(chat) {
    var msgs = get(chat, 'msgs');
    if (!msgs) return [];
    try {
      if (typeof msgs.getModelsArray === 'function') return msgs.getModelsArray();
      return msgs.models || msgs._models || [];
    } catch (err) {
      return [];
    }
  }

  function loadState(chat) {
    var msgs = get(chat, 'msgs');
    var state = msgs ? get(msgs, 'msgLoadState') : null;
    return {
      noEarlierMsgs: Boolean(state && get(state, 'noEarlierMsgs')),
      isLoadingEarlierMsgs: Boolean(state && get(state, 'isLoadingEarlierMsgs')),
      known: Boolean(state),
    };
  }

  function widString(wid) {
    if (!wid) return '';
    if (typeof wid === 'string') return wid;
    try {
      return wid._serialized || (wid.toString && wid.toString()) || wid.user || '';
    } catch (err) {
      return '';
    }
  }

  function contactName(wid) {
    if (!wid) return '';
    var Contact = collections().Contact || (req('WAWebContactCollection') || {}).ContactCollection;
    var contact = null;
    try {
      contact = Contact && typeof Contact.get === 'function' ? Contact.get(wid) : null;
    } catch (err) {
      contact = null;
    }
    var name =
      get(contact, 'name') ||
      get(contact, 'pushname') ||
      get(contact, 'verifiedName') ||
      get(contact, 'formattedName') ||
      '';
    if (name) return String(name);
    var user = (wid && wid.user) || widString(wid).split('@')[0];
    return user ? '+' + user : '';
  }

  function chatName(chat) {
    var name = get(chat, 'formattedTitle') || get(chat, 'name');
    if (name) return String(name);
    var contact = get(chat, 'contact');
    return get(contact, 'name') || get(contact, 'pushname') || get(contact, 'formattedName') || contactName(get(chat, 'id'));
  }

  function isGroupChat(chat) {
    var flag = get(chat, 'isGroup');
    if (typeof flag === 'boolean') return flag;
    var id = get(chat, 'id');
    return Boolean(id && (id.server === 'g.us' || /@g\.us$/.test(widString(id))));
  }

  function messageId(msg) {
    var id = get(msg, 'id');
    return id ? String(id._serialized || id.id || widString(id)) : '';
  }

  /* ------------------------------------------------------------ messages */

  var MEDIA_TYPES = { image: 1, video: 1, audio: 1, ptt: 1, document: 1, sticker: 1, ptv: 1 };

  function reactionsFor(msg) {
    if (!get(msg, 'hasReaction')) return [];
    var Reactions = collections().Reactions;
    if (!Reactions || typeof Reactions.get !== 'function') return null;
    try {
      var entry = Reactions.get(messageId(msg));
      var list = entry ? get(entry, 'reactions') : null;
      var models = list ? (typeof list.getModelsArray === 'function' ? list.getModelsArray() : list.models || list) : [];
      var out = [];
      for (var i = 0; i < models.length; i++) {
        var emoji = get(models[i], 'aggregateEmoji') || get(models[i], 'reactionText') || '';
        var senders = get(models[i], 'senders');
        var count = senders ? (typeof senders.length === 'number' ? senders.length : (senders.models || []).length) : 1;
        if (emoji) out.push({ emoji: String(emoji), count: count || 1 });
      }
      return out;
    } catch (err) {
      return null;
    }
  }

  function vcardName(text) {
    var match = /(?:^|\n)FN[^:]*:(.*)/.exec(String(text || ''));
    return match ? match[1].trim() : '';
  }

  function serialize(msg, chat, groupChat, name) {
    var id = get(msg, 'id') || {};
    var type = String(get(msg, 'type') || '');
    var fromMe = Boolean(id.fromMe);
    var authorWid = get(msg, 'author') || (fromMe ? null : get(msg, 'from'));
    var author = fromMe ? '' : groupChat ? contactName(authorWid) : name;
    var mediaKey = get(msg, 'mediaKey');
    var directPath = get(msg, 'directPath');

    var quoted = null;
    var quotedMsg = get(msg, 'quotedMsg');
    if (quotedMsg) {
      var quotedType = String(get(quotedMsg, 'type') || '');
      var participant = get(msg, 'quotedParticipant');
      var quotedFromMe = false;
      try {
        var me = (collections().Contact || {}).getMeContact ? collections().Contact.getMeContact() : null;
        quotedFromMe = Boolean(me && participant && widString(get(me, 'id')) === widString(participant));
      } catch (err) {
        quotedFromMe = false;
      }
      quoted = {
        author: quotedFromMe ? 'You' : groupChat ? contactName(participant) : participant ? name : '',
        type: quotedType,
        text: String(
          (quotedType === 'chat' ? get(quotedMsg, 'body') : get(quotedMsg, 'caption')) || ''
        ).slice(0, 2000),
      };
    }

    var out = {
      id: messageId(msg),
      t: Number(get(msg, 't')) || 0,
      type: type,
      subtype: String(get(msg, 'subtype') || ''),
      fromMe: fromMe,
      author: author,
      // For media types `body` holds a base64 thumbnail, never text.
      body: type === 'chat' ? String(get(msg, 'body') || '') : '',
      caption: MEDIA_TYPES[type] ? String(get(msg, 'caption') || '') : '',
      filename: String(get(msg, 'filename') || ''),
      mimetype: String(get(msg, 'mimetype') || ''),
      size: Number(get(msg, 'size')) || 0,
      duration: Number(get(msg, 'duration')) || 0,
      hasMedia: Boolean(MEDIA_TYPES[type] && mediaKey && directPath),
      isGif: Boolean(get(msg, 'isGif')),
      isViewOnce: Boolean(get(msg, 'isViewOnce')),
      isForwarded: Boolean(get(msg, 'isForwarded')),
      isVideoCall: Boolean(get(msg, 'isVideoCall')),
      hasReaction: Boolean(get(msg, 'hasReaction')),
      reactions: reactionsFor(msg),
      quoted: quoted,
      vcardName: type === 'vcard' ? vcardName(get(msg, 'body')) : '',
      lat: get(msg, 'lat'),
      lng: get(msg, 'lng'),
      pollName: type === 'poll_creation' ? String(get(msg, 'pollName') || '') : '',
      pollOptions:
        type === 'poll_creation'
          ? (get(msg, 'pollOptions') || []).map(function (o) {
              return String((o && (o.name || o.optionName)) || '');
            })
          : [],
    };
    return out;
  }

  /* --------------------------------------------------------------- media */

  function findMsg(chat, id) {
    var list = msgsOf(chat);
    for (var i = 0; i < list.length; i++) {
      if (messageId(list[i]) === id) return list[i];
    }
    return null;
  }

  async function downloadMedia(chat, id) {
    var msg = findMsg(chat, id);
    if (!msg) throw new Error('message is no longer loaded');
    var manager = (req('WAWebDownloadManager') || {}).downloadManager;
    if (!manager || typeof manager.downloadAndMaybeDecrypt !== 'function') {
      throw new Error('WhatsApp download manager not found');
    }
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var data = await manager.downloadAndMaybeDecrypt({
      directPath: get(msg, 'directPath'),
      encFilehash: get(msg, 'encFilehash'),
      filehash: get(msg, 'filehash'),
      mediaKey: get(msg, 'mediaKey'),
      mediaKeyTimestamp: get(msg, 'mediaKeyTimestamp'),
      type: get(msg, 'type'),
      signal: controller ? controller.signal : undefined,
    });
    if (!data) throw new Error('empty download');
    // Compare by tag, not instanceof: the buffer may come from another realm.
    var tag = Object.prototype.toString.call(data);
    var buffer = null;
    if (tag === '[object ArrayBuffer]') buffer = data;
    else if (ArrayBuffer.isView(data)) buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    if (!buffer) throw new Error('unexpected download result');
    return { buffer: buffer, mimetype: String(get(msg, 'mimetype') || ''), filename: String(get(msg, 'filename') || '') };
  }

  /* -------------------------------------------------------- load earlier */

  function earlierLoader() {
    var mod = req('WAWebChatLoadMessages');
    if (!mod) return null;
    if (typeof mod.loadEarlierMsgs === 'function') return mod.loadEarlierMsgs;
    var keys = Object.keys(mod);
    for (var i = 0; i < keys.length; i++) {
      if (/earlier/i.test(keys[i]) && typeof mod[keys[i]] === 'function') return mod[keys[i]];
    }
    return null;
  }

  async function loadEarlier(chat) {
    var loader = earlierLoader();
    if (!loader) return { ok: false, reason: 'no loader' };
    var before = msgsOf(chat).length;
    try {
      await loader(chat);
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err).slice(0, 120) };
    }
    return { ok: true, added: msgsOf(chat).length - before };
  }

  /* ------------------------------------------------------------ dispatch */

  function oldestT(list) {
    var oldest = 0;
    for (var i = 0; i < list.length; i++) {
      var t = Number(get(list[i], 't')) || 0;
      if (t && (!oldest || t < oldest)) oldest = t;
    }
    return oldest;
  }

  async function handle(type, payload) {
    var chat = activeChat();
    if (type === 'ping') {
      return {
        version: VERSION,
        store: Boolean(req('WAWebCollections')),
        chat: Boolean(chat),
        chatName: chat ? chatName(chat) : '',
        isGroup: chat ? isGroupChat(chat) : false,
        loaded: chat ? msgsOf(chat).length : 0,
        state: chat ? loadState(chat) : null,
        canLoadEarlier: Boolean(earlierLoader()),
        canDownload: Boolean(((req('WAWebDownloadManager') || {}).downloadManager || {}).downloadAndMaybeDecrypt),
      };
    }
    if (!chat) throw new Error('no open chat');
    if (type === 'state') {
      var list = msgsOf(chat);
      return { loaded: list.length, oldest: oldestT(list), state: loadState(chat) };
    }
    if (type === 'loadEarlier') return loadEarlier(chat);
    if (type === 'messages') {
      var group = isGroupChat(chat);
      var name = chatName(chat);
      var models = msgsOf(chat);
      var messages = [];
      for (var i = 0; i < models.length; i++) {
        try {
          messages.push(serialize(models[i], chat, group, name));
        } catch (err) {
          messages.push({ id: messageId(models[i]), t: Number(get(models[i], 't')) || 0, type: 'unreadable', error: true });
        }
      }
      return { chatName: name, isGroup: group, messages: messages, state: loadState(chat) };
    }
    if (type === 'media') return downloadMedia(chat, String((payload && payload.id) || ''));
    throw new Error('unknown request ' + type);
  }

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.source !== IN || typeof data.type !== 'string' || !data.reqId) return;
    if (event.source && event.source !== window) return;
    handle(data.type, data.payload).then(
      function (result) {
        var transfer =
          result && Object.prototype.toString.call(result.buffer) === '[object ArrayBuffer]' ? [result.buffer] : [];
        window.postMessage({ source: OUT, reqId: data.reqId, ok: true, result: result }, '*', transfer);
      },
      function (err) {
        window.postMessage(
          { source: OUT, reqId: data.reqId, ok: false, error: String((err && err.message) || err).slice(0, 200) },
          '*'
        );
      }
    );
  });

  // Shared with the isolated world: the DOM is common to both.
  try {
    document.documentElement.setAttribute('data-wax-bridge', String(VERSION));
  } catch (err) {
    /* no DOM yet; the content script will time out its ping and fall back */
  }
})();
