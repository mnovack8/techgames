/**
 * socket.js — Shared WebSocket hub for FuzzNet, Clusterflick, and ByteClub.
 *
 * Usage:
 *   var hub = SocketHub.create({
 *     url          : 'wss://...',   // optional — defaults to wss?://location.host
 *     reconnectMs  : 2000,          // optional — default 2000
 *     onConnect    : function() {},  // called on every WebSocket open
 *     onDisconnect : function() {},  // called on every WebSocket close (before reconnect)
 *     sendFilter   : function(msg) { return false; }, // return false to suppress send
 *   });
 *
 *   hub.on('lobby_update', function(msg) { ... }); // subscribe by msg.type
 *   hub.on('*', function(msg) { ... });             // wildcard — receives every message
 *   hub.off('lobby_update', fn);                    // unsubscribe
 *   hub.send({ type: 'game_action', ... });         // JSON-encode and send
 *   hub.connect();                                  // open the socket (call once at startup)
 *   hub.destroy();                                  // close and stop reconnecting
 */
'use strict';
window.SocketHub = (function () {

  function create(cfg) {
    cfg = cfg || {};
    var _ws       = null;
    var _handlers = {};                      // type → [fn, ...]
    var _delay    = cfg.reconnectMs || 2000;
    var _dead     = false;

    // ── URL ────────────────────────────────────────────────────────────────────
    function _wsUrl() {
      if (cfg.url) return cfg.url;
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return proto + '//' + location.host;
    }

    // ── Subscription ───────────────────────────────────────────────────────────
    function on(type, fn) {
      if (!_handlers[type]) _handlers[type] = [];
      _handlers[type].push(fn);
    }

    function off(type, fn) {
      if (!_handlers[type]) return;
      _handlers[type] = _handlers[type].filter(function (h) { return h !== fn; });
    }

    // ── Send ───────────────────────────────────────────────────────────────────
    function send(msg) {
      if (cfg.sendFilter && cfg.sendFilter(msg) === false) return;
      if (_ws && _ws.readyState === 1) _ws.send(JSON.stringify(msg));
    }

    // ── Dispatch ───────────────────────────────────────────────────────────────
    function _dispatch(raw) {
      var msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }
      if (!msg || typeof msg.type !== 'string') return;
      var list = _handlers[msg.type];
      if (list) for (var i = 0; i < list.length; i++) list[i](msg);
      var all  = _handlers['*'];
      if (all)  for (var j = 0; j < all.length;  j++) all[j](msg);
    }

    // ── Connection ─────────────────────────────────────────────────────────────
    function connect() {
      if (_dead) return;
      _ws = new WebSocket(_wsUrl());
      _ws.onopen    = function ()  { if (cfg.onConnect)    cfg.onConnect();    };
      _ws.onmessage = function (e) { _dispatch(e.data);                        };
      _ws.onclose   = function ()  {
        if (cfg.onDisconnect) cfg.onDisconnect();
        if (!_dead) setTimeout(connect, _delay);
      };
      _ws.onerror   = function ()  {};   // close fires separately; prevents uncaught
    }

    function destroy() {
      _dead = true;
      if (_ws) _ws.close();
    }

    return { send: send, on: on, off: off, connect: connect, destroy: destroy };
  }

  return { create: create };

}());
