'use strict';

/**
 * Acceptance suite for the JPEG thumbnail service.
 *
 *   node test-acceptance/run.js
 *
 * Spawns real server processes and drives them over real HTTP. No network
 * access beyond 127.0.0.1, no third-party dependencies. Every test prints
 * the request/response essentials and the image assertions it makes, so the
 * run log doubles as the acceptance record.
 */

const fs = require('fs');
const path = require('path');
const {
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
  quadrantsMatch,
  listDir,
} = require('./helpers');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

const bigJpeg = fs.readFileSync(BIG_JPEG);
// A slow task: 36MP decode plus four large targets keeps a worker busy for
// well over a second, which makes queueing/cancel/timeout windows reliable.
const slowTask = (extra = {}) => ({
  image: bigJpeg,
  targets: [
    { width: 1200, height: 1200 },
    { width: 1200, height: 1200 },
    { width: 1200, height: 1200 },
    { width: 1200, height: 1200 },
  ],
  ...extra,
});

// ---------------------------------------------------------------------------
// Server A: functional behavior (single worker, concurrency 1, queue 2)
// ---------------------------------------------------------------------------

test('A: health and readiness endpoints respond', async (a) => {
  const health = await api(a.port, 'GET', '/health');
  assert(health.status === 200 && health.json.status === 'ok', `health -> ${health.status}`);
  const ready = await api(a.port, 'GET', '/ready');
  assert(ready.status === 200 && ready.json.status === 'ready', `ready -> ${ready.status}`);
  console.log('    GET /health -> 200 {"status":"ok"}; GET /ready -> 200 {"status":"ready"}');
});

test('A: landscape image, non-integer scaling, documented rounding', async (a) => {
  // 333x200 fit into 100x100: scale = 100/333, height = round(200*100/333) = 60
  const image = encodeImage(333, 200, (x) => (x < 166 ? [250, 0, 0] : [0, 0, 250]));
  const { status, json } = await submitTask(a.port, {
    image,
    targets: [{ width: 100, height: 100, quality: 90 }],
  });
  console.log(`    POST /tasks (333x200 -> 100x100) -> ${status}`);
  assert(status === 202, `submit -> ${status}`);
  const done = await waitForTerminal(a.port, json.taskId);
  assert(done.status === 'succeeded', `task ${done.status}: ${JSON.stringify(done.error)}`);
  const out = decode(await downloadOutput(a.port, done, 0));
  console.log(`    decoded output: ${out.width}x${out.height}`);
  assert(out.width === 100 && out.height === 60, `expected 100x60, got ${out.width}x${out.height}`);
});

test('A: portrait image scales to fit the other way', async (a) => {
  const image = encodeImage(200, 333, () => [0, 200, 0]);
  const { json } = await submitTask(a.port, { image, targets: [{ width: 100, height: 100 }] });
  const done = await waitForTerminal(a.port, json.taskId);
  assert(done.status === 'succeeded', `task ${done.status}`);
  const out = decode(await downloadOutput(a.port, done, 0));
  console.log(`    200x333 -> target 100x100 => ${out.width}x${out.height}`);
  assert(out.width === 60 && out.height === 100, `expected 60x100, got ${out.width}x${out.height}`);
});

test('A: small images are never upscaled', async (a) => {
  const image = encodeImage(50, 40, () => [10, 20, 30]);
  const { json } = await submitTask(a.port, { image, targets: [{ width: 100, height: 100 }] });
  const done = await waitForTerminal(a.port, json.taskId);
  assert(done.status === 'succeeded', `task ${done.status}`);
  const out = decode(await downloadOutput(a.port, done, 0));
  console.log(`    50x40 -> target 100x100 => ${out.width}x${out.height} (no upscale)`);
  assert(out.width === 50 && out.height === 40, `expected 50x40, got ${out.width}x${out.height}`);
});

