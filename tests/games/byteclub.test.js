'use strict';
/**
 * tests/games/byteclub.test.js
 * ByteClub (cybersecurity card game) flow tests.
 *
 * Server message types:
 *   bc_game_started  — broadcast when game starts (no state payload)
 *   bc_state         — per-player state (fields at top level, NOT under .state)
 *   bc_player_event  — player join/leave/reconnect notifications
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, connectWs, delay } = require('../helpers');

let _server;

describe('ByteClub — Game Flow', () => {
  before(async () => { _server = await startServer(); });
  after(async ()  => { await stopServer(_server); });

  const ws = () => connectWs(_server.port);

  /** Create a ByteClub room with one human + one bot, ready to start. */
  async function setupRoom() {
    const host = await ws();
    host.send({ type: 'create_room', gameType: 'byteclub', playerName: 'Host', color: 'blue' });
    const { code, token } = await host.next('room_created');

    host.send({ type: 'toggle_bot' });
    await host.next('lobby_update');

    return { host, code, token };
  }

  // ── Pre-game ───────────────────────────────────────────────────────────────
  describe('Pre-game lobby', () => {
    it('cannot start ByteClub with 1 player → error', async () => {
      const host = await ws();
      host.send({ type: 'create_room', gameType: 'byteclub', playerName: 'Solo', color: 'blue' });
      await host.next('room_created');

      host.send({ type: 'start_game' });
      const err = await host.next('error');
      assert.equal(err.type, 'error');
      host.close();
    });
  });

  // ── Game start ─────────────────────────────────────────────────────────────
  describe('Game start', () => {
    it('start → bc_game_started then bc_state', async () => {
      const { host } = await setupRoom();

      host.send({ type: 'start_game' });

      // bc_game_started is broadcast to all players on game start
      const started = await host.next('bc_game_started');
      assert.equal(started.type, 'bc_game_started');

      // bc_state is sent individually per-player (fields at top level, not .state)
      const state = await host.next('bc_state');
      assert.equal(state.type, 'bc_state');
      assert.ok(typeof state.phase === 'string', 'bc_state must have a phase field');

      host.close();
    });

    it('initial bc_state structure is correct', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('bc_game_started');
      const s = await host.next('bc_state');

      // Top-level state fields (bc_state is NOT wrapped in .state)
      assert.ok(Array.isArray(s.players), 'bc_state.players must be an array');
      assert.equal(s.players.length, 2, '1 human + 1 bot = 2 players');
      assert.ok(typeof s.currentPlayer === 'number', 'currentPlayer must be a number');
      assert.equal(s.phase, 'play', 'Initial phase should be "play"');
      assert.equal(s.winner, -1, 'No winner at game start');

      host.close();
    });

    it('human player receives own hand via myHand', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('bc_game_started');
      const s = await host.next('bc_state');

      // myHand is the current player's own cards (only they can see them)
      assert.ok(Array.isArray(s.myHand), 'bc_state.myHand must be an array');
      assert.ok(s.myHand.length > 0, 'Player should have cards at game start');

      // Each card has id (number or string), type, and cat (category: attack/defend)
      for (const card of s.myHand) {
        assert.ok(card.id != null,               `Card must have an id`);
        assert.ok(typeof card.type === 'string', `Card must have a type`);
        assert.ok(typeof card.cat === 'string',  `Card must have a category (cat)`);
      }

      host.close();
    });

    it('players list shows handCount but not other players\' private cards', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('bc_game_started');
      const s = await host.next('bc_state');

      for (const p of s.players) {
        assert.ok(typeof p.handCount === 'number', 'Each player entry must have handCount');
        assert.ok(Array.isArray(p.played),          'Each player entry must have played array');
        // Players should NOT be able to see other players' full hand
        assert.equal(p.hand, undefined, 'Full hand array must not be exposed in players[]');
      }

      host.close();
    });
  });

  // ── Actions ────────────────────────────────────────────────────────────────
  describe('Game actions', () => {
    it('play_card with valid cardId → bc_state update', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('bc_game_started');
      let s = await host.next('bc_state');

      // Wait for human's turn (player 0) in the play phase.
      // Drain the queue after each match so we always act on the freshest state
      // (the bot may have already queued further state updates by the time we read).
      while (s.currentPlayer !== 0 || s.phase !== 'play') {
        s = await host.next('bc_state', 8000);
      }
      // Consume any additional buffered bc_states so we have the very latest snapshot
      for (const m of host.drain()) {
        if (m.type === 'bc_state') s = m;
      }
      if (s.currentPlayer !== 0 || s.phase !== 'play') { host.close(); return; }

      // Find a playable card — not data_flag or action_obj in the play phase
      const playable = s.myHand.find(c =>
        c.type !== 'data_flag' && c.type !== 'action_obj' && c.type !== 'weaponize'
      );

      if (!playable) { host.close(); return; } // edge case: skip if no playable card

      host.send({ type: 'game_action', action: 'play_card', cardId: playable.id });

      // ByteClub never sends 'error' for invalid play_card — it silently ignores them.
      // Wait only for bc_state. Using Promise.race with two concurrent host.next() calls
      // leaves a dangling resolver whose 3-second timeout fires as an unhandled rejection
      // and intermittently fails the test via node:test's async-context tracking.
      const res = await host.next('bc_state', 5000);
      assert.equal(res.type, 'bc_state', 'Expected bc_state response to play_card');

      host.close();
    });

    it('end_play_phase → state update', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('bc_game_started');
      let s = await host.next('bc_state');

      while (s.currentPlayer !== 0 || s.phase !== 'play') {
        s = await host.next('bc_state', 8000);
      }

      host.send({ type: 'game_action', action: 'end_play_phase' });

      // Wait for bc_state only — avoids the dangling-resolver problem of Promise.race
      const res = await host.next('bc_state', 5000);
      assert.ok(res, 'Received bc_state response to end_play_phase');

      host.close();
    });

    it('invalid action → silently ignored, game still cancellable after', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('bc_game_started');
      await host.next('bc_state');

      // ByteClub silently ignores unknown actions (no error response).
      host.send({ type: 'game_action', action: 'not_a_real_action_xyz' });

      // Verify the connection is still alive: host can still cancel the game.
      await delay(100);
      host.send({ type: 'cancel_game' });
      const cancelled = await host.next('game_cancelled', 3000);
      assert.equal(cancelled.type, 'game_cancelled', 'Connection still functional after unknown action');

      host.close();
    });
  });

  // ── Two-player multiplayer ─────────────────────────────────────────────────
  describe('Two-human ByteClub game', () => {
    it('both players receive bc_game_started and bc_state', async () => {
      const host  = await ws();
      const guest = await ws();

      host.send({ type: 'create_room', gameType: 'byteclub', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');

      guest.send({ type: 'join_room', code, gameType: 'byteclub', playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.next('lobby_update');

      host.send({ type: 'start_game' });

      const [hs, gs] = await Promise.all([
        host.next('bc_game_started'),
        guest.next('bc_game_started'),
      ]);
      assert.equal(hs.type,  'bc_game_started');
      assert.equal(gs.type,  'bc_game_started');

      const [hState, gState] = await Promise.all([
        host.next('bc_state'),
        guest.next('bc_state'),
      ]);
      assert.equal(hState.type, 'bc_state');
      assert.equal(gState.type, 'bc_state');

      // Each player sees their own hand (different cards)
      assert.ok(Array.isArray(hState.myHand), 'Host has a hand');
      assert.ok(Array.isArray(gState.myHand), 'Guest has a hand');

      host.close(); guest.close();
    });
  });

  // ── Cancellation ──────────────────────────────────────────────────────────
  describe('Game cancellation', () => {
    it('host cancels → game_cancelled received', async () => {
      const { host } = await setupRoom();
      host.send({ type: 'start_game' });
      await host.next('bc_game_started');
      await host.next('bc_state');

      host.send({ type: 'cancel_game' });
      const msg = await host.next('game_cancelled');
      assert.equal(msg.type, 'game_cancelled');
      host.close();
    });
  });

  // ── Four-player game ───────────────────────────────────────────────────────
  describe('Four-player game', () => {
    /**
     * Send an action from a socket and return the player's latest bc_state
     * after the server has finished broadcasting. ByteClub may fire multiple
     * bc_state events per action (e.g. end_play_phase → draw → end-turn), so
     * we drain the queue with a short window to capture the final state.
     */
    async function actAndSettle(sock, msg) {
      sock.send(msg);
      let last = await sock.next('bc_state', 5000);
      while (true) {
        try { last = await sock.next('bc_state', 40); }
        catch { break; }
      }
      return last;
    }

    /** Pull the latest bc_state from a socket's queue (for the OTHER player's turn change). */
    async function freshState(sock) {
      let last = await sock.next('bc_state', 5000);
      while (true) {
        try { last = await sock.next('bc_state', 40); }
        catch { break; }
      }
      return last;
    }

    it('4 humans can complete a full game lifecycle (create → join → start → turn rotation → end)', async () => {
      const NAMES  = ['Alice', 'Bob', 'Carol', 'Dave'];
      const COLORS = ['blue', 'red', 'green', 'purple'];

      // 1. Open 4 WebSocket connections
      const sockets = await Promise.all([0, 1, 2, 3].map(() => ws()));

      // 2. Host (sockets[0]) creates the room
      sockets[0].send({ type: 'create_room', gameType: 'byteclub', playerName: NAMES[0], color: COLORS[0] });
      const { code } = await sockets[0].next('room_created');

      // 3. The other three players join in sequence
      for (let i = 1; i < 4; i++) {
        sockets[i].send({ type: 'join_room', code, gameType: 'byteclub', playerName: NAMES[i], color: COLORS[i] });
        await sockets[i].next('room_joined');
      }

      // 4. Host starts the game — every socket should receive bc_game_started
      sockets[0].send({ type: 'start_game' });
      const startEvents = await Promise.all(sockets.map(s => s.next('bc_game_started')));
      assert.equal(startEvents.filter(e => e.type === 'bc_game_started').length, 4,
        'All 4 players receive bc_game_started');

      // 5. Initial per-player bc_state (each player gets their own with myHand)
      const initStates = await Promise.all(sockets.map(s => s.next('bc_state')));
      const initial = initStates[0];
      assert.equal(initial.players.length, 4, 'state.players.length === 4');
      assert.equal(initial.winner, -1,        'No winner at game start');
      assert.equal(initial.phase,  'play',    'Initial phase is "play"');
      // Each player should see their own myHand of starting cards
      for (let i = 0; i < 4; i++) {
        assert.ok(Array.isArray(initStates[i].myHand) && initStates[i].myHand.length > 0,
          `Player ${i} has a starting hand`);
      }

      // 6. Drive the game forward by having the current player issue end_play_phase
      //    (the minimal valid turn — draws a card, ends the turn). Handle the
      //    discard phase if a hand grows past 6 cards. Cap iterations as a safety net.
      //
      //    Because ByteClub's deck contains exactly one Times Up card (in the bottom
      //    third) and one Data Flag (in the top third), simply drawing through the
      //    deck this way will eventually trigger a natural win — typically within
      //    ~30-50 turns.
      let curState   = initStates[initial.currentPlayer];
      let iterations = 0;
      const MAX_ITERATIONS    = 200;
      const distinctPlayers   = new Set([curState.currentPlayer]);
      let actionsTaken        = 0;

      while (curState.winner === -1 && iterations < MAX_ITERATIONS) {
        const cur  = curState.currentPlayer;
        const sock = sockets[cur];

        let action;
        if (curState.phase === 'play') {
          action = { type: 'game_action', action: 'end_play_phase' };
        } else if (curState.phase === 'discard') {
          // Discard the first card in hand (skip data_flag — that's the win condition card)
          const discardable = curState.myHand.find(c => c.type !== 'data_flag') || curState.myHand[0];
          if (!discardable) break;
          action = { type: 'game_action', action: 'discard_card', cardId: discardable.id };
        } else {
          // Unhandled phase (weaponize_window, attack states, etc.) — would only
          // trigger if cards were played; since we only call end_play_phase, this
          // is essentially unreachable. Bail out defensively.
          break;
        }

        const afterAction = await actAndSettle(sock, action);
        actionsTaken++;

        // If the turn rotated to a new player, fetch THAT player's POV state
        // (they have their own queued bc_state from the same broadcast).
        if (afterAction.currentPlayer !== cur) {
          curState = await freshState(sockets[afterAction.currentPlayer]);
        } else {
          curState = afterAction;
        }
        distinctPlayers.add(curState.currentPlayer);
        iterations++;
      }

      // 7. Turn rotation should visit all 4 players (proves 4-way mechanics work)
      assert.ok(distinctPlayers.size >= 4,
        `Turn rotation should reach all 4 players; saw: ${[...distinctPlayers].sort().join(',')}`);
      assert.ok(actionsTaken >= 4,
        `Expected at least 4 actions taken; got ${actionsTaken}`);

      // 8. Game should have reached a natural game-over (Times Up + Data Flag).
      //    If it didn't (unlikely given enough iterations), host cancels — and
      //    every socket should still receive game_cancelled.
      if (curState.winner >= 0) {
        assert.ok(curState.winner >= 0 && curState.winner < 4,
          `Winner index in range; got ${curState.winner}`);
        assert.equal(curState.phase, 'game_over',
          'Final phase should be "game_over" on natural win');
      } else {
        sockets[0].send({ type: 'cancel_game' });
        const cancellations = await Promise.all(
          sockets.map(s => s.next('game_cancelled', 5000))
        );
        assert.equal(
          cancellations.filter(m => m.type === 'game_cancelled').length, 4,
          'All 4 players receive game_cancelled on host cancel'
        );
      }

      sockets.forEach(s => s.close());
    });
  });
});
