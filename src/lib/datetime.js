/**
 * Date and time handling.
 *
 * WhatsApp Web exposes each message's timestamp only as *rendered text* inside the
 * `data-pre-plain-text` attribute, e.g.
 *
 *     [10:30 AM, 11/14/2023] Alice: 
 *     [10:30, 14/11/2023] Bob: 
 *     [22:05:12, 2023-11-14] Carol: 
 *
 * The layout depends on the user's WhatsApp language, so nothing here assumes a
 * fixed format: every value is parsed defensively and ambiguous day/month order is
 * inferred from the whole conversation.
 */
(function (global) {
  'use strict';

  var WAEx = (global.WAEx = global.WAEx || {});
  var MS_DAY = 86400000;

  var MONTHS = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, sept: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };

  var MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /**
   * Split `[time, date] Author: ` into its parts.
   * Returns null when the attribute does not follow the expected shape.
   */
  function parsePrePlainText(raw) {
    if (typeof raw !== 'string' || raw.indexOf('[') !== 0) return null;

    var close = raw.indexOf(']');
    if (close < 0) return null;

    var inner = raw.slice(1, close);
    var cut = inner.lastIndexOf(',');
    if (cut < 0) return null;

    var timeText = inner.slice(0, cut).trim();
    var dateText = inner.slice(cut + 1).trim();

    var rest = raw.slice(close + 1).replace(/^\s+/, '');
    // Trailing ": " is the separator WhatsApp puts between the author and the body.
    var author = rest.replace(/:\s*$/, '').trim();

    if (!timeText || !dateText) return null;

    return {
      timeText: timeText,
      dateText: dateText,
      author: author,
    };
  }

  /** Parse `10:30`, `10:30:12`, `10:30 AM`, `10:30 p.m.` */
  function parseTimeText(text) {
    if (typeof text !== 'string') return null;
    var m = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?/i);
    if (!m) return null;

    var hours = parseInt(m[1], 10);
    var minutes = parseInt(m[2], 10);
    var seconds = m[3] ? parseInt(m[3], 10) : 0;
    var meridiem = m[4] ? m[4].toLowerCase() : '';

    if (meridiem) {
      if (hours === 12) hours = 0;
      if (meridiem === 'p') hours += 12;
    }

    if (hours > 23 || minutes > 59 || seconds > 59) return null;

    return { hours: hours, minutes: minutes, seconds: seconds };
  }

  /**
   * Parse the date half. `order` is 'dmy', 'mdy' or 'auto'.
   * Returns { year, month, day } or null.
   */
  function parseDateText(text, order) {
    if (typeof text !== 'string') return null;
    var raw = text.trim();
    if (!raw) return null;

    // ISO-first: 2023-11-14
    var iso = raw.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
    if (iso) {
      var year = parseInt(iso[1], 10);
      var month = parseInt(iso[2], 10);
      var day = parseInt(iso[3], 10);
      return validParts(year, month, day);
    }

    // Numeric day/month/year with either separator.
    var num = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (num) {
      var a = parseInt(num[1], 10);
      var b = parseInt(num[2], 10);
      var y = parseInt(num[3], 10);
      if (y < 100) y += y > 69 ? 1900 : 2000;

      var useDmy;
      if (a > 12 && b <= 12) useDmy = true;
      else if (b > 12 && a <= 12) useDmy = false;
      else if (order === 'mdy') useDmy = false;
      else useDmy = true; // 'dmy' and 'auto' both default to day-first

      return useDmy ? validParts(y, b, a) : validParts(y, a, b);
    }

    // 14 Nov 2023 / 14 November 2023
    var dMonY = raw.match(/^(\d{1,2})\s+([A-Za-zÀ-ÿ.]+)\.?\s+(\d{2,4})$/);
    if (dMonY) {
      var mon = MONTHS[dMonY[2].toLowerCase().replace('.', '')];
      if (mon) return validParts(parseYear(dMonY[3]), mon, parseInt(dMonY[1], 10));
    }

    // Nov 14, 2023 / November 14 2023
    var monDY = raw.match(/^([A-Za-zÀ-ÿ.]+)\.?\s+(\d{1,2}),?\s+(\d{2,4})$/);
    if (monDY) {
      var mon2 = MONTHS[monDY[1].toLowerCase().replace('.', '')];
      if (mon2) return validParts(parseYear(monDY[3]), mon2, parseInt(monDY[2], 10));
    }

    return null;
  }

  function parseYear(text) {
    var y = parseInt(text, 10);
    if (y < 100) y += y > 69 ? 1900 : 2000;
    return y;
  }

  function validParts(year, month, day) {
    if (!year || !month || !day) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Reject impossible dates such as 31 February.
    var probe = new Date(year, month - 1, day);
    if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
      return null;
    }
    return { year: year, month: month, day: day };
  }

  /** Combine parsed date + time parts into an epoch timestamp in local time. */
  function toEpoch(dateParts, timeParts) {
    if (!dateParts) return null;
    var time = timeParts || { hours: 0, minutes: 0, seconds: 0 };
    var d = new Date(
      dateParts.year,
      dateParts.month - 1,
      dateParts.day,
      time.hours,
      time.minutes,
      time.seconds,
      0
    );
    var ts = d.getTime();
    return isNaN(ts) ? null : ts;
  }

  /**
   * Pick day-first vs month-first by scanning many dates.
   * Any date whose first component exceeds 12 proves day-first, and vice versa.
   */
  function inferDateOrder(samples, fallback) {
    var dmy = 0;
    var mdy = 0;

    for (var i = 0; i < samples.length; i++) {
      var text = typeof samples[i] === 'string' ? samples[i].trim() : '';
      var m = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
      if (!m) continue;
      var a = parseInt(m[1], 10);
      var b = parseInt(m[2], 10);
      if (a > 12 && b <= 12) dmy++;
      else if (b > 12 && a <= 12) mdy++;
    }

    if (dmy > mdy) return 'dmy';
    if (mdy > dmy) return 'mdy';
    return fallback || 'dmy';
  }

  /** Guess day/month order from a BCP-47 language tag (en-US is month-first). */
  function suggestOrderFromLocale(language) {
    var lang = String(language || '').toLowerCase();
    if (!lang) return 'dmy';
    var monthFirst = [
      'en-us', 'en-ph', 'en-ca', 'en-za', 'en-bz', 'en-jm', 'en-pr',
      'es-us', 'es-mx', 'es-pr', 'es-ph', 'ja', 'ja-jp', 'ko', 'ko-kr',
      'zh', 'zh-cn', 'zh-tw', 'zh-hk', 'zh-sg', 'he', 'he-il', 'ar', 'ar-sa',
      'fa', 'fa-ir',
    ];
    for (var i = 0; i < monthFirst.length; i++) {
      if (lang === monthFirst[i] || lang.indexOf(monthFirst[i] + '-') === 0) return 'mdy';
    }
    // Taiwanese/Hungarian style year-first still resolves unambiguously elsewhere.
    return 'dmy';
  }

  /** Local calendar day key, e.g. 2023-11-14 */
  function dateKey(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** Local ISO date, for <input type="date"> values. */
  function isoDate(ts) {
    return dateKey(ts);
  }

  /** Parse a YYYY-MM-DD value as local start-of-day. */
  function parseIsoDate(value, endOfDay) {
    if (typeof value !== 'string') return null;
    var m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    if (isNaN(d.getTime())) return null;
    if (endOfDay) {
      d.setHours(23, 59, 59, 999);
    }
    return d.getTime();
  }

  /** Stable, locale-independent display date: 14 Nov 2023 */
  function formatDate(ts) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getDate() + ' ' + MONTH_SHORT[d.getMonth()] + ' ' + d.getFullYear();
  }

  /** Stable 24-hour clock with seconds: 10:30:05 */
  function formatTime(ts, withSeconds) {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var base = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return withSeconds ? base + ':' + pad2(d.getSeconds()) : base;
  }

  /** 2023-11-14 10:30:05 */
  function formatDateTime(ts) {
    if (!ts) return '';
    return dateKey(ts) + ' ' + formatTime(ts, true);
  }

  /** Compact duration for the UI: 3d ago, 2h ago, 5m ago, just now */
  function relativeTime(ts, now) {
    var reference = now || Date.now();
    var diff = Math.max(0, reference - ts);
    if (diff < 45000) return 'just now';
    var minutes = Math.round(diff / 60000);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.round(hours / 24);
    if (days < 30) return days + 'd ago';
    var months = Math.round(days / 30);
    if (months < 12) return months + 'mo ago';
    return Math.round(months / 12) + 'y ago';
  }

  /**
   * Resolve the settings' date range into epoch bounds.
   * Returns `{ start, end }` where either side may be null (unbounded).
   */
  function rangeForSettings(settings, now) {
    var reference = now || Date.now();
    var range = settings && settings.dateRange;

    if (range === 'custom') {
      return {
        start: parseIsoDate(settings.customStart, false),
        end: parseIsoDate(settings.customEnd, true),
      };
    }

    var preset = null;
    var presets = WAEx.DATE_RANGES || [];
    for (var i = 0; i < presets.length; i++) {
      if (presets[i].id === range) preset = presets[i];
    }

    if (!preset || !preset.days) return { start: null, end: null };

    var startDate = new Date(reference - preset.days * MS_DAY);
    startDate.setHours(0, 0, 0, 0);
    return { start: startDate.getTime(), end: null };
  }

  /** True when `ts` falls inside the bounds (nulls are unbounded). */
  function inRange(ts, bounds) {
    if (!bounds) return true;
    if (bounds.start !== null && bounds.start !== undefined && ts < bounds.start) return false;
    if (bounds.end !== null && bounds.end !== undefined && ts > bounds.end) return false;
    return true;
  }

  /** "14 Nov 2023" -> "14 Nov 2023 – 16 Nov 2023" for the chat summary line. */
  function formatRange(range) {
    if (!range) return '';
    if (range.start === range.end) return formatDate(range.start);
    return formatDate(range.start) + ' – ' + formatDate(range.end);
  }

  WAEx.datetime = {
    MS_DAY: MS_DAY,
    parsePrePlainText: parsePrePlainText,
    parseTimeText: parseTimeText,
    parseDateText: parseDateText,
    toEpoch: toEpoch,
    inferDateOrder: inferDateOrder,
    suggestOrderFromLocale: suggestOrderFromLocale,
    dateKey: dateKey,
    isoDate: isoDate,
    parseIsoDate: parseIsoDate,
    formatDate: formatDate,
    formatTime: formatTime,
    formatDateTime: formatDateTime,
    relativeTime: relativeTime,
    rangeForSettings: rangeForSettings,
    inRange: inRange,
    formatRange: formatRange,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WAEx.datetime;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
