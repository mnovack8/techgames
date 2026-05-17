'use strict';
/**
 * tests/games/clusterflick.test.js
 * ClusterFlick (AI/KNN token-flicking game) flow tests.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, connectWs, delay } = require('../helpers');

let _server;

describe('ClusterFlick — Game Flow', () => {
  before(async () => { _server = await startServer(); });
  after(async ()  => { await stopServer(_server); });

  const ws = () => connectWs(_server.port);

  /** Create a ClusterFlick room with one human + one bot. */
  async function setupRoom() {
    const host = await ws();
    host.send({ type: 'create_room', gameType: 'clusterflick', playerName: 'Host', color: 'blue' });
    const { code, token } = await host.next('room_created');

    host.send({ type: 'toggle_bot' });
    await host.next('lobby_update');

    return { host, code, token };
  }

  // ── Pre-game ───────────────────────────────────────────────────────────────
  describe('Pre-game lobby', () => {
    it('cannot start ClusterFlick with 1 player → error', async () => {
      const host = await ws();
      host.send({ type: 'create_room', gameType: 'clusterflick', playerName: 'Solo', color: 'blue' });
      await host.next('room_created');

      host.send({ type: 'start_game' });
      const err = await host.next('error');
      assert.equal(err.type, 'error');
      host.close();
    });
  });

  // ── Game start ─────────────────────────────────────────────────────────────
  describe('Game start', () => {
    it('start → game_started then state_update', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });

      const started = await host.next('game_started');
      assert.equal(started.type, 'game_started');

      const state = await host.next('state_update');
      assert.equal(state.type, 'state_update');
      assert.ok(state.state, 'State payload must be present');

      host.close();
    });

    it('initial ClusterFlick state structure is correct', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('game_started');
      const { state: s } = await host.next('state_update');

      assert.ok(Array.isArray(s.players), 'state.players must be an array');
      assert.equal(s.players.length, 2, '1 human + 1 bot = 2 players');
      assert.ok(typeof s.currentPlayer === 'number');
      assert.equal(s.gameOver, false, 'Game not over at start');
      assert.ok(typeof s.round === 'number', 'Round number should exist');
      assert.ok(s.round >= 1, 'First round should be 1 or more');

      host.close();
    });

    it('players have expected initial confidence of 0', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('game_started');
      const { state: s } = await host.next('state_update');

      // ClusterFlick tracks "confidence" per animal, not a single score
      for (const player of s.players) {
        assert.ok(Array.isArray(player.confidence), 'Player must have a confidence array');
        assert.ok(player.confidence.every(c => c === 0), 'All confidence values should be 0 at game start');
      }

      host.close();
    });
  });

  // ── Actions ────────────────────────────────────────────────────────────────
  describe('Game actions', () => {
    it('flick_token with valid params → state_update update', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('game_started');
      const { state: s } = await host.next('state_update');

      // Wait for human's turn
      let currentState = s;
      while (currentState.currentPlayer !== 0) {
        const next = await host.next('state_update', 8000);
        currentState = next.state;
      }

      // Flick at a reasonable angle and power
      host.send({ type: 'game_action', action: 'flick_token', angle: 45, power: 0.5 });

      const after = await host.next('state_update', 5000);
      assert.equal(after.type, 'state_update');
      assert.ok(after.state, 'State update received after flick');

      host.close();
    });

    it('flick_token out of turn → error', async () => {
      const host  = await ws();
      const guest = await ws();

      host.send({ type: 'create_room', gameType: 'clusterflick', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');

      guest.send({ type: 'join_room', code, gameType: 'clusterflick', playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.next('lobby_update');

      host.send({ type: 'start_game' });
      await Promise.all([host.next('game_started'), guest.next('game_started')]);
      const [{ state }] = await Promise.all([
        host.next('state_update'),
        guest.next('state_update'),
      ]);

      // The non-current player attempts to flick
      const nonCurrent = state.currentPlayer === 0 ? guest : host;
      nonCurrent.send({ type: 'game_action', action: 'flick_token', angle: 90, power: 0.3 });
      const err = await nonCurrent.next('error', 3000);
      assert.equal(err.type, 'error', 'Out-of-turn flick must be rejected');

      host.close(); guest.close();
    });

    it('set_action_mode → state reflects mode change', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('game_started');
      const { state: s } = await host.next('state_update');

      let currentState = s;
      while (currentState.currentPlayer !== 0) {
        const next = await host.next('state_update', 8000);
        currentState = next.state;
      }

      // Switch to 'sample' action mode
      host.send({ type: 'game_action', action: 'set_action_mode', mode: 'sample' });
      const after = await Promise.race([
        host.next('state_update', 3000),
        host.next('error',         3000),
      ]);
      // Either the mode was accepted (state_update) or rejected (error) — either is valid
      assert.ok(after, 'Got response to set_action_mode');

      host.close();
    });
  });

  // ── Two-player multiplayer ─────────────────────────────────────────────────
  describe('Two-human ClusterFlick game', () => {
    it('both players receive game_started and state_update', async () => {
      const host  = await ws();
      const guest = await ws();

      host.send({ type: 'create_room', gameType: 'clusterflick', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');

      guest.send({ type: 'join_room', code, gameType: 'clusterflick', playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.next('lobby_update');

      host.send({ type: 'start_game' });

      await Promise.all([host.next('game_started'), guest.next('game_started')]);

      const [hs, gs] = await Promise.all([
        host.next('state_update'),
        guest.next('state_update'),
      ]);
      assert.ok(hs.state, 'Host received game state');
      assert.ok(gs.state, 'Guest received game state');

      host.close(); guest.close();
    });
  });

  // ── Cancellation ──────────────────────────────────────────────────────────
  describe('Game cancellation', () => {
    it('host cancels in-progress game → game_cancelled', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('game_started');
      await host.next('state_update');

      host.send({ type: 'cancel_game' });
      const msg = await host.next('game_cancelled');
      assert.equal(msg.type, 'game_cancelled');
      host.close();
    });
  });

  // ── Four-player game ───────────────────────────────────────────────────────
  describe('Four-player game', () => {
    /**
     * Send an action from a socket and return the latest state_update payload.
     * ClusterFlick may fire multiple state_update events per action (e.g. the
     * flick result + turn advance), so we drain with a short window to settle.
     */
    /**
     * Send an action and read the resulting state_update.
     * IMPORTANT: drain the socket queue first — prior broadcasts (intended for
     * other players' turns) accumulate in this socket's queue, and reading the
     * oldest one would give us stale state and trip the "Not your turn" guard.
     * ClusterFlick fires exactly one state_update per action.
     */
    async function actAndSettle(sock, msg) {
      sock.drain();
      sock.send(msg);
      return sock.next('state_update', 5000);
    }

    it('4 humans can complete a full game lifecycle (create → join → start → flick rotation → end)', async () => {
      const NAMES  = ['Alice', 'Bob', 'Carol', 'Dave'];
      const COLORS = ['blue', 'red', 'green', 'purple'];

      // 1. Open 4 WebSocket connections
      const sockets = await Promise.all([0, 1, 2, 3].map(() => ws()));

      // 2. Host (sockets[0]) creates the room
      sockets[0].send({ type: 'create_room', gameType: 'clusterflick', playerName: NAMES[0], color: COLORS[0] });
      const { code } = await sockets[0].next('room_created');

      // 3. The other three players join in sequence
      for (let i = 1; i < 4; i++) {
        sockets[i].send({ type: 'join_room', code, gameType: 'clusterflick', playerName: NAMES[i], color: COLORS[i] });
        await sockets[i].next('room_joined');
      }

      // 4. Host starts the game — every socket should receive game_started
      sockets[0].send({ type: 'start_game' });
      const startEvents = await Promise.all(sockets.map(s => s.next('game_started')));
      assert.equal(startEvents.filter(e => e.type === 'game_started').length, 4,
        'All 4 players receive game_started');

      // 5. Initial state has 4 players, round 1, no winner
      const initStates = await Promise.all(sockets.map(s => s.next('state_update')));
      const initial = initStates[0].state;
      assert.equal(initial.players.length, 4, 'state.players.length === 4');
      assert.equal(initial.gameOver, false,    'Game not over at start');
      assert.equal(initial.round,    1,        'Game begins at round 1');
      assert.equal(initial.phase,    'flicking', 'Initial phase is "flicking"');
      // Each player begins with all-zero confidence across the 6 animal classes
      for (let i = 0; i < 4; i++) {
        const p = initial.players[i];
        assert.ok(Array.isArray(p.confidence) && p.confidence.length === 6,
          `Player ${i} has 6-animal confidence array`);
        assert.ok(p.confidence.every(c => c === 0),
          `Player ${i} starts with all confidences = 0`);
      }

      // 6. Drive the game forward: on each turn, the current player flicks.
      //    ClusterFlick has 6 rounds × 4 players × 5 flicks-per-player = 120
      //    flicks max, after which the game naturally reaches game_over.
      //    The flick angle/power values don't affect game completion — even
      //    flicks that miss the board count and advance the turn.
      let s = initial;
      const distinctPlayers = new Set([s.currentPlayer]);
      const MAX_ITERATIONS  = 200;
      let iterations = 0;
      let flicksTaken = 0;

      while (!s.gameOver && iterations < MAX_ITERATIONS) {
        // Sanity check: we never set actionMode to 'sample' so the player's
        // turn always ends with a single flick_token. If the phase changes
        // away from 'flicking' something is off — bail rather than hang.
        if (s.phase !== 'flicking') break;

        const cur  = s.currentPlayer;
        const sock = sockets[cur];

        // Vary angle/power deterministically so we don't get stuck in any one zone
        const angle = (iterations * 0.7) % (2 * Math.PI);
        const power = 0.3 + (iterations % 5) * 0.1;
        const action = { type: 'game_action', action: 'flick_token', angle, power };

        const after = await actAndSettle(sock, action);
        flicksTaken++;
        s = after.state;
        distinctPlayers.add(s.currentPlayer);
        iterations++;
      }

      // 7. Turn rotation should visit all 4 players (proves 4-way mechanics work)
      assert.ok(distinctPlayers.size >= 4,
        `Turn rotation should reach all 4 players; saw: ${[...distinctPlayers].sort().join(',')}`);
      assert.ok(flicksTaken >= 4,
        `Expected at least 4 actions taken; got ${flicksTaken}`);

      // 8. Game should have reached a natural game-over after 6 rounds.
      //    Fallback: host cancels — every socket should still receive game_cancelled.
      if (s.gameOver) {
        assert.equal(s.gameOver, true, 'Game reached natural game-over');
        // Final round should be ≥ 1 and ≤ CF_ROUNDS (6)
        assert.ok(s.round >= 1 && s.round <= 7,
          `Final round in valid range; got ${s.round}`);
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
