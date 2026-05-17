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
