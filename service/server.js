'use strict';

const http = require('http');
const fs = require('fs');
const { jpegDimensions } = require('./jpeg-size');
const { HttpError } = require('./task-manager');

const MAX_DIMENSION = 16384;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, err) {
  const status = err.status || 500;
  sendJson(res, status, {
    error: {
      code: err.code || 'internal_error',
      message: err.message || 'Internal error',
    },
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limit) {
        settled = true;
        // Drain the rest of the upload so the socket stays usable and the
        // 413 response can actually reach the client.
        req.removeAllListeners('data');
        req.on('error', () => {});
        req.resume();
        reject(new HttpError(
          413,
          'payload_too_large',
          `Upload exceeds ${limit} bytes`,
        ));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function isInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validateParams(body) {
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'invalid_request', 'JSON object body required');
  }
  const { image, targets, orientation, idempotencyKey } = body;

  if (typeof image !== 'string' || image.length === 0) {
    throw new HttpError(400, 'invalid_request', '"image" (base64 JPEG) is required');
  }
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new HttpError(400, 'invalid_request', '"targets" must be a non-empty array');
  }
  if (orientation !== undefined && !isInt(orientation, 1, 8)) {
    throw new HttpError(400, 'invalid_request', '"orientation" must be an integer 1-8');
  }
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 200)
  ) {
    throw new HttpError(400, 'invalid_request', '"idempotencyKey" must be a string of 1-200 chars');
  }
  // Test-only hook, ignored unless the server was started with
  // WORKER_ALLOW_DEBUG_CRASH=1.
  const debugCrash = body.debugCrash === true;

  const cleanTargets = targets.map((t, i) => {
    const where = `targets[${i}]`;
    if (!t || typeof t !== 'object') {
      throw new HttpError(400, 'invalid_request', `${where} must be an object`);
    }
    if (!isInt(t.width, 1, MAX_DIMENSION) || !isInt(t.height, 1, MAX_DIMENSION)) {
      throw new HttpError(400, 'invalid_request',
        `${where}.width/height must be integers 1-${MAX_DIMENSION}`);
    }
    const quality = t.quality === undefined ? 80 : t.quality;
    if (!isInt(quality, 1, 100)) {
      throw new HttpError(400, 'invalid_request', `${where}.quality must be an integer 1-100`);
    }
    let crop;
    if (t.crop !== undefined) {
      const c = t.crop;
      if (
        !c || typeof c !== 'object' ||
        !isInt(c.x, 0, MAX_DIMENSION) || !isInt(c.y, 0, MAX_DIMENSION) ||
        !isInt(c.width, 1, MAX_DIMENSION) || !isInt(c.height, 1, MAX_DIMENSION)
      ) {
        throw new HttpError(400, 'invalid_request',
          `${where}.crop must be {x,y,width,height} with non-negative origin and positive size`);
      }
      crop = { x: c.x, y: c.y, width: c.width, height: c.height };
    }
    return { width: t.width, height: t.height, quality, ...(crop ? { crop } : {}) };
  });

  return {
    params: { orientation: orientation || null, targets: cleanTargets, ...(debugCrash ? { debugCrash } : {}) },
    idempotencyKey: idempotencyKey || null,
  };
}

function taskView(task, req) {
  const base = `/tasks/${task.id}`;
  return {
    taskId: task.id,
    status: task.status,
    error: task.error,
    targets: task.params.targets,
    outputs: task.outputs
      ? task.outputs.map((o) => ({
          index: o.index,
          width: o.width,
          height: o.height,
          url: `${base}/outputs/${o.index}`,
        }))
      : null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function createServer(config, manager) {
  const state = { shuttingDown: false };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean);

      // Health must stay fast even while workers saturate the CPU: it never
      // touches the codec or the task store's disk state.
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { status: 'ok' });
      }
      if (req.method === 'GET' && url.pathname === '/ready') {
        if (state.shuttingDown) {
          return sendJson(res, 503, { status: 'shutting_down' });
        }
        return sendJson(res, 200, { status: 'ready' });
      }

      if (req.method === 'POST' && url.pathname === '/tasks') {
        if (state.shuttingDown) {
          throw new HttpError(503, 'shutting_down', 'Service is shutting down');
        }
        const body = await readBody(req, config.maxUploadBytes);
        let parsed;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
        }
        const { params, idempotencyKey } = validateParams(parsed);
        if (params.targets.length > config.maxTargetsPerTask) {
          throw new HttpError(400, 'invalid_request',
            `At most ${config.maxTargetsPerTask} targets per task`);
        }

        const image = Buffer.from(parsed.image, 'base64');
        if (image.length === 0) {
          throw new HttpError(400, 'invalid_image', 'Image payload is empty');
        }

        // Idempotent replay short-circuits admission limits: the original
        // task was already admitted once under the limits of its time.
        if (idempotencyKey) {
          const found = manager.checkIdempotency(idempotencyKey, image, params);
          if (found && found.conflict) {
            throw new HttpError(
              409,
              'idempotency_conflict',
              'Idempotency key was already used with different content',
            );
          }
          if (found && found.task) {
            return sendJson(res, 200, taskView(found.task, req));
          }
        }

        const dims = jpegDimensions(image);
        if (!dims) {
          throw new HttpError(400, 'invalid_image', 'Payload is not a parseable JPEG');
        }
        const pixels = dims.width * dims.height;
        if (pixels > config.maxInputPixels) {
          throw new HttpError(413, 'input_pixels_exceeded',
            `Input has ${pixels} pixels, limit is ${config.maxInputPixels}`);
        }
        const targetPixels = params.targets.reduce((sum, t) => sum + t.width * t.height, 0);
        if (targetPixels > config.maxTargetTotalPixels) {
          throw new HttpError(413, 'target_pixels_exceeded',
            `Targets total ${targetPixels} pixels, limit is ${config.maxTargetTotalPixels}`);
        }

        const { task, replay } = manager.submit({
          idempotencyKey,
          image,
          params,
        });
        return sendJson(res, replay ? 200 : 202, taskView(task, req));
      }

      if (segments[0] === 'tasks' && segments.length >= 2) {
        const id = segments[1];
        if (req.method === 'GET' && segments.length === 2) {
          const task = manager.get(id);
          if (!task) throw new HttpError(404, 'not_found', 'Unknown task');
          return sendJson(res, 200, taskView(task, req));
        }
        if (req.method === 'POST' && segments.length === 3 && segments[2] === 'cancel') {
          const task = manager.cancel(id);
          return sendJson(res, 200, taskView(task, req));
        }
        if (req.method === 'GET' && segments.length === 4 && segments[2] === 'outputs') {
          const index = Number(segments[3]);
          const task = manager.get(id);
          if (!task) throw new HttpError(404, 'not_found', 'Unknown task');
          if (!Number.isInteger(index) || index < 0) {
            throw new HttpError(404, 'not_found', 'Unknown output');
          }
          const file = manager.outputFile(task, index);
          if (!file) {
            if (task.status !== 'succeeded') {
              throw new HttpError(409, 'task_not_ready',
                `Task is ${task.status}; outputs are only available after success`);
            }
            throw new HttpError(404, 'not_found', 'Unknown output');
          }
          const stat = await fs.promises.stat(file);
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': stat.size,
          });
          return fs.createReadStream(file).pipe(res);
        }
      }

      throw new HttpError(404, 'not_found', 'Unknown route');
    } catch (err) {
      if (!res.headersSent) return sendError(res, err);
      res.end();
    }
  });

  return { server, state };
}

module.exports = { createServer };
