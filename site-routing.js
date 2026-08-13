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

// ── URL aliases → canonical file path ────────────────────────────────────────
const PATH_ALIASES = {
  '/ai':      '/games/ai/index.html',
  '/ai.html': '/games/ai/index.html',

  '/ai/neural-network/fuzznet':            '/games/ai-neural-network/fuzznet.html',
  '/ai/neural-network/fuzznet.html':       '/games/ai-neural-network/fuzznet.html',
  '/ai/neural-network/fuzznet/lobby':      '/games/ai-neural-network/fuzznet.html',
  '/ai/neural-network/fuzznet/activegame': '/games/ai-neural-network/fuzznet.html',
  '/ai/neural-network/fuzznet/tutorial':   '/games/ai-neural-network/fuzznet.html',

  '/ai/knn/clusterflick':            '/games/ai-knn/clusterflick.html',
  '/ai/knn/clusterflick.html':       '/games/ai-knn/clusterflick.html',
  '/ai/knn/clusterflick/lobby':      '/games/ai-knn/clusterflick.html',
  '/ai/knn/clusterflick/activegame': '/games/ai-knn/clusterflick.html',
  '/ai/knn/clusterflick/tutorial':   '/games/ai-knn/clusterflick.html',

  '/cybersecurity/byteclub':            '/games/cybersecurity/byteclub.html',
  '/cybersecurity/byteclub.html':       '/games/cybersecurity/byteclub.html',
  '/cybersecurity/byteclub/lobby':      '/games/cybersecurity/byteclub.html',
  '/cybersecurity/byteclub/activegame': '/games/cybersecurity/byteclub.html',
  '/cybersecurity/byteclub/tutorial':   '/games/cybersecurity/byteclub.html',

  '/quantumcomputing/qubit':            '/games/quantumcomputing/qubit.html',
  '/quantumcomputing/qubit.html':       '/games/quantumcomputing/qubit.html',
  '/quantumcomputing/qubit/lobby':      '/games/quantumcomputing/qubit.html',
  '/quantumcomputing/qubit/activegame': '/games/quantumcomputing/qubit.html',
  '/quantumcomputing/qubit/tutorial':   '/games/quantumcomputing/qubit.html',

  '/services':      '/singlepage/services.html',
  '/services.html': '/singlepage/services.html',
  '/contact':        '/singlepage/contact.html',
  '/contact.html':   '/singlepage/contact.html',
  '/about':          '/singlepage/about.html',
  '/about.html':     '/singlepage/about.html',
  '/buy-now':        '/singlepage/buy-now.html',
  '/buy-now.html':   '/singlepage/buy-now.html',
  '/admin':          '/singlepage/admin.html',
  '/admin.html':     '/singlepage/admin.html',
  '/blog':           '/blog/index.html',
  '/blog.html':      '/blog/index.html',

  '/cybersecurity-literacy-use-case':      '/cybersecurity-literacy-use-case.html',
  '/cybersecurity-literacy-use-case.html': '/cybersecurity-literacy-use-case.html',
  '/corporate-training':                   '/cybersecurity-literacy-use-case.html',
  '/corporate-training.html':              '/cybersecurity-literacy-use-case.html',

  '/ai-literacy-use-case':      '/ai-literacy-use-case.html',
  '/ai-literacy-use-case.html': '/ai-literacy-use-case.html',
  '/specialized-training':      '/ai-literacy-use-case.html',
  '/specialized-training.html': '/ai-literacy-use-case.html',
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
  '/qubit-waitlist': '/quantumcomputing/qubit', '/qubit-waitlist.html': '/quantumcomputing/qubit',
  '/quantumcomputing': '/quantumcomputing/qubit', '/quantumcomputing.html': '/quantumcomputing/qubit',
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

  if (PATH_ALIASES[pathname]) pathname = PATH_ALIASES[pathname];
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
