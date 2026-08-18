'use strict';
/**
 * tests/games/fuzznet-robustness.test.js
 * Adversarial/edge-case coverage for FuzzNet online play that isn't
 * exercised by websocket.test.js or fuzznet.test.js:
 *  - malformed input (garbage JSON, unknown types, huge payloads, bad field types)
 *  - message flooding on a single connection
 *  - concurrent races (double start_game, simultaneous color claim)
 *  - rejoin/token abuse (invalid/guessed tokens, stale token after game over)
 *  - server stays alive throughout (process must not crash / hang)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, connectWs, delay } = require('../helpers');

let _server;

describe('FuzzNet — Robustness', () => {
  before(async () => { _server = await startServer(); });
  after(async ()  => { await stopServer(_server); });

  const ws = () => connectWs(_server.port);

  async function makeRoom(playerName = 'Host', color = 'blue') {
    const host = await ws();
    host.send({ type: 'create_room', gameType: 'fuzznet', playerName, color });
    const { code, token } = await host.next('room_created');
    return { host, code, token };
  }

  // ── Malformed input ─────────────────────────────────────────────────────
  describe('malformed input', () => {
    it('garbage (non-JSON) frame does not crash the connection or server', async () => {
      const c = await ws();
      c._ws.send('this is not json {{{');
      await delay(100);
      // Connection should still be usable afterwards
      c.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'A', color: 'blue' });
      const msg = await c.next('room_created');
      assert.ok(msg.code);
      c.close();
    });

    it('unknown message type is ignored without error or crash', async () => {
      const c = await ws();
      c.send({ type: 'totally_bogus_action', foo: 'bar' });
      await delay(100);
      c.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'A', color: 'blue' });
      const msg = await c.next('room_created');
      assert.ok(msg.code);
      c.close();
    });

    it('message missing "type" field is ignored', async () => {
      const c = await ws();
      c._ws.send(JSON.stringify({ foo: 'bar' }));
      await delay(100);
      c.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'A', color: 'blue' });
      const msg = await c.next('room_created');
      assert.ok(msg.code);
      c.close();
    });

    it('create_room with wrong field types does not crash server', async () => {
      const c = await ws();
      c.send({ type: 'create_room', gameType: 123, playerName: { nested: true }, color: ['blue'] });
      await delay(150);
      // Server should still respond to a well-formed follow-up
      const c2 = await ws();
      c2.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'B', color: 'red' });
      const msg = await c2.next('room_created');
      assert.ok(msg.code);
      c.close(); c2.close();
    });

    it('join_room with non-existent/garbage code returns error, not a crash', async () => {
      const c = await ws();
      c.send({ type: 'join_room', code: 'ZZZZ', playerName: 'X', color: 'blue' });
      const msg = await c.next();
      assert.equal(msg.type, 'error');
      c.close();
    });

    it('game_action sent before joining any room is rejected gracefully', async () => {
      const c = await ws();
      c.send({ type: 'game_action', action: 'start_design', payload: {} });
      const msg = await c.next();
      assert.equal(msg.type, 'error');
      c.close();
    });

    it('very large payload does not crash the server', async () => {
      const c = await ws();
      const bigString = 'x'.repeat(2_000_000); // 2MB
      c.send({ type: 'create_room', gameType: 'fuzznet', playerName: bigString, color: 'blue' });
      await delay(300);
      // Server should still be responsive to other clients
      const c2 = await ws();
      c2.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Sanity', color: 'red' });
      const msg = await c2.next('room_created');
      assert.ok(msg.code);
      c.close(); c2.close();
    });

    it('deeply nested/odd game_action payload in an active room does not crash server', async () => {
      const { host, code } = await makeRoom('Host', 'blue');
      const guest = await ws();
      guest.send({ type: 'join_room', code, playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.drain();

      host.send({ type: 'start_game' });
      await host.next('game_started');
      await guest.next('game_started').catch(() => {});

      host.send({
        type: 'game_action',
        action: 'start_design',
        payload: { deeply: { nested: { object: [1, 2, { x: 'y' }] } }, weird: null, num: NaN },
      });
      await delay(200);

      // Server still alive — sanity round trip
      const c2 = await ws();
      c2.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Sanity2', color: 'green' });
      const msg = await c2.next('room_created');
      assert.ok(msg.code);

      host.close(); guest.close(); c2.close();
    });
  });

  // ── Flooding ─────────────────────────────────────────────────────────────
  describe('message flooding', () => {
    it('rapid burst of create_room from one connection does not crash server', async () => {
      const c = await ws();
      for (let i = 0; i < 100; i++) {
        c.send({ type: 'create_room', gameType: 'fuzznet', playerName: `Flood${i}`, color: 'blue' });
      }
      await delay(500);
      const received = c.drain();
      assert.ok(received.length > 0, 'Server should have responded to at least some flood messages');

      // Confirm server still healthy for a fresh client
      const c2 = await ws();
      c2.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'PostFlood', color: 'red' });
      const msg = await c2.next('room_created');
      assert.ok(msg.code);
      c.close(); c2.close();
    });

    it('rapid burst of invalid game_action on one room does not crash server', async () => {
      const { host, code } = await makeRoom('Host', 'blue');
      const guest = await ws();
      guest.send({ type: 'join_room', code, playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.drain();
      host.send({ type: 'start_game' });
      await host.next('game_started');

      for (let i = 0; i < 200; i++) {
        host.send({ type: 'game_action', action: 'nonexistent_action_' + i, payload: { i } });
      }
      await delay(500);

      const c2 = await ws();
      c2.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'PostFlood2', color: 'green' });
      const msg = await c2.next('room_created');
      assert.ok(msg.code);

      host.close(); guest.close(); c2.close();
    });
  });

  // ── Concurrency / races ──────────────────────────────────────────────────
  describe('concurrency', () => {
    it('two clients racing to claim the same color — only one wins', async () => {
      const { host, code } = await makeRoom('Host', 'blue');
      const [c1, c2] = await Promise.all([ws(), ws()]);
      c1.send({ type: 'join_room', code, playerName: 'Racer1', color: 'red' });
      c2.send({ type: 'join_room', code, playerName: 'Racer2', color: 'red' });

      const results = await Promise.all([
        c1.next().catch(e => ({ type: 'timeout', e })),
        c2.next().catch(e => ({ type: 'timeout', e })),
      ]);
      const oks = results.filter(r => r.type === 'room_joined');
      const errs = results.filter(r => r.type === 'error');
      assert.equal(oks.length, 1, 'Exactly one racer should successfully claim the color');
      assert.equal(errs.length, 1, 'The other racer should get an error');

      host.close(); c1.close(); c2.close();
    });

    it('double start_game from host only starts the game once', async () => {
      const { host, code } = await makeRoom('Host', 'blue');
      const guest = await ws();
      guest.send({ type: 'join_room', code, playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.drain();

      host.send({ type: 'start_game' });
      host.send({ type: 'start_game' });

      const first = await host.next('game_started');
      assert.ok(first);
      // A second game_started (or a crash) would be a bug; give it a moment and ensure
      // the server is still coherent afterward.
      await delay(200);
      const extra = host.drain().filter(m => m.type === 'game_started');
      assert.equal(extra.length, 0, 'start_game should not be processed twice');

      host.close(); guest.close();
    });

    it('start_game from a non-host is rejected even when racing the real start', async () => {
      const { host, code } = await makeRoom('Host', 'blue');
      const guest = await ws();
      guest.send({ type: 'join_room', code, playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.drain();

      guest.send({ type: 'start_game' });
      host.send({ type: 'start_game' });

      const guestMsg = await guest.next().catch(() => null);
      assert.ok(guestMsg, 'Guest should get some response (error) to its illegitimate start_game');
      assert.notEqual(guestMsg.type, 'game_started', 'Non-host start_game must not itself start the game');

      host.close(); guest.close();
    });
  });

  // ── Token / rejoin abuse ─────────────────────────────────────────────────
  describe('rejoin/token abuse', () => {
    it('rejoin with a random/guessed token is rejected', async () => {
      const { host, code } = await makeRoom('Host', 'blue');
      const guest = await ws();
      guest.send({ type: 'join_room', code, playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.drain();
      host.send({ type: 'start_game' });
      await host.next('game_started');

      const attacker = await ws();
      // 32-char lowercase-alnum guesses, matching the real token's format
      const guesses = Array.from({ length: 25 }, () =>
        Array.from({ length: 32 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('')
      );
      let anyHijacked = false;
      for (const guess of guesses) {
        attacker.send({ type: 'rejoin_room', code, token: guess });
        const resp = await attacker.next().catch(() => ({ type: 'timeout' }));
        if (resp.type === 'room_rejoined' || resp.type === 'game_started') anyHijacked = true;
      }
      assert.equal(anyHijacked, false, 'No random token guess should succeed in hijacking a player slot');

      host.close(); guest.close(); attacker.close();
    });

    it('rejoin with a stale token after the room is gone returns an error, not a hang', async () => {
      const { host, code, token } = await makeRoom('Host', 'blue');
      host.send({ type: 'leave_room' });
      await delay(100);
      host.close();

      const c = await ws();
      c.send({ type: 'rejoin_room', code, token });
      const resp = await c.next();
      assert.ok(['error', 'rejoin_failed'].includes(resp.type), `expected a failure response, got ${resp.type}`);
      c.close();
    });
  });

  // ── Server liveness sanity ───────────────────────────────────────────────
  it('server survives the full adversarial sequence above and still serves /health', async () => {
    const { httpRequest } = require('../helpers');
    const res = await httpRequest(_server.port, '/health');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(typeof body.uptime === 'number' || body.uptime !== undefined);
  });
});
