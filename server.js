const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = 8090;

// ==================== CONSTANTS ====================
const COLOR_INFO = {
  blue:   { hex: '#4a9eff', name: 'Blue' },
  red:    { hex: '#ff4a4a', name: 'Red' },
  green:  { hex: '#4aff8a', name: 'Green' },
  purple: { hex: '#c880ff', name: 'Purple' },
};
const CLEAN_PENALTIES = [0, -1, -2, -4, -6];
const SCORE_VALUES = { 2: [5, 3], 3: [5, 3, 2], 4: [5, 4, 3, 2] };
const TEST_THRESHOLD = 18;

const INPUT_TO_L1 = { 0:[0], 1:[0,1], 2:[1,2], 3:[2,3], 4:[3] };
const L1_TO_L2 = { 0:[4,6], 1:[4,5], 2:[5,6], 3:[4,6] };
const L2_TO_L3 = { 4:[7,8], 5:[8,9], 6:[9,10] };
const L3_TO_OUT = { 7:[0,1], 8:[1,2], 9:[2,3], 10:[3,4] };

// ==================== GAME HELPERS ====================
function getForwardEdges(nodeId) {
  if (nodeId <= 3) return (L1_TO_L2[nodeId]||[]).map(t => ({from:nodeId,to:t,key:nodeId+'-'+t}));
  if (nodeId <= 6) return (L2_TO_L3[nodeId]||[]).map(t => ({from:nodeId,to:t,key:nodeId+'-'+t}));
  return (L3_TO_OUT[nodeId]||[]).map(t => ({from:nodeId,to:t,key:nodeId+'-out'+t}));
}

function findPaths(ps, animalOrder, animalIdx) {
  const targetOut = animalOrder.indexOf(animalIdx);
  const paths = [];
  for (const l1 of (INPUT_TO_L1[animalIdx]||[])) {
    if (!ps.nodes[l1]) continue;
    for (const l2 of (L1_TO_L2[l1]||[])) {
      if (!ps.nodes[l2] || ps.blocked.includes(l1+'-'+l2)) continue;
      for (const l3 of (L2_TO_L3[l2]||[])) {
        if (!ps.nodes[l3] || ps.blocked.includes(l2+'-'+l3)) continue;
        if ((L3_TO_OUT[l3]||[]).includes(targetOut) && !ps.blocked.includes(l3+'-out'+targetOut)) {
          paths.push([l1, l2, l3]);
        }
      }
    }
  }
  return paths;
}

function canTestAny(ps, animalOrder) {
  for (let a = 0; a < 5; a++) {
    if (!ps.tested[a] && findPaths(ps, animalOrder, a).length > 0) return true;
  }
  return false;
}

function countDataSlots(ps) {
  let s = 0;
  for (let i = 0; i < 11; i++) if (ps.nodes[i] && ps.data[i] < 3) s += (3 - ps.data[i]);
  return s;
}

function hasNodeSlots(ps) {
  for (let i = 0; i < 11; i++) if (!ps.nodes[i]) return true;
  return false;
}

function rollDie() { return Math.floor(Math.random() * 6) + 1; }

function canBackprop(ps, testPath) {
  const pathSet = new Set(testPath);
  for (let src = 0; src < 11; src++) {
    if (!ps.nodes[src] || ps.data[src] <= 0) continue;
    for (let dst = 0; dst < 11; dst++) {
      if (src === dst) continue;
      if (!ps.nodes[dst] || ps.data[dst] >= 3) continue;
      if (pathSet.has(src) || pathSet.has(dst)) return true;
    }
  }
  return false;
}

function calculateScore(ps, scoreboard, numPlayers) {
  const vals = SCORE_VALUES[numPlayers];
  let score = 0;
  for (let a = 0; a < 5; a++) {
    for (let i = 0; i < scoreboard[a].length; i++) {
      if (scoreboard[a][i] && scoreboard[a][i].player === ps._idx) {
        score += vals[i];
        score += scoreboard[a][i].bonusTokens;
      }
    }
  }
  if (ps.tested.every(t => t)) score += 1;
  for (let i = 0; i < 11; i++) if (ps.nodes[i] && ps.data[i] >= 3) score += 1;
  score += CLEAN_PENALTIES[ps.cleanUses];
  return score;
}

