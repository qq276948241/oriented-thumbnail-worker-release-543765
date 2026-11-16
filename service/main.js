'use strict';

/**
 * Service entry point.
 *
 *   node service/main.js
 *
 * Every configuration knob is an environment variable (see config.js); the
 * resolved configuration is printed at boot so a deployment is reproducible.
 * SIGTERM/SIGINT trigger a graceful shutdown: stop accepting new work, wait
 * for in-flight tasks up to SHUTDOWN_GRACE_MS, abort the rest, then exit.
 */

const { loadConfig } = require('./config');
const { WorkerPool } = require('./pool');
const { TaskManager } = require('./task-manager');
const { createServer } = require('./server');

function main() {
  const config = loadConfig();
  // Reproducible startup: the full effective configuration goes to the log.
  console.log(`[thumbnail-service] config ${JSON.stringify(config)}`);

  const pool = new WorkerPool({
    size: config.workerCount,
    workerData: { allowDebugCrash: config.allowDebugCrash },
  });
  const manager = new TaskManager(config, pool);
  const { server, state } = createServer(config, manager);

  server.listen(config.port, config.host, () => {
    console.log(
      `[thumbnail-service] listening on http://${config.host}:${config.port} ` +
      `(pid ${process.pid})`,
    );
  });

  let shutdownStarted = false;
  const shutdown = (signal) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    state.shuttingDown = true;
    console.log(`[thumbnail-service] ${signal} received, draining`);

    // Hard backstop: never hang past the grace window plus a margin.
    const forceTimer = setTimeout(() => {
      console.error('[thumbnail-service] forced exit');
      process.exit(1);
    }, config.shutdownGraceMs + 5000);
    forceTimer.unref();

    // Stop accepting new connections immediately; in-flight requests and
    // accepted tasks get the grace window.
    server.close();
    manager
      .shutdown(config.shutdownGraceMs)
      .then(() => pool.close())
      .then(() => {
        clearTimeout(forceTimer);
        console.log('[thumbnail-service] clean exit');
        process.exit(0);
      })
      .catch((err) => {
        console.error(`[thumbnail-service] shutdown error: ${err.stack || err}`);
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
