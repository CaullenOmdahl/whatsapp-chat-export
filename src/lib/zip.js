/**
 * Minimal ZIP writer (PKZIP 2.0 layout).
 *
 * Media downloads need their files bundled next to the report. Pulling in a zip
 * library would mean a build step and a supply-chain dependency, so this writes
 * standard archives by hand. Entries are STORE (uncompressed) by default, which is
 * the right trade-off for JPEG/MP4 payloads, and DEFLATE when the platform exposes
 * CompressionStream (reports are text and shrink a lot).
 *
 * Output is a Blob assembled from parts, so a 200 MB archive is never copied into a
 * single contiguous buffer.
 */
(function (global) {
  'use strict';

  var WAEx = (global.WAEx = global.WAEx || {});

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  /** CRC-32 of a byte array, as required by the ZIP format. */
  function crc32(bytes) {
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  var encoder = new TextEncoder();

  function encodeUtf8(text) {
    return encoder.encode(String(text));
  }

  function dosDateTime(date) {
    var d = date instanceof Date ? date : new Date();
    var year = d.getFullYear();
    if (year < 1980) year = 1980;
    var time =
      ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
    var day = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
    return { time: time, date: day };
  }

  /** Normalise entry names: forward slashes, no leading slash, no `..`. */
  function safeName(name) {
    var clean = String(name || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .split('/')
      .filter(function (part) {
        return part && part !== '.' && part !== '..';
      })
      .join('/');
    return clean || 'file';
  }

  function needsZip64(size) {
    return size > 0xffffffff;
  }

  function create() {
    var entries = [];
    var parts = [];
    var offset = 0;
    var seen = Object.create(null);
    var closed = false;

    /**
     * Add one file. `data` may be a Uint8Array, ArrayBuffer or Blob.
     * Resolves to the entry name that was used.
     */
    async function add(name, data, options) {
      if (closed) throw new Error('zip: archive already finalised');
      var opts = options || {};
      var entryName = uniqueName(safeName(name));

      var bytes = await toBytes(data);
      var method = 0;
      var payload = bytes;
      var crc = crc32(bytes);

      if (opts.compress !== false && typeof CompressionStream === 'function' && bytes.length > 256) {
        try {
          var deflated = await deflateRaw(bytes);
          if (deflated && deflated.length < bytes.length) {
            payload = deflated;
            method = 8;
          }
        } catch (err) {
          // Fall back to STORE; a bigger archive is better than a failed export.
          method = 0;
          payload = bytes;
        }
      }

      if (needsZip64(bytes.length)) {
        throw new Error('zip: single file exceeds 4 GB limit');
      }

      var nameBytes = encodeUtf8(entryName);
      var stamp = dosDateTime(opts.date || new Date());

      var header = new Uint8Array(30 + nameBytes.length);
      var view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true); // local file header signature
      view.setUint16(4, 20, true); // version needed
      view.setUint16(6, 0x0800, true); // UTF-8 filename flag
      view.setUint16(8, method, true);
      view.setUint16(10, stamp.time, true);
      view.setUint16(12, stamp.date, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, payload.length, true);
      view.setUint32(22, bytes.length, true);
      view.setUint16(26, nameBytes.length, true);
      view.setUint16(28, 0, true);
      header.set(nameBytes, 30);

      var entry = {
        name: entryName,
        nameBytes: nameBytes,
        method: method,
        crc: crc,
        compressedSize: payload.length,
        size: bytes.length,
        offset: offset,
        stamp: stamp,
      };

      parts.push(header, payload);
      offset += header.length + payload.length;
      entries.push(entry);
      seen[entryName.toLowerCase()] = true;
      return entryName;
    }

    /**
     * Add a directory entry so empty folders survive extraction.
     * Not strictly required by ZIP readers; provided for completeness.
     */
    function addDirectory(name) {
      var dirName = safeName(name).replace(/\/+$/, '') + '/';
      var nameBytes = encodeUtf8(dirName);
      var stamp = dosDateTime(new Date());
      var header = new Uint8Array(30 + nameBytes.length);
      var view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, stamp.time, true);
      view.setUint16(12, stamp.date, true);
      view.setUint32(14, 0, true);
      view.setUint32(18, 0, true);
      view.setUint32(22, 0, true);
      view.setUint16(26, nameBytes.length, true);
      view.setUint16(28, 0, true);
      header.set(nameBytes, 30);

      parts.push(header);
      entries.push({
        name: dirName,
        nameBytes: nameBytes,
        method: 0,
        crc: 0,
        compressedSize: 0,
        size: 0,
        offset: offset,
        stamp: stamp,
      });
      offset += header.length;
    }

    /** Build the archive. Returns a Blob. */
    function generate() {
      if (closed) throw new Error('zip: archive already finalised');
      closed = true;

      var centralParts = [];
      var centralSize = 0;

      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var rec = new Uint8Array(46 + e.nameBytes.length);
        var view = new DataView(rec.buffer);
        view.setUint32(0, 0x02014b50, true); // central directory signature
        view.setUint16(4, 20, true); // version made by
        view.setUint16(6, 20, true); // version needed
        view.setUint16(8, 0x0800, true); // UTF-8 flag
        view.setUint16(10, e.method, true);
        view.setUint16(12, e.stamp.time, true);
        view.setUint16(14, e.stamp.date, true);
        view.setUint32(16, e.crc, true);
        view.setUint32(20, e.compressedSize, true);
        view.setUint32(24, e.size, true);
        view.setUint16(28, e.nameBytes.length, true);
        view.setUint16(30, 0, true);
        view.setUint16(32, 0, true);
        view.setUint16(34, 0, true);
        view.setUint16(36, 0, true);
        view.setUint32(38, 0, true); // external attributes
        view.setUint32(42, e.offset, true);
        rec.set(e.nameBytes, 46);
        centralParts.push(rec);
        centralSize += rec.length;
      }

      var end = new Uint8Array(22);
      var endView = new DataView(end.buffer);
      endView.setUint32(0, 0x06054b50, true);
      endView.setUint16(4, 0, true);
      endView.setUint16(6, 0, true);
      endView.setUint16(8, entries.length, true);
      endView.setUint16(10, entries.length, true);
      endView.setUint32(12, centralSize, true);
      endView.setUint32(16, offset, true);
      endView.setUint16(20, 0, true);

      var blobParts = parts.concat(centralParts, [end]);
      return new Blob(blobParts, { type: 'application/zip' });
    }

    /** Archive size in bytes (only known after generate()). */
    function size() {
      if (!closed) throw new Error('zip: call generate() first');
      var total = offset;
      for (var i = 0; i < entries.length; i++) {
        total += 46 + entries[i].nameBytes.length;
      }
      return total + 22;
    }

    function uniqueName(name) {
      if (!seen[name.toLowerCase()]) return name;
      var dot = name.lastIndexOf('.');
      var base = dot > 0 ? name.slice(0, dot) : name;
      var ext = dot > 0 ? name.slice(dot) : '';
      var n = 2;
      var candidate = base + ' (' + n + ')' + ext;
      while (seen[candidate.toLowerCase()]) {
        n++;
        candidate = base + ' (' + n + ')' + ext;
      }
      return candidate;
    }

    return {
      add: add,
      addDirectory: addDirectory,
      generate: generate,
      size: size,
      get count() {
        return entries.length;
      },
      get names() {
        return entries.map(function (e) {
          return e.name;
        });
      },
    };
  }

  async function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data && typeof data.arrayBuffer === 'function') {
      return new Uint8Array(await data.arrayBuffer());
    }
    if (typeof data === 'string') return encodeUtf8(data);
    throw new Error('zip: unsupported entry payload');
  }

  async function deflateRaw(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    var buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  }

  WAEx.zip = {
    create: create,
    crc32: crc32,
    encodeUtf8: encodeUtf8,
    _internal: { dosDateTime: dosDateTime, safeName: safeName, crc32: crc32 },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WAEx.zip;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
