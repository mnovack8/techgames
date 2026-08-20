'use strict';

// Dependency injection — set by game-manager.js after shared state is defined
let _rooms, _broadcastToRoom, _trackEvent;
function init({ rooms, broadcastToRoom, trackEvent }) {
  _rooms = rooms;
  _broadcastToRoom = broadcastToRoom;
  _trackEvent = trackEvent;
}

function delay(ms) { return new Promise(r => { const t = setTimer(r, ms); if (t?.unref) t.unref(); }); }
function setTimer(fn, ms) { const t = setTimeout(fn, ms); if (t?.unref) t.unref(); return t; }

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
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
      bcLog(room, `${room.players[i].name} collected all NIST defend types — receives the Govern card!`);
    }
    if (gs.actionObjHolder === -1 && bcHasAllAttack(pl.played)) {
      gs.actionObjHolder = i;
      pl.hand.push({ ...BC_ACTION_OBJ_CARD });
      bcLog(room, `${room.players[i].name} completed the Kill Chain — receives the Action Objectives card!`);
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
  const installBlockedPlayers = Object.keys(gs.installBlocked).map(Number).filter(idx => gs.installBlocked[idx]);

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
        isBot: !!room.players[pi].isBot,
      })),
    });
  }
  // ── Observers — full state, all hands and private info visible ──
  for (const o of (room.observers || [])) {
    if (!o.connected || !o.ws) continue;
    send(o.ws, {
      type: 'bc_state',
      isObserver: true,
      myIndex: -1,
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
      myHand: [],
      recoverActive: false,
      protectedPlayers,
      installBlockedPlayers,
      iAmInstallBlocked: false,
      // Full private info visible to observers
      detectViewCards: gs.detectView ? gs.detectView.cards : null,
      identifyInfo: gs.identifyState ? {
        chooser: gs.identifyState.chooser,
        phase: gs.phase,
        dataFlagHolder: gs.identifyState.dataFlagHolder ?? -2,
        dataFlagInDeck: gs.identifyState.dataFlagInDeck ?? false,
        swapMyCard: gs.identifyState.swapMyCard || null,
        swapTargetIdx: gs.identifyState.swapTargetIdx ?? -1,
      } : null,
      attackInfo: gs.attackState ? {
        type: gs.attackState.type,
        attacker: gs.attackState.attacker,
        target: gs.attackState.target,
        cardName: gs.attackState.card?.name || '',
        targetHand: gs.attackState.target >= 0 ? gs.players[gs.attackState.target].hand : null,
        reconSwapMyCard: gs.attackState.reconSwapMyCard || null,
        deliverySwaps: gs.attackState.swaps || [],
        deliveryPickStep: gs.attackState.pickStep || null,
        iAmTarget: false,
        iAmAttacker: false,
        myRespondCards: [],
      } : null,
      weaponizeInfo: gs.weaponizeWindow ? {
        defender: gs.weaponizeWindow.defender,
        defenderName: room.players[gs.weaponizeWindow.defender]?.name || '',
        cardName: gs.weaponizeWindow.card?.name || '',
        iAmDefender: false,
        myWeaponizeCards: [],
      } : null,
      governInfo: gs.governState ? {
        mode: gs.governState.mode,
        step: gs.governState.step,
        totalTargets: gs.governState.targets.length,
        currentTargetIdx: gs.governState.targets[gs.governState.step] ?? -1,
        allHands: gs.players.map((p, pi) => ({ playerIdx: pi, hand: p.hand })),
        taken: gs.governState.taken,
      } : null,
      pendingError: null,
      // Observers see full hands for every player
      players: gs.players.map((gpl, pi) => ({
        name: room.players[pi].name,
        color: room.players[pi].color,
        handCount: gpl.hand.length,
        hand: gpl.hand,
        played: gpl.played,
        isBlocked: gs.actionObjActive && gs.actionObjBlockedPlayer === pi,
        isProtected: bcIsProtected(gs, pi),
        isBot: !!room.players[pi].isBot,
      })),
    });
  }

  // Clear one-shot error after broadcasting
  gs.pendingError = null;

  // Bot inactivity watchdog — resets on every state broadcast.
  // If a bot is in 'play' phase and 3s pass with no further state change
  // (e.g. stuck after Respond cancels attack, Weaponize cancels card, or
  // Data Flag is revealed), force-end the turn so the game doesn't freeze.
  clearTimeout(room._bcBotWatchdog);
  if (gs.phase === 'play' && gs.winner < 0) {
    const botIdx = gs.currentPlayer;
    if (room.players[botIdx]?.isBot) {
      room._bcBotWatchdog = setTimer(() => {
        if (gs.phase === 'play' && gs.currentPlayer === botIdx && gs.winner < 0) {
          console.log(`[Bot watchdog] ${room.players[botIdx]?.name} inactive 3 s — forcing end_play_phase`);
          room._bcBotRunning = false;
          bcHandleAction(room, botIdx, { type: 'game_action', action: 'end_play_phase' });
        }
      }, 3000);
    }
  }

  // Notify event organizers of status changes (in_progress → completed on game_over)
  if (room.isEventRoom) sendEventStatus(room);
}

