'use strict';

// Dependency injection — set by game-manager.js after shared state is defined
let _rooms, _broadcastToRoom, _trackEvent;
function init({ rooms, broadcastToRoom, trackEvent }) {
  _rooms = rooms;
  _broadcastToRoom = broadcastToRoom;
  _trackEvent = trackEvent;
}

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
const NODE_LABELS = ['L1-A','L1-B','L1-C','L1-D','L2-A','L2-B','L2-C','L3-A','L3-B','L3-C','L3-D'];
const ANIMAL_LOG  = ['🐕 Dog','🐰 Bunny','🐸 Frog','🐿️ Squirrel','🐟 Fish'];

const INPUT_TO_L1 = { 0:[0], 1:[0,1], 2:[1,2], 3:[2,3], 4:[3] };
const L1_TO_L2 = { 0:[4,6], 1:[4,5], 2:[5,6], 3:[4,6] };
const L2_TO_L3 = { 4:[7,8], 5:[8,9], 6:[9,10] };
const L3_TO_OUT = { 7:[0,1], 8:[1,2], 9:[2,3], 10:[3,4] };

// ==================== GAME HELPERS ====================
function fnLog(room, msg) {
  room.state.log.unshift(msg);
  if (room.state.log.length > 40) room.state.log.pop();
}
function pSpan(room, idx) {
  const c = room.players[idx];
  return `<span style="color:${COLOR_INFO[c.color].hex}">●</span> ${c.name}`;
}

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
// In TEST_MODE all bot delays collapse to 10 ms so full-game tests complete in seconds.
const _BOT_DELAY_MS = process.env.TEST_MODE ? 10 : null;
function delay(ms) { return new Promise(r => { const t = setTimeout(r, _BOT_DELAY_MS ?? ms); if (t?.unref) t.unref(); }); }

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
  if (!overfitEdges || overfitEdges.length === 0) return null;
  if (overfitEdges.length === 1) return overfitEdges[0].key;
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
  // Guard: only one bot loop at a time. nextTurn may try to start a second
  // when the human is disconnected and we wrap back to the bot mid-loop.
  if (!room.state || room._botRunning) return;
  room._botRunning = true;

  const s = room.state;
  const botIdx = s.currentPlayer;
  if (!room.players[botIdx]?.isBot || s.gameOver) { room._botRunning = false; return; }

  // Track the current round so we exit after one full round of bot play instead
  // of looping indefinitely when the disconnected human keeps getting skipped.
  const startRound = s.round;

  try {
  while (s.actionsLeft > 0 && !s.gameOver && s.currentPlayer === botIdx && s.round === startRound) {
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
            if (key) { processAction(room, botIdx, { action: 'select_overfit_edge', edgeKey: key }); broadcastState(room); }
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
          if (key) { processAction(room, botIdx, { action: 'select_overfit_edge', edgeKey: key }); broadcastState(room); }
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
            if (key) { processAction(room, botIdx, { action: 'backprop_select_overfit', edgeKey: key }); broadcastState(room); }
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
  } finally {
    room._botRunning = false;
    // If it's still the bot's turn (human was skipped past), schedule the next
    // bot turn rather than looping immediately — gives the human time to reconnect.
    if (!s.gameOver && room.players[s.currentPlayer]?.isBot) {
      const t = setTimeout(() => executeBotTurn(room), 800);
      if (t?.unref) t.unref();
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

// ==================== BROADCAST STATE ====================
function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
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
      scoreboard: s.scoreboard, roundScores: s.roundScores, log: s.log,
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
  // Observers get the full state (FuzzNet has no private hand info)
  for (const o of (room.observers || [])) {
    if (o.connected && o.ws) send(o.ws, { ...base, yourId: -1, isObserver: true });
  }

  // Bot inactivity watchdog — if a bot is the current player and 5 s pass with
  // no further broadcast, reset the lock and re-trigger so the game never freezes.
  clearTimeout(room._fnBotWatchdog);
  if (!s.gameOver && room.players[s.currentPlayer]?.isBot) {
    const watchBotIdx = s.currentPlayer;
    room._fnBotWatchdog = setTimeout(() => {
      if (!room.state || room.state.gameOver || room.state.currentPlayer !== watchBotIdx) return;
      console.log(`[FuzzNet watchdog] player ${watchBotIdx} inactive 5 s — resetting bot lock`);
      room._botRunning = false;
      executeBotTurn(room);
    }, 5000);
    if (room._fnBotWatchdog.unref) room._fnBotWatchdog.unref();
  }
}

// ==================== GAME STATE INIT ====================
function createGameState(numPlayers) {
  // Generate a derangement: no animal output aligned with same-position input
  let order;
  do {
    order = [0,1,2,3,4];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  } while (order.some((v, i) => v === i));
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
    log: [],
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

  // Skip disconnected players, but never end the game just because everyone is
  // transiently disconnected (a brief network hiccup should not kill a live game).
  // leaveRoom() already deletes the room when players truly leave with no session.
  let attempts = 0;
  while (!room.players[s.currentPlayer].connected
      && !room.players[s.currentPlayer].isBot
      && attempts < s.players.length) {
    s.currentPlayer = (s.currentPlayer + 1) % s.players.length;
    if (s.currentPlayer === 0) { s.round++; s.roundScores = {}; }
    attempts++;
  }
  // If we lapped all players and none are connected or bots, hold the turn —
  // don't end the game. They are mid-reconnect; the rejoin flow will resume play.
  if (attempts >= s.players.length && !room.players.some(p => p.connected || p.isBot)) {
    return;
  }

  const p = curPlayer(s);
  s.actionsLeft = p.firstTurnDone ? 1 : 3;
  p.firstTurnDone = true;
  s.phase = 'idle';
  fnLog(room, `── ${pSpan(room, s.currentPlayer)}'s turn ──`);

  // Trigger bot turn if next player is a bot and no bot loop is already running
  if (room.players[s.currentPlayer].isBot && !room._botRunning) {
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
  fnLog(room, '🏁 Game over!');
  const mode = room.players.some(p => p.isBot) ? '1p_bot'
    : room.players.length === 2 ? '2p'
    : room.players.length === 3 ? '3p' : '4p';
  const duration = room.sessionStartedAt ? Math.round((Date.now() - room.sessionStartedAt) / 1000) : null;
  _trackEvent('session_completed', { gameType: 'fuzznet', mode, uvKey: room.uvKey || '', duration });
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
      fnLog(room, `${pSpan(room, playerIdx)} designed <b>${NODE_LABELS[id]}</b>`);
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
      fnLog(room, `${pSpan(room, playerIdx)} trained <b>${NODE_LABELS[id]}</b> (${ps.data[id]}/3)`);
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
      fnLog(room, `⚠ overfit — ${pSpan(room, playerIdx)} blocked <b>${NODE_LABELS[parseInt(key)]}</b> edge`);
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
      fnLog(room, `${pSpan(room, playerIdx)} is testing ${ANIMAL_LOG[a]}…`);
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
      fnLog(room, `🧹 ${pSpan(room, playerIdx)} rerolled ${indices.length} die (use ${ps.cleanUses}/4)`);
      return null;
    }
    case 'clean_flip': {
      if (s.phase !== 'test_eval') return 'Wrong phase';
      if (ps.cleanUses >= 4) return 'No clean uses left';
      const i = msg.dieIdx;
      if (i < 0 || i > 2) return 'Invalid die';
      ps.cleanUses++;
      s.dice[i] = 7 - s.dice[i];
      fnLog(room, `🧹 ${pSpan(room, playerIdx)} flipped a die (use ${ps.cleanUses}/4)`);
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
        fnLog(room, `✅ ${ANIMAL_LOG[a]} passed! <b>+${vals[slot]}pts</b> → ${pSpan(room, playerIdx)}`);
      }
      if (ps.tested.every(t => t)) s.gameEnding = true;
      consumeAction(room);
      return null;
    }
    case 'resolve_fail': {
      if (s.phase !== 'test_eval') return 'Wrong phase';
      fnLog(room, `❌ ${ANIMAL_LOG[s.testAnimal]} failed → ${pSpan(room, playerIdx)}`);
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
      fnLog(room, `↩ ${pSpan(room, playerIdx)} backprop: <b>${NODE_LABELS[src]}</b> → <b>${NODE_LABELS[dst]}</b>`);
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

module.exports = {
  init,
  createGameState,
  processAction,
  broadcastState,
  executeBotTurn,
  nextTurn,
  COLOR_INFO,
  CLEAN_PENALTIES,
  SCORE_VALUES,
  TEST_THRESHOLD,
};
