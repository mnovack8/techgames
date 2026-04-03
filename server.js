const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8090;

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

// ==================== BOT AI ====================
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function botPickNode(ps, animalOrder) {
  // Score each empty node by how many new paths it completes for untested animals
  let best = -1, bestScore = -1;
  for (let n = 0; n < 11; n++) {
    if (ps.nodes[n]) continue;
    // Simulate placing
    ps.nodes[n] = true;
    let score = 0;
    for (let a = 0; a < 5; a++) {
      if (!ps.tested[a] && findPaths(ps, animalOrder, a).length > 0) score++;
    }
    ps.nodes[n] = false;
    if (score > bestScore) { bestScore = score; best = n; }
  }
  // Fallback: first empty node
  if (best === -1) { for (let n = 0; n < 11; n++) if (!ps.nodes[n]) { best = n; break; } }
  return best;
}

function botPickDataNode(ps, animalOrder) {
  // Place data on nodes that are on the best testable path
  const pathData = [];
  for (let a = 0; a < 5; a++) {
    if (ps.tested[a]) continue;
    const paths = findPaths(ps, animalOrder, a);
    for (const p of paths) {
      const sum = p.reduce((s, n) => s + ps.data[n], 0);
      pathData.push({ path: p, sum, animal: a });
    }
  }
  pathData.sort((a, b) => b.sum - a.sum); // best path first
  // Find a node on the best path with room for data
  for (const pd of pathData) {
    // Prefer nodes with lowest data on this path (avoid maxing out)
    const sorted = [...pd.path].sort((a, b) => ps.data[a] - ps.data[b]);
    for (const n of sorted) {
      if (ps.data[n] < 3) return n;
    }
  }
  // Fallback: any node with room
  for (let n = 0; n < 11; n++) if (ps.nodes[n] && ps.data[n] < 3) return n;
  return -1;
}

