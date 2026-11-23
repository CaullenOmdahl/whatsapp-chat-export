// WhatsApp Web structure probe. Paste into DevTools on the WhatsApp tab with a chat open.
// It scrolls through the messages already loaded in the open chat, then puts back your scroll position.
// Output is structure only: no message text, names, numbers, ids, file names or labels.
// The report is saved to your Downloads folder as wa-probe-<time>.json.
// Digits become 9 and letters become a; only WhatsApp's own UI names (data-testid,
// data-icon, role) are kept verbatim.
(async () => {
  const cp = typeof copy === 'function' ? copy : null; // DevTools helper, gone after the first await
  const main = document.querySelector('#main');
  if (!main) return console.log('Open a chat first.');
  const mask = (s) => String(s || '').replace(/\p{L}+/gu, 'a').replace(/\d/g, '9');
  // UI names stay readable, but anything carrying a message id (conv-msg-3A00…) is masked.
  const ui = (v) => String(v || '').replace(/[0-9A-F]{8,}/gi, '<id>').replace(/\d{5,}/g, '<n>');
  const uiNames = (el, sel, attr) => [...new Set([...el.querySelectorAll(sel)].map((e) => ui(e.getAttribute(attr))))].sort();

  const scroller = [...main.querySelectorAll('div')]
    .filter((d) => d.scrollHeight > d.clientHeight + 24 && d.querySelector('[data-id]'))
    .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (!scroller) return console.log('No scrollable message list found.');

  // Tag skeleton without text or attribute values (except UI names), depth-limited.
  const skeleton = (el, depth = 0) => {
    if (depth > 9) return '…';
    const bits = [el.tagName.toLowerCase()];
    for (const a of ['data-testid', 'data-icon', 'role', 'dir']) if (el.hasAttribute(a)) bits.push(`${a}=${ui(el.getAttribute(a))}`);
    for (const a of ['data-id', 'data-pre-plain-text', 'aria-label', 'title', 'src', 'href', 'alt']) if (el.hasAttribute(a)) bits.push(a);
    if (el.classList.contains('selectable-text')) bits.push('.selectable-text');
    if (el.classList.contains('copyable-text')) bits.push('.copyable-text');
    if (/message-(in|out)/.test(el.className)) bits.push('.' + el.className.match(/message-(in|out)/)[0]);
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim()).length;
    if (own) bits.push(`text×${own}`);
    const kids = [...el.children];
    return kids.length ? { [bits.join(' ')]: kids.slice(0, 12).map((k) => skeleton(k, depth + 1)) } : bits.join(' ');
  };

  const box = () => scroller.getBoundingClientRect();
  const describe = (row) => {
    const n = row.querySelector('[data-id]');
    const b = box();
    const r = row.getBoundingClientRect();
    const bubble = row.querySelector('[data-testid="msg-container"]') || n || row;
    const br = bubble.getBoundingClientRect();
    const left = br.left - b.left, right = b.right - br.right;
    const pre = row.querySelector('[data-pre-plain-text]');
    const text = row.innerText || '';
    const imgs = [...row.querySelectorAll('img')];
    return {
      hasId: Boolean(n),
      idShape: n ? mask(n.getAttribute('data-id')).replace(/a9|9a/g, 'x').slice(0, 24) : '',
      nestedIds: row.querySelectorAll('[data-id]').length,
      pre: pre ? mask(pre.getAttribute('data-pre-plain-text')).replace(/\] .*:/, '] A:') : '',
      selectable: row.querySelectorAll('.selectable-text').length,
      copyable: row.querySelectorAll('.copyable-text').length,
      imgsBig: imgs.filter((i) => (i.naturalWidth || i.width) >= 48 && !i.closest('.selectable-text')).length,
      imgsSmall: imgs.filter((i) => (i.naturalWidth || i.width) < 48).length,
      imgSrc: [...new Set(imgs.map((i) => (i.getAttribute('src') || '').split(':')[0]))].sort(),
      video: row.querySelectorAll('video').length,
      audio: row.querySelectorAll('audio').length,
      testids: uiNames(row, '[data-testid]', 'data-testid'),
      icons: uiNames(row, '[data-icon]', 'data-icon'),
      ariaLabels: row.querySelectorAll('[aria-label]').length,
      plusN: /(^|\s)\+\d+(\s|$)/.test(text),
      deletedText: /this message was deleted|you deleted this message/i.test(text),
      textLen: text.trim().length === 0 ? '0' : text.trim().length < 40 ? '<40' : '40+',
      side: !br.width ? '?' : Math.abs(left - right) < 24 ? 'centre' : right < left ? 'right' : 'left',
      onScreen: r.bottom >= b.top && r.top <= b.bottom,
      height: Math.round(r.height),
    };
  };
  const signature = (d) =>
    [d.hasId ? 'id' : 'no-id', d.pre ? 'pre' : 'no-pre', `sel${d.selectable}`, `img${d.imgsBig}`,
      d.video ? 'video' : '', d.audio ? 'audio' : '', d.plusN ? '+N' : '', d.deletedText ? 'deleted' : '',
      d.side, d.textLen === '0' ? 'blank' : 'text', d.testids.filter((t) => !/^(msg-meta|msg-container|addon-bubble-container)$/.test(t)).join(',')]
      .filter(Boolean).join(' ');

  const startTop = scroller.scrollTop;
  const seen = new Map(); // row index key -> latest description (on-screen wins)
  const samples = {};
  const placeholders = { offScreenBlank: 0, offScreenFilled: 0, onScreenBlank: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let steps = 0;

  const sweep = () => {
    const rows = [...main.querySelectorAll('div[role="row"]')];
    rows.forEach((row) => {
      const d = describe(row);
      const n = row.querySelector('[data-id]');
      const key = n ? 'id:' + n.getAttribute('data-id') : 'row:' + d.textLen + d.height + rows.indexOf(row);
      if (d.onScreen) { if (d.textLen === '0' && d.hasId) placeholders.onScreenBlank++; }
      else if (d.hasId) placeholders[d.textLen === '0' && !d.imgsBig ? 'offScreenBlank' : 'offScreenFilled']++;
      const prev = seen.get(key);
      if (!prev || d.onScreen) seen.set(key, d);
      const sig = signature(d);
      if (d.onScreen && (!samples[sig] || samples[sig].length < 2)) {
        (samples[sig] = samples[sig] || []).push(skeleton(row));
      }
    });
  };

  scroller.scrollTop = 0;
  await sleep(1500);
  while (steps < 400) {
    sweep();
    steps++;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + scroller.clientHeight * 0.8;
    await sleep(700);
    if (scroller.scrollTop === before) { sweep(); break; }
  }
  scroller.scrollTop = startTop;

  const counts = {};
  for (const d of seen.values()) { const s = signature(d); counts[s] = (counts[s] || 0) + 1; }
  const report = {
    probe: 'wa-structure-v1',
    userAgent: navigator.userAgent,
    language: navigator.language,
    scroller: {
      overflowY: getComputedStyle(scroller).overflowY,
      flexDirection: getComputedStyle(scroller).flexDirection,
      scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, steps,
    },
    header: { title: Boolean(main.querySelector('header [data-testid="conversation-info-header-chat-title"]')), testids: uiNames(main.querySelector('header') || main, '[data-testid]', 'data-testid') },
    rowsSeen: seen.size,
    placeholdersSeenDuringSweep: placeholders,
    preShapes: [...new Set([...seen.values()].map((d) => d.pre).filter(Boolean))].slice(0, 10),
    idShapes: [...new Set([...seen.values()].map((d) => d.idShape).filter(Boolean))].slice(0, 5),
    allTestids: [...new Set([...seen.values()].flatMap((d) => d.testids))].sort(),
    allIcons: [...new Set([...seen.values()].flatMap((d) => d.icons))].sort(),
    signatureCounts: Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1])),
    samples,
  };
  const json = JSON.stringify(report, null, 1);
  const name = `wa-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  try { if (cp) cp(json); } catch (e) { /* the download is enough */ }
  console.log(`Probe done: ${seen.size} rows, ${steps} screens. Saved to Downloads as ${name} (${json.length} chars).`);
})();
