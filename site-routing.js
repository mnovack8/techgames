'use strict';
const path = require('path');
const fs   = require('fs');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.pdf':  'application/pdf',
};

// ── Legacy-URL redirects (301) ───────────────────────────────────────────────
const REDIRECTS = {
  '/knn': '/ai-knn', '/knn.html': '/ai-knn',
  '/ai':  '/ai-neural-network', '/ai.html':  '/ai-neural-network',
  '/qubit-waitlist': '/quantumcomputing', '/qubit-waitlist.html': '/quantumcomputing',
};

/**
 * Resolve a URL pathname to a file path.
 * Returns { filePath, contentType } or null if the caller should handle it as an API route.
 */
function resolvePathname(pathname) {
  if (REDIRECTS[pathname]) {
    return { redirect: REDIRECTS[pathname] };
  }

  // ── URL → file path ───────────────────────────────────────────────────────
  if (pathname === '/cybersecurity/byteclub' || pathname === '/cybersecurity/byteclub.html') pathname = '/games/cybersecurity/byteclub.html';
  else if (pathname === '/ai-neural-network/fuzznet' || pathname === '/ai-neural-network/fuzznet.html') pathname = '/games/ai-neural-network/fuzznet.html';
  else if (pathname === '/ai-knn/clusterflick' || pathname === '/ai-knn/clusterflick.html') pathname = '/games/ai-knn/clusterflick.html';
  else if (pathname === '/ai-knn' || pathname === '/ai-knn.html') pathname = '/games/ai-knn/index.html';
  else if (pathname === '/cybersecurity' || pathname === '/cybersecurity.html') pathname = '/games/cybersecurity/index.html';
  else if (pathname === '/ai-neural-network' || pathname === '/ai-neural-network.html') pathname = '/games/ai-neural-network/index.html';
  else if (pathname === '/quantumcomputing' || pathname === '/quantumcomputing.html') pathname = '/games/quantumcomputing.html';
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
 * Handles 404 with /404.html fallback and 500 on other errors.
 */
function serveFile(filePath, contentType, res) {
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
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

module.exports = {
  resolvePathname,
  serveFile,
  REDIRECTS,
  MIME_TYPES,
};
