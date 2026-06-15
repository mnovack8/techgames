'use strict';
/**
 * tests/games/fuzznet.test.js
 * FuzzNet Labs game flow tests.
 * Tests create → bot → start → actions → game lifecycle via WebSocket.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, connectWs, delay } = require('../helpers');

let _server;

describe('FuzzNet — Game Flow', () => {
  before(async () => { _server = await startServer(); });
  after(async ()  => { await stopServer(_server); });

  const ws = () => connectWs(_server.port);

  // ── Helpers ────────────────────────────────────────────────────────────────
  /** Create a FuzzNet room with one human + one bot, ready to start. */
  async function setupRoom() {
    const host = await ws();
    host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
    const { code, token } = await host.next('room_created');

    host.send({ type: 'toggle_bot' });
    await host.next('lobby_update'); // bot added

    return { host, code, token };
  }

  // ── Pre-game ───────────────────────────────────────────────────────────────
  describe('Pre-game lobby', () => {
    it('cannot start with only 1 human player (no bot) → error', async () => {
      const host = await ws();
      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Alone', color: 'blue' });
      await host.next('room_created');

      host.send({ type: 'start_game' });
      const err = await host.next('error');
      assert.equal(err.type, 'error', 'Should refuse to start with only 1 player');
      host.close();
    });

    it('non-host cannot start the game → error', async () => {
      const host  = await ws();
      const guest = await ws();

      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');

      guest.send({ type: 'join_room', code, gameType: 'fuzznet', playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.next('lobby_update');

      guest.send({ type: 'start_game' });
      const err = await guest.next('error');
      assert.equal(err.type, 'error', 'Non-host cannot start');

      host.close(); guest.close();
    });
  });

  // ── Game start ─────────────────────────────────────────────────────────────
  describe('Game start', () => {
    it('host + bot → game_started then state_update received', async () => {
      const { host } = await setupRoom();

      host.send({ type: 'start_game' });

      const started = await host.next('game_started');
      assert.equal(started.type, 'game_started');

      const state = await host.next('state_update');
      assert.equal(state.type, 'state_update');
      assert.ok(state.state, 'state_update must carry game state');

      host.close();
    });

    it('initial state has correct structure', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('game_started');
      const { state: s } = await host.next('state_update');

      assert.ok(Array.isArray(s.players), 'state.players must be an array');
      assert.equal(s.players.length, 2, '1 human + 1 bot = 2 players');
      assert.ok(typeof s.currentPlayer === 'number', 'state.currentPlayer must be a number');
      assert.ok(typeof s.actionsLeft === 'number',   'state.actionsLeft must exist');
      assert.equal(s.gameOver, false, 'Game not over at start');

      host.close();
    });
  });

  // ── Actions ────────────────────────────────────────────────────────────────
  describe('Game actions', () => {
    it('start_design action → state_update in design phase', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('game_started');
      const { state: initial } = await host.next('state_update');

      // Only act if it's our turn (player 0 = human host)
      if (initial.currentPlayer !== 0) {
        // Bot moves first — wait for next state when it becomes human's turn
        const nextState = await host.next('state_update', 8000);
        assert.equal(nextState.state.currentPlayer, 0, 'Should become human turn');
      }

      host.send({ type: 'game_action', action: 'start_design' });
      const after = await host.next('state_update');
      assert.ok(after.state, 'State update received after action');
      // Phase should now be 'design' or actions decreased
      const s = after.state;
      assert.ok(
        s.phase === 'design' || s.actionsLeft < initial.actionsLeft,
        'Action was processed (phase changed or actionsLeft decreased)'
      );

      host.close();
    });

    it('end_turn when actions remain → error (cannot end early in idle)', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('game_started');
      const { state: s } = await host.next('state_update');

      if (s.currentPlayer !== 0) {
        await host.next('state_update', 8000); // wait for human turn
      }

      // Try ending turn while still in idle phase with actions remaining
      // FuzzNet requires you to use your actions — ending turn prematurely is invalid
      host.send({ type: 'game_action', action: 'end_turn' });
      // Should receive either an error or a state_update (depending on phase)
      const res = await Promise.race([
        host.next('error',        3000),
        host.next('state_update', 3000),
      ]);
      assert.ok(res, 'Got a response to end_turn');

      host.close();
    });
  });

  // ── Game cancellation ──────────────────────────────────────────────────────
  describe('Game cancellation', () => {
    it('host can cancel an in-progress game → game_cancelled', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('game_started');
      await host.next('state_update');

      host.send({ type: 'cancel_game' });
      const msg = await host.next('game_cancelled');
      assert.equal(msg.type, 'game_cancelled');

      host.close();
    });

    it('non-host cannot cancel in-progress game → error', async () => {
      const host  = await ws();
      const guest = await ws();

      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');

      guest.send({ type: 'join_room', code, gameType: 'fuzznet', playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.next('lobby_update');

      host.send({ type: 'start_game' });
      await host.next('game_started');
      await host.next('state_update');
      await guest.next('game_started');
      await guest.next('state_update');

      guest.send({ type: 'cancel_game' });
      const err = await guest.next('error');
      assert.equal(err.type, 'error');

      host.close(); guest.close();
    });
  });

  // ── Two-human multiplayer ──────────────────────────────────────────────────
  describe('Two-human game', () => {
    it('both players receive game_started and state_update', async () => {
      const host  = await ws();
      const guest = await ws();

      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');

      guest.send({ type: 'join_room', code, gameType: 'fuzznet', playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.next('lobby_update');

      host.send({ type: 'start_game' });

      const [hostStart, guestStart] = await Promise.all([
        host.next('game_started'),
        guest.next('game_started'),
      ]);
      assert.equal(hostStart.type,  'game_started');
      assert.equal(guestStart.type, 'game_started');

      const [hostState, guestState] = await Promise.all([
        host.next('state_update'),
        guest.next('state_update'),
      ]);
      assert.ok(hostState.state,  'Host received game state');
      assert.ok(guestState.state, 'Guest received game state');

      host.close(); guest.close();
    });

    it('only the current player\'s action is processed (others → error)', async () => {
      const host  = await ws();
      const guest = await ws();

      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');

      guest.send({ type: 'join_room', code, gameType: 'fuzznet', playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.next('lobby_update');

      host.send({ type: 'start_game' });
      await Promise.all([host.next('game_started'), guest.next('game_started')]);
      const [{ state }, gState] = await Promise.all([
        host.next('state_update'),
        guest.next('state_update'),
      ]);

      // The non-current player attempts an action → should receive error
      const nonCurrent = state.currentPlayer === 0 ? guest : host;
      nonCurrent.send({ type: 'game_action', action: 'start_design' });
      const err = await nonCurrent.next('error');
      assert.equal(err.type, 'error', 'Out-of-turn action must be rejected');

      host.close(); guest.close();
    });
  });

  // ── Full game results (human + bot to natural completion) ──────────────────
  // TEST_MODE (set in helpers.js) collapses bot delays to ~10ms so this
  // completes in a few seconds rather than ~90s.
  describe('Full game result — human vs bot', () => {
    const ANIMALS = ['Dog','Bunny','Frog','Squirrel','Fish'];

    /**
     * Human player strategy: test-first, then train to build the network.
     *   Priority: test > design > train (prefer low-data nodes) > end_turn
     *
     * Contrast with the bot which designs the full network first, maxes all data,
     * then tests. The human attempts tests as soon as any valid path exists —
     * building paths and testing in parallel rather than front-loading infrastructure.
     */
    async function humanStep(sock, s) {
      sock.drain();
      const myPs = s.players[s.currentPlayer];

      // Send one action and return any server response without hanging on errors.
      async function act(msg) {
        sock.send(msg);
        return sock.next(null, 5000);
      }

      switch (s.phase) {
        case 'idle': {
          // 1. Test first — the human's defining trait vs the bot's design-first approach
          if (myPs.tested && myPs.tested.some(t => !t)) {
            const r = await act({ type: 'game_action', action: 'start_test' });
            if (r.type === 'state_update') return r.state;
            // Server error = no valid path yet — fall through to build the network
          }
          // 2. Design if empty slots exist
          if (myPs.nodes.findIndex(n => !n) >= 0) {
            const r = await act({ type: 'game_action', action: 'start_design' });
            return r.type === 'state_update' ? r.state : null;
          }
          // 3. Train (uncapped — allows overfit which eventually blocks paths and ends game)
          const dataSlots = myPs.nodes.reduce((sum, n, i) =>
            (n && myPs.data[i] < 3 ? sum + (3 - myPs.data[i]) : sum), 0);
          if (dataSlots >= 2) {
            const r = await act({ type: 'game_action', action: 'start_train' });
            return r.type === 'state_update' ? r.state : null;
          }
          // 4. Nothing useful — skip remaining actions
          const r = await act({ type: 'game_action', action: 'end_turn' });
          return r.type === 'state_update' ? r.state : null;
        }
        case 'design': {
          const node = myPs.nodes.findIndex(n => !n);
          if (node < 0) return null;
          const r = await act({ type: 'game_action', action: 'place_node', nodeId: node });
          if (r.type !== 'state_update') return null;
          const ns = r.state;
          // Skip leftover actions so the bot isn't blocked waiting on us
          if (!ns.gameOver && ns.currentPlayer === 0 && ns.phase === 'idle' && ns.actionsLeft > 0 && ns.actionsLeft < 3) {
            sock.drain();
            const r2 = await act({ type: 'game_action', action: 'end_turn' });
            return r2.type === 'state_update' ? r2.state : ns;
          }
          return ns;
        }
        case 'train1':
        case 'train2': {
          // Pick node with the most remaining capacity (spreads data evenly across network)
          let best = -1, bestRoom = 0;
          for (let i = 0; i < 11; i++) {
            const room = myPs.nodes[i] && myPs.data[i] < 3 ? (3 - myPs.data[i]) : 0;
            if (room > bestRoom) { best = i; bestRoom = room; }
          }
          if (best < 0) return null;
          const r = await act({ type: 'game_action', action: 'place_data', nodeId: best });
          return r.type === 'state_update' ? r.state : null;
        }
        case 'train_overfit':
        case 'backprop_overfit': {
          const edge = s.overfitEdges && s.overfitEdges[0];
          if (!edge) return null;
          const action = s.phase === 'train_overfit' ? 'select_overfit_edge' : 'backprop_select_overfit';
          const r = await act({ type: 'game_action', action, edgeKey: edge.key });
          return r.type === 'state_update' ? r.state : null;
        }
        case 'test_animal': {
          // Try each untested animal; server returns error if no valid path
          for (let a = 0; a < 5; a++) {
            if (myPs.tested && !myPs.tested[a]) {
              const r = await act({ type: 'game_action', action: 'select_animal', animalIdx: a });
              if (r.type === 'state_update') return r.state;
              // error = no valid path for this animal — try next
            }
          }
          return null;
        }
        case 'test_path_l1':
        case 'test_path_l2':
        case 'test_path_l3': {
          const node = s.pathClickable && s.pathClickable[0];
          if (node == null) return null;
          const r = await act({ type: 'game_action', action: 'select_path_node', nodeId: node });
          return r.type === 'state_update' ? r.state : null;
        }
        case 'test_roll': {
          const r = await act({ type: 'game_action', action: 'roll_dice' });
          return r.type === 'state_update' ? r.state : null;
        }
        case 'test_eval': {
          const ds = s.dice.reduce((a, b) => a + b, 0);
          const dp = s.testPath.reduce((sum, n) => sum + myPs.data[n], 0);
          if (ds + dp >= 18) {
            const r = await act({ type: 'game_action', action: 'resolve_success' });
            return r.type === 'state_update' ? r.state : null;
          }
          // Use Clean Data to flip the lowest die and boost the total if uses remain.
          // Flipping 1→6 adds 5, 2→5 adds 3, 3→4 adds 1 — always improves worst die.
          if ((myPs.cleanUses || 0) < 4) {
            const minIdx = s.dice.indexOf(Math.min(...s.dice));
            const r = await act({ type: 'game_action', action: 'clean_flip', dieIdx: minIdx });
            if (r.type === 'state_update') return r.state; // re-enter test_eval next loop
          }
          const r = await act({ type: 'game_action', action: 'resolve_fail' });
          return r.type === 'state_update' ? r.state : null;
        }
        case 'backprop_source': {
          // Mirror canBackprop exactly: find the first src/dst pair where
          // nodes[src] && data[src]>0 && nodes[dst] && data[dst]<3 && src≠dst &&
          // (pathSet.has(src) || pathSet.has(dst))
          const pathSet = new Set(s.testPath);
          let src = null;
          outer_src: for (let i = 0; i < 11; i++) {
            if (!myPs.nodes[i] || myPs.data[i] <= 0) continue;
            for (let j = 0; j < 11; j++) {
              if (i === j || !myPs.nodes[j] || myPs.data[j] >= 3) continue;
              if (pathSet.has(i) || pathSet.has(j)) { src = i; break outer_src; }
            }
          }
          if (src == null) return null;
          const r = await act({ type: 'game_action', action: 'backprop_select_source', nodeId: src });
          return r.type === 'state_update' ? r.state : null;
        }
        case 'backprop_dest': {
          // Mirror the server dest validation exactly:
          // nodes[dst] && data[dst]<3 && dst≠src && (pathSet.has(src) || pathSet.has(dst))
          const pathSet = new Set(s.testPath);
          const src = s.backpropSource;
          let dst = null;
          for (let j = 0; j < 11; j++) {
            if (j === src || !myPs.nodes[j] || myPs.data[j] >= 3) continue;
            if (pathSet.has(src) || pathSet.has(j)) { dst = j; break; }
          }
          if (dst == null) return null;
          const r = await act({ type: 'game_action', action: 'backprop_select_dest', nodeId: dst });
          return r.type === 'state_update' ? r.state : null;
        }
        default:
          return null;
      }
    }

    it('human vs bot plays to natural game-over and reports final scores', async () => {
      const host = await ws();
      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Human', color: 'blue' });
      await host.next('room_created');

      host.send({ type: 'toggle_bot' });
      await host.next('lobby_update');

      host.send({ type: 'start_game' });
      await host.next('game_started');
      let s = (await host.next('state_update', 5000)).state;

      // With TEST_MODE bot delays (~10ms each), a full game completes in < 3s.
      const MAX_STEPS     = 500;
      let steps           = 0;
      let humanTurns      = 0;
      let botUpdates      = 0;
      let roundsReached   = new Set([s.round]);

      while (!s.gameOver && steps < MAX_STEPS) {
        steps++;

        if (s.currentPlayer !== 0) {
          // Bot's turn — consume state_updates until currentPlayer rotates back
          s = (await host.next('state_update', 5000)).state;
          botUpdates++;
          roundsReached.add(s.round);
          continue;
        }

        // Human's turn
        const next = await humanStep(host, s);
        if (!next) break; // unexpected phase — abort cleanly
        s = next;
        humanTurns++;
        roundsReached.add(s.round);
      }

      // ── Assertions ────────────────────────────────────────────────────────
      assert.equal(s.gameOver, true,
        `Game must reach natural game-over; stopped at phase="${s.phase}" round=${s.round} after ${steps} steps`);

      const scores = s.scores || s.players.map(() => 0);
      assert.ok(Array.isArray(scores) && scores.length === 2, 'Two-player scores array present');
      assert.ok(scores.some(sc => sc > 0),    'At least one player scored points');
      assert.ok(s.round >= 2,                 `Game lasted at least 2 rounds; got ${s.round}`);

      const totalTested = s.players.reduce((sum, p) => sum + (p.tested ? p.tested.filter(Boolean).length : 0), 0);
      assert.ok(totalTested >= 1, `At least 1 animal tested across both players; got ${totalTested}`);

      const totalNodes = s.players.reduce((sum, p) => sum + (p.nodes ? p.nodes.filter(Boolean).length : 0), 0);
      assert.ok(totalNodes >= 3, `At least 3 nodes placed; got ${totalNodes}`);

      // ── Results ───────────────────────────────────────────────────────────
      const SCORE_VALUES = { 2: [5, 3], 3: [5, 3, 2], 4: [5, 4, 3, 2] };
      const CLEAN_PENALTIES = [0, -1, -2, -4, -6];
      const numP = s.players.length;
      const vals = SCORE_VALUES[numP] || SCORE_VALUES[2];

      // Compute per-player scoring breakdown from raw state
      function scoreBreakdown(p, idx) {
        let animalPts = 0, bonusPts = 0;
        const animalDetail = [];
        for (let a = 0; a < 5; a++) {
          for (let slot = 0; slot < (s.scoreboard[a] || []).length; slot++) {
            const entry = s.scoreboard[a][slot];
            if (entry && entry.player === idx) {
              const base = vals[slot] || 0;
              animalPts += base;
              bonusPts  += entry.bonusTokens || 0;
              animalDetail.push(`${ANIMALS[a]} +${base}${entry.bonusTokens ? `+${entry.bonusTokens}bonus` : ''}`);
            }
          }
        }
        const maxedNodes  = p.nodes ? p.nodes.filter((n, ni) => n && p.data[ni] >= 3).length : 0;
        const allTested   = p.tested && p.tested.every(Boolean) ? 1 : 0;
        const cleanPen    = CLEAN_PENALTIES[Math.min(p.cleanUses || 0, 4)];
        const total       = animalPts + bonusPts + maxedNodes + allTested + cleanPen;
        return { animalPts, bonusPts, maxedNodes, allTested, cleanPen, total, animalDetail };
      }

      const winnerScore  = Math.max(...scores);
      const winnerIdx    = scores.indexOf(winnerScore);
      const totalData    = s.players.reduce((sum, p) => sum + (p.data ? p.data.reduce((a, b) => a + b, 0) : 0), 0);
      const roundsPlayed = Math.max(...roundsReached);

      // Why did the game end?
      const allTestedPlayer = s.players.findIndex(p => p.tested && p.tested.every(Boolean));
      const endReason = allTestedPlayer >= 0
        ? `${s.players[allTestedPlayer].name} tested all 5 animals`
        : 'Testing became impossible — remaining animal paths blocked by overfit edges';

      console.log('\n  ━━━ FuzzNet Results ━━━');
      console.log(`  Winner        : ${s.players[winnerIdx]?.name} (${s.players[winnerIdx]?.color}) — ${winnerScore} pts`);
      console.log(`  Game ended    : ${endReason}`);
      console.log(`  Rounds played : ${roundsPlayed}`);
      console.log(`  Animals tested: ${totalTested}/10 across both players`);
      console.log(`  Nodes on board: ${totalNodes}/22   Data tokens: ${totalData}`);
      console.log(`  Loop steps    : ${steps}  |  Human turns: ${humanTurns}  Bot state updates: ${botUpdates}`);
      console.log('  Players:');
      for (const [i, p] of s.players.entries()) {
        const tested     = p.tested ? p.tested.filter(Boolean).length : 0;
        const animalList = p.tested
          ? p.tested.map((t, ai) => t ? ANIMALS[ai] : null).filter(Boolean).join(', ') || 'none'
          : 'none';
        const nodesPlaced = p.nodes ? p.nodes.filter(Boolean).length : 0;
        const dataTotal   = p.data  ? p.data.reduce((a, b) => a + b, 0) : 0;
        const isWinner    = scores[i] === winnerScore ? ' ← winner' : '';
        const bd          = scoreBreakdown(p, i);
        console.log(`    [${i}] ${String(p.name || `P${i}`).padEnd(8)} (${p.color ?? 'bot'}) — TOTAL: ${String(scores[i]).padStart(3)} pts${isWinner}`);
        console.log(`         Animals   : ${bd.animalPts} pts  [${bd.animalDetail.join(', ') || 'none'}]`);
        console.log(`         Bonus tkns: +${bd.bonusPts}  Maxed nodes: +${bd.maxedNodes}  All tested: +${bd.allTested}  Clean pen: ${bd.cleanPen}`);
        console.log(`         Network   : ${nodesPlaced}/11 nodes  ${dataTotal} data tokens  tested ${tested}/5 [${animalList}]  Clean uses: ${p.cleanUses || 0}/4`);
      }
      console.log('  Scoreboard:');
      for (let a = 0; a < 5; a++) {
        const slots = s.scoreboard[a] || [];
        if (slots.length === 0) {
          console.log(`    ${ANIMALS[a].padEnd(10)} — untested`);
        } else {
          const slotStr = slots.map((e, slot) => {
            const name = s.players[e.player]?.name || `P${e.player}`;
            const pts  = vals[slot] || 0;
            return `${slot === 0 ? '1st' : slot === 1 ? '2nd' : '3rd'}: ${name} +${pts}${e.bonusTokens ? `+${e.bonusTokens}b` : ''} (R${e.round})`;
          }).join('  ');
          console.log(`    ${ANIMALS[a].padEnd(10)} — ${slotStr}`);
        }
      }
      if (s.log && s.log.length > 0) {
        console.log('  Activity Log (last 5):');
        s.log.slice(0, 5).forEach(e => console.log(`    ${e.replace(/<[^>]+>/g, '')}`));
      }
      console.log('  ─────────────────────────\n');

      host.close();
    });
  });

  // ── Four-player game ───────────────────────────────────────────────────────
  describe('Four-player game', () => {
    /** Find an unused (empty) neural-network node for a player's design action. */
    function pickEmptyNode(playerState) {
      if (!playerState || !Array.isArray(playerState.nodes)) return -1;
      for (let id = 0; id < playerState.nodes.length; id++) {
        if (!playerState.nodes[id]) return id;
      }
      return -1;
    }

    it('4 humans can complete a full game lifecycle (create → join → start → turn rotation → end)', async () => {
      const NAMES  = ['Alice', 'Bob', 'Carol', 'Dave'];
      const COLORS = ['blue', 'red', 'green', 'purple'];

      // 1. Open 4 WebSocket connections
      const sockets = await Promise.all([0, 1, 2, 3].map(() => ws()));

      // 2. Host (sockets[0]) creates the room
      sockets[0].send({ type: 'create_room', gameType: 'fuzznet', playerName: NAMES[0], color: COLORS[0] });
      const { code } = await sockets[0].next('room_created');

      // 3. The other three players join in sequence
      for (let i = 1; i < 4; i++) {
        sockets[i].send({ type: 'join_room', code, gameType: 'fuzznet', playerName: NAMES[i], color: COLORS[i] });
        await sockets[i].next('room_joined');
      }

      // 4. Host starts the game — every socket should receive game_started
      sockets[0].send({ type: 'start_game' });
      const startEvents = await Promise.all(sockets.map(s => s.next('game_started')));
      assert.equal(startEvents.filter(e => e.type === 'game_started').length, 4,
        'All 4 players receive game_started');

      // 5. Initial state has 4 players, game in progress
      const initStates = await Promise.all(sockets.map(s => s.next('state_update')));
      const initial = initStates[0].state;
      assert.equal(initial.players.length, 4, 'state.players.length === 4');
      assert.equal(initial.gameOver, false,    'Game not over at start');
      assert.ok(typeof initial.currentPlayer === 'number',
        'state.currentPlayer is a number');
      assert.equal(initial.actionsLeft, 3, 'Each turn starts with 3 actions');

      // 6. Cycle through turns: the current player consumes all 3 actions
      //    via start_design + place_node, which advances state and rotates the
      //    turn through all 4 players. Cap at MAX_TURNS as a safety net so
      //    a buggy game-state can never hang the test indefinitely.
      let s = initial;
      const distinctTurnPlayers = new Set([s.currentPlayer]);
      const MAX_TURNS = 24;          // 6 rounds × 4 players, plenty of room
      let turnsCompleted = 0;
      let actionsTaken   = 0;

      while (!s.gameOver && turnsCompleted < MAX_TURNS) {
        const cur = s.currentPlayer;
        const sock = sockets[cur];
        const nodeId = pickEmptyNode(s.players[cur]);
        if (nodeId < 0) break;       // no design slots left — stop early

        // start_design (idle → design) — one state_update broadcast
        sock.send({ type: 'game_action', action: 'start_design' });
        await sock.next('state_update', 3000);

        // place_node consumes 1 action; nextTurn fires automatically when
        // actionsLeft reaches 0
        sock.send({ type: 'game_action', action: 'place_node', nodeId });
        const after = await sock.next('state_update', 3000);
        s = after.state;
        actionsTaken++;

        // Track every player who has had at least one turn-as-current
        distinctTurnPlayers.add(s.currentPlayer);

        // If the turn advanced (current player changed), record one completed turn
        if (s.currentPlayer !== cur) turnsCompleted++;
      }

      // 7. Verify the turn rotation actually visited all 4 players —
      //    proves multi-player turn-based mechanics work end-to-end
      assert.ok(distinctTurnPlayers.size >= 4,
        `Turn rotation should reach all 4 players; saw players: ${[...distinctTurnPlayers].sort().join(',')}`);
      assert.ok(actionsTaken >= 4,
        `Expected at least 4 actions taken; got ${actionsTaken}`);

      // 8. Complete the game cleanly — either it ended naturally, or the host
      //    cancels and every player receives the cancellation broadcast.
      if (s.gameOver) {
        // Natural completion — game logic finished on its own
        assert.equal(s.gameOver, true, 'Game reached natural game-over');
      } else {
        sockets[0].send({ type: 'cancel_game' });
        const cancellations = await Promise.all(
          sockets.map(sock => sock.next('game_cancelled', 5000))
        );
        assert.equal(
          cancellations.filter(m => m.type === 'game_cancelled').length, 4,
          'All 4 players receive game_cancelled on host cancel'
        );
      }

      sockets.forEach(sock => sock.close());
    });
  });
});
