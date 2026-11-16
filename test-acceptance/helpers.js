'use strict';

/**
 * Shared helpers for the acceptance suite. Everything runs against real HTTP
 * servers spawned as child processes; the only library used is the repo's
 * own jpeg-js (for building fixtures and asserting on decoded outputs).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const jpeg = require(path.join(ROOT, 'index.js'));

const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const BIG_JPEG = path.join(FIXTURES, 'black-6000x6000.jpg');

let nextPort = 18411;

const startedServers = [];

/** SIGKILL every server this process started (safety net for test failures). */
function killAllServers() {
  for (const server of startedServers) {
    if (server.proc.exitCode === null && !server.proc.killed) {
      server.proc.kill('SIGKILL');
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn the service as a child process and wait for readiness.
 * @returns server handle { port, dataDir, proc, logs, stop() }
 */
async function startServer(env = {}, { dataDir } = {}) {
  const port = nextPort;
  nextPort += 1;
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-it-'));
  const logs = [];
  const proc = spawn(process.execPath, [path.join(ROOT, 'service', 'main.js')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dir,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => logs.push(String(d)));
  proc.stderr.on('data', (d) => logs.push(String(d)));

  const deadline = Date.now() + 15000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`server exited early (${proc.exitCode}):\n${logs.join('')}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`);
      if (res.status === 200) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`server did not become ready:\n${logs.join('')}`);
    }
    await sleep(50);
  }

  const handle = {
    port,
    dataDir: dir,
    proc,
    logs,
    /** SIGTERM and wait for exit; returns the exit code. */
    stop: (timeoutMs = 15000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error('server did not exit in time'));
      }, timeoutMs);
      proc.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      proc.kill('SIGTERM');
    }),
  };
  startedServers.push(handle);
  return handle;
}

// --- HTTP -----------------------------------------------------------------

async function api(port, method, pathname, body) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}

async function submitTask(port, task) {
  return api(port, 'POST', '/tasks', {
    ...task,
    image: task.image.toString('base64'),
  });
}

async function getTask(port, id) {
  const res = await api(port, 'GET', `/tasks/${id}`);
  if (res.status !== 200) throw new Error(`GET /tasks/${id} -> ${res.status}`);
  return res.json;
}

async function waitForStatus(port, id, wanted, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await getTask(port, id);
    if (task.status === wanted) return task;
    if (Date.now() > deadline) {
      throw new Error(`task ${id} never reached ${wanted} (now ${task.status})`);
    }
    await sleep(25);
  }
}

async function waitForTerminal(port, id, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await getTask(port, id);
    if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return task;
    if (Date.now() > deadline) {
      throw new Error(`task ${id} never reached a terminal state (${task.status})`);
    }
    await sleep(50);
  }
}

