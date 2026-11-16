'use strict';

/**
 * Pure pixel operations on RGBA images ({ data, width, height }, 4 bytes per
 * pixel). Every operation allocates a fresh output buffer: the decoded source
 * pixels are shared by all targets of a task and must never be mutated by one
 * target's processing.
 */

/**
 * Convert stored pixels to display pixels for EXIF orientation 1-8.
 *
 * EXIF semantics: the value says where stored row 0 / column 0 sit in the
 * intended visual image. Correction maps each stored pixel (sx, sy) to its
 * visual position (vx, vy):
 *
 *   1: row0=top,    col0=left   -> vx=sx,        vy=sy        (identity)
 *   2: row0=top,    col0=right  -> vx=W-1-sx,    vy=sy        (mirror horizontal)
 *   3: row0=bottom, col0=right  -> vx=W-1-sx,    vy=H-1-sy    (rotate 180)
 *   4: row0=bottom, col0=left   -> vx=sx,        vy=H-1-sy    (mirror vertical)
 *   5: row0=left,   col0=top    -> vx=sy,        vy=sx        (transpose)
 *   6: row0=right,  col0=top    -> vx=H-1-sy,    vy=sx        (rotate 90 CW)
 *   7: row0=right,  col0=bottom -> vx=H-1-sy,    vy=W-1-sx    (transverse)
 *   8: row0=left,   col0=bottom -> vx=sy,        vy=W-1-sx    (rotate 90 CCW)
 *
 * Orientations 5-8 swap width and height.
 */
function applyOrientation(image, orientation) {
  const { data, width: W, height: H } = image;
  const swap = orientation >= 5 && orientation <= 8;
  const outW = swap ? H : W;
  const outH = swap ? W : H;
  const out = Buffer.alloc(outW * outH * 4);
  for (let sy = 0; sy < H; sy += 1) {
    for (let sx = 0; sx < W; sx += 1) {
      let vx;
      let vy;
      switch (orientation) {
        case 1: vx = sx; vy = sy; break;
        case 2: vx = W - 1 - sx; vy = sy; break;
        case 3: vx = W - 1 - sx; vy = H - 1 - sy; break;
        case 4: vx = sx; vy = H - 1 - sy; break;
        case 5: vx = sy; vy = sx; break;
        case 6: vx = H - 1 - sy; vy = sx; break;
        case 7: vx = H - 1 - sy; vy = W - 1 - sx; break;
        case 8: vx = sy; vy = W - 1 - sx; break;
        default:
          throw new Error(`Unsupported orientation: ${orientation}`);
      }
      const from = (sy * W + sx) * 4;
      const to = (vy * outW + vx) * 4;
      out[to] = data[from];
      out[to + 1] = data[from + 1];
      out[to + 2] = data[from + 2];
      out[to + 3] = data[from + 3];
    }
  }
  return { data: out, width: outW, height: outH };
}

/**
 * Crop a rectangle out of the image, in the current (orientation-corrected)
 * coordinate system. Out-of-bounds rectangles are a hard failure.
 */
function crop(image, rect) {
  const { x, y, width, height } = rect;
  if (
    !Number.isInteger(x) || !Number.isInteger(y) ||
    !Number.isInteger(width) || !Number.isInteger(height) ||
    x < 0 || y < 0 || width <= 0 || height <= 0 ||
    x + width > image.width || y + height > image.height
  ) {
    throw new RangeError(
      `Crop rectangle ${JSON.stringify(rect)} is out of bounds for ` +
      `${image.width}x${image.height} image`,
    );
  }
  const out = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * image.width + x) * 4;
    image.data.copy(out, row * width * 4, from, from + width * 4);
  }
  return { data: out, width, height };
}

/**
 * Output dimensions for a crop of cw x ch requested at tw x th.
 *
 * Rounding rules (documented contract):
 *   - aspect-preserving fit-within: scale = min(tw/cw, th/ch)
 *   - never upscale: scale = min(scale, 1)
 *   - each output dimension = max(1, round(input * scale)) — halves round up
 */
function fitSize(cw, ch, tw, th) {
  const scale = Math.min(tw / cw, th / ch, 1);
  return {
    width: Math.max(1, Math.round(cw * scale)),
    height: Math.max(1, Math.round(ch * scale)),
  };
}

/**
 * Bilinear resample to exactly outW x outH. Always allocates a new buffer,
 * even when the size is unchanged, so callers can treat outputs as owned.
 */
function resize(image, outW, outH) {
  const { data, width: W, height: H } = image;
  const out = Buffer.alloc(outW * outH * 4);
  if (outW === W && outH === H) {
    data.copy(out, 0);
    return { data: out, width: outW, height: outH };
  }
  // Map output pixel centers back into source coordinates.
  const scaleX = W / outW;
  const scaleY = H / outH;
  for (let oy = 0; oy < outH; oy += 1) {
    const sy = (oy + 0.5) * scaleY - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(H - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, sy - y0));
    for (let ox = 0; ox < outW; ox += 1) {
      const sx = (ox + 0.5) * scaleX - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(W - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      const to = (oy * outW + ox) * 4;
      const i00 = (y0 * W + x0) * 4;
      const i01 = (y0 * W + x1) * 4;
      const i10 = (y1 * W + x0) * 4;
      const i11 = (y1 * W + x1) * 4;
      for (let c = 0; c < 4; c += 1) {
        const top = data[i00 + c] + (data[i01 + c] - data[i00 + c]) * fx;
        const bottom = data[i10 + c] + (data[i11 + c] - data[i10 + c]) * fx;
        out[to + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return { data: out, width: outW, height: outH };
}

module.exports = { applyOrientation, crop, fitSize, resize };
