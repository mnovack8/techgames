'use strict';
/**
 * games/template-util.js
 *
 * Shared Mustache-lite templater used by both:
 *   - marketing-hub-renderer.js (full marketing-page rendering)
 *   - creategame-renderer.js    (lobby/create-game fragment rendering)
 *
 * Syntax (zero dependencies):
 *   {{name}}              → substitute data[name] as raw HTML
 *   {{#array}}…{{/array}} → iterate array, inner placeholders resolve against
 *                            the current item; parent scope is also reachable
 *   {{#flag}}…{{/flag}}   → if data[flag] is truthy (and not an array), render
 *                            the inner block once against the parent scope —
 *                            standard Mustache-style boolean section, for
 *                            toggling a whole block of markup on/off per game
 */

function renderTemplate(tpl, data) {
  // Section iterators/conditionals first: {{#key}}…{{/key}}
  tpl = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => {
    const val = data[key];
    if (Array.isArray(val)) {
      return val.map(item => renderTemplate(inner, { ...data, ...item })).join('');
    }
    return val ? renderTemplate(inner, data) : '';
  });
  // Simple placeholders: {{key}}
  tpl = tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return data[key] != null ? String(data[key]) : '';
  });
  return tpl;
}

module.exports = { renderTemplate };