test('A: all eight EXIF orientations are corrected before scaling', async (a) => {
  const visual = quadrantImage(60, 40); // non-square to catch dimension swaps
  for (let orientation = 1; orientation <= 8; orientation += 1) {
    const stored = storedLayoutFor(visual, orientation);
    const image = encodeImage(stored.width, stored.height, (x, y) => {
      const i = (y * stored.width + x) * 4;
      return [stored.data[i], stored.data[i + 1], stored.data[i + 2]];
    });
    const { status, json } = await submitTask(a.port, {
      image,
      orientation,
      targets: [{ width: 60, height: 40, quality: 95 }],
    });
    assert(status === 202, `orientation ${orientation}: submit -> ${status}`);
    const done = await waitForTerminal(a.port, json.taskId);
    assert(done.status === 'succeeded', `orientation ${orientation}: ${JSON.stringify(done.error)}`);
    const out = decode(await downloadOutput(a.port, done, 0));
    assert(out.width === 60 && out.height === 40,
      `orientation ${orientation}: expected 60x40, got ${out.width}x${out.height}`);
    quadrantsMatch(out, assert);
    console.log(`    orientation ${orientation}: corrected to 60x40, quadrants OK`);
  }
});

test('A: edge-touching crop succeeds and lands on the right pixels', async (a) => {
  // 100x80, left half red, right half blue. Crop the right half, touching
  // the right and both vertical edges of the corrected image.
  const image = encodeImage(100, 80, (x) => (x < 50 ? [250, 0, 0] : [0, 0, 250]));
  const { json } = await submitTask(a.port, {
    image,
    targets: [{ width: 25, height: 40, crop: { x: 50, y: 0, width: 50, height: 80 } }],
  });
  const done = await waitForTerminal(a.port, json.taskId);
  assert(done.status === 'succeeded', `task ${done.status}: ${JSON.stringify(done.error)}`);
  const out = decode(await downloadOutput(a.port, done, 0));
  console.log(`    crop x=50 w=50 of 100x80 (touches right edge) -> ${out.width}x${out.height}`);
  assert(out.width === 25 && out.height === 40, `expected 25x40, got ${out.width}x${out.height}`);
  const px = [out.data[0], out.data[1], out.data[2]];
  assert(px[2] > 200 && px[0] < 60, `expected blue crop, got ${px}`);
});

test('A: out-of-bounds crop fails the task and leaves nothing behind', async (a) => {
  const image = encodeImage(100, 80, () => [0, 0, 0]);
  const { json } = await submitTask(a.port, {
    image,
    targets: [{ width: 10, height: 10, crop: { x: 90, y: 0, width: 20, height: 80 } }],
  });
  const done = await waitForTerminal(a.port, json.taskId);
  console.log(`    out-of-bounds crop -> ${done.status} (${done.error && done.error.code})`);
  assert(done.status === 'failed', `expected failed, got ${done.status}`);
  assert(done.error.code === 'crop_out_of_bounds', `error ${JSON.stringify(done.error)}`);
  const dl = await api(a.port, 'GET', `/tasks/${done.taskId}/outputs/0`);
  assert(dl.status === 409, `download of failed task -> ${dl.status}`);
  assert(listDir(path.join(a.dataDir, 'tmp')).length === 0, 'tmp dir not cleaned');
});

test('A: one bad target rolls back the whole group', async (a) => {
  const image = encodeImage(100, 80, () => [0, 0, 0]);
  const { json } = await submitTask(a.port, {
    image,
    targets: [
      { width: 50, height: 40 }, // perfectly valid
      { width: 10, height: 10, crop: { x: 0, y: 70, width: 50, height: 50 } }, // out of bounds
    ],
  });
  const done = await waitForTerminal(a.port, json.taskId);
  console.log(`    mixed group -> ${done.status} (${done.error && done.error.code})`);
  assert(done.status === 'failed', `expected failed, got ${done.status}`);
  assert(done.outputs === null, 'failed task must not expose outputs');
  const dl = await api(a.port, 'GET', `/tasks/${done.taskId}/outputs/0`);
  assert(dl.status === 409, `partial output downloadable -> ${dl.status}`);
  assert(listDir(path.join(a.dataDir, 'tmp')).length === 0, 'tmp dir not cleaned');
  assert(!listDir(path.join(a.dataDir, 'tasks')).includes(done.taskId),
    'partial output directory was published');
});

