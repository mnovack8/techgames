'use strict';

const fs   = require('fs');
const path = require('path');

const { trackEvent, isRematch } = require('../analytics');
const fuzznet      = require('./ai-neural-network/fuzznet-logic');
const clusterflick = require('./ai-knn/clusterflick-logic');
const byteclub     = require('./cybersecurity/byteclub-logic');
const qubit        = require('./quantumcomputing/qubit-logic');

// ==================== CONSTANTS (shared) ====================
const COLOR_INFO = {
  blue:   { hex: '#4a9eff', name: 'Blue' },
  red:    { hex: '#ff4a4a', name: 'Red' },
  green:  { hex: '#4aff8a', name: 'Green' },
  purple: { hex: '#c880ff', name: 'Purple' },
  yellow: { hex: '#facc15', name: 'Yellow' },
  orange: { hex: '#f97316', name: 'Orange' },
};

// The colour set the original four-player games ship with. Games that seat more
// players declare their own `colors` in GAME_REGISTRY.
const DEFAULT_COLORS = ['blue', 'red', 'green', 'purple'];

// ==================== ROOM MANAGEMENT ====================
const rooms    = new Map();
const wsData   = new Map();    // ws -> { roomCode, playerIdx, isObserver?, observerIdx? }
const sessions = new Map();    // token -> { roomCode, playerIdx }
const wsUvKey  = new Map();    // ws -> uvKey (hash of IP + day, captured at connection time)

// ── State persistence across server restarts ──────────────────────────────────
const DATA_DIR   = process.env.STATE_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'game-state.json');
let _saveTimer   = null;

function _serializeRooms() {
  const out = { rooms: [], sessions: [] };
  for (const [code, room] of rooms.entries()) {
    // Only persist in-progress games that aren't over yet
    const isOver = (room.state && room.state.gameOver)
      || (room.cfState && room.cfState.gameOver)
      || (room.bcState && room.bcState.phase === 'game_over')
      || (room.qbState && room.qbState.gameOver);
    if (!room.started || isOver) continue;
    const saved = {
      ...room,
      players: room.players.map(p => ({ ...p, ws: undefined, connected: false })),
      observers: (room.observers || []).map(o => ({ ...o, ws: undefined, connected: false })),
      eventOrganizers: undefined,
      _botRunning: false,
      _cfBotRunning: false,
      _bcBotRunning: false,
      _fnBotWatchdog: undefined,
      _cfBotWatchdog: undefined,
      _bcBotWatchdog: undefined,
    };
    out.rooms.push([code, saved]);
  }
  for (const [token, sess] of sessions.entries()) {
    out.sessions.push([token, sess]);
  }
  return out;
}

function saveState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(_serializeRooms()), 'utf8');
  } catch (e) {
    console.error('[saveState]', e.message);
  }
}

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; saveState(); }, 30000);
  if (_saveTimer.unref) _saveTimer.unref();
}

// Restore rooms and sessions from disk on startup
(function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [code, room] of (raw.rooms || [])) rooms.set(code, room);
    for (const [token, sess] of (raw.sessions || [])) sessions.set(token, sess);
    if (raw.rooms && raw.rooms.length)
      console.log('[loadState] restored', raw.rooms.length, 'room(s),', (raw.sessions || []).length, 'session(s)');
  } catch (e) {
    console.error('[loadState]', e.message);
  }
})();

function generateToken() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < 32; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

// Clean up rooms that have been idle (all players disconnected) for 1 hour,
// or that are older than 24 hours regardless of activity.
const ROOM_MAX_AGE      = 24 * 60 * 60 * 1000;
const ROOM_IDLE_TIMEOUT =       60 * 60 * 1000; // 1 hour all-disconnected
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const anyoneConnected = room.players.some(p => p.connected)
      || (room.observers || []).some(o => o.connected);
    const lastSeen = room.lastActivity || room.createdAt;
    const tooOld  = now - room.createdAt  > ROOM_MAX_AGE;
    const tooIdle = !anyoneConnected && now - lastSeen > ROOM_IDLE_TIMEOUT;
    if (!tooOld && !tooIdle) continue;
    const expiredMsg = tooOld ? 'This game expired after 24 hours.' : 'This game closed after 1 hour of inactivity.';
    for (const [token, s] of sessions.entries()) {
      if (s.roomCode === code) sessions.delete(token);
    }
    for (const p of room.players) {
      if (p.connected && p.ws) {
        try { send(p.ws, { type: 'error', msg: expiredMsg }); } catch {}
        wsData.delete(p.ws);
      }
    }
    for (const o of (room.observers || [])) {
      if (o.connected && o.ws) {
        try { send(o.ws, { type: 'error', msg: expiredMsg }); } catch {}
        wsData.delete(o.ws);
      }
    }
    rooms.delete(code);
  }
}, 60 * 60 * 1000);

