'use strict';
const path = require('path');
const fs   = require('fs');
const hubRenderer = require('./games/marketing-hub-renderer');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.pdf':  'application/pdf',
  '.xml':  'application/xml; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
};

// ── Legacy-URL redirects (301) ───────────────────────────────────────────────
const REDIRECTS = {
  // Legacy AI paths → new nested structure under /ai
  '/ai/neural-network':           '/ai/neural-network/fuzznet',
  '/ai/neural-network.html':      '/ai/neural-network/fuzznet',
  '/ai-neural-network':           '/ai/neural-network/fuzznet',
  '/ai-neural-network.html':      '/ai/neural-network/fuzznet',
  '/ai-neural-network/fuzznet':   '/ai/neural-network/fuzznet',
  '/ai-neural-network/fuzznet.html': '/ai/neural-network/fuzznet',
  '/ai/knn':                      '/ai/knn/clusterflick',
  '/ai/knn.html':                 '/ai/knn/clusterflick',
  '/ai-knn':                      '/ai/knn/clusterflick',
  '/ai-knn.html':                 '/ai/knn/clusterflick',
  '/ai-knn/clusterflick':         '/ai/knn/clusterflick',
  '/ai-knn/clusterflick.html':    '/ai/knn/clusterflick',
  '/knn':       '/ai/knn/clusterflick',
  '/knn.html':  '/ai/knn/clusterflick',
  '/qubit-waitlist': '/quantumcomputing', '/qubit-waitlist.html': '/quantumcomputing',
  '/cybersecurity': '/cybersecurity/byteclub', '/cybersecurity.html': '/cybersecurity/byteclub',
};

/**
 * Resolve a URL pathname to a file path.
 * Returns { filePath, contentType } or null if the caller should handle it as an API route.
 */
function resolvePathname(pathname) {
  if (REDIRECTS[pathname]) {
    return { redirect: REDIRECTS[pathname] };
  }

  // ── Marketing hub pages: auto-discovered from games/<key>/marketing.json files.
  //    Each JSON's "routes" array registers the URL(s) it serves.
  const hubRoutes = hubRenderer.getHubRoutes();
  if (hubRoutes.has(pathname)) {
    return { renderHub: hubRoutes.get(pathname), contentType: 'text/html; charset=utf-8' };
  }

  // ── URL → file path ───────────────────────────────────────────────────────

  if (pathname === '/ai' || pathname === '/ai.html') pathname = '/games/ai/index.html';
  else if (
    pathname === '/ai/neural-network/fuzznet' ||
    pathname === '/ai/neural-network/fuzznet.html' ||
    pathname === '/ai/neural-network/fuzznet/lobby' ||
    pathname === '/ai/neural-network/fuzznet/activegame' ||
    pathname === '/ai/neural-network/fuzznet/tutorial'
  ) pathname = '/games/ai-neural-network/fuzznet.html';
  else if (
    pathname === '/ai/knn/clusterflick' ||
    pathname === '/ai/knn/clusterflick.html' ||
    pathname === '/ai/knn/clusterflick/lobby' ||
    pathname === '/ai/knn/clusterflick/activegame' ||
    pathname === '/ai/knn/clusterflick/tutorial'
  ) pathname = '/games/ai-knn/clusterflick.html';
  else if (
    pathname === '/cybersecurity/byteclub' ||
    pathname === '/cybersecurity/byteclub.html' ||
    pathname === '/cybersecurity/byteclub/lobby' ||
    pathname === '/cybersecurity/byteclub/activegame' ||
    pathname === '/cybersecurity/byteclub/tutorial'
  ) pathname = '/games/cybersecurity/byteclub.html';
  else if (pathname === '/quantumcomputing' || pathname === '/quantumcomputing.html') pathname = '/games/quantumcomputing.html';
  else if (pathname === '/services' || pathname === '/services.html') pathname = '/singlepage/services.html';
  else if (pathname === '/contact' || pathname === '/contact.html') pathname = '/singlepage/contact.html';
  else if (pathname === '/about' || pathname === '/about.html') pathname = '/singlepage/about.html';
  else if (pathname === '/board-culture-change' || pathname === '/board-culture-change.html' || pathname === '/corporate-training' || pathname === '/corporate-training.html') pathname = '/use-cases/board-culture-change.html';
  else if (pathname === '/focused-deep-work' || pathname === '/focused-deep-work.html' || pathname === '/specialized-training' || pathname === '/specialized-training.html') pathname = '/use-cases/focused-deep-work.html';
  else if (pathname === '/buy-now' || pathname === '/buy-now.html') pathname = '/singlepage/buy-now.html';
  else if (pathname === '/admin' || pathname === '/admin.html') pathname = '/singlepage/admin.html';
  else if (pathname === '/blog' || pathname === '/blog.html') pathname = '/blog/index.html';
  else if (pathname.startsWith('/blog/') && !path.extname(pathname)) pathname = pathname + '.html';
  else if (pathname === '/') pathname = '/index.html';

  const filePath = path.join(__dirname, pathname);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  return { filePath, contentType };
}

/**
 * Serve a resolved file path, writing to res.
 *
 * @param {string} filePath     Absolute path to read.
 * @param {string} contentType  MIME type for the Content-Type header.
 * @param {*} res               Response object.
 * @param {object} [opts]
 * @param {(buf: Buffer) => (Buffer|string)} [opts.transform]
 *        Optional transform applied to the file contents before write
 *        (used to inject the create-game fragment into game HTML pages).
 *
 * Handles 404 with /404.html fallback and 500 on other errors.
 */
function serveFile(filePath, contentType, res, opts) {
  // Only serve files under __dirname (prevent path traversal)
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(__dirname, '/singlepage/404.html'), (e2, d2) => {
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(e2 ? 'Not Found' : d2);
        });
      } else {
        res.writeHead(500); res.end('Server Error');
      }
      return;
    }
    let payload = data;
    if (opts && typeof opts.transform === 'function') {
      try { payload = opts.transform(data); } catch (e) {
        console.error('[serveFile] transform error:', e);
        payload = data;
      }
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(payload);
  });
}

module.exports = {
  resolvePathname,
  serveFile,
  REDIRECTS,
  MIME_TYPES,
};
