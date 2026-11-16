'use strict';

const path = require('path');

function intFrom(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  return value;
}

/**
 * Reproducible startup configuration. Every knob comes from an environment
 * variable with a documented default; `main.js` prints the resolved config
 * at boot so a deployment can be reproduced exactly.
 */
function loadConfig(env = process.env) {
  return {
    host: env.HOST || '127.0.0.1',
    port: intFrom(env, 'PORT', 8080),
    // Root for job records, published outputs and temporary staging files.
    dataDir: env.DATA_DIR
      ? path.resolve(env.DATA_DIR)
      : path.join(process.cwd(), 'data'),

    // --- admission limits (rejection frees no slot because none is taken) ---
    maxUploadBytes: intFrom(env, 'MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
    maxInputPixels: intFrom(env, 'MAX_INPUT_PIXELS', 40_000_000),
    maxTargetTotalPixels: intFrom(env, 'MAX_TARGET_TOTAL_PIXELS', 4_000_000),
    maxTargetsPerTask: intFrom(env, 'MAX_TARGETS_PER_TASK', 16),
    maxConcurrentTasks: intFrom(env, 'MAX_CONCURRENT_TASKS', 2),
    maxQueueLength: intFrom(env, 'MAX_QUEUE_LENGTH', 8),

    // --- processing ---
    workerCount: intFrom(env, 'WORKER_COUNT', 2),
    taskTimeoutMs: intFrom(env, 'TASK_TIMEOUT_MS', 30_000),
    // jpeg-js decode backstops (defense in depth on top of maxInputPixels).
    decodeMaxResolutionMP: intFrom(env, 'DECODE_MAX_RESOLUTION_MP', 100),
    decodeMaxMemoryMB: intFrom(env, 'DECODE_MAX_MEMORY_MB', 512),

    // --- lifecycle ---
    shutdownGraceMs: intFrom(env, 'SHUTDOWN_GRACE_MS', 10_000),
    // Test-only hook: allows the acceptance suite to ask a worker to crash.
    allowDebugCrash: env.WORKER_ALLOW_DEBUG_CRASH === '1',
  };
}

module.exports = { loadConfig };
