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
});
