'use strict';
/**
 * games/interactive-tutorial-renderer.js
 *
 * Renders the interactive in-game tutorial sidebar's INNER HTML.
 * Each game keeps its own wrapper container (#tutorial-overlay#tutorial-card,
 * #bc-tut-panel, #cft-panel) because container positioning/theme is per-game.
 * The INNER content (header → title → body → footer) is identical and lives
 * in the shared template.
 *
 * Contract every game must implement:
 *   - global function tutNext()       — handler for the Next button
 *   - global function endTutorial()   — handler for the Exit Tutorial button
 *   - canonical inner IDs in JS: #tut-step, #tut-progress-fill, #tut-title,
 *     #tut-body, #tut-hint, #tut-next, #tut-exit
 *   - canonical inner CSS classes: .tut-header, .tut-progress, .tut-footer
 *
 * Reads:   games/interactive-tutorial.template.html (shared structure)
 *          games/<gameKey>/interactive-tutorial.json (just declares `mount`)
 *
 * Exports:
 *   renderInteractiveTutorial(gameKey)   →  HTML fragment
 *   getMounts()                          →  Map<htmlFileRelativePath, gameKey>
 *   getRegisteredKeys()                  →  string[]
 *   injectInto(relPath, html)            →  replaces <!-- INTERACTIVE_TUTORIAL_HTML -->
 *   clearCache()
 */
const fs   = require('fs');
const path = require('path');
const { renderTemplate } = require('./template-util');

const TEMPLATE_PATH = path.join(__dirname, 'interactive-tutorial.template.html');
const MARKER        = '<!-- INTERACTIVE_TUTORIAL_HTML -->';

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
    const file = path.join(__dirname, gameKey, 'interactive-tutorial.json');
    _dataCache[gameKey] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return _dataCache[gameKey];
}

function discoverGames() {
  const result = [];
  for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jsonPath = path.join(__dirname, entry.name, 'interactive-tutorial.json');
    if (!fs.existsSync(jsonPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      result.push({ gameKey: entry.name, data });
    } catch (err) {
      console.error(`[interactive-tutorial] Failed to parse ${jsonPath}:`, err.message);
    }
  }
  return result;
}

function getMounts() {
  if (_mountsCache) return _mountsCache;
  const map = new Map();
  for (const { gameKey, data } of discoverGames()) {
    if (typeof data.mount !== 'string') {
      console.warn(`[interactive-tutorial] ${gameKey}/interactive-tutorial.json missing "mount" field`);
      continue;
    }
    if (map.has(data.mount)) {
      console.warn(`[interactive-tutorial] Mount collision: ${data.mount} declared by both ${map.get(data.mount)} and ${gameKey}`);
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

function renderInteractiveTutorial(gameKey) {
  if (_renderCache[gameKey]) return _renderCache[gameKey];
  _renderCache[gameKey] = renderTemplate(loadTemplate(), loadGameData(gameKey));
  return _renderCache[gameKey];
}

function injectInto(htmlPathRelativeToRepo, htmlContent) {
  const mounts = getMounts();
  const gameKey = mounts.get(htmlPathRelativeToRepo);
  if (!gameKey) return htmlContent;
  if (!htmlContent.includes(MARKER)) return htmlContent;
  return htmlContent.replace(MARKER, renderInteractiveTutorial(gameKey));
}

function clearCache() {
  _templateCache = null;
  _mountsCache   = null;
  _keysCache     = null;
  for (const k of Object.keys(_dataCache))   delete _dataCache[k];
  for (const k of Object.keys(_renderCache)) delete _renderCache[k];
}

module.exports = {
  renderInteractiveTutorial,
  getMounts,
  getRegisteredKeys,
  injectInto,
  clearCache,
  MARKER,
};
