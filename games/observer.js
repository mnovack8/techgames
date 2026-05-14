/**
 * observer.js — Shared observer waiting-room list for FuzzNet and Clusterflick.
 *
 * Both games share the same DOM IDs for the waiting-room observer section:
 *   #waiting-observer-section  — wrapper (show/hide)
 *   #waiting-observer-count    — "N Observer(s)" label
 *   #waiting-observer-list     — rows container
 *
 * Usage:
 *   ObserverUI.renderWaitingObservers(observers);   // observers = array from lobby_update
 */
'use strict';
window.ObserverUI = (function () {

  // Minimal HTML-escape so observer names can't inject markup.
  function _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Render (or hide) the observer list in the waiting room.
   * @param {Array} observers  — array of { name, isHost } objects from lobby_update
   */
  function renderWaitingObservers(observers) {
    var section = document.getElementById('waiting-observer-section');
    var list    = document.getElementById('waiting-observer-list');
    var count   = document.getElementById('waiting-observer-count');
    if (!section) return;   // page doesn't use this pattern (e.g. byteclub)

    if (!observers || observers.length === 0) {
      section.style.display = 'none';
      if (list) list.innerHTML = '';
      return;
    }

    section.style.display = 'block';
    var n = observers.length;
    if (count) count.textContent = n + ' Observer' + (n !== 1 ? 's' : '');
    if (list) {
      list.innerHTML = observers.map(function (o) {
        return '<div class="waiting-observer-row">' +
          '<span class="obs-name">' + _esc(o.name) + '</span>' +
          (o.isHost ? '<span class="obs-host-badge">HOST</span>' : '') +
          '</div>';
      }).join('');
    }
  }

  return { renderWaitingObservers: renderWaitingObservers };

}());
