/**
 * Media capture.
 *
 * WhatsApp renders media from short-lived `blob:` URLs that only exist while the
 * message is mounted. Capturing therefore has to happen from the live page, before
 * the conversation is scrolled back and WhatsApp reclaims the object URLs.
 *
 * Only already-rendered media can be captured that way. A photo the user has never
 * opened in the chat has no blob URL at all, so it is reported as missing rather than
 * silently omitted.
 *
 * Messages read from WhatsApp's store (internal.js) carry a `wax-msg:<id>` URL
 * instead: their media is downloaded and decrypted by WhatsApp's own download manager
 * through the page bridge (`readInternal`), whether or not it was ever opened.
 */
(function (global) {
  'use strict';

  var WAEx = (global.WAEx = global.WAEx || {});

  var CONCURRENCY = 3;

  var EXTENSION_BY_MIME = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
  };

  var MIME_BY_KIND = {
    image: 'image/jpeg',
    sticker: 'image/webp',
    gif: 'image/gif',
    video: 'video/mp4',
    audio: 'audio/mpeg',
    voice: 'audio/ogg',
    document: 'application/octet-stream',
  };

  function extensionFor(mime, kind) {
    var clean = String(mime || '').split(';')[0].trim().toLowerCase();
    if (EXTENSION_BY_MIME[clean]) return EXTENSION_BY_MIME[clean];
    if (clean.indexOf('image/') === 0) return 'jpg';
    if (clean.indexOf('video/') === 0) return 'mp4';
    if (clean.indexOf('audio/') === 0) return 'ogg';
    if (clean === 'application/pdf') return 'pdf';
    if (kind === 'sticker') return 'webp';
    if (kind === 'gif') return 'gif';
    return 'bin';
  }

  function pad(num, width) {
    var text = String(num);
    while (text.length < width) text = '0' + text;
    return text;
  }

  /** Strip anything that would be awkward in a zip entry name. */
  function safeFileName(name, fallback) {
    var clean = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 60)
      .trim();
    return clean || fallback || 'file';
  }

  /**
   * Prepare a collector for one export.
   *
   * options:
   *   maxBytes   hard ceiling for captured media (bytes)
   *   readInternal  (id) => Promise<{ buffer, mimetype }> for `wax-msg:` URLs
   *   shouldCancel  () => boolean
   *   onProgress    ({ attempted, captured, bytes, skipped }) => void
   */
  function createCollector(options) {
    var opts = options || {};
    var maxBytes = typeof opts.maxBytes === 'number' && opts.maxBytes > 0 ? opts.maxBytes : 250 * 1024 * 1024;
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : function () {
      return false;
    };
    var readInternal = typeof opts.readInternal === 'function' ? opts.readInternal : null;

    var pending = [];
    var entries = [];
    var bytes = 0;
    var skipped = 0;
    var warnings = [];
    var failures = Object.create(null); // kind -> { count, reason }
    var index = 0;

    /** Queue one message's media (called during parsing, still synchronous). */
    function enqueue(message) {
      if (!message || !message.media) return;
      var media = message.media;

      if (!media.url) {
        media.missing = true;
        skipped++;
        return;
      }
      var internal = /^wax-msg:/.test(String(media.url));
      if (internal && !readInternal) {
        media.missing = true;
        skipped++;
        return;
      }
      if (!internal && !/^(blob|data):/.test(String(media.url))) {
        media.missing = true;
        skipped++;
        return;
      }

      pending.push({ message: message, url: media.url });
    }

    async function captureOne(job) {
      var media = job.message.media;

      if (shouldCancel()) {
        media.missing = true;
        return;
      }

      var blob;
      try {
        if (/^wax-msg:/.test(job.url)) {
          var internalResult = await readInternal(job.url.slice('wax-msg:'.length));
          blob = new Blob([internalResult.buffer], {
            type: internalResult.mimetype || media.mime || MIME_BY_KIND[media.kind] || '',
          });
        } else {
          var response = await fetch(job.url);
          if (!response.ok && response.status !== 0) {
            throw new Error('HTTP ' + response.status);
          }
          blob = await response.blob();
        }
      } catch (err) {
        media.missing = true;
        skipped++;
        // One warning per kind, not per file: a chat can have dozens of these.
        var kind = (media.kind || 'media') + (/^wax-msg:/.test(job.url) ? ':download' : '');
        var failure = failures[kind] || (failures[kind] = { count: 0, reason: '' });
        failure.count++;
        if (!failure.reason) failure.reason = err && err.message ? err.message : 'unknown error';
        return;
      }

      if (!blob || blob.size === 0) {
        media.missing = true;
        skipped++;
        return;
      }

      if (bytes + blob.size > maxBytes) {
        media.missing = true;
        skipped++;
        if (!warnings.some(isLimitWarning)) {
          warnings.push(
            'Media download stopped at the ' +
              WAEx.formatBytes(maxBytes) +
              ' limit. Increase the limit in options to include the rest.'
          );
        }
        return;
      }

      index++;
      var mime = blob.type || media.mime || MIME_BY_KIND[media.kind] || 'application/octet-stream';
      var ext = extensionFor(mime, media.kind);
      var baseName = media.fileName
        ? safeFileName(media.fileName, media.kind || 'file')
        : media.kind || 'file';
      // Avoid doubling the extension when the original name already ends with it.
      var hasExt = new RegExp('\\.' + ext + '$', 'i').test(baseName);
      var fileName = pad(index, 4) + '-' + baseName + (hasExt ? '' : '.' + ext);

      media.zipPath = 'media/' + fileName;
      media.mime = mime;
      media.bytes = blob.size;
      media.missing = false;

      bytes += blob.size;
      entries.push({ path: media.zipPath, blob: blob, messageId: job.message.id });
    }

    function isLimitWarning(text) {
      return text.indexOf('Media download stopped at the') === 0;
    }

    /**
     * Capture everything queued. Returns
     * { entries, captured, attempted, bytes, skipped, warnings }.
     */
    async function drain(progress) {
      var report = typeof progress === 'function' ? progress : onProgress;
      var attempted = pending.length;
      var captured = 0;
      var cursor = 0;

      async function worker() {
        while (true) {
          if (shouldCancel()) return;
          var i = cursor++;
          if (i >= pending.length) return;
          await captureOne(pending[i]);
          if (!pending[i].message.media.missing) captured++;
          report({
            attempted: attempted,
            captured: captured,
            bytes: bytes,
            skipped: skipped,
            done: cursor,
          });
        }
      }

      var workers = [];
      var count = Math.min(CONCURRENCY, pending.length);
      for (var w = 0; w < count; w++) workers.push(worker());
      await Promise.all(workers);

      Object.keys(failures).forEach(function (key) {
        var failure = failures[key];
        var kind = key.replace(/:download$/, '');
        var one = failure.count === 1;
        var what = one ? 'one ' + kind + ' file' : failure.count + ' ' + kind + ' files';
        var cause = /:download$/.test(key)
          ? 'WhatsApp could not download ' + (one ? 'it' : 'them') + ' (' + failure.reason + ')'
          : 'WhatsApp had probably already released ' + (one ? 'it' : 'them') + ' (' + failure.reason + ')';
        warnings.push(
          'Could not save ' + what + ': ' + cause + '. ' + (one ? 'It is' : 'They are') +
            ' marked as not loaded in the export.'
        );
      });

      return {
        entries: entries,
        captured: captured,
        attempted: attempted,
        bytes: bytes,
        skipped: skipped,
        warnings: warnings,
        cancelled: shouldCancel(),
      };
    }

    return {
      enqueue: enqueue,
      drain: drain,
      get queued() {
        return pending.length;
      },
      get captured() {
        return entries.length;
      },
      get bytes() {
        return bytes;
      },
    };
  }

  WAEx.media = {
    createCollector: createCollector,
    extensionFor: extensionFor,
    safeFileName: safeFileName,
    _internal: { EXTENSION_BY_MIME: EXTENSION_BY_MIME, MIME_BY_KIND: MIME_BY_KIND },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WAEx.media;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
