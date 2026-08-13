'use strict';
require('dotenv').config();

// ── Process-level crash guards ───────────────────────────────────────────────
// Log unhandled errors rather than silently killing the process.
process.on('uncaughtException',  (err)       => console.error('[uncaughtException]',  err));
process.on('unhandledRejection', (reason, p) => console.error('[unhandledRejection]', reason, p));
const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const analytics    = require('./analytics');
const auth         = require('./auth');
const gameManager  = require('./games/game-manager');
const siteRouting  = require('./site-routing');
const posts        = require('./posts');
const hubRenderer  = require('./games/marketing-hub-renderer');
const creategameRenderer = require('./games/creategame-renderer');
const lobbyRenderer       = require('./games/lobby-renderer');
const interactiveTutorialRenderer = require('./games/interactive-tutorial-renderer');

const PORT = process.env.PORT || 8090;

// Timestamp of the last WebSocket message from any player.
// Used by the self-ping to decide whether the server is worth keeping awake.
let lastActivityAt = 0;

// Self-ping target: Render sets RENDER_EXTERNAL_URL automatically; other platforms
// can set SERVER_URL.  If neither is present (local dev) we skip pinging entirely.
const SELF_PING_URL = (process.env.RENDER_EXTERNAL_URL || process.env.SERVER_URL || '').replace(/\/$/, '');
const PING_INTERVAL_MS  = 4 * 60 * 1000;   // every 4 minutes
const ACTIVITY_WINDOW_MS = 60 * 60 * 1000; // stop pinging after 1 hour of silence

const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    const idleSec = lastActivityAt ? Math.floor((Date.now() - lastActivityAt) / 1000) : null;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      status          : 'ok',
      activeRooms     : gameManager.rooms.size,
      idleSeconds     : idleSec,
      uptime          : Math.floor(process.uptime()),
      selfPingEnabled : !!SELF_PING_URL,
    }));
    return;
  }
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  let pathname = parsed.pathname;

  // ── Blog posts metadata API ──
  if (pathname === '/api/posts' && req.method === 'GET') {
    const blogDir = path.join(__dirname, 'blog');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(posts.getBlogPosts(blogDir)));
    return;
  }

  // ── Admin API endpoints ──
  if (pathname === '/track'                && req.method === 'POST') return analytics.handleTrack(req, res);
  if (pathname === '/admin/verify'         && req.method === 'POST') return auth.handleAdminVerify(req, res);
  if (pathname === '/admin/session'        && req.method === 'GET')  return auth.handleAdminSession(req, res);
  if (pathname === '/admin/signout'        && req.method === 'POST') return auth.handleAdminSignout(req, res);
  if (pathname === '/admin/metrics'        && req.method === 'GET')  return analytics.handleAdminMetrics(req, res, auth.verifyToken, auth.getSessionCookie);
  if (pathname === '/admin/metrics/export' && req.method === 'GET')  return analytics.handleAdminExportCSV(req, res, auth.verifyToken, auth.getSessionCookie);
  if (pathname === '/admin/rooms'          && req.method === 'GET')  {
    const sess = auth.verifyToken(auth.getSessionCookie(req));
    if (!sess) { res.writeHead(401); return res.end(JSON.stringify({ ok: false })); }
    const roomList = [...gameManager.rooms.values()]
      .filter(r => r.started)
      .map(r => {
        const isOver = (r.state && r.state.gameOver) || (r.cfState && r.cfState.gameOver)
          || (r.bcState && r.bcState.phase === 'game_over');
        // Pull the activity log from whichever game state has one
        const log = (r.state && r.state.log)
          || (r.bcState && r.bcState.log)
          || [];
        return {
          code      : r.code,
          gameType  : r.gameType,
          started   : r.started,
          gameOver  : !!isOver,
          players   : r.players.map(p => ({ name: p.name, color: p.color, connected: p.connected, isBot: !!p.isBot })),
          observers : (r.observers || []).filter(o => o.connected).length,
          createdAt : r.createdAt,
          startedAt : r.sessionStartedAt || null,
          log       : log.slice(0, 40),
        };
      });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: roomList, uptime: Math.floor(process.uptime()) }));
  }

  // Track homepage visits — deduplicated to one unique visitor per IP per calendar day
  if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
    const uvKey = analytics.visitorKey(req);
    if (!analytics.seenVisitors.has(uvKey)) {
      analytics.seenVisitors.add(uvKey);
      const vid = analytics.rawVisitorId(req);
      const returnVisitor = analytics.knownVisitors.has(vid);
      analytics.knownVisitors.add(vid);
      const ref = req.headers['referer'] || req.headers['referrer'] || '';
      const host = (req.headers.host || '').split(':')[0];
      let referrerSource;
      if (!ref || ref.includes(host)) referrerSource = 'direct';
      else if (/google|bing|yahoo|duckduckgo|baidu|yandex/i.test(ref)) referrerSource = 'search';
      else if (/linkedin\.com/i.test(ref)) referrerSource = 'linkedin';
      else referrerSource = 'other';
      analytics.trackEvent('homepage_visit', { uvKey, vid, returnVisitor, referrerSource });
    }
  }

  // ── Legacy-URL redirects (301) ───────────────────────────────────────────────
  const qs = parsed.search || '';
  const resolved = siteRouting.resolvePathname(pathname);

  if (resolved.redirect) {
    res.writeHead(301, { Location: resolved.redirect + qs });
    res.end();
    return;
  }

  if (resolved.renderHub) {
    try {
      const html = hubRenderer.renderHub(resolved.renderHub);
      res.writeHead(200, { 'Content-Type': resolved.contentType });
      res.end(html);
    } catch (err) {
      console.error(`[hubRenderer] Failed to render ${resolved.renderHub}:`, err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server Error');
    }
    return;
  }

  // If the resolved file is a registered game page, inject any template
  // fragments (create-game + lobby/waiting + interactive tutorial) into markers.
  const relPath = '/' + path.relative(__dirname, resolved.filePath);
  const needsCreategame = creategameRenderer.getMounts().has(relPath);
  const needsLobby      = lobbyRenderer.getMounts().has(relPath);
  const needsTutorial   = interactiveTutorialRenderer.getMounts().has(relPath);
  const transform = (needsCreategame || needsLobby || needsTutorial)
    ? (buf) => {
        let html = buf.toString('utf8');
        if (needsCreategame) html = creategameRenderer.injectInto(relPath, html);
        if (needsLobby)      html = lobbyRenderer.injectInto(relPath, html);
        if (needsTutorial)   html = interactiveTutorialRenderer.injectInto(relPath, html);
        return html;
      }
    : undefined;

  siteRouting.serveFile(resolved.filePath, resolved.contentType, res, { transform });
});