async function downloadOutput(port, task, index) {
  const output = task.outputs.find((o) => o.index === index);
  if (!output) throw new Error(`task has no output ${index}`);
  const res = await fetch(`http://127.0.0.1:${port}${output.url}`);
  if (res.status !== 200) throw new Error(`download ${output.url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// --- images -----------------------------------------------------------------

/** Encode an RGBA pixel function into a JPEG buffer. */
function encodeImage(width, height, pixelAt, quality = 95) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, quality).data;
}

const QUADRANT_COLORS = {
  TL: [220, 30, 30],
  TR: [30, 200, 30],
  BL: [30, 30, 220],
  BR: [230, 210, 30],
};

/** Visual image with four distinctly colored quadrants. */
function quadrantImage(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const key = `${y < height / 2 ? 'T' : 'B'}${x < width / 2 ? 'L' : 'R'}`;
      const [r, g, b] = QUADRANT_COLORS[key];
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/**
 * Build the *stored* pixel layout for an image whose visual content is
 * `visual`, under EXIF orientation `o` — i.e. the inverse of the correction
 * the service must apply. Mapping follows the EXIF row0/col0 definitions:
 *   1: (sx,sy)->(sx,sy)            2: ->(W-1-sx,sy)
 *   3: ->(W-1-sx,H-1-sy)           4: ->(sx,H-1-sy)
 *   5: ->(sy,sx)                   6: ->(H-1-sy,sx)
 *   7: ->(H-1-sy,W-1-sx)           8: ->(sy,W-1-sx)
 * where (vx,vy) is the visual position of stored pixel (sx,sy).
 */
function storedLayoutFor(visual, orientation) {
  const sW = orientation >= 5 ? visual.height : visual.width;
  const sH = orientation >= 5 ? visual.width : visual.height;
  const out = Buffer.alloc(sW * sH * 4);
  for (let sy = 0; sy < sH; sy += 1) {
    for (let sx = 0; sx < sW; sx += 1) {
      let vx;
      let vy;
      switch (orientation) {
        case 1: vx = sx; vy = sy; break;
        case 2: vx = sW - 1 - sx; vy = sy; break;
        case 3: vx = sW - 1 - sx; vy = sH - 1 - sy; break;
        case 4: vx = sx; vy = sH - 1 - sy; break;
        case 5: vx = sy; vy = sx; break;
        case 6: vx = sH - 1 - sy; vy = sx; break;
        case 7: vx = sH - 1 - sy; vy = sW - 1 - sx; break;
        case 8: vx = sy; vy = sW - 1 - sx; break;
        default: throw new Error(`bad orientation ${orientation}`);
      }
      const from = (vy * visual.width + vx) * 4;
      const to = (sy * sW + sx) * 4;
      out[to] = visual.data[from];
      out[to + 1] = visual.data[from + 1];
      out[to + 2] = visual.data[from + 2];
      out[to + 3] = 255;
    }
  }
  return { data: out, width: sW, height: sH };
}

function decode(buffer) {
  return jpeg.decode(buffer);
}

/** Average color of a rectangle in a decoded RGBA image. */
function averageColor(image, x0, y0, w, h) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const i = (y * image.width + x) * 4;
      r += image.data[i];
      g += image.data[i + 1];
      b += image.data[i + 2];
    }
  }
  const n = w * h;
  return [r / n, g / n, b / n];
}

function colorNear(actual, expected, tolerance = 30) {
  return expected.every((v, i) => Math.abs(actual[i] - v) <= tolerance);
}

/** Assert all four quadrants of a decoded image match the visual layout. */
function quadrantsMatch(image, assert, tolerance = 30) {
  const qw = Math.floor(image.width / 4);
  const qh = Math.floor(image.height / 4);
  const centers = {
    TL: [Math.floor(image.width * 0.25), Math.floor(image.height * 0.25)],
    TR: [Math.floor(image.width * 0.75), Math.floor(image.height * 0.25)],
    BL: [Math.floor(image.width * 0.25), Math.floor(image.height * 0.75)],
    BR: [Math.floor(image.width * 0.75), Math.floor(image.height * 0.75)],
  };
  for (const [key, [cx, cy]] of Object.entries(centers)) {
    const avg = averageColor(image, cx - Math.floor(qw / 2), cy - Math.floor(qh / 2), qw, qh);
    assert(
      colorNear(avg, QUADRANT_COLORS[key], tolerance),
      `quadrant ${key}: expected ~${QUADRANT_COLORS[key]}, got ${avg.map(Math.round)}`,
    );
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

module.exports = {
  ROOT,
  FIXTURES,
  BIG_JPEG,
  sleep,
  startServer,
  killAllServers,
  api,
  submitTask,
  getTask,
  waitForStatus,
  waitForTerminal,
  downloadOutput,
  encodeImage,
  quadrantImage,
  storedLayoutFor,
  decode,
  averageColor,
  colorNear,
  quadrantsMatch,
  listDir,
  QUADRANT_COLORS,
};