// ==================== ROOM MANAGEMENT ====================
const rooms = new Map();
const wsData = new Map(); // ws -> { roomCode, playerIdx }

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
    players: room.players.map((p, i) => ({
      color: p.color, name: p.name, connected: p.connected, isHost: i === room.hostIdx,
    })),
  };
  for (const p of room.players) {
    if (p.connected && p.ws) send(p.ws, lobbyInfo);
  }
}

function broadcastState(room) {
  const s = room.state;
  const numP = room.players.length;
  const base = {
    type: 'state_update',
    code: room.code,
    state: {
      phase: s.phase, currentPlayer: s.currentPlayer, actionsLeft: s.actionsLeft,
      round: s.round, animalOrder: s.animalOrder, gameEnding: s.gameEnding, gameOver: s.gameOver,
      testAnimal: s.testAnimal, testPath: s.testPath, dice: s.dice,
      overfitEdges: s.overfitEdges, pathClickable: s.pathClickable, backpropSource: s.backpropSource,
      scoreboard: s.scoreboard, roundScores: s.roundScores,
      players: s.players.map((ps, i) => ({
        ...ps,
        color: room.players[i].color,
        name: room.players[i].name,
        hex: COLOR_INFO[room.players[i].color].hex,
        connected: room.players[i].connected,
      })),
      scores: s.players.map((ps, i) => calculateScore(ps, s.scoreboard, numP)),
    },
  };
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.connected && p.ws) {
      send(p.ws, { ...base, yourId: i });
    }
  }
}

// ==================== GAME STATE INIT ====================
function createGameState(numPlayers) {
  const order = [0,1,2,3,4];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return {
    phase: 'idle',
    currentPlayer: 0,
    actionsLeft: 3,
    round: 1,
    animalOrder: order,
    players: Array.from({length: numPlayers}, (_, i) => ({
      _idx: i,
      nodes: Array(11).fill(false),
      data: Array(11).fill(0),
      blocked: [],
      cleanUses: 0,
      tested: Array(5).fill(false),
      firstTurnDone: false,
    })),
    scoreboard: [[], [], [], [], []],
    roundScores: {},
    gameEnding: false,
    gameOver: false,
    testAnimal: -1,
    testPath: [],
    dice: [0, 0, 0],
    overfitEdges: [],
    pathClickable: [],
    pathOptions: [],
    _overfitFromTrain2: false,
    backpropSource: -1,
  };
}

// ==================== ACTION PROCESSING ====================
function curPlayer(s) { return s.players[s.currentPlayer]; }

function consumeAction(room) {
  const s = room.state;
  s.actionsLeft--;
  s.phase = 'idle';
  s.testAnimal = -1; s.testPath = []; s.overfitEdges = [];
  s.pathClickable = []; s.pathOptions = []; s.backpropSource = -1;
  if (s.actionsLeft <= 0) {
    nextTurn(room);
  }
}

function nextTurn(room) {
  const s = room.state;
  if (s.gameOver) return;

  // Check game end
  if (s.gameEnding) {
    const next = (s.currentPlayer + 1) % s.players.length;
    if (next === 0) { endGame(room); return; }
  }

  // Check testing impossible
  if (checkTestingImpossible(s)) {
    s.gameEnding = true;
    const next = (s.currentPlayer + 1) % s.players.length;
    if (next === 0) { endGame(room); return; }
  }

  s.currentPlayer = (s.currentPlayer + 1) % s.players.length;
  if (s.currentPlayer === 0) {
    s.round++;
    s.roundScores = {};
  }

  // Skip disconnected players
  let attempts = 0;
  while (!room.players[s.currentPlayer].connected && attempts < s.players.length) {
    s.currentPlayer = (s.currentPlayer + 1) % s.players.length;
    if (s.currentPlayer === 0) { s.round++; s.roundScores = {}; }
    attempts++;
  }
  if (attempts >= s.players.length) { endGame(room); return; }

  const p = curPlayer(s);
  s.actionsLeft = p.firstTurnDone ? 1 : 3;
  p.firstTurnDone = true;
  s.phase = 'idle';
}

