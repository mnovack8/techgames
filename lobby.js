/**
 * lobby.js — Shared lobby form logic for all TechGames pages.
 *
 * Usage (call once after DOM is ready, before WebSocket connect):
 *
 *   LobbyUI.init({
 *     gameType : 'fuzznet' | 'clusterflick' | 'byteclub',
 *     sendFn   : function(msg)  — send a WS message for create / join actions,
 *     checkFn  : function(msg)  — send a WS message for check_room (defaults to sendFn),
 *     // Optional hooks for game-specific side-effects:
 *     onCreateAsObserver : function({ name })        — called before observer-create send,
 *     onJoinAsObserver   : function({ code, name })  — called before observer-join send,
 *   });
 *
 * After init() the following are exposed on window so inline onclick= / oninput=
 * handlers keep working without any HTML changes:
 *   createRoom, joinRoom, checkRoom,
 *   updateCreateBtn, updateJoinBtn,
 *   toggleCreateObserver, toggleJoinObserver,
 *   selectCreateRole, selectJoinRole,
 *   selectCreateColor, selectJoinColor
 *
 * Call LobbyUI.handleRoomInfo(msg) from the WebSocket 'room_info' message handler.
 */
'use strict';
window.LobbyUI = (function () {

  // ── Config ──────────────────────────────────────────────────────────────────
  var _cfg = {};

  // ── State ────────────────────────────────────────────────────────────────────
  var createColor            = 'blue';
  var joinColor              = '';
  var createObserverSelected = false;
  var joinObserverSelected   = false;
  var joinAvailable          = [];
  var canObserveJoin         = false;
  var _checkTimer            = null;

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function _el(id) { return document.getElementById(id); }

  function _highlightColors(containerId, selected) {
    var btns = document.querySelectorAll('#' + containerId + ' .color-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('selected', btns[i].dataset.color === selected);
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init(cfg) {
    _cfg = cfg || {};
    if (!_cfg.createErrorId) _cfg.createErrorId = 'create-error';
    if (!_cfg.joinErrorId)   _cfg.joinErrorId   = 'join-error';
    if (!_cfg.checkFn)       _cfg.checkFn       = _cfg.sendFn;

    // Reset state
    createColor            = 'blue';
    joinColor              = '';
    createObserverSelected = false;
    joinObserverSelected   = false;
    joinAvailable          = [];
    canObserveJoin         = false;

    // Highlight the default create color in the static HTML buttons
    _highlightColors('create-colors', 'blue');

    // Expose all interaction functions to window so inline event handlers work
    window.createRoom           = createRoom;
    window.joinRoom             = joinRoom;
    window.checkRoom            = checkRoom;
    window.updateCreateBtn      = updateCreateBtn;
    window.updateJoinBtn        = updateJoinBtn;
    window.toggleCreateObserver = toggleCreateObserver;
    window.toggleJoinObserver   = toggleJoinObserver;
    window.selectCreateRole     = selectCreateRole;
    window.selectJoinRole       = selectJoinRole;
    window.selectCreateColor    = selectCreateColor;
    window.selectJoinColor      = selectJoinColor;
  }

  // ── Color selection ───────────────────────────────────────────────────────────
  function selectCreateColor(c) {
    createColor = c;
    // Picking a color deselects observer mode
    if (createObserverSelected) {
      createObserverSelected = false;
      var obsBtn    = _el('create-obs-btn');
      var playerBox = _el('create-player-role');
      if (obsBtn)    obsBtn.classList.remove('selected');
      if (playerBox) playerBox.classList.add('active');
    }
    _highlightColors('create-colors', c);
    updateCreateBtn();
  }

  function selectJoinColor(c) {
    joinColor = c;
    // Picking a color deselects observer mode
    if (joinObserverSelected) {
      joinObserverSelected = false;
      var obsBtn    = _el('join-obs-btn');
      var playerBox = _el('join-player-role');
      if (obsBtn)    obsBtn.classList.remove('selected');
      if (playerBox) playerBox.classList.add('active');
    }
    _highlightColors('join-colors', c);
    updateJoinBtn();
  }

  // ── Role selection ────────────────────────────────────────────────────────────
  function selectCreateRole(role) {
    if (role === 'player' && createObserverSelected) {
      createObserverSelected = false;
      var obsBtn    = _el('create-obs-btn');
      var playerBox = _el('create-player-role');
      if (obsBtn)    obsBtn.classList.remove('selected');
      if (playerBox) playerBox.classList.add('active');
      createColor = 'blue';
      _highlightColors('create-colors', 'blue');
      updateCreateBtn();
    }
  }

  function selectJoinRole(role) {
    if (role === 'player' && joinObserverSelected) {
      joinObserverSelected = false;
      var obsBtn    = _el('join-obs-btn');
      var playerBox = _el('join-player-role');
      if (obsBtn)    obsBtn.classList.remove('selected');
      if (playerBox) playerBox.classList.add('active');
      updateJoinBtn();
    }
  }

  // ── Observer toggles ──────────────────────────────────────────────────────────
  function toggleCreateObserver() {
    createObserverSelected = !createObserverSelected;
    var obsBtn    = _el('create-obs-btn');
    var playerBox = _el('create-player-role');
    if (createObserverSelected) {
      if (obsBtn)    obsBtn.classList.add('selected');
      if (playerBox) playerBox.classList.remove('active');
      createColor = null;
      // Deselect all color buttons visually
      var colorBtns = document.querySelectorAll('#create-colors .color-btn');
      for (var i = 0; i < colorBtns.length; i++) colorBtns[i].classList.remove('selected');
    } else {
      if (obsBtn)    obsBtn.classList.remove('selected');
      if (playerBox) playerBox.classList.add('active');
      createColor = 'blue';
      _highlightColors('create-colors', 'blue');
    }
    updateCreateBtn();
  }

  function toggleJoinObserver() {
    if (!canObserveJoin) return;
    joinObserverSelected = !joinObserverSelected;
    var obsBtn    = _el('join-obs-btn');
    var playerBox = _el('join-player-role');
    if (joinObserverSelected) {
      if (obsBtn)    obsBtn.classList.add('selected');
      if (playerBox) playerBox.classList.remove('active');
      joinColor = null;
      var colorBtns = document.querySelectorAll('#join-colors .color-btn');
      for (var i = 0; i < colorBtns.length; i++) colorBtns[i].classList.remove('selected');
    } else {
      if (obsBtn)    obsBtn.classList.remove('selected');
      if (playerBox) playerBox.classList.add('active');
    }
    updateJoinBtn();
  }

  // ── Button enable state ───────────────────────────────────────────────────────
  function updateCreateBtn() {
    var nameEl = _el('create-name');
    var name   = nameEl ? nameEl.value.trim() : '';
    var playerReady   = createColor && name.length >= 1;
    var observerReady = createObserverSelected && name.length >= 1;
    var btn = _el('btn-create');
    if (btn) btn.disabled = !playerReady && !observerReady;
  }

  function updateJoinBtn() {
    var nameEl = _el('join-name');
    var codeEl = _el('join-code');
    var name   = nameEl ? nameEl.value.trim() : '';
    var code   = codeEl ? codeEl.value.trim() : '';
    var codeOk        = code.length === 4;
    var playerReady   = joinColor && codeOk && name.length >= 1;
    var observerReady = joinObserverSelected && codeOk && name.length >= 1;
    var btn = _el('btn-join');
    if (btn) btn.disabled = !playerReady && !observerReady;
  }

  // ── Join color rendering (called after room info arrives) ─────────────────────
  function _renderJoinColors() {
    var container = _el('join-colors');
    if (!container) return;
    container.style.opacity       = '1';
    container.style.pointerEvents = 'auto';
    var btns = container.querySelectorAll('.color-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = !joinAvailable.includes(btns[i].dataset.color);
      btns[i].classList.remove('selected');
    }
    joinColor = '';
    // Reset observer state whenever available colors update
    joinObserverSelected = false;
    var obsBtn    = _el('join-obs-btn');
    var playerBox = _el('join-player-role');
    if (obsBtn)    obsBtn.classList.remove('selected');
    if (playerBox) playerBox.classList.add('active');
    updateJoinBtn();
  }

  // ── Check room (oninput on the room code field) ───────────────────────────────
  function checkRoom() {
    var codeEl = _el('join-code');
    if (!codeEl) return;
    // Sanitise input: uppercase, alphanumeric only
    codeEl.value = codeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    var code = codeEl.value;

    // Clear any previous error
    var errEl = _el(_cfg.joinErrorId);
    if (errEl) errEl.textContent = '';

    // Reset observer toggle when the code changes
    joinObserverSelected = false;
    var obsBtn    = _el('join-obs-btn');
    var playerBox = _el('join-player-role');
    if (obsBtn)    obsBtn.classList.remove('selected');
    if (playerBox) playerBox.classList.add('active');

    if (code.length === 4) {
      clearTimeout(_checkTimer);
      _checkTimer = setTimeout(function () {
        _cfg.checkFn({ type: 'check_room', code: code });
      }, 200);
    } else {
      var colors = _el('join-colors');
      if (colors) { colors.style.opacity = '0.3'; colors.style.pointerEvents = 'none'; }
      if (obsBtn) obsBtn.disabled = true;
      canObserveJoin = false;
      updateJoinBtn();
    }
  }

  // ── Room info handler — call from ws 'room_info' case ─────────────────────────
  function handleRoomInfo(msg) {
    var errEl  = _el(_cfg.joinErrorId);
    var obsBtn = _el('join-obs-btn');
    var colors = _el('join-colors');

    if (!msg.exists) {
      if (errEl)  errEl.textContent = 'Room not found.';
      canObserveJoin = false;
      if (obsBtn) obsBtn.disabled = true;
      return;
    }

    if (msg.started) {
      if (msg.rejoinColors && msg.rejoinColors.length > 0) {
        if (errEl) errEl.textContent = 'Game in progress. Select your color to rejoin.';
        joinAvailable = msg.rejoinColors;
        _renderJoinColors();
        var btnJoin = _el('btn-join');
        if (btnJoin) btnJoin.textContent = 'Rejoin Game';
      } else {
        // No player slots open — offer observer if server permits
        canObserveJoin = msg.canObserve !== false;
        if (obsBtn) obsBtn.disabled = !canObserveJoin;
        if (canObserveJoin) {
          joinObserverSelected = true;
          if (obsBtn) obsBtn.classList.add('selected');
          var playerBox = _el('join-player-role');
          if (playerBox) playerBox.classList.remove('active');
          if (errEl) errEl.textContent = 'Game in progress. Join as observer.';
        } else {
          if (errEl) errEl.textContent = 'Game in progress. No open slots.';
        }
        if (colors) { colors.style.opacity = '0.3'; colors.style.pointerEvents = 'none'; }
      }
      updateJoinBtn();
      return;
    }

    if (msg.full) {
      if (errEl) errEl.textContent = 'Room is full.';
      canObserveJoin = msg.canObserve !== false;
      if (obsBtn) obsBtn.disabled = !canObserveJoin;
      updateJoinBtn();
      return;
    }

    if (errEl) errEl.textContent = '';
    joinAvailable  = msg.availableColors || [];
    canObserveJoin = msg.canObserve !== false;
    if (obsBtn) obsBtn.disabled = !canObserveJoin;
    var btnJoin = _el('btn-join');
    if (btnJoin) btnJoin.textContent = 'Join Game';
    _renderJoinColors();
  }

  // ── Create room ───────────────────────────────────────────────────────────────
  function createRoom() {
    var nameEl = _el('create-name');
    var name   = nameEl ? nameEl.value.trim() : '';
    if (!name) return;
    var errEl = _el(_cfg.createErrorId);
    if (errEl) errEl.textContent = '';
    if (createObserverSelected) {
      if (_cfg.onCreateAsObserver) _cfg.onCreateAsObserver({ name: name });
      _cfg.sendFn({ type: 'create_room_as_observer', gameType: _cfg.gameType, name: name });
      return;
    }
    if (!createColor) return;
    _cfg.sendFn({ type: 'create_room', gameType: _cfg.gameType, playerName: name, color: createColor });
  }

  // ── Join room ─────────────────────────────────────────────────────────────────
  function joinRoom() {
    var codeEl = _el('join-code');
    var nameEl = _el('join-name');
    var code   = codeEl ? codeEl.value.trim().toUpperCase() : '';
    var name   = nameEl ? nameEl.value.trim() : '';
    if (!code || !name) return;
    var errEl = _el(_cfg.joinErrorId);
    if (errEl) errEl.textContent = '';
    if (joinObserverSelected) {
      if (_cfg.onJoinAsObserver) _cfg.onJoinAsObserver({ code: code, name: name });
      _cfg.sendFn({ type: 'join_as_observer', code: code, name: name });
      return;
    }
    if (!joinColor) return;
    _cfg.sendFn({ type: 'join_room', gameType: _cfg.gameType, code: code, playerName: name, color: joinColor });
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  return {
    init           : init,
    handleRoomInfo : handleRoomInfo,
    // Accessors for game-specific code that needs to read current selections
    getCreateColor   : function () { return createColor; },
    getJoinColor     : function () { return joinColor; },
    isCreateObserver : function () { return createObserverSelected; },
    isJoinObserver   : function () { return joinObserverSelected; },
  };

}());
