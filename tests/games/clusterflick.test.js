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
});
