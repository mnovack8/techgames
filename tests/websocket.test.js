'use strict';
/**
 * tests/websocket.test.js
 * Tests room lifecycle, session management, and observer flow over WebSocket.
 * Each test uses real WS connections to the live test server.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, connectWs, delay } = require('./helpers');

let _server;

describe('WebSocket — Room Lifecycle', () => {
  before(async () => { _server = await startServer(); });
  after(async ()  => { await stopServer(_server); });

  // ── Helpers ────────────────────────────────────────────────────────────────
  const ws = () => connectWs(_server.port);

  // ── Room creation ──────────────────────────────────────────────────────────
  describe('create_room', () => {
    it('creates a FuzzNet room → room_created with 4-char code and token', async () => {
      const c = await ws();
      c.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Alice', color: 'blue' });
      const msg = await c.next('room_created');
      assert.equal(msg.type, 'room_created');
      assert.match(msg.code, /^[A-Z2-9]{4}$/, 'Room code must be 4 uppercase alphanumeric chars');
      assert.ok(typeof msg.token === 'string' && msg.token.length > 0, 'Must receive a session token');
      assert.equal(msg.yourId, 0, 'First player is index 0');
      c.close();
    });

    it('creates a ByteClub room', async () => {
      const c = await ws();
      c.send({ type: 'create_room', gameType: 'byteclub', playerName: 'Bob', color: 'red' });
      const msg = await c.next('room_created');
      assert.equal(msg.type, 'room_created');
      assert.match(msg.code, /^[A-Z2-9]{4}$/);
      c.close();
    });

    it('creates a ClusterFlick room', async () => {
      const c = await ws();
      c.send({ type: 'create_room', gameType: 'clusterflick', playerName: 'Carol', color: 'green' });
      const msg = await c.next('room_created');
      assert.equal(msg.type, 'room_created');
      assert.match(msg.code, /^[A-Z2-9]{4}$/);
      c.close();
    });

    it('each room gets a unique code', async () => {
      const [c1, c2] = await Promise.all([ws(), ws()]);
      c1.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'A', color: 'blue' });
      c2.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'B', color: 'red' });
      const [m1, m2] = await Promise.all([c1.next('room_created'), c2.next('room_created')]);
      assert.notEqual(m1.code, m2.code, 'Two separate rooms must have distinct codes');
      c1.close(); c2.close();
    });
  });

  // ── Room check ─────────────────────────────────────────────────────────────
  describe('check_room', () => {
    it('existing room → room_info with exists:true', async () => {
      const host = await ws();
      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');

      const checker = await ws();
      checker.send({ type: 'check_room', code });
      const info = await checker.next('room_info');
      assert.equal(info.exists, true);
      assert.equal(info.started, false);
      assert.ok(Array.isArray(info.availableColors), 'Should list available colors');
      assert.ok(!info.availableColors.includes('blue'), 'blue is taken by host');

      host.close(); checker.close();
    });

    it('nonexistent code → room_info with exists:false', async () => {
      const c = await ws();
      c.send({ type: 'check_room', code: 'ZZZZ' });
      const info = await c.next('room_info');
      assert.equal(info.exists, false);
      c.close();
    });
  });

  // ── Join room ──────────────────────────────────────────────────────────────
  describe('join_room', () => {
    it('valid join → room_joined with correct playerIdx and token', async () => {
      const host  = await ws();
      const guest = await ws();

      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');

      guest.send({ type: 'join_room', code, gameType: 'fuzznet', playerName: 'Guest', color: 'red' });
      const joined = await guest.next('room_joined');

      assert.equal(joined.type, 'room_joined');
      assert.equal(joined.code, code);
      assert.equal(joined.yourId, 1, 'Second player is index 1');
      assert.ok(typeof joined.token === 'string');
      assert.equal(joined.isHost, false);

      host.close(); guest.close();
    });

    it('join broadcasts lobby_update to host', async () => {
      const host  = await ws();
      const guest = await ws();

      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');
      await host.next('lobby_update'); // consume initial lobby_update sent on room creation (1 player)

      guest.send({ type: 'join_room', code, gameType: 'fuzznet', playerName: 'Guest', color: 'red' });
      // Host should receive lobby_update after guest joins
      const update = await host.next('lobby_update');
      assert.equal(update.players.length, 2);
      assert.ok(update.players.some(p => p.color === 'red'), 'Guest color should appear in lobby');

      host.close(); guest.close();
    });

    it('duplicate color is rejected → error', async () => {
      const host  = await ws();
      const guest = await ws();

      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');

      guest.send({ type: 'join_room', code, gameType: 'fuzznet', playerName: 'Guest', color: 'blue' });
      const err = await guest.next('error');
      assert.equal(err.type, 'error');

      host.close(); guest.close();
    });

    it('nonexistent room → error', async () => {
      const c = await ws();
      c.send({ type: 'join_room', code: 'ZZZZ', gameType: 'fuzznet', playerName: 'X', color: 'blue' });
      const err = await c.next('error');
      assert.equal(err.type, 'error');
      c.close();
    });
  });

  // ── Bot toggle ─────────────────────────────────────────────────────────────
  describe('toggle_bot', () => {
    it('adds a bot → lobby_update with bot player', async () => {
      const host = await ws();
      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      await host.next('room_created');
      await host.next('lobby_update'); // consume initial lobby_update from room creation

      host.send({ type: 'toggle_bot' });
      const update = await host.next('lobby_update');
      assert.ok(update.players.some(p => p.isBot), 'A bot player should be in the lobby');

      host.close();
    });

    it('toggling bot twice removes it', async () => {
      const host = await ws();
      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      await host.next('room_created');
      await host.next('lobby_update'); // consume initial lobby_update from room creation

      host.send({ type: 'toggle_bot' });
      await host.next('lobby_update'); // bot added

      host.send({ type: 'toggle_bot' });
      const update2 = await host.next('lobby_update');
      assert.ok(!update2.players.some(p => p.isBot), 'Bot should be removed after second toggle');

      host.close();
    });
  });

  // ── Observer join ──────────────────────────────────────────────────────────
  describe('join_as_observer', () => {
    it('observer joins waiting room → joined_as_observer', async () => {
      const host = await ws();
      const obs  = await ws();

      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');

      obs.send({ type: 'join_as_observer', code, name: 'Watcher' });
      const joined = await obs.next('joined_as_observer');

      assert.equal(joined.type, 'joined_as_observer');
      assert.equal(joined.code, code);
      assert.equal(joined.started, false);
      assert.equal(joined.observerIdx, 0, 'First observer is index 0');

      host.close(); obs.close();
    });

    it('observer is listed in lobby_update', async () => {
      const host = await ws();
      const obs  = await ws();

      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');
      await host.next('lobby_update'); // consume initial lobby_update from room creation

      obs.send({ type: 'join_as_observer', code, name: 'Spy' });
      await obs.next('joined_as_observer');

      // Host gets lobby_update reflecting the observer
      const update = await host.next('lobby_update');
      assert.ok(update.observers.length >= 1, 'Observer should appear in lobby update');
      assert.ok(update.observers.some(o => o.name === 'Spy'));

      host.close(); obs.close();
    });

    it('joining nonexistent room as observer → error', async () => {
      const c = await ws();
      c.send({ type: 'join_as_observer', code: 'ZZZZ', name: 'Ghost' });
      const err = await c.next('error');
      assert.equal(err.type, 'error');
      c.close();
    });
  });

  // ── Session rejoin ─────────────────────────────────────────────────────────
  describe('rejoin_room', () => {
    it('valid token → room_rejoined with same playerIdx', async () => {
      // Token-based rejoin only works for STARTED games — pre-game disconnects clear the session.
      // Use a bot so we can start the game with one human, then simulate a mid-game reconnect.
      const host = await ws();
      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      const { code, token, yourId } = await host.next('room_created');
      await host.next('lobby_update'); // initial lobby

      host.send({ type: 'toggle_bot' });
      await host.next('lobby_update'); // bot added

      host.send({ type: 'start_game' });
      await host.next('game_started');
      await host.next('state_update');

      // Simulate mid-game disconnect: close the socket (ws.close → explicit=false → session preserved)
      host.close();
      await delay(50);

      const reconnected = await ws();
      reconnected.send({ type: 'rejoin_room', token });
      const rejoined = await reconnected.next('room_rejoined');

      assert.equal(rejoined.type, 'room_rejoined');
      assert.equal(rejoined.code, code);
      assert.equal(rejoined.yourId, yourId, 'Must rejoin the same player slot');

      reconnected.close();
    });

    it('invalid token → rejoin_failed', async () => {
      const c = await ws();
      c.send({ type: 'rejoin_room', token: 'not-a-real-token-abc123' });
      const msg = await c.next('rejoin_failed');
      assert.equal(msg.type, 'rejoin_failed');
      c.close();
    });
  });

  // ── Leave room ─────────────────────────────────────────────────────────────
  describe('leave_room', () => {
    it('host leaves → left_room response', async () => {
      const host = await ws();
      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      await host.next('room_created');

      host.send({ type: 'leave_room' });
      const msg = await host.next('left_room');
      assert.equal(msg.type, 'left_room');
      host.close();
    });

    it('guest leaves → host receives lobby_update with 1 player', async () => {
      const host  = await ws();
      const guest = await ws();

      host.send({ type: 'create_room', gameType: 'fuzznet', playerName: 'Host', color: 'blue' });
      const { code } = await host.next('room_created');
      await host.next('lobby_update'); // consume initial lobby_update from room creation (1 player)

      guest.send({ type: 'join_room', code, gameType: 'fuzznet', playerName: 'Guest', color: 'red' });
      await guest.next('room_joined');
      await host.next('lobby_update'); // guest join update (2 players)

      guest.send({ type: 'leave_room' });
      const update = await host.next('lobby_update');
      assert.equal(update.players.length, 1, 'Only host should remain');

      host.close(); guest.close();
    });
  });

  // ── Event room ─────────────────────────────────────────────────────────────
  describe('Event rooms', () => {
    it('create_event_room → event_room_created with valid code', async () => {
      const org = await ws();
      org.send({ type: 'create_event_room', gameType: 'fuzznet', name: 'Organizer' });
      const msg = await org.next('event_room_created');
      assert.equal(msg.type, 'event_room_created');
      assert.match(msg.code, /^[A-Z2-9]{4}$/);
      org.close();
    });

    it('query_event_rooms → event_status_update for existing room', async () => {
      const org = await ws();
      org.send({ type: 'create_event_room', gameType: 'fuzznet', name: 'Organizer' });
      const { code } = await org.next('event_room_created');

      // Query the room status
      org.send({ type: 'query_event_rooms', codes: [code] });
      const status = await org.next('event_status_update');
      assert.equal(status.code, code);
      assert.ok(['pending', 'in_progress', 'completed'].includes(status.status));

      org.close();
    });

    it('query_event_rooms with unknown code → event_rooms_expired', async () => {
      const c = await ws();
      c.send({ type: 'query_event_rooms', codes: ['XXXX'] });
      const msg = await c.next('event_rooms_expired');
      assert.deepEqual(msg.codes, ['XXXX']);
      c.close();
    });

    it('observer joins event room → joined_as_observer with isHost', async () => {
      const org = await ws();
      org.send({ type: 'create_event_room', gameType: 'fuzznet', name: 'Org' });
      const { code } = await org.next('event_room_created');

      const obs = await ws();
      obs.send({ type: 'join_as_observer', code, name: 'FirstWatcher' });
      const joined = await obs.next('joined_as_observer');

      assert.equal(joined.code, code);
      assert.equal(joined.isHost, true, 'First observer of event room is the host');

      org.close(); obs.close();
    });
  });

  // ── create_room_as_observer ────────────────────────────────────────────────
  describe('create_room_as_observer', () => {
    it('creates room and joins as observer host', async () => {
      const c = await ws();
      c.send({ type: 'create_room_as_observer', gameType: 'fuzznet', name: 'ObsHost' });
      const msg = await c.next('joined_as_observer');
      assert.equal(msg.type, 'joined_as_observer');
      assert.equal(msg.isHost, true);
      assert.match(msg.code, /^[A-Z2-9]{4}$/);
      c.close();
    });
  });
});
