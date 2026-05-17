'use strict';
require('dotenv').config();
const http   = require('http');
const path   = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const analytics    = require('./analytics');
const auth         = require('./auth');
const gameManager  = require('./games/game-manager');
const siteRouting  = require('./site-routing');
const hubRenderer  = require('./games/marketing-hub-renderer');
const creategameRenderer = require('./games/creategame-renderer');
const lobbyRenderer       = require('./games/lobby-renderer');
const interactiveTutorialRenderer = require('./games/interactive-tutorial-renderer');

const PORT = process.env.PORT || 8090;

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  let pathname = parsed.pathname;

  // ── Admin API endpoints ──
  if (pathname === '/track'                && req.method === 'POST') return analytics.handleTrack(req, res);
  if (pathname === '/admin/verify'         && req.method === 'POST') return auth.handleAdminVerify(req, res);
  if (pathname === '/admin/session'        && req.method === 'GET')  return auth.handleAdminSession(req, res);
  if (pathname === '/admin/signout'        && req.method === 'POST') return auth.handleAdminSignout(req, res);
  if (pathname === '/admin/metrics'        && req.method === 'GET')  return analytics.handleAdminMetrics(req, res, auth.verifyToken, auth.getSessionCookie);
  if (pathname === '/admin/metrics/export' && req.method === 'GET')  return analytics.handleAdminExportCSV(req, res, auth.verifyToken, auth.getSessionCookie);

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

wss.on('connection', (ws, req) => {
  // Capture visitor key at connection time for session attribution
  const ip  = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  gameManager.wsUvKey.set(ws, crypto.createHash('sha256').update(ip + '|' + day).digest('hex').slice(0, 24));

  ws.on('message', (raw) => gameManager.handleMessage(ws, raw.toString()));
  ws.on('close', () => {
    for (const [, room] of gameManager.rooms) {
      if (room.eventOrganizers) room.eventOrganizers = room.eventOrganizers.filter(w => w !== ws);
    }
    gameManager.leaveRoom(ws, false);
    gameManager.wsUvKey.delete(ws);
  });
  ws.on('error', () => {
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

module.exports = { server, wss };
