/**
 * Content-script orchestrator.
 *
 * Runs inside web.whatsapp.com. Owns the export state machine, drives the scraper,
 * packages the result and triggers the download. The popup is only a view: closing it
 * mid-export does not interrupt anything, and re-opening it reads the live state back
 * through a ping.
 */
(function (global) {
  'use strict';

  var WAEx = (global.WAEx = global.WAEx || {});

  if (WAEx.__contentReady) return;
  WAEx.__contentReady = true;

  var extractor = WAEx.extractor;
  var formats = WAEx.formats;
  var media = WAEx.media;
  var dt = WAEx.datetime;
  var zip = WAEx.zip;
  var T = WAEx.MESSAGE_TYPES;
  var PHASE = WAEx.PHASE;

  /** How long a finished export stays "current" for a re-opened popup. */
  var RESULT_TTL_MS = 120000;
  var PROGRESS_STORAGE_THROTTLE_MS = 200;

  var running = false;
  var cancelRequested = false;
  var lastState = null;
  var lastProgressWrite = 0;
  var lastChatName = '';

  /* ------------------------------------------------------------- messaging */

  function send(type, payload) {
    var message = { type: type };
    if (payload) {
      for (var key in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) message[key] = payload[key];
      }
    }
    try {
      chrome.runtime.sendMessage(message, function () {
        // Reading lastError prevents "Unchecked runtime.lastError" noise when the
        // popup is closed and nobody is listening.
        void chrome.runtime.lastError;
      });
    } catch (err) {
      /* extension context invalidated (reload) - nothing to notify */
    }
  }

  function sendProgress(state) {
    send(WAEx.MSG.PROGRESS, {
      phase: state.phase,
      loaded: state.loaded,
      total: state.total,
      detail: state.detail,
      percent: state.percent,
      startedAt: state.startedAt,
    });
  }

  function sendResult(result) {
    send(WAEx.MSG.RESULT, result);
  }

  function mirrorState(state) {
    var now = Date.now();
    var force = !state || state.phase === PHASE.DONE || state.phase === PHASE.ERROR || state.phase === PHASE.CANCELLED;
    if (!force && now - lastProgressWrite < PROGRESS_STORAGE_THROTTLE_MS) return;
    lastProgressWrite = now;
    try {
      if (!chrome.storage || !chrome.storage.session) return;
      chrome.storage.session.set({ [WAEx.STATE_KEY]: state }, function () {
        void chrome.runtime.lastError;
      });
    } catch (err) {
      /* storage.session may be unavailable in older Chrome; harmless */
    }
  }

  /* ----------------------------------------------------------- state utils */

  function createState(seed) {
    var base = {
      phase: PHASE.IDLE,
      loaded: 0,
      total: null,
      detail: '',
      percent: null,
      startedAt: 0,
      finishedAt: null,
      warnings: [],
    };
    if (seed) {
      for (var key in seed) {
        if (Object.prototype.hasOwnProperty.call(seed, key)) base[key] = seed[key];
      }
    }
    return base;
  }

  function setPhase(phase, detail, extra) {
    lastState = lastState || createState();
    lastState.phase = phase;
    if (detail !== undefined) lastState.detail = detail;
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) lastState[key] = extra[key];
      }
    }
    sendProgress(lastState);
    mirrorState(lastState);
  }

  function reportProgress(update) {
    if (!lastState) return;
    if (update.loaded !== undefined) lastState.loaded = update.loaded;
    if (update.total !== undefined) lastState.total = update.total;
    if (update.percent !== undefined) lastState.percent = update.percent;
    if (update.detail !== undefined) lastState.detail = update.detail;
    sendProgress(lastState);
    mirrorState(lastState);
  }

  /** Live-export state for the popup, or null when nothing recent happened. */
  function currentStateForPopup() {
    if (!lastState) return null;
    if (running) return lastState;
    var finished = lastState.finishedAt || 0;
    if (finished && Date.now() - finished < RESULT_TTL_MS) return lastState;
    return null;
  }

  /* -------------------------------------------------------------- download */

  function saveBlob(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);

    try {
      link.click();
    } finally {
      setTimeout(function () {
        try {
          link.remove();
          URL.revokeObjectURL(url);
        } catch (err) {
          /* already gone */
        }
      }, 60000);
    }
  }

  function historyEntry(result, settings) {
    return {
      filename: result.filename,
      messageCount: result.messageCount,
      bytes: result.bytes,
      format: settings.format,
      mediaMode: settings.mediaMode,
      at: Date.now(),
    };
  }

  function rememberExport(entry) {
    try {
      chrome.storage.local.get([WAEx.HISTORY_KEY], function (data) {
        void chrome.runtime.lastError;
        var history = (data && data[WAEx.HISTORY_KEY]) || [];
        if (!Array.isArray(history)) history = [];
        history.unshift(entry);
        chrome.storage.local.set({ [WAEx.HISTORY_KEY]: history.slice(0, WAEx.HISTORY_LIMIT) }, function () {
          void chrome.runtime.lastError;
        });
      });
    } catch (err) {
      /* history is a nicety, never fail the export over it */
    }
  }

  /* ---------------------------------------------------------------- export */

  async function runExport(rawSettings) {
    if (running) {
      throw new extractor.ExportError(
        'ALREADY_RUNNING',
        'An export is already running.',
        'Wait for it to finish, or press Cancel first.'
      );
    }

    var settings = WAEx.normalizeSettings(rawSettings);
    running = true;
    cancelRequested = false;

    lastState = createState({
      phase: PHASE.SCROLLING,
      startedAt: Date.now(),
      detail: 'Loading messages',
      percent: null,
    });
    sendProgress(lastState);
    mirrorState(lastState);

    var history = null;
    var bounds = dt.rangeForSettings(settings);
    var warnings = [];
    var mediaResult = null;

    try {
      var chatInfo = extractor.getChatInfo();
      if (!chatInfo.found) {
        throw new extractor.ExportError(
          'NO_CONVERSATION',
          chatInfo.reason || 'Open a conversation in WhatsApp Web first.',
          'Click a chat in the left sidebar, wait for the messages to appear, then retry.'
        );
      }

      if (chatInfo.name !== lastChatName) {
        extractor.resetDateOrderCache();
        lastChatName = chatInfo.name;
      }

      setPhase(PHASE.SCROLLING, 'Loading older messages', { loaded: 0, percent: bounds.start ? 2 : null });

      // ---- phase 1: load history -------------------------------------------------
      history = await extractor.loadAllHistory({
        dateBounds: bounds,
        includeReactions: settings.includeReactions,
        shouldCancel: function () {
          return cancelRequested;
        },
        onProgress: function (progress) {
          var percent = null;
          var end = bounds.end || Date.now();

          if (bounds.start && bounds.end) {
            // Both ends known: progress from the oldest loaded message to the range end.
            if (progress.newest !== null && bounds.end > bounds.start) {
              var coveredBoth = (progress.newest - bounds.start) / (bounds.end - bounds.start);
              percent = Math.max(3, Math.min(96, Math.round(coveredBoth * 100)));
            }
          } else if (bounds.start) {
            if (progress.oldest !== null && end > bounds.start) {
              var covered = (end - progress.oldest) / (end - bounds.start);
              percent = Math.max(3, Math.min(96, Math.round(covered * 100)));
            }
          }

          var detail = 'Scrolling back through history';
          if (progress.direction === 'down') {
            detail = 'Catching up to the newest message';
          } else if (progress.atTop) {
            detail = 'Reached the oldest message';
          }

          reportProgress({
            loaded: progress.loaded,
            percent: percent,
            detail: detail,
          });
        },
      });

      warnings = warnings.concat(history.warnings || []);
      if (cancelRequested) throw cancelledError();

      // ---- phase 2: parse --------------------------------------------------------
      setPhase(PHASE.PARSING, 'Reading messages', {
        loaded: history.loaded,
        percent: bounds.start ? 97 : null,
      });

      // loadAllHistory parsed every message it saw while scrolling, so messages that
      // WhatsApp removed from the DOM afterwards are still in the export.
      var messages = Array.isArray(history.messages) ? history.messages.slice() : null;
      if (!messages) {
        var parsed = extractor.parseMessages({
          main: history.main,
          harvested: history.seen,
          includeReactions: settings.includeReactions,
        });
        warnings = warnings.concat(parsed.warnings || []);
        messages = parsed.messages;
      }

      // System messages are collected always; the option only decides whether they ship.
      if (!settings.includeSystem) {
        messages = messages.filter(function (m) {
          return m.type !== T.SYSTEM;
        });
      }

      if (bounds.start !== null || bounds.end !== null) {
        messages = messages.filter(function (m) {
          if (m.timestamp === null || m.timestamp === undefined) return false;
          return dt.inRange(m.timestamp, bounds);
        });
      }

      if (!messages.length) {
        throw new extractor.ExportError(
          'NO_MESSAGES',
          'No messages matched this export.',
          bounds.start
            ? 'Try widening the date range, or load more history by scrolling up in the chat.'
            : 'Wait for the conversation to finish loading, then try again.'
        );
      }

      // ---- phase 3: media --------------------------------------------------------
      if (settings.mediaMode === 'download') {
        var collector = media.createCollector({
          maxBytes: Math.max(1, settings.maxMediaMb) * 1024 * 1024,
          shouldCancel: function () {
            return cancelRequested;
          },
          onProgress: function (progress) {
            var percent =
              progress.attempted > 0
                ? Math.round((progress.done / progress.attempted) * 100)
                : 100;
            reportProgress({
              percent: percent,
              detail:
                'Saving media ' +
                Math.min(progress.done, progress.attempted) +
                ' of ' +
                progress.attempted,
            });
          },
        });

        for (var i = 0; i < messages.length; i++) {
          collector.enqueue(messages[i]);
        }

        if (collector.queued > 0) {
          setPhase(PHASE.MEDIA, 'Saving media', { percent: 0, total: collector.queued });
          mediaResult = await collector.drain();
          warnings = warnings.concat(mediaResult.warnings || []);
          if (cancelRequested) throw cancelledError();
        }
      }

      // ---- phase 4: build --------------------------------------------------------
      setPhase(PHASE.BUILDING, 'Building file', { percent: null });

      var stats = formats.summarize(messages);
      var isGroup = chatInfo.isGroup || stats.authors.length > 1;

      var meta = {
        chat: { name: chatInfo.name, isGroup: isGroup },
        exportedAt: Date.now(),
        settings: settings,
        stats: stats,
      };

      var serialized = formats.serialize(settings.format, messages, meta);
      var baseName = formats.buildBaseName(chatInfo.name, meta.exportedAt);
      var reportFileName = baseName + '.' + serialized.extension;
      var reportBlob = new Blob([serialized.text], { type: serialized.mime });
      var blob = reportBlob;
      var fileName = reportFileName;

      var capturedMedia = mediaResult ? mediaResult.entries : [];
      if (capturedMedia.length > 0) {
        var archive = zip.create();
        await archive.add(reportFileName, reportBlob, { compress: true });
        for (var e = 0; e < capturedMedia.length; e++) {
          await archive.add(capturedMedia[e].path, capturedMedia[e].blob, { compress: false });
        }
        blob = archive.generate();
        fileName = baseName + '.zip';
      }

      if (cancelRequested) throw cancelledError();

      // ---- phase 5: save ---------------------------------------------------------
      setPhase(PHASE.SAVING, 'Saving file', { percent: 100, total: null });
      saveBlob(blob, fileName);

      var result = {
        ok: true,
        filename: fileName,
        bytes: blob.size,
        messageCount: stats.total,
        format: settings.format,
        zipped: capturedMedia.length > 0,
        mediaCaptured: capturedMedia.length,
        mediaMissing: messages.filter(function (m) {
          return m.media && m.media.missing;
        }).length,
        warnings: warnings,
        chatName: chatInfo.name,
        isGroup: isGroup,
        dateRange: stats.range,
      };

      lastState.phase = PHASE.DONE;
      lastState.finishedAt = Date.now();
      lastState.filename = fileName;
      lastState.bytes = blob.size;
      lastState.messageCount = stats.total;
      lastState.warnings = warnings;
      lastState.detail = 'Export complete';
      lastState.percent = 100;
      sendProgress(lastState);
      mirrorState(lastState);

      var entry = historyEntry(result, settings);
      rememberExport(entry);
      result.historyEntry = entry;

      sendResult(result);
      return result;
    } catch (err) {
      var error = normalizeError(err);

      lastState = lastState || createState();
      lastState.phase = error.code === 'CANCELLED' ? PHASE.CANCELLED : PHASE.ERROR;
      lastState.finishedAt = Date.now();
      lastState.detail = error.message;
      lastState.error = error;
      sendProgress(lastState);
      mirrorState(lastState);

      sendResult({ ok: false, error: error, warnings: warnings });
      return { ok: false, error: error };
    } finally {
      running = false;
      cancelRequested = false;
      if (settings.restoreScroll && history) {
        extractor.restoreScroll(history);
      }
    }
  }

  function cancelledError() {
    return new extractor.ExportError(
      'CANCELLED',
      'Export cancelled.',
      'Nothing was saved. Run the export again whenever you are ready.'
    );
  }

  function normalizeError(err) {
    if (err && err.code && err.message) {
      return { code: err.code, message: err.message, hint: err.hint || '' };
    }
    var message = err && err.message ? String(err.message) : 'Unexpected error during export.';
    var hint = 'Reload the WhatsApp tab and try again. If it keeps failing, open Diagnostics in the popup.';
    if (/Extension context invalidated/i.test(message)) {
      hint = 'WhatsApp was reloaded while exporting. Reopen the popup and run the export again.';
    }
    return { code: 'EXPORT_FAILED', message: message, hint: hint };
  }

  /* ------------------------------------------------------------- listeners */

  function replyWithChat(sendResponse) {
    var chat;
    try {
      chat = extractor.getChatInfo();
    } catch (err) {
      chat = {
        found: false,
        reason: 'Could not read the conversation panel: ' + (err && err.message ? err.message : err),
        name: '',
        isGroup: false,
        initials: '?',
        renderedCount: 0,
        dateRange: null,
      };
    }

    sendResponse({
      ok: true,
      chat: chat,
      state: currentStateForPopup(),
      running: running,
      version: WAEx.VERSION || '',
    });
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || typeof message.type !== 'string') return false;

    switch (message.type) {
      case WAEx.MSG.PING:
        replyWithChat(sendResponse);
        return true;

      case WAEx.MSG.SCAN:
        replyWithChat(sendResponse);
        return true;

      case WAEx.MSG.EXPORT:
        if (running) {
          sendResponse({
            accepted: false,
            error: {
              code: 'ALREADY_RUNNING',
              message: 'An export is already running.',
              hint: 'Wait for it to finish, or press Cancel.',
            },
          });
          return true;
        }
        sendResponse({ accepted: true });
        // Fire and forget: progress and the final result arrive as broadcasts.
        runExport(message.settings).catch(function (err) {
          void err;
        });
        return true;

      case WAEx.MSG.CANCEL:
        if (running) {
          cancelRequested = true;
          sendResponse({ ok: true, cancelling: true });
        } else {
          sendResponse({ ok: true, cancelling: false });
        }
        return true;

      case WAEx.MSG.DIAGNOSE:
        try {
          var report = extractor.diagnose();
          sendResponse(report);
          send(WAEx.MSG.DIAGNOSTICS, { report: report });
        } catch (err) {
          sendResponse({
            url: String(global.location && global.location.href),
            mainPanel: false,
            messageList: false,
            scrollContainer: false,
            renderedRows: 0,
            parsedMessages: 0,
            selectors: [],
            warnings: ['Diagnostics failed: ' + (err && err.message ? err.message : err)],
            version: WAEx.VERSION || '',
          });
        }
        return true;

      default:
        return false;
    }
  });

  // Keep the mirror honest if the popup never sees a final broadcast.
  global.addEventListener('beforeunload', function () {
    if (running) {
      try {
        chrome.storage.session.set({
          [WAEx.STATE_KEY]: {
            phase: PHASE.ERROR,
            detail: 'WhatsApp was reloaded during the export.',
            finishedAt: Date.now(),
            error: {
              code: 'PAGE_RELOADED',
              message: 'WhatsApp was reloaded during the export.',
              hint: 'Run the export again from the popup.',
            },
          },
        });
      } catch (err) {
        /* ignore */
      }
    }
  });

  WAEx.content = {
    runExport: runExport,
    getState: currentStateForPopup,
    version: WAEx.VERSION,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
