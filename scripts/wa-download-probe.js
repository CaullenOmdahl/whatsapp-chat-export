// WhatsApp Web media-download probe. Paste into DevTools on the WhatsApp tab with a chat open.
// Read-only: it downloads nothing. It saves the source text of WhatsApp's own download
// functions (to see which arguments they expect) and, for media already opened in the
// chat, which fields hold the downloaded file. No message content, names, ids, keys or
// URLs. Saved to Downloads as wa-download-<time>.json.
(() => {
  const R = typeof window.require === 'function' ? window.require : null;
  const req = (n) => { try { return R(n); } catch (e) { return null; } };
  const src = (fn, max) => (typeof fn === 'function' ? Function.prototype.toString.call(fn).slice(0, max || 4000) : null);
  const get = (m, k) => { try { return m[k] !== undefined ? m[k] : m['__x_' + k]; } catch (e) { return undefined; } };
  const names = (o) => { const s = new Set(); for (let p = o, d = 0; p && p !== Object.prototype && d < 3; p = Object.getPrototypeOf(p), d++) for (const k of Object.getOwnPropertyNames(p)) { try { if (typeof o[k] === 'function' && k !== 'constructor') s.add(k); } catch (e) {} } return [...s].sort(); };
  const report = { probe: 'wa-download-v1', sources: {}, opened: null };

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
