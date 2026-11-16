'use strict';

/**
 * Minimal EXIF reader: finds the APP1 "Exif\0\0" segment and reads tag
 * 0x0112 (Orientation) from IFD0. Returns an integer 1-8, or null when the
 * image carries no usable orientation. jpeg-js ignores EXIF, so the service
 * applies the correction itself in pixel space (see imageops.js).
 */
function readExifOrientation(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    if (marker === 0xda || marker === 0xd9) return null; // SOS / EOI
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buf.length) return null;
    if (marker === 0xe1) {
      const body = offset + 4;
      const bodyLength = segmentLength - 2;
      if (
        bodyLength >= 14 &&
        buf.toString('ascii', body, body + 6) === 'Exif\0\0'
      ) {
        return parseTiffOrientation(buf, body + 6, bodyLength - 6);
      }
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function parseTiffOrientation(buf, tiff, length) {
  if (tiff + 8 > buf.length || length < 8) return null;
  const byteOrder = buf.toString('ascii', tiff, tiff + 2);
  const little = byteOrder === 'II';
  if (!little && byteOrder !== 'MM') return null;
  const u16 = (at) => (little ? buf.readUInt16LE(at) : buf.readUInt16BE(at));
  const u32 = (at) => (little ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  if (u16(tiff + 2) !== 0x2a) return null;
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > buf.length) return null;
  const entries = u16(ifd0);
  for (let i = 0; i < entries; i += 1) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > buf.length) return null;
    if (u16(entry) === 0x0112) {
      const type = u16(entry + 2);
      const count = u32(entry + 4);
      if (type !== 3 || count < 1) return null; // expect a single SHORT
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

module.exports = { readExifOrientation };
