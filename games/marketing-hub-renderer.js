'use strict';
/**
 * games/marketing-hub-renderer.js
 *
 * Single source of truth for the marketing/landing pages of each game.
 * To add a new game's marketing page, drop in:
 *   games/<gameKey>/marketing.json
 * The "routes" field in that JSON registers the URL(s) automatically.
 *
 * Reads:   games/marketing-hub.template.html   (shared HTML structure)
 *          games/<gameKey>/marketing.json      (per-game content + routes)
 *
 * Exports: renderHub(gameKey)     →  rendered HTML string
 *          getHubRoutes()         →  Map<pathname, gameKey> for routing
 *          getRegisteredKeys()    →  Array of all discovered gameKeys
 *
 * Templating syntax (Mustache-lite, zero dependencies):
 *   {{name}}              → substitute data[name] as raw HTML
 *   {{#array}}…{{/array}} → iterate array, inner placeholders resolve against
 *                            the current item; parent scope is also reachable
 */
const fs   = require('fs');
const path = require('path');
const { renderTemplate } = require('./template-util');

const TEMPLATE_PATH = path.join(__dirname, 'marketing-hub.template.html');

let _templateCache = null;
const _dataCache = Object.create(null);
let _routesCache = null;     // Map<pathname, gameKey>
let _keysCache   = null;     // string[]

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

/**
 * Scan games/* for any subdirectory containing a marketing.json file. Returns
 * an array of { gameKey, data } objects. Called once at startup and memoised.
 */
function discoverHubs() {
  const result = [];
  for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonPath = path.join(__dirname, entry.name, 'marketing.json');
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      result.push({ gameKey: entry.name, data });
    } catch (err) {
      console.error(`[hubRenderer] Failed to parse ${jsonPath}:`, err.message);
    }
  }
  return result;
}

/**
 * Map of URL pathname → gameKey, built once from each marketing.json's "routes"
 * field. Lets the router register hub pages without hardcoded conditionals.
 */
function getHubRoutes() {
  if (_routesCache) return _routesCache;
  const map = new Map();
  for (const { gameKey, data } of discoverHubs()) {
    const routes = Array.isArray(data.routes) ? data.routes : [];
    for (const route of routes) {
      if (map.has(route)) {
        console.warn(`[hubRenderer] Route collision: ${route} declared by both ${map.get(route)} and ${gameKey}`);
      }
      map.set(route, gameKey);
    }
    // Prime the data cache so first-request render is fast
    _dataCache[gameKey] = data;
  }
  _routesCache = map;
  return map;
}

/** List of all discovered gameKeys (directory names with a marketing.json). */
function getRegisteredKeys() {
  if (_keysCache) return _keysCache;
  _keysCache = discoverHubs().map(h => h.gameKey);
  return _keysCache;
}

/** Invalidate caches (used in tests / dev when files change). */
function clearCache() {
  _templateCache = null;
  _routesCache = null;
  _keysCache = null;
  for (const k of Object.keys(_dataCache)) delete _dataCache[k];
}

/** Render a hub page for the given game key. */
function renderHub(gameKey) {
  return renderTemplate(loadTemplate(), loadGameData(gameKey));
}

module.exports = { renderHub, getHubRoutes, getRegisteredKeys, clearCache };
