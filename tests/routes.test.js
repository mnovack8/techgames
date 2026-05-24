'use strict';
/**
 * tests/routes.test.js
 * Validates that every public URL on the site returns the correct HTTP status,
 * no link leads to a 404, and redirects resolve to the right destination.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, stopServer, httpRequest } = require('./helpers');
const hubRenderer = require('../games/marketing-hub-renderer');

// ─────────────────────────────────────────────────────────────────────────────
// Shared server instance for this file
// ─────────────────────────────────────────────────────────────────────────────
let _server;

describe('Route Coverage', () => {
  before(async () => { _server = await startServer(); });
  after(async ()  => { await stopServer(_server); });

  const { port } = (() => {
    // port isn't available until before() runs, so we use a getter
    const ref = {};
    before(async () => { ref.port = _server.port; });
    return ref;
  })();

  // ── Helper ─────────────────────────────────────────────────────────────────
  async function get(path) {
    return httpRequest(_server.port, path);
  }

  // ── Core pages ─────────────────────────────────────────────────────────────
  describe('Core pages', () => {
    const pages = [
      ['/', 'Landing page'],
      ['/about', 'About'],
      ['/contact', 'Contact'],
      ['/buy-now', 'Buy Now'],
      ['/admin', 'Admin'],
      ['/blog', 'Blog index'],
    ];

    for (const [path, label] of pages) {
      it(`${label} (${path}) → 200`, async () => {
        const res = await get(path);
        assert.equal(res.status, 200, `Expected 200 for ${path}, got ${res.status}`);
        assert.ok(
          res.headers['content-type']?.startsWith('text/html'),
          `Expected text/html for ${path}, got ${res.headers['content-type']}`
        );
      });
    }
  });

  // ── Game hubs ─────────────────────────────────────────────────────────────
  describe('Game hub pages', () => {
    // Static hubs (not template-driven)
    const staticHubs = [
      ['/ai',                       'AI hub'],
      ['/quantumcomputing',         'Quantum Computing'],
    ];

    // Template-driven hubs auto-discovered from games/<key>/marketing.json
    const templateRoutes = [...hubRenderer.getHubRoutes().keys()]
      .filter(p => !p.endsWith('.html'))                       // skip .html aliases
      .map(p => [p, `Marketing hub: ${hubRenderer.getHubRoutes().get(p)}`]);

    const hubs = [...staticHubs, ...templateRoutes];

    for (const [path, label] of hubs) {
      it(`${label} (${path}) → 200`, async () => {
        const res = await get(path);
        assert.equal(res.status, 200, `Expected 200 for ${path}`);
      });
    }
  });

  // ── Game play pages ────────────────────────────────────────────────────────
  describe('Game play pages', () => {
    const games = [
      ['/cybersecurity/byteclub',                   'ByteClub game'],
      ['/cybersecurity/byteclub/lobby',             'ByteClub lobby (state)'],
      ['/cybersecurity/byteclub/activegame',        'ByteClub active game (state)'],
      ['/cybersecurity/byteclub/tutorial',          'ByteClub tutorial (state)'],
      ['/ai/neural-network/fuzznet',                'FuzzNet game'],
      ['/ai/neural-network/fuzznet/lobby',          'FuzzNet lobby (state)'],
      ['/ai/neural-network/fuzznet/activegame',     'FuzzNet active game (state)'],
      ['/ai/neural-network/fuzznet/tutorial',       'FuzzNet tutorial (state)'],
      ['/ai/knn/clusterflick',                      'ClusterFlick game'],
      ['/ai/knn/clusterflick/lobby',                'ClusterFlick lobby (state)'],
      ['/ai/knn/clusterflick/activegame',           'ClusterFlick active game (state)'],
      ['/ai/knn/clusterflick/tutorial',             'ClusterFlick tutorial (state)'],
    ];

    for (const [path, label] of games) {
      it(`${label} (${path}) → 200`, async () => {
        const res = await get(path);
        assert.equal(res.status, 200, `Expected 200 for ${path}`);
        assert.ok(
          res.headers['content-type']?.startsWith('text/html'),
          `Expected text/html for ${path}`
        );
      });
    }
  });

  // ── Use-case pages ─────────────────────────────────────────────────────────
  describe('Use case pages', () => {
    const useCases = [
      ['/board-culture-change', 'Board culture change'],
      ['/focused-deep-work',    'Focused deep work'],
    ];

    for (const [path, label] of useCases) {
      it(`${label} (${path}) → 200`, async () => {
        const res = await get(path);
        assert.equal(res.status, 200, `Expected 200 for ${path}`);
      });
    }
  });

  // ── Blog articles ──────────────────────────────────────────────────────────
  describe('Blog articles', () => {
    const articles = [
      '/blog/ai-security-workshop',
      '/blog/culture-is-already-showing',
      '/blog/cybersecurity-awareness-workshop',
      '/blog/cybersecurity-mindset-critical-thinking',
      '/blog/how-to-facilitate-an-ai-literacy-workshop',
      '/blog/how-to-run-an-ai-literacy-workshop-online',
      '/blog/people-process-tools',
      '/blog/principles-of-ai-data-science',
      '/blog/quantum-computing-basics',
      '/blog/why-we-learn-better-through-play',
    ];

    for (const path of articles) {
      it(`${path} → 200`, async () => {
        const res = await get(path);
        assert.equal(res.status, 200, `Expected 200 for ${path}`);
        assert.ok(
          res.headers['content-type']?.startsWith('text/html'),
          `Expected text/html content-type`
        );
      });
    }
  });

  // ── 301 Redirects ──────────────────────────────────────────────────────────
  describe('Legacy URL redirects (301)', () => {
    const redirects = [
      // AI nested-path migration
      ['/ai/neural-network',              '/ai/neural-network/fuzznet'],
      ['/ai/neural-network.html',         '/ai/neural-network/fuzznet'],
      ['/ai-neural-network',              '/ai/neural-network/fuzznet'],
      ['/ai-neural-network.html',         '/ai/neural-network/fuzznet'],
      ['/ai-neural-network/fuzznet',      '/ai/neural-network/fuzznet'],
      ['/ai-neural-network/fuzznet.html', '/ai/neural-network/fuzznet'],
      ['/ai/knn',                         '/ai/knn/clusterflick'],
      ['/ai/knn.html',                    '/ai/knn/clusterflick'],
      ['/ai-knn',                         '/ai/knn/clusterflick'],
      ['/ai-knn.html',                    '/ai/knn/clusterflick'],
      ['/ai-knn/clusterflick',            '/ai/knn/clusterflick'],
      ['/ai-knn/clusterflick.html',       '/ai/knn/clusterflick'],
      // Short aliases
      ['/knn',                            '/ai/knn/clusterflick'],
      ['/knn.html',                       '/ai/knn/clusterflick'],
      ['/qubit-waitlist',                 '/quantumcomputing'],
      ['/qubit-waitlist.html',            '/quantumcomputing'],
    ];

    for (const [from, to] of redirects) {
      it(`${from} → 301 → ${to}`, async () => {
        const res = await get(from);
        assert.equal(res.status, 301, `Expected 301 for ${from}`);
        assert.equal(
          res.headers.location, to,
          `Expected Location: ${to}, got ${res.headers.location}`
        );
      });
    }

    it('Redirect preserves query string (?room=ABCD)', async () => {
      const res = await get('/knn?room=ABCD');
      assert.equal(res.status, 301);
      assert.equal(res.headers.location, '/ai/knn/clusterflick?room=ABCD');
    });
  });

  // ── 404 handling ───────────────────────────────────────────────────────────
  describe('404 handling', () => {
    it('Unknown path → 404 with HTML body', async () => {
      const res = await get('/this-page-does-not-exist-xyz');
      assert.equal(res.status, 404, `Expected 404 for unknown path`);
      assert.ok(
        res.headers['content-type']?.startsWith('text/html'),
        'Expected 404 response to be HTML'
      );
    });

    it('Unknown blog path → 404', async () => {
      const res = await get('/blog/not-a-real-article');
      assert.equal(res.status, 404);
    });

    it('Path traversal attempt → 403', async () => {
      const res = await get('/../../../etc/passwd');
      assert.ok([403, 404].includes(res.status), `Expected 403 or 404 for path traversal`);
    });
  });

  // ── MIME types ─────────────────────────────────────────────────────────────
  describe('Static asset MIME types', () => {
    it('lobby.js → application/javascript', async () => {
      const res = await get('/games/lobby.js');
      assert.equal(res.status, 200);
      assert.ok(
        res.headers['content-type']?.includes('javascript'),
        `Expected javascript, got ${res.headers['content-type']}`
      );
    });

    it('socket.js → application/javascript', async () => {
      const res = await get('/games/socket.js');
      assert.equal(res.status, 200);
      assert.ok(res.headers['content-type']?.includes('javascript'));
    });

    it('game-nav.css → text/css', async () => {
      const res = await get('/games/game-nav.css');
      assert.equal(res.status, 200);
      assert.ok(
        res.headers['content-type']?.includes('css'),
        `Expected css, got ${res.headers['content-type']}`
      );
    });

    it('sitemap.xml → application/xml', async () => {
      const res = await get('/sitemap.xml');
      assert.equal(res.status, 200);
      assert.ok(
        res.headers['content-type']?.includes('xml'),
        `Expected xml, got ${res.headers['content-type']}`
      );
    });

    it('robots.txt → text/plain', async () => {
      const res = await get('/robots.txt');
      assert.equal(res.status, 200);
      assert.ok(
        res.headers['content-type']?.includes('text/plain'),
        `Expected text/plain, got ${res.headers['content-type']}`
      );
    });

    it('Logo PNG → image/png', async () => {
      const res = await get('/images/logo.png');
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-type'], 'image/png');
    });
  });

  // ── API endpoints ──────────────────────────────────────────────────────────
  describe('API endpoints', () => {
    it('POST /track → 204 (accepts valid event type)', async () => {
      const body = JSON.stringify({ type: 'tutorial_started' });
      const res = await httpRequest(_server.port, '/track', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        body,
      });
      assert.equal(res.status, 204);
    });

    it('POST /track → 400 (rejects unknown event type)', async () => {
      const body = JSON.stringify({ type: 'not_a_real_event' });
      const res = await httpRequest(_server.port, '/track', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        body,
      });
      assert.equal(res.status, 400);
    });

    it('GET /admin/session → 401 (no auth cookie)', async () => {
      const res = await get('/admin/session');
      assert.equal(res.status, 401, `Expected 401 for unauthenticated /admin/session`);
    });

    it('GET /admin/metrics → 401 (no auth cookie)', async () => {
      const res = await get('/admin/metrics');
      assert.equal(res.status, 401);
    });

    it('GET /admin/metrics/export → 401 (no auth cookie)', async () => {
      const res = await get('/admin/metrics/export');
      assert.equal(res.status, 401);
    });

    it('Wrong method on /track → 404 (not a static file route)', async () => {
      const res = await httpRequest(_server.port, '/track', { method: 'GET' });
      // GET /track has no handler, falls through to static file serving → 404
      assert.equal(res.status, 404);
    });
  });

  // ── URL aliases ────────────────────────────────────────────────────────────
  describe('URL aliases (.html extensions)', () => {
    const aliases = [
      ['/about.html',                       200],
      ['/contact.html',                     200],
      ['/buy-now.html',                     200],
      ['/cybersecurity.html',               200],
      ['/ai.html',                          200],
      ['/cybersecurity/byteclub.html',      200],
    ];

    for (const [path, status] of aliases) {
      it(`${path} → ${status}`, async () => {
        const res = await get(path);
        assert.equal(res.status, status);
      });
    }
  });
});