test('A: idempotency — same content replays, different content conflicts', async (a) => {
  const image = encodeImage(40, 40, () => [1, 2, 3]);
  const body = { image, targets: [{ width: 20, height: 20 }], idempotencyKey: 'idem-a-1' };
  const first = await submitTask(a.port, body);
  assert(first.status === 202, `first submit -> ${first.status}`);
  const replay = await submitTask(a.port, body);
  console.log(`    same key+content -> ${replay.status}, taskId ${replay.json.taskId}`);
  assert(replay.status === 200, `replay -> ${replay.status}`);
  assert(replay.json.taskId === first.json.taskId, 'replay returned a different task');

  // Same key, same image bytes, different parameters -> conflict. The
  // comparison is content-based (sha256 of image + canonical params), it
  // never looks at filenames.
  const conflict = await submitTask(a.port, {
    image,
    targets: [{ width: 21, height: 21 }],
    idempotencyKey: 'idem-a-1',
  });
  console.log(`    same key+other params -> ${conflict.status} (${conflict.json.error.code})`);
  assert(conflict.status === 409, `conflict -> ${conflict.status}`);
  assert(conflict.json.error.code === 'idempotency_conflict', conflict.text);

  const otherImage = encodeImage(40, 40, () => [9, 9, 9]);
  const conflict2 = await submitTask(a.port, {
    image: otherImage,
    targets: [{ width: 20, height: 20 }],
    idempotencyKey: 'idem-a-1',
  });
  assert(conflict2.status === 409, 'different image with same key must conflict');
  await waitForTerminal(a.port, first.json.taskId);
});

test('A: bad images are rejected or fail the task, never crash it', async (a) => {
  const garbage = await submitTask(a.port, {
    image: Buffer.from('this is not a jpeg at all'),
    targets: [{ width: 10, height: 10 }],
  });
  console.log(`    garbage bytes -> ${garbage.status} (${garbage.json.error.code})`);
  assert(garbage.status === 400 && garbage.json.error.code === 'invalid_image', garbage.text);

  // Valid header, truncated scan data: passes admission, fails at decode.
  const good = encodeImage(100, 80, () => [100, 100, 100]);
  const truncated = good.slice(0, 400);
  const { status, json } = await submitTask(a.port, {
    image: truncated,
    targets: [{ width: 10, height: 10 }],
  });
  assert(status === 202, `truncated submit -> ${status}`);
  const done = await waitForTerminal(a.port, json.taskId);
  console.log(`    truncated jpeg -> task ${done.status} (${done.error && done.error.code})`);
  assert(done.status === 'failed', `expected failed, got ${done.status}`);
});

test('A: full queue rejects with 429 and the rejection takes no slot', async (a) => {
  // concurrency 1 + queue 2: one processing, two queued, fourth rejected.
  const t1 = await submitTask(a.port, slowTask());
  assert(t1.status === 202, `t1 -> ${t1.status}`);
  await waitForStatus(a.port, t1.json.taskId, 'processing');
  const t2 = await submitTask(a.port, { image: encodeImage(20, 20, () => [0, 0, 0]), targets: [{ width: 5, height: 5 }] });
  const t3 = await submitTask(a.port, { image: encodeImage(20, 20, () => [1, 1, 1]), targets: [{ width: 5, height: 5 }] });
  assert(t2.status === 202 && t3.status === 202, 'queued submissions must be accepted');
  const t4 = await submitTask(a.port, { image: encodeImage(20, 20, () => [2, 2, 2]), targets: [{ width: 5, height: 5 }] });
  console.log(`    1 processing + 2 queued, 4th submit -> ${t4.status} (${t4.json.error.code})`);
  assert(t4.status === 429 && t4.json.error.code === 'queue_full', t4.text);

  // Freeing a queued slot lets a new task in: the 429 consumed nothing.
  const cancel = await api(a.port, 'POST', `/tasks/${t2.json.taskId}/cancel`);
  assert(cancel.status === 200 && cancel.json.status === 'cancelled', cancel.text);
  const t5 = await submitTask(a.port, { image: encodeImage(20, 20, () => [3, 3, 3]), targets: [{ width: 5, height: 5 }] });
  console.log(`    after cancelling a queued task, submit -> ${t5.status}`);
  assert(t5.status === 202, `resubmit -> ${t5.status}`);

  // Drain: cancel what is cancellable, wait for the rest.
  await api(a.port, 'POST', `/tasks/${t1.json.taskId}/cancel`);
  await waitForTerminal(a.port, t3.json.taskId);
  await waitForTerminal(a.port, t5.json.taskId);
});

