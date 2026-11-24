/**
 * Page bridge: runs in WhatsApp Web's own JavaScript world (manifest `world: "MAIN"`).
 *
 * The content script lives in an isolated world and can only see the rendered page,
 * which WhatsApp virtualises (off-screen messages are empty placeholders). WhatsApp's
 * own message store has every loaded message as structured data, and its own download
 * flow (the one clicking a photo runs) can fetch and decrypt any media in the chat,
 * opened or not. This bridge
 * exposes a small, read-only slice of that to the content script over
 * `window.postMessage`:
 *
 *   ping      is the store reachable, which chat is open, how much is loaded
 *   state     loaded count, oldest timestamp, whether earlier history remains
 *   loadEarlier  ask WhatsApp to load the previous page of history (as scrolling up does)
 *   messages  every loaded message of the open chat, as plain data
 *   prefetchMedia  start downloading many messages' media at once
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

  function isBlob(value) {
    return Boolean(value && typeof value.arrayBuffer === 'function' && typeof value.size === 'number');
  }

  /** Shape of a value for failure messages: type and key names only, never contents. */
  function describe(value) {
    if (value === null) return 'null';
    if (value === undefined) return 'none';
    var tag = Object.prototype.toString.call(value).slice(8, -1);
    if (typeof value !== 'object') return typeof value;
    var keys = [];
    try {
      keys = Object.keys(value).filter(function (k) {
        return !/^\$/.test(k);
      });
    } catch (err) {
      keys = [];
    }
    return tag + (keys.length ? '{' + keys.slice(0, 6).join(',') + '}' : '');
  }

  /**
   * Turn whatever WhatsApp hands back into a Blob: a Blob, raw bytes, its MediaBlob wrapper
   * (forceToBlob/getBlob), a promise of any of these, or a record holding one of them.
   */
  async function unwrap(value, mimetype, depth) {
    if (value == null || (depth || 0) > 3) return null;
    try {
      if (typeof value.then === 'function') {
        value = await Promise.race([
          value,
          new Promise(function (resolve) {
            setTimeout(resolve, 5000, null);
          }),
        ]);
        if (value == null) return null;
      }
      if (isBlob(value)) return value;
      var tag = Object.prototype.toString.call(value);
      if (tag === '[object ArrayBuffer]' || ArrayBuffer.isView(value)) {
        return new Blob([value], { type: mimetype || '' });
      }
      if (typeof value === 'string') return /^blob:/.test(value) ? blobFromUrl(value) : null;
      if (typeof value !== 'object') return null;
      if (value.released === true) return null;
      var methods = ['forceToBlob', 'getBlob'];
      for (var i = 0; i < methods.length; i++) {
        if (typeof value[methods[i]] === 'function') {
          var inner = await unwrap(value[methods[i]](), mimetype, (depth || 0) + 1);
          if (inner) return inner;
        }
      }
      var fields = ['mediaBlob', 'blob', 'data', 'value', 'buffer', 'file', 'arrayBuffer'];
      for (var j = 0; j < fields.length; j++) {
        var field = value[fields[j]];
        if (field != null && typeof field !== 'function') {
          var found = await unwrap(field, mimetype, (depth || 0) + 1);
          if (found) return found;
        }
      }
    } catch (err) {
      /* not readable this way */
    }
    return null;
  }

  function mediaStore() {
    var mod = req('WAWebMediaStore');
    return mod && mod.LruMediaStore && typeof mod.LruMediaStore.get === 'function' ? mod.LruMediaStore : null;
  }

  /**
   * The downloaded file of a message, if WhatsApp has it: a Blob, or null. `note.found`
   * records what each source returned (types and key names only), so a failure explains
   * itself instead of needing another probe.
   *
   * Live (2026-11): a finished download is put on mediaObject.mediaBlob and autoreleased
   * soon after it is rendered (mediaObject.clearBlob); the file stays in WhatsApp's media
   * cache (WAWebMediaStore.LruMediaStore), keyed by filehash (getLRUStoreKey). Only videos
   * kept theirs on mediaData.mediaBlob.
   */
  async function blobOf(msg, note) {
    var mediaData = get(msg, 'mediaData');
    var mediaObject = get(msg, 'mediaObject');
    var mimetype = String(get(msg, 'mimetype') || '');
    var seen = [];
    var sources = [
      ['mediaObject.mediaBlob', function () {
        return get(mediaObject, 'mediaBlob');
      }],
      ['mediaData.mediaBlob', function () {
        return get(mediaData, 'mediaBlob');
      }],
      ['renderableUrl', function () {
        return get(mediaData, 'renderableUrl');
      }],
      ['download result', function () {
        var entry = downloads[messageId(msg)];
        return entry ? entry.result : undefined;
      }],
    ];
    for (var i = 0; i < sources.length; i++) {
      var value;
      try {
        value = sources[i][1]();
      } catch (err) {
        seen.push(sources[i][0] + ' threw');
        continue;
      }
      var blob = await unwrap(value, mimetype, 0);
      if (blob) return blob;
      seen.push(sources[i][0] + '=' + describe(value));
    }
    var store = mediaStore();
    var filehash = get(mediaData, 'filehash') || get(msg, 'filehash');
    if (store && filehash) {
      var cached;
      try {
        cached = await Promise.race([
          store.get(filehash),
          new Promise(function (resolve) {
            setTimeout(resolve, 5000, undefined);
          }),
        ]);
      } catch (err) {
        cached = 'threw';
      }
      var fromCache = await unwrap(cached, mimetype, 0);
      if (fromCache) return fromCache;
      seen.push('cache=' + describe(cached));
    } else {
      seen.push(store ? 'cache: no filehash' : 'cache: not found');
    }
    note.found = seen.join(', ');
    return null;
  }

  /** Read a blob: URL WhatsApp created in this page. Never anything else. */
  async function blobFromUrl(url) {
    if (typeof url !== 'string' || !/^blob:/.test(url)) return null;
    try {
      var response = await window.fetch(url);
      var fetched = await response.blob();
      return isBlob(fetched) ? fetched : null;
    } catch (err) {
      return null;
    }
  }

  function stageOf(msg) {
    var mediaData = get(msg, 'mediaData');
    return String((mediaData && get(mediaData, 'mediaStage')) || '');
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Media of one message, downloaded the way clicking it in WhatsApp does:
   * `forceDownloadMediaEvenIfExpensive()` runs WhatsApp's own download flow (including
   * asking the phone to re-send media the server no longer has), then the decrypted file
   * is read from `mediaData.mediaBlob`. Media WhatsApp already downloaded is read directly.
   *
   * The download is started, not awaited: WhatsApp's flow can stay pending for a long time
   * (media waiting on the phone), so the whole attempt is bounded by one deadline.
   */
  /**
   * Started downloads, by message id: { how, failed, startedAt }. Starting is separate from
   * reading so every download can be started at once (`prefetchMedia`): requests that wait
   * on the phone then overlap instead of queueing behind each other.
   */
  var downloads = Object.create(null);

  function startDownload(msg, id) {
    if (downloads[id]) return downloads[id];
    var entry = { how: '', failed: null, startedAt: Date.now() };
    var run;
    if (typeof msg.forceDownloadMediaEvenIfExpensive === 'function') {
      entry.how = 'forceDownload';
      run = function () {
        return msg.forceDownloadMediaEvenIfExpensive();
      };
    } else if (typeof msg.downloadMedia === 'function') {
      entry.how = 'downloadMedia';
      run = function () {
        return msg.downloadMedia({ downloadEvenIfExpensive: true, isUserInitiated: true });
      };
    } else {
      entry.failed = new Error('WhatsApp download function not found');
      downloads[id] = entry;
      return entry;
    }
    // Started, not awaited: WhatsApp's flow can stay pending for a long time.
    Promise.resolve()
      .then(run)
      .catch(function (err) {
        entry.failed = err || new Error('download failed');
      });
    downloads[id] = entry;
    // WhatsApp frees the downloaded file soon after use, so copy it the moment the
    // download's own promise settles (mediaObject.getDownloadPromise()).
    captureResult(msg, entry);
    return entry;
  }

  async function captureResult(msg, entry) {
    var mimetype = String(get(msg, 'mimetype') || '');
    var until = Date.now() + (Number(window.__waxMediaWaitMs) || 30000);
    while (Date.now() < until && !entry.result && !entry.failed) {
      var mediaObject = get(msg, 'mediaObject');
      var promise = null;
      try {
        promise = mediaObject && typeof mediaObject.getDownloadPromise === 'function' ? mediaObject.getDownloadPromise() : null;
      } catch (err) {
        promise = null;
      }
      if (promise) {
        try {
          var settled = await promise;
          entry.result = (await unwrap(settled, mimetype, 0)) || (await unwrap(get(mediaObject, 'mediaBlob'), mimetype, 0));
        } catch (err) {
          /* the poll in downloadMedia reports the failure */
        }
        return;
      }
      var direct = await unwrap(get(mediaObject, 'mediaBlob'), mimetype, 0);
      if (direct) {
        entry.result = direct;
        return;
      }
      await sleep(100);
    }
  }

  /** Start downloading every listed message's media that WhatsApp does not have yet. */
  async function prefetchMedia(chat, ids) {
    var started = 0;
    var note = { found: '' };
    for (var i = 0; i < ids.length; i++) {
      var msg = findMsg(chat, ids[i]);
      if (!msg || downloads[ids[i]]) continue;
      if (await blobOf(msg, note)) continue;
      startDownload(msg, ids[i]);
      started++;
    }
    return { started: started };
  }

  async function downloadMedia(chat, id) {
    var msg = findMsg(chat, id);
    if (!msg) throw new Error('message is no longer loaded');
    var note = { found: '' };
    var blob = await blobOf(msg, note);
    if (!blob) {
      var entry = startDownload(msg, id);
      // The limit counts from the download's start, restarts whenever its stage changes
      // (it is moving through WhatsApp's queue), and leaves at least a third of it (10 s)
      // from this read.
      var waitMs = Number(window.__waxMediaWaitMs) || 30000;
      var lastStage = stageOf(msg);
      var deadline = Math.max(entry.startedAt + waitMs, Date.now() + Math.round(waitMs / 3));
      while (!blob && !entry.failed && Date.now() < deadline) {
        var stage = stageOf(msg);
        if (/ERROR|FAIL/i.test(stage)) break;
        if (stage !== lastStage) {
          lastStage = stage;
          deadline = Math.max(deadline, Date.now() + waitMs);
        }
        blob = await blobOf(msg, note);
        if (!blob) await sleep(Math.min(250, Math.max(20, Math.round(waitMs / 10))));
      }
      if (!blob) blob = await blobOf(msg, note); // it may have landed during the last wait
      delete downloads[id]; // finished either way; a later export may try again
      if (!blob) {
        var why = entry.failed
          ? entry.how + ' failed: ' + String((entry.failed && entry.failed.message) || entry.failed).slice(0, 80)
          : Date.now() >= deadline
            ? 'timed out'
            : 'stage ' + stageOf(msg);
        throw new Error(why + ' (stage ' + (stageOf(msg) || 'none') + (note.found ? ', ' + note.found : '') + ')');
      }
    }
    var buffer = await blob.arrayBuffer();
    return {
      buffer: buffer,
      // The message's own type is more specific than a generic blob type.
      mimetype: String(
        (blob.type && blob.type !== 'application/octet-stream' ? blob.type : get(msg, 'mimetype')) || blob.type || ''
      ),
      filename: String(get(msg, 'filename') || ''),
    };
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

  /**
   * Which argument form WhatsApp's loadEarlierMsgs accepts on this build, once found.
   * Its parameters are not public; open-source clients have called it as (chat) and as
   * (chat, chat.msgs). Each form is tried until one adds messages, then reused.
   */
  var loaderForm = null;
  var LOADER_FORMS = ['chat', 'chat+msgs', 'msgs'];

  function loaderArgs(form, chat) {
    var msgs = get(chat, 'msgs');
    if (form === 'chat+msgs') return [chat, msgs];
    if (form === 'msgs') return [msgs];
    return [chat];
  }

  async function waitWhileLoading(chat) {
    for (var i = 0; i < 100 && loadState(chat).isLoadingEarlierMsgs; i++) await sleep(100);
  }

  async function loadEarlier(chat) {
    var loader = earlierLoader();
    if (!loader) return { ok: false, reason: 'no loader', tried: [] };
    var forms = loaderForm ? [loaderForm] : LOADER_FORMS;
    var tried = [];
    for (var i = 0; i < forms.length; i++) {
      var before = msgsOf(chat).length;
      var returned;
      try {
        returned = await loader.apply(null, loaderArgs(forms[i], chat));
        await waitWhileLoading(chat);
      } catch (err) {
        tried.push(forms[i] + ' threw ' + String((err && err.message) || err).replace(/[0-9A-F]{8,}/gi, '<id>').slice(0, 60));
        continue;
      }
      var added = msgsOf(chat).length - before;
      tried.push(forms[i] + ' added ' + added + ' (returned ' + describe(returned) + ')');
      if (added > 0 || loadState(chat).noEarlierMsgs) {
        loaderForm = forms[i];
        return { ok: true, added: added, form: forms[i], tried: tried };
      }
    }
    if (loaderForm) {
      // A form that worked before brought nothing this time: older history may still be
      // on its way from WhatsApp's servers. Not a broken loader; the caller retries.
      return { ok: true, added: 0, form: loaderForm, tried: tried };
    }
    return { ok: false, reason: 'loaded nothing', tried: tried };
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

  function newestT(list) {
    var newest = 0;
    for (var i = 0; i < list.length; i++) {
      var t = Number(get(list[i], 't')) || 0;
      if (t > newest) newest = t;
    }
    return newest;
  }

  async function handle(type, payload) {
    var chat = activeChat();
    if (type === 'ping') {
      var loadedList = chat ? msgsOf(chat) : [];
      return {
        oldest: oldestT(loadedList),
        newest: newestT(loadedList),
        version: VERSION,
        store: Boolean(req('WAWebCollections')),
        chat: Boolean(chat),
        chatName: chat ? chatName(chat) : '',
        isGroup: chat ? isGroupChat(chat) : false,
        loaded: loadedList.length,
        state: chat ? loadState(chat) : null,
        canLoadEarlier: Boolean(earlierLoader()),
        canDownload: true,
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
    if (type === 'prefetchMedia') return prefetchMedia(chat, (payload && payload.ids) || []);
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
