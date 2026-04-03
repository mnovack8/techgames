#!/usr/bin/env node
// ============================================================
// Full 4-player Byte Club game simulation
// 4 WebSocket clients, all controlled by this script
// ============================================================

const WebSocket = require('ws');
const HOST    = 'ws://localhost:8090';
const DELAY   = 300; // ms before each action

const gameLog = [];
const issues  = [];
let gameOver  = false;
let stuckTimer = null;

const ts    = () => new Date().toISOString().slice(11, 23);
const note  = (m) => console.log(`[${ts()}] ${m}`);
const bug   = (m) => { issues.push(m); console.error(`[${ts()}] ⚠️  BUG: ${m}`); };
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const pick  = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ── Stuck-game watchdog ───────────────────────────────────────
function resetStuck(phase, cp) {
  if (stuckTimer) clearTimeout(stuckTimer);
  stuckTimer = setTimeout(() => {
    if (!gameOver) bug(`Stuck 18s at phase="${phase}" currentPlayer=${cp}`);
  }, 18000);
}

// ── Build one WS client ───────────────────────────────────────
function makeClient(name) {
  return new Promise((res, rej) => {
    const ws  = new WebSocket(HOST);
    const c = {
      name, ws,
      roomCode: null, playerId: null,
      // per-turn tracking
      _lastCP: -1, _playedThisTurn: false, _actTimer: null, _lastActAt: 0,
    };
    c.send = (obj)  => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
    c.act  = (act, extra = {}) => c.send({ type: 'game_action', action: act, ...extra });
    ws.on('error', rej);
    ws.on('open',  () => res(c));
  });
}