test('A: cancelling a processing task frees its slot and is final', async (a) => {
  const submitted = await submitTask(a.port, slowTask());
  assert(submitted.status === 202, `submit -> ${submitted.status}`);
  const id = submitted.json.taskId;
  await waitForStatus(a.port, id, 'processing');
  const cancelled = await api(a.port, 'POST', `/tasks/${id}/cancel`);
  console.log(`    cancel while processing -> ${cancelled.json.status}`);
  assert(cancelled.status === 200 && cancelled.json.status === 'cancelled', cancelled.text);

  // The slot is back: a new task is accepted and completes.
  const next = await submitTask(a.port, { image: encodeImage(30, 30, () => [7, 7, 7]), targets: [{ width: 10, height: 10 }] });
  assert(next.status === 202, `follow-up submit -> ${next.status}`);
  const done = await waitForTerminal(a.port, next.json.taskId);
  assert(done.status === 'succeeded', `follow-up task ${done.status}`);

  // No late result can resurrect the cancelled task.
  await sleep(1500);
  const after = await getTask(a.port, id);
  assert(after.status === 'cancelled', `cancelled task flipped to ${after.status}`);
  const dl = await api(a.port, 'GET', `/tasks/${id}/outputs/0`);
  assert(dl.status === 409, `cancelled task output -> ${dl.status}`);
  console.log('    cancelled task stays cancelled; outputs stay unavailable');
});

test('A: a crashed worker fails its task and the pool recovers', async (a) => {
  const crashed = await submitTask(a.port, {
    image: encodeImage(40, 40, () => [0, 0, 0]),
    targets: [{ width: 10, height: 10 }],
    debugCrash: true, // honored because the server runs with WORKER_ALLOW_DEBUG_CRASH=1
  });
  assert(crashed.status === 202, `submit -> ${crashed.status}`);
  const done = await waitForTerminal(a.port, crashed.json.taskId);
  console.log(`    worker crash -> task ${done.status} (${done.error && done.error.code})`);
  assert(done.status === 'failed' && done.error.code === 'worker_crash', JSON.stringify(done.error));

  const next = await submitTask(a.port, { image: encodeImage(30, 30, () => [8, 8, 8]), targets: [{ width: 10, height: 10 }] });
  const recovered = await waitForTerminal(a.port, next.json.taskId);
  assert(recovered.status === 'succeeded', 'pool did not recover after crash');
  console.log('    replacement worker processed the next task successfully');
});

test('A: health checks stay fast while a worker is saturated', async (a) => {
  const submitted = await submitTask(a.port, slowTask());
  await waitForStatus(a.port, submitted.json.taskId, 'processing');
  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    const start = Date.now();
    const res = await api(a.port, 'GET', '/health');
    samples.push(Date.now() - start);
    assert(res.status === 200, `health -> ${res.status}`);
  }
  console.log(`    /health latency under load: ${samples.join(', ')}ms`);
  assert(Math.max(...samples) < 1000, `health check blocked: ${samples}`);
  await api(a.port, 'POST', `/tasks/${submitted.json.taskId}/cancel`);
  await waitForTerminal(a.port, submitted.json.taskId);
});

// ---------------------------------------------------------------------------
// Server B: admission limits
// ---------------------------------------------------------------------------

