'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const { EventEmitter } = require('events');

class WorkerCrashError extends Error {
  constructor(message) {
    super(message);
    this.code = 'worker_crash';
  }
}

class JobAbortedError extends Error {
  constructor(message = 'Job aborted') {
    super(message);
    this.code = 'job_aborted';
  }
}

/**
 * Fixed-size worker_thread pool. The task manager pulls work through
 * `exec()` only when it holds a concurrency slot, so the pool itself never
 * queues: `exec` throws when no worker is idle.
 *
 * Crash/abort semantics: a worker that exits for any reason while busy fails
 * its current job (WorkerCrashError) and is replaced; `abort()` terminates
 * the worker (the only way to interrupt synchronous codec work) and likewise
 * replaces it. Either way the pool emits 'idle' once a fresh worker is up,
 * which is the signal the task manager uses to release a queue slot.
 */
class WorkerPool extends EventEmitter {
  constructor({ size, workerData }) {
    super();
    this.size = size;
    this.workerData = workerData || {};
    this.workerPath = path.join(__dirname, 'worker.js');
    this.workers = new Set();
    this.idleWorkers = [];
    this.closed = false;
    for (let i = 0; i < size; i += 1) this._spawn();
  }

  _spawn() {
    if (this.closed) return;
    const worker = new Worker(this.workerPath, { workerData: this.workerData });
    worker._job = null; // { resolve, reject } while busy
    worker.on('message', (msg) => this._onMessage(worker, msg));
    worker.on('error', () => {}); // the exit handler below covers failures
    worker.on('exit', (code) => {
      this.workers.delete(worker);
      const idleAt = this.idleWorkers.indexOf(worker);
      if (idleAt !== -1) this.idleWorkers.splice(idleAt, 1);
      const job = worker._job;
      worker._job = null;
      if (job) {
        job.reject(new WorkerCrashError(`Worker exited with code ${code}`));
      }
      if (!this.closed) {
        this._spawn();
        this.emit('idle');
      }
    });
    this.workers.add(worker);
    this.idleWorkers.push(worker);
  }

  _onMessage(worker, msg) {
    const job = worker._job;
    if (!job) return; // late message for an already-settled job: drop it
    worker._job = null;
    if (msg.ok) {
      job.resolve(msg);
    } else {
      const err = new Error(msg.error);
      err.code = msg.errorCode || 'processing_failed';
      job.reject(err);
    }
    if (!this.closed) {
      this.idleWorkers.push(worker);
      this.emit('idle');
    }
  }

  idleCount() {
    return this.idleWorkers.length;
  }

  /**
   * Run one job on an idle worker. Returns { promise, abort }.
   * abort() terminates the worker; the promise rejects with JobAbortedError.
   */
  exec(payload) {
    if (this.closed) throw new Error('Pool is closed');
    const worker = this.idleWorkers.pop();
    if (!worker) throw new Error('No idle worker');

    let jobRef;
    const promise = new Promise((resolve, reject) => {
      jobRef = { resolve, reject };
      worker._job = jobRef;
    });

    const abort = () => {
      if (worker._job !== jobRef) return Promise.resolve(false);
      worker._job = null;
      jobRef.reject(new JobAbortedError());
      return worker.terminate().then(() => true);
    };

    // Copy the payload image into a fresh, exactly-sized ArrayBuffer before
    // transferring: Buffers sliced from Node's shared allocation pool cannot
    // be transferred (DataCloneError), and transferring a pooled buffer would
    // detach memory other Buffers still use.
    let transfer = [];
    if (payload.image) {
      payload.image = new Uint8Array(payload.image);
      transfer = [payload.image.buffer];
    }
    worker.postMessage(payload, transfer);
    return { promise, abort };
  }

  async close() {
    this.closed = true;
    const workers = [...this.workers];
    this.idleWorkers.length = 0;
    await Promise.all(workers.map((w) => {
      w._job = null;
      return w.terminate();
    }));
  }
}

module.exports = { WorkerPool, WorkerCrashError, JobAbortedError };