// ── Core decision engine (msg = raw bc_state message) ────────
function decide(client, msg) {
  if (gameOver) return;

  const me  = msg.myIndex;
  const ph  = msg.phase;
  const cp  = msg.currentPlayer;
  const ai  = msg.attackInfo;    // attackInfo
  const ii  = msg.identifyInfo;  // identifyInfo
  const dv  = msg.detectViewCards; // array or null
  const wi  = msg.weaponizeInfo; // weaponize window info
  const gv  = msg.governView;    // govern viewing info (only for viewer)

  resetStuck(ph, cp);

  // Debounce rapid re-broadcasts
  if (Date.now() - client._lastActAt < 200) return;

  // ── Phases where I'm the active player ────────────────────
  if (cp === me) {
    // Reset per-turn play flag when it becomes my turn
    if (cp !== client._lastCP) {
      client._lastCP        = cp;
      client._playedThisTurn = false;
    }

    switch (ph) {

      // ── Play phase ──
      case 'play': {
        const hand     = msg.myHand || [];
        const playable = hand.filter(c =>
          c.type !== 'data_flag' && c.type !== 'action_obj' && c.type !== 'weaponize'
        );
        if (!client._playedThisTurn) {
          if (playable.length > 0) {
            const card = pick(playable);
            note(`  ${client.name} ▶ plays ${card.name} [${card.type}]`);
            client._playedThisTurn = true;
            client._lastActAt = Date.now();
            client.act('play_card', { cardId: card.id });
          } else {
            note(`  ${client.name} ▶ end turn (nothing to play)`);
            client._lastActAt = Date.now();
            client.act('end_play_phase');
          }
        } else {
          note(`  ${client.name} ▶ end turn`);
          client._lastActAt = Date.now();
          client.act('end_play_phase');
        }
        break;
      }

      // ── Discard ──
      case 'discard': {
        const hand  = msg.myHand || [];
        const cards = hand.filter(c => c.type !== 'data_flag');
        if (cards.length > 0) {
          const card = pick(cards);
          note(`  ${client.name} ▶ discards ${card.name}`);
          client._lastActAt = Date.now();
          client.act('discard_card', { cardId: card.id });
        } else if (hand.length > 0) {
          // Only data_flag? Shouldn't happen but handle gracefully
          bug(`${client.name} forced to discard Data Flag!`);
        }
        break;
      }

      // ── Attack targeting ──
      case 'attack_c2_target':
      case 'attack_recon_target':
      case 'attack_exploit_target':
      case 'attack_install_target':
      case 'attack_delivery_target': {
        if (!ai || ai.attacker !== me) break;
        const plrs = msg.players || [];
        const validTargets = plrs
          .map((p, i) => ({ i, p }))
          .filter(({ i, p }) => i !== me && !p.isProtected);
        if (validTargets.length === 0) {
          note(`  ${client.name} ▶ no valid targets, end turn`);
          client._lastActAt = Date.now();
          client.act('end_play_phase');
          break;
        }
        const t = pick(validTargets);
        note(`  ${client.name} ▶ targets player ${t.i} (${t.p.name})`);
        client._lastActAt = Date.now();
        client.act('attack_select_target', { targetIdx: t.i });
        break;
      }

      // ── Recon: choose look or swap ──
      case 'attack_recon_choose': {
        if (!ai || ai.attacker !== me) break;
        const tgt      = ai.target;
        const plrs     = msg.players || [];
        const myAtk    = (plrs[me]?.played || []).filter(c => c.cat === 'attack');
        const theirAtk = (plrs[tgt]?.played || []).filter(c => c.cat === 'attack');
        const canSwap  = myAtk.length > 0 && theirAtk.length > 0;
        const choice   = canSwap && Math.random() < 0.5 ? 'swap' : 'look';
        note(`  ${client.name} ▶ recon: ${choice}`);
        client._lastActAt = Date.now();
        client.act('recon_choice', { choice });
        break;
      }

      case 'attack_recon_look': {
        if (!ai || ai.attacker !== me) break;
        note(`  ${client.name} ▶ recon look done`);
        client._lastActAt = Date.now();
        client.act('recon_look_done');
        break;
      }

      case 'attack_recon_swap_my': {
        if (!ai || ai.attacker !== me) break;
        const mine = (msg.players?.[me]?.played || []).filter(c => c.cat === 'attack');
        if (mine.length > 0) {
          client._lastActAt = Date.now();
          client.act('recon_swap_my', { cardId: pick(mine).id });
        }
        break;
      }

      case 'attack_recon_swap_their': {
        if (!ai || ai.attacker !== me) break;
        const tgt    = ai.target;
        const theirs = (msg.players?.[tgt]?.played || []).filter(c => c.cat === 'attack');
        if (theirs.length > 0) {
          client._lastActAt = Date.now();
          client.act('recon_swap_their', { cardId: pick(theirs).id });
        }
        break;
      }

      // ── Delivery ──
      case 'attack_delivery_pick': {
        if (!ai || ai.attacker !== me) break;
        if (!ai.deliveryPickStep) {
          // Step 1: pick one of my played cards
          const mine = msg.players?.[me]?.played || [];
          if (mine.length === 0) {
            // Can't pick anything — skip if already have swaps
            if ((ai.deliverySwaps || []).length > 0) {
              client._lastActAt = Date.now();
              client.act('delivery_done');
            }
            break;
          }
          client._lastActAt = Date.now();
          client.act('delivery_pick_mine', { cardId: pick(mine).id });
        } else {
          // Step 2: pick a target + their card
          const plrs = msg.players || [];
          const opps = plrs
            .map((p, i) => ({ i, played: p.played || [] }))
            .filter(({ i, played }) => i !== me && played.length > 0);
          if (opps.length === 0) {
            // No one to swap with — call done
            client._lastActAt = Date.now();
            client.act('delivery_done');
            break;
          }
          const opp  = pick(opps);
          const card = pick(opp.played);
          client._lastActAt = Date.now();
          client.act('delivery_pick_theirs', { targetIdx: opp.i, cardId: card.id });
        }
        break;
      }

      // ── Identify: choose option ──
      case 'identify_choosing': {
        if (!ii || ii.chooser !== me) break;
        const plrs   = msg.players || [];
        const myDef  = (plrs[me]?.played || []).filter(c => c.cat === 'defend');
        const oppsDef = plrs
          .map((p, i) => ({ i, played: (p.played || []).filter(c => c.cat === 'defend') }))
          .filter(({ i, played }) => i !== me && played.length > 0);
        const canSwap = myDef.length > 0 && oppsDef.length > 0;
        const choice  = canSwap && Math.random() < 0.4 ? 'swap' : 'dataflag';
        note(`  ${client.name} ▶ identify: ${choice}`);
        client._lastActAt = Date.now();
        client.act('identify_choice', { choice });
        break;
      }

      // ── Identify: dataflag was revealed — dismiss ──
      case 'identify_dataflag': {
        if (!ii || ii.chooser !== me) break;
        note(`  ${client.name} ▶ identify dataflag seen — done`);
        client._lastActAt = Date.now();
        client.act('identify_dataflag_done');
        break;
      }

      // ── Identify swap: pick MY defend card ──
      case 'identify_swap_my': {
        if (!ii || ii.chooser !== me) break;
        const myDef = (msg.players?.[me]?.played || []).filter(c => c.cat === 'defend');
        if (myDef.length > 0) {
          client._lastActAt = Date.now();
          client.act('identify_swap_my', { cardId: pick(myDef).id });
        }
        break;
      }

      // ── Identify swap: pick TARGET player ──
      case 'identify_swap_target': {
        if (!ii || ii.chooser !== me) break;
        const plrs   = msg.players || [];
        const opps   = plrs
          .map((p, i) => ({ i, played: (p.played || []).filter(c => c.cat === 'defend') }))
          .filter(({ i, played }) => i !== me && played.length > 0 && !plrs[i].isProtected);
        if (opps.length > 0) {
          const opp = pick(opps);
          client._lastActAt = Date.now();
          client.act('identify_swap_target', { targetIdx: opp.i });
        }
        break;
      }

      // ── Identify swap: pick THEIR defend card ──
      case 'identify_swap_their': {
        if (!ii || ii.chooser !== me) break;
        const tgt    = ii.swapTargetIdx;
        const theirs = (msg.players?.[tgt]?.played || []).filter(c => c.cat === 'defend');
        if (theirs.length > 0) {
          client._lastActAt = Date.now();
          client.act('identify_swap_their', { cardId: pick(theirs).id });
        }
        break;
      }

      // ── Detect: view & reorder top 5 ──
      case 'detect_view': {
        if (!dv) break; // not my detect
        // Keep same order (no reorder) — send card IDs in original order
        const order = dv.map(c => c.id);
        note(`  ${client.name} ▶ detect done (${dv.length} cards, no reorder)`);
        client._lastActAt = Date.now();
        client.act('detect_reorder', { order });
        break;
      }

      // ── Govern: pick who to view ──
      case 'govern_select': {
        const plrs = msg.players || [];
        const tgts = plrs.map((p, i) => i).filter(i => i !== me);
        if (tgts.length > 0) {
          const t = pick(tgts);
          note(`  ${client.name} ▶ govern: view player ${t}`);
          client._lastActAt = Date.now();
          client.act('govern_select', { targetIdx: t });
        }
        break;
      }

      // ── Govern: done viewing ──
      case 'govern_viewing': {
        if (!gv) break; // not my govern session
        note(`  ${client.name} ▶ govern done`);
        client._lastActAt = Date.now();
        client.act('govern_done');
        break;
      }
    }
  }

  // ── Phases where I'm involved as a NON-active participant ──

  // Respond window: I'm the target
  if (ph === 'attack_respond_window' && ai?.target === me) {
    const respondCards = ai.myRespondCards || [];
    if (respondCards.length > 0 && Math.random() < 0.3) {
      note(`  ${client.name} ▶ RESPONDS (cancel attack)!`);
      client._lastActAt = Date.now();
      client.act('play_respond', { cardId: respondCards[0].id });
    } else {
      note(`  ${client.name} ▶ skip respond`);
      client._lastActAt = Date.now();
      client.act('respond_skip');
    }
    return;
  }

  // C2 give: I'm the target, must give a card
  if (ph === 'attack_c2_give' && ai?.target === me) {
    const hand     = msg.myHand || [];
    const giveable = hand.filter(c => c.type !== 'data_flag');
    if (giveable.length > 0) {
      const card = pick(giveable);
      note(`  ${client.name} ▶ gives ${card.name} (C2)`);
      client._lastActAt = Date.now();
      client.act('attack_c2_give_card', { cardId: card.id });
    } else {
      bug(`${client.name} is C2 target but has no non-DataFlag cards to give!`);
    }
    return;
  }

  // Weaponize window: I'm NOT the defender
  if (ph === 'weaponize_window' && wi && wi.defender !== me) {
    const wCards = wi.myWeaponizeCards || [];
    if (wCards.length > 0 && Math.random() < 0.25) {
      note(`  ${client.name} ▶ WEAPONIZES (cancel ${wi.cardName})!`);
      client._lastActAt = Date.now();
      client.act('play_weaponize', { cardId: wCards[0].id });
    }
    return;
  }
}

