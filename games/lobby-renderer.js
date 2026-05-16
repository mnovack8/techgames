'use strict';
/**
 * games/lobby-renderer.js
 *
 * Renders the waiting-room (lobby) HTML fragment that all three games share.
 * This is the screen shown after a room has been created but before the
 * host starts the game. (Distinct from the create-game landing screen, which
 * lives in the HTML's `<div id="lobby">` and is rendered by creategame-renderer.)
 *
 * Reads:   games/lobby.template.html        (shared structure)
 *          games/<gameKey>/lobby.json       (per-game content)
 *
 * Exports:
 *   renderLobby(gameKey)       →  HTML fragment (the <div id="waiting">…</div>)
 *   getMounts()                →  Map<htmlFileRelativePath, gameKey>
 *   getRegisteredKeys()        →  string[]
 *   injectInto(relPath, html)  →  replaces <!-- LOBBY_HTML --> marker
 *   clearCache()
 */
const fs   = require('fs');
const path = require('path');
const { renderTemplate } = require('./template-util');

const TEMPLATE_PATH = path.join(__dirname, 'lobby.template.html');
const MARKER        = '<!-- LOBBY_HTML -->';

let _templateCache  = null;
const _dataCache    = Object.create(null);
const _renderCache  = Object.create(null);
let _mountsCache    = null;
let _keysCache      = null;

function loadTemplate() {
  if (!_templateCache) {
    _templateCache = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  }
  return _templateCache;
}

function loadGameData(gameKey) {
  if (!_dataCache[gameKey]) {
    const file = path.join(__dirname, gameKey, 'lobby.json');
    _dataCache[gameKey] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return _dataCache[gameKey];
}

function discoverGames() {
  const result = [];
  for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonPath = path.join(__dirname, entry.name, 'lobby.json');
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      result.push({ gameKey: entry.name, data });
    } catch (err) {
      console.error(`[lobby] Failed to parse ${jsonPath}:`, err.message);
    }
  }
  return result;
}

function getMounts() {
  if (_mountsCache) return _mountsCache;
  const map = new Map();
  for (const { gameKey, data } of discoverGames()) {
    if (typeof data.mount !== 'string') {
      console.warn(`[lobby] ${gameKey}/lobby.json missing "mount" field`);
      continue;
    }
    if (map.has(data.mount)) {
      console.warn(`[lobby] Mount collision: ${data.mount} declared by both ${map.get(data.mount)} and ${gameKey}`);
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

function renderLobby(gameKey) {
  if (_renderCache[gameKey]) return _renderCache[gameKey];
  _renderCache[gameKey] = renderTemplate(loadTemplate(), loadGameData(gameKey));
  return _renderCache[gameKey];
}

function injectInto(htmlPathRelativeToRepo, htmlContent) {
  const mounts = getMounts();
  const gameKey = mounts.get(htmlPathRelativeToRepo);
  if (!gameKey) return htmlContent;
  if (!htmlContent.includes(MARKER)) return htmlContent;
  return htmlContent.replace(MARKER, renderLobby(gameKey));
}

function clearCache() {
  _templateCache = null;
  _mountsCache   = null;
  _keysCache     = null;
  for (const k of Object.keys(_dataCache))   delete _dataCache[k];
  for (const k of Object.keys(_renderCache)) delete _renderCache[k];
}

module.exports = {
  renderLobby,
  getMounts,
  getRegisteredKeys,
  injectInto,
  clearCache,
  MARKER,
};
