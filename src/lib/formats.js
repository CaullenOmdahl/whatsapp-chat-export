/**
 * Serialisers: turn the parsed message list into a downloadable document.
 *
 * Every format returns a plain string (the caller wraps it in a Blob) plus metadata.
 * Message text is user content and is *never* interpolated into raw HTML: the HTML
 * writer escapes every dynamic value through `escapeHtml`.
 */
(function (global) {
  'use strict';

  var WAEx = (global.WAEx = global.WAEx || {});
  var T = WAEx.MESSAGE_TYPES || {};

  var ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(value) {
    return String(value === undefined || value === null ? '' : value).replace(
      /[&<>"']/g,
      function (ch) {
        return ESCAPES[ch];
      }
    );
  }

  /** Media entries produce a human label such as "Photo" or "Document: report.pdf". */
  function mediaLabel(message) {
    var kind = (message.media && message.media.kind) || message.type;
    var fileName = message.media && message.media.fileName;
    switch (kind) {
      case 'image':
        return 'Photo';
      case 'video':
        return 'Video';
      case 'audio':
        return 'Audio';
      case 'voice':
        return 'Voice message';
      case 'document':
        return 'Document' + (fileName ? ': ' + fileName : '');
      case 'sticker':
        return 'Sticker';
      case 'gif':
        return 'GIF';
      case 'contact':
        return 'Contact card';
      case 'location':
        return 'Location';
      case 'poll':
        return 'Poll';
      default:
        return fileName ? String(fileName) : 'Attachment';
    }
  }

  /** Count messages, types and participants. Assumes the list is sorted by time. */
  function summarize(messages) {
    var byType = {};
    var authors = Object.create(null);
    var start = null;
    var end = null;
    var incoming = 0;
    var outgoing = 0;

    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      byType[m.type] = (byType[m.type] || 0) + 1;
      if (m.author) authors[m.author] = (authors[m.author] || 0) + 1;
      if (typeof m.timestamp === 'number' && !isNaN(m.timestamp)) {
        if (start === null || m.timestamp < start) start = m.timestamp;
        if (end === null || m.timestamp > end) end = m.timestamp;
      }
      if (m.isOutgoing) outgoing++;
      else incoming++;
    }

    var authorList = Object.keys(authors)
      .map(function (name) {
        return { name: name, count: authors[name] };
      })
      .sort(function (a, b) {
        return b.count - a.count;
      });

    return {
      total: messages.length,
      byType: byType,
      authors: authorList,
      outgoing: outgoing,
      incoming: incoming,
      range: start === null ? null : { start: start, end: end },
    };
  }

  /** Group messages into ordered [{ dateKey, label, messages }] buckets. */
  function groupByDay(messages, dt) {
    var groups = [];
    var current = null;

    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var key = m.dateKey || (m.timestamp ? dt.dateKey(m.timestamp) : '');
      if (!current || current.key !== key) {
        current = {
          key: key,
          label: m.timestamp ? dt.formatDate(m.timestamp) : key || 'Undated',
          messages: [],
        };
        groups.push(current);
      }
      current.messages.push(m);
    }

    return groups;
  }

  function sanitizeFileName(name, fallback) {
    var clean = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 80)
      .trim();
    return clean || fallback || 'chat';
  }

  /** Build the shared download base name: `WhatsApp Chat with Alice - 2026-11-18` */
  function buildBaseName(chatName, now) {
    var dt = WAEx.datetime;
    var day = dt.dateKey(now || Date.now());
    return 'WhatsApp Chat with ' + sanitizeFileName(chatName, 'Unknown') + ' - ' + day;
  }

  /* ------------------------------------------------------------------ text */

  /**
   * The export's own notes: which date range was asked for, and every warning. Written into
   * the file so a short or incomplete export explains itself without the popup.
   */
  function rangeLabel(settings) {
    var s = settings || {};
    if (s.dateRange === 'custom') {
      return 'Custom (' + (s.customStart || 'beginning') + ' to ' + (s.customEnd || 'now') + ')';
    }
    var presets = WAEx.DATE_RANGES || [];
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].id === s.dateRange) return presets[i].label;
    }
    return 'All time';
  }

  function toText(messages, meta) {
    var dt = WAEx.datetime;
    var stats = meta.stats || summarize(messages);
    var lines = [];

    lines.push('WhatsApp Chat with ' + (meta.chat.name || 'Unknown'));
    lines.push(
      'Exported ' +
        dt.formatDateTime(meta.exportedAt) +
        ' · ' +
        WAEx.plural(stats.total, 'message')
    );
    if (stats.range) {
      lines.push('Conversation dates: ' + dt.formatRange(stats.range));
    }
    lines.push('Date range: ' + rangeLabel(meta.settings));
    var notes = Array.isArray(meta.warnings) ? meta.warnings : [];
    if (notes.length) {
      lines.push('Warnings:');
      for (var w = 0; w < notes.length; w++) lines.push('  - ' + String(notes[w]).replace(/\s*\n\s*/g, ' '));
    }
    lines.push(new Array(56).join('-'));
    lines.push('');

    var groups = groupByDay(messages, dt);

    for (var g = 0; g < groups.length; g++) {
      lines.push('--- ' + groups[g].label + ' ---');
      lines.push('');

      for (var i = 0; i < groups[g].messages.length; i++) {
        var m = groups[g].messages[i];
        var stamp = m.timestamp ? dt.formatDateTime(m.timestamp) : '';

        if (m.type === T.SYSTEM) {
          lines.push('[' + stamp + '] ' + (m.text || 'System message'));
          continue;
        }

        var line = '[' + stamp + '] ';
        var settings = meta.settings || {};
        if (settings.senderLabels !== false && m.author) {
          line += m.author + ': ';
        }
        if (m.media) {
          var label = mediaLabel(m);
          var mediaNote = m.media.zipPath
            ? label + ' -> ' + m.media.zipPath
            : label + (m.media.missing ? ' (not loaded)' : '');
          line += '[' + mediaNote + ']' + (m.text ? ' ' : '');
        }

        // Continuation lines are indented so one message stays one parseable block.
        lines.push(line + String(m.text || '').replace(/\n/g, '\n    '));
        if (m.quoted) {
          lines.push(
            '    > ' +
              (m.quoted.author ? m.quoted.author + ': ' : '') +
              String(m.quoted.text || '').replace(/\n/g, '\n      ')
          );
        }
        if (m.reactions && m.reactions.length) {
          lines.push('    reactions: ' + m.reactions.map(renderReaction).join(' '));
        }
      }
      lines.push('');
    }

    lines.push(new Array(56).join('-'));
    lines.push('Generated by Chat Export for WhatsApp. Not affiliated with WhatsApp.');

    return lines.join('\n');
  }

  /* ------------------------------------------------------------------- csv */

  var CSV_COLUMNS = [
    'timestamp_iso',
    'timestamp_ms',
    'date',
    'time',
    'author',
    'direction',
    'type',
    'text',
    'quoted_author',
    'quoted_text',
    'reactions',
    'media_kind',
    'media_file',
    'media_missing',
    'message_id',
  ];

  function csvCell(value) {
    var text = value === undefined || value === null ? '' : String(value);
    if (/[",\r\n]/.test(text)) {
      return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
  }

  function toCsv(messages, meta) {
    var dt = WAEx.datetime;
    var rows = [CSV_COLUMNS.join(',')];

    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      var iso = m.timestamp ? new Date(m.timestamp).toISOString() : '';
      rows.push(
        [
          iso,
          m.timestamp || '',
          m.timestamp ? dt.dateKey(m.timestamp) : '',
          m.timestamp ? dt.formatTime(m.timestamp, true) : '',
          m.author || '',
          m.isOutgoing ? 'outgoing' : 'incoming',
          m.type,
          m.text || '',
          m.quoted ? m.quoted.author || '' : '',
          m.quoted ? m.quoted.text || '' : '',
          m.reactions && m.reactions.length ? m.reactions.map(renderReaction).join(' ') : '',
          m.media ? m.media.kind || '' : '',
          m.media ? m.media.zipPath || '' : '',
          m.media && m.media.missing ? 'true' : '',
          m.id || '',
        ]
          .map(csvCell)
          .join(',')
      );
    }

    // UTF-8 BOM so Excel detects the encoding.
    return '\ufeff' + rows.join('\r\n');
  }

  /* ------------------------------------------------------------------ json */

  function toJson(messages, meta) {
    var dt = WAEx.datetime;
    var stats = meta.stats || summarize(messages);

    var byDay = groupByDay(messages, dt).map(function (group) {
      return {
        date: group.key,
        label: group.label,
        count: group.messages.length,
      };
    });

    var payload = {
      schema: 'chat-export/v1',
      generator: 'Chat Export for WhatsApp ' + (WAEx.VERSION || '1.0.0'),
      exportedAt: new Date(meta.exportedAt || Date.now()).toISOString(),
      chat: {
        name: meta.chat.name || '',
        isGroup: Boolean(meta.chat.isGroup),
      },
      settings: {
        format: meta.settings ? meta.settings.format : 'json',
        mediaMode: meta.settings ? meta.settings.mediaMode : 'link',
        includeSystem: meta.settings ? meta.settings.includeSystem : false,
        includeReactions: meta.settings ? meta.settings.includeReactions : true,
        dateRange: meta.settings ? meta.settings.dateRange : 'all',
        dateRangeLabel: rangeLabel(meta.settings),
      },
      warnings: Array.isArray(meta.warnings) ? meta.warnings.map(String) : [],
      stats: {
        total: stats.total,
        incoming: stats.incoming,
        outgoing: stats.outgoing,
        byType: stats.byType,
        participants: stats.authors,
        dateRange: stats.range
          ? {
              start: new Date(stats.range.start).toISOString(),
              end: new Date(stats.range.end).toISOString(),
            }
          : null,
        days: byDay,
      },
      messages: messages.map(function (m) {
        return {
          id: m.id || '',
          timestamp: m.timestamp || null,
          timestampISO: m.timestamp ? new Date(m.timestamp).toISOString() : null,
          date: m.timestamp ? dt.dateKey(m.timestamp) : '',
          time: m.timestamp ? dt.formatTime(m.timestamp, true) : '',
          author: m.author || '',
          direction: m.isOutgoing ? 'outgoing' : 'incoming',
          type: m.type,
          text: m.text || '',
          quoted: m.quoted
            ? { author: m.quoted.author || '', text: m.quoted.text || '' }
            : null,
          reactions: m.reactions && m.reactions.length ? m.reactions : [],
          media: m.media
            ? {
                kind: m.media.kind || '',
                fileName: m.media.fileName || '',
                mime: m.media.mime || '',
                bytes: m.media.bytes || 0,
                file: m.media.zipPath || '',
                missing: Boolean(m.media.missing),
              }
            : null,
        };
      }),
    };

    return JSON.stringify(payload, null, 2);
  }

  /* ------------------------------------------------------------------ html */

  var HTML_STYLE = [
    ':root{--bg:#efeae2;--panel:#ffffff;--ink:#111b21;--muted:#667781;--line:#e5ded6;',
    '--in:#ffffff;--out:#d9fdd3;--accent:#008069;--chip:#f0f2f5;--quote:#f3f5f6;}',
    '@media (prefers-color-scheme: dark){:root{--bg:#0b141a;--panel:#111b21;--ink:#e9edef;',
    '--muted:#8696a0;--line:#2a3942;--in:#202c33;--out:#005c4b;--accent:#00a884;',
    '--chip:#202c33;--quote:#1b262c;}}',
    '*{box-sizing:border-box}',
    'html,body{margin:0;padding:0}',
    'body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,',
    '"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}',
    '.wrap{max-width:860px;margin:0 auto;padding:0 16px 64px}',
    'header.top{position:sticky;top:0;z-index:2;background:var(--accent);color:#fff;',
    'margin:0 -16px 24px;padding:18px 24px;box-shadow:0 1px 3px rgba(0,0,0,.2)}',
    'header.top h1{margin:0;font-size:18px;font-weight:600;letter-spacing:.1px;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    'header.top p{margin:3px 0 0;font-size:12.5px;opacity:.85}',
    '.day{display:flex;justify-content:center;margin:22px 0 14px}',
    '.day span{background:var(--panel);color:var(--muted);font-size:12px;font-weight:500;',
    'padding:5px 12px;border-radius:8px;box-shadow:0 1px 1px rgba(0,0,0,.08)}',
    '.msg{display:flex;margin:2px 0;padding:0 6px}',
    '.msg.out{justify-content:flex-end}',
    '.bubble{max-width:min(78%,620px);background:var(--in);border-radius:9px;padding:7px 10px 6px;',
    'box-shadow:0 1px .5px rgba(0,0,0,.13);position:relative;overflow-wrap:anywhere}',
    '.msg.out .bubble{background:var(--out)}',
    '.author{font-size:12.5px;font-weight:600;color:#e542a3;margin-bottom:2px}',
    '.text{white-space:pre-wrap;font-size:14.5px}',
    '.meta{display:flex;justify-content:flex-end;align-items:center;gap:6px;margin-top:3px;',
    'font-size:11px;color:var(--muted)}',
    '.quote{border-left:3px solid var(--accent);background:var(--quote);border-radius:4px;',
    'padding:5px 8px;margin:2px 0 5px;font-size:13px;color:var(--muted)}',
    '.quote b{display:block;color:var(--accent);font-size:12px;margin-bottom:1px}',
    '.reactions{display:flex;gap:4px;margin-top:4px}',
    '.reaction{background:var(--chip);border-radius:10px;padding:1px 6px;font-size:12px}',
    '.media{margin:3px 0 4px}',
    '.media img,.media video{display:block;max-width:100%;border-radius:6px;max-height:340px}',
    '.media audio{width:100%;max-width:320px}',
    '.file{display:flex;align-items:center;gap:9px;background:var(--chip);border-radius:7px;',
    'padding:9px 11px;font-size:13px;max-width:340px}',
    '.file .ico{font-size:18px;line-height:1}',
    '.file a{color:var(--accent);text-decoration:none;font-weight:500;word-break:break-all}',
    '.file small{display:block;color:var(--muted);font-weight:400;font-size:11.5px}',
    '.missing{font-style:italic;color:var(--muted);font-size:12.5px}',
    '.system{display:flex;justify-content:center;margin:10px 0}',
    '.system span{background:var(--panel);color:var(--muted);font-size:12px;padding:4px 10px;',
    'border-radius:7px;max-width:80%;text-align:center;box-shadow:0 1px 1px rgba(0,0,0,.06)}',
    'footer.foot{margin-top:36px;text-align:center;color:var(--muted);font-size:12px;',
    'border-top:1px solid var(--line);padding-top:16px}',
    '@media print{header.top{position:static}.msg{break-inside:avoid}}',
  ].join('');

  function renderReaction(reaction) {
    if (!reaction) return '';
    var emoji = reaction.emoji || '';
    var count = reaction.count || 1;
    return count > 1 ? emoji + ' ' + count : emoji;
  }

  function renderMediaHtml(message, settings) {
    var media = message.media;
    if (!media) return '';

    // "None" means none: never surface media in this mode, even defensively.
    if (settings.mediaMode === 'skip') return '';

    if (media.zipPath) {
      var src = escapeHtml(media.zipPath);
      var label = escapeHtml(media.fileName || media.kind || 'file');
      if (media.kind === 'image' || media.kind === 'sticker' || media.kind === 'gif') {
        return (
          '<div class="media"><img loading="lazy" src="' +
          src +
          '" alt="' +
          label +
          '"></div>'
        );
      }
      if (media.kind === 'video') {
        return (
          '<div class="media"><video controls preload="metadata" src="' +
          src +
          '"></video></div>'
        );
      }
      if (media.kind === 'audio' || media.kind === 'voice') {
        return '<div class="media"><audio controls preload="metadata" src="' + src + '"></audio></div>';
      }
      return (
        '<div class="media"><div class="file"><span class="ico">&#128196;</span><span>' +
        '<a href="' +
        src +
        '">' +
        label +
        '</a><small>' +
        escapeHtml(media.mime || 'file') +
        (media.bytes ? ' · ' + WAEx.formatBytes(media.bytes) : '') +
        '</small></span></div></div>'
      );
    }

    var note = mediaLabel(message);
    var why = media.missing
      ? 'not loaded in WhatsApp, so it was not saved'
      : 'not saved with this export';
    return (
      '<div class="media"><div class="missing">[' +
      escapeHtml(note) +
      ' — ' +
      escapeHtml(why) +
      ']</div></div>'
    );
  }

  function toHtml(messages, meta) {
    var dt = WAEx.datetime;
    var stats = meta.stats || summarize(messages);
    var settings = meta.settings || {};
    var groups = groupByDay(messages, dt);
    var html = [];

    var chatName = meta.chat.name || 'Unknown chat';
    var summaryParts = [WAEx.plural(stats.total, 'message')];
    if (stats.range) summaryParts.push(dt.formatRange(stats.range) + ' (' + dt.relativeTime(stats.range.end, meta.exportedAt) + ')');

    html.push('<!DOCTYPE html>');
    html.push('<html lang="en">');
    html.push('<head>');
    html.push('<meta charset="utf-8">');
    html.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
    html.push('<meta name="generator" content="Chat Export for WhatsApp ' + escapeHtml(WAEx.VERSION || '') + '">');
    html.push('<title>WhatsApp Chat with ' + escapeHtml(chatName) + '</title>');
    html.push('<style>' + HTML_STYLE + '</style>');
    html.push('</head>');
    html.push('<body>');
    html.push('<div class="wrap">');
    html.push('<header class="top">');
    html.push('<h1>' + escapeHtml(chatName) + '</h1>');
    html.push('<p>' + escapeHtml(summaryParts.join(' · ')) + '</p>');
    html.push('</header>');

    for (var g = 0; g < groups.length; g++) {
      html.push('<div class="day"><span>' + escapeHtml(groups[g].label) + '</span></div>');

      for (var i = 0; i < groups[g].messages.length; i++) {
        var m = groups[g].messages[i];

        if (m.type === T.SYSTEM) {
          html.push('<div class="system"><span>' + escapeHtml(m.text || '') + '</span></div>');
          continue;
        }

        var classes = 'msg ' + (m.isOutgoing ? 'out' : 'in');
        html.push('<div class="' + classes + '">');
        html.push('<div class="bubble">');

        if (!m.isOutgoing && settings.senderLabels !== false && m.author) {
          html.push('<div class="author">' + escapeHtml(m.author) + '</div>');
        }

        if (m.quoted) {
          html.push('<div class="quote">');
          if (m.quoted.author) html.push('<b>' + escapeHtml(m.quoted.author) + '</b>');
          html.push(escapeHtml(m.quoted.text || ''));
          html.push('</div>');
        }

        var mediaHtml = renderMediaHtml(m, settings);
        if (mediaHtml) html.push(mediaHtml);

        if (m.text) {
          html.push('<div class="text">' + escapeHtml(m.text) + '</div>');
        }

        if (m.reactions && m.reactions.length && settings.includeReactions !== false) {
          html.push('<div class="reactions">');
          for (var r = 0; r < m.reactions.length; r++) {
            html.push('<span class="reaction">' + escapeHtml(renderReaction(m.reactions[r])) + '</span>');
          }
          html.push('</div>');
        }

        html.push('<div class="meta">');
        html.push('<span>' + escapeHtml(m.timestamp ? dt.formatTime(m.timestamp) : '') + '</span>');
        html.push('</div>');

        html.push('</div>');
        html.push('</div>');
      }
    }

    html.push('<footer class="foot">');
    html.push(
      'Exported ' +
        escapeHtml(dt.formatDateTime(meta.exportedAt)) +
        ' with Chat Export for WhatsApp. ' +
        escapeHtml(stats.total) +
        ' messages.'
    );
    html.push('<br>Date range: ' + escapeHtml(rangeLabel(settings)) + '.');
    var htmlNotes = Array.isArray(meta.warnings) ? meta.warnings : [];
    if (htmlNotes.length) {
      html.push('<br>Warnings:<ul class="notes">');
      for (var n = 0; n < htmlNotes.length; n++) html.push('<li>' + escapeHtml(htmlNotes[n]) + '</li>');
      html.push('</ul>');
    }
    html.push('<br>Not affiliated with, endorsed by, or sponsored by WhatsApp LLC or Meta.');
    html.push('</footer>');
    html.push('</div>');
    html.push('</body>');
    html.push('</html>');

    return html.join('\n');
  }

  /**
   * Serialise `messages` in `format`.
   * Returns { text, mime, extension }.
   */
  function serialize(format, messages, meta) {
    var enriched = meta || {};
    if (!enriched.stats) enriched.stats = summarize(messages);
    if (!enriched.exportedAt) enriched.exportedAt = Date.now();
    if (!enriched.chat) enriched.chat = { name: '', isGroup: false };
    if (!enriched.settings) enriched.settings = WAEx.normalizeSettings
      ? WAEx.normalizeSettings({})
      : {};

    switch (format) {
      case 'txt':
        return { text: toText(messages, enriched), mime: 'text/plain;charset=utf-8', extension: 'txt' };
      case 'csv':
        return { text: toCsv(messages, enriched), mime: 'text/csv;charset=utf-8', extension: 'csv' };
      case 'json':
        return { text: toJson(messages, enriched), mime: 'application/json;charset=utf-8', extension: 'json' };
      case 'html':
      default:
        return { text: toHtml(messages, enriched), mime: 'text/html;charset=utf-8', extension: 'html' };
    }
  }

  WAEx.formats = {
    serialize: serialize,
    summarize: summarize,
    toText: toText,
    toHtml: toHtml,
    toJson: toJson,
    toCsv: toCsv,
    escapeHtml: escapeHtml,
    sanitizeFileName: sanitizeFileName,
    buildBaseName: buildBaseName,
    mediaLabel: mediaLabel,
    groupByDay: groupByDay,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WAEx.formats;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
