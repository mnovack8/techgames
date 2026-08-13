'use strict';
// Lightweight static preview server for local development.
// Reuses the site's real routing table (site-routing.js) so clean URLs
// like /contact, /cybersecurity-literacy-use-case, /blog/<slug> all resolve the
// same way they do in production, instead of guessing at path mappings.
const http = require('http');
const fs = require('fs');
const path = require('path');
const siteRouting = require('../site-routing');
const posts = require('../posts');

const PORT = process.env.PORT || 7711;

http.createServer((req, res) => {
  const pathname = decodeURIComponent(req.url.split('?')[0]);

  // Mirrors server.js's /api/posts handler via the shared ../posts module,
  // so the home page carousel can be previewed without the full app server.
  if (pathname === '/api/posts' && req.method === 'GET') {
    const blogDir = path.join(__dirname, '..', 'blog');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(posts.getBlogPosts(blogDir)));
    return;
  }

  const resolved = siteRouting.resolvePathname(pathname);

  if (resolved.redirect) {
    res.writeHead(302, { Location: resolved.redirect });
    res.end();
    return;
  }

  if (resolved.renderHub) {
    const hubRenderer = require('../games/marketing-hub-renderer');
    const html = hubRenderer.renderHub(resolved.renderHub);
    res.writeHead(200, { 'Content-Type': resolved.contentType });
    res.end(html);
    return;
  }

  siteRouting.serveFile(resolved.filePath, resolved.contentType, res);
}).listen(PORT, () => {
  console.log('Preview server (real site routing) listening on port ' + PORT);
});