function checkTestingImpossible(s) {
  for (let pi = 0; pi < s.players.length; pi++) {
    const ps = s.players[pi];
    for (let a = 0; a < 5; a++) {
      if (!ps.tested[a] && findPaths(ps, s.animalOrder, a).length > 0) return false;
    }
    if (hasNodeSlots(ps) || countDataSlots(ps) >= 2) return false;
  }
  return true;
}

function endGame(room) {
  room.state.gameOver = true;
  room.state.phase = 'idle';
}

function processAction(room, playerIdx, msg) {
  const s = room.state;
  if (s.gameOver) return 'Game is over';
  if (s.currentPlayer !== playerIdx) return 'Not your turn';

  const ps = curPlayer(s);
  const act = msg.action;

  switch (act) {
    case 'start_design': {
      if (s.phase !== 'idle' || s.actionsLeft <= 0) return 'Invalid';
      if (!hasNodeSlots(ps)) return 'No empty nodes';
      s.phase = 'design';
      return null;
    }
    case 'place_node': {
      if (s.phase !== 'design') return 'Not in design phase';
      const id = msg.nodeId;
      if (id < 0 || id > 10 || ps.nodes[id]) return 'Invalid node';
      ps.nodes[id] = true;
      consumeAction(room);
      return null;
    }
    case 'start_train': {
      if (s.phase !== 'idle' || s.actionsLeft <= 0) return 'Invalid';
      if (countDataSlots(ps) < 2) return 'Not enough data slots';
      s.phase = 'train1';
      return null;
    }
    case 'place_data': {
      if (s.phase !== 'train1' && s.phase !== 'train2') return 'Not in train phase';
      const id = msg.nodeId;
      if (id < 0 || id > 10 || !ps.nodes[id] || ps.data[id] >= 3) return 'Invalid node';
      const wasPhase = s.phase;
      ps.data[id]++;
      if (ps.data[id] >= 3) {
        const fwd = getForwardEdges(id).filter(e => !ps.blocked.includes(e.key));
        if (fwd.length > 0) {
          s.overfitEdges = fwd;
          s._overfitFromTrain2 = (wasPhase === 'train2');
          s.phase = 'train_overfit';
          return null;
        }
      }
      if (wasPhase === 'train1') { s.phase = 'train2'; }
      else { consumeAction(room); }
      return null;
    }
    case 'select_overfit_edge': {
      if (s.phase !== 'train_overfit') return 'Not in overfit phase';
      const key = msg.edgeKey;
      if (!s.overfitEdges.find(e => e.key === key)) return 'Invalid edge';
      ps.blocked.push(key);
      const wasFrom2 = s._overfitFromTrain2;
      s.overfitEdges = [];
      s._overfitFromTrain2 = false;
      if (!wasFrom2) { s.phase = 'train2'; }
      else { consumeAction(room); }
      return null;
    }
    case 'start_test': {
      if (s.phase !== 'idle' || s.actionsLeft <= 0) return 'Invalid';
      if (!canTestAny(ps, s.animalOrder)) return 'No testable animals';
      s.testAnimal = -1; s.testPath = []; s.dice = [0,0,0];
      s.phase = 'test_animal';
      return null;
    }
    case 'select_animal': {
      if (s.phase !== 'test_animal') return 'Wrong phase';
      const a = msg.animalIdx;
      if (a < 0 || a > 4 || ps.tested[a]) return 'Invalid animal';
      const paths = findPaths(ps, s.animalOrder, a);
      if (paths.length === 0) return 'No valid paths';
      s.testAnimal = a;
      s.testPath = [];
      s.pathOptions = paths;
      if (paths.length === 1) {
        s.testPath = [...paths[0]];
        s.phase = 'test_roll';
      } else {
        s.phase = 'test_path_l1';
        s.pathClickable = [...new Set(paths.map(p => p[0]))];
      }
      return null;
    }
    case 'select_path_node': {
      if (!['test_path_l1','test_path_l2','test_path_l3'].includes(s.phase)) return 'Wrong phase';
      const id = msg.nodeId;
      if (!s.pathClickable || !s.pathClickable.includes(id)) return 'Invalid node';
      s.testPath.push(id);
      // Advance path selection
      const matching = s.pathOptions.filter(p => {
        for (let i = 0; i < s.testPath.length; i++) if (p[i] !== s.testPath[i]) return false;
        return true;
      });
      if (s.testPath.length === 3) {
        s.pathClickable = [];
        s.phase = 'test_roll';
      } else {
        const nextOpts = [...new Set(matching.map(p => p[s.testPath.length]))];
        if (nextOpts.length === 1) {
          s.testPath.push(nextOpts[0]);
          // Check again
          if (s.testPath.length === 3) {
            s.pathClickable = [];
            s.phase = 'test_roll';
          } else {
            const matching2 = s.pathOptions.filter(p => {
              for (let i = 0; i < s.testPath.length; i++) if (p[i] !== s.testPath[i]) return false;
              return true;
            });
            const nextOpts2 = [...new Set(matching2.map(p => p[s.testPath.length]))];
            if (nextOpts2.length === 1) {
              s.testPath.push(nextOpts2[0]);
              s.pathClickable = [];
              s.phase = 'test_roll';
            } else {
              s.pathClickable = nextOpts2;
              s.phase = s.testPath.length === 1 ? 'test_path_l2' : 'test_path_l3';
            }
          }
        } else {
          s.pathClickable = nextOpts;
          s.phase = s.testPath.length === 1 ? 'test_path_l2' : 'test_path_l3';
        }
      }
      return null;
    }
    case 'roll_dice': {
      if (s.phase !== 'test_roll') return 'Wrong phase';
      s.dice = [rollDie(), rollDie(), rollDie()];
      s.phase = 'test_eval';
      return null;
    }
    case 'clean_reroll': {
      if (s.phase !== 'test_eval') return 'Wrong phase';
      if (ps.cleanUses >= 4) return 'No clean uses left';
      const indices = msg.diceIndices;
      if (!Array.isArray(indices) || indices.length === 0) return 'Select dice';
      for (const i of indices) { if (i < 0 || i > 2) return 'Invalid die'; }
      ps.cleanUses++;
      for (const i of indices) s.dice[i] = rollDie();
      // phase stays test_eval
      return null;
    }
    case 'clean_flip': {
      if (s.phase !== 'test_eval') return 'Wrong phase';
      if (ps.cleanUses >= 4) return 'No clean uses left';
      const i = msg.dieIdx;
      if (i < 0 || i > 2) return 'Invalid die';
      ps.cleanUses++;
      s.dice[i] = 7 - s.dice[i];
      return null;
    }
    case 'resolve_success': {
      if (s.phase !== 'test_eval') return 'Wrong phase';
      const diceSum = s.dice[0] + s.dice[1] + s.dice[2];
      const dataOnPath = s.testPath.reduce((sum, n) => sum + ps.data[n], 0);
      if (diceSum + dataOnPath < TEST_THRESHOLD) return 'Test not passed';
      const a = s.testAnimal;
      ps.tested[a] = true;
      const vals = SCORE_VALUES[s.players.length];
      const slot = s.scoreboard[a].length;
      if (slot < vals.length) {
        let bonusTokens = 0;
        if (s.roundScores[a] !== undefined) {
          bonusTokens = Math.max(0, s.roundScores[a] - vals[slot]);
        } else {
          s.roundScores[a] = vals[slot];
        }
        s.scoreboard[a].push({ player: playerIdx, round: s.round, bonusTokens });
      }
      if (ps.tested.every(t => t)) s.gameEnding = true;
      consumeAction(room);
      return null;
    }
    case 'resolve_fail': {
      if (s.phase !== 'test_eval') return 'Wrong phase';
      if (canBackprop(ps, s.testPath)) {
        s.phase = 'backprop_source';
        s.backpropSource = -1;
      } else {
        consumeAction(room);
      }
      return null;
    }
    case 'backprop_select_source': {
      if (s.phase !== 'backprop_source') return 'Wrong phase';
      const src = msg.nodeId;
      if (src < 0 || src > 10 || !ps.nodes[src] || ps.data[src] <= 0) return 'Invalid source';
      const pathSet = new Set(s.testPath);
      let hasValidDest = false;
      for (let dst = 0; dst < 11; dst++) {
        if (src === dst) continue;
        if (!ps.nodes[dst] || ps.data[dst] >= 3) continue;
        if (pathSet.has(src) || pathSet.has(dst)) { hasValidDest = true; break; }
      }
      if (!hasValidDest) return 'No valid destination for this source';
      s.backpropSource = src;
      s.phase = 'backprop_dest';
      return null;
    }
    case 'backprop_select_dest': {
      if (s.phase !== 'backprop_dest') return 'Wrong phase';
      const dst = msg.nodeId;
      const src = s.backpropSource;
      if (dst < 0 || dst > 10 || !ps.nodes[dst] || ps.data[dst] >= 3) return 'Invalid destination';
      if (dst === src) return 'Must be different from source';
      const pathSet = new Set(s.testPath);
      if (!pathSet.has(src) && !pathSet.has(dst)) return 'At least one node must be on the test path';
      // Move: remove data from source
      ps.data[src]--;
      // If source was maxed (now 2), remove its overfit edge
      if (ps.data[src] === 2) {
        const edges = getForwardEdges(src);
        for (const e of edges) {
          const idx = ps.blocked.indexOf(e.key);
          if (idx !== -1) { ps.blocked.splice(idx, 1); break; }
        }
      }
      // Add data to destination
      ps.data[dst]++;
      // If destination becomes maxed (3), need overfit edge selection
      if (ps.data[dst] >= 3) {
        const fwd = getForwardEdges(dst).filter(e => !ps.blocked.includes(e.key));
        if (fwd.length > 0) {
          s.overfitEdges = fwd;
          s.phase = 'backprop_overfit';
          s.backpropSource = -1;
          return null;
        }
      }
      s.backpropSource = -1;
      consumeAction(room);
      return null;
    }
    case 'backprop_select_overfit': {
      if (s.phase !== 'backprop_overfit') return 'Wrong phase';
      const key = msg.edgeKey;
      if (!s.overfitEdges.find(e => e.key === key)) return 'Invalid edge';
      ps.blocked.push(key);
      s.overfitEdges = [];
      consumeAction(room);
      return null;
    }
    case 'end_turn': {
      if (s.phase !== 'idle' || s.actionsLeft <= 0) return 'Invalid';
      s.actionsLeft = 0;
      nextTurn(room);
      return null;
    }
    default: return 'Unknown action';
  }
}

