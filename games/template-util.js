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
 */

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

module.exports = { renderTemplate };
