'use strict';
const fs   = require('fs');
const path = require('path');

// Parses blog/index.html once and returns { '/blog/slug': '<svg>...</svg>' }
// for every card, so callers never have to hand-maintain a second copy of
// each post's thumbnail image.
function readBlogCardImages(blogDir) {
  const images = {};
  try {
    const html = fs.readFileSync(path.join(blogDir, 'index.html'), 'utf8');
    const cardRe = /<a href="(\/blog\/[^"]+)"[^>]*class="blog-card[^"]*"[^>]*>[\s\S]*?<div class="blog-card-img"[^>]*>([\s\S]*?)<\/div>\s*<div class="blog-card-body">/g;
    let m;
    while ((m = cardRe.exec(html))) {
      images[m[1]] = m[2].trim();
    }
  } catch (_) {}
  return images;
}

// Scans blog/*.html JSON-LD directly and returns the sorted post list used
// by both the production /api/posts route and the local preview server.
function getBlogPosts(blogDir) {
  const posts = [];
  try {
    const cardImages = readBlogCardImages(blogDir);
    const files = fs.readdirSync(blogDir).filter(f => f.endsWith('.html') && f !== 'index.html');
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(blogDir, file), 'utf8');
        const match = content.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
        if (!match) continue;
        const data = JSON.parse(match[1]);
        if (data['@type'] !== 'Article') continue;
        const urlPath = (data.url || '').replace(/^https?:\/\/[^/]+/, '') || '/blog/' + file.replace('.html', '');
        // Read the real, currently-displayed tags straight from the article's own
        // tag row, so the homepage carousel can never drift from what the blog
        // post itself shows (unlike the old, hand-maintained articleSection field).
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
          headline:    data.headline    || '',
          description: data.description || '',
          section:     data.articleSection || '',
          tags:        tags,
          url:         urlPath,
          image:       cardImages[urlPath] || null,
          date:        data.datePublished || '1970-01-01'
        });
      } catch (_) {}
    }
    posts.sort((a, b) => b.date.localeCompare(a.date));
  } catch (_) {}
  return posts;
}

module.exports = { readBlogCardImages, getBlogPosts };