// sendEventStatus reference — will be set by game-manager via init or accessed via closure
let _sendEventStatus;
function setSendEventStatus(fn) { _sendEventStatus = fn; }
function sendEventStatus(room) { if (_sendEventStatus) _sendEventStatus(room); }

function bcDrawOne(room, playerIdx) {
  const gs = room.bcState;
  if (gs.deck.length === 0) return 'empty';
  const card = gs.deck.shift();
  if (card.type === 'times_up') {
    gs.timesUpRevealed = true;
    bcLog(room, `<span class="lb lb-time">TIME</span> Times Up revealed! Any player holding the Data Flag can now win.`);
    for (let i = 0; i < gs.players.length; i++) {
      if (bcCheckWin(room, i) === 1) {
        gs.winner = i; gs.winCondition = 1; gs.phase = 'game_over';
        bcLog(room, `<span class="lb lb-win">WIN</span> ${room.players[i].name} wins! (Data Flag + Times Up)`);
        { const m = room.players.some(p=>p.isBot)?'1p_bot':room.players.length===2?'2p':room.players.length===3?'3p':'4p'; const dur=room.sessionStartedAt?Math.round((Date.now()-room.sessionStartedAt)/1000):null; _trackEvent('session_completed',{gameType:'byteclub',mode:m,uvKey:room.uvKey||'',duration:dur}); }
        return 'game_over';
      }
    }
    return 'times_up';
  }
  if (card.type === 'data_flag') {
    gs.players[playerIdx].hand.push(card);
    bcLog(room, `<span class="lb lb-flag">FLAG</span> ${room.players[playerIdx].name} drew the Data Flag!`);
    if (gs.timesUpRevealed && bcCheckWin(room, playerIdx) === 1) {
      gs.winner = playerIdx; gs.winCondition = 1; gs.phase = 'game_over';
      bcLog(room, `🏆 ${room.players[playerIdx].name} wins! (Data Flag + Times Up)`);
      { const m = room.players.some(p=>p.isBot)?'1p_bot':room.players.length===2?'2p':room.players.length===3?'3p':'4p'; const dur=room.sessionStartedAt?Math.round((Date.now()-room.sessionStartedAt)/1000):null; _trackEvent('session_completed',{gameType:'byteclub',mode:m,uvKey:room.uvKey||'',duration:dur}); }
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
  const timer = setTimer(() => {
    if (gs.weaponizeWindow === ww) {
      gs.weaponizeWindow = null;
      gs.phase = 'play';  // reset before resolveCb so Protect/Recover land in 'play'; Detect/Identify override it
      resolveCb();
      // Re-trigger bot only for sub-phases (detect_view, identify_choosing) that resolveCb opened.
      // If phase stayed 'play', bcFinishPlay (called inside resolveCb) already scheduled the re-trigger.
      if (room.players[playerIdx]?.isBot && gs.currentPlayer === playerIdx && gs.phase !== 'play') {
        room._bcBotRunning = false;
        setTimer(() => bcBotContinueTurn(room, playerIdx), 50);
      }
    }
  }, 8000);
  ww._timer = timer;
  bcBroadcastState(room);
  // Bot opponents: auto-play Weaponize if they have it (after 1-2s), else pass after 2s
  gs.players.forEach((opl, i) => {
    if (i === playerIdx || !room.players[i]?.isBot) return;
    const wc = opl.hand.find(c => c.type === 'weaponize');
    setTimer(() => {
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
    setTimer(() => {
      if (gs.weaponizeWindow === ww) {
        clearTimeout(ww._timer);
        gs.weaponizeWindow = null;
        gs.phase = 'play';  // reset before resolveCb (same fix as 8s timer path)
        resolveCb();
        // Same rule: only re-trigger bot for sub-phases; bcFinishPlay handles play-phase re-trigger
        if (room.players[playerIdx]?.isBot && gs.currentPlayer === playerIdx && gs.phase !== 'play') {
          room._bcBotRunning = false;
          setTimer(() => bcBotContinueTurn(room, playerIdx), 50);
        }
      }
    }, 1500);
  }
}

function bcResolveRecon(room, st) {
  const gs = room.bcState;
  gs.phase = 'attack_recon_choose';
  bcLog(room, `Recon resolved — ${room.players[st.attacker].name} chooses: Look at hand or Swap attack cards.`);
  bcBroadcastState(room);
  if (room.players[st.attacker]?.isBot) {
    setTimer(() => {
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
    bcLog(room, `Exploit — ${room.players[st.target].name} has no cards to steal.`);
  } else {
    const randIdx = Math.floor(Math.random() * tgtPl.hand.length);
    const stolen = tgtPl.hand.splice(randIdx, 1)[0];
    gs.players[st.attacker].hand.push(stolen);
    bcLog(room, `${room.players[st.attacker].name} blindly stole ${stolen.name} from ${room.players[st.target].name}!`);
  }
  const attacker = st.attacker;
  gs.attackState = null; gs.phase = 'play';
  bcFinishPlay(room, attacker);
}

function bcBotGovern(room, playerIdx) {
  const gs = room.bcState;
  setTimer(() => {
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
  bcLog(room, `${room.players[st.target].name} is blocked from playing defend cards until their next turn (Installation)!`);
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
    bcLog(room, `Delivery — no cards on the table to swap.`);
    gs.attackState = null; gs.phase = 'play';
    bcFinishPlay(room, st.attacker);
    return;
  }
  gs.phase = 'attack_delivery_pick';
  bcLog(room, `Delivery resolved — ${room.players[st.attacker].name} picks up to 2 card swaps.`);
  gs.attackState.swaps = [];
  gs.attackState.pickStep = null;
  bcBroadcastState(room);
  // 15-second auto-resolve for non-bots (safety net)
  const snapAtk = gs.attackState;
  setTimer(() => {
    if (gs.phase === 'attack_delivery_pick' && gs.attackState === snapAtk) {
      bcLog(room, `Delivery timed out — resolving with ${snapAtk.swaps.length} swap(s).`);
      bcExecuteDelivery(room);
    }
  }, 120000);
  if (room.players[st.attacker]?.isBot) {
    setTimer(() => {
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
    bcLog(room, `Delivery swap: ${swap.myCard.name} ↔ ${room.players[swap.theirIdx].name}'s ${swap.theirCard.name}`);
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
    bcLog(room, `C2 resolved — ${room.players[target].name} had the Data Flag and gave it to ${room.players[attacker].name}!`);
    gs.attackState = null;
    gs.phase = 'play';
    bcFinishPlay(room, attacker);
  } else if (tgtPl.hand.length > 0) {
    // TARGET picks which card from their own hand to give
    gs.phase = 'attack_c2_give';
    bcLog(room, `C2 — ${room.players[target].name} must give a card of their choice to ${room.players[attacker].name}.`);
    bcBroadcastState(room);
    if (room.players[target]?.isBot) {
      setTimer(() => {
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
    bcLog(room, `C2 — ${room.players[target].name} has no cards to give.`);
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
    bcLog(room, `<span class="lb lb-win">WIN</span> ${room.players[playerIdx].name} wins!`);
    { const m = room.players.some(p=>p.isBot)?'1p_bot':room.players.length===2?'2p':room.players.length===3?'3p':'4p'; const dur=room.sessionStartedAt?Math.round((Date.now()-room.sessionStartedAt)/1000):null; _trackEvent('session_completed',{gameType:'byteclub',mode:m,uvKey:room.uvKey||'',duration:dur}); }
  }
  bcBroadcastState(room);
  // Re-trigger bot if it's still their turn in play phase.
  // Deferred 50ms so any synchronous call stack (e.g. weaponize resolveCb) fully
  // unwinds first — prevents bcBotContinueTurn from opening a new weaponize window
  // before the timer callback's own post-resolveCb log line executes.
  if (!w && gs.phase === 'play' && gs.currentPlayer === playerIdx && room.players[playerIdx]?.isBot) {
    room._bcBotRunning = false;
    setTimer(() => {
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
          bcLog(room, `${room.players[playerIdx].name} plays Govern — no other players have cards.`);
          bcFinishPlay(room, playerIdx);
          return;
        }
        gs.governState = { viewer: playerIdx, targets: govTargets, step: 0, mode: 'take', taken: [] };
        gs.phase = 'govern_take';
        bcLog(room, `${room.players[playerIdx].name} plays Govern — privately viewing all hands and taking one card from each player.`);
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
          bcLog(room, `${room.players[playerIdx].name} plays Action Objectives — ${room.players[dfHolder].name} must give up the Data Flag!`);
        } else if (dfHolder === playerIdx) {
          bcLog(room, `${room.players[playerIdx].name} plays Action Objectives — they already hold the Data Flag!`);
        } else {
          bcLog(room, `${room.players[playerIdx].name} plays Action Objectives — the Data Flag is not in anyone's hand (fizzles).`);
        }
        bcFinishPlay(room, playerIdx); return;
      }

      // ── IDENTIFY ──
      if (card.type === 'identify') {
        pl.played.push(card);
        bcLog(room, `${room.players[playerIdx].name} plays Identify — choose to Swap defend cards or reveal the Data Flag.`);
        return bcOpenWeaponizeWindow(room, playerIdx, card, () => {
          gs.phase = 'identify_choosing';
          gs.identifyState = { chooser: playerIdx };
          bcBroadcastState(room);
        });
      }

      // ── PROTECT ──
      if (card.type === 'protect') {
        pl.played.push(card);
        bcLog(room, `${room.players[playerIdx].name} plays Protect — cannot be targeted by attack effects until their next turn.`);
        return bcOpenWeaponizeWindow(room, playerIdx, card, () => {
          gs.protectedUntilTurn[playerIdx] = true;
          bcFinishPlay(room, playerIdx);
        });
      }

      // ── DETECT ──
      if (card.type === 'detect') {
        pl.played.push(card);
        bcLog(room, `${room.players[playerIdx].name} plays Detect — viewing top 5 cards of the deck.`);
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
        bcLog(room, `${room.players[playerIdx].name} plays Respond — can be used to counter attack card effects.`);
        bcFinishPlay(room, playerIdx); return;
      }

      // ── RECOVER ──
      if (card.type === 'recover') {
        pl.played.push(card);
        bcLog(room, `${room.players[playerIdx].name} plays Recover — drawing up to 5 cards, skipping end-of-turn draw.`);
        return bcOpenWeaponizeWindow(room, playerIdx, card, () => {
          const needed = Math.max(0, 5 - pl.hand.length);
          let drew = 0;
          for (let i = 0; i < needed && gs.deck.length > 0; i++) {
            const r = bcDrawOne(room, playerIdx);
            if (r === 'game_over') { bcBroadcastState(room); return; }
            drew++;
          }
          gs.recoverActive = true;
          bcLog(room, `${room.players[playerIdx].name} drew ${drew} card(s) via Recover.`);
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
            bcLog(room, `<span class="lb lb-warn">!</span> ${room.players[playerIdx].name} plays ${card.name} — no valid targets (all opponents are Protected). Effect cancelled.`);
            bcFinishPlay(room, playerIdx);
            return;
          }
          gs.attackState = { type: card.type, attacker: playerIdx, card, swaps: [], pickStep: null };
          gs.phase = targetPhase;
          bcLog(room, `${room.players[playerIdx].name} plays ${card.name} [${card.type}] — choose a target.`);
          bcBroadcastState(room);
          if (room.players[playerIdx]?.isBot) { room._bcBotRunning = false; bcBotContinueTurn(room, playerIdx); }
          return;
        }
        // Weaponize: collection only (its power is played out-of-turn via play_weaponize)
        bcLog(room, `${room.players[playerIdx].name} plays ${card.name} [Weaponize] — can cancel defend card effects out of turn.`);
        bcFinishPlay(room, playerIdx); break;
      }

      // ── Defend card — check install block ──
      if (gs.installBlocked[playerIdx]) {
        // Put card back in hand
        pl.hand.push(card);
        gs.pendingError = { playerIdx, message: `⚙️ You cannot play defend cards this turn — Installation is blocking you until the start of your next turn.` };
        bcLog(room, `<span class="lb lb-block">blocked</span> ${room.players[playerIdx].name} is blocked from playing defend cards this turn (Installation)!`);
        bcBroadcastState(room); return;
      }

      // ── Generic defend card ──
      pl.played.push(card);
      bcLog(room, `${room.players[playerIdx].name} plays ${card.name}`);
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
        bcLog(room, `${room.players[playerIdx].name} plays Action Objectives — ${room.players[dfHolder].name} must give up the Data Flag!`);
      } else if (dfHolder === playerIdx) {
        bcLog(room, `${room.players[playerIdx].name} plays Action Objectives — they already hold the Data Flag!`);
      } else {
        bcLog(room, `${room.players[playerIdx].name} plays Action Objectives — the Data Flag is not in anyone's hand (fizzles).`);
      }
      bcFinishPlay(room, playerIdx); break;
    }

    // ===== CANCEL ATTACK (human safety valve when no valid targets) =====
    case 'cancel_attack': {
      const cancelPhases = ['attack_c2_target','attack_recon_target','attack_exploit_target','attack_install_target','attack_delivery_target'];
      if (!cancelPhases.includes(gs.phase) || gs.attackState?.attacker !== playerIdx) return;
      bcLog(room, `<span class="lb lb-block">cancelled</span> ${room.players[playerIdx].name} cancels their attack — no valid target.`);
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
      bcLog(room, `${room.players[playerIdx].name} plays Weaponize — ${gs.weaponizeWindow.card?.name || 'defend card'} effect cancelled!`);
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
        bcLog(room, `<span class="lb lb-block">protected</span> ${room.players[tgt].name} is Protected — cannot be targeted!`);
        bcBroadcastState(room); return;
      }
      gs.attackState.target = tgt;
      gs.phase = 'attack_respond_window';
      bcLog(room, `${room.players[playerIdx].name} targets ${room.players[tgt].name} — Respond to cancel?`);
      bcBroadcastState(room);
      // Auto-resolve for bot target
      if (room.players[tgt]?.isBot) {
        setTimer(() => {
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
        setTimer(() => {
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
      bcLog(room, `${room.players[playerIdx].name} plays Respond — ${gs.attackState.cardName || 'attack'} effect cancelled!`);
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
        bcLog(room, `${room.players[playerIdx].name} looks at ${room.players[gs.attackState.target].name}'s hand.`);
        bcBroadcastState(room);
        // Auto-dismiss after 10s
        setTimer(() => {
          if (gs.phase === 'attack_recon_look' && gs.attackState?.attacker === playerIdx) {
            gs.attackState = null; gs.phase = 'play'; bcFinishPlay(room, playerIdx);
          }
        }, 10000);
      } else {
        gs.phase = 'attack_recon_swap_my';
        bcLog(room, `${room.players[playerIdx].name} chooses to swap attack cards.`);
        bcBroadcastState(room);
        // Bot auto-picks swap-my card
        if (room.players[playerIdx]?.isBot) {
          setTimer(() => {
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
        setTimer(() => {
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
      bcLog(room, `${room.players[playerIdx].name} swapped ${st.reconSwapMyCard.name} for ${room.players[tgt].name}'s ${theirCard.name}.`);
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
      bcLog(room, `Swap ${gs.attackState.swaps.length}: ${gs.attackState.pickStep?.myCard?.name||'card'} ↔ ${theirCard.name}`);
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
      bcLog(room, `C2 resolved — ${room.players[playerIdx].name} gave ${given.name} to ${room.players[att].name}.`);
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
      bcLog(room, `${room.players[playerIdx].name} takes a card from ${room.players[fromIdx].name}.`);
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
      bcLog(room, `${room.players[playerIdx].name} gives a card to ${room.players[toIdx].name}.`);
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
          bcLog(room, `Data Flag reveal — ${room.players[dfHolder].name} is holding the Data Flag!`);
        } else if (dfInDeck) {
          bcLog(room, `Data Flag reveal — the Data Flag is still in the deck.`);
        } else {
          bcLog(room, `Data Flag reveal — the Data Flag has not yet been drawn.`);
        }
        bcBroadcastState(room);
        // Auto-dismiss for bot chooser
        if (room.players[playerIdx]?.isBot) {
          setTimer(() => {
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
        bcLog(room, `Swap chosen — ${room.players[playerIdx].name} selects one of their played defend cards to swap.`);
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
        bcLog(room, `<span class="lb lb-block">fizzled</span> ${room.players[tgt].name} has no swappable defend cards${tgtProtected ? ' (Protect is active)' : ''}.`);
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
        bcLog(room, `<span class="lb lb-block">blocked</span> ${room.players[tgt].name}'s Protect card is currently active — it cannot be swapped.`);
        bcBroadcastState(room); return;
      }
      // Execute swap: remove my card from my played, add their card; vice versa
      pl.played = pl.played.filter(c => c.id !== id.swapMyCard.id);
      gs.players[tgt].played = gs.players[tgt].played.filter(c => c.id !== theirCard.id);
      pl.played.push({ ...theirCard });
      gs.players[tgt].played.push({ ...id.swapMyCard });
      bcLog(room, `${room.players[playerIdx].name} swapped ${id.swapMyCard.name} for ${room.players[tgt].name}'s ${theirCard.name}.`);
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
      bcLog(room, `${room.players[playerIdx].name} rearranged the top of the deck.`);
      gs.detectView = null; gs.phase = 'play';
      bcFinishPlay(room, playerIdx); break;
    }
  }
}

module.exports = {
  init,
  setSendEventStatus,
  initBCGame,
  bcHandleAction,
  bcBroadcastState,
  bcEndTurn,
  executeBCBotTurn,
  bcBotContinueTurn,
};
