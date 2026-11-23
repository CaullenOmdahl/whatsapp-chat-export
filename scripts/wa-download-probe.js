// WhatsApp Web media-download probe. Paste into DevTools on the WhatsApp tab with a chat open.
// Read-only: it downloads nothing. It saves the source text of WhatsApp's own download
// functions (to see which arguments they expect) and, for media already opened in the
// chat, which fields hold the downloaded file. No message content, names, ids, keys or
// URLs. Saved to Downloads as wa-download-<time>.json.
(async () => {
  const R = typeof window.require === 'function' ? window.require : null;
  const req = (n) => { try { return R(n); } catch (e) { return null; } };
  const src = (fn, max) => (typeof fn === 'function' ? Function.prototype.toString.call(fn).slice(0, max || 4000) : null);
  const get = (m, k) => { try { return m[k] !== undefined ? m[k] : m['__x_' + k]; } catch (e) { return undefined; } };
  const names = (o) => { const s = new Set(); for (let p = o, d = 0; p && p !== Object.prototype && d < 3; p = Object.getPrototypeOf(p), d++) for (const k of Object.getOwnPropertyNames(p)) { try { if (typeof o[k] === 'function' && k !== 'constructor') s.add(k); } catch (e) {} } return [...s].sort(); };
  const report = { probe: 'wa-download-v3', sources: {}, opened: null };

  const dm = (req('WAWebDownloadManager') || {}).downloadManager;
  report.sources.downloadAndMaybeDecrypt = dm && src(dm.downloadAndMaybeDecrypt, 6000);
  report.sources.startMediaDownloadQpl = src((req('WAWebStartMediaDownloadQpl') || {}).startMediaDownloadQpl, 3000);
  report.sources.mmsV4downloadMedia = src((req('WAWebMediaMmsV4Download') || {}).downloadMedia, 8000);
  report.sources.downloadMsg = src((req('WAWebMediaDownloadMsg') || {}).downloadMsg, 4000);
  report.sources.createMediaBlobUrl = src((req('WAWebCreateMediaBlobUrl') || {}).createMediaBlobUrl, 1500);

  const coll = req('WAWebCollections') || {};
  const chat = coll.Chat && coll.Chat.getActive && coll.Chat.getActive();
  const msgs = chat ? (get(chat, 'msgs').getModelsArray ? get(chat, 'msgs').getModelsArray() : []) : [];
  const media = msgs.filter((m) => get(m, 'mediaKey'));
  report.sources.msgDownloadMedia = media[0] ? src(media[0].downloadMedia, 3000) : null;
  report.sources.msgForceDownload = media[0] ? src(media[0].forceDownloadMediaEvenIfExpensive, 3000) : null;
  const stages = {};
  for (const m of media) { const md = get(m, 'mediaData'); const st = String(md && get(md, 'mediaStage')); stages[st] = (stages[st] || 0) + 1; }
  report.mediaStages = stages;
  const opened = media.map((m) => get(m, 'mediaData')).find((md) => md && get(md, 'mediaBlob'));
  if (opened) {
    const blob = get(opened, 'mediaBlob');
    report.opened = {
      stage: String(get(opened, 'mediaStage')),
      mediaBlobFunctions: names(blob),
      mediaBlobFields: Object.keys(blob).slice(0, 30),
      hasRenderableUrl: Boolean(get(opened, 'renderableUrl')),
      mediaDataFunctions: names(opened).filter((f) => /blob|url|download|media/i.test(f)),
    };
  }

  // v2: WhatsApp's download quietly does nothing for a message without a mediaObject
  // ("msg without mediaObject"). Which messages have one, and how is it created?
  const byStage = {};
  for (const m of media) {
    const md = get(m, 'mediaData');
    const key = String(get(m, 'type')) + ' ' + String(md && get(md, 'mediaStage')) +
      (get(m, 'mediaObject') ? ' +mediaObject' : ' -mediaObject') +
      (md && get(md, 'mediaBlob') ? ' +blob' : '') + (md && get(md, 'renderableUrl') ? ' +url' : '');
    byStage[key] = (byStage[key] || 0) + 1;
  }
  report.mediaObjectByStage = byStage;
  const withObject = media.find((m) => get(m, 'mediaObject'));
  if (withObject) {
    const mo = get(withObject, 'mediaObject');
    report.mediaObjectFunctions = names(mo).slice(0, 60);
    report.mediaObjectFields = Object.keys(mo).slice(0, 40);
  }
  const withoutObject = media.find((m) => !get(m, 'mediaObject'));
  if (withoutObject) {
    report.sources.registerAndPrepMedia = src(withoutObject.registerAndPrepMedia, 4000);
    report.msgMediaFunctions = names(withoutObject).filter((f) => /media|prep|register|object/i.test(f));
  }
  const sticker = media.find((m) => get(m, 'type') === 'sticker');
  if (sticker) {
    const md = get(sticker, 'mediaData');
    report.sticker = md ? Object.keys(md).filter((k) => !/^\$/.test(k)).map((k) => { const v = get(md, k.replace(/^__x_/, '')); return k + ':' + (v === null ? 'null' : typeof v); }).slice(0, 60) : null;
  }
  try {
    const dbg = req('__debug');
    const all = dbg && dbg.modulesMap ? Object.keys(dbg.modulesMap) : [];
    const mods = all.filter((n) => /^WAWeb.*(MediaObject|PrepMedia|MediaPrep|ObjectUrl|MediaStore|MediaBlobCache|getOrCreateMedia)/.test(n)).slice(0, 40);
    report.mediaObjectModules = {};
    for (const n of mods) {
      const m = req(n);
      if (m) report.mediaObjectModules[n] = Object.keys(m).slice(0, 30).map((k) => k + ':' + typeof m[k]);
    }
    const util = mods.map(req).filter(Boolean);
    for (const m of util) {
      for (const k of Object.keys(m)) {
        if (/getOrCreate|createMediaObject|prepMedia|registerMedia/i.test(k) && typeof m[k] === 'function') {
          report.sources['module.' + k] = src(m[k], 3000);
        }
      }
    }
  } catch (e) {
    report.modulesError = String(e && e.message).slice(0, 120);
  }

  // v3: for media WhatsApp reports as downloaded (RESOLVED), try every place the file
  // could be and count which ones return one. Reads only; returns sizes and types, never bytes.
  const describe = (v) => (v === null ? 'null' : v === undefined ? 'undefined' : Object.prototype.toString.call(v).slice(8, -1));
  const asBlob = async (v) => {
    if (!v) return null;
    if (v && typeof v.then === 'function') v = await v;
    if (v && typeof v.arrayBuffer === 'function' && typeof v.size === 'number') return v;
    if (v && v.blob && typeof v.blob.arrayBuffer === 'function') return v.blob;
    for (const f of ['forceToBlob', 'getBlob']) {
      if (v && typeof v[f] === 'function') {
        try { let b = v[f](); if (b && b.then) b = await b; if (b && typeof b.arrayBuffer === 'function') return b; } catch (e) { /* next */ }
      }
    }
    return null;
  };
  const store = (req('WAWebMediaStore') || {}).LruMediaStore;
  report.lruMediaStoreFunctions = store ? names(store).slice(0, 40) : null;
  const resolved = media.filter((m) => { const md = get(m, 'mediaData'); return md && String(get(md, 'mediaStage')) === 'RESOLVED'; }).slice(0, 12);
  const tally = {};
  const hit = (k, ok, detail) => { tally[k] = tally[k] || { ok: 0, no: 0, types: {} }; tally[k][ok ? 'ok' : 'no']++; if (detail) tally[k].types[detail] = (tally[k].types[detail] || 0) + 1; };
  for (const m of resolved) {
    const md = get(m, 'mediaData');
    const mo = get(m, 'mediaObject');
    const type = String(get(m, 'type'));
    let v;
    v = mo && get(mo, 'mediaBlob'); hit(type + ' mediaObject.mediaBlob', Boolean(await asBlob(v)), describe(v));
    v = md && get(md, 'mediaBlob'); hit(type + ' mediaData.mediaBlob', Boolean(await asBlob(v)), describe(v));
    v = md && get(md, 'renderableUrl'); hit(type + ' renderableUrl', typeof v === 'string' && v.startsWith('blob:'), describe(v));
    if (mo && typeof mo.getDownloadPromise === 'function') {
      try { v = mo.getDownloadPromise(); const r = v && v.then ? await Promise.race([v, new Promise((res) => setTimeout(() => res('pending'), 1500))]) : v; hit(type + ' mediaObject.getDownloadPromise()', Boolean(await asBlob(r)), describe(r) + (r && typeof r === 'object' ? '[' + Object.keys(r).slice(0, 8).join(',') + ']' : '')); } catch (e) { hit(type + ' mediaObject.getDownloadPromise()', false, 'threw'); }
    }
    const filehash = (md && get(md, 'filehash')) || get(m, 'filehash');
    if (store && filehash) {
      for (const f of names(store).filter((n) => /^(get|read|load|fetch|lookup|retrieve)/i.test(n)).slice(0, 6)) {
        try { const r = await Promise.race([Promise.resolve(store[f](filehash)), new Promise((res) => setTimeout(() => res('pending'), 1500))]); hit(type + ' LruMediaStore.' + f + '(filehash)', Boolean(await asBlob(r)), describe(r)); } catch (e) { hit(type + ' LruMediaStore.' + f + '(filehash)', false, 'threw'); }
      }
    }
  }
  report.resolvedTried = resolved.length;
  report.whereTheFileIs = tally;

  const json = JSON.stringify(report, null, 1);
  const name = `wa-download-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  console.log(`Download probe done (${media.length} media messages, ${Object.keys(report.sources).filter((k) => report.sources[k]).length} sources). Saved to Downloads as ${name}.`);
})();
