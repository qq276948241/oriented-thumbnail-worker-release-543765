'use strict';

/**
 * Worker thread entry point. All synchronous, CPU-blocking codec work
 * (jpeg-js decode/encode, pixel transforms) happens here so the HTTP thread
 * stays responsive for health checks and admissions.
 *
 * Protocol (parentPort):
 *   in:  { jobId, image: Buffer, orientation: 1-8|null, targets: [...],
 *          decodeLimits: {maxResolutionInMP, maxMemoryUsageInMB},
 *          debugCrash?: boolean }
 *   out: { jobId, ok: true,  results: [{ index, width, height, data }] }
 *        { jobId, ok: false, error: string, errorCode: string }
 *
 * A job either produces every target or fails the whole job — the parent
 * never receives partial results, which is what makes group-level rollback
 * possible.
 */

const { parentPort, workerData } = require('worker_threads');
const jpeg = require('../index.js');
const { readExifOrientation } = require('./exif');
const ops = require('./imageops');

const allowDebugCrash = Boolean(workerData && workerData.allowDebugCrash);

parentPort.on('message', (msg) => {
  const { jobId } = msg;
  try {
    if (msg.debugCrash && allowDebugCrash) {
      // Test hook: simulate a hard worker crash (no message, non-zero exit).
      process.exit(2);
    }

    const image = Buffer.isBuffer(msg.image) ? msg.image : Buffer.from(msg.image);
    const limits = msg.decodeLimits || {};
    const decoded = jpeg.decode(image, {
      useTArray: false,
      maxResolutionInMP: limits.maxResolutionInMP,
      maxMemoryUsageInMB: limits.maxMemoryUsageInMB,
    });

    const orientation = msg.orientation || readExifOrientation(image) || 1;
    // 1) correct orientation first; 2) crop in the corrected coordinate
    //    system; 3) aspect-preserving downscale (never upscale).
    const corrected = ops.applyOrientation(
      { data: decoded.data, width: decoded.width, height: decoded.height },
      orientation,
    );

    const results = msg.targets.map((target, index) => {
      const region = target.crop ? ops.crop(corrected, target.crop) : corrected;
      const size = ops.fitSize(region.width, region.height, target.width, target.height);
      const resized = ops.resize(region, size.width, size.height);
      const encoded = jpeg.encode(
        { data: resized.data, width: resized.width, height: resized.height },
        target.quality,
      );
      // Copy into a fresh, exactly-sized buffer: encoder output may be
      // backed by Node's shared Buffer pool, which cannot be transferred.
      const data = new Uint8Array(encoded.data);
      return { index, width: resized.width, height: resized.height, data };
    });

    const transfer = results.map((r) => r.data.buffer);
    parentPort.postMessage({ jobId, ok: true, results }, transfer);
  } catch (err) {
    let errorCode = 'processing_failed';
    if (err instanceof RangeError) errorCode = 'crop_out_of_bounds';
    parentPort.postMessage({
      jobId,
      ok: false,
      error: String((err && err.message) || err),
      errorCode,
    });
  }
});
