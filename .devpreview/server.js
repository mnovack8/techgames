'use strict';
// Lightweight static preview server for local development.
// Reuses the site's real routing table (site-routing.js) so clean URLs
// like /contact, /board-culture-change, /blog/<slug> all resolve the
// same way they do in production, instead of guessing at path mappings.
const http = require('http');
const path = require('path');
const siteRouting = require('../site-routing');

const PORT = process.env.PORT || 7711;

http.createServer((req, res) => {
  const pathname = decodeURIComponent(req.url.split('?')[0]);
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
