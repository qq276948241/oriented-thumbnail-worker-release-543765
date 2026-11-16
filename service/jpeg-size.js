'use strict';

// Start-Of-Frame markers (all except DHT/DAC/RST which share the range).
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function isStandalone(marker) {
  return marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/**
 * Cheap header-only probe of a JPEG buffer: walks markers until the first
 * Start-Of-Frame and returns { width, height }. Returns null when the bytes
 * are not a parseable JPEG. Runs in microseconds even on large uploads, so
 * it is safe to do on the HTTP thread before admitting a task.
 */
function jpegDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null; // SOI
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return null;
    // Skip fill bytes (0xFF padding) before the marker code.
    let pos = offset;
    while (pos + 1 < buf.length && buf[pos + 1] === 0xff) pos += 1;
    if (pos + 1 >= buf.length) return null;
    const marker = buf[pos + 1];
    if (marker === 0x00) return null; // stuffed byte outside scan data: corrupt
    if (isStandalone(marker)) {
      offset = pos + 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS before SOF
    if (pos + 4 > buf.length) return null;
    const segmentLength = buf.readUInt16BE(pos + 2);
    if (segmentLength < 2 || pos + 2 + segmentLength > buf.length) return null;
    if (SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: buf.readUInt16BE(pos + 5),
        width: buf.readUInt16BE(pos + 7),
      };
    }
    offset = pos + 2 + segmentLength;
  }
  return null;
}

module.exports = { jpegDimensions };
