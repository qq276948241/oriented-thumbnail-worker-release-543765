'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { JobAbortedError } = require('./pool');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Owns the task state machine, admission limits, idempotency, persistence
 * and the temp/publish file lifecycle.
 *
 * State machine:
 *   queued -> processing -> succeeded | failed
 *   queued|processing -> cancelled
 * Terminal states are immutable: a late worker result can never flip a
 * cancelled/failed task back to success.
 *
 * On-disk layout under dataDir:
 *   jobs/<id>.json     durable task record, rewritten on every transition
 *   tmp/<id>/          staging: input.jpg + out-N.jpg before publish
 *   tasks/<id>/        published outputs, renamed atomically from tmp/<id>
 *
 * A task only becomes downloadable after the whole group of targets has been
 * encoded and the directory rename + job record write have both happened.
 */
class TaskManager extends EventEmitter {
  constructor(config, pool) {
    super();
    this.config = config;
    this.pool = pool;
    this.tasks = new Map(); // id -> task record
    this.waiting = []; // task ids, FIFO
    this.active = new Map(); // id -> { abort, done: Promise }
    this.timers = new Map(); // id -> timeout handle
    this.idempotency = new Map(); // key -> { contentHash, taskId }
    this.shuttingDown = false;

    this.jobsDir = path.join(config.dataDir, 'jobs');
    this.tmpDir = path.join(config.dataDir, 'tmp');
    this.tasksDir = path.join(config.dataDir, 'tasks');
    for (const dir of [this.jobsDir, this.tmpDir, this.tasksDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this._recover();
    this.pool.on('idle', () => this._pump());
  }

  // --- recovery -----------------------------------------------------------

  _recover() {
    // Anything left in tmp/ belongs to a task that never published: drop it.
    for (const entry of fs.readdirSync(this.tmpDir)) {
      fs.rmSync(path.join(this.tmpDir, entry), { recursive: true, force: true });
    }
    for (const file of fs.readdirSync(this.jobsDir)) {
      if (!file.endsWith('.json')) continue;
      let record;
      try {
        record = JSON.parse(fs.readFileSync(path.join(this.jobsDir, file), 'utf8'));
      } catch {
        continue; // unreadable record: ignore, never report as success
      }
      if (record.status === 'queued' || record.status === 'processing') {
        // The process died before finishing: never report as succeeded.
        record.status = 'failed';
        record.error = {
          code: 'interrupted_by_restart',
          message: 'Task was incomplete when the service stopped',
        };
        record.updatedAt = new Date().toISOString();
        this._save(record);
      }
      this.tasks.set(record.id, record);
      if (record.idempotencyKey) {
        this.idempotency.set(record.idempotencyKey, {
          contentHash: record.contentHash,
          taskId: record.id,
        });
      }
    }
    // Remove published directories whose record is not 'succeeded' (crash
    // between rename and record write), so stale files are never served and
    // never claimed by a new task.
    for (const entry of fs.readdirSync(this.tasksDir)) {
      const record = this.tasks.get(entry);
      if (!record || record.status !== 'succeeded') {
        fs.rmSync(path.join(this.tasksDir, entry), { recursive: true, force: true });
      }
    }
  }

  // --- persistence ----------------------------------------------------------

  _save(task) {
    // Small JSON record; synchronous write keeps every transition durable
    // without complicating the state machine.
    const file = path.join(this.jobsDir, `${task.id}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
    fs.renameSync(tmp, file);
  }

  // --- submission -----------------------------------------------------------

  contentHashFor(image, params) {
    return crypto.createHash('sha256')
      .update(image)
      .update('\0')
      .update(canonical(params))
      .digest('hex');
  }

  /**
   * Idempotency pre-check, done before admission limits so that a faithful
   * replay always returns the original task, even one recorded under
   * different limits.
   * @returns {{ task: object } | { conflict: true } | null}
   */
  checkIdempotency(idempotencyKey, image, params) {
    if (!idempotencyKey) return null;
    const existing = this.idempotency.get(idempotencyKey);
    if (!existing) return null;
    if (existing.contentHash !== this.contentHashFor(image, params)) {
      return { conflict: true };
    }
    return { task: this.tasks.get(existing.taskId) };
  }

  /**
   * @returns {{ task: object, replay: boolean }}
   * @throws HttpError 409 idempotency_conflict | 429 queue_full
   */
  submit({ idempotencyKey, image, params }) {
    if (this.shuttingDown) {
      throw new HttpError(503, 'shutting_down', 'Service is shutting down');
    }
    const contentHash = this.contentHashFor(image, params);

    if (idempotencyKey) {
      const existing = this.idempotency.get(idempotencyKey);
      if (existing) {
        if (existing.contentHash !== contentHash) {
          throw new HttpError(
            409,
            'idempotency_conflict',
            'Idempotency key was already used with different content',
          );
        }
        return { task: this.tasks.get(existing.taskId), replay: true };
      }
    }

    const capacity = this.config.maxConcurrentTasks + this.config.maxQueueLength;
    if (this.active.size + this.waiting.length >= capacity) {
      // Rejected before any slot is taken: nothing to release.
      throw new HttpError(429, 'queue_full', 'Too many tasks in flight, retry later');
    }

    const now = new Date().toISOString();
    const task = {
      id: crypto.randomUUID(),
      idempotencyKey: idempotencyKey || null,
      contentHash,
      status: 'queued',
      error: null,
      params,
      outputs: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, { contentHash, taskId: task.id });
    }

    // Stage the upload so queued tasks hold no large buffers in memory and
    // the temp lifecycle is visible on disk.
    fs.mkdirSync(this._stagingDir(task.id), { recursive: true });
    fs.writeFileSync(this._inputFile(task.id), image);

    this._save(task);
    this.waiting.push(task.id);
    this._armTimeout(task.id);
    this._pump();
    return { task, replay: false };
  }

  // --- dispatch -------------------------------------------------------------

  _pump() {
    if (this.shuttingDown) return;
    while (
      this.waiting.length > 0 &&
      this.active.size < this.config.maxConcurrentTasks &&
      this.pool.idleCount() > 0
    ) {
      const id = this.waiting.shift();
      const task = this.tasks.get(id);
      if (!task || task.status !== 'queued') continue;
      this._start(task);
    }
  }

  _start(task) {
    let image;
    try {
      image = fs.readFileSync(this._inputFile(task.id));
    } catch (err) {
      this._finish(task, 'failed', {
        code: 'staging_lost',
        message: `Staged input disappeared: ${err.message}`,
      });
      return;
    }
    this._transition(task, 'processing');

    const payload = {
      jobId: task.id,
      image,
      orientation: task.params.orientation || null,
      targets: task.params.targets,
      decodeLimits: {
        maxResolutionInMP: this.config.decodeMaxResolutionMP,
        maxMemoryUsageInMB: this.config.decodeMaxMemoryMB,
      },
    };
    if (task.params.debugCrash && this.config.allowDebugCrash) {
      payload.debugCrash = true;
    }

    let handle;
    try {
      handle = this.pool.exec(payload);
    } catch (err) {
      this._finish(task, 'failed', { code: 'pool_error', message: err.message });
      return;
    }

    const entry = { abort: handle.abort };
    entry.done = handle.promise
      .then((msg) => this._onProcessed(task, msg))
      .catch((err) => {
        if (err instanceof JobAbortedError) return; // cancel/timeout already handled
        this._finish(task, 'failed', {
          code: err.code || 'processing_failed',
          message: err.message,
        });
      })
      .finally(() => {
        if (this.active.get(task.id) === entry) this.active.delete(task.id);
        this._pump();
      });
    this.active.set(task.id, entry);
  }

  async _onProcessed(task, msg) {
    // Late result for a task that was cancelled/failed meanwhile: the
    // terminal state wins, nothing is published.
    if (task.status !== 'processing') return;
    try {
      const dir = this._stagingDir(task.id);
      const outputs = [];
      for (const result of msg.results) {
        const file = `out-${result.index}.jpg`;
        await fs.promises.writeFile(path.join(dir, file), result.data);
        outputs.push({
          index: result.index,
          width: result.width,
          height: result.height,
          file,
        });
      }
      await fs.promises.rm(this._inputFile(task.id), { force: true });
      if (task.status !== 'processing') {
        // Lost the race with cancel/timeout while writing: leave nothing.
        await fs.promises.rm(dir, { recursive: true, force: true });
        return;
      }
      // Atomic publish: the whole group appears under tasks/<id> at once.
      await fs.promises.rename(dir, path.join(this.tasksDir, task.id));
      task.outputs = outputs;
      this._finish(task, 'succeeded', null, { alreadyCleaned: true });
    } catch (err) {
      this._finish(task, 'failed', {
        code: 'publish_failed',
        message: err.message,
      });
    }
  }

  // --- transitions ------------------------------------------------------------

  _transition(task, status) {
    task.status = status;
    task.updatedAt = new Date().toISOString();
    this._save(task);
  }

  _finish(task, status, error, { alreadyCleaned = false } = {}) {
    if (TERMINAL.has(task.status)) return; // terminal states are immutable
    task.status = status;
    task.error = error;
    task.updatedAt = new Date().toISOString();
    this._save(task);
    this._clearTimeout(task.id);
    const entry = this.active.get(task.id);
    if (entry) {
      this.active.delete(task.id);
      entry.abort().catch(() => {});
    }
    if (!alreadyCleaned) {
      fs.promises.rm(this._stagingDir(task.id), { recursive: true, force: true })
        .catch(() => {});
    }
    this._pump();
  }

  // --- timeout / cancel -------------------------------------------------------

  _armTimeout(id) {
    const timer = setTimeout(() => {
      this.timers.delete(id);
      const task = this.tasks.get(id);
      if (!task || TERMINAL.has(task.status)) return;
      this._removeFromQueue(id);
      this._finish(task, 'failed', {
        code: 'task_timeout',
        message: `Task exceeded ${this.config.taskTimeoutMs}ms`,
      });
    }, this.config.taskTimeoutMs);
    if (timer.unref) timer.unref();
    this.timers.set(id, timer);
  }

  _clearTimeout(id) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  _removeFromQueue(id) {
    const at = this.waiting.indexOf(id);
    if (at !== -1) this.waiting.splice(at, 1);
  }

  /**
   * @throws HttpError 404 not_found | 409 task_not_cancellable
   */
  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) throw new HttpError(404, 'not_found', 'Unknown task');
    if (TERMINAL.has(task.status)) {
      throw new HttpError(
        409,
        'task_not_cancellable',
        `Task is already ${task.status}`,
      );
    }
    this._removeFromQueue(id);
    this._finish(task, 'cancelled', null);
    return task;
  }

  // --- queries ------------------------------------------------------------------

  get(id) {
    return this.tasks.get(id) || null;
  }

  outputFile(task, index) {
    if (!task || task.status !== 'succeeded' || !task.outputs) return null;
    const output = task.outputs.find((o) => o.index === index);
    if (!output) return null;
    return path.join(this.tasksDir, task.id, output.file);
  }

  // --- shutdown -----------------------------------------------------------------

  /**
   * Stop admitting and dispatching, fail everything still queued, wait for
   * in-flight tasks up to `graceMs`, then abort whatever remains. Every
   * unfinished task ends in a terminal non-success state, so a restart can
   * never report it as succeeded.
   */
  async shutdown(graceMs) {
    this.shuttingDown = true;
    for (const id of [...this.waiting]) {
      const task = this.tasks.get(id);
      this._removeFromQueue(id);
      if (task) {
        this._finish(task, 'failed', {
          code: 'interrupted_by_shutdown',
          message: 'Service stopped before the task started',
        });
      }
    }
    const pending = [...this.active.values()].map((e) => e.done);
    if (pending.length > 0 && graceMs > 0) {
      let expired;
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => {
          expired = setTimeout(resolve, graceMs);
          if (expired.unref) expired.unref();
        }),
      ]);
      if (expired) clearTimeout(expired);
    }
    for (const [id] of [...this.active]) {
      const task = this.tasks.get(id);
      if (task) {
        this._finish(task, 'failed', {
          code: 'interrupted_by_shutdown',
          message: 'Service stopped before the task finished',
        });
      }
    }
    for (const id of this.timers.keys()) this._clearTimeout(id);
  }

  _stagingDir(id) {
    return path.join(this.tmpDir, id);
  }

  _inputFile(id) {
    return path.join(this._stagingDir(id), 'input.jpg');
  }
}

module.exports = { TaskManager, HttpError, TERMINAL };