function sanitizeName(raw, fallback) {
  if (!raw || typeof raw !== 'string') return fallback;
  const name = raw.trim().replace(/[^\w\s'-]/g, '').slice(0, 12).trim();
  return name.length >= 1 ? name : fallback;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastLobby(room) {
  const lobbyInfo = {
    type: 'lobby_update',
    code: room.code,
    mode: room.mode || 'beginner',
    players: room.players.map((p, i) => ({
      color: p.color, name: p.name, connected: p.connected, isHost: i === room.hostIdx, isBot: !!p.isBot,
    })),
    // Filter out the virtual organizer placeholder (ws:null) — it only shows once claimed
    observers: (room.observers || []).filter(o => o.ws !== null).map((o) => ({
      name: o.name, connected: o.connected, isHost: (room.observers || []).indexOf(o) === 0,
    })),
    observerCount: (room.observers || []).filter(o => o.ws !== null).length,
  };
  for (const p of room.players) {
    if (p.connected && p.ws) send(p.ws, lobbyInfo);
  }
  for (const o of (room.observers || [])) {
    if (o.connected && o.ws) send(o.ws, lobbyInfo);
  }
  sendEventStatus(room);
}

function sendEventStatus(room) {
  if (!room.eventOrganizers || room.eventOrganizers.length === 0) return;
  let status = 'pending';
  if (room.started) {
    const isOver = (room.bcState && room.bcState.phase === 'game_over')
      || (room.cfState && room.cfState.gameOver)
      || (room.state && room.state.gameOver)
      || (room.qbState && room.qbState.gameOver);
    status = isOver ? 'completed' : 'in_progress';
  }
  const playerCount = room.players.filter(p => !p.isBot).length;
  const update = { type: 'event_status_update', code: room.code, playerCount, status };
  for (const orgWs of room.eventOrganizers) {
    send(orgWs, update);
  }
}

/** Send a message to every connected player and observer in a room. */
function broadcastToRoom(room, msg) {
  for (const p of room.players)          if (p.ws)                  send(p.ws, msg);
  for (const o of (room.observers || [])) if (o.connected && o.ws)  send(o.ws, msg);
}

// ── Initialise game-logic modules with shared state ──────────────────────────
fuzznet.init({ rooms, broadcastToRoom, trackEvent });
clusterflick.init({ rooms, broadcastToRoom, trackEvent });
byteclub.init({ rooms, broadcastToRoom, trackEvent });
byteclub.setSendEventStatus(sendEventStatus);
qubit.init({ rooms, broadcastToRoom, trackEvent });

// ── Destructure helpers from game-logic modules ───────────────────────────────
const { createGameState, processAction, broadcastState: fnBroadcastState, executeBotTurn, nextTurn: fnNextTurn } = fuzznet;
const { createCFGameState, processCFAction, cfBroadcastState, cfAdvanceTurn, executeCFBotTurn } = clusterflick;
const { initBCGame, bcHandleAction, bcBroadcastState, bcEndTurn } = byteclub;
const { initQBGame, qbHandleAction, qbBroadcastState, maybeScheduleBotTurn: qbMaybeScheduleBotTurn } = qubit;

// ==================== GAME REGISTRY ====================
// Single source of truth for per-game behaviour.
// Adding a new game: add one entry here — no other switch branches needed.

const GAME_REGISTRY = {
  byteclub: {
    minPlayers: 2, maxPlayers: 4, colors: DEFAULT_COLORS,
    startGame(room) {
      initBCGame(room);
      broadcastToRoom(room, { type: 'bc_game_started' });
      bcBroadcastState(room);
    },
    broadcastState(room)      { bcBroadcastState(room); },
    onRejoin(room, playerIdx) {
      const p = room.players[playerIdx];
      const evt = { type: 'bc_player_event', event: 'rejoined', playerIdx, playerName: p.name, playerColor: p.color };
      broadcastToRoom(room, evt);
      bcBroadcastState(room);
    },
    onDisconnect(room, playerIdx) {
      const p = room.players[playerIdx];
      const evt = { type: 'bc_player_event', event: 'disconnected', playerIdx, playerName: p.name, playerColor: p.color };
      broadcastToRoom(room, evt);
      if (room.bcState && room.bcState.currentPlayer === playerIdx && room.bcState.phase !== 'game_over') {
        bcEndTurn(room);
      } else if (room.bcState) {
        bcBroadcastState(room);
      }
    },
    isGameOver(room) { return !!(room.bcState && room.bcState.phase === 'game_over'); },
  },

  clusterflick: {
    minPlayers: 2, maxPlayers: 4, colors: DEFAULT_COLORS,
    startGame(room) {
      room.cfState = createCFGameState(room.players.length);
      broadcastToRoom(room, { type: 'game_started' });
      cfBroadcastState(room);
      if (room.players[0].isBot) { const t = setTimeout(() => executeCFBotTurn(room), 800); if (t?.unref) t.unref(); }
    },
    broadcastState(room)      { cfBroadcastState(room); },
    onRejoin(room)            { cfBroadcastState(room); },
    onDisconnect(room, playerIdx) {
      const s = room.cfState;
      if (s && s.currentPlayer === playerIdx && !s.gameOver) {
        cfAdvanceTurn(room);
        cfBroadcastState(room);
      } else if (s) {
        cfBroadcastState(room);
      }
    },
    isGameOver(room) { return !!(room.cfState && room.cfState.gameOver); },
  },

  fuzznet: {
    minPlayers: 2, maxPlayers: 4, colors: DEFAULT_COLORS,
    startGame(room) {
      room.state = createGameState(room.players.length);
      room.state.players[0].firstTurnDone = true;
      broadcastToRoom(room, { type: 'game_started' });
      fnBroadcastState(room);
      if (room.players[0].isBot) executeBotTurn(room);
    },
    broadcastState(room)      { fnBroadcastState(room); },
    onRejoin(room)            { fnBroadcastState(room); },
    onDisconnect(room, playerIdx) {
      const s = room.state;
      if (!s || s.gameOver) return;
      if (s.currentPlayer === playerIdx) {
        // Reset any mid-phase state so a mid-action disconnect doesn't freeze the game
        s.actionsLeft = 0;
        s.phase = 'idle';
        s.testAnimal = -1; s.testPath = []; s.overfitEdges = [];
        s.pathClickable = []; s.pathOptions = []; s.backpropSource = -1;
        fnNextTurn(room);
      }
      fnBroadcastState(room);
    },
    isGameOver(room) { return !!(room.state && room.state.gameOver); },
  },

  qubit: {
    minPlayers: 3, maxPlayers: 6, maxBots: 2,
    colors: ['blue', 'red', 'green', 'purple', 'yellow', 'orange'],
    startGame(room) {
      initQBGame(room);
      broadcastToRoom(room, { type: 'qb_game_started' });
      qbBroadcastState(room);
      qbMaybeScheduleBotTurn(room);
    },
    broadcastState(room)           { qbBroadcastState(room); },
    onRejoin(room)                 { qbBroadcastState(room); },
    onDisconnect(room)             { qbBroadcastState(room); },
    isGameOver(room) { return !!(room.qbState && room.qbState.gameOver); },
  },
};

/** Resolve an incoming gameType string to a known registry key, defaulting to fuzznet. */
function resolveGameType(raw) {
  return GAME_REGISTRY[raw] ? raw : 'fuzznet';
}

/** Get the registry entry for a room, with fuzznet as safe fallback. */
function getGame(room) {
  return GAME_REGISTRY[room.gameType] || GAME_REGISTRY.fuzznet;
}

/** Colours a given game seats players in. */
function gameColors(gameType) {
  return (GAME_REGISTRY[gameType] && GAME_REGISTRY[gameType].colors) || DEFAULT_COLORS;
}

/** Maximum / minimum player count for a given game. */
function gameMaxPlayers(gameType) {
  return (GAME_REGISTRY[gameType] && GAME_REGISTRY[gameType].maxPlayers) || 4;
}
function gameMinPlayers(gameType) {
  return (GAME_REGISTRY[gameType] && GAME_REGISTRY[gameType].minPlayers) || 2;
}
/** How many bot seats a game supports at once (1 for the original solo-vs-bot games). */
function gameMaxBots(gameType) {
  return (GAME_REGISTRY[gameType] && GAME_REGISTRY[gameType].maxBots) || 1;
}

// ==================== WEBSOCKET HANDLING ====================
function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return send(ws, {type:'error',msg:'Bad JSON'}); }

  // Refresh inactivity clock on every valid message
  const _info = wsData.get(ws);
  if (_info?.roomCode) {
    const _room = rooms.get(_info.roomCode);
    if (_room) _room.lastActivity = Date.now();
  }

  switch (msg.type) {
    case 'create_room': {
      const color    = msg.color;
      const gameType = resolveGameType(msg.gameType);
      if (!gameColors(gameType).includes(color)) return send(ws, {type:'error',msg:'Invalid color'});
      // Leave existing room
      leaveRoom(ws, true);
      const code = generateCode();
      const room = {
        code, hostIdx: 0,
        gameType,
        players: [{ color, name: sanitizeName(msg.playerName, COLOR_INFO[color].name), ws, connected: true }],
        observers: [],
        started: false, state: null, bcState: null, mode: 'beginner',
        createdAt: Date.now(),
      };
      rooms.set(code, room);
      wsData.set(ws, { roomCode: code, playerIdx: 0 });
      const token = generateToken();
      sessions.set(token, { roomCode: code, playerIdx: 0 });
      // Bots are added manually via toggle_bot in the waiting room
      send(ws, { type: 'room_created', code, yourId: 0, token });
      broadcastLobby(room);
      break;
    }

    case 'create_room_as_observer': {
      // Observer creates a room — no player slot taken, observer is host
      leaveRoom(ws, true);
      const code = generateCode();
      const name = sanitizeName(msg.name, 'Observer');
      const room = {
        code, hostIdx: 0,
        gameType: resolveGameType(msg.gameType),
        players: [],
        observers: [{ ws, name, connected: true }],
        started: false, state: null, bcState: null, mode: 'beginner',
        createdAt: Date.now(),
      };
      rooms.set(code, room);
      wsData.set(ws, { roomCode: code, playerIdx: -1, isObserver: true, observerIdx: 0 });
      send(ws, { type: 'joined_as_observer', code, observerIdx: 0, isHost: true, started: false });
      broadcastLobby(room);
      break;
    }

    case 'create_event_room': {
      const orgRoomCount = [...rooms.values()].filter(r => r.isEventRoom && r.eventOrganizers?.includes(ws)).length;
      if (orgRoomCount >= 10) return send(ws, { type: 'error', msg: 'Maximum of 10 event tables reached.' });
      const code = generateCode();
      const orgName = sanitizeName(msg.name, 'Organizer');
      const room = {
        code, hostIdx: 0,
        gameType: msg.gameType || 'byteclub',
        players: [],
        // Add organizer as a virtual observer (no ws — won't receive broadcasts, but shows in lobby)
        observers: [{ ws: null, name: orgName, connected: true }],
        eventOrganizers: [ws],
        isEventRoom: true,
        started: false, state: null, bcState: null,
        createdAt: Date.now(),
      };
      rooms.set(code, room);
      send(ws, { type: 'event_room_created', code });
      sendEventStatus(room);
      break;
    }

    case 'query_event_rooms': {
      const codes = Array.isArray(msg.codes) ? msg.codes.slice(0, 20) : [];
      const valid = [], dead = [];
      for (const code of codes) {
        const room = rooms.get(code);
        if (!room || !room.isEventRoom) { dead.push(code); continue; }
        if (!room.eventOrganizers.includes(ws)) room.eventOrganizers.push(ws);
        valid.push(code);
        sendEventStatus(room);
      }
      if (dead.length > 0) send(ws, { type: 'event_rooms_expired', codes: dead });
      break;
    }

    case 'check_room': {
      const room = rooms.get((msg.code||'').toUpperCase());
      if (!room) return send(ws, {type:'room_info', exists:false});
      const observerCount = (room.observers || []).length;
      const canObserve = observerCount < 10;
      if (room.started) {
        const rejoinColors = room.players
          .filter(p => !p.isBot)
          .map(p => p.color);
        return send(ws, { type:'room_info', exists:true, started:true, rejoinColors, observerCount, canObserve });
      }
      const humanCount = room.players.filter(p => !p.isBot).length;
      // Full when every seat is taken by a human (bots are always displaceable)
      if (humanCount >= gameMaxPlayers(room.gameType)) return send(ws, {type:'room_info', exists:true, full:true, observerCount, canObserve});
      // Available = all colors not held by human players (bots can be displaced)
      const humanColors = room.players.filter(p => !p.isBot).map(p => p.color);
      const available   = gameColors(room.gameType).filter(c => !humanColors.includes(c));
      send(ws, { type:'room_info', exists:true, started:false, full:false, availableColors: available, observerCount, canObserve });
      break;
    }

    case 'join_room': {
      const code = (msg.code||'').toUpperCase();
      const color = msg.color;
      const room = rooms.get(code);
      if (!room) return send(ws, {type:'error',msg:'Room not found'});
      if (!gameColors(room.gameType).includes(color)) return send(ws, {type:'error',msg:'Invalid color'});

      // Rejoin a started game by matching color — allow even if the slot still
      // appears connected (old tab may not have closed yet after a crash).
      if (room.started) {
        const rejoinIdx = room.players.findIndex(p => !p.isBot && p.color === color);
        if (rejoinIdx === -1) return send(ws, {type:'error',msg:'Game in progress — that color is not in this game'});
        leaveRoom(ws, true);
        if (room.players[rejoinIdx].ws) wsData.delete(room.players[rejoinIdx].ws);
        room.players[rejoinIdx].ws = ws;
        room.players[rejoinIdx].connected = true;
        wsData.set(ws, { roomCode: code, playerIdx: rejoinIdx });
        // Issue a fresh session token
        for (const [t, s] of sessions.entries()) {
          if (s.roomCode === code && s.playerIdx === rejoinIdx) sessions.delete(t);
        }
        const token = generateToken();
        sessions.set(token, { roomCode: code, playerIdx: rejoinIdx });
        send(ws, { type: 'room_rejoined', code, yourId: rejoinIdx, token, started: true, isHost: rejoinIdx === room.hostIdx });
        getGame(room).onRejoin(room, rejoinIdx);
        break;
      }

      // If a human already holds this color, reject
      if (room.players.some(p => !p.isBot && p.color === color)) {
        const humanColors = room.players.filter(p => !p.isBot).map(p => p.color);
        const available = gameColors(room.gameType).filter(c => !humanColors.includes(c));
        return send(ws, {type:'error',msg:'Color already taken',availableColors:available});
      }
      // When a human joins, drop all bots — humans only from here on
      const hadBots = room.players.some(p => p.isBot);
      if (hadBots) {
        // Remove all bots and reindex wsData + sessions for remaining humans
        room.players = room.players.filter(p => !p.isBot);
        let idx = 0;
        for (const [w, d] of wsData.entries()) {
          if (d.roomCode === code) { d.playerIdx = idx++; }
        }
        for (const [t, s] of sessions.entries()) {
          if (s.roomCode === code) { /* bots have no sessions, nothing to reindex */ }
        }
      }
      if (room.players.length >= gameMaxPlayers(room.gameType)) return send(ws, {type:'error',msg:'Room is full'});
      leaveRoom(ws, true);
      const idx = room.players.length;
      room.players.push({ color, name: sanitizeName(msg.playerName, COLOR_INFO[color].name), ws, connected: true });
      wsData.set(ws, { roomCode: code, playerIdx: idx });
      const token = generateToken();
      sessions.set(token, { roomCode: code, playerIdx: idx });
      send(ws, { type: 'room_joined', code, yourId: idx, token, isHost: idx === room.hostIdx });
      broadcastLobby(room);
      break;
    }

    case 'join_as_observer': {
      const code = (msg.code||'').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, {type:'error', msg:'Room not found'});
      const observers = room.observers || (room.observers = []);
      if (observers.length >= 10) return send(ws, {type:'error', msg:'Observer limit reached (max 10)'});
      leaveRoom(ws, true);
      const name = sanitizeName(msg.name, 'Observer');
      // For event rooms, replace the null placeholder at index 0 so the first real
      // observer inherits host status instead of being pushed to index 1.
      const placeholderIdx = room.isEventRoom ? observers.findIndex(o => o.ws === null) : -1;
      let observerIdx, isObsHost;
      if (placeholderIdx !== -1) {
        observers[placeholderIdx] = { ws, name, connected: true };
        observerIdx = placeholderIdx;
        isObsHost = placeholderIdx === 0;
      } else {
        observerIdx = observers.length;
        isObsHost = observerIdx === 0;
        observers.push({ ws, name, connected: true });
      }
      wsData.set(ws, { roomCode: code, playerIdx: -1, isObserver: true, observerIdx });
      send(ws, { type: 'joined_as_observer', code, observerIdx, isHost: isObsHost, started: room.started });
      broadcastLobby(room);
      // If game already started send current state immediately
      if (room.started) getGame(room).broadcastState(room);
      break;
    }

    case 'rejoin_room': {
      const session = sessions.get(msg.token);
      if (!session) return send(ws, { type: 'rejoin_failed' });
      const room = rooms.get(session.roomCode);
      if (!room) { sessions.delete(msg.token); return send(ws, { type: 'rejoin_failed' }); }
      const playerIdx = session.playerIdx;
      const player = room.players[playerIdx];
      if (!player || player.isBot) { sessions.delete(msg.token); return send(ws, { type: 'rejoin_failed' }); }
      // Reject rejoin into a finished game — client lands on lobby instead of game-over screen
      if (room.started && getGame(room).isGameOver(room)) {
        sessions.delete(msg.token);
        return send(ws, { type: 'rejoin_failed' });
      }
      // Detach old ws if any
      if (player.ws && player.ws !== ws) wsData.delete(player.ws);
      player.ws = ws;
      player.connected = true;
      wsData.set(ws, { roomCode: room.code, playerIdx });
      if (!room.started) {
        send(ws, { type: 'room_rejoined', code: room.code, yourId: playerIdx, token: msg.token, started: false, isHost: playerIdx === room.hostIdx });
        broadcastLobby(room);
      } else {
        send(ws, { type: 'room_rejoined', code: room.code, yourId: playerIdx, token: msg.token, started: true, isHost: playerIdx === room.hostIdx });
        getGame(room).onRejoin(room, playerIdx);
      }
      break;
    }

    case 'toggle_bot': {
      const info = wsData.get(ws);
      if (!info) return send(ws, {type:'error',msg:'Not in a room'});
      const room = rooms.get(info.roomCode);
      if (!room || room.started) return;
      const isPlayerHost = !info.isObserver && info.playerIdx === room.hostIdx;
      const isObsHost = info.isObserver && info.observerIdx === 0;
      if (!isPlayerHost && !isObsHost) return send(ws, {type:'error',msg:'Only host can add bot'});

      const maxBots = gameMaxBots(room.gameType);
      const bots    = room.players.filter(p => p.isBot);
      const humans  = room.players.length - bots.length;

      if (maxBots <= 1) {
        // Original single-bot toggle: solo-vs-bot only, one bot in or out.
        if (humans > 1) return send(ws, {type:'error',msg:'Bot only available for single player'});
        const botIdx = room.players.findIndex(p => p.isBot);
        if (botIdx !== -1) {
          room.players.splice(botIdx, 1);
          for (const [w, d] of wsData.entries()) {
            if (d.roomCode === room.code && d.playerIdx > botIdx) d.playerIdx--;
          }
        } else {
          const taken = room.players.map(p => p.color);
          const available = gameColors(room.gameType).filter(c => !taken.includes(c));
          if (available.length === 0) return;
          const botColor = available[Math.floor(Math.random() * available.length)];
          room.players.push({ color: botColor, name: COLOR_INFO[botColor].name + ' (Bot)', ws: null, connected: true, isBot: true });
        }
      } else {
        // Multi-bot cycle: click adds one bot at a time up to maxBots, then
        // the next click clears them all back to zero.
        if (bots.length < maxBots && room.players.length < gameMaxPlayers(room.gameType)) {
          const taken = room.players.map(p => p.color);
          const available = gameColors(room.gameType).filter(c => !taken.includes(c));
          if (available.length === 0) return;
          const botColor = available[Math.floor(Math.random() * available.length)];
          room.players.push({ color: botColor, name: COLOR_INFO[botColor].name + ' (Bot)', ws: null, connected: true, isBot: true });
        } else if (bots.length > 0) {
          // Remove bots from the end so player indices held by earlier bots
          // (and any humans) are undisturbed.
          for (let i = room.players.length - 1; i >= 0; i--) {
            if (!room.players[i].isBot) continue;
            room.players.splice(i, 1);
            for (const [w, d] of wsData.entries()) {
              if (d.roomCode === room.code && d.playerIdx > i) d.playerIdx--;
            }
          }
        }
      }
      broadcastLobby(room);
      break;
    }

    case 'set_qb_mode': {
      const info = wsData.get(ws);
      if (!info) return send(ws, {type:'error',msg:'Not in a room'});
      const room = rooms.get(info.roomCode);
      if (!room || room.started) return;
      const isPlayerHost = !info.isObserver && info.playerIdx === room.hostIdx;
      const isObsHost = info.isObserver && info.observerIdx === 0;
      if (!isPlayerHost && !isObsHost) return send(ws, {type:'error',msg:'Only host can change game mode'});
      if (msg.mode !== 'beginner' && msg.mode !== 'advanced') return;
      room.mode = msg.mode;
      broadcastLobby(room);
      break;
    }

    case 'start_game': {
      const info = wsData.get(ws);
      if (!info) return send(ws, {type:'error',msg:'Not in a room'});
      const room = rooms.get(info.roomCode);
      if (!room) return send(ws, {type:'error',msg:'Room not found'});
      const isPlayerHost = !info.isObserver && info.playerIdx === room.hostIdx;
      const isObsHost = info.isObserver && info.observerIdx === 0;
      if (!isPlayerHost && !isObsHost) return send(ws, {type:'error',msg:'Only host can start'});
      const _minPlayers = gameMinPlayers(room.gameType);
      if (room.players.length < _minPlayers) return send(ws, {type:'error',msg:`Need at least ${_minPlayers} players`});
      if (room.started) return send(ws, {type:'error',msg:'Already started'});
      room.started = true;
      room.sessionStartedAt = Date.now();
      room.uvKey = wsUvKey.get(ws) || '';
      const _startMode = room.players.some(p => p.isBot) ? '1p_bot'
        : room.players.length + 'p';
      const _rematch = isRematch(room.uvKey, room.gameType);
      trackEvent('session_started', { gameType: room.gameType, mode: _startMode, uvKey: room.uvKey, rematch: _rematch });
      getGame(room).startGame(room);
      sendEventStatus(room);
      scheduleSave();
      break;
    }

    case 'game_action': {
      const info = wsData.get(ws);
      if (!info) return send(ws, {type:'error',msg:'Not in a room'});
      const room = rooms.get(info.roomCode);
      if (!room || !room.started) return send(ws, {type:'error',msg:'Game not started'});
      try {
        if (room.gameType === 'byteclub') {
          bcHandleAction(room, info.playerIdx, msg);
        } else if (room.gameType === 'qubit') {
          qbHandleAction(room, info.playerIdx, msg);
        } else if (room.gameType === 'clusterflick') {
          const err = processCFAction(room, info.playerIdx, msg);
          if (err) return send(ws, {type:'error',msg:err});
          const wpts=room._lastFlickWaypoints||null;
          room._lastFlickWaypoints=null;
          cfBroadcastState(room,wpts);
        } else {
          const err = processAction(room, info.playerIdx, msg);
          if (err) return send(ws, {type:'error',msg:err});
          fnBroadcastState(room);
        }
        scheduleSave();
      } catch (e) {
        console.error('[game_action crash] room=%s type=%s err=%s', info.roomCode, msg.action, e && e.message, e);
        send(ws, { type: 'error', msg: 'Server error processing that action — please rejoin if the game appears stuck.' });
      }
      break;
    }

    case 'cancel_game': {
      const info = wsData.get(ws);
      if (!info) break;
      const room = rooms.get(info.roomCode);
      if (!room || !room.started) break;
      const isPlayerHost = !info.isObserver && info.playerIdx === room.hostIdx;
      const isObsHost = info.isObserver && info.observerIdx === 0;
      if (!isPlayerHost && !isObsHost) return send(ws, { type: 'error', msg: 'Only the host can cancel the game' });
      // Notify all connected players and observers
      for (const p of room.players) {
        if (p.connected && p.ws) send(p.ws, { type: 'game_cancelled' });
      }
      for (const o of (room.observers || [])) {
        if (o.connected && o.ws) send(o.ws, { type: 'game_cancelled' });
      }
      // Clean up sessions and wsData
      for (const [t, s] of sessions.entries()) {
        if (s.roomCode === room.code) sessions.delete(t);
      }
      for (const p of room.players) {
        if (p.ws) wsData.delete(p.ws);
      }
      for (const o of (room.observers || [])) {
        if (o.ws) wsData.delete(o.ws);
      }
      // Stop any in-flight bot loops by marking the game as over before deleting the room.
      // Without this, async bot turns hold a stale room reference and keep spinning.
      if (room.state)   room.state.gameOver   = true;
      if (room.bcState) room.bcState.phase     = 'game_over';
      if (room.cfState) room.cfState.gameOver  = true;
      if (room.qbState) room.qbState.gameOver  = true;
      // Notify event organizers before the room is deleted
      if (room.isEventRoom && room.eventOrganizers?.length > 0) {
        const update = { type: 'event_status_update', code: room.code, playerCount: 0, status: 'cancelled' };
        for (const orgWs of room.eventOrganizers) send(orgWs, update);
      }
      rooms.delete(room.code);
      break;
    }

    case 'leave_room': {
      leaveRoom(ws, true);
      send(ws, { type: 'left_room' });
      break;
    }
  }
}

