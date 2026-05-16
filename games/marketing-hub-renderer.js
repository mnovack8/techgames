'use strict';
/**
 * games/marketing-hub-renderer.js
 *
 * Single source of truth for the /cybersecurity, /ai/neural-network, /ai/knn
 * marketing pages.
 *
 * Reads:   games/marketing-hub.template.html   (shared HTML structure)
 *          games/<gameKey>/marketing.json      (per-game content)
 *
 * Exports: renderHub(gameKey)  →  rendered HTML string
 *
 * Templating syntax (Mustache-lite, zero dependencies):
 *   {{name}}              → substitute data[name] as raw HTML
 *   {{#array}}…{{/array}} → iterate array, inner placeholders resolve against
 *                            the current item; parent scope is also reachable
 */
const fs   = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, 'marketing-hub.template.html');

let _templateCache = null;
const _dataCache = Object.create(null);

function loadTemplate() {
  if (!_templateCache) {
    _templateCache = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  }
  return _templateCache;
}

function loadGameData(gameKey) {
  if (!_dataCache[gameKey]) {
    const file = path.join(__dirname, gameKey, 'marketing.json');
    _dataCache[gameKey] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return _dataCache[gameKey];
}

function renderTemplate(tpl, data) {
  // Section iterators first: {{#array}}…{{/array}}
  tpl = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => {
    const arr = data[key];
    if (!Array.isArray(arr)) return '';
    return arr.map(item => renderTemplate(inner, { ...data, ...item })).join('');
  });
  // Simple placeholders: {{key}}
  tpl = tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return data[key] != null ? String(data[key]) : '';
  });
  return tpl;
}

/** Invalidate caches (used in tests / dev when files change). */
function clearCache() {
  _templateCache = null;
  for (const k of Object.keys(_dataCache)) delete _dataCache[k];
}

/** Render a hub page for the given game key. */
function renderHub(gameKey) {
  return renderTemplate(loadTemplate(), loadGameData(gameKey));
}

module.exports = { renderHub, clearCache };