function botPickTestAnimal(ps, animalOrder, scoreboard) {
  // Prefer animals not yet on scoreboard (5pt first place), considering player awareness
  let best = -1, bestScore = -1;
  for (let a = 0; a < 5; a++) {
    if (ps.tested[a]) continue;
    const paths = findPaths(ps, animalOrder, a);
    if (paths.length === 0) continue;
    const bestPathData = Math.max(...paths.map(p => p.reduce((s, n) => s + ps.data[n], 0)));
    // Bonus for animals not yet scored by anyone (first place available)
    const slotBonus = scoreboard[a].length === 0 ? 10 : 0;
    const score = bestPathData + slotBonus;
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return best;
}

function botPickBestPath(ps, animalOrder, animal) {
  const paths = findPaths(ps, animalOrder, animal);
  if (paths.length === 0) return null;
  return paths.reduce((best, p) => {
    const sum = p.reduce((s, n) => s + ps.data[n], 0);
    const bestSum = best.reduce((s, n) => s + ps.data[n], 0);
    return sum > bestSum ? p : best;
  });
}

function botShouldUseClean(ps, diceSum, dataOnPath) {
  const gap = TEST_THRESHOLD - (diceSum + dataOnPath);
  // Only use clean if penalty is low and gap is small
  return gap > 0 && gap <= 4 && ps.cleanUses < 2;
}

function botPickOverfitEdge(overfitEdges, ps) {
  // Pick the edge whose destination node has the most alternative incoming edges (least damaging)
  if (overfitEdges.length === 1) return overfitEdges[0].key;
  // Simple: pick last edge in the list (tends to be less critical)
  return overfitEdges[overfitEdges.length - 1].key;
}

function botPickBackprop(ps, testPath) {
  const pathSet = new Set(testPath);
  let bestMove = null, bestScore = -1;
  for (let src = 0; src < 11; src++) {
    if (!ps.nodes[src] || ps.data[src] <= 0) continue;
    for (let dst = 0; dst < 11; dst++) {
      if (src === dst || !ps.nodes[dst] || ps.data[dst] >= 3) continue;
      if (!pathSet.has(src) && !pathSet.has(dst)) continue;
      // Prefer moving data TO path nodes, and FROM non-path nodes
      let score = 0;
      if (pathSet.has(dst)) score += 2;
      if (!pathSet.has(src)) score += 1;
      if (score > bestScore) { bestScore = score; bestMove = { src, dst }; }
    }
  }
  return bestMove;
}

async function executeBotTurn(room) {
  const s = room.state;
  const botIdx = s.currentPlayer;
  if (!room.players[botIdx].isBot || s.gameOver) return;

  while (s.actionsLeft > 0 && !s.gameOver && s.currentPlayer === botIdx) {
    const ps = s.players[botIdx];
    const action = decideBotAction(ps, s);

    await delay(1200);
    if (s.gameOver || s.currentPlayer !== botIdx) break;

    switch (action) {
      case 'design': {
        processAction(room, botIdx, { action: 'start_design' });
        broadcastState(room);
        await delay(800);
        const nodeId = botPickNode(ps, s.animalOrder);
        if (nodeId >= 0) {
          processAction(room, botIdx, { action: 'place_node', nodeId });
          broadcastState(room);
        }
        break;
      }
      case 'train': {
        processAction(room, botIdx, { action: 'start_train' });
        broadcastState(room);
        for (let t = 0; t < 2; t++) {
          await delay(800);
          if (s.phase === 'train_overfit') {
            const key = botPickOverfitEdge(s.overfitEdges, ps);
            processAction(room, botIdx, { action: 'select_overfit_edge', edgeKey: key });
            broadcastState(room);
            await delay(600);
          }
          if (s.phase !== 'train1' && s.phase !== 'train2') break;
          const nodeId = botPickDataNode(ps, s.animalOrder);
          if (nodeId < 0) break;
          processAction(room, botIdx, { action: 'place_data', nodeId });
          broadcastState(room);
        }
        // Handle trailing overfit
        if (s.phase === 'train_overfit') {
          await delay(800);
          const key = botPickOverfitEdge(s.overfitEdges, ps);
          processAction(room, botIdx, { action: 'select_overfit_edge', edgeKey: key });
          broadcastState(room);
        }
        break;
      }
      case 'test': {
        processAction(room, botIdx, { action: 'start_test' });
        broadcastState(room);
        await delay(800);
        const animal = botPickTestAnimal(ps, s.animalOrder, s.scoreboard);
        if (animal < 0) break;
        processAction(room, botIdx, { action: 'select_animal', animalIdx: animal });
        broadcastState(room);
        // Handle path selection if needed
        while (['test_path_l1', 'test_path_l2', 'test_path_l3'].includes(s.phase)) {
          await delay(600);
          const bestPath = botPickBestPath(ps, s.animalOrder, animal);
          if (!bestPath || !s.pathClickable || s.pathClickable.length === 0) break;
          // Pick the node from pathClickable that matches our best path
          let pick = s.pathClickable[0];
          for (const n of s.pathClickable) {
            if (bestPath.includes(n)) { pick = n; break; }
          }
          processAction(room, botIdx, { action: 'select_path_node', nodeId: pick });
          broadcastState(room);
        }
        if (s.phase === 'test_roll') {
          await delay(1000);
          processAction(room, botIdx, { action: 'roll_dice' });
          broadcastState(room);
          await delay(1200);
          // Evaluate result
          const diceSum = s.dice[0] + s.dice[1] + s.dice[2];
          const dataOnPath = s.testPath.reduce((sum, n) => sum + ps.data[n], 0);
          const total = diceSum + dataOnPath;
          // Try clean data if close
          if (total < TEST_THRESHOLD && botShouldUseClean(ps, diceSum, dataOnPath)) {
            // Reroll the lowest die
            const minVal = Math.min(...s.dice);
            const minIdx = s.dice.indexOf(minVal);
            processAction(room, botIdx, { action: 'clean_reroll', diceIndices: [minIdx] });
            broadcastState(room);
            await delay(1000);
          }
          // Check again after potential clean
          const finalSum = s.dice[0] + s.dice[1] + s.dice[2] + dataOnPath;
          if (finalSum >= TEST_THRESHOLD) {
            processAction(room, botIdx, { action: 'resolve_success' });
          } else {
            processAction(room, botIdx, { action: 'resolve_fail' });
          }
          broadcastState(room);
          // Handle backprop phases
          if (s.phase === 'backprop_source') {
            await delay(800);
            const move = botPickBackprop(ps, s.testPath);
            if (move) {
              processAction(room, botIdx, { action: 'backprop_select_source', nodeId: move.src });
              broadcastState(room);
              await delay(600);
              processAction(room, botIdx, { action: 'backprop_select_dest', nodeId: move.dst });
              broadcastState(room);
            }
          }
          if (s.phase === 'backprop_overfit') {
            await delay(600);
            const key = botPickOverfitEdge(s.overfitEdges, ps);
            processAction(room, botIdx, { action: 'backprop_select_overfit', edgeKey: key });
            broadcastState(room);
          }
        }
        break;
      }
      default: {
        processAction(room, botIdx, { action: 'end_turn' });
        broadcastState(room);
        break;
      }
    }
  }
}

function decideBotAction(ps, s) {
  // 1. Can test with good odds?
  for (let a = 0; a < 5; a++) {
    if (ps.tested[a]) continue;
    const paths = findPaths(ps, s.animalOrder, a);
    for (const p of paths) {
      const dataSum = p.reduce((sum, n) => sum + ps.data[n], 0);
      if (dataSum >= 7) return 'test'; // 10.5 avg dice + 7 data = 17.5, close enough
    }
  }
  // 2. Can train and have paths that need data?
  if (countDataSlots(ps) >= 2) {
    // Check if we have any paths that could benefit from more data
    for (let a = 0; a < 5; a++) {
      if (ps.tested[a]) continue;
      if (findPaths(ps, s.animalOrder, a).length > 0) return 'train';
    }
    // Also train if we have nodes but no complete paths yet (boost future paths)
    let hasNodes = false;
    for (let i = 0; i < 11; i++) if (ps.nodes[i]) { hasNodes = true; break; }
    if (hasNodes) return 'train';
  }
  // 3. Design if we need more paths
  if (hasNodeSlots(ps)) {
    // Check if we're missing paths for untested animals
    let needsPaths = false;
    for (let a = 0; a < 5; a++) {
      if (!ps.tested[a] && findPaths(ps, s.animalOrder, a).length === 0) { needsPaths = true; break; }
    }
    if (needsPaths) return 'design';
    // Also design if we have few nodes placed
    let nodeCount = 0;
    for (let i = 0; i < 11; i++) if (ps.nodes[i]) nodeCount++;
    if (nodeCount < 6) return 'design';
  }
  // 4. Train as fallback if possible
  if (countDataSlots(ps) >= 2) return 'train';
  // 5. Test even with lower odds
  if (canTestAny(ps, s.animalOrder)) return 'test';
  // 6. Design as last resort
  if (hasNodeSlots(ps)) return 'design';
  return 'end_turn';
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
      color: p.color, name: p.name, connected: p.connected, isHost: i === room.hostIdx, isBot: !!p.isBot,
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
        isBot: !!room.players[i].isBot,
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

  // Trigger bot turn if next player is a bot
  if (room.players[s.currentPlayer].isBot) {
    broadcastState(room);
    executeBotTurn(room);
  }
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
        gameType: msg.gameType === 'byteclub' ? 'byteclub' : 'fuzznet',
        players: [{ color, name: COLOR_INFO[color].name, ws, connected: true }],
        started: false, state: null, bcState: null,
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
      if (room.players.length >= 4 || room.players.some(p => p.isBot)) return send(ws, {type:'room_info', exists:true, full:true});
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
      if (room.players.length >= 4 || room.players.some(p => p.isBot)) return send(ws, {type:'error',msg:'Room is full'});
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

    case 'toggle_bot': {
      const info = wsData.get(ws);
      if (!info) return send(ws, {type:'error',msg:'Not in a room'});
      const room = rooms.get(info.roomCode);
      if (!room || room.started) return;
      if (info.playerIdx !== room.hostIdx) return send(ws, {type:'error',msg:'Only host can add bot'});
      // Count humans
      const humans = room.players.filter(p => !p.isBot).length;
      if (humans > 1) return send(ws, {type:'error',msg:'Bot only available for single player'});
      // Toggle: remove existing bot or add one
      const botIdx = room.players.findIndex(p => p.isBot);
      if (botIdx !== -1) {
        room.players.splice(botIdx, 1);
        // Fix wsData indices
        for (const [w, d] of wsData.entries()) {
          if (d.roomCode === room.code && d.playerIdx > botIdx) d.playerIdx--;
        }
      } else {
        const taken = room.players.map(p => p.color);
        const available = Object.keys(COLOR_INFO).filter(c => !taken.includes(c));
        if (available.length === 0) return;
        const botColor = available[Math.floor(Math.random() * available.length)];
        room.players.push({ color: botColor, name: COLOR_INFO[botColor].name + ' (Bot)', ws: null, connected: true, isBot: true });
      }
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
      if (room.gameType === 'byteclub') {
        initBCGame(room);
        for (const p of room.players) if (p.ws) send(p.ws, { type: 'bc_game_started' });
        bcBroadcastState(room);
      } else {
        room.state = createGameState(room.players.length);
        room.state.players[0].firstTurnDone = true;
        for (const p of room.players) if (p.ws) send(p.ws, { type: 'game_started' });
        broadcastState(room);
        if (room.players[0].isBot) executeBotTurn(room);
      }
      break;
    }

    case 'game_action': {
      const info = wsData.get(ws);
      if (!info) return send(ws, {type:'error',msg:'Not in a room'});
      const room = rooms.get(info.roomCode);
      if (!room || !room.started) return send(ws, {type:'error',msg:'Game not started'});
      if (room.gameType === 'byteclub') {
        bcHandleAction(room, info.playerIdx, msg);
      } else {
        const err = processAction(room, info.playerIdx, msg);
        if (err) return send(ws, {type:'error',msg:err});
        broadcastState(room);
      }
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
    if (room.gameType === 'byteclub') {
      if (room.bcState && room.bcState.currentPlayer === info.playerIdx && room.bcState.phase !== 'game_over') {
        bcEndTurn(room);
      } else if (room.bcState) {
        bcBroadcastState(room);
      }
    } else {
      if (room.state.currentPlayer === info.playerIdx && !room.state.gameOver) {
        room.state.actionsLeft = 0;
        room.state.phase = 'idle';
        nextTurn(room);
        broadcastState(room);
      }
    }
    if (room.players.every(p => !p.connected)) rooms.delete(room.code);
  }
}

// ==================== BYTE CLUB BOT ====================

function bcBotPickCard(room, botIdx) {
  const gs = room.bcState;
  const pl = gs.players[botIdx];
  const playable = pl.hand.filter(c => c.type !== 'data_flag' && c.type !== 'action_obj' && c.type !== 'weaponize');
  if (playable.length === 0) return null;
  // Pick a random playable card
  return playable[Math.floor(Math.random() * playable.length)];
}

function bcBotDiscard(room, botIdx) {
  const gs = room.bcState;
  const pl = gs.players[botIdx];
  const playedTypes = new Set(pl.played.map(c => c.type));

  // Prefer discarding: already-played types first, then any non-special
  const discard = pl.hand.find(c => c.cat !== 'special' && playedTypes.has(c.type))
    || pl.hand.find(c => c.type !== 'data_flag')
    || pl.hand[0];

  if (discard) bcHandleAction(room, botIdx, { type: 'game_action', action: 'discard_card', cardId: discard.id });
}

// (Removed: bcBotSchedulePendingReveals — reveal path replaced by dataflag reveal)

// bcBotContinueTurn: resume bot's existing turn after an async interruption (weaponize window,
// respond window, etc.). Unlike executeBCBotTurn, it does NOT play another card — it only
// handles the current sub-phase and then ends the turn.
async function bcBotContinueTurn(room, botIdx) {
  const gs = room.bcState;
  if (!room.players[botIdx]?.isBot || gs.phase === 'game_over' || gs.currentPlayer !== botIdx) return;
  if (room._bcBotRunning) return;
  room._bcBotRunning = true;
  await delay(700);
  await bcBotHandleEffect(room, botIdx);
  if (gs.winner >= 0 || gs.phase === 'game_over') { room._bcBotRunning = false; return; }
  await delay(700);
  if (gs.phase === 'play' && gs.currentPlayer === botIdx && gs.winner < 0) {
    bcHandleAction(room, botIdx, { type: 'game_action', action: 'end_play_phase' });
  }
  await delay(600);
  if (gs.phase === 'discard' && gs.currentPlayer === botIdx) bcBotDiscard(room, botIdx);
  room._bcBotRunning = false;
}

async function executeBCBotTurn(room) {
  const gs = room.bcState;
  const botIdx = gs.currentPlayer;
  if (!room.players[botIdx]?.isBot || gs.phase === 'game_over') return;
  // Guard against concurrent bot turn invocations
  if (room._bcBotRunning) return;
  room._bcBotRunning = true;

  await delay(1200); // pause so human can see whose turn it is

  // Play cards loop — play at most one new-type card per turn
  if (gs.phase === 'play' && gs.currentPlayer === botIdx && gs.winner < 0) {
    const card = bcBotPickCard(room, botIdx);
    if (card && !gs.recoverActive) {
      await delay(800);
      if (gs.phase !== 'play' || gs.currentPlayer !== botIdx || gs.winner >= 0) return;
      bcHandleAction(room, botIdx, { type: 'game_action', action: 'play_card', cardId: card.id });

      // Handle sub-phase from card effect
      await delay(700);
      await bcBotHandleEffect(room, botIdx);
      if (gs.winner >= 0 || gs.phase === 'game_over') return;
    }
  }

  // End turn if still in play phase
  await delay(700);
  if ((gs.phase === 'play') && gs.currentPlayer === botIdx && gs.winner < 0) {
    bcHandleAction(room, botIdx, { type: 'game_action', action: 'end_play_phase' });
  }

  // Handle discard if triggered
  await delay(600);
  if (gs.phase === 'discard' && gs.currentPlayer === botIdx) {
    bcBotDiscard(room, botIdx);
  }
  room._bcBotRunning = false;
}

async function bcBotHandleEffect(room, botIdx) {
  const gs = room.bcState;
  if (gs.winner >= 0) return;

  // Govern: view first opponent then dismiss
  if (gs.phase === 'govern_select' && gs.governViewer === botIdx) {
    await delay(600);
    const tgt = gs.players.findIndex((_, i) => i !== botIdx && room.players[i].connected);
    if (tgt !== -1) bcHandleAction(room, botIdx, { type: 'game_action', action: 'govern_select', targetIdx: tgt });
    await delay(1200);
    if (gs.phase === 'govern_viewing' && gs.governViewer === botIdx) {
      bcHandleAction(room, botIdx, { type: 'game_action', action: 'govern_done' });
    }
  }

  // Identify: choose dataflag or swap
  if (gs.phase === 'identify_choosing' && gs.identifyState?.chooser === botIdx) {
    await delay(600);
    const botDefendPlayed = gs.players[botIdx].played.filter(c => c.cat === 'defend');
    const anyOppAhead = gs.players.some((opl, i) => i !== botIdx &&
      opl.played.filter(c => c.cat === 'defend').length > botDefendPlayed.length);
    const choice = (anyOppAhead && botDefendPlayed.length > 0) ? 'swap' : 'dataflag';
    bcHandleAction(room, botIdx, { type: 'game_action', action: 'identify_choice', choice });
  }

  // Identify swap: bot picks its least-needed defend card
  if (gs.phase === 'identify_swap_my' && gs.identifyState?.chooser === botIdx) {
    await delay(700);
    const botDefendPlayed = gs.players[botIdx].played.filter(c => c.cat === 'defend');
    if (botDefendPlayed.length > 0) {
      const playedTypes = gs.players[botIdx].played.map(c => c.type);
      const dup = botDefendPlayed.find(c => playedTypes.filter(t => t === c.type).length > 1);
      const card = dup || botDefendPlayed[0];
      bcHandleAction(room, botIdx, { type: 'game_action', action: 'identify_swap_my', cardId: card.id });
    }
  }

  if (gs.phase === 'identify_swap_target' && gs.identifyState?.chooser === botIdx) {
    await delay(600);
    const tgt = gs.players.findIndex((_, i) => i !== botIdx && !bcIsProtected(gs, i) &&
      gs.players[i].played.some(c => c.cat === 'defend'));
    if (tgt !== -1) {
      bcHandleAction(room, botIdx, { type: 'game_action', action: 'identify_swap_target', targetIdx: tgt });
    }
  }

  if (gs.phase === 'identify_swap_their' && gs.identifyState?.chooser === botIdx) {
    await delay(600);
    const tgt = gs.identifyState.swapTargetIdx;
    if (tgt >= 0) {
      const theirCards = gs.players[tgt].played.filter(c => c.cat === 'defend');
      if (theirCards.length > 0) {
        bcHandleAction(room, botIdx, { type: 'game_action', action: 'identify_swap_their', cardId: theirCards[0].id });
      }
    }
  }

  // Generic targeted attack: pick a target
  const attackTargetPhases = ['attack_c2_target','attack_recon_target','attack_exploit_target','attack_install_target','attack_delivery_target'];
  if (attackTargetPhases.includes(gs.phase) && gs.attackState?.attacker === botIdx) {
    await delay(700);
    const tgt = gs.players.findIndex((_, i) => i !== botIdx && !bcIsProtected(gs, i) && room.players[i].connected);
    if (tgt !== -1) {
      bcHandleAction(room, botIdx, { type: 'game_action', action: 'attack_select_target', targetIdx: tgt });
    } else {
      gs.attackState = null; gs.phase = 'play'; bcBroadcastState(room);
    }
  }

  // Recon swap steps
  if (gs.phase === 'attack_recon_swap_my' && gs.attackState?.attacker === botIdx) {
    await delay(600);
    const myAttack = gs.players[botIdx].played.filter(c => c.cat === 'attack');
    if (myAttack.length > 0) {
      bcHandleAction(room, botIdx, { type: 'game_action', action: 'recon_swap_my', cardId: myAttack[0].id });
    }
  }

  if (gs.phase === 'attack_recon_swap_their' && gs.attackState?.attacker === botIdx) {
    await delay(600);
    const tgt = gs.attackState.target;
    const theirAttack = gs.players[tgt].played.filter(c => c.cat === 'attack');
    if (theirAttack.length > 0) {
      bcHandleAction(room, botIdx, { type: 'game_action', action: 'recon_swap_their', cardId: theirAttack[0].id });
    }
  }

  if (gs.phase === 'attack_recon_look' && gs.attackState?.attacker === botIdx) {
    await delay(1200);
    if (gs.phase === 'attack_recon_look' && gs.attackState?.attacker === botIdx) {
      bcHandleAction(room, botIdx, { type: 'game_action', action: 'recon_look_done' });
    }
  }

  // Detect: confirm current order (no reorder)
  if (gs.phase === 'detect_view' && gs.detectView?.viewer === botIdx) {
    await delay(800);
    const order = (gs.detectView?.cards || []).map(c => c.id);
    bcHandleAction(room, botIdx, { type: 'game_action', action: 'detect_reorder', order });
  }
}

// ==================== BYTE CLUB ====================

const BC_ATTACK_TYPES = [
  { id: 'recon',     name: 'Reconnaissance',    emoji: '🔍', chain: 1 },
  { id: 'weaponize', name: 'Weaponization',      emoji: '⚒️',  chain: 2 },
  { id: 'deliver',   name: 'Delivery',           emoji: '📨', chain: 3 },
  { id: 'exploit',   name: 'Exploitation',       emoji: '💥', chain: 4 },
  { id: 'install',   name: 'Installation',       emoji: '⚙️',  chain: 5 },
  { id: 'c2',        name: 'Command & Control',  emoji: '📡', chain: 6 },
];

const BC_DEFEND_TYPES = [
  { id: 'identify', name: 'Identify', emoji: '🔎', nist: 1 },
  { id: 'protect',  name: 'Protect',  emoji: '🛡️',  nist: 2 },
  { id: 'detect',   name: 'Detect',   emoji: '👁️',  nist: 3 },
  { id: 'respond',  name: 'Respond',  emoji: '🚨', nist: 4 },
  { id: 'recover',  name: 'Recover',  emoji: '🔄', nist: 5 },
];

// 55 action cards (5 per type × 5 defend types + 6 attack types)
// Card names match the actual card type names from the game
const BC_ACTION_CARDS = [
  { id:1,  cat:'defend', type:'identify', name:'Identify',       desc:'Reveal who holds the Data Flag to all players, OR swap one of your played Defend cards with another player\'s.' },
  { id:2,  cat:'defend', type:'identify', name:'Identify',       desc:'Reveal who holds the Data Flag to all players, OR swap one of your played Defend cards with another player\'s.' },
  { id:3,  cat:'defend', type:'identify', name:'Identify',       desc:'Reveal who holds the Data Flag to all players, OR swap one of your played Defend cards with another player\'s.' },
  { id:4,  cat:'defend', type:'identify', name:'Identify',       desc:'Reveal who holds the Data Flag to all players, OR swap one of your played Defend cards with another player\'s.' },
  { id:5,  cat:'defend', type:'identify', name:'Identify',       desc:'Reveal who holds the Data Flag to all players, OR swap one of your played Defend cards with another player\'s.' },
  { id:6,  cat:'defend', type:'protect',  name:'Protect',        desc:'You cannot be targeted by Attack card effects until the start of your next turn.' },
  { id:7,  cat:'defend', type:'protect',  name:'Protect',        desc:'You cannot be targeted by Attack card effects until the start of your next turn.' },
  { id:8,  cat:'defend', type:'protect',  name:'Protect',        desc:'You cannot be targeted by Attack card effects until the start of your next turn.' },
  { id:9,  cat:'defend', type:'protect',  name:'Protect',        desc:'You cannot be targeted by Attack card effects until the start of your next turn.' },
  { id:10, cat:'defend', type:'protect',  name:'Protect',        desc:'You cannot be targeted by Attack card effects until the start of your next turn.' },
  { id:11, cat:'defend', type:'detect',   name:'Detect',         desc:'View the top 5 cards of the deck, reorder them as you choose, then return them.' },
  { id:12, cat:'defend', type:'detect',   name:'Detect',         desc:'View the top 5 cards of the deck, reorder them as you choose, then return them.' },
  { id:13, cat:'defend', type:'detect',   name:'Detect',         desc:'View the top 5 cards of the deck, reorder them as you choose, then return them.' },
  { id:14, cat:'defend', type:'detect',   name:'Detect',         desc:'View the top 5 cards of the deck, reorder them as you choose, then return them.' },
  { id:15, cat:'defend', type:'detect',   name:'Detect',         desc:'View the top 5 cards of the deck, reorder them as you choose, then return them.' },
  { id:16, cat:'defend', type:'respond',  name:'Respond',        desc:'Play out of turn when targeted by an Attack — cancels the Attack effect. Goes to your played area.' },
  { id:17, cat:'defend', type:'respond',  name:'Respond',        desc:'Play out of turn when targeted by an Attack — cancels the Attack effect. Goes to your played area.' },
  { id:18, cat:'defend', type:'respond',  name:'Respond',        desc:'Play out of turn when targeted by an Attack — cancels the Attack effect. Goes to your played area.' },
  { id:19, cat:'defend', type:'respond',  name:'Respond',        desc:'Play out of turn when targeted by an Attack — cancels the Attack effect. Goes to your played area.' },
  { id:20, cat:'defend', type:'respond',  name:'Respond',        desc:'Play out of turn when targeted by an Attack — cancels the Attack effect. Goes to your played area.' },
  { id:21, cat:'defend', type:'recover',  name:'Recover',        desc:'Draw cards until you have 5 in hand. Skip your end-of-turn draw.' },
  { id:22, cat:'defend', type:'recover',  name:'Recover',        desc:'Draw cards until you have 5 in hand. Skip your end-of-turn draw.' },
  { id:23, cat:'defend', type:'recover',  name:'Recover',        desc:'Draw cards until you have 5 in hand. Skip your end-of-turn draw.' },
  { id:24, cat:'defend', type:'recover',  name:'Recover',        desc:'Draw cards until you have 5 in hand. Skip your end-of-turn draw.' },
  { id:25, cat:'defend', type:'recover',  name:'Recover',        desc:'Draw cards until you have 5 in hand. Skip your end-of-turn draw.' },
  { id:26, cat:'attack', type:'recon',    name:'Reconnaissance', desc:'Look at one player\'s hand (info only), OR swap one of your played Attack cards with another player\'s played Attack card.' },
  { id:27, cat:'attack', type:'recon',    name:'Reconnaissance', desc:'Look at one player\'s hand (info only), OR swap one of your played Attack cards with another player\'s played Attack card.' },
  { id:28, cat:'attack', type:'recon',    name:'Reconnaissance', desc:'Look at one player\'s hand (info only), OR swap one of your played Attack cards with another player\'s played Attack card.' },
  { id:29, cat:'attack', type:'recon',    name:'Reconnaissance', desc:'Look at one player\'s hand (info only), OR swap one of your played Attack cards with another player\'s played Attack card.' },
  { id:30, cat:'attack', type:'recon',    name:'Reconnaissance', desc:'Look at one player\'s hand (info only), OR swap one of your played Attack cards with another player\'s played Attack card.' },
  { id:31, cat:'attack', type:'weaponize',name:'Weaponization',  desc:'Play out of turn — cancel the effect of another player\'s Defend card.' },
  { id:32, cat:'attack', type:'weaponize',name:'Weaponization',  desc:'Play out of turn — cancel the effect of another player\'s Defend card.' },
  { id:33, cat:'attack', type:'weaponize',name:'Weaponization',  desc:'Play out of turn — cancel the effect of another player\'s Defend card.' },
  { id:34, cat:'attack', type:'weaponize',name:'Weaponization',  desc:'Play out of turn — cancel the effect of another player\'s Defend card.' },
  { id:35, cat:'attack', type:'weaponize',name:'Weaponization',  desc:'Play out of turn — cancel the effect of another player\'s Defend card.' },
  { id:36, cat:'attack', type:'deliver',  name:'Delivery',       desc:'Swap up to 2 of your played cards with other players\' played cards (may target different players).' },
  { id:37, cat:'attack', type:'deliver',  name:'Delivery',       desc:'Swap up to 2 of your played cards with other players\' played cards (may target different players).' },
  { id:38, cat:'attack', type:'deliver',  name:'Delivery',       desc:'Swap up to 2 of your played cards with other players\' played cards (may target different players).' },
  { id:39, cat:'attack', type:'deliver',  name:'Delivery',       desc:'Swap up to 2 of your played cards with other players\' played cards (may target different players).' },
  { id:40, cat:'attack', type:'deliver',  name:'Delivery',       desc:'Swap up to 2 of your played cards with other players\' played cards (may target different players).' },
  { id:41, cat:'attack', type:'exploit',  name:'Exploitation',   desc:'Pick a target — take one card at random (blind) from their hand. Respond cancels.' },
  { id:42, cat:'attack', type:'exploit',  name:'Exploitation',   desc:'Pick a target — take one card at random (blind) from their hand. Respond cancels.' },
  { id:43, cat:'attack', type:'exploit',  name:'Exploitation',   desc:'Pick a target — take one card at random (blind) from their hand. Respond cancels.' },
  { id:44, cat:'attack', type:'exploit',  name:'Exploitation',   desc:'Pick a target — take one card at random (blind) from their hand. Respond cancels.' },
  { id:45, cat:'attack', type:'exploit',  name:'Exploitation',   desc:'Pick a target — take one card at random (blind) from their hand. Respond cancels.' },
  { id:46, cat:'attack', type:'install',  name:'Installation',   desc:'Pick a target — they cannot play Defend cards until the end of their next turn. Respond cancels.' },
  { id:47, cat:'attack', type:'install',  name:'Installation',   desc:'Pick a target — they cannot play Defend cards until the end of their next turn. Respond cancels.' },
  { id:48, cat:'attack', type:'install',  name:'Installation',   desc:'Pick a target — they cannot play Defend cards until the end of their next turn. Respond cancels.' },
  { id:49, cat:'attack', type:'install',  name:'Installation',   desc:'Pick a target — they cannot play Defend cards until the end of their next turn. Respond cancels.' },
  { id:50, cat:'attack', type:'install',  name:'Installation',   desc:'Pick a target — they cannot play Defend cards until the end of their next turn. Respond cancels.' },
  { id:51, cat:'attack', type:'c2',       name:'C2',             desc:'Pick a target. If they hold the Data Flag, they must give it to you. Otherwise, pick any card from their revealed hand.' },
  { id:52, cat:'attack', type:'c2',       name:'C2',             desc:'Pick a target. If they hold the Data Flag, they must give it to you. Otherwise, pick any card from their revealed hand.' },
  { id:53, cat:'attack', type:'c2',       name:'C2',             desc:'Pick a target. If they hold the Data Flag, they must give it to you. Otherwise, pick any card from their revealed hand.' },
  { id:54, cat:'attack', type:'c2',       name:'C2',             desc:'Pick a target. If they hold the Data Flag, they must give it to you. Otherwise, pick any card from their revealed hand.' },
  { id:55, cat:'attack', type:'c2',       name:'C2',             desc:'Pick a target. If they hold the Data Flag, they must give it to you. Otherwise, pick any card from their revealed hand.' },
];

const BC_GOVERN_CARD     = { id:'govern',    cat:'defend', type:'govern',     name:'Govern',              desc:'Privately look at every player\'s hand and take one card from each. Then give one card back to each player (can be any card from your hand). Weaponize cannot cancel this. (Earned by collecting all NIST defend types)' };
const BC_ACTION_OBJ_CARD = { id:'action_obj',cat:'attack', type:'action_obj', name:'Action Objectives',   desc:'Play at any time — the player holding the Data Flag must give it to you. Respond cannot cancel this card. (Earned by completing the Kill Chain)' };

function bcShuffle(arr) {
  const a = arr.map(c => ({ ...c }));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function bcInsert(arr, card) {
  const pos = Math.floor(Math.random() * (arr.length + 1));
  const a = [...arr];
  a.splice(pos, 0, { ...card });
  return a;
}

function bcBuildDeck() {
  const shuffled = bcShuffle(BC_ACTION_CARDS);
  const sz = Math.floor(shuffled.length / 3);
  let A = shuffled.slice(0, sz);
  let B = shuffled.slice(sz, sz * 2);
  let C = shuffled.slice(sz * 2);
  // Data Flag into A, A on top of B
  A = bcInsert(A, { id:'data_flag', cat:'special', type:'data_flag', name:'Data Flag', desc:'Hold this when Times Up is revealed to win.' });
  // Times Up into C, C on bottom
  C = bcInsert(C, { id:'times_up', cat:'special', type:'times_up', name:'Times Up', desc:'When revealed, players holding the Data Flag can win.' });
  return [...A, ...B, ...C];
}

function initBCGame(room) {
  let deck = bcBuildDeck();
  const players = room.players.map(() => {
    const hand = deck.splice(0, 4);
    return { hand, played: [] };
  });
  room.bcState = {
    deck, players,
    currentPlayer: 0,
    phase: 'play',
    timesUpRevealed: false,
    governHolder: -1,
    actionObjHolder: -1,
    actionObjActive: false,
    actionObjBlockedPlayer: -1,
    governState: null,        // multi-step Govern resolution
    // Card effects
    protectedUntilTurn: {},   // { playerIdx: true } — Protect card
    detectView: null,          // { viewer, cards } — Detect card
    identifyState: null,       // multi-step Identify resolution
    recoverActive: false,      // Recover: skip end-of-turn draw, lock play
    attackState: null,         // active attack effect: { type, attacker, card, target, ... }
    weaponizeWindow: null,     // { defender, card, targetPhase } — Weaponize cancel window
    installBlocked: {},        // { playerIdx: true } — Installation block (cleared at start of their next turn)
    pendingError: null,        // { playerIdx, message } — one-shot error toast sent to a specific player
    log: [],
    winner: -1,
    winCondition: 0,
    turnNumber: 1,
  };
}

function bcIsProtected(gs, playerIdx) {
  return !!gs.protectedUntilTurn[playerIdx];
}

function bcLog(room, msg) {
  room.bcState.log.unshift(msg);
  if (room.bcState.log.length > 30) room.bcState.log.pop();
}

function bcHasAllDefend(played) {
  const types = new Set(played.filter(c => c.cat === 'defend').map(c => c.type));
  return BC_DEFEND_TYPES.every(t => types.has(t.id));
}

function bcHasAllAttack(played) {
  const types = new Set(played.filter(c => c.cat === 'attack').map(c => c.type));
  return BC_ATTACK_TYPES.every(t => types.has(t.id));
}

function bcCheckSpecialAcquisition(room) {
  const gs = room.bcState;
  for (let i = 0; i < gs.players.length; i++) {
    const pl = gs.players[i];
    if (gs.governHolder === -1 && bcHasAllDefend(pl.played)) {
      gs.governHolder = i;
      pl.hand.push({ ...BC_GOVERN_CARD });
      bcLog(room, `🏛️ ${room.players[i].name} collected all NIST defend types — receives the Govern card!`);
    }
    if (gs.actionObjHolder === -1 && bcHasAllAttack(pl.played)) {
      gs.actionObjHolder = i;
      pl.hand.push({ ...BC_ACTION_OBJ_CARD });
      bcLog(room, `🎯 ${room.players[i].name} completed the Kill Chain — receives the Action Objectives card!`);
    }
  }
}

function bcCheckWin(room, idx) {
  const gs = room.bcState;
  const pl = gs.players[idx];
  // Win 1: hold Data Flag + Times Up revealed
  if (gs.timesUpRevealed && pl.hand.some(c => c.type === 'data_flag')) return 1;
  // Win 2: 1 of every attack type (inc. action_obj) AND every defend type (inc. govern) in front
  const types = new Set(pl.played.map(c => c.type));
  const needAttack = [...BC_ATTACK_TYPES.map(t => t.id), 'action_obj'];
  const needDefend = [...BC_DEFEND_TYPES.map(t => t.id), 'govern'];
  if (needAttack.every(t => types.has(t)) && needDefend.every(t => types.has(t))) return 2;
  return 0;
}

function bcBroadcastState(room) {
  const gs = room.bcState;
  const protectedPlayers = Object.keys(gs.protectedUntilTurn)
    .map(Number)
    .filter(idx => bcIsProtected(gs, idx));

  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (!p.connected || !p.ws) continue;
    const pl = gs.players[i];
    const isCurrentPlayer = i === gs.currentPlayer;

    // Detect: only the viewer sees the cards
    const detectViewCards = (gs.detectView && gs.detectView.viewer === i)
      ? gs.detectView.cards : null;

    // Identify: build info (same for all players)
    let identifyInfo = null;
    if (gs.identifyState) {
      const id = gs.identifyState;
      identifyInfo = {
        chooser: id.chooser,
        phase: gs.phase,
        // Data Flag reveal result (public — everyone sees)
        dataFlagHolder: id.dataFlagHolder ?? -2,   // -2 = not yet revealed, -1 = in deck
        dataFlagInDeck: id.dataFlagInDeck ?? false,
        // Swap steps (only chooser needs these)
        swapMyCard: (i === id.chooser) ? (id.swapMyCard || null) : null,
        swapTargetIdx: (i === id.chooser) ? (id.swapTargetIdx ?? -1) : -1,
      };
    }

    // Install block
    const installBlockedPlayers = Object.keys(gs.installBlocked).map(Number).filter(idx => gs.installBlocked[idx]);

    // Weaponize window info
    let weaponizeInfo = null;
    if (gs.weaponizeWindow) {
      const ww = gs.weaponizeWindow;
      weaponizeInfo = {
        defender: ww.defender,
        defenderName: room.players[ww.defender].name,
        cardName: ww.card?.name || '',
        iAmDefender: i === ww.defender,
        myWeaponizeCards: i !== ww.defender ? pl.hand.filter(c => c.type === 'weaponize') : [],
      };
    }

    // Attack effect info — target sees the cards being offered; attacker sees target hand during choose
    let attackInfo = null;
    if (gs.attackState) {
      const st = gs.attackState;
      attackInfo = {
        type: st.type,
        attacker: st.attacker,
        target: st.target,
        cardName: st.card?.name || '',
        // Attacker sees target hand during recon look; target sees own hand during c2_give
        targetHand: ((gs.phase === 'attack_recon_look') && i === st.attacker && st.target >= 0)
          ? gs.players[st.target].hand
          : (gs.phase === 'attack_c2_give' && i === st.target)
          ? pl.hand
          : null,
        // Recon swap state
        reconSwapMyCard: (i === st.attacker) ? (st.reconSwapMyCard || null) : null,
        // Delivery swaps in progress
        deliverySwaps: (i === st.attacker) ? (st.swaps || []) : [],
        deliveryPickStep: (i === st.attacker) ? (st.pickStep || null) : null,
        // Target knows they can respond
        iAmTarget: i === st.target,
        iAmAttacker: i === st.attacker,
        myRespondCards: (i === st.target)
          ? pl.hand.filter(c => c.type === 'respond') : [],
      };
    }

    send(p.ws, {
      type: 'bc_state',
      phase: gs.phase,
      currentPlayer: gs.currentPlayer,
      timesUpRevealed: gs.timesUpRevealed,
      actionObjActive: gs.actionObjActive,
      actionObjBlockedPlayer: gs.actionObjBlockedPlayer,
      deckCount: gs.deck.length,
      log: gs.log.slice(0, 20),
      winner: gs.winner,
      winCondition: gs.winCondition,
      turnNumber: gs.turnNumber,
      myIndex: i,
      myHand: pl.hand,
      recoverActive: gs.recoverActive && isCurrentPlayer,
      protectedPlayers,
      installBlockedPlayers,
      iAmInstallBlocked: !!gs.installBlocked[i],
      detectViewCards,
      identifyInfo,
      attackInfo,
      weaponizeInfo,
      governInfo: (gs.governState?.viewer === i)
        ? {
            mode: gs.governState.mode,
            step: gs.governState.step,
            totalTargets: gs.governState.targets.length,
            currentTargetIdx: gs.governState.targets[gs.governState.step] ?? -1,
            allHands: gs.players.map((p, pi) => ({ playerIdx: pi, hand: p.hand })),
            taken: gs.governState.taken,
          }
        : null,
      pendingError: (gs.pendingError?.playerIdx === i) ? gs.pendingError.message : null,
      players: gs.players.map((gpl, pi) => ({
        name: room.players[pi].name,
        color: room.players[pi].color,
        handCount: gpl.hand.length,
        played: gpl.played,
        isBlocked: gs.actionObjActive && gs.actionObjBlockedPlayer === pi,
        isProtected: bcIsProtected(gs, pi),
      })),
    });
  }
  // Clear one-shot error after broadcasting
  gs.pendingError = null;
}

function bcDrawOne(room, playerIdx) {
  const gs = room.bcState;
  if (gs.deck.length === 0) return 'empty';
  const card = gs.deck.shift();
  if (card.type === 'times_up') {
    gs.timesUpRevealed = true;
    bcLog(room, `⏰ Times Up revealed! Any player holding the Data Flag can now win.`);
    for (let i = 0; i < gs.players.length; i++) {
      if (bcCheckWin(room, i) === 1) {
        gs.winner = i; gs.winCondition = 1; gs.phase = 'game_over';
        bcLog(room, `🏆 ${room.players[i].name} wins! (Data Flag + Times Up)`);
        return 'game_over';
      }
    }
    return 'times_up';
  }
  if (card.type === 'data_flag') {
    gs.players[playerIdx].hand.push(card);
    bcLog(room, `🚩 ${room.players[playerIdx].name} drew the Data Flag!`);
    if (gs.timesUpRevealed && bcCheckWin(room, playerIdx) === 1) {
      gs.winner = playerIdx; gs.winCondition = 1; gs.phase = 'game_over';
      bcLog(room, `🏆 ${room.players[playerIdx].name} wins! (Data Flag + Times Up)`);
      return 'game_over';
    }
    return 'ok';
  }
  gs.players[playerIdx].hand.push(card);
  return 'ok';
}

function bcOpenWeaponizeWindow(room, playerIdx, card, resolveCb) {
  const gs = room.bcState;
  const opponents = gs.players.filter((_, i) => i !== playerIdx && room.players[i].connected);
  const anyHasWeaponize = opponents.some((_, oi) => {
    const idx = gs.players.indexOf(opponents[oi]);
    return gs.players[idx < 0 ? room.players.findIndex((_,i2) => i2 !== playerIdx && room.players[i2].connected) : idx]?.hand.some(c => c.type === 'weaponize');
  });
  // Always open window so opponents have a chance (8 second window)
  gs.weaponizeWindow = { defender: playerIdx, card, _resolve: resolveCb };
  gs.phase = 'weaponize_window';
  const ww = gs.weaponizeWindow;
  const timer = setTimeout(() => {
    if (gs.weaponizeWindow === ww) {
      gs.weaponizeWindow = null;
      gs.phase = 'play';  // reset before resolveCb so Protect/Recover land in 'play'; Detect/Identify override it
      resolveCb();
      // Re-trigger bot only for sub-phases (detect_view, identify_choosing) that resolveCb opened.
      // If phase stayed 'play', bcFinishPlay (called inside resolveCb) already scheduled the re-trigger.
      if (room.players[playerIdx]?.isBot && gs.currentPlayer === playerIdx && gs.phase !== 'play') {
        room._bcBotRunning = false;
        setTimeout(() => bcBotContinueTurn(room, playerIdx), 50);
      }
    }
  }, 8000);
  ww._timer = timer;
  bcBroadcastState(room);
  // Bot opponents: auto-play Weaponize if they have it (after 1-2s), else pass after 2s
  gs.players.forEach((opl, i) => {
    if (i === playerIdx || !room.players[i]?.isBot) return;
    const wc = opl.hand.find(c => c.type === 'weaponize');
    setTimeout(() => {
      if (gs.weaponizeWindow !== ww) return;
      if (wc) {
        bcHandleAction(room, i, { type: 'game_action', action: 'play_weaponize', cardId: wc.id });
      }
      // Bot without weaponize just waits — timer will resolve
    }, 900 + Math.random() * 400);
  });
  // If the only opponents are bots and none has Weaponize, fast-resolve the window (1.5s)
  const allOpponentsBots = gs.players.every((_, i) => i === playerIdx || room.players[i]?.isBot);
  const anyBotOpponentHasWeaponize = gs.players.some((opl, i) => i !== playerIdx && room.players[i]?.isBot && opl.hand.some(c => c.type === 'weaponize'));
  if (allOpponentsBots && !anyBotOpponentHasWeaponize) {
    setTimeout(() => {
      if (gs.weaponizeWindow === ww) {
        clearTimeout(ww._timer);
        gs.weaponizeWindow = null;
        gs.phase = 'play';  // reset before resolveCb (same fix as 8s timer path)
        resolveCb();
        // Same rule: only re-trigger bot for sub-phases; bcFinishPlay handles play-phase re-trigger
        if (room.players[playerIdx]?.isBot && gs.currentPlayer === playerIdx && gs.phase !== 'play') {
          room._bcBotRunning = false;
          setTimeout(() => bcBotContinueTurn(room, playerIdx), 50);
        }
      }
    }, 1500);
  }
}

function bcResolveRecon(room, st) {
  const gs = room.bcState;
  gs.phase = 'attack_recon_choose';
  bcLog(room, `🔍 Recon resolved — ${room.players[st.attacker].name} chooses: Look at hand or Swap attack cards.`);
  bcBroadcastState(room);
  if (room.players[st.attacker]?.isBot) {
    setTimeout(() => {
      if (gs.phase !== 'attack_recon_choose' || gs.attackState?.attacker !== st.attacker) return;
      // Bot swaps only if both sides have played attack cards; otherwise look
      const myAttack = gs.players[st.attacker].played.filter(c => c.cat === 'attack');
      const theirAttack = gs.players[st.target].played.filter(c => c.cat === 'attack');
      const choice = (myAttack.length > 0 && theirAttack.length > 0) ? 'swap' : 'look';
      bcHandleAction(room, st.attacker, { type: 'game_action', action: 'recon_choice', choice });
    }, 700);
  }
}

function bcResolveExploit(room, st) {
  const gs = room.bcState;
  const tgtPl = gs.players[st.target];
  if (tgtPl.hand.length === 0) {
    bcLog(room, `💥 Exploit — ${room.players[st.target].name} has no cards to steal.`);
  } else {
    const randIdx = Math.floor(Math.random() * tgtPl.hand.length);
    const stolen = tgtPl.hand.splice(randIdx, 1)[0];
    gs.players[st.attacker].hand.push(stolen);
    bcLog(room, `💥 ${room.players[st.attacker].name} blindly stole ${stolen.name} from ${room.players[st.target].name}!`);
  }
  const attacker = st.attacker;
  gs.attackState = null; gs.phase = 'play';
  bcFinishPlay(room, attacker);
}

function bcBotGovern(room, playerIdx) {
  const gs = room.bcState;
  setTimeout(() => {
    if (!gs.governState || gs.governState.viewer !== playerIdx) return;
    if (gs.phase === 'govern_take') {
      const fromIdx = gs.governState.targets[gs.governState.step];
      const hand = gs.players[fromIdx].hand;
      if (hand.length === 0) return;
      // Prefer Data Flag, then card types not yet collected, else first card
      const myPlayed = new Set(gs.players[playerIdx].played.map(c => c.type));
      const take = hand.find(c => c.type === 'data_flag')
                || hand.find(c => !myPlayed.has(c.type))
                || hand[0];
      bcHandleAction(room, playerIdx, { type: 'game_action', action: 'govern_take_card', cardId: take.id });
      bcBotGovern(room, playerIdx);
    } else if (gs.phase === 'govern_give') {
      const myHand = gs.players[playerIdx].hand;
      if (myHand.length === 0) return;
      // Give duplicates or least-valuable cards first
      const myTypes = myHand.map(c => c.type);
      const give = myHand.find(c => myTypes.filter(t => t === c.type).length > 1 && c.type !== 'data_flag' && c.type !== 'action_obj')
                || myHand.find(c => c.type !== 'data_flag' && c.type !== 'action_obj' && c.type !== 'govern')
                || myHand[0];
      bcHandleAction(room, playerIdx, { type: 'game_action', action: 'govern_give_card', cardId: give.id });
      bcBotGovern(room, playerIdx);
    }
  }, 700);
}

function bcResolveInstall(room, st) {
  const gs = room.bcState;
  gs.installBlocked[st.target] = true;
  bcLog(room, `⚙️ ${room.players[st.target].name} is blocked from playing defend cards until their next turn (Installation)!`);
  const attacker = st.attacker;
  gs.attackState = null; gs.phase = 'play';
  bcFinishPlay(room, attacker);
}

function bcResolveDelivery(room, st) {
  const gs = room.bcState;
  // Check if any swaps are even possible
  const myPlayed  = gs.players[st.attacker].played;
  const hasOppPlayed = gs.players.some((p, i) => i !== st.attacker && p.played.length > 0);
  if (myPlayed.length === 0 || !hasOppPlayed) {
    bcLog(room, `📨 Delivery — no cards on the table to swap.`);
    gs.attackState = null; gs.phase = 'play';
    bcFinishPlay(room, st.attacker);
    return;
  }
  gs.phase = 'attack_delivery_pick';
  bcLog(room, `📨 Delivery resolved — ${room.players[st.attacker].name} picks up to 2 card swaps.`);
  gs.attackState.swaps = [];
  gs.attackState.pickStep = null;
  bcBroadcastState(room);
  // 15-second auto-resolve for non-bots (safety net)
  const snapAtk = gs.attackState;
  setTimeout(() => {
    if (gs.phase === 'attack_delivery_pick' && gs.attackState === snapAtk) {
      bcLog(room, `📨 Delivery timed out — resolving with ${snapAtk.swaps.length} swap(s).`);
      bcExecuteDelivery(room);
    }
  }, 15000);
  if (room.players[st.attacker]?.isBot) {
    setTimeout(() => {
      if (gs.phase !== 'attack_delivery_pick' || gs.attackState?.attacker !== st.attacker) return;
      // Bot: swap first played card with first opponent's played card
      const myPlayed = gs.players[st.attacker].played;
      if (myPlayed.length === 0) { bcExecuteDelivery(room); return; }
      const myCard = myPlayed[0];
      const tgtIdx = gs.players.findIndex((_, i) => i !== st.attacker && gs.players[i].played.length > 0);
      if (tgtIdx < 0) { bcExecuteDelivery(room); return; }
      const theirCard = gs.players[tgtIdx].played[0];
      gs.attackState.swaps.push({ myCard, theirCard, theirIdx: tgtIdx });
      bcExecuteDelivery(room);
    }, 1000);
  }
}

function bcExecuteDelivery(room) {
  const gs = room.bcState;
  const st = gs.attackState;
  const attPl = gs.players[st.attacker];
  for (const swap of st.swaps) {
    attPl.played = attPl.played.filter(c => c.id !== swap.myCard.id);
    gs.players[swap.theirIdx].played = gs.players[swap.theirIdx].played.filter(c => c.id !== swap.theirCard.id);
    attPl.played.push({ ...swap.theirCard });
    gs.players[swap.theirIdx].played.push({ ...swap.myCard });
    bcLog(room, `📨 Delivery swap: ${swap.myCard.name} ↔ ${room.players[swap.theirIdx].name}'s ${swap.theirCard.name}`);
  }
  gs.attackState = null; gs.phase = 'play';
  bcFinishPlay(room, st.attacker);
}

function bcResolveC2(room, st) {
  const gs = room.bcState;
  const { attacker, target } = st;
  const tgtPl = gs.players[target];
  const dfCard = tgtPl.hand.find(c => c.type === 'data_flag');
  if (dfCard) {
    // Target holds Data Flag — must give it to attacker
    tgtPl.hand = tgtPl.hand.filter(c => c.id !== dfCard.id);
    gs.players[attacker].hand.push(dfCard);
    bcLog(room, `📡 C2 resolved — ${room.players[target].name} had the Data Flag and gave it to ${room.players[attacker].name}!`);
    gs.attackState = null;
    gs.phase = 'play';
    bcFinishPlay(room, attacker);
  } else if (tgtPl.hand.length > 0) {
    // TARGET picks which card from their own hand to give
    gs.phase = 'attack_c2_give';
    bcLog(room, `📡 C2 — ${room.players[target].name} must give a card of their choice to ${room.players[attacker].name}.`);
    bcBroadcastState(room);
    if (room.players[target]?.isBot) {
      setTimeout(() => {
        if (gs.phase !== 'attack_c2_give' || gs.attackState?.target !== target) return;
        // Bot gives: prefer giving duplicates, then non-special
        const hand = gs.players[target].hand;
        const playedTypes = new Set(gs.players[target].played.map(c => c.type));
        const give = hand.find(c => c.type !== 'data_flag' && playedTypes.has(c.type))
                  || hand.find(c => c.type !== 'data_flag' && c.type !== 'action_obj')
                  || hand[0];
        if (give) bcHandleAction(room, target, { type: 'game_action', action: 'attack_c2_give_card', cardId: give.id });
      }, 1000);
    }
  } else {
    bcLog(room, `📡 C2 — ${room.players[target].name} has no cards to give.`);
    gs.attackState = null;
    gs.phase = 'play';
    bcFinishPlay(room, attacker);
  }
}

function bcEndTurn(room) {
  const gs = room.bcState;
  gs.recoverActive = false;
  gs.identifyState = null;
  gs.detectView = null;
  gs.attackState = null;
  gs.currentPlayer = (gs.currentPlayer + 1) % room.players.length;
  let skip = 0;
  while (!room.players[gs.currentPlayer].connected && skip < room.players.length) {
    gs.currentPlayer = (gs.currentPlayer + 1) % room.players.length;
    skip++;
  }
  if (gs.currentPlayer === 0) gs.turnNumber++;
  // Protection and install block expire at START of that player's own next turn
  delete gs.protectedUntilTurn[gs.currentPlayer];
  delete gs.installBlocked[gs.currentPlayer];
  gs.weaponizeWindow = null;
  gs.phase = 'play';
  // If next player has 0 cards, draw 4
  const pl = gs.players[gs.currentPlayer];
  if (pl.hand.length === 0) {
    bcLog(room, `${room.players[gs.currentPlayer].name} has no cards — drawing 4!`);
    for (let i = 0; i < 4 && gs.deck.length > 0; i++) {
      if (bcDrawOne(room, gs.currentPlayer) === 'game_over') { bcBroadcastState(room); return; }
    }
  }
  bcBroadcastState(room);
  // Trigger bot turn if the next player is a bot
  if (room.players[gs.currentPlayer]?.isBot) {
    room._bcBotRunning = false; // reset lock for fresh turn
    executeBCBotTurn(room);
  }
}

function bcFinishPlay(room, playerIdx) {
  // After a card is played and its immediate effect is applied: check acquisition + win
  bcCheckSpecialAcquisition(room);
  const gs = room.bcState;
  const w = bcCheckWin(room, playerIdx);
  if (w) {
    gs.winner = playerIdx; gs.winCondition = w; gs.phase = 'game_over';
    bcLog(room, `🏆 ${room.players[playerIdx].name} wins!`);
  }
  bcBroadcastState(room);
  // Re-trigger bot if it's still their turn in play phase.
  // Deferred 50ms so any synchronous call stack (e.g. weaponize resolveCb) fully
  // unwinds first — prevents bcBotContinueTurn from opening a new weaponize window
  // before the timer callback's own post-resolveCb log line executes.
  if (!w && gs.phase === 'play' && gs.currentPlayer === playerIdx && room.players[playerIdx]?.isBot) {
    room._bcBotRunning = false;
    setTimeout(() => {
      if (gs.phase === 'play' && gs.currentPlayer === playerIdx)
        bcBotContinueTurn(room, playerIdx);
    }, 50);
  }
}

function bcHandleAction(room, playerIdx, msg) {
  const gs = room.bcState;
  if (gs.phase === 'game_over') return;
  const pl = gs.players[playerIdx];

  // Coerce cardId to number only when it's a numeric string (e.g. from HTML onclick).
  // Special-card IDs are strings ('govern', 'action_obj', 'data_flag') — leave them as-is.
  if (msg.cardId !== undefined) {
    const n = Number(msg.cardId);
    if (!isNaN(n)) msg.cardId = n;
  }

  switch (msg.action) {

    // ===== PLAY CARD =====
    case 'play_card': {
      if (gs.phase !== 'play' || gs.currentPlayer !== playerIdx) return;
      if (gs.recoverActive) return; // Recover: can't play more cards this turn
      const cardIdx = pl.hand.findIndex(c => c.id === msg.cardId);
      if (cardIdx === -1) return;
      const card = pl.hand.splice(cardIdx, 1)[0];

      // ── Govern (special) ──
      if (card.type === 'govern') {
        pl.played.push(card);
        const govTargets = gs.players.map((p, i) => i).filter(i => i !== playerIdx && gs.players[i].hand.length > 0);
        if (govTargets.length === 0) {
          bcLog(room, `🏛️ ${room.players[playerIdx].name} plays Govern — no other players have cards.`);
          bcFinishPlay(room, playerIdx);
          return;
        }
        gs.governState = { viewer: playerIdx, targets: govTargets, step: 0, mode: 'take', taken: [] };
        gs.phase = 'govern_take';
        bcLog(room, `🏛️ ${room.players[playerIdx].name} plays Govern — privately viewing all hands and taking one card from each player.`);
        bcBroadcastState(room);
        if (room.players[playerIdx]?.isBot) bcBotGovern(room, playerIdx);
        return;
      }

      // ── Action Objectives (special) ──
      if (card.type === 'action_obj') {
        pl.played.push(card);
        let dfHolder = -1;
        for (let i = 0; i < gs.players.length; i++) {
          if (gs.players[i].hand.some(c => c.type === 'data_flag')) { dfHolder = i; break; }
        }
        if (dfHolder >= 0 && dfHolder !== playerIdx) {
          const dfCard = gs.players[dfHolder].hand.find(c => c.type === 'data_flag');
          gs.players[dfHolder].hand = gs.players[dfHolder].hand.filter(c => c.id !== dfCard.id);
          gs.players[playerIdx].hand.push(dfCard);
          bcLog(room, `🎯 ${room.players[playerIdx].name} plays Action Objectives — ${room.players[dfHolder].name} must give up the Data Flag!`);
        } else if (dfHolder === playerIdx) {
          bcLog(room, `🎯 ${room.players[playerIdx].name} plays Action Objectives — they already hold the Data Flag!`);
        } else {
          bcLog(room, `🎯 ${room.players[playerIdx].name} plays Action Objectives — the Data Flag is not in anyone's hand (fizzles).`);
        }
        bcFinishPlay(room, playerIdx); return;
      }

      // ── IDENTIFY ──
      if (card.type === 'identify') {
        pl.played.push(card);
        bcLog(room, `🔎 ${room.players[playerIdx].name} plays Identify — choose to Swap defend cards or reveal the Data Flag.`);
        return bcOpenWeaponizeWindow(room, playerIdx, card, () => {
          gs.phase = 'identify_choosing';
          gs.identifyState = { chooser: playerIdx };
          bcBroadcastState(room);
        });
      }

      // ── PROTECT ──
      if (card.type === 'protect') {
        pl.played.push(card);
        bcLog(room, `🛡️ ${room.players[playerIdx].name} plays Protect — cannot be targeted by attack effects until their next turn.`);
        return bcOpenWeaponizeWindow(room, playerIdx, card, () => {
          gs.protectedUntilTurn[playerIdx] = true;
          bcFinishPlay(room, playerIdx);
        });
      }

      // ── DETECT ──
      if (card.type === 'detect') {
        pl.played.push(card);
        bcLog(room, `👁️ ${room.players[playerIdx].name} plays Detect — viewing top 5 cards of the deck.`);
        return bcOpenWeaponizeWindow(room, playerIdx, card, () => {
          const topCards = gs.deck.slice(0, 5).map(c => ({ ...c }));
          gs.detectView = { viewer: playerIdx, cards: topCards };
          gs.phase = 'detect_view';
          bcBroadcastState(room);
        });
      }

      // ── RESPOND (goes to table; played from hand on your turn as collection only — out-of-turn via play_respond) ──
      if (card.type === 'respond') {
        pl.played.push(card);
        bcLog(room, `🚨 ${room.players[playerIdx].name} plays Respond — can be used to counter attack card effects.`);
        bcFinishPlay(room, playerIdx); return;
      }

      // ── RECOVER ──
      if (card.type === 'recover') {
        pl.played.push(card);
        bcLog(room, `🔄 ${room.players[playerIdx].name} plays Recover — drawing up to 5 cards, skipping end-of-turn draw.`);
        return bcOpenWeaponizeWindow(room, playerIdx, card, () => {
          const needed = Math.max(0, 5 - pl.hand.length);
          let drew = 0;
          for (let i = 0; i < needed && gs.deck.length > 0; i++) {
            const r = bcDrawOne(room, playerIdx);
            if (r === 'game_over') { bcBroadcastState(room); return; }
            drew++;
          }
          gs.recoverActive = true;
          bcLog(room, `🔄 ${room.players[playerIdx].name} drew ${drew} card(s) via Recover.`);
          bcFinishPlay(room, playerIdx);
        });
      }

      // ── Attack cards with effects ──
      if (card.cat === 'attack') {
        // Installation block: can't play defend cards — but attack cards are fine
        pl.played.push(card);
        const attackPhaseMap = {
          c2:        'attack_c2_target',
          recon:     'attack_recon_target',
          exploit:   'attack_exploit_target',
          install:   'attack_install_target',
          deliver:   'attack_delivery_target',
          weaponize: null,  // no target — goes to table for collection only
        };
        const targetPhase = attackPhaseMap[card.type];
        if (targetPhase) {
          // Check if any valid (non-protected, connected) targets exist before entering target phase
          const validTargets = gs.players.filter((_, i) => i !== playerIdx && !bcIsProtected(gs, i) && room.players[i]?.connected);
          if (validTargets.length === 0) {
            bcLog(room, `⚠️ ${room.players[playerIdx].name} plays ${card.name} — no valid targets (all opponents are Protected). Effect cancelled.`);
            bcFinishPlay(room, playerIdx);
            return;
          }
          gs.attackState = { type: card.type, attacker: playerIdx, card, swaps: [], pickStep: null };
          gs.phase = targetPhase;
          bcLog(room, `${room.players[playerIdx].name} plays ${card.name} [⚔️ ${card.type}] — choose a target.`);
          bcBroadcastState(room);
          if (room.players[playerIdx]?.isBot) { room._bcBotRunning = false; bcBotContinueTurn(room, playerIdx); }
          return;
        }
        // Weaponize: collection only (its power is played out-of-turn via play_weaponize)
        bcLog(room, `⚒️ ${room.players[playerIdx].name} plays ${card.name} [Weaponize] — can cancel defend card effects out of turn.`);
        bcFinishPlay(room, playerIdx); break;
      }

      // ── Defend card — check install block ──
      if (gs.installBlocked[playerIdx]) {
        // Put card back in hand
        pl.hand.push(card);
        gs.pendingError = { playerIdx, message: `⚙️ You cannot play defend cards this turn — Installation is blocking you until the start of your next turn.` };
        bcLog(room, `❌ ${room.players[playerIdx].name} is blocked from playing defend cards this turn (Installation)!`);
        bcBroadcastState(room); return;
      }

      // ── Generic defend card ──
      pl.played.push(card);
      bcLog(room, `${room.players[playerIdx].name} plays ${card.name} [🛡️]`);
      bcFinishPlay(room, playerIdx); break;
    }

    // ===== ACTION OBJ — OUT OF TURN =====
    case 'play_action_obj_anytime': {
      const aoIdx = pl.hand.findIndex(c => c.type === 'action_obj');
      if (aoIdx === -1) return;
      const aoCard = pl.hand.splice(aoIdx, 1)[0];
      pl.played.push(aoCard);
      let dfHolder = -1;
      for (let i = 0; i < gs.players.length; i++) {
        if (gs.players[i].hand.some(c => c.type === 'data_flag')) { dfHolder = i; break; }
      }
      if (dfHolder >= 0 && dfHolder !== playerIdx) {
        const dfCard = gs.players[dfHolder].hand.find(c => c.type === 'data_flag');
        gs.players[dfHolder].hand = gs.players[dfHolder].hand.filter(c => c.id !== dfCard.id);
        gs.players[playerIdx].hand.push(dfCard);
        bcLog(room, `🎯 ${room.players[playerIdx].name} plays Action Objectives — ${room.players[dfHolder].name} must give up the Data Flag!`);
      } else if (dfHolder === playerIdx) {
        bcLog(room, `🎯 ${room.players[playerIdx].name} plays Action Objectives — they already hold the Data Flag!`);
      } else {
        bcLog(room, `🎯 ${room.players[playerIdx].name} plays Action Objectives — the Data Flag is not in anyone's hand (fizzles).`);
      }
      bcFinishPlay(room, playerIdx); break;
    }

    // ===== CANCEL ATTACK (human safety valve when no valid targets) =====
    case 'cancel_attack': {
      const cancelPhases = ['attack_c2_target','attack_recon_target','attack_exploit_target','attack_install_target','attack_delivery_target'];
      if (!cancelPhases.includes(gs.phase) || gs.attackState?.attacker !== playerIdx) return;
      bcLog(room, `❌ ${room.players[playerIdx].name} cancels their attack — no valid target.`);
      gs.attackState = null; gs.phase = 'play';
      bcFinishPlay(room, playerIdx); break;
    }

    // ===== ATTACK EFFECTS =====

    // ===== WEAPONIZE (out-of-turn cancel of defend card effect) =====
    case 'play_weaponize': {
      if (gs.phase !== 'weaponize_window') return;
      if (playerIdx === gs.weaponizeWindow?.defender) return; // defender can't cancel own card
      const wCard = pl.hand.find(c => c.id === msg.cardId && c.type === 'weaponize');
      if (!wCard) return;
      pl.hand = pl.hand.filter(c => c.id !== wCard.id);
      pl.played.push(wCard);
      bcLog(room, `⚒️ ${room.players[playerIdx].name} plays Weaponize — ${gs.weaponizeWindow.card?.name || 'defend card'} effect cancelled!`);
      if (gs.weaponizeWindow._timer) clearTimeout(gs.weaponizeWindow._timer);
      gs.weaponizeWindow = null;
      gs.phase = 'play';
      bcBroadcastState(room); break;
    }

    case 'weaponize_window_pass': {
      // Defender dismisses the window (all opponents have no weaponize)
      if (gs.phase !== 'weaponize_window' || gs.weaponizeWindow?.defender !== playerIdx) return;
      const ww = gs.weaponizeWindow;
      if (ww._timer) clearTimeout(ww._timer);
      const cb = ww._resolve;
      gs.weaponizeWindow = null;
      if (cb) cb();
      break;
    }

    // ===== GENERIC ATTACK TARGET =====
    case 'attack_select_target': {
      const validTargetPhases = ['attack_c2_target','attack_recon_target','attack_exploit_target','attack_install_target','attack_delivery_target'];
      if (!validTargetPhases.includes(gs.phase) || gs.attackState?.attacker !== playerIdx) return;
      const tgt = Number(msg.targetIdx ?? msg.target);
      if (!Number.isFinite(tgt) || tgt < 0 || tgt >= gs.players.length || tgt === playerIdx) return;
      if (!room.players[tgt]?.connected) return;
      if (bcIsProtected(gs, tgt)) {
        gs.pendingError = { playerIdx, message: `🛡️ ${room.players[tgt].name} is Protected — they cannot be targeted by attack cards right now.` };
        bcLog(room, `❌ ${room.players[tgt].name} is Protected — cannot be targeted!`);
        bcBroadcastState(room); return;
      }
      gs.attackState.target = tgt;
      gs.phase = 'attack_respond_window';
      bcLog(room, `📡 ${room.players[playerIdx].name} targets ${room.players[tgt].name} — Respond to cancel?`);
      bcBroadcastState(room);
      // Auto-resolve for bot target
      if (room.players[tgt]?.isBot) {
        setTimeout(() => {
          if (gs.phase !== 'attack_respond_window' || gs.attackState?.target !== tgt) return;
          const respondCard = gs.players[tgt].hand.find(c => c.type === 'respond');
          if (respondCard) {
            bcHandleAction(room, tgt, { type: 'game_action', action: 'play_respond', cardId: respondCard.id });
          } else {
            bcHandleAction(room, tgt, { type: 'game_action', action: 'respond_skip' });
          }
        }, 1000 + Math.random() * 500);
      } else {
        // Auto-skip after 12 seconds if human doesn't act
        const snapAttack = gs.attackState;
        setTimeout(() => {
          if (gs.phase === 'attack_respond_window' && gs.attackState === snapAttack) {
            bcHandleAction(room, tgt, { type: 'game_action', action: 'respond_skip' });
          }
        }, 12000);
      }
      break;
    }

    case 'play_respond': {
      if (gs.phase !== 'attack_respond_window') return;
      if (playerIdx !== gs.attackState?.target) return;
      const respondCard = pl.hand.find(c => c.id === msg.cardId && c.type === 'respond');
      if (!respondCard) return;
      pl.hand = pl.hand.filter(c => c.id !== respondCard.id);
      pl.played.push(respondCard);
      const attackerIdx = gs.attackState.attacker;
      bcLog(room, `🚨 ${room.players[playerIdx].name} plays Respond — ${gs.attackState.cardName || 'attack'} effect cancelled!`);
      gs.attackState = null;
      gs.phase = 'play';
      bcBroadcastState(room);
      // Resume bot turn if the attacker was a bot (their turn was suspended waiting for respond window)
      if (room.players[attackerIdx]?.isBot && gs.currentPlayer === attackerIdx) {
        room._bcBotRunning = false;
        bcBotContinueTurn(room, attackerIdx);
      }
      break;
    }

    case 'respond_skip': {
      if (gs.phase !== 'attack_respond_window') return;
      if (playerIdx !== gs.attackState?.target) return;
      const st = gs.attackState;
      const attackerWasBot = room.players[st.attacker]?.isBot;
      const attackerIdx = st.attacker;
      if      (st.type === 'c2')      bcResolveC2(room, st);
      else if (st.type === 'recon')   bcResolveRecon(room, st);
      else if (st.type === 'exploit') bcResolveExploit(room, st);
      else if (st.type === 'install') bcResolveInstall(room, st);
      else if (st.type === 'deliver') bcResolveDelivery(room, st);
      // Re-trigger bot turn if phase returned to play (exploit/install resolve immediately)
      if (attackerWasBot && gs.currentPlayer === attackerIdx && gs.phase === 'play') {
        room._bcBotRunning = false;
        bcBotContinueTurn(room, attackerIdx);
      }
      break;
    }

    // ===== RECON ACTIONS =====
    case 'recon_choice': {
      if (gs.phase !== 'attack_recon_choose' || gs.attackState?.attacker !== playerIdx) return;
      if (msg.choice === 'look') {
        gs.phase = 'attack_recon_look';
        bcLog(room, `🔍 ${room.players[playerIdx].name} looks at ${room.players[gs.attackState.target].name}'s hand.`);
        bcBroadcastState(room);
        // Auto-dismiss after 10s
        setTimeout(() => {
          if (gs.phase === 'attack_recon_look' && gs.attackState?.attacker === playerIdx) {
            gs.attackState = null; gs.phase = 'play'; bcFinishPlay(room, playerIdx);
          }
        }, 10000);
      } else {
        gs.phase = 'attack_recon_swap_my';
        bcLog(room, `🔍 ${room.players[playerIdx].name} chooses to swap attack cards.`);
        bcBroadcastState(room);
        // Bot auto-picks swap-my card
        if (room.players[playerIdx]?.isBot) {
          setTimeout(() => {
            if (gs.phase !== 'attack_recon_swap_my' || gs.attackState?.attacker !== playerIdx) return;
            const myAttack = gs.players[playerIdx].played.filter(c => c.cat === 'attack');
            if (myAttack.length > 0) bcHandleAction(room, playerIdx, { type: 'game_action', action: 'recon_swap_my', cardId: myAttack[0].id });
            else { gs.attackState = null; gs.phase = 'play'; bcFinishPlay(room, playerIdx); }
          }, 700);
        }
      }
      break;
    }

    case 'recon_look_done': {
      if (gs.phase !== 'attack_recon_look' || gs.attackState?.attacker !== playerIdx) return;
      gs.attackState = null; gs.phase = 'play';
      bcFinishPlay(room, playerIdx); break;
    }

    case 'recon_go_back': {
      if (gs.phase !== 'attack_recon_choose' || gs.attackState?.attacker !== playerIdx) return;
      // Go back to target selection
      gs.phase = 'attack_recon_target';
      gs.attackState.target = -1;
      bcBroadcastState(room); break;
    }

    case 'identify_go_back': {
      // Go back from swap flow to identify_choosing
      if (!['identify_swap_my','identify_swap_target','identify_swap_their','identify_dataflag'].includes(gs.phase)) return;
      if (gs.identifyState?.chooser !== playerIdx) return;
      gs.phase = 'identify_choosing';
      gs.identifyState = { chooser: playerIdx };
      bcBroadcastState(room); break;
    }

    case 'delivery_go_back': {
      if (gs.phase !== 'attack_delivery_pick' || gs.attackState?.attacker !== playerIdx) return;
      gs.attackState.pickStep = null;
      bcBroadcastState(room); break;
    }

    case 'recon_swap_my': {
      if (gs.phase !== 'attack_recon_swap_my' || gs.attackState?.attacker !== playerIdx) return;
      const myCard = pl.played.find(c => c.cat === 'attack' && c.id === msg.cardId);
      if (!myCard) return;
      gs.attackState.reconSwapMyCard = myCard;
      gs.phase = 'attack_recon_swap_their';
      bcBroadcastState(room);
      // Bot auto-picks their card
      if (room.players[playerIdx]?.isBot) {
        setTimeout(() => {
          if (gs.phase !== 'attack_recon_swap_their' || gs.attackState?.attacker !== playerIdx) return;
          const tgt = gs.attackState.target;
          const theirAttack = gs.players[tgt].played.filter(c => c.cat === 'attack');
          if (theirAttack.length > 0) {
            bcHandleAction(room, playerIdx, { type: 'game_action', action: 'recon_swap_their', cardId: theirAttack[0].id });
          } else {
            // No cards to swap — cancel gracefully
            gs.attackState = null; gs.phase = 'play';
            bcFinishPlay(room, playerIdx);
          }
        }, 700);
      }
      break;
    }

    case 'recon_swap_their': {
      if (gs.phase !== 'attack_recon_swap_their' || gs.attackState?.attacker !== playerIdx) return;
      const st = gs.attackState;
      const tgt = st.target;
      const theirCard = gs.players[tgt].played.find(c => c.cat === 'attack' && c.id === msg.cardId);
      if (!theirCard || !st.reconSwapMyCard) return;
      pl.played = pl.played.filter(c => c.id !== st.reconSwapMyCard.id);
      gs.players[tgt].played = gs.players[tgt].played.filter(c => c.id !== theirCard.id);
      pl.played.push({ ...theirCard });
      gs.players[tgt].played.push({ ...st.reconSwapMyCard });
      bcLog(room, `🔍 ${room.players[playerIdx].name} swapped ${st.reconSwapMyCard.name} for ${room.players[tgt].name}'s ${theirCard.name}.`);
      gs.attackState = null; gs.phase = 'play';
      bcFinishPlay(room, playerIdx); break;
    }

    // ===== DELIVERY ACTIONS =====
    case 'delivery_pick_mine': {
      if (gs.phase !== 'attack_delivery_pick' || gs.attackState?.attacker !== playerIdx) return;
      const myCard = pl.played.find(c => c.id === msg.cardId);
      if (!myCard) return;
      gs.attackState.pickStep = { myCard };
      bcBroadcastState(room); break;
    }

    case 'delivery_pick_theirs': {
      if (gs.phase !== 'attack_delivery_pick' || gs.attackState?.attacker !== playerIdx) return;
      if (!gs.attackState.pickStep?.myCard) return;
      const tgtIdx = msg.targetIdx;
      const theirCard = gs.players[tgtIdx]?.played.find(c => c.id === msg.cardId);
      if (!theirCard || tgtIdx === playerIdx) return;
      // Record this swap
      gs.attackState.swaps.push({ myCard: gs.attackState.pickStep.myCard, theirCard, theirIdx: tgtIdx });
      gs.attackState.pickStep = null;
      bcLog(room, `📨 Swap ${gs.attackState.swaps.length}: ${gs.attackState.pickStep?.myCard?.name||'card'} ↔ ${theirCard.name}`);
      if (gs.attackState.swaps.length >= 2) {
        bcExecuteDelivery(room); // execute both swaps
      } else {
        bcBroadcastState(room); // ready for 2nd swap
      }
      break;
    }

    case 'delivery_done': {
      if (gs.phase !== 'attack_delivery_pick' || gs.attackState?.attacker !== playerIdx) return;
      bcExecuteDelivery(room); break;
    }

    case 'attack_c2_give_card': {
      if (gs.phase !== 'attack_c2_give' || gs.attackState?.target !== playerIdx) return;
      const att = gs.attackState.attacker;
      const given = pl.hand.find(c => c.id === msg.cardId && c.type !== 'data_flag');
      if (!given) return;
      pl.hand = pl.hand.filter(c => c.id !== given.id);
      gs.players[att].hand.push(given);
      bcLog(room, `📡 C2 resolved — ${room.players[playerIdx].name} gave ${given.name} to ${room.players[att].name}.`);
      gs.attackState = null; gs.phase = 'play';
      bcFinishPlay(room, att); break;
    }

    // ===== END PLAY PHASE =====
    case 'end_play_phase': {
      if (gs.phase !== 'play' || gs.currentPlayer !== playerIdx) return;
      if (gs.recoverActive) {
        // Recover: skip auto-draw
        gs.recoverActive = false;
        bcBroadcastState(room);
        bcEndTurn(room);
        return;
      }
      const result = bcDrawOne(room, playerIdx);
      if (result === 'game_over') { bcBroadcastState(room); return; }
      if (result === 'empty') { bcLog(room, `Deck empty — skipping draw.`); bcBroadcastState(room); bcEndTurn(room); return; }
      if (result !== 'times_up') bcLog(room, `${room.players[playerIdx].name} draws a card (${pl.hand.length} in hand).`);
      if (pl.hand.length > 6) {
        gs.phase = 'discard';
        bcLog(room, `${room.players[playerIdx].name} has ${pl.hand.length} cards — discard down to 6.`);
        bcBroadcastState(room);
      } else { bcBroadcastState(room); bcEndTurn(room); }
      break;
    }

    // ===== DISCARD =====
    case 'discard_card': {
      if (gs.phase !== 'discard' || gs.currentPlayer !== playerIdx) return;
      const idx = pl.hand.findIndex(c => c.id === msg.cardId);
      if (idx === -1) return;
      const card = pl.hand.splice(idx, 1)[0];
      bcLog(room, `${room.players[playerIdx].name} discards ${card.name}.`);
      if (pl.hand.length <= 6) { gs.phase = 'play'; bcBroadcastState(room); bcEndTurn(room); }
      else bcBroadcastState(room);
      break;
    }

    // ===== GOVERN =====
    case 'govern_take_card': {
      if (gs.phase !== 'govern_take' || gs.governState?.viewer !== playerIdx) return;
      const gst = gs.governState;
      const fromIdx = gst.targets[gst.step];
      const fromPl = gs.players[fromIdx];
      const takenCard = fromPl.hand.find(c => c.id === msg.cardId);
      if (!takenCard) return;
      fromPl.hand = fromPl.hand.filter(c => c.id !== takenCard.id);
      gs.players[playerIdx].hand.push(takenCard);
      gst.taken.push({ fromIdx, card: takenCard });
      bcLog(room, `🏛️ ${room.players[playerIdx].name} takes a card from ${room.players[fromIdx].name}.`);
      gst.step++;
      if (gst.step >= gst.targets.length) {
        // All taken — switch to give mode
        gst.mode = 'give';
        gst.step = 0;
        gs.phase = 'govern_give';
      }
      bcBroadcastState(room); break;
    }

    case 'govern_give_card': {
      if (gs.phase !== 'govern_give' || gs.governState?.viewer !== playerIdx) return;
      const gst = gs.governState;
      const toIdx = gst.taken[gst.step].fromIdx;
      const giveCard = gs.players[playerIdx].hand.find(c => c.id === msg.cardId);
      if (!giveCard) return;
      gs.players[playerIdx].hand = gs.players[playerIdx].hand.filter(c => c.id !== giveCard.id);
      gs.players[toIdx].hand.push(giveCard);
      bcLog(room, `🏛️ ${room.players[playerIdx].name} gives a card to ${room.players[toIdx].name}.`);
      gst.step++;
      if (gst.step >= gst.taken.length) {
        // Done — all exchanges complete
        gs.governState = null;
        gs.phase = 'play';
        bcFinishPlay(room, playerIdx);
        return;
      }
      bcBroadcastState(room); break;
    }

    // ===== IDENTIFY =====
    case 'identify_choice': {
      if (gs.phase !== 'identify_choosing' || gs.identifyState?.chooser !== playerIdx) return;
      if (msg.choice === 'dataflag') {
        // Find who holds the Data Flag
        let dfHolder = -1;
        for (let i = 0; i < gs.players.length; i++) {
          if (gs.players[i].hand.some(c => c.type === 'data_flag')) { dfHolder = i; break; }
        }
        const dfInDeck = dfHolder === -1 && gs.deck.some(c => c.type === 'data_flag');
        gs.identifyState.dataFlagHolder = dfHolder;  // -1 = no one (in deck or gone)
        gs.identifyState.dataFlagInDeck = dfInDeck;
        gs.phase = 'identify_dataflag';
        if (dfHolder >= 0) {
          bcLog(room, `🔎 Data Flag reveal — ${room.players[dfHolder].name} is holding the Data Flag!`);
        } else if (dfInDeck) {
          bcLog(room, `🔎 Data Flag reveal — the Data Flag is still in the deck.`);
        } else {
          bcLog(room, `🔎 Data Flag reveal — the Data Flag has not yet been drawn.`);
        }
        bcBroadcastState(room);
        // Auto-dismiss for bot chooser
        if (room.players[playerIdx]?.isBot) {
          setTimeout(() => {
            if (gs.phase === 'identify_dataflag') {
              gs.identifyState = null; gs.phase = 'play';
              bcBroadcastState(room);
            }
          }, 2000);
        }
      } else if (msg.choice === 'swap') {
        gs.identifyState.swapMyCard = null;
        gs.identifyState.swapTargetIdx = -1;
        gs.phase = 'identify_swap_my';
        bcLog(room, `🔎 Swap chosen — ${room.players[playerIdx].name} selects one of their played defend cards to swap.`);
        bcBroadcastState(room);
      }
      break;
    }

    case 'identify_dataflag_done': {
      if (gs.phase !== 'identify_dataflag' || gs.identifyState?.chooser !== playerIdx) return;
      gs.identifyState = null; gs.phase = 'play';
      bcBroadcastState(room); break;
    }

    case 'identify_swap_my': {
      if (gs.phase !== 'identify_swap_my' || gs.identifyState?.chooser !== playerIdx) return;
      const card = pl.played.find(c => c.cat === 'defend' && c.id === msg.cardId);
      if (!card) return;
      gs.identifyState.swapMyCard = card;
      gs.phase = 'identify_swap_target';
      bcBroadcastState(room); break;
    }

    case 'identify_swap_target': {
      if (gs.phase !== 'identify_swap_target' || gs.identifyState?.chooser !== playerIdx) return;
      const tgt = msg.targetIdx;
      if (tgt < 0 || tgt >= gs.players.length || tgt === playerIdx) return;
      // Protected players can be targeted — but their active Protect card is ineligible for the swap
      const tgtProtected = bcIsProtected(gs, tgt);
      const swappableCards = gs.players[tgt].played.filter(c => c.cat === 'defend' && !(c.type === 'protect' && tgtProtected));
      if (swappableCards.length === 0) {
        bcLog(room, `❌ ${room.players[tgt].name} has no swappable defend cards${tgtProtected ? ' (Protect is active)' : ''}.`);
        bcBroadcastState(room); return;
      }
      gs.identifyState.swapTargetIdx = tgt;
      gs.phase = 'identify_swap_their';
      bcBroadcastState(room); break;
    }

    case 'identify_swap_their': {
      if (gs.phase !== 'identify_swap_their' || gs.identifyState?.chooser !== playerIdx) return;
      const id = gs.identifyState;
      const tgt = id.swapTargetIdx;
      const theirCard = gs.players[tgt].played.find(c => c.cat === 'defend' && c.id === msg.cardId);
      if (!theirCard) return;
      // Cannot swap an active Protect card
      if (theirCard.type === 'protect' && bcIsProtected(gs, tgt)) {
        bcLog(room, `❌ ${room.players[tgt].name}'s Protect card is currently active — it cannot be swapped.`);
        bcBroadcastState(room); return;
      }
      // Execute swap: remove my card from my played, add their card; vice versa
      pl.played = pl.played.filter(c => c.id !== id.swapMyCard.id);
      gs.players[tgt].played = gs.players[tgt].played.filter(c => c.id !== theirCard.id);
      pl.played.push({ ...theirCard });
      gs.players[tgt].played.push({ ...id.swapMyCard });
      bcLog(room, `🔎 ${room.players[playerIdx].name} swapped ${id.swapMyCard.name} for ${room.players[tgt].name}'s ${theirCard.name}.`);
      gs.identifyState = null; gs.phase = 'play';
      bcFinishPlay(room, playerIdx); break;
    }

    // ===== DETECT =====
    case 'detect_reorder': {
      if (gs.phase !== 'detect_view' || gs.detectView?.viewer !== playerIdx) return;
      const ordered = msg.order.map(id => gs.detectView.cards.find(c => c.id === id)).filter(Boolean);
      if (ordered.length !== gs.detectView.cards.length) return;
      // Put reordered cards back on top of deck
      gs.deck.splice(0, ordered.length);
      gs.deck.unshift(...ordered);
      bcLog(room, `👁️ ${room.players[playerIdx].name} rearranged the top of the deck.`);
      gs.detectView = null; gs.phase = 'play';
      bcFinishPlay(room, playerIdx); break;
    }
  }
}

// ==================== HTTP SERVER ====================
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  let pathname = parsed.pathname;
  if (pathname === '/byteclub' || pathname === '/byteclub.html') pathname = '/byteclub.html';
  else if (pathname === '/fuzznet' || pathname === '/fuzznet.html') pathname = '/fuzznet.html';
  else if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(__dirname, pathname);
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