function leaveRoom(ws, explicit = false) {
  const info = wsData.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomCode);
  wsData.delete(ws);
  if (!room) return;

  // ── Observer disconnect ──
  if (info.isObserver) {
    const oIdx = info.observerIdx;
    if (room.observers && oIdx < room.observers.length) {
      room.observers.splice(oIdx, 1);
      // Fix observerIdx for remaining observers in wsData
      for (const [w, d] of wsData.entries()) {
        if (d.roomCode === room.code && d.isObserver && d.observerIdx > oIdx) d.observerIdx--;
      }
    }
    if (!room.started && room.players.length === 0 && (room.observers || []).length === 0
        && !(room.isEventRoom && room.eventOrganizers?.length > 0)) {
      rooms.delete(room.code);
    } else {
      broadcastLobby(room);
    }
    return;
  }

  if (!room.started) {
    // Remove player from lobby (always — can't hold a slot while disconnected pre-game)
    room.players.splice(info.playerIdx, 1);
    // Fix indices for remaining players and sessions
    for (const [w, d] of wsData.entries()) {
      if (d.roomCode === room.code && d.playerIdx > info.playerIdx) d.playerIdx--;
    }
    for (const [t, s] of sessions.entries()) {
      if (s.roomCode === room.code) {
        if (s.playerIdx === info.playerIdx) sessions.delete(t);
        else if (s.playerIdx > info.playerIdx) s.playerIdx--;
      }
    }
    if (room.hostIdx >= room.players.length) room.hostIdx = 0;
    if (room.players.length === 0 && !(room.isEventRoom && room.eventOrganizers?.length > 0)) {
      rooms.delete(room.code);
    } else {
      broadcastLobby(room);
    }
  } else {
    // Track unexpected mid-game disconnects (not explicit leaves, not already finished games)
    if (!explicit) {
      if (!getGame(room).isGameOver(room)) trackEvent('ws_disconnect', { gameType: room.gameType || '' });
    }
    // Capture name/color before nulling ws so the broadcast message is meaningful
    const _dcName  = room.players[info.playerIdx].name;
    const _dcColor = room.players[info.playerIdx].color;
    // Mark as disconnected in game — keep their slot for reconnection
    room.players[info.playerIdx].connected = false;
    room.players[info.playerIdx].ws = null;
    // If they explicitly left, clear their session so they can't rejoin
    if (explicit) {
      for (const [t, s] of sessions.entries()) {
        if (s.roomCode === room.code && s.playerIdx === info.playerIdx) sessions.delete(t);
      }
    }
    // Notify remaining players so they know to wait (or that someone left)
    if (!getGame(room).isGameOver(room)) {
      broadcastToRoom(room, {
        type    : 'player_disconnected',
        name    : _dcName,
        color   : _dcColor,
        explicit: explicit,
      });
    }
    getGame(room).onDisconnect(room, info.playerIdx);
    // Only delete room if all players explicitly left or all disconnected with no sessions
    const hasRejoinable = room.players.some(p => !p.isBot && !p.connected &&
      [...sessions.values()].some(s => s.roomCode === room.code && s.playerIdx === room.players.indexOf(p)));
    if (room.players.every(p => !p.connected) && !hasRejoinable) rooms.delete(room.code);
  }
}

module.exports = {
  handleMessage,
  leaveRoom,
  wsUvKey,
  rooms,
  sessions,
  wsData,
  generateToken,
  generateCode,
  sanitizeName,
  broadcastToRoom,
  broadcastLobby,
  sendEventStatus,
  GAME_REGISTRY,
};
