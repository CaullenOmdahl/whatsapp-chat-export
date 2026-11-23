// WhatsApp Web internals probe. Paste into DevTools on the WhatsApp tab with a chat open.
// Read-only: it calls nothing that loads, downloads, sends or changes anything. It looks
// up WhatsApp's own module and field names and counts things in the open chat.
// Output: module names, function names, field names, types, booleans and counts only.
// No message text, names, numbers, ids, media keys or URLs. Saved to Downloads as
// wa-internals-<time>.json.
(async () => {
  const cp = typeof copy === 'function' ? copy : null;
  const report = { probe: 'wa-internals-v1', userAgent: navigator.userAgent, at: new Date().toISOString().slice(0, 10) };
  const err = (e) => String((e && e.message) || e).replace(/[0-9A-F]{8,}/gi, '<id>').slice(0, 160);
  const R = typeof window.require === 'function' ? window.require : null;
  report.loader = {
    require: Boolean(R),
    __d: typeof window.__d === 'function',
    webpackChunks: Object.keys(window).filter((k) => /webpackChunk/i.test(k)),
  };

  const req = (name) => {
    try {
      return R ? R(name) : undefined;
    } catch (e) {
      return undefined;
    }
  };
  const fnNames = (obj, depth = 2) => {
    const names = new Set();
    let o = obj;
    for (let d = 0; o && d < depth; d++, o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) {
        try {
          if (typeof obj[k] === 'function' && k !== 'constructor' && !/^__/.test(k) && o !== Object.prototype) names.add(k);
        } catch (e) { /* getter threw */ }
      }
    }
    return [...names].sort();
  };
  const shape = (obj) => {
    if (!obj || typeof obj !== 'object') return typeof obj;
    return Object.keys(obj).slice(0, 60).map((k) => {
      let v;
      try { v = obj[k]; } catch (e) { return k + ':throws'; }
      return k + ':' + (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    });
  };

  // 1. Module names.
  let names = [];
  try {
    const dbg = req('__debug');
    report.loader.debug = Boolean(dbg);
    if (dbg && dbg.modulesMap) names = Object.keys(dbg.modulesMap);
  } catch (e) {
    report.loader.debugError = err(e);
  }
  report.moduleCount = names.length;
  const relevant = names.filter((n) => /^WAWeb/.test(n) &&
    /(Collection|LoadEarlier|LoadMsg|ChatLoad|MsgLoad|Download|Decrypt|MediaBlob|MediaPrep|Mms|MsgModel|MsgGetter|ChatModel)/.test(n));
  report.relevantModules = relevant.slice(0, 300);

  // 2. Exports of the modules most likely to matter (only already-named modules; read-only).
  const probeModules = [...new Set([
    'WAWebCollections', 'WAWebChatCollection', 'WAWebMsgCollection', 'WAWebDownloadManager',
    'WAWebCmd', 'WAWebMsgGetters',
    ...relevant.filter((n) => /Collections?$|Download|LoadEarlier|LoadMsg|ChatLoad|MsgLoad|Decrypt|MediaBlob/.test(n)).slice(0, 80),
  ])];
  report.moduleExports = {};
  for (const n of probeModules) {
    const m = req(n);
    if (!m) continue;
    report.moduleExports[n] = Object.keys(m).slice(0, 50).map((k) => {
      const v = m[k];
      if (typeof v === 'function') return k + ':function';
      if (v && typeof v === 'object') return k + ':object[' + fnNames(v).filter((f) => /earlier|load|download|decrypt|active|get|find|msgs?/i.test(f)).slice(0, 25).join(',') + ']';
      return k + ':' + typeof v;
    });
  }

  // 3. The open chat and its loaded messages.
  const collections = req('WAWebCollections') || {};
  const ChatColl = collections.Chat || (req('WAWebChatCollection') || {}).ChatCollection;
  report.chatCollection = Boolean(ChatColl);
  let chat = null;
  if (ChatColl) {
    try { if (typeof ChatColl.getActive === 'function') { chat = ChatColl.getActive(); report.activeVia = 'getActive'; } } catch (e) { report.getActiveError = err(e); }
    if (!chat) {
      try {
        const all = typeof ChatColl.getModelsArray === 'function' ? ChatColl.getModelsArray() : ChatColl.models || [];
        chat = all.find((c) => c.active || c.__x_active) || null;
        if (chat) report.activeVia = 'active flag';
      } catch (e) { report.findActiveError = err(e); }
    }
  }
  report.activeChat = Boolean(chat);

  const get = (m, k) => {
    try {
      if (m[k] !== undefined) return m[k];
      if (m['__x_' + k] !== undefined) return m['__x_' + k];
      if (m.attributes && m.attributes[k] !== undefined) return m.attributes[k];
    } catch (e) { /* ignore */ }
    return undefined;
  };

  if (chat) {
    report.chatFunctions = fnNames(chat, 3).filter((f) => /msg|load|earlier|download|media/i.test(f)).slice(0, 60);
    report.chatFlags = {};
    for (const k of ['isGroup', 'isUser', 'isNewsletter', 'isBroadcast']) {
      const v = get(chat, k);
      if (typeof v === 'boolean') report.chatFlags[k] = v;
    }
    const msgs = get(chat, 'msgs');
    report.msgsCollection = Boolean(msgs);
    if (msgs) {
      report.msgsFunctions = fnNames(msgs, 3).filter((f) => /earlier|load|get|find|models|msgs?|add|sort/i.test(f)).slice(0, 60);
      const state = get(msgs, 'msgLoadState');
      if (state && typeof state === 'object') {
        report.msgLoadState = {};
        for (const k of Object.keys(state).concat(Object.keys(state.attributes || {}))) {
          const v = get(state, k.replace(/^__x_/, ''));
          if (typeof v === 'boolean') report.msgLoadState[k.replace(/^__x_/, '')] = v;
        }
      }
      let arr = [];
      try { arr = typeof msgs.getModelsArray === 'function' ? msgs.getModelsArray() : msgs.models || msgs._models || []; } catch (e) { report.modelsError = err(e); }
      report.loadedMessages = arr.length;

      if (arr.length) {
        const keyTypes = {};
        for (const m of arr.slice(0, 300)) {
          const keys = new Set([...Object.keys(m), ...Object.keys(m.attributes || {})].map((k) => k.replace(/^__x_/, '')));
          for (const k of keys) {
            const v = get(m, k);
            const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
            if (t === 'undefined' || t === 'function') continue;
            keyTypes[k] = keyTypes[k] || new Set();
            keyTypes[k].add(t);
          }
        }
        report.messageFields = Object.keys(keyTypes).sort().map((k) => k + ':' + [...keyTypes[k]].join('|'));
        report.messageFunctions = fnNames(arr[0], 3).filter((f) => /media|download|blob|url|decrypt|body|text|caption|quoted|author|sender|from/i.test(f)).slice(0, 60);
        const id0 = get(arr[0], 'id');
        report.messageIdShape = shape(id0);

        const count = (pred) => arr.filter((m) => { try { return pred(m); } catch (e) { return false; } }).length;
        const types = {};
        for (const m of arr) { const t = String(get(m, 'type')); types[t] = (types[t] || 0) + 1; }
        report.counts = {
          types,
          fromMe: count((m) => (get(m, 'id') || {}).fromMe === true),
          withBody: count((m) => typeof get(m, 'body') === 'string' && get(m, 'body').length > 0),
          withCaption: count((m) => typeof get(m, 'caption') === 'string' && get(m, 'caption').length > 0),
          withMediaKey: count((m) => Boolean(get(m, 'mediaKey'))),
          withDirectPath: count((m) => Boolean(get(m, 'directPath'))),
          withMediaData: count((m) => Boolean(get(m, 'mediaData'))),
          withQuoted: count((m) => Boolean(get(m, 'quotedMsg') || get(m, 'quotedStanzaID'))),
          withTimestamp: count((m) => typeof get(m, 't') === 'number'),
          withAuthor: count((m) => Boolean(get(m, 'author'))),
          withReactions: count((m) => Boolean(get(m, 'hasReaction'))),
        };
        const ts = arr.map((m) => get(m, 't')).filter((t) => typeof t === 'number').sort((a, b) => a - b);
        if (ts.length) report.loadedSpan = { from: new Date(ts[0] * 1000).toISOString().slice(0, 10), to: new Date(ts[ts.length - 1] * 1000).toISOString().slice(0, 10) };
        const media = arr.find((m) => get(m, 'mediaKey'));
        if (media) {
          report.mediaMessageFunctions = fnNames(media, 3).filter((f) => /media|download|blob|url|decrypt/i.test(f)).slice(0, 40);
          report.mediaDataShape = shape(get(media, 'mediaData'));
        }
      }
    }
  }

  const json = JSON.stringify(report, null, 1);
  const name = `wa-internals-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  try { if (cp) cp(json); } catch (e) { /* the download is enough */ }
  console.log(`Internals probe done: module loader ${R ? 'found' : 'NOT found'}, ${report.moduleCount} modules, ` +
    `active chat ${report.activeChat ? 'found' : 'not found'}, ${report.loadedMessages || 0} messages loaded. Saved to Downloads as ${name}.`);
})();