const wss = new WebSocketServer({ server });

// Heartbeat: ping every 25 s to prevent NAT/proxy idle-connection kills.
// Render's load balancer drops WebSocket connections silent after ~60 s of no
// traffic; keeping pings under 30 s guarantees the connection stays alive.
// If a client misses two consecutive pings (50 s) we terminate it so the
// player's rejoin flow takes over rather than leaving a zombie socket.
const HEARTBEAT_MS = 25_000;
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);
if (heartbeatTimer.unref) heartbeatTimer.unref();

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Capture visitor key at connection time for session attribution
  const ip  = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  gameManager.wsUvKey.set(ws, crypto.createHash('sha256').update(ip + '|' + day).digest('hex').slice(0, 24));

  ws.on('message', (raw) => {
    lastActivityAt = Date.now();
    gameManager.handleMessage(ws, raw.toString());
  });
  ws.on('close', () => {
    for (const [, room] of gameManager.rooms) {
      if (room.eventOrganizers) room.eventOrganizers = room.eventOrganizers.filter(w => w !== ws);
    }
    gameManager.leaveRoom(ws, false);
    gameManager.wsUvKey.delete(ws);
  });
  ws.on('error', (err) => {
    console.error('[ws error]', err && err.message);
    for (const [, room] of gameManager.rooms) {
      if (room.eventOrganizers) room.eventOrganizers = room.eventOrganizers.filter(w => w !== ws);
    }
    gameManager.leaveRoom(ws, false);
    gameManager.wsUvKey.delete(ws);
  });
});

// Only auto-listen when run directly (not when required by tests)
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`FuzzNet Labs server running at http://localhost:${PORT}`);
  });
}

// Self-ping: keeps the platform from sleeping while games are active.
// Fires every 4 minutes but only sends a request when someone has been
// active within the last hour — after an hour of silence it stops, allowing
// the platform to sleep normally.
if (SELF_PING_URL) {
  const pingLib = SELF_PING_URL.startsWith('https') ? https : http;
  const interval = setInterval(() => {
    if (!lastActivityAt || Date.now() - lastActivityAt > ACTIVITY_WINDOW_MS) return;
    pingLib.get(`${SELF_PING_URL}/health`, (res) => { res.resume(); }).on('error', () => {});
  }, PING_INTERVAL_MS);
  if (interval.unref) interval.unref(); // don't block process exit in tests
}

module.exports = { server, wss };
