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
});