// ==================== WEBSOCKET HANDLING ====================
function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return send(ws, {type:'error',msg:'Bad JSON'}); }

  switch (msg.type) {
    case 'create_room': {
      const color = msg.color;
      if (!COLOR_INFO[color]) return send(ws, {type:'error',msg:'Invalid color'});
      // Leave existing room
      leaveRoom(ws);
      const code = generateCode();
      const room = {
        code, hostIdx: 0,
        players: [{ color, name: COLOR_INFO[color].name, ws, connected: true }],
        started: false, state: null,
      };
      rooms.set(code, room);
      wsData.set(ws, { roomCode: code, playerIdx: 0 });
      send(ws, { type: 'room_created', code, yourId: 0 });
      broadcastLobby(room);
      break;
    }

    case 'check_room': {
      const room = rooms.get((msg.code||'').toUpperCase());
      if (!room) return send(ws, {type:'room_info', exists:false});
      if (room.started) return send(ws, {type:'room_info', exists:true, started:true});
      if (room.players.length >= 4) return send(ws, {type:'room_info', exists:true, full:true});
      const taken = room.players.map(p => p.color);
      const available = Object.keys(COLOR_INFO).filter(c => !taken.includes(c));
      send(ws, { type:'room_info', exists:true, started:false, full:false, availableColors: available });
      break;
    }

    case 'join_room': {
      const code = (msg.code||'').toUpperCase();
      const color = msg.color;
      if (!COLOR_INFO[color]) return send(ws, {type:'error',msg:'Invalid color'});
      const room = rooms.get(code);
      if (!room) return send(ws, {type:'error',msg:'Room not found'});
      if (room.started) return send(ws, {type:'error',msg:'Game already started'});
      if (room.players.length >= 4) return send(ws, {type:'error',msg:'Room is full'});
      if (room.players.some(p => p.color === color)) {
        const available = Object.keys(COLOR_INFO).filter(c => !room.players.some(p2 => p2.color === c));
        return send(ws, {type:'error',msg:'Color already taken',availableColors:available});
      }
      leaveRoom(ws);
      const idx = room.players.length;
      room.players.push({ color, name: COLOR_INFO[color].name, ws, connected: true });
      wsData.set(ws, { roomCode: code, playerIdx: idx });
      send(ws, { type: 'room_joined', code, yourId: idx });
      broadcastLobby(room);
      break;
    }

    case 'start_game': {
      const info = wsData.get(ws);
      if (!info) return send(ws, {type:'error',msg:'Not in a room'});
      const room = rooms.get(info.roomCode);
      if (!room) return send(ws, {type:'error',msg:'Room not found'});
      if (info.playerIdx !== room.hostIdx) return send(ws, {type:'error',msg:'Only host can start'});
      if (room.players.length < 2) return send(ws, {type:'error',msg:'Need at least 2 players'});
      if (room.started) return send(ws, {type:'error',msg:'Already started'});
      room.started = true;
      room.state = createGameState(room.players.length);
      // Mark first player's firstTurnDone
      room.state.players[0].firstTurnDone = true;
      for (const p of room.players) send(p.ws, { type: 'game_started' });
      broadcastState(room);
      break;
    }

    case 'game_action': {
      const info = wsData.get(ws);
      if (!info) return send(ws, {type:'error',msg:'Not in a room'});
      const room = rooms.get(info.roomCode);
      if (!room || !room.started) return send(ws, {type:'error',msg:'Game not started'});
      const err = processAction(room, info.playerIdx, msg);
      if (err) return send(ws, {type:'error',msg:err});
      broadcastState(room);
      break;
    }

    case 'leave_room': {
      leaveRoom(ws);
      send(ws, { type: 'left_room' });
      break;
    }
  }
}