test('B: upload bytes, input pixels and target pixels limits (413)', async (b) => {
  const small = encodeImage(20, 20, () => [0, 0, 0]); // 400 px

  // Upload bytes: pad the JSON body past MAX_UPLOAD_BYTES=20000.
  const big = await api(b.port, 'POST', '/tasks', {
    image: small.toString('base64'),
    targets: [{ width: 5, height: 5 }],
    padding: 'x'.repeat(30 * 1024),
  });
  console.log(`    oversized body -> ${big.status} (${big.json.error.code})`);
  assert(big.status === 413 && big.json.error.code === 'payload_too_large', big.text);

  // Input pixels: 200x200 = 40000 > MAX_INPUT_PIXELS=10000.
  const pixels = await submitTask(b.port, {
    image: encodeImage(200, 200, () => [0, 0, 0]),
    targets: [{ width: 5, height: 5 }],
  });
  console.log(`    200x200 input -> ${pixels.status} (${pixels.json.error.code})`);
  assert(pixels.status === 413 && pixels.json.error.code === 'input_pixels_exceeded', pixels.text);

  // Target pixels: 2 x 150x150 = 45000 > MAX_TARGET_TOTAL_PIXELS=20000.
  const targets = await submitTask(b.port, {
    image: small,
    targets: [{ width: 150, height: 150 }, { width: 150, height: 150 }],
  });
  console.log(`    2x 150x150 targets -> ${targets.status} (${targets.json.error.code})`);
  assert(targets.status === 413 && targets.json.error.code === 'target_pixels_exceeded', targets.text);

  // None of the rejections consumed capacity: a valid task still gets in.
  const ok = await submitTask(b.port, { image: small, targets: [{ width: 10, height: 10 }] });
  console.log(`    valid task after rejections -> ${ok.status}`);
  assert(ok.status === 202, `valid submit after rejections -> ${ok.status}`);
  const done = await waitForTerminal(b.port, ok.json.taskId);
  assert(done.status === 'succeeded', `valid task ${done.status}`);
});

// ---------------------------------------------------------------------------
// Server C: task timeout
// ---------------------------------------------------------------------------

test('C: a task exceeding its timeout fails and releases the worker', async (c) => {
  const submitted = await submitTask(c.port, slowTask());
  assert(submitted.status === 202, `submit -> ${submitted.status}`);
  const done = await waitForTerminal(c.port, submitted.json.taskId);
  console.log(`    36MP task with 400ms timeout -> ${done.status} (${done.error && done.error.code})`);
  assert(done.status === 'failed' && done.error.code === 'task_timeout', JSON.stringify(done.error));

  // The timed-out worker was replaced: the next task succeeds.
  const next = await submitTask(c.port, { image: encodeImage(30, 30, () => [5, 5, 5]), targets: [{ width: 10, height: 10 }] });
  const recovered = await waitForTerminal(c.port, next.json.taskId);
  assert(recovered.status === 'succeeded', `post-timeout task ${recovered.status}`);
  console.log('    worker replaced, next task succeeded');
});

// ---------------------------------------------------------------------------
// Server D: graceful shutdown lets accepted tasks finish
// ---------------------------------------------------------------------------

test('D: SIGTERM stops admissions, finishes accepted tasks, exits cleanly', async () => {
  const d = await startServer({
    WORKER_COUNT: '1',
    MAX_CONCURRENT_TASKS: '1',
    SHUTDOWN_GRACE_MS: '15000',
    MAX_INPUT_PIXELS: '50000000',
    MAX_TARGET_TOTAL_PIXELS: '40000000',
  });
  const submitted = await submitTask(d.port, slowTask({ idempotencyKey: 'grace-1' }));
  assert(submitted.status === 202, `submit -> ${submitted.status}`);
  const id = submitted.json.taskId;
  await waitForStatus(d.port, id, 'processing');

  const exitCode = await d.stop();
  console.log(`    SIGTERM during processing -> exit code ${exitCode}`);
  assert(exitCode === 0, `expected clean exit, got ${exitCode}`);

  // New admissions are refused once draining (connection refused or 503).
  let refused = false;
  try {
    const res = await submitTask(d.port, { image: encodeImage(10, 10, () => [0, 0, 0]), targets: [{ width: 5, height: 5 }] });
    refused = res.status === 503;
  } catch {
    refused = true; // listener already closed
  }
  assert(refused, 'service kept accepting work during/after shutdown');

  // Restart on the same data dir: the accepted task finished within the
  // grace window and must be reported — and downloadable — as succeeded.
  const d2 = await startServer({}, { dataDir: d.dataDir });
  const task = await getTask(d2.port, id);
  console.log(`    after restart: task ${task.status}`);
  assert(task.status === 'succeeded', `expected succeeded, got ${task.status}`);
  const out = decode(await downloadOutput(d2.port, task, 0));
  assert(out.width === 1200 && out.height === 1200, `output ${out.width}x${out.height}`);
  console.log(`    output 0 downloadable after restart: ${out.width}x${out.height}`);
  await d2.stop();
});

