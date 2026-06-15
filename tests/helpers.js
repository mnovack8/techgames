'use strict';
/**
 * tests/helpers.js
 * Shared utilities: server lifecycle, HTTP requests, WebSocket client.
 *
 * Call startServer() before tests, stopServer() after.
 * Re-requires the server module fresh each test file by setting env vars
 * BEFORE the first require — Node caches modules, so helpers must be loaded
 * once per test process (which node --test does by default per file).
 */

const http   = require('http');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const { WebSocket } = require('ws');

// ── Temp metrics file ────────────────────────────────────────────────────────
// Point analytics at a throwaway file so tests don't pollute production data.
const TEMP_METRICS = path.join(os.tmpdir(), `techgames-test-metrics-${process.pid}.json`);
process.env.METRICS_FILE = TEMP_METRICS;

// Collapse bot animation delays so full-game tests finish in seconds, not minutes.
process.env.TEST_MODE = '1';
// Use a throwaway state dir so tests never read stale production rooms.
const TEMP_STATE_DIR = path.join(os.tmpdir(), `techgames-test-state-${process.pid}`);
process.env.STATE_DIR = TEMP_STATE_DIR;

// ── Server lifecycle ─────────────────────────────────────────────────────────

/** Start the server on a random OS-assigned port. Returns { server, wss, port }. */
async function startServer() {
  // Require fresh each invocation (works because node:test runs each file in its own process)
  const { server, wss } = require('../server');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return { server, wss, port };
}

/** Gracefully close all WS clients then the HTTP server. */
function stopServer({ server, wss }) {
  // Mark all active game states as over so bot async loops exit cleanly.
  // Without this, bot timers hold stale room references and keep spinning after
  // WS connections are terminated, flooding the test runner's async hook map.
  try {
    const { rooms } = require('../games/game-manager');
    for (const room of rooms.values()) {
      if (room.state)   room.state.gameOver  = true;
      if (room.bcState) room.bcState.phase   = 'game_over';
      if (room.cfState) room.cfState.gameOver = true;
    }
  } catch {}

  // Terminate all connected WebSocket clients
  for (const client of wss.clients) {
    try { client.terminate(); } catch {}
  }

  // Unref the server so it doesn't prevent process exit, then close it.
  // We do NOT await server.close() — the after() hook returning is enough
  // for the test runner to finalize. Any unref'd handles drain naturally.
  server.unref();
  try { wss.close(); } catch {}
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  try { server.close(); } catch {}

  // Clean up temp metrics file
  try { fs.unlinkSync(TEMP_METRICS); } catch {}

  // Schedule a forced exit to let the test runner flush its TAP output
  // before terminating.  The HTTP Server handle keeps the event loop alive
  // even when unref'd under node:test's async_hooks tracking; without this
  // the child process hangs indefinitely after all tests pass.
  // setImmediate gives the test runner one more event loop tick to report
  // results, then we exit regardless of lingering handles.
  setImmediate(() => process.exit(0));
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

/**
 * Make an HTTP request to the test server.
 * @param {number} port
 * @param {string} urlPath  e.g. '/about'
 * @param {{ method?, headers?, body?, followRedirects? }} [opts]
 * @returns {Promise<{ status, headers, body }>}
 */
function httpRequest(port, urlPath, opts = {}) {
  const method  = opts.method  || 'GET';
  const headers = opts.headers || {};
  const body    = opts.body    || null;

  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers,
    };
    const req = http.request(reqOpts, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (chunks += c));
      res.on('end',  () => resolve({ status: res.statusCode, headers: res.headers, body: chunks }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── WebSocket client ─────────────────────────────────────────────────────────

/**
 * Queue-based WebSocket test client.
 * - send(msg)        — JSON-stringify and send
 * - next(type?)      — resolve with next message (optionally matching type)
 * - drain()          — resolve with all queued messages
 * - close()          — close the socket
 */
class WsClient {
  constructor(ws) {
    this._ws        = ws;
    this._queue     = [];  // buffered messages not yet consumed
    this._resolvers = [];  // { type: string|null, resolve, timeoutId }
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Find the earliest resolver that accepts this message type
    const idx = this._resolvers.findIndex(r => r.type == null || r.type === msg.type);
    if (idx !== -1) {
      const [{ resolve, timeoutId }] = this._resolvers.splice(idx, 1);
      clearTimeout(timeoutId);
      resolve(msg);
    } else {
      this._queue.push(msg);
    }
  }

  send(msg) {
    this._ws.send(JSON.stringify(msg));
  }

  /**
   * Wait for the next message (optionally of a specific type).
   * Messages not matching type accumulate in the queue for later.
   */
  next(type = null, timeoutMs = 5000) {
    // Immediately satisfy from queue
    if (type == null && this._queue.length > 0) {
      return Promise.resolve(this._queue.shift());
    }
    if (type != null) {
      const i = this._queue.findIndex(m => m.type === type);
      if (i !== -1) return Promise.resolve(this._queue.splice(i, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const entry = { type, resolve: null, timeoutId: null };
      entry.timeoutId = setTimeout(() => {
        const i = this._resolvers.indexOf(entry);
        if (i !== -1) this._resolvers.splice(i, 1);
        reject(new Error(`WsClient timeout waiting for msg type="${type ?? 'any'}"`));
      }, timeoutMs);
      entry.resolve = resolve;
      this._resolvers.push(entry);
    });
  }

  /** Collect all messages already in the buffer. */
  drain() {
    const all = this._queue.slice();
    this._queue = [];
    return all;
  }

  close() {
    this._ws.close();
  }
}

/**
 * Open a WebSocket connection to the test server.
 * @returns {Promise<WsClient>}
 */
function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = new WsClient(ws);
    ws.on('message', (raw) => client._onMessage(raw));
    ws.on('open',  () => resolve(client));
    ws.on('error', reject);
  });
}

// ── Small delay helper ───────────────────────────────────────────────────────
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startServer, stopServer, httpRequest, connectWs, WsClient, delay };
