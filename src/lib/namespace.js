/**
 * Shared namespace, constants and settings defaults.
 *
 * Loaded first in every extension context (content script, popup, service worker)
 * as a classic script. Everything hangs off a single global so the extension stays
 * dependency-free and works in Chrome's isolated world.
 */
(function (global) {
  'use strict';

  var WAEx = (global.WAEx = global.WAEx || {});

  /** Extension version, mirrored in manifest.json. */
  WAEx.VERSION = '1.0.2';

  /** Bump when the persisted settings shape changes. */
  WAEx.SETTINGS_VERSION = 1;

  /**
   * Content-script files, in load order. Used both by manifest.json and when the
   * popup injects the scripts on demand into an already-open WhatsApp tab.
   */
  WAEx.CONTENT_FILES = [
    'src/lib/namespace.js',
    'src/lib/datetime.js',
    'src/lib/zip.js',
    'src/lib/formats.js',
    'src/content/extractor.js',
    'src/content/media.js',
    'src/content/content.js',
  ];

  /** storage.local key holding the user's saved options. */
  WAEx.STORAGE_KEY = 'wax:settings';

  /** storage.session key mirroring live export state (survives popup close). */
  WAEx.STATE_KEY = 'wax:state';

  /** storage.local key holding a short history of exports. */
  WAEx.HISTORY_KEY = 'wax:history';

  /** Maximum entries kept in the recent-export history. */
  WAEx.HISTORY_LIMIT = 5;

  /** Formats the user can export to. */
  WAEx.FORMATS = [
    {
      id: 'html',
      label: 'HTML',
      extension: 'html',
      blurb: 'Styled transcript that opens in any browser',
    },
    {
      id: 'txt',
      label: 'Text',
      extension: 'txt',
      blurb: 'Plain text, close to what WhatsApp shows',
    },
    {
      id: 'json',
      label: 'JSON',
      extension: 'json',
      blurb: 'Structured data for scripts and analysis',
    },
    {
      id: 'csv',
      label: 'CSV',
      extension: 'csv',
      blurb: 'One row per message, opens in Excel or Sheets',
    },
  ];

  /** Media handling strategies. */
  WAEx.MEDIA_MODES = [
    { id: 'skip', label: 'None', blurb: 'Text only, smallest file' },
    { id: 'link', label: 'Placeholders', blurb: 'Note where each media item was' },
    { id: 'download', label: 'Download', blurb: 'Save media files into a .zip' },
  ];

  /** Date range presets, in days back from now. `null` means "everything". */
  WAEx.DATE_RANGES = [
    { id: 'all', label: 'All time', days: null },
    { id: '7d', label: 'Last 7 days', days: 7 },
    { id: '30d', label: 'Last 30 days', days: 30 },
    { id: '90d', label: 'Last 90 days', days: 90 },
    { id: 'custom', label: 'Custom range', days: null },
  ];

  /** Message kinds produced by the extractor. */
  WAEx.MESSAGE_TYPES = {
    TEXT: 'text',
    IMAGE: 'image',
    VIDEO: 'video',
    AUDIO: 'audio',
    VOICE: 'voice',
    DOCUMENT: 'document',
    STICKER: 'sticker',
    GIF: 'gif',
    CONTACT: 'contact',
    LOCATION: 'location',
    POLL: 'poll',
    LINK: 'link',
    DELETED: 'deleted',
    SYSTEM: 'system',
    UNKNOWN: 'unknown',
  };

  /** Runtime message types (popup <-> content script). */
  WAEx.MSG = {
    PING: 'WAX:PING',
    SCAN: 'WAX:SCAN',
    EXPORT: 'WAX:EXPORT',
    CANCEL: 'WAX:CANCEL',
    DIAGNOSE: 'WAX:DIAGNOSE',
    DIAGNOSTICS: 'WAX:DIAGNOSTICS',
    PROGRESS: 'WAX:PROGRESS',
    RESULT: 'WAX:RESULT',
  };

  /** Export phases, in the order they run. */
  WAEx.PHASE = {
    IDLE: 'idle',
    SCROLLING: 'scrolling',
    PARSING: 'parsing',
    MEDIA: 'media',
    BUILDING: 'building',
    SAVING: 'saving',
    DONE: 'done',
    CANCELLED: 'cancelled',
    ERROR: 'error',
  };

  /** Defaults for every user-facing option. */
  WAEx.DEFAULT_SETTINGS = {
    version: WAEx.SETTINGS_VERSION,
    format: 'html',
    dateRange: 'all',
    customStart: '',
    customEnd: '',
    mediaMode: 'link',
    includeSystem: false,
    includeReactions: true,
    senderLabels: true,
    /** Hard ceiling on downloaded media, in megabytes. */
    maxMediaMb: 250,
    /** Restore the chat scroll position when the export finishes. */
    restoreScroll: true,
  };

  /** Coerce unknown input into a valid settings object. */
  WAEx.normalizeSettings = function (input) {
    var out = {};
    var d = WAEx.DEFAULT_SETTINGS;
    var src = input && typeof input === 'object' ? input : {};

    Object.keys(d).forEach(function (key) {
      out[key] = src[key] === undefined ? d[key] : src[key];
    });

    var formats = WAEx.FORMATS.map(function (f) {
      return f.id;
    });
    var mediaModes = WAEx.MEDIA_MODES.map(function (m) {
      return m.id;
    });
    var ranges = WAEx.DATE_RANGES.map(function (r) {
      return r.id;
    });

    if (formats.indexOf(out.format) === -1) out.format = d.format;
    if (mediaModes.indexOf(out.mediaMode) === -1) out.mediaMode = d.mediaMode;
    if (ranges.indexOf(out.dateRange) === -1) out.dateRange = d.dateRange;

    out.includeSystem = Boolean(out.includeSystem);
    out.includeReactions = Boolean(out.includeReactions);
    out.senderLabels = Boolean(out.senderLabels);
    out.restoreScroll = Boolean(out.restoreScroll);

    out.maxMediaMb = Math.max(0, Math.min(2048, Number(out.maxMediaMb) || 0));

    out.customStart = typeof out.customStart === 'string' ? out.customStart : '';
    out.customEnd = typeof out.customEnd === 'string' ? out.customEnd : '';
    out.version = WAEx.SETTINGS_VERSION;

    return out;
  };

  /** Look up a format descriptor by id. */
  WAEx.getFormat = function (id) {
    for (var i = 0; i < WAEx.FORMATS.length; i++) {
      if (WAEx.FORMATS[i].id === id) return WAEx.FORMATS[i];
    }
    return WAEx.FORMATS[0];
  };

  /** Human readable byte size, e.g. 1.4 MB. */
  WAEx.formatBytes = function (bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB'];
    var value = n / 1024;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    return (value < 10 ? value.toFixed(1) : Math.round(value)) + ' ' + units[i];
  };

  /** Count messages with a simple plural helper. */
  WAEx.plural = function (count, singular, plural) {
    return (Number(count) || 0) + ' ' + (Number(count) === 1 ? singular : plural || singular + 's');
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WAEx;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