// ── Main ─────────────────────────────────────────────────────
async function main() {
  note('════════════════════════════════════════════');
  note('   4-Player Byte Club Simulation Test');
  note('════════════════════════════════════════════');

  const specs = [
    { name: 'Blue',   color: 'blue'   },
    { name: 'Red',    color: 'red'    },
    { name: 'Green',  color: 'green'  },
    { name: 'Purple', color: 'purple' },
  ];

  const clients = await Promise.all(specs.map(s => makeClient(s.name)));
  note('All 4 clients connected.');

  // ── Attach handlers ────────────────────────────────────────
  clients.forEach(client => {
    client.ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'room_created':
          client.roomCode = msg.code;
          client.playerId = msg.yourId;
          note(`${client.name} created room ${msg.code}`);
          break;

        case 'room_joined':
          client.roomCode = msg.code;
          client.playerId = msg.yourId;
          note(`${client.name} joined as player ${msg.yourId}`);
          break;

        case 'bc_game_started':
          note(`${client.name} — game started!`);
          break;

        case 'error':
          // Flag unexpected errors; suppress common "not your turn" rejections
          if (!['Not in a room', 'Not your turn', 'Already started'].includes(msg.msg)) {
            note(`${client.name} server msg: "${msg.msg}"`);
          }
          break;

        case 'bc_state': {
          // Capture new log lines
          if (msg.log) {
            const newLines = msg.log.slice(gameLog.length);
            newLines.forEach(l => note(`    📋 ${l}`));
            msg.log.forEach((l, i) => { gameLog[i] = l; });
          }

          // Game over
          if (msg.phase === 'game_over' && !gameOver) {
            gameOver = true;
            if (stuckTimer) clearTimeout(stuckTimer);
            note(`\n🏆 GAME OVER`);
            note(`   Winner   : ${specs[msg.winner]?.name ?? '?'} (player ${msg.winner})`);
            note(`   Condition : ${msg.winCondition}`);
            printSummary(msg, specs);
            setTimeout(() => process.exit(0), 300);
            return;
          }

          // Schedule action
          if (client._actTimer) clearTimeout(client._actTimer);
          client._actTimer = setTimeout(() => decide(client, msg), DELAY);
          break;
        }
      }
    });
  });

  // ── Step 1: Create room ────────────────────────────────────
  clients[0].send({ type: 'create_room', color: 'blue', gameType: 'byteclub' });
  await delay(600);

  const code = clients[0].roomCode;
  if (!code) { console.error('No room code!'); process.exit(1); }
  note(`Room code: ${code}`);

  // ── Step 2: Others join ────────────────────────────────────
  for (let i = 1; i < clients.length; i++) {
    clients[i].send({ type: 'join_room', code, color: specs[i].color });
    await delay(350);
  }
  await delay(400);

  // ── Step 3: Start ──────────────────────────────────────────
  note('Starting 4-player game...');
  clients[0].send({ type: 'start_game' });

  // ── Global timeout ─────────────────────────────────────────
  setTimeout(() => {
    if (!gameOver) {
      bug('TIMEOUT — game did not complete within 120s');
      printSummary(null, specs);
      process.exit(1);
    }
  }, 120000);

  note('Simulation running...\n');
}

function printSummary(finalMsg, specs) {
  console.log('\n' + '═'.repeat(62));
  console.log('GAME SUMMARY');
  console.log('═'.repeat(62));
  if (finalMsg) {
    console.log(`Winner     : ${specs[finalMsg.winner]?.name} (${finalMsg.winCondition})`);
    console.log(`Turn count : ${finalMsg.turnNumber}`);
    console.log(`Deck left  : ${finalMsg.deckCount} cards`);
  }
  console.log(`\n─── Full Game Log (${gameLog.length} entries) ────────────────────`);
  gameLog.forEach((l, i) => console.log(`  ${String(i+1).padStart(3)}. ${l}`));
  console.log('\n─── Bugs / Issues Found ──────────────────────────────────');
  if (issues.length === 0) {
    console.log('  ✅ No bugs detected during this playthrough.');
  } else {
    issues.forEach((e, i) => console.log(`  ${i+1}. ⚠️  ${e}`));
  }
  console.log('═'.repeat(62));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
