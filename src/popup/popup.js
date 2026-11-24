/**
 * Chat Export — popup UI.
 *
 * Classic script (no ES modules) for Manifest V3 popup pages. The whole shell is
 * built with DOM APIs so the same code powers both the real popup and
 * test/popup-preview.html. Chat names, message counts, filenames and error text
 * are always written with textContent — never innerHTML.
 *
 * Contract: docs/PROTOCOL.md. All constants come from WAEx (src/lib/namespace.js).
 */
(function () {
  'use strict';

  var WAEx = globalThis.WAEx;
  if (!WAEx || !WAEx.MSG) return;

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /** Phases that mean "an export is in flight". */
  var ACTIVE_PHASES = {
    scrolling: true,
    parsing: true,
    media: true,
    building: true,
    saving: true,
    cancelling: true,
  };

  /** Inline SVG sprite: every icon is a local symbol, never a remote image. */
  var ICON_PATHS = {
    logo: [
      'M21 11.6c0 4.2-3.9 7.6-8.7 7.6-1 0-2-.15-2.9-.43L4.6 20.2l1.2-3.7a7.05 7.05 0 0 1-2.1-4.9C3.7 7.4 7.6 4 12.3 4S21 7.4 21 11.6Z',
      'M12.8 7.7v6.1m0 0 2.3-2.4m-2.3 2.4-2.3-2.4',
    ],
    gear: [
      'M12 15.1a3.1 3.1 0 1 0 0-6.2 3.1 3.1 0 0 0 0 6.2Z',
      'M19.3 13.1a7.6 7.6 0 0 0 .1-1.1 7.6 7.6 0 0 0-.1-1.1l1.9-1.5-1.9-3.2-2.3.9a7.4 7.4 0 0 0-1.8-1.1L14.8 3.5h-3.6L10.8 6a7.4 7.4 0 0 0-1.8 1.1l-2.3-.9-1.9 3.2 1.9 1.5a7.6 7.6 0 0 0-.1 1.1 7.6 7.6 0 0 0 .1 1.1L4.8 14.6l1.9 3.2 2.3-.9a7.4 7.4 0 0 0 1.8 1.1l.4 2.5h3.6l.4-2.5a7.4 7.4 0 0 0 1.8-1.1l2.3.9 1.9-3.2-1.9-1.5Z',
    ],
    refresh: ['M20 11.1a8 8 0 1 0-1.9 5.2', 'M20 5.3V11h-5.7'],
    check: ['M5 12.6l4.4 4.4L19 7.4'],
    alert: [
      'M10.4 5.1 2.9 18.2a1.9 1.9 0 0 0 1.6 2.8h15a1.9 1.9 0 0 0 1.6-2.8L13.6 5.1a1.9 1.9 0 0 0-3.2 0Z',
      'M12 9.4v4.2',
      'M12 16.7h.01',
    ],
    close: ['M6 6l12 12', 'M18 6 6 18'],
    download: ['M12 3.5v10.6', 'M7.9 10.2 12 14.3l4.1-4.1', 'M5 20.2h14'],
    message: [
      'M20.5 11.3c0 4.1-3.8 7.4-8.5 7.4-1 0-2-.2-2.9-.5L4.5 19.5l1.4-3.9a6.9 6.9 0 0 1-1.9-4.3c0-4.1 3.8-7.4 8.5-7.4s8 3.3 8 7.4Z',
      'M8.5 11.2h.01',
      'M12 11.2h.01',
      'M15.5 11.2h.01',
    ],
    file: ['M6.5 3.5h7l4.5 4.5v12.5h-11.5v-17Z', 'M13.5 3.5v4.5h4.5'],
    chevron: ['M7.5 10l4.5 4.5 4.5-4.5'],
    info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 10.6v5.2', 'M12 7.8h.01'],
    external: [
      'M14 4.2h5.8V10',
      'M19.8 4.2 11.2 12.8',
      'M17.3 13.4v5.4a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 18.8V8.1a1.8 1.8 0 0 1 1.8-1.8h5.4',
    ],
    copy: [
      'M9 8.5V5.2A1.7 1.7 0 0 1 10.7 3.5h8.1a1.7 1.7 0 0 1 1.7 1.7v8.1a1.7 1.7 0 0 1-1.7 1.7h-3.3',
      'M5.2 9h8.1a1.7 1.7 0 0 1 1.7 1.7v8.1a1.7 1.7 0 0 1-1.7 1.7H5.2a1.7 1.7 0 0 1-1.7-1.7v-8.1A1.7 1.7 0 0 1 5.2 9Z',
    ],
    shield: ['M12 3.2 19 6v5.2c0 4.4-3 8.1-7 9.6-4-1.5-7-5.2-7-9.6V6l7-2.8Z', 'M9.2 11.9l2 2 3.6-3.9'],
  };

  /** Deterministic, reasonably contrast-safe avatar colours. */
  var AVATAR_TONES = 8;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  var state = {
    view: 'loading', // loading | no-tab | not-ready | no-chat | ready | exporting | done | error
    tab: null,
    tabId: null,
    version: '',
    chat: null,
    exportState: null,
    settings: null,
    history: [],
    dateError: '',
    notice: '',
    refreshing: false,
    reloading: false,
    cancelRequested: false,
    optionsCollapsed: false,
    connectionError: '',
    diagnostics: {
      open: false,
      loading: false,
      report: null,
      error: '',
      copied: false,
    },
    controls: {},
  };

  /** Cached DOM references (the shell is built once). */
  var dom = {};
  var messageListenerBound = false;

  // ---------------------------------------------------------------------------
  // Small DOM helpers (textContent only for user data)
  // ---------------------------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined) return;
        if (key === 'text') {
          node.textContent = String(value);
        } else if (key === 'className') {
          node.className = value;
        } else if (key === 'htmlFor') {
          node.setAttribute('for', value);
        } else if (key === 'dataset') {
          Object.keys(value).forEach(function (dataKey) {
            node.dataset[dataKey] = value[dataKey];
          });
        } else if (key === 'on') {
          Object.keys(value).forEach(function (eventName) {
            node.addEventListener(eventName, value[eventName]);
          });
        } else if (typeof value === 'boolean') {
          node.setAttribute(key, '');
          if (key in node) node[key] = value;
        } else {
          node.setAttribute(key, String(value));
        }
      });
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    if (children === null || children === undefined) return;
    var list = Array.isArray(children) ? children : [children];
    list.forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
  }

  function icon(name, className) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon' + (className ? ' ' + className : ''));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#icon-' + name);
    svg.appendChild(use);
    return svg;
  }

  function buildIconSprite() {
    var sprite = document.createElementNS(SVG_NS, 'svg');
    sprite.setAttribute('class', 'svg-sprite');
    sprite.setAttribute('aria-hidden', 'true');
    sprite.setAttribute('focusable', 'false');
    sprite.setAttribute('width', '0');
    sprite.setAttribute('height', '0');
    Object.keys(ICON_PATHS).forEach(function (name) {
      var symbol = document.createElementNS(SVG_NS, 'symbol');
      symbol.setAttribute('id', 'icon-' + name);
      symbol.setAttribute('viewBox', '0 0 24 24');
      ICON_PATHS[name].forEach(function (d) {
        var path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        symbol.appendChild(path);
      });
      sprite.appendChild(symbol);
    });
    document.body.appendChild(sprite);
  }

  function setHidden(node, hidden) {
    if (!node) return;
    if (hidden) node.setAttribute('hidden', '');
    else node.removeAttribute('hidden');
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function fmtNum(value) {
    var n = Number(value) || 0;
    try {
      return n.toLocaleString();
    } catch (err) {
      return String(n);
    }
  }

  function formatBytes(value) {
    if (typeof WAEx.formatBytes === 'function') return WAEx.formatBytes(value);
    return fmtNum(value) + ' B';
  }

  function relativeTime(timestamp) {
    if (WAEx.datetime && typeof WAEx.datetime.relativeTime === 'function') {
      return WAEx.datetime.relativeTime(timestamp);
    }
    var diff = Math.max(0, Date.now() - timestamp);
    if (diff < 45000) return 'just now';
    var minutes = Math.round(diff / 60000);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.round(hours / 24) + 'd ago';
  }

  /** Compact date used on the chat card, e.g. "Jan 3 – Nov 12, 2025". */
  function formatShortDate(ms, includeYear) {
    var date = new Date(ms);
    if (isNaN(date.getTime())) return '';
    var options = { month: 'short', day: 'numeric' };
    if (includeYear) options.year = 'numeric';
    try {
      return date.toLocaleDateString(undefined, options);
    } catch (err) {
      return date.toDateString();
    }
  }

  function formatChatRange(range) {
    if (!range || !range.start || !range.end) return '';
    if (range.start > range.end) return formatShortDate(range.start, true);
    var nowYear = new Date().getFullYear();
    var startYear = new Date(range.start).getFullYear();
    var endYear = new Date(range.end).getFullYear();
    var includeYear = startYear !== endYear || endYear !== nowYear;
    var start = formatShortDate(range.start, includeYear);
    var end = formatShortDate(range.end, includeYear);
    return start === end ? start : start + ' – ' + end;
  }

  function pluralMessages(count) {
    return (Number(count) || 0) === 1 ? 'message' : 'messages';
  }

  function deriveInitials(name) {
    var text = String(name || '').trim();
    if (!text) return '?';
    var words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function avatarTone(name) {
    var text = String(name || '');
    var hash = 0;
    for (var i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash % AVATAR_TONES;
  }

  // ---------------------------------------------------------------------------
  // Chrome API helpers
  // ---------------------------------------------------------------------------

  function getActiveTab() {
    return new Promise(function (resolve, reject) {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'Could not read the active tab.'));
            return;
          }
          resolve((tabs && tabs[0]) || null);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function sendToContent(tabId, message, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (tabId === null || tabId === undefined) {
        reject(new Error('No WhatsApp Web tab is available.'));
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('WhatsApp Web is not responding.'));
      }, timeoutMs || 10000);

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      }

      try {
        chrome.tabs.sendMessage(tabId, message, function (reply) {
          if (chrome.runtime.lastError) {
            finish(reject, new Error(chrome.runtime.lastError.message || 'Could not reach WhatsApp Web.'));
            return;
          }
          finish(resolve, reply);
        });
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  function injectContentFiles(tabId) {
    return new Promise(function (resolve, reject) {
      if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
        reject(new Error('The scripting permission is unavailable.'));
        return;
      }
      function injectIsolated() {
        chrome.scripting.executeScript(
          { target: { tabId: tabId }, files: WAEx.CONTENT_FILES },
          function () {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || 'Could not connect to WhatsApp Web.'));
              return;
            }
            resolve();
          }
        );
      }
      try {
        // The page bridge first, in WhatsApp's own world. Best effort: without it the
        // export falls back to reading the screen.
        chrome.scripting.executeScript(
          { target: { tabId: tabId }, files: WAEx.PAGE_FILES || [], world: 'MAIN' },
          function () {
            void chrome.runtime.lastError;
            try {
              injectIsolated();
            } catch (err) {
              reject(err);
            }
          }
        );
      } catch (err) {
        try {
          injectIsolated();
        } catch (inner) {
          reject(inner);
        }
      }
    });
  }

  function isPingReply(reply) {
    return !!reply && typeof reply === 'object' && reply.ok !== false && (reply.chat !== undefined || reply.state !== undefined || reply.ok === true);
  }

  /** Try PING, inject the content scripts if needed, then retry PING once. */
  async function ensureContentScript(tabId) {
    var reply = null;
    try {
      reply = await sendToContent(tabId, { type: WAEx.MSG.PING });
    } catch (err) {
      reply = null;
    }
    if (isPingReply(reply)) return reply;

    await injectContentFiles(tabId);
    reply = await sendToContent(tabId, { type: WAEx.MSG.PING });
    if (!isPingReply(reply)) {
      throw new Error('WhatsApp Web did not respond after the extension reconnected.');
    }
    return reply;
  }

  function isWhatsAppUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      var parsed = new URL(url);
      return parsed.hostname === 'web.whatsapp.com' || /\.web\.whatsapp\.com$/.test(parsed.hostname);
    } catch (err) {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  function loadSettings() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([WAEx.STORAGE_KEY], function (result) {
          var raw = result && result[WAEx.STORAGE_KEY];
          resolve(WAEx.normalizeSettings(raw));
        });
      } catch (err) {
        resolve(WAEx.normalizeSettings({}));
      }
    });
  }

  function saveSettings(settings) {
    return new Promise(function (resolve) {
      try {
        var payload = {};
        payload[WAEx.STORAGE_KEY] = settings;
        chrome.storage.local.set(payload, function () {
          resolve();
        });
      } catch (err) {
        resolve();
      }
    });
  }

  function normalizeHistory(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(function (entry) {
        return entry && typeof entry.filename === 'string' && entry.filename;
      })
      .map(function (entry) {
        return {
          filename: entry.filename,
          messageCount: Number(entry.messageCount) || 0,
          bytes: Number(entry.bytes) || 0,
          format: typeof entry.format === 'string' ? entry.format : '',
          mediaMode: typeof entry.mediaMode === 'string' ? entry.mediaMode : '',
          at: Number(entry.at) || 0,
        };
      })
      .sort(function (a, b) {
        return b.at - a.at;
      });
  }

  function loadHistory() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([WAEx.HISTORY_KEY], function (result) {
          resolve(normalizeHistory(result && result[WAEx.HISTORY_KEY]));
        });
      } catch (err) {
        resolve([]);
      }
    });
  }

  function rememberHistory(resultMessage) {
    var entry = resultMessage && resultMessage.historyEntry;
    if (!entry || typeof entry !== 'object') {
      entry = {
        filename: resultMessage && resultMessage.filename,
        messageCount: resultMessage && resultMessage.messageCount,
        bytes: resultMessage && resultMessage.bytes,
        format: state.settings ? state.settings.format : '',
        at: Date.now(),
      };
    }
    if (!entry.filename) return;
    var normalized = normalizeHistory([entry])[0];
    if (!normalized) return;
    state.history = [normalized]
      .concat(
        state.history.filter(function (item) {
          return !(item.filename === normalized.filename && item.at === normalized.at);
        })
      )
      .slice(0, WAEx.HISTORY_LIMIT || 5);
  }

  // ---------------------------------------------------------------------------
  // Shell
  // ---------------------------------------------------------------------------

  function buildShell() {
    buildIconSprite();

    var root = document.getElementById('app');
    if (!root) {
      root = el('div', { id: 'app' });
      document.body.appendChild(root);
    }
    clear(root);

    dom.gearButton = el(
      'button',
      {
        type: 'button',
        className: 'icon-btn header-icon-btn',
        id: 'gear-btn',
        'aria-label': 'Open diagnostics',
        title: 'Diagnostics',
      },
      icon('gear')
    );
    dom.gearButton.addEventListener('click', openDiagnostics);

    var header = el('header', { className: 'app-header' }, [
      el('div', { className: 'brand' }, [
        el('div', { className: 'logo', 'aria-hidden': 'true' }, icon('logo')),
        el('div', { className: 'brand-text' }, [
          el('h1', { text: 'Chat Export' }),
          el('p', { text: 'WhatsApp Web' }),
        ]),
      ]),
      dom.gearButton,
    ]);

    dom.stateHost = el('div', { id: 'state-host' });
    dom.chatCard = el('section', { className: 'chat-card', id: 'chat-card' });
    dom.noticeHost = el('div', { id: 'notice-host' });
    dom.formatSection = el('section', { className: 'section', id: 'format-section' });
    dom.optionsSection = el('section', { className: 'section', id: 'options-section' });
    dom.actionArea = el('div', { className: 'action-area', id: 'action-area' });
    dom.historySection = el('section', { className: 'section', id: 'history-section' });

    var main = el('main', { className: 'app-main' }, [
      dom.stateHost,
      dom.chatCard,
      dom.noticeHost,
      dom.formatSection,
      dom.optionsSection,
      dom.actionArea,
      dom.historySection,
    ]);

    dom.footerDiagButton = el('button', {
      type: 'button',
      className: 'link-btn',
      id: 'footer-diag',
      text: 'Diagnostics',
    });
    dom.footerDiagButton.addEventListener('click', openDiagnostics);

    var footer = el('footer', { className: 'app-footer' }, [
      el('p', { className: 'privacy-line' }, [
        icon('shield'),
        el('span', { text: 'Files are created on your device. Nothing is uploaded.' }),
      ]),
      el('div', { className: 'footer-row' }, [
        el('span', { className: 'privacy-sub', text: 'Nothing uploaded · No analytics' }),
        dom.footerDiagButton,
      ]),
    ]);

    root.appendChild(header);
    root.appendChild(main);
    root.appendChild(footer);
    buildDiagnosticsModal(root);

    buildFormatSection();
    buildOptionsSection();

    // Avoid a flash of uncontrolled options while storage/PING resolve.
    setHidden(dom.chatCard, true);
    setHidden(dom.formatSection, true);
    setHidden(dom.optionsSection, true);
    setHidden(dom.actionArea, true);
    setHidden(dom.historySection, true);
    setHidden(dom.noticeHost, true);
  }

  function buildDiagnosticsModal(root) {
    dom.diagCloseButton = el(
      'button',
      {
        type: 'button',
        className: 'icon-btn modal-close',
        'aria-label': 'Close diagnostics',
      },
      icon('close')
    );
    dom.diagCloseButton.addEventListener('click', closeDiagnostics);

    dom.diagBody = el('div', { className: 'modal-body', id: 'diag-body' });

    dom.diagCopyButton = el(
      'button',
      { type: 'button', className: 'btn btn-secondary btn-small', id: 'diag-copy', disabled: true },
      [icon('copy'), el('span', { text: 'Copy report' })]
    );
    dom.diagCopyButton.addEventListener('click', copyDiagnosticsReport);

    dom.diagCopyStatus = el('span', {
      className: 'copy-status',
      role: 'status',
      'aria-live': 'polite',
    });

    var modal = el(
      'div',
      {
        className: 'modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'diag-title',
      },
      [
        el('div', { className: 'modal-head' }, [
          el('h2', { id: 'diag-title', text: 'Diagnostics' }),
          dom.diagCloseButton,
        ]),
        dom.diagBody,
        el('div', { className: 'modal-foot' }, [dom.diagCopyButton, dom.diagCopyStatus]),
      ]
    );

    dom.diagOverlay = el('div', { className: 'modal-overlay', id: 'diagnostics-modal', hidden: true }, modal);
    dom.diagOverlay.addEventListener('click', function (event) {
      if (event.target === dom.diagOverlay) closeDiagnostics();
    });
    dom.diagModal = modal;
    root.appendChild(dom.diagOverlay);

    document.addEventListener('keydown', function (event) {
      if (!state.diagnostics.open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDiagnostics();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Format picker
  // ---------------------------------------------------------------------------

  function buildFormatSection() {
    var fieldset = el('fieldset', { className: 'segmented' });
    fieldset.appendChild(el('legend', { className: 'sr-only', text: 'Export format' }));

    state.controls.format = {};
    WAEx.FORMATS.forEach(function (format) {
      var input = el('input', {
        type: 'radio',
        name: 'wax-format',
        id: 'fmt-' + format.id,
        value: format.id,
      });
      input.addEventListener('change', function () {
        if (input.checked) setSetting('format', format.id);
      });
      var label = el('label', { className: 'seg-item', htmlFor: 'fmt-' + format.id }, [
        input,
        el('span', { text: format.label }),
      ]);
      fieldset.appendChild(label);
      state.controls.format[format.id] = input;
    });

    state.controls.formatBlurb = el('p', { className: 'blurb', id: 'format-blurb' });

    dom.formatSection.appendChild(el('h2', { className: 'section-title', text: 'Format' }));
    dom.formatSection.appendChild(fieldset);
    dom.formatSection.appendChild(state.controls.formatBlurb);
  }

  // ---------------------------------------------------------------------------
  // Options
  // ---------------------------------------------------------------------------

  function buildOptionsSection() {
    dom.optionsSection.appendChild(el('h2', { className: 'section-title', text: 'Options' }));

    var card = el('div', { className: 'card options-card' });

    // Date range -------------------------------------------------------------
    state.controls.dateRange = el('select', {
      id: 'date-range',
      className: 'select',
      'aria-label': 'Date range',
    });
    WAEx.DATE_RANGES.forEach(function (range) {
      state.controls.dateRange.appendChild(el('option', { value: range.id, text: range.label }));
    });
    state.controls.dateRange.addEventListener('change', function () {
      setSetting('dateRange', state.controls.dateRange.value);
    });

    card.appendChild(
      el('div', { className: 'option-row' }, [
        el('label', { className: 'option-label', htmlFor: 'date-range', text: 'Date range' }),
        selectWrap(state.controls.dateRange),
      ])
    );
    state.controls.dateRangeHint = el('p', {
      className: 'blurb option-blurb',
      id: 'date-range-hint',
    });
    card.appendChild(state.controls.dateRangeHint);

    state.controls.customStart = el('input', {
      type: 'date',
      id: 'custom-start',
      className: 'date-input',
      'aria-label': 'Start date',
    });
    state.controls.customEnd = el('input', {
      type: 'date',
      id: 'custom-end',
      className: 'date-input',
      'aria-label': 'End date',
    });

    state.controls.customWrap = el('div', { className: 'custom-dates', id: 'custom-dates' }, [
      el('div', { className: 'date-field' }, [
        el('label', { className: 'date-label', htmlFor: 'custom-start', text: 'From' }),
        state.controls.customStart,
      ]),
      el('div', { className: 'date-field' }, [
        el('label', { className: 'date-label', htmlFor: 'custom-end', text: 'To' }),
        state.controls.customEnd,
      ]),
    ]);

    state.controls.dateError = el('p', {
      className: 'field-error',
      id: 'date-error',
      role: 'alert',
      hidden: true,
    });
    state.controls.customStart.setAttribute('aria-describedby', 'date-error');
    state.controls.customEnd.setAttribute('aria-describedby', 'date-error');

    [state.controls.customStart, state.controls.customEnd].forEach(function (input) {
      input.addEventListener('input', function () {
        state.settings.customStart = state.controls.customStart.value;
        state.settings.customEnd = state.controls.customEnd.value;
        validateCustomDates();
        renderActionArea();
      });
      input.addEventListener('change', function () {
        state.settings.customStart = state.controls.customStart.value;
        state.settings.customEnd = state.controls.customEnd.value;
        saveSettings(state.settings);
        if (state.view === 'done') {
          returnToReady();
          render();
        }
      });
    });

    card.appendChild(state.controls.customWrap);
    card.appendChild(state.controls.dateError);
    card.appendChild(el('div', { className: 'option-divider' }));

    // Media ------------------------------------------------------------------
    state.controls.media = el('select', {
      id: 'media-mode',
      className: 'select',
      'aria-label': 'Media handling',
    });
    WAEx.MEDIA_MODES.forEach(function (mode) {
      state.controls.media.appendChild(el('option', { value: mode.id, text: mode.label }));
    });
    state.controls.media.addEventListener('change', function () {
      setSetting('mediaMode', state.controls.media.value);
    });

    card.appendChild(
      el('div', { className: 'option-row' }, [
        el('label', { className: 'option-label', htmlFor: 'media-mode', text: 'Media' }),
        selectWrap(state.controls.media),
      ])
    );
    state.controls.mediaBlurb = el('p', { className: 'blurb option-blurb', id: 'media-blurb' });
    card.appendChild(state.controls.mediaBlurb);

    // Size limit only matters when media is downloaded into the archive.
    state.controls.mediaLimit = el('input', {
      type: 'number',
      id: 'media-limit',
      className: 'number-input',
      min: '10',
      max: '2048',
      step: '10',
      inputmode: 'numeric',
      'aria-label': 'Media size limit in megabytes',
    });
    state.controls.mediaLimit.addEventListener('input', onMediaLimitInput);
    state.controls.mediaLimit.addEventListener('change', commitMediaLimit);
    state.controls.mediaLimit.addEventListener('blur', commitMediaLimit);

    state.controls.mediaLimitWrap = el('div', { className: 'media-limit-wrap', id: 'media-limit-wrap' }, [
      el('div', { className: 'option-row' }, [
        el('label', { className: 'option-label', htmlFor: 'media-limit', text: 'Size limit' }),
        el('div', { className: 'number-wrap' }, [
          state.controls.mediaLimit,
          el('span', { className: 'number-suffix', text: 'MB' }),
        ]),
      ]),
      el('p', {
        className: 'blurb option-blurb media-limit-hint',
        text: 'Stop saving media after this much. Larger items are marked as missing.',
      }),
    ]);
    card.appendChild(state.controls.mediaLimitWrap);
    card.appendChild(el('div', { className: 'option-divider' }));

    // Toggles ----------------------------------------------------------------
    var toggleConfig = [
      { key: 'includeSystem', id: 'toggle-system', label: 'Include system messages' },
      { key: 'includeReactions', id: 'toggle-reactions', label: 'Include reactions' },
      { key: 'senderLabels', id: 'toggle-senders', label: 'Show sender names' },
    ];
    state.controls.toggles = {};
    toggleConfig.forEach(function (config) {
      var input = el('input', {
        type: 'checkbox',
        role: 'switch',
        id: config.id,
        className: 'switch',
      });
      input.addEventListener('change', function () {
        setSetting(config.key, input.checked);
      });
      state.controls.toggles[config.key] = input;
      card.appendChild(
        el('div', { className: 'toggle-row' }, [
          el('label', { className: 'toggle-label', htmlFor: config.id, text: config.label }),
          input,
        ])
      );
    });

    dom.optionsSection.appendChild(card);
  }

  function selectWrap(select) {
    return el('div', { className: 'select-wrap' }, [select, icon('chevron', 'select-chevron')]);
  }

  function syncControls() {
    var settings = state.settings || WAEx.normalizeSettings({});
    state.settings = settings;

    Object.keys(state.controls.format).forEach(function (id) {
      state.controls.format[id].checked = id === settings.format;
    });
    state.controls.dateRange.value = settings.dateRange;
    state.controls.media.value = settings.mediaMode;
    var mediaLimit = Number(settings.maxMediaMb);
    if (!isFinite(mediaLimit) || mediaLimit < 10) mediaLimit = WAEx.DEFAULT_SETTINGS.maxMediaMb || 250;
    state.settings.maxMediaMb = mediaLimit;
    state.controls.mediaLimit.value = String(mediaLimit);
    state.controls.customStart.value = settings.customStart || '';
    state.controls.customEnd.value = settings.customEnd || '';
    state.controls.toggles.includeSystem.checked = !!settings.includeSystem;
    state.controls.toggles.includeReactions.checked = !!settings.includeReactions;
    state.controls.toggles.senderLabels.checked = !!settings.senderLabels;

    updateBlurbs();
    updateCustomDatesVisibility();
    updateMediaLimitVisibility();
    validateCustomDates();
  }

  function updateBlurbs() {
    var format = WAEx.getFormat(state.settings.format);
    state.controls.formatBlurb.textContent = format.blurb;
    state.controls.mediaBlurb.textContent = getMediaMode().blurb;
    updateDateRangeHint();
  }

  /** Explain how far back the export will scroll for the chosen range. */
  function updateDateRangeHint() {
    if (!state.controls.dateRangeHint) return;
    var range = state.settings.dateRange;
    if (range === 'all') {
      state.controls.dateRangeHint.textContent =
        'Scrolls back through the whole conversation, as far as WhatsApp has it.';
    } else if (range === 'custom') {
      state.controls.dateRangeHint.textContent =
        'Scrolls back until the start date is covered, then stops.';
    } else {
      state.controls.dateRangeHint.textContent =
        'Scrolls back until the whole range is covered, then stops.';
    }
  }

  function getMediaMode() {
    var id = state.settings.mediaMode;
    for (var i = 0; i < WAEx.MEDIA_MODES.length; i++) {
      if (WAEx.MEDIA_MODES[i].id === id) return WAEx.MEDIA_MODES[i];
    }
    return WAEx.MEDIA_MODES[0];
  }

  function clampMediaLimit(value) {
    var n = Number(value);
    if (!isFinite(n)) n = WAEx.DEFAULT_SETTINGS.maxMediaMb || 250;
    return Math.max(10, Math.min(2048, Math.round(n)));
  }

  function onMediaLimitInput() {
    if (!state.controls.mediaLimit) return;
    var raw = state.controls.mediaLimit.value.trim();
    if (raw === '') return;
    var n = Number(raw);
    if (!isFinite(n)) return;
    state.settings.maxMediaMb = clampMediaLimit(n);
    saveSettings(state.settings);
    if (state.view === 'done') returnToReady();
  }

  function commitMediaLimit() {
    if (!state.controls.mediaLimit) return;
    var limit = clampMediaLimit(state.controls.mediaLimit.value);
    state.controls.mediaLimit.value = String(limit);
    state.settings.maxMediaMb = limit;
    saveSettings(state.settings);
    if (state.view === 'done') returnToReady();
  }

  function updateMediaLimitVisibility() {
    var show = state.settings.mediaMode === 'download';
    if (state.controls.mediaLimitWrap) setHidden(state.controls.mediaLimitWrap, !show);
  }

  function updateCustomDatesVisibility() {
    var isCustom = state.settings.dateRange === 'custom';
    setHidden(state.controls.customWrap, !isCustom);
    if (!isCustom) {
      state.dateError = '';
      state.controls.dateError.hidden = true;
      state.controls.dateError.textContent = '';
      state.controls.customStart.classList.remove('invalid');
      state.controls.customEnd.classList.remove('invalid');
      state.controls.customStart.removeAttribute('aria-invalid');
      state.controls.customEnd.removeAttribute('aria-invalid');
    }
  }

  function validateCustomDates() {
    var settings = state.settings;
    state.dateError = '';
    if (settings.dateRange === 'custom' && settings.customStart && settings.customEnd && settings.customStart > settings.customEnd) {
      state.dateError = 'Start date must be on or before the end date.';
    }
    var errorNode = state.controls.dateError;
    errorNode.textContent = state.dateError;
    errorNode.hidden = !state.dateError;
    [state.controls.customStart, state.controls.customEnd].forEach(function (input) {
      input.classList.toggle('invalid', !!state.dateError);
      if (state.dateError) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    });
    return !state.dateError;
  }

  function setSetting(key, value) {
    var patch = {};
    patch[key] = value;
    state.settings = WAEx.normalizeSettings(Object.assign({}, state.settings, patch));
    saveSettings(state.settings);
    if (key === 'dateRange') updateCustomDatesVisibility();
    updateMediaLimitVisibility();
    updateBlurbs();
    validateCustomDates();
    if (state.view === 'done') returnToReady();
    render();
  }

  function returnToReady() {
    state.view = state.chat && state.chat.found ? 'ready' : 'no-chat';
    state.optionsCollapsed = false;
  }

  // ---------------------------------------------------------------------------
  // Render — every function is idempotent and safe to call repeatedly
  // ---------------------------------------------------------------------------

  function render() {
    renderStateHost();
    renderChatCard();
    renderNotice();

    var view = state.view;
    var showChat = view === 'ready' || view === 'exporting' || view === 'done' || view === 'error' || view === 'no-chat';
    var showOptions =
      view === 'ready' || ((view === 'done' || view === 'error') && !state.optionsCollapsed);

    setHidden(dom.chatCard, !showChat);
    setHidden(dom.formatSection, !showOptions);
    setHidden(dom.optionsSection, !showOptions);
    setHidden(dom.actionArea, !showChat);
    updateControlsLock();
    renderActionArea();
    renderHistory();
  }

  function renderStateHost() {
    clear(dom.stateHost);
    var view = state.view;

    if (view !== 'loading' && view !== 'no-tab' && view !== 'not-ready') {
      setHidden(dom.stateHost, true);
      return;
    }
    setHidden(dom.stateHost, false);

    if (view === 'loading') {
      dom.stateHost.appendChild(
        el('div', { className: 'empty-card card' }, [
          el('div', { className: 'empty-icon' }, el('span', { className: 'spinner' })),
          el('p', { className: 'empty-title', text: 'Connecting to WhatsApp Web…' }),
          el('p', { className: 'empty-text', text: 'Checking the current tab. This only takes a moment.' }),
        ])
      );
      return;
    }

    if (view === 'no-tab') {
      var openButton = el('button', { type: 'button', className: 'btn btn-primary' }, [
        icon('external'),
        el('span', { text: 'Open WhatsApp Web' }),
      ]);
      openButton.addEventListener('click', openWhatsAppWeb);
      dom.stateHost.appendChild(
        el('div', { className: 'empty-card card' }, [
          el('div', { className: 'empty-icon' }, icon('message')),
          el('p', { className: 'empty-title', text: "You're not on WhatsApp Web" }),
          el('p', {
            className: 'empty-text',
            text: 'Open WhatsApp Web in a tab, then reopen this popup to export a chat.',
          }),
          openButton,
        ])
      );
      return;
    }

    // not-ready
    var reloadButton = el('button', { type: 'button', className: 'btn btn-primary' }, [
      icon('refresh'),
      el('span', { text: state.reloading ? 'Reloading…' : 'Reload tab' }),
    ]);
    reloadButton.disabled = state.reloading;
    reloadButton.addEventListener('click', reloadWhatsAppTab);
    dom.stateHost.appendChild(
      el('div', { className: 'empty-card card' }, [
        el('div', { className: 'empty-icon empty-icon-alert' }, icon('alert')),
        el('p', { className: 'empty-title', text: "Can't reach WhatsApp Web" }),
        el('p', {
          className: 'empty-text',
          text: state.reloading
            ? 'The tab is reloading. This popup will reconnect when WhatsApp Web is ready.'
            : 'The extension needs to reconnect to the WhatsApp tab. Reloading usually fixes this.',
        }),
        reloadButton,
        state.connectionError ? el('p', { className: 'empty-fineprint', text: state.connectionError }) : null,
      ])
    );
  }

  /** How long the card says "Updated" after a refresh. */
  var REFRESHED_NOTE_MS = 3000;

  function renderChatCard() {
    clear(dom.chatCard);
    var chat = state.chat;

    if (!chat || !chat.found) {
      dom.chatCard.className = 'chat-card card';
      dom.chatCard.appendChild(
        el('div', { className: 'chat-avatar chat-avatar-empty', 'aria-hidden': 'true' }, icon('message'))
      );
      dom.chatCard.appendChild(
        el('div', { className: 'chat-body' }, [
          el('p', { className: 'chat-empty-title', text: 'Open a chat in WhatsApp Web to get started' }),
          el('p', {
            className: 'chat-empty-hint',
            // The page says why it found no chat; show it, so "I am in the chat" can be diagnosed.
            text:
              (chat && chat.reason ? chat.reason : 'Click any conversation, then reopen this popup.') +
              (justRefreshed() ? ' (Checked again just now.)' : ''),
          }),
        ])
      );
      dom.chatCard.appendChild(buildRefreshButton());
      return;
    }

    var name = chat.name || 'Unnamed chat';
    var initials = (chat.initials || deriveInitials(name)).slice(0, 2).toUpperCase();
    var avatar = el('div', {
      className: 'chat-avatar tone-' + avatarTone(name),
      text: initials,
      'aria-hidden': 'true',
    });

    var titleRow = el('div', { className: 'chat-title-row' }, [
      el('span', { className: 'chat-name', title: name, text: name }),
      el('span', { className: 'badge', text: chat.isGroup ? 'Group' : 'Direct' }),
    ]);
    var metaText = chatMetaText(chat) + (justRefreshed() ? ' · Updated' : '');
    dom.chatCard.appendChild(avatar);
    dom.chatCard.appendChild(
      el('div', { className: 'chat-body' }, [
        titleRow,
        el('p', { className: 'chat-meta', title: metaText, text: metaText, 'aria-live': 'polite' }),
      ])
    );
    dom.chatCard.appendChild(buildRefreshButton());
  }

  /** A refresh finished in the last few seconds: say so, or the button looks inert. */
  function justRefreshed() {
    return Boolean(state.refreshedAt && Date.now() - state.refreshedAt < REFRESHED_NOTE_MS);
  }

  function chatMetaText(chat) {
    var count = Number(chat.renderedCount) || 0;
    var range = formatChatRange(chat.dateRange);
    if (!count) return 'No messages loaded yet';
    // fullHistory: WhatsApp reports nothing earlier to load, so this is the whole chat.
    var parts = [
      chat.fullHistory
        ? 'All ' + fmtNum(count) + ' ' + pluralMessages(count)
        : fmtNum(count) + ' ' + pluralMessages(count) + ' loaded',
    ];
    if (range) parts.push(range);
    return parts.join(' · ');
  }

  function buildRefreshButton() {
    var button = el(
      'button',
      {
        type: 'button',
        className: 'chat-refresh' + (state.refreshing ? ' spinning' : ''),
        title: 'Refresh chat info',
        'aria-label': 'Refresh chat info',
      },
      icon('refresh')
    );
    button.disabled = state.refreshing || state.view === 'exporting' || state.view === 'loading';
    button.addEventListener('click', refreshChat);
    return button;
  }

  function renderNotice() {
    clear(dom.noticeHost);
    if (!state.notice) {
      setHidden(dom.noticeHost, true);
      return;
    }
    setHidden(dom.noticeHost, false);
    dom.noticeHost.appendChild(
      el('div', { className: 'notice', role: 'status' }, [icon('info'), el('span', { text: state.notice })])
    );
  }

  function updateControlsLock() {
    var locked = state.view === 'exporting';
    var controls = [
      state.controls.dateRange,
      state.controls.media,
      state.controls.mediaLimit,
      state.controls.customStart,
      state.controls.customEnd,
    ];
    Object.keys(state.controls.format).forEach(function (id) {
      controls.push(state.controls.format[id]);
    });
    Object.keys(state.controls.toggles).forEach(function (key) {
      controls.push(state.controls.toggles[key]);
    });
    controls.forEach(function (control) {
      if (!control) return;
      control.disabled = locked;
    });
    dom.formatSection.classList.toggle('is-locked', locked);
    dom.optionsSection.classList.toggle('is-locked', locked);
  }

  function renderActionArea() {
    clear(dom.actionArea);
    var view = state.view;

    if (view === 'ready') {
      dom.actionArea.appendChild(buildExportButton(false));
      return;
    }

    if (view === 'no-chat') {
      dom.actionArea.appendChild(buildExportButton(true));
      dom.actionArea.appendChild(
        el('p', { className: 'hint', text: 'Open a conversation in WhatsApp Web to enable export.' })
      );
      return;
    }

    if (view === 'exporting') {
      dom.actionArea.appendChild(buildProgressPanel());
      return;
    }

    if (view === 'done') {
      dom.actionArea.appendChild(buildDonePanel());
      return;
    }

    if (view === 'error') {
      dom.actionArea.appendChild(buildErrorPanel());
    }
  }

  function buildExportButton(forceDisabled) {
    var button = el('button', { type: 'button', className: 'btn btn-primary', id: 'export-btn' }, [
      icon('download'),
      el('span', { text: 'Export chat' }),
    ]);
    button.disabled = !!forceDisabled || !!state.dateError || !(state.chat && state.chat.found);
    button.addEventListener('click', startExport);
    return button;
  }

  function buildProgressPanel() {
    var exportState = state.exportState || {};
    var percent = typeof exportState.percent === 'number' && isFinite(exportState.percent) ? clampPercent(exportState.percent) : null;

    var title = el('h2', { className: 'progress-title', id: 'progress-title', text: progressLabel(exportState) });
    var detail = el('p', {
      className: 'progress-sub',
      id: 'progress-sub',
      title: exportState.detail ? String(exportState.detail) : '',
      text: exportState.detail ? String(exportState.detail) : 'Preparing your export…',
    });
    var percentNode = el('span', {
      className: 'progress-pct',
      id: 'progress-pct',
      text: percent === null ? '' : percent + '%',
    });
    if (percent === null) percentNode.hidden = true;

    var track = el('div', {
      className: 'progress-track' + (percent === null ? ' indeterminate' : ''),
      id: 'progress-track',
      role: 'progressbar',
      'aria-label': 'Export progress',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': percent === null ? null : String(percent),
    });
    var fill = el('div', { className: 'progress-fill', id: 'progress-fill' });
    if (percent !== null) fill.style.width = percent + '%';
    track.appendChild(fill);

    var cancelButton = el('button', {
      type: 'button',
      className: 'link-btn cancel-btn',
      id: 'progress-cancel',
      text: state.cancelRequested ? 'Cancelling…' : 'Cancel',
    });
    cancelButton.disabled = !!state.cancelRequested;
    cancelButton.addEventListener('click', cancelExport);

    var panel = el('section', { className: 'panel progress-panel', 'aria-busy': 'true' }, [
      el('div', { className: 'progress-head' }, [
        el('span', { className: 'spinner', 'aria-hidden': 'true' }),
        el('div', { className: 'progress-titles' }, [title, detail]),
        percentNode,
      ]),
      track,
      el('div', { className: 'progress-foot' }, [
        el('span', { className: 'progress-note', text: 'Keep this tab open. You can close this popup.' }),
        cancelButton,
      ]),
    ]);

    dom.progress = {
      title: title,
      detail: detail,
      percent: percentNode,
      track: track,
      fill: fill,
      cancel: cancelButton,
    };
    return panel;
  }

  function updateProgressView() {
    if (!dom.progress) return;
    var exportState = state.exportState || {};
    var percent =
      typeof exportState.percent === 'number' && isFinite(exportState.percent) ? clampPercent(exportState.percent) : null;

    dom.progress.title.textContent = progressLabel(exportState);
    var detailText = exportState.detail ? String(exportState.detail) : 'Preparing your export…';
    dom.progress.detail.textContent = detailText;
    dom.progress.detail.title = exportState.detail ? String(exportState.detail) : '';

    if (percent === null) {
      dom.progress.percent.hidden = true;
      dom.progress.percent.textContent = '';
      dom.progress.track.classList.add('indeterminate');
      dom.progress.track.removeAttribute('aria-valuenow');
      dom.progress.fill.style.width = '';
    } else {
      dom.progress.percent.hidden = false;
      dom.progress.percent.textContent = percent + '%';
      dom.progress.track.classList.remove('indeterminate');
      dom.progress.track.setAttribute('aria-valuenow', String(percent));
      dom.progress.fill.style.width = percent + '%';
    }

    var cancelText = state.cancelRequested ? 'Cancelling…' : 'Cancel';
    dom.progress.cancel.textContent = cancelText;
    dom.progress.cancel.disabled = !!state.cancelRequested;
  }

  function clampPercent(value) {
    return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  }

  function progressLabel(exportState) {
    var phase = exportState.phase;
    var loaded = Number(exportState.loaded) || 0;
    var total = exportState.total === null || exportState.total === undefined ? null : Number(exportState.total);

    if (phase === 'scrolling') {
      return 'Loading messages…' + (loaded > 0 ? ' ' + fmtNum(loaded) + ' so far' : '');
    }
    if (phase === 'parsing') return 'Reading messages';
    if (phase === 'media') {
      if (total) return 'Saving media ' + fmtNum(loaded) + ' of ' + fmtNum(total);
      return loaded ? 'Saving media ' + fmtNum(loaded) : 'Saving media…';
    }
    if (phase === 'building') return 'Building file';
    if (phase === 'saving') return 'Saving…';
    if (phase === 'cancelling') return 'Cancelling…';
    return 'Working…';
  }

  function buildDonePanel() {
    var exportState = state.exportState || {};
    var filename = exportState.filename || 'Chat export';
    var count = Number(exportState.messageCount) || 0;
    var bytes = Number(exportState.bytes) || 0;
    var warnings = Array.isArray(exportState.warnings) ? exportState.warnings : [];

    var metaParts = [];
    if (count) metaParts.push(fmtNum(count) + ' ' + pluralMessages(count));
    if (bytes) metaParts.push(formatBytes(bytes));

    var children = [
      el('div', { className: 'success-head' }, [
        el('span', { className: 'status-icon status-icon-success', 'aria-hidden': 'true' }, icon('check')),
        el('div', { className: 'success-titles' }, [
          // "Saved", not "complete": whether the whole chat is in the file is shown below.
          el('h2', { className: 'panel-title', text: 'Export saved' }),
          el('p', { className: 'success-file', title: filename, text: filename }),
        ]),
      ]),
    ];
    if (metaParts.length) {
      children.push(el('p', { className: 'success-meta', text: metaParts.join(' · ') }));
    }
    var outcome = exportState.completeness;
    if (outcome && outcome.status) {
      var outcomeLabel = { complete: 'Whole chat', partial: 'Partial', unknown: 'Completeness unknown' }[outcome.status] || 'Completeness unknown';
      children.push(
        el('p', { className: 'success-outcome outcome-' + outcome.status, role: 'status' }, [
          el('b', { text: outcomeLabel + ': ' }),
          el('span', { text: String(outcome.reason || '') }),
        ])
      );
      if (outcome.mediaMissing) {
        children.push(
          el('p', {
            className: 'success-outcome outcome-partial',
            text: fmtNum(outcome.mediaMissing) + ' of ' + fmtNum(outcome.mediaItems) + ' media items could not be saved.',
          })
        );
      }
    }
    if (warnings.length) {
      children.push(
        el('p', { className: 'success-warn' }, [
          icon('alert'),
          el('span', { text: fmtNum(warnings.length) + (warnings.length === 1 ? ' warning' : ' warnings') }),
        ])
      );
      // Spell the warnings out: they say what may be missing from the file and what to do.
      var warningList = el('ul', { className: 'warning-list success-warning-list' });
      warnings.forEach(function (warning) {
        warningList.appendChild(el('li', { text: String(warning) }));
      });
      children.push(warningList);
    }

    var againButton = el('button', { type: 'button', className: 'btn btn-primary' }, [
      icon('download'),
      el('span', { text: 'Export again' }),
    ]);
    againButton.addEventListener('click', startExport);

    var closeButton = el('button', { type: 'button', className: 'btn btn-secondary', text: 'Close' });
    closeButton.addEventListener('click', function () {
      try {
        window.close();
      } catch (err) {
        /* Preview pages and some contexts ignore window.close(). */
      }
    });

    children.push(el('div', { className: 'panel-actions' }, [againButton, closeButton]));

    if (state.optionsCollapsed) {
      var changeButton = el('button', { type: 'button', className: 'link-btn change-options', text: 'Change options' });
      changeButton.addEventListener('click', function () {
        state.optionsCollapsed = false;
        render();
      });
      children.push(changeButton);
    }

    return el('section', { className: 'panel panel-success', role: 'status' }, children);
  }

  function buildErrorPanel() {
    var exportState = state.exportState || {};
    var error = exportState.error || {};
    var message = error.message || 'The export could not be completed.';
    var hint = error.hint || 'Reload the WhatsApp tab, then try again.';

    var tryAgain = el('button', { type: 'button', className: 'btn btn-primary' }, [
      icon('refresh'),
      el('span', { text: 'Try again' }),
    ]);
    tryAgain.addEventListener('click', retryExport);

    var children = [
      el('div', { className: 'error-head' }, [
        el('span', { className: 'status-icon status-icon-error', 'aria-hidden': 'true' }, icon('alert')),
        el('div', { className: 'error-titles' }, [
          el('h2', { className: 'panel-title', text: 'Export failed' }),
          el('p', { className: 'error-msg', text: message }),
        ]),
      ]),
      el('p', { className: 'error-hint', text: hint }),
      el('div', { className: 'panel-actions' }, [tryAgain]),
    ];

    if (state.optionsCollapsed) {
      var changeButton = el('button', { type: 'button', className: 'link-btn change-options', text: 'Change options' });
      changeButton.addEventListener('click', function () {
        state.optionsCollapsed = false;
        render();
      });
      children.push(changeButton);
    }

    return el('section', { className: 'panel panel-error', role: 'alert' }, children);
  }

  function renderHistory() {
    clear(dom.historySection);
    var items = state.history.slice(0, 3);
    if (!items.length) {
      setHidden(dom.historySection, true);
      return;
    }
    setHidden(dom.historySection, false);
    dom.historySection.appendChild(el('h2', { className: 'section-title', text: 'Recent exports' }));

    var card = el('div', { className: 'card history-card' });
    items.forEach(function (item) {
      var row = el('div', { className: 'history-row' }, [
        el('div', { className: 'history-icon', 'aria-hidden': 'true' }, icon('file')),
        el('div', { className: 'history-body' }, [
          el('p', { className: 'history-name', title: item.filename, text: item.filename }),
          el('p', { className: 'history-meta', text: historyMeta(item) }),
        ]),
      ]);
      var badge = historyBadge(item);
      if (badge) row.appendChild(el('span', { className: 'history-format', text: badge }));
      card.appendChild(row);
    });
    dom.historySection.appendChild(card);
  }

  function historyBadge(item) {
    var filename = String(item.filename || '');
    if (/\.zip$/i.test(filename)) return 'ZIP';
    if (item.mediaMode === 'download' && !/\.(html|txt|json|csv)$/i.test(filename)) return 'ZIP';
    return item.format ? WAEx.getFormat(item.format).label : '';
  }

  function historyMeta(item) {
    var parts = [];
    if (item.messageCount) parts.push(fmtNum(item.messageCount) + ' ' + pluralMessages(item.messageCount));
    if (item.bytes) parts.push(formatBytes(item.bytes));
    if (item.at) parts.push(relativeTime(item.at));
    return parts.join(' · ') || 'Saved export';
  }

  // ---------------------------------------------------------------------------
  // Connection / view derivation
  // ---------------------------------------------------------------------------

  function normalizeChat(raw) {
    if (!raw || typeof raw !== 'object') {
      return { found: false, name: '', isGroup: false, initials: '', renderedCount: 0, dateRange: null, reason: '' };
    }
    var range = raw.dateRange;
    if (
      !range ||
      typeof range !== 'object' ||
      !isFinite(Number(range.start)) ||
      !isFinite(Number(range.end)) ||
      Number(range.start) <= 0 ||
      Number(range.end) <= 0
    ) {
      range = null;
    } else {
      range = { start: Number(range.start), end: Number(range.end) };
    }
    return {
      found: raw.found !== false,
      name: typeof raw.name === 'string' ? raw.name : '',
      isGroup: !!raw.isGroup,
      initials: typeof raw.initials === 'string' ? raw.initials : '',
      renderedCount: Number(raw.renderedCount) || 0,
      fullHistory: raw.fullHistory === true,
      dateRange: range,
      reason: typeof raw.reason === 'string' ? raw.reason : '',
    };
  }

  function applyPingReply(reply) {
    if (!reply || typeof reply !== 'object' || reply.ok === false) {
      throw new Error('WhatsApp Web did not return a chat snapshot.');
    }
    state.chat = normalizeChat(reply.chat);
    state.exportState = reply.state && typeof reply.state === 'object' ? reply.state : null;
    if (typeof reply.version === 'string') state.version = reply.version;
    state.view = deriveView();
    state.optionsCollapsed = state.view === 'done' || state.view === 'error';
    state.notice = '';
    state.connectionError = '';
    state.cancelledPending = false;
  }

  function deriveView() {
    var exportState = state.exportState;
    var phase = exportState && exportState.phase;
    if (ACTIVE_PHASES[phase]) return 'exporting';
    if (phase === 'done') return 'done';
    if (phase === 'error') return 'error';
    return state.chat && state.chat.found ? 'ready' : 'no-chat';
  }

  async function init() {
    buildShell();
    bindGlobalHandlers();
    bindRuntimeMessages();

    state.settings = await loadSettings();
    syncControls();
    state.history = await loadHistory();
    render();

    await connect();
  }

  function bindGlobalHandlers() {
    // One slow timer for relative timestamps in the history list.
    setInterval(function () {
      if (state.history.length) renderHistory();
    }, 60000);
  }

  function bindRuntimeMessages() {
    if (messageListenerBound) return;
    messageListenerBound = true;
    chrome.runtime.onMessage.addListener(function (message, sender) {
      if (!message || !message.type) return;
      if (sender && sender.tab && sender.tab.id !== state.tabId) return;
      handleRuntimeMessage(message);
    });
  }

  function handleRuntimeMessage(message) {
    if (message.type === WAEx.MSG.PROGRESS) {
      handleProgress(message);
      return;
    }
    if (message.type === WAEx.MSG.RESULT) {
      handleResult(message);
      return;
    }
    if (message.type === WAEx.MSG.DIAGNOSTICS) {
      if (state.diagnostics.open) {
        var report = message.report && typeof message.report === 'object' ? message.report : message;
        if (report && Array.isArray(report.selectors)) {
          state.diagnostics.loading = false;
          state.diagnostics.error = '';
          state.diagnostics.report = report;
          renderDiagnostics();
        }
      }
    }
  }

  function handleProgress(message) {
    // The content script also sends a progress snapshot for terminal phases right
    // before the WAX:RESULT broadcast; let RESULT own those views.
    if (message.phase === 'done' || message.phase === 'error') return;

    if (message.phase === 'cancelled' || message.phase === WAEx.PHASE.CANCELLED) {
      state.exportState = {
        phase: 'cancelled',
        loaded: Number(message.loaded) || 0,
        total: message.total === undefined ? null : message.total,
        detail: message.detail || '',
        percent: null,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      };
      state.cancelRequested = false;
      state.view = state.chat && state.chat.found ? 'ready' : 'no-chat';
      state.notice = 'Export cancelled. No file was saved.';
      render();
      return;
    }

    var previous = state.exportState && ACTIVE_PHASES[state.exportState.phase] ? state.exportState : {};
    state.exportState = {
      phase: message.phase,
      loaded: Number(message.loaded) || 0,
      total: message.total === undefined ? (previous.total === undefined ? null : previous.total) : message.total,
      detail: message.detail ? String(message.detail) : '',
      percent: typeof message.percent === 'number' && isFinite(message.percent) ? message.percent : null,
      startedAt: previous.startedAt || Date.now(),
      finishedAt: null,
    };
    state.cancelRequested = false;

    if (state.view !== 'exporting') {
      state.view = 'exporting';
      state.optionsCollapsed = false;
      state.notice = '';
      render();
    } else {
      updateProgressView();
    }
  }

  function handleResult(message) {
    if (message.ok) {
      state.exportState = {
        phase: 'done',
        loaded: 0,
        total: null,
        detail: '',
        percent: 100,
        startedAt: state.exportState && state.exportState.startedAt ? state.exportState.startedAt : Date.now(),
        finishedAt: Date.now(),
        filename: message.filename || 'Chat export',
        bytes: Number(message.bytes) || 0,
        messageCount: Number(message.messageCount) || 0,
        warnings: Array.isArray(message.warnings) ? message.warnings : [],
        completeness: message.completeness && typeof message.completeness === 'object' ? message.completeness : null,
      };
      state.view = 'done';
      state.optionsCollapsed = true;
      state.notice = '';
      state.cancelRequested = false;
      rememberHistory(message);
      render();
      refreshHistoryAfterResult();
      return;
    }

    var error = message.error && typeof message.error === 'object' ? message.error : {};
    var code = String(error.code || '');
    var cancelled = code.toLowerCase().indexOf('cancel') !== -1;
    state.cancelRequested = false;

    if (cancelled) {
      state.exportState = {
        phase: 'cancelled',
        loaded: 0,
        total: null,
        detail: '',
        percent: null,
        startedAt: Date.now(),
        finishedAt: Date.now(),
      };
      state.view = state.chat && state.chat.found ? 'ready' : 'no-chat';
      state.notice = 'Export cancelled. No file was saved.';
      render();
      return;
    }

    state.exportState = {
      phase: 'error',
      loaded: 0,
      total: null,
      detail: '',
      percent: null,
      startedAt: state.exportState && state.exportState.startedAt ? state.exportState.startedAt : Date.now(),
      finishedAt: Date.now(),
      error: {
        code: code || 'E_UNKNOWN',
        message: error.message || 'The export could not be completed.',
        hint: error.hint || 'Reload the WhatsApp tab, then try again.',
      },
    };
    state.view = 'error';
    state.optionsCollapsed = true;
    render();
  }

  /** The content script writes history around the same time as RESULT. */
  function refreshHistoryAfterResult() {
    setTimeout(function () {
      loadHistory().then(function (history) {
        if (!history.length) return;
        state.history = history;
        renderHistory();
      });
    }, 500);
  }

  async function connect() {
    state.view = 'loading';
    render();

    var tab = null;
    try {
      tab = await getActiveTab();
    } catch (err) {
      state.connectionError = err && err.message ? err.message : '';
      state.view = 'not-ready';
      render();
      return;
    }

    if (!tab) {
      state.tab = null;
      state.tabId = null;
      state.view = 'no-tab';
      render();
      return;
    }

    state.tab = tab;
    state.tabId = tab.id;

    if (!isWhatsAppUrl(tab.url)) {
      state.view = 'no-tab';
      render();
      return;
    }

    try {
      var reply = await ensureContentScript(tab.id);
      applyPingReply(reply);
    } catch (err) {
      state.connectionError = err && err.message ? err.message : '';
      state.view = 'not-ready';
    }
    render();
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  function openWhatsAppWeb() {
    try {
      chrome.tabs.create({ url: 'https://web.whatsapp.com' }, function () {
        try {
          window.close();
        } catch (err) {
          /* ignore */
        }
      });
    } catch (err) {
      /* ignore */
    }
  }

  function reloadWhatsAppTab() {
    if (!state.tabId || state.reloading) return;
    state.reloading = true;
    state.connectionError = '';
    render();
    try {
      chrome.tabs.reload(state.tabId, {}, function () {
        setTimeout(function () {
          reconnectAfterReload();
        }, 2200);
      });
    } catch (err) {
      state.reloading = false;
      render();
    }
  }

  async function reconnectAfterReload() {
    if (!state.tabId) {
      state.reloading = false;
      render();
      return;
    }
    try {
      var reply = await ensureContentScript(state.tabId);
      applyPingReply(reply);
      state.reloading = false;
    } catch (err) {
      state.connectionError = err && err.message ? err.message : '';
      state.reloading = false;
      state.view = 'not-ready';
    }
    render();
  }

  async function refreshChat() {
    if (state.refreshing || !state.tabId) return;
    state.refreshing = true;
    renderChatCard();

    try {
      var reply = await sendToContent(state.tabId, { type: WAEx.MSG.PING, scan: true });
      if (!isPingReply(reply)) throw new Error('No chat snapshot returned.');
      if (!reply.chat || !reply.chat.found) {
        // The tab answered but sees no chat: possibly a copy of the extension left over from
        // before a reload. Re-run the scripts in the tab (the newest copy takes over), then ask
        // again. Normally only reloading the WhatsApp tab does this.
        try {
          await injectContentFiles(state.tabId);
          var again = await sendToContent(state.tabId, { type: WAEx.MSG.PING, scan: true });
          if (isPingReply(again)) reply = again;
        } catch (reconnectErr) {
          /* keep the first answer */
        }
      }
      applyPingReply(reply);
      state.refreshedAt = Date.now();
    } catch (err) {
      try {
        var retryReply = await ensureContentScript(state.tabId);
        applyPingReply(retryReply);
      } catch (retryErr) {
        state.connectionError = retryErr && retryErr.message ? retryErr.message : '';
        state.view = 'not-ready';
      }
    } finally {
      state.refreshing = false;
      render();
      if (state.refreshedAt) {
        setTimeout(function () {
          if (!state.refreshing) renderChatCard();
        }, REFRESHED_NOTE_MS + 50);
      }
    }
  }

  async function startExport() {
    if (!state.tabId) {
      state.view = 'not-ready';
      render();
      return;
    }
    if (!validateCustomDates()) {
      renderActionArea();
      return;
    }
    if (!(state.chat && state.chat.found)) {
      renderActionArea();
      return;
    }

    state.settings = WAEx.normalizeSettings(state.settings);
    saveSettings(state.settings);

    state.notice = '';
    state.cancelRequested = false;
    state.optionsCollapsed = false;
    state.exportState = {
      phase: WAEx.PHASE.SCROLLING,
      loaded: 0,
      total: null,
      detail: '',
      percent: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    state.view = 'exporting';
    render();

    try {
      var reply = null;
      try {
        reply = await sendToContent(state.tabId, { type: WAEx.MSG.EXPORT, settings: state.settings });
      } catch (err) {
        await ensureContentScript(state.tabId);
        reply = await sendToContent(state.tabId, { type: WAEx.MSG.EXPORT, settings: state.settings });
      }
      if (reply && reply.accepted === false) {
        throw new Error((reply.error && reply.error.message) || 'The export could not be started.');
      }
    } catch (err) {
      state.exportState = {
        phase: 'error',
        loaded: 0,
        total: null,
        detail: '',
        percent: null,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        error: {
          code: 'E_START',
          message: err && err.message ? err.message : 'The export could not be started.',
          hint: 'Reload the WhatsApp tab, then try again.',
        },
      };
      state.view = 'error';
      state.optionsCollapsed = true;
      render();
    }
  }

  async function cancelExport() {
    if (state.cancelRequested || !state.tabId) return;
    state.cancelRequested = true;
    updateProgressView();
    try {
      await sendToContent(state.tabId, { type: WAEx.MSG.CANCEL });
    } catch (err) {
      /* The pause/stop may still arrive through broadcasts. */
    }
    setTimeout(reconcileAfterCancel, 700);
  }

  function reconcileAfterCancel() {
    if (state.view !== 'exporting' || !state.tabId) return;
    sendToContent(state.tabId, { type: WAEx.MSG.PING })
      .then(function (reply) {
        if (state.view !== 'exporting' || !reply || reply.ok === false) return;
        state.chat = normalizeChat(reply.chat);
        state.exportState = reply.state && typeof reply.state === 'object' ? reply.state : null;
        var phase = state.exportState && state.exportState.phase;
        if (ACTIVE_PHASES[phase]) {
          state.cancelRequested = true;
          render();
          return;
        }
        state.view = state.chat && state.chat.found ? 'ready' : 'no-chat';
        state.notice = 'Export cancelled. No file was saved.';
        state.cancelRequested = false;
        render();
      })
      .catch(function () {
        state.cancelRequested = false;
        render();
      });
  }

  function retryExport() {
    if (state.tabId && state.chat && state.chat.found) {
      startExport();
      return;
    }
    connect();
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  function openDiagnostics() {
    state.diagnostics.open = true;
    state.diagnostics.loading = true;
    state.diagnostics.report = null;
    state.diagnostics.error = '';
    state.diagnostics.copied = false;
    state.diagnosticsReturnFocus = document.activeElement;
    setHidden(dom.diagOverlay, false);
    document.documentElement.classList.add('dialog-open');
    renderDiagnostics();
    try {
      dom.diagCloseButton.focus();
    } catch (err) {
      /* ignore */
    }
    requestDiagnostics();
  }

  function closeDiagnostics() {
    state.diagnostics.open = false;
    state.diagnostics.copied = false;
    setHidden(dom.diagOverlay, true);
    document.documentElement.classList.remove('dialog-open');
    if (state.diagnosticsReturnFocus && typeof state.diagnosticsReturnFocus.focus === 'function') {
      try {
        state.diagnosticsReturnFocus.focus();
      } catch (err) {
        /* ignore */
      }
    }
  }

  function requestDiagnostics() {
    if (!state.tabId) {
      state.diagnostics.loading = false;
      state.diagnostics.error = 'Open WhatsApp Web first, then run diagnostics.';
      renderDiagnostics();
      return;
    }
    sendToContent(state.tabId, { type: WAEx.MSG.DIAGNOSE })
      .then(function (reply) {
        if (!state.diagnostics.open) return;
        var report = reply && reply.report && typeof reply.report === 'object' ? reply.report : reply;
        if (!report || !Array.isArray(report.selectors)) {
          throw new Error('No selector report was returned.');
        }
        state.diagnostics.loading = false;
        state.diagnostics.error = '';
        state.diagnostics.report = report;
        renderDiagnostics();
      })
      .catch(function (err) {
        if (!state.diagnostics.open) return;
        state.diagnostics.loading = false;
        state.diagnostics.error = err && err.message ? err.message : 'Diagnostics are unavailable.';
        renderDiagnostics();
      });
  }

  function renderDiagnostics() {
    if (!state.diagnostics.open) return;
    setHidden(dom.diagOverlay, false);
    clear(dom.diagBody);

    var diag = state.diagnostics;
    dom.diagCopyButton.disabled = !diag.report;
    dom.diagCopyStatus.textContent = diag.copied ? 'Copied' : '';

    if (diag.loading) {
      dom.diagBody.appendChild(
        el('div', { className: 'diag-loading' }, [el('span', { className: 'spinner', 'aria-hidden': 'true' }), 'Checking WhatsApp Web…'])
      );
      return;
    }

    if (diag.error) {
      var retryButton = el('button', { type: 'button', className: 'btn btn-secondary btn-small', text: 'Retry' });
      retryButton.addEventListener('click', function () {
        state.diagnostics.loading = true;
        state.diagnostics.error = '';
        renderDiagnostics();
        requestDiagnostics();
      });
      dom.diagBody.appendChild(
        el('div', { className: 'diag-error', role: 'alert' }, [
          el('p', { className: 'error-msg', text: diag.error }),
          retryButton,
        ])
      );
      return;
    }

    var report = diag.report;
    if (!report) return;

    if (report.url) {
      dom.diagBody.appendChild(el('p', { className: 'diag-url', title: report.url, text: report.url }));
    }

    dom.diagBody.appendChild(
      el('div', { className: 'diag-stats' }, [
        el('div', { className: 'diag-stat' }, [
          el('span', { className: 'diag-stat-label', text: 'Rendered rows' }),
          el('span', { className: 'diag-stat-value', text: fmtNum(report.renderedRows) }),
        ]),
        el('div', { className: 'diag-stat' }, [
          el('span', { className: 'diag-stat-label', text: 'Parsed messages' }),
          el('span', { className: 'diag-stat-value', text: fmtNum(report.parsedMessages) }),
        ]),
        el('div', { className: 'diag-stat' }, [
          el('span', { className: 'diag-stat-label', text: 'Message list' }),
          el('span', {
            className: 'diag-stat-value',
            text: describeScroller(report.scroll),
          }),
        ]),
        el('div', { className: 'diag-stat' }, [
          el('span', { className: 'diag-stat-label', text: 'Scroll height' }),
          el('span', {
            className: 'diag-stat-value',
            text: describeScrollHeight(report.scroll),
          }),
        ]),
      ])
    );

    dom.diagBody.appendChild(el('h3', { className: 'diag-section-title', text: 'Selector health' }));
    var selectors = Array.isArray(report.selectors) ? report.selectors : [];
    if (!selectors.length) {
      dom.diagBody.appendChild(el('p', { className: 'diag-empty', text: 'No selector data was reported.' }));
    } else {
      var list = el('div', { className: 'diag-list' });
      selectors.forEach(function (entry) {
        var matches = Number(entry && entry.matches) || 0;
        list.appendChild(
          el('div', { className: 'diag-row' }, [
            el('span', { className: 'dot' + (matches > 0 ? ' ok' : ''), 'aria-hidden': 'true' }),
            el('div', { className: 'diag-info' }, [
              el('span', { className: 'diag-name', text: String((entry && entry.name) || 'selector') }),
              el('code', {
                className: 'diag-selector',
                title: String((entry && entry.selector) || ''),
                text: String((entry && entry.selector) || ''),
              }),
            ]),
            el('span', { className: 'diag-matches' + (matches > 0 ? '' : ' bad'), text: fmtNum(matches) }),
          ])
        );
      });
      dom.diagBody.appendChild(list);
    }

    var warnings = Array.isArray(report.warnings) ? report.warnings : [];
    if (warnings.length) {
      dom.diagBody.appendChild(el('h3', { className: 'diag-section-title', text: 'Warnings' }));
      var warningList = el('ul', { className: 'warning-list' });
      warnings.forEach(function (warning) {
        warningList.appendChild(el('li', { text: String(warning) }));
      });
      dom.diagBody.appendChild(warningList);
    }
  }

  /** "scrollable" / "not scrollable" / "not found" for the diagnostics panel. */
  function describeScroller(scroll) {
    if (!scroll || typeof scroll !== 'object') return 'unknown';
    if (!scroll.found) return 'not found';
    return scroll.scrollable ? 'scrollable' : 'not scrollable';
  }

  /** Content height of the message list, which explains how much history is loaded. */
  function describeScrollHeight(scroll) {
    if (!scroll || !scroll.found) return '—';
    return fmtNum(scroll.scrollHeight) + ' px';
  }

  function copyDiagnosticsReport() {
    var report = state.diagnostics.report;
    if (!report) return;
    var text = JSON.stringify(report, null, 2);
    copyText(text).then(function () {
      state.diagnostics.copied = true;
      dom.diagCopyStatus.textContent = 'Copied';
      setTimeout(function () {
        if (!state.diagnostics.open) return;
        state.diagnostics.copied = false;
        dom.diagCopyStatus.textContent = '';
      }, 1600);
    });
  }

  function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).catch(function () {
        fallbackCopy(text);
      });
    }
    fallbackCopy(text);
    return Promise.resolve();
  }

  function fallbackCopy(text) {
    try {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    } catch (err) {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // Go
  // ---------------------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