function leaveRoom(ws) {
  const info = wsData.get(ws);
  if (!info) return;
  const room = rooms.get(info.roomCode);
  wsData.delete(ws);
  if (!room) return;

  if (!room.started) {
    // Remove player from lobby
    room.players.splice(info.playerIdx, 1);
    // Fix indices for remaining players
    for (const [w, d] of wsData.entries()) {
      if (d.roomCode === room.code && d.playerIdx > info.playerIdx) d.playerIdx--;
    }
    if (room.hostIdx >= room.players.length) room.hostIdx = 0;
    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      broadcastLobby(room);
    }
  } else {
    // Mark as disconnected in game
    room.players[info.playerIdx].connected = false;
    room.players[info.playerIdx].ws = null;
    // If it's their turn, skip
    if (room.state.currentPlayer === info.playerIdx && !room.state.gameOver) {
      room.state.actionsLeft = 0;
      room.state.phase = 'idle';
      nextTurn(room);
      broadcastState(room);
    }
    // If all disconnected, clean up
    if (room.players.every(p => !p.connected)) rooms.delete(room.code);
  }
}

// ==================== HTTP SERVER ====================
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const url = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  const filePath = path.join(__dirname, url);
  // Only serve files under __dirname (prevent path traversal)
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => handleMessage(ws, raw.toString()));
  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

server.listen(PORT, () => {
  console.log(`FuzzNet Labs server running at http://localhost:${PORT}`);
});
