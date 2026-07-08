/* Minimal ZIP reader for .pixob — browser + Node 18+ (uses global DecompressionStream).
   Reads the central directory, inflates each *.json entry (stored or deflate),
   returns { filename: string(text) }. No external dependencies. */
(function (global) {
  function dv(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

  async function inflateRaw(bytes) {
    if (bytes.length === 0) return new Uint8Array(0);
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  // Find End Of Central Directory (scan backwards for 0x06054b50)
  function findEOCD(u8) {
    var sig = 0x06054b50;
    for (var i = u8.length - 22; i >= 0 && i >= u8.length - 22 - 65536; i--) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) {
        var d = dv(u8);
        return { cdOffset: d.getUint32(i + 16, true), cdCount: d.getUint16(i + 10, true) };
      }
    }
    throw new Error('Not a valid .pixob (no ZIP end-of-central-directory found).');
  }

  async function readZipJson(arrayBuffer, opts) {
    opts = opts || {};
    var u8 = new Uint8Array(arrayBuffer);
    var d = dv(u8);
    var eocd = findEOCD(u8);
    var files = {};
    var p = eocd.cdOffset;
    for (var n = 0; n < eocd.cdCount; n++) {
      if (d.getUint32(p, true) !== 0x02014b50) break; // central dir header sig
      var method = d.getUint16(p + 10, true);
      var compSize = d.getUint32(p + 20, true);
      var nameLen = d.getUint16(p + 28, true);
      var extraLen = d.getUint16(p + 30, true);
      var commentLen = d.getUint16(p + 32, true);
      var localOff = d.getUint32(p + 42, true);
      var name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;

      if (!/\.json$/i.test(name)) continue; // only JSON entries

      // Local header: recompute data start using the LOCAL name/extra lengths
      var lNameLen = d.getUint16(localOff + 26, true);
      var lExtraLen = d.getUint16(localOff + 28, true);
      var dataStart = localOff + 30 + lNameLen + lExtraLen;
      var comp = u8.subarray(dataStart, dataStart + compSize);
      var raw;
      if (method === 0) raw = comp;                    // stored
      else if (method === 8) raw = await inflateRaw(comp); // deflate
      else continue;
      files[name] = new TextDecoder().decode(raw);
    }
    return files;
  }

  // Parse the text map into JSON objects (skips unparseable files gracefully).
  function parseAll(textFiles) {
    var out = {};
    for (var fn in textFiles) {
      if (!textFiles.hasOwnProperty(fn)) continue;
      try { out[fn] = JSON.parse(textFiles[fn]); } catch (e) { /* skip */ }
    }
    return out;
  }

  var api = { readZipJson: readZipJson, parseAll: parseAll };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.BuilderDoctorZip = api;
})(typeof window !== 'undefined' ? window : globalThis);
