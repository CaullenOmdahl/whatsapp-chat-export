// WhatsApp Web full probe: everything the extension needs to know, in one run.
// Paste into DevTools on the WhatsApp tab with a chat open, then wait (about a minute).
//
// What it does:
//   1. internals: WhatsApp's module loader, the open chat, its message store, load state
//   2. messages: every field name and type, counts by type / media stage
//   3. media objects: the full shape (two levels, private fields included) of a downloaded
//      photo's mediaObject, mediaData and mediaBlob, and of WhatsApp's media cache
//   4. sources: the code of every WhatsApp function involved in downloading and reading media
//   5. read paths: for a sample of every media type and stage, tries every place a file
//      could be (incl. the <img> WhatsApp already rendered) and counts which return a file
//   6. live download: starts up to 4 not-yet-downloaded items the way a click does and
//      records their stage and every read path once a second for 40 s
//
// Step 6 downloads a few media items, exactly as clicking them in WhatsApp would.
// Output: names, types, counts, sizes, timings and WhatsApp's own code. Never message text,
// names, numbers, ids, keys, URLs or file contents. Saved to Downloads as wa-full-<time>.json.
(async () => {
  const T0 = Date.now();
  const R = typeof window.require === 'function' ? window.require : null;
  const req = (n) => { try { return R(n); } catch (e) { return null; } };
  const src = (fn, max) => (typeof fn === 'function' ? Function.prototype.toString.call(fn).slice(0, max || 3000) : null);
  const get = (m, k) => { try { if (m == null) return undefined; if (m[k] !== undefined) return m[k]; if (m['__x_' + k] !== undefined) return m['__x_' + k]; if (m.attributes) return m.attributes[k]; } catch (e) { /* getter threw */ } return undefined; };
  const kind = (v) => (v === null ? 'null' : v === undefined ? 'undefined' : Array.isArray(v) ? 'array[' + v.length + ']' : typeof v === 'object' ? Object.prototype.toString.call(v).slice(8, -1) + (v.constructor && v.constructor.name && v.constructor.name !== 'Object' ? ':' + v.constructor.name : '') : typeof v);
  const fns = (o) => { const s = new Set(); try { for (let p = o, d = 0; p && p !== Object.prototype && p !== Function.prototype && d < 4; p = Object.getPrototypeOf(p), d++) for (const k of Object.getOwnPropertyNames(p)) { try { if (k !== 'constructor' && typeof o[k] === 'function') s.add(k); } catch (e) {} } } catch (e) {} return [...s].sort(); };
  const shape = (o, depth) => {
    if (o === null || typeof o !== 'object') return kind(o);
    const out = { _type: kind(o), _functions: fns(o).slice(0, 80) };
    let keys = [];
    try { keys = Object.keys(o); } catch (e) {}
    for (const k of keys.slice(0, 80)) {
      let v; try { v = o[k]; } catch (e) { out[k] = 'throws'; continue; }
      out[k] = depth > 0 && v && typeof v === 'object' && !Array.isArray(v) ? shape(v, depth - 1) : kind(v);
    }
    return out;
  };
  const timeout = (p, ms) => Promise.race([p, new Promise((res) => setTimeout(() => res('__timeout__'), ms))]);
  const isBlob = (v) => Boolean(v && typeof v.arrayBuffer === 'function' && typeof v.size === 'number');
  const toBlob = async (v) => {
    try {
      if (v && typeof v.then === 'function') v = await timeout(v, 1500);
      if (isBlob(v)) return v;
      if (v && isBlob(v.blob)) return v.blob;
      for (const f of ['forceToBlob', 'getBlob']) {
        if (v && typeof v[f] === 'function') { let b = v[f](); if (b && b.then) b = await timeout(b, 1500); if (isBlob(b)) return b; }
      }
      if (typeof v === 'string' && v.startsWith('blob:')) { const r = await fetch(v); const b = await r.blob(); if (isBlob(b)) return b; }
    } catch (e) { /* not this path */ }
    return null;
  };
  const report = { probe: 'wa-full-v1', userAgent: navigator.userAgent, steps: {} };
  const step = (name, fn) => Promise.resolve().then(fn).catch((e) => { report.steps[name] = 'error: ' + String((e && e.message) || e).replace(/[0-9A-F]{8,}/gi, '<id>').slice(0, 200); });

  // 1. internals ------------------------------------------------------------------
  let chat = null, msgs = [];
  await step('internals', () => {
    const coll = req('WAWebCollections') || {};
    chat = coll.Chat && coll.Chat.getActive ? coll.Chat.getActive() : null;
    const mc = chat && get(chat, 'msgs');
    msgs = mc ? (mc.getModelsArray ? mc.getModelsArray() : mc.models || []) : [];
    const state = mc && get(mc, 'msgLoadState');
    report.internals = {
      require: Boolean(R), chatFound: Boolean(chat), loadedMessages: msgs.length,
      isGroup: get(chat, 'isGroup'),
      loadState: state ? Object.fromEntries(['noEarlierMsgs', 'isLoadingEarlierMsgs', 'isLoadingRecentMsgs', 'contextLoaded'].map((k) => [k, get(state, k)])) : null,
      loaderExports: Object.keys(req('WAWebChatLoadMessages') || {}),
      chatFunctions: chat ? fns(chat).filter((f) => /msg|load|media|download/i.test(f)) : [],
    };
    report.steps.internals = 'ok';
  });

  // 2. messages ------------------------------------------------------------------
  await step('messages', () => {
    const fields = {};
    const byType = {};
    for (const m of msgs) {
      const keys = new Set([...Object.keys(m), ...Object.keys(m.attributes || {})].map((k) => k.replace(/^__x_/, '')));
      for (const k of keys) { if (/^\$/.test(k)) continue; const t = kind(get(m, k)).replace(/\[\d+\]/, ''); (fields[k] = fields[k] || new Set()).add(t); }
      const md = get(m, 'mediaData');
      const key = String(get(m, 'type')) + (md ? ' ' + String(get(md, 'mediaStage')) : '') + (get(get(m, 'id') || {}, 'fromMe') ? ' out' : ' in');
      byType[key] = (byType[key] || 0) + 1;
    }
    report.messages = { fields: Object.fromEntries(Object.entries(fields).sort().map(([k, v]) => [k, [...v].join('|')])), countsByTypeStageDirection: byType };
    report.steps.messages = 'ok';
  });

  const media = msgs.filter((m) => get(m, 'mediaKey') || get(m, 'mediaData'));
  const stageOf = (m) => String(get(get(m, 'mediaData'), 'mediaStage'));

  // 3. media object shapes -------------------------------------------------------------
  await step('shapes', () => {
    const pick = (pred) => media.find(pred);
    const resolvedPhoto = pick((m) => get(m, 'type') === 'image' && stageOf(m) === 'RESOLVED');
    const anyPhoto = resolvedPhoto || pick((m) => get(m, 'type') === 'image');
    const video = pick((m) => get(m, 'type') === 'video');
    const sticker = pick((m) => get(m, 'type') === 'sticker');
    report.shapes = {};
    for (const [label, m] of Object.entries({ photo: anyPhoto, video, sticker })) {
      if (!m) continue;
      report.shapes[label] = {
        stage: stageOf(m),
        message: { _functions: fns(m).filter((f) => /media|download|blob|url|prep|object|render|thumb/i.test(f)) },
        mediaObject: shape(get(m, 'mediaObject'), 2),
        mediaData: shape(get(m, 'mediaData'), 2),
        mediaDataMediaBlob: shape(get(get(m, 'mediaData'), 'mediaBlob'), 2),
        mediaObjectMediaBlob: shape(get(get(m, 'mediaObject'), 'mediaBlob'), 2),
      };
    }
    const ms = req('WAWebMediaStore') || {};
    report.shapes.mediaStoreModule = Object.keys(ms);
    report.shapes.lruMediaStore = shape(ms.LruMediaStore, 1);
    report.steps.shapes = 'ok';
  });

  // 4. sources --------------------------------------------------------------------------
  await step('sources', () => {
    const S = {};
    const add = (name, fn, max) => { const s = src(fn, max); if (s) S[name] = s; };
    const dm = (req('WAWebDownloadManager') || {}).downloadManager;
    add('downloadManager.downloadAndMaybeDecrypt', dm && dm.downloadAndMaybeDecrypt);
    for (const mod of ['WAWebMediaDownloadMsg', 'WAWebMediaMmsV4Download', 'WAWebCreateMediaBlobUrl', 'WAWebMediaBlobProvider', 'WAWebDownloadAndDecryptCache', 'WAWebMediaStore', 'WAWebMediaObject', 'WAWebMediaDownloadService']) {
      const m = req(mod);
      if (!m) continue;
      for (const k of Object.keys(m)) if (typeof m[k] === 'function') add(mod + '.' + k, m[k], 6000);
    }
    const sample = media.find((m) => get(m, 'type') === 'image') || media[0];
    if (sample) {
      for (const f of fns(sample).filter((f) => /media|download|blob|url|prep|render/i.test(f))) add('msg.' + f, sample[f], 3000);
      const mo = get(sample, 'mediaObject');
      if (mo) for (const f of fns(mo)) add('mediaObject.' + f, mo[f], 1500);
      const store = (req('WAWebMediaStore') || {}).LruMediaStore;
      if (store) for (const f of fns(store)) add('LruMediaStore.' + f, store[f], 1500);
    }
    // WhatsApp's own modules whose names mention how media is shown or read.
    const dbg = req('__debug');
    const names = dbg && dbg.modulesMap ? Object.keys(dbg.modulesMap) : [];
    report.mediaModuleNames = names.filter((n) => /^WAWeb.*(MediaBlob|BlobUrl|MediaStore|MediaCache|Renderable|ImageThumb|FullImage|MediaViewer|LoadMedia|GetMedia|MediaUrl)/i.test(n)).slice(0, 80);
    report.sources = S;
    report.steps.sources = 'ok: ' + Object.keys(S).length;
  });

  // 5. read paths -------------------------------------------------------------------------
  const readPaths = async (m) => {
    const md = get(m, 'mediaData');
    const mo = get(m, 'mediaObject');
    const out = {};
    const tryPath = async (name, getter) => {
      let v; try { v = getter(); } catch (e) { out[name] = 'throws'; return; }
      const b = await toBlob(v);
      out[name] = b ? 'FILE ' + b.size + 'B ' + (b.type || '?') : kind(v);
    };
    await tryPath('mediaObject.mediaBlob', () => get(mo, 'mediaBlob'));
    await tryPath('mediaData.mediaBlob', () => get(md, 'mediaBlob'));
    await tryPath('mediaData.renderableUrl', () => get(md, 'renderableUrl'));
    await tryPath('mediaData.fullPreviewData', () => get(md, 'fullPreviewData'));
    await tryPath('mediaObject.getDownloadPromise()', () => mo && mo.getDownloadPromise && mo.getDownloadPromise());
    const store = (req('WAWebMediaStore') || {}).LruMediaStore;
    const fh = get(md, 'filehash') || get(m, 'filehash');
    if (store && fh) for (const f of fns(store).filter((f) => /^(get|read|load|fetch|lookup|retrieve)/i.test(f)).slice(0, 6)) await tryPath('LruMediaStore.' + f + '(filehash)', () => store[f](fh));
    // The <img> WhatsApp drew for this message, if it is on screen.
    const id = get(get(m, 'id') || {}, 'id');
    const esc = (v) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));
    const node = id ? document.querySelector('#main [data-id="' + esc(String(id)) + '"], #main [data-testid="conv-msg-' + esc(String(id)) + '"]') : null;
    out.onScreen = Boolean(node);
    if (node) {
      const imgs = [...node.querySelectorAll('img')].filter((i) => (i.naturalWidth || i.width) >= 48);
      out.renderedImgs = imgs.length;
      for (const [i, img] of imgs.slice(0, 2).entries()) await tryPath('renderedImg' + i + '.src', () => img.currentSrc || img.src);
    }
    return out;
  };

  await step('readPaths', async () => {
    const groups = {};
    for (const m of media) { const k = String(get(m, 'type')) + ' ' + stageOf(m); (groups[k] = groups[k] || []).push(m); }
    report.readPaths = {};
    for (const [k, list] of Object.entries(groups)) {
      const results = [];
      for (const m of list.slice(0, 4)) results.push(await readPaths(m));
      const tally = {};
      for (const r of results) for (const [path, v] of Object.entries(r)) { const key = path + ' -> ' + String(v).replace(/FILE \d+B/, 'FILE'); tally[key] = (tally[key] || 0) + 1; }
      report.readPaths[k + ' (' + list.length + ' total, ' + results.length + ' tried)'] = tally;
    }
    report.steps.readPaths = 'ok';
  });

  // 6. live download ---------------------------------------------------------------------
  await step('liveDownload', async () => {
    const candidates = media.filter((m) => stageOf(m) !== 'RESOLVED' && typeof m.forceDownloadMediaEvenIfExpensive === 'function');
    const pickByType = {};
    for (const m of candidates) { const t = String(get(m, 'type')); if (!pickByType[t] || Object.keys(pickByType).length < 4) pickByType[t] = pickByType[t] || m; }
    let picked = Object.values(pickByType);
    for (const m of candidates) { if (picked.length >= 4) break; if (!picked.includes(m)) picked.push(m); }
    report.liveDownload = { candidates: candidates.length, items: [] };
    const items = picked.map((m) => ({ m, type: String(get(m, 'type')), startStage: stageOf(m), call: 'pending', timeline: [] }));
    for (const it of items) {
      const t = Date.now();
      it.callPromise = Promise.resolve().then(() => it.m.forceDownloadMediaEvenIfExpensive())
        .then((r) => { it.call = 'resolved after ' + (Date.now() - t) + 'ms -> ' + kind(r); }, (e) => { it.call = 'rejected after ' + (Date.now() - t) + 'ms: ' + String((e && e.message) || e).replace(/[0-9A-F]{8,}/gi, '<id>').slice(0, 120); });
    }
    for (let s = 0; s < 40 && items.length; s++) {
      await new Promise((r) => setTimeout(r, 1000));
      for (const it of items) {
        const last = it.timeline[it.timeline.length - 1];
        const stage = stageOf(it.m);
        const paths = await readPaths(it.m);
        const files = Object.entries(paths).filter(([, v]) => String(v).startsWith('FILE')).map(([k]) => k);
        const entry = (s + 1) + 's ' + stage + (files.length ? ' FILE via ' + files.join(', ') : '');
        if (!last || last.replace(/^\d+s /, '') !== entry.replace(/^\d+s /, '')) it.timeline.push(entry);
      }
      if (items.every((it) => it.timeline.some((e) => /FILE/.test(e)))) break;
    }
    for (const it of items) { const final = await readPaths(it.m); report.liveDownload.items.push({ type: it.type, startStage: it.startStage, call: it.call, timeline: it.timeline, finalPaths: final }); }
    report.steps.liveDownload = 'ok';
  });

  report.tookMs = Date.now() - T0;
  const json = JSON.stringify(report, null, 1);
  const name = `wa-full-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  console.log(`Full probe done in ${Math.round(report.tookMs / 1000)} s (${msgs.length} messages, ${media.length} media). Saved to Downloads as ${name}.`);
})();
