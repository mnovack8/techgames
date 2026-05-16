'use strict';
/**
 * games/creategame-renderer.js
 *
 * Renders the create-game (lobby) HTML fragment that all three games share.
 * Drop in a new game's `creategame.json` (with a `mount` field that points at
 * one of the game HTML files) and it is picked up automatically.
 *
 * Reads:   games/creategame.template.html    (shared structure)
 *          games/<gameKey>/creategame.json   (per-game content)
 *
 * Exports:
 *   renderCreateGame(gameKey)  →  HTML fragment (the <div id="lobby">…</div>)
 *   getMounts()                →  Map<htmlFileRelativePath, gameKey>
 *                                  e.g. { "/games/ai-knn/clusterflick.html": "ai-knn" }
 *                                  Used by the server to know which file gets
 *                                  the `<!-- CREATEGAME_HTML -->` marker replaced.
 *   getRegisteredKeys()        →  string[]
 *   clearCache()
 */
const fs   = require('fs');
const path = require('path');
const { renderTemplate } = require('./template-util');

const TEMPLATE_PATH = path.join(__dirname, 'creategame.template.html');
const MARKER        = '<!-- CREATEGAME_HTML -->';

let _templateCache  = null;
const _dataCache    = Object.create(null);   // gameKey → parsed JSON
const _renderCache  = Object.create(null);   // gameKey → rendered fragment
let _mountsCache    = null;                  // Map<htmlPath, gameKey>
let _keysCache      = null;                  // string[]

function loadTemplate() {
  if (!_templateCache) {
    _templateCache = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  }
  return _templateCache;
}

function loadGameData(gameKey) {
  if (!_dataCache[gameKey]) {
    const file = path.join(__dirname, gameKey, 'creategame.json');
    _dataCache[gameKey] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return _dataCache[gameKey];
}

/** Scan games/* for any subdirectory containing a creategame.json file. */
function discoverGames() {
  const result = [];
  for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonPath = path.join(__dirname, entry.name, 'creategame.json');
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      result.push({ gameKey: entry.name, data });
    } catch (err) {
      console.error(`[creategame] Failed to parse ${jsonPath}:`, err.message);
    }
  }
  return result;
}

/**
 * Map of HTML file path (relative to repo root) → gameKey. The server uses
 * this to know which served HTML file should have its marker replaced.
 */
function getMounts() {
  if (_mountsCache) return _mountsCache;
  const map = new Map();
  for (const { gameKey, data } of discoverGames()) {
    if (typeof data.mount !== 'string') {
      console.warn(`[creategame] ${gameKey}/creategame.json missing "mount" field`);
      continue;
    }
    if (map.has(data.mount)) {
      console.warn(`[creategame] Mount collision: ${data.mount} declared by both ${map.get(data.mount)} and ${gameKey}`);
    }
    map.set(data.mount, gameKey);
    _dataCache[gameKey] = data;
  }
  _mountsCache = map;
  return map;
}

function getRegisteredKeys() {
  if (_keysCache) return _keysCache;
  _keysCache = discoverGames().map(h => h.gameKey);
  return _keysCache;
}

/** Render the create-game fragment for the given gameKey. Cached per key. */
function renderCreateGame(gameKey) {
  if (_renderCache[gameKey]) return _renderCache[gameKey];
  _renderCache[gameKey] = renderTemplate(loadTemplate(), loadGameData(gameKey));
  return _renderCache[gameKey];
}

/**
 * If `htmlContent` is the HTML of a registered game page, replace the
 * `<!-- CREATEGAME_HTML -->` marker in it with the rendered fragment.
 * If there's no marker or no matching mount, returns the input unchanged.
 */
function injectInto(htmlPathRelativeToRepo, htmlContent) {
  const mounts = getMounts();
  const gameKey = mounts.get(htmlPathRelativeToRepo);
  if (!gameKey) return htmlContent;
  if (!htmlContent.includes(MARKER)) return htmlContent;
  return htmlContent.replace(MARKER, renderCreateGame(gameKey));
}

function clearCache() {
  _templateCache = null;
  _mountsCache   = null;
  _keysCache     = null;
  for (const k of Object.keys(_dataCache))   delete _dataCache[k];
  for (const k of Object.keys(_renderCache)) delete _renderCache[k];
}

module.exports = {
  renderCreateGame,
  getMounts,
  getRegisteredKeys,
  injectInto,
  clearCache,
  MARKER,
};
