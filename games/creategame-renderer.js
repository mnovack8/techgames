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

// The four-colour lobby palette every game used before colours became
// configurable. A game only needs a "colors" array in its creategame.json when
// it seats more (or different) players than this.
const DEFAULT_COLORS = [
  { key: 'blue',   label: 'Blue',   swatch_css: 'background:#4a9eff' },
  { key: 'red',    label: 'Red',    swatch_css: 'background:#ff4a4a' },
  { key: 'green',  label: 'Yellow', swatch_css: 'background:#ffd700;color:#1a1a1a' },
  { key: 'purple', label: 'Purple', swatch_css: 'background:#a060dd' },
];

const DEFAULT_PLAYERS_TEXT = '2–4 Players';

/**
 * Fill in the derived fields the template iterates over. `create_colors`
 * carries the `selected` class on the first swatch (the create form defaults to
 * it); `join_colors` starts with nothing selected.
 */
function withDefaults(data) {
  const colors = Array.isArray(data.colors) && data.colors.length ? data.colors : DEFAULT_COLORS;
  return {
    ...data,
    players_text : data.players_text || DEFAULT_PLAYERS_TEXT,
    create_colors: colors.map((c, i) => ({ ...c, sel_css: i === 0 ? ' selected' : '' })),
    join_colors  : colors.map(c => ({ ...c, sel_css: '' })),
    // Each defaults on (existing games all ship these) — a game opts OUT by
    // setting the flag to false in its creategame.json, not by omitting data.
    show_hero_ctas: data.show_hero_ctas !== false,
    show_event_hub: data.show_event_hub !== false,
    show_workshop:  data.show_workshop  !== false,
  };
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
  _renderCache[gameKey] = renderTemplate(loadTemplate(), withDefaults(loadGameData(gameKey)));
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