// ---------------------------------------------------------------------------
// Server E: shutdown past the grace window interrupts and never lies
// ---------------------------------------------------------------------------

test('E: interrupted tasks are failed, cleaned up, and never reported as success', async () => {
  const e = await startServer({
    WORKER_COUNT: '1',
    MAX_CONCURRENT_TASKS: '1',
    SHUTDOWN_GRACE_MS: '300',
    TASK_TIMEOUT_MS: '60000',
    MAX_INPUT_PIXELS: '50000000',
    MAX_TARGET_TOTAL_PIXELS: '40000000',
  });
  const submitted = await submitTask(e.port, slowTask({ idempotencyKey: 'interrupt-1' }));
  assert(submitted.status === 202, `submit -> ${submitted.status}`);
  const id = submitted.json.taskId;
  await waitForStatus(e.port, id, 'processing');
  const exitCode = await e.stop();
  console.log(`    SIGTERM with 300ms grace -> exit code ${exitCode}`);
  assert(exitCode === 0, `expected clean exit, got ${exitCode}`);

  const e2 = await startServer({}, { dataDir: e.dataDir });
  const task = await getTask(e2.port, id);
  console.log(`    after restart: task ${task.status} (${task.error && task.error.code})`);
  assert(task.status === 'failed', `interrupted task reported as ${task.status}`);
  assert(task.error.code === 'interrupted_by_shutdown', JSON.stringify(task.error));
  assert(task.outputs === null, 'interrupted task exposes outputs');
  const dl = await api(e2.port, 'GET', `/tasks/${id}/outputs/0`);
  assert(dl.status === 409, `output of interrupted task -> ${dl.status}`);
  assert(listDir(path.join(e2.dataDir, 'tmp')).length === 0, 'tmp dir not cleaned on restart');
  assert(!listDir(path.join(e2.dataDir, 'tasks')).includes(id), 'stale outputs were published');

  // Idempotency survives the restart: same key + same content replays the
  // original (failed) task instead of silently creating a new one.
  const replay = await submitTask(e2.port, slowTask({ idempotencyKey: 'interrupt-1' }));
  console.log(`    resubmit after restart -> ${replay.status}, same task: ${replay.json.taskId === id}`);
  assert(replay.status === 200 && replay.json.taskId === id, 'idempotent replay broken by restart');
  await e2.stop();
});

// ---------------------------------------------------------------------------

(async () => {
  const servers = {};
  let exitCode = 1;
  try {
    console.log('== starting server A (functional) ==');
    servers.a = await startServer({
      WORKER_COUNT: '1',
      MAX_CONCURRENT_TASKS: '1',
      MAX_QUEUE_LENGTH: '2',
      TASK_TIMEOUT_MS: '30000',
      SHUTDOWN_GRACE_MS: '5000',
      MAX_INPUT_PIXELS: '50000000',
      MAX_TARGET_TOTAL_PIXELS: '40000000',
      WORKER_ALLOW_DEBUG_CRASH: '1',
    });
    console.log('== starting server B (limits) ==');
    servers.b = await startServer({
      MAX_UPLOAD_BYTES: '20000',
      MAX_INPUT_PIXELS: '10000',
      MAX_TARGET_TOTAL_PIXELS: '20000',
    });
    console.log('== starting server C (timeout) ==');
    servers.c = await startServer({
      WORKER_COUNT: '1',
      MAX_CONCURRENT_TASKS: '1',
      TASK_TIMEOUT_MS: '400',
      MAX_INPUT_PIXELS: '50000000',
      MAX_TARGET_TOTAL_PIXELS: '40000000',
    });

    let passed = 0;
    let failed = 0;
    for (const { name, fn } of tests) {
      const server = servers[name[0].toLowerCase()];
      console.log(`\n▶ ${name}`);
      try {
        await fn(server);
        passed += 1;
        console.log(`  ✓ ${name}`);
      } catch (err) {
        failed += 1;
        console.error(`  ✗ ${name}\n    ${err.message}`);
      }
    }
    console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
    exitCode = failed === 0 ? 0 : 1;
  } finally {
    killAllServers();
  }
  // Child-process stdio pipes would otherwise keep this process alive.
  process.exit(exitCode);
})();
