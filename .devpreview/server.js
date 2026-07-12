'use strict';
// Lightweight static preview server for local development.
// Reuses the site's real routing table (site-routing.js) so clean URLs
// like /contact, /board-culture-change, /blog/<slug> all resolve the
// same way they do in production, instead of guessing at path mappings.
const http = require('http');
const fs = require('fs');
const path = require('path');
const siteRouting = require('../site-routing');

const PORT = process.env.PORT || 7711;

http.createServer((req, res) => {
  const pathname = decodeURIComponent(req.url.split('?')[0]);

  // Mirrors server.js's /api/posts handler: scan blog/*.html JSON-LD directly,
  // so the home page carousel can be previewed without the full app server.
  if (pathname === '/api/posts' && req.method === 'GET') {
    const blogDir = path.join(__dirname, '..', 'blog');
    const posts = [];
    try {
      const files = fs.readdirSync(blogDir).filter(f => f.endsWith('.html') && f !== 'index.html');
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(blogDir, file), 'utf8');
          const match = content.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
          if (!match) continue;
          const data = JSON.parse(match[1]);
          if (data['@type'] !== 'Article') continue;
          const urlPath = (data.url || '').replace(/^https?:\/\/[^/]+/, '') || '/blog/' + file.replace('.html', '');
          const tags = [];
          const tagRowMatch = content.match(/<div class="article-tag-row">([\s\S]*?)<\/div>/);
          if (tagRowMatch) {
            const tagRe = /<span class="article-tag ([a-z0-9-]+)">([^<]*)<\/span>/g;
            let tm;
            while ((tm = tagRe.exec(tagRowMatch[1]))) {
              tags.push({ cls: tm[1], label: tm[2] });
            }
          }
          posts.push({
            headline: data.headline || '',
            description: data.description || '',
            section: data.articleSection || '',
            tags: tags,
            url: urlPath,
            date: data.datePublished || '1970-01-01'
          });
        } catch (_) {}
      }
      posts.sort((a, b) => b.date.localeCompare(a.date));
    } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(posts));
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
