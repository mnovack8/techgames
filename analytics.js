'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');

// ==================== METRICS ====================
const METRICS_FILE = path.join(__dirname, 'metrics.json');
let metricsEvents = [];

// Load persisted events on startup
try {
  const raw = fs.readFileSync(METRICS_FILE, 'utf8');
  metricsEvents = JSON.parse(raw);
} catch (e) { metricsEvents = []; }

// Unique-visitor deduplication — one homepage_visit per IP per calendar day.
// We store a hashed token (SHA-256 of IP + date) in the event so raw IPs are never persisted.
const seenVisitors = new Set();

// Known visitor IDs (SHA-256 of IP only, no date) — used for return-visitor detection.
// Rebuilt from persisted events on startup; never pruned (all-time uniqueness).
const knownVisitors = new Set(
  metricsEvents.filter(e => e.type === 'homepage_visit' && e.vid).map(e => e.vid)
);

function pruneSeenVisitors() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  seenVisitors.clear();
  for (const e of metricsEvents) {
    if (e.type === 'homepage_visit' && e.uvKey && e.ts >= cutoff) seenVisitors.add(e.uvKey);
  }
}

// Build from persisted events on startup, then prune hourly
pruneSeenVisitors();
setInterval(pruneSeenVisitors, 60 * 60 * 1000);

function visitorKey(req) {
  const ip  = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
              || req.socket.remoteAddress || 'unknown';
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
  return crypto.createHash('sha256').update(ip + '|' + day).digest('hex').slice(0, 24);
}

// IP-only hash (no date) — identifies a visitor across days for return-visit tracking
function rawVisitorId(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
             || req.socket.remoteAddress || 'unknown';
  return crypto.createHash('sha256').update('vid|' + ip).digest('hex').slice(0, 24);
}

// Returns true if this uvKey completed a game of the same type within the last 30 minutes
function isRematch(uvKey, gameType) {
  if (!uvKey) return false;
  const cutoff = Date.now() - 30 * 60 * 1000;
  return metricsEvents.some(e =>
    e.type === 'session_completed' && e.uvKey === uvKey &&
    e.gameType === gameType && e.ts >= cutoff
  );
}

function saveMetrics() {
  // Keep at most 2 years of events (730 days) to prevent unbounded growth
  const cutoff = Date.now() - 730 * 24 * 60 * 60 * 1000;
  metricsEvents = metricsEvents.filter(e => e.ts >= cutoff);
  fs.writeFile(METRICS_FILE, JSON.stringify(metricsEvents), () => {});
}

function trackEvent(type, extra = {}) {
  const event = { type, ts: Date.now(), ...extra };
  metricsEvents.push(event);
  saveMetrics();
  syncEventToSheets(event); // fire-and-forget to Google Sheets
}

function makeBuckets(cutoff, days) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const n = days <= 30 ? days : days <= 90 ? Math.ceil(days / 3) : Math.ceil(days / 7);
  const bucketMs = (days * DAY_MS) / n;
  const labels = [];
  for (let i = 0; i < n; i++) {
    const t = new Date(cutoff + (i + 0.5) * bucketMs);
    labels.push(t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  }
  return { n, bucketMs, labels };
}

function bucketIdx(ts, cutoff, bucketMs, n) {
  return Math.min(n - 1, Math.floor((ts - cutoff) / bucketMs));
}

function getMetrics(days, page = 'homepage') {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const ev = metricsEvents.filter(e => e.ts >= cutoff);
  const { n, bucketMs, labels } = makeBuckets(cutoff, days);

  if (page === 'homepage') {
    const hpSeries      = new Array(n).fill(0);
    const fnPhysSeries  = new Array(n).fill(0);
    const bcPhysSeries  = new Array(n).fill(0);
    const qubitSeries   = new Array(n).fill(0);
    let hp = 0, fnPhys = 0, bcPhys = 0, qubit = 0;
    let returnVisitors = 0, wsDCTotal = 0;
    const referrers = { direct: 0, search: 0, linkedin: 0, other: 0 };
    const hourly    = new Array(24).fill(0);

    // Pre-build set of uvKeys that took any action (for bounce rate)
    const engagedUvKeys = new Set(ev.filter(e => e.type !== 'homepage_visit' && e.uvKey).map(e => e.uvKey));
    let bounced = 0;

    // Total sessions started in period (for WS disconnect rate denominator)
    const totalSessions = ev.filter(e => e.type === 'session_started').length;

    for (const e of ev) {
      const i = bucketIdx(e.ts, cutoff, bucketMs, n);
      if (e.type === 'homepage_visit') {
        hp++; hpSeries[i]++;
        if (e.returnVisitor) returnVisitors++;
        if (e.referrerSource && referrers[e.referrerSource] !== undefined) referrers[e.referrerSource]++;
        hourly[new Date(e.ts).getUTCHours()]++;
        if (e.uvKey && !engagedUvKeys.has(e.uvKey)) bounced++;
      }
      if (e.type === 'button_click') {
        if (e.button === 'fuzznet_physical')  { fnPhys++;  fnPhysSeries[i]++; }
        if (e.button === 'byteclub_physical') { bcPhys++;  bcPhysSeries[i]++; }
        if (e.button === 'qubit_waitlist')    { qubit++;   qubitSeries[i]++;  }
      }
      if (e.type === 'ws_disconnect') wsDCTotal++;
    }

    const wsDCRate   = totalSessions > 0 ? Math.round(wsDCTotal / totalSessions * 100) : 0;
    const bounceRate = hp > 0 ? Math.round(bounced / hp * 100) : 0;
    const returnRate = hp > 0 ? Math.round(returnVisitors / hp * 100) : 0;

    // Play-to-click: visitors who completed a game AND clicked a buy button on the same day
    const completedKeys = new Set(ev.filter(e => e.type === 'session_completed' && e.uvKey).map(e => e.uvKey));
    const buyKeys       = new Set(ev.filter(e => e.type === 'button_click' && ['fuzznet_physical','byteclub_physical'].includes(e.button) && e.uvKey).map(e => e.uvKey));
    const playToBuy     = [...completedKeys].filter(k => buyKeys.has(k)).length;

    return { page: 'homepage', hp, fnPhys, bcPhys, qubit,
      returnVisitors, returnRate, bounceRate, wsDCTotal, wsDCRate, referrers, hourly, playToBuy,
      chart: { labels, hp: hpSeries, fnPhys: fnPhysSeries, bcPhys: bcPhysSeries, qubit: qubitSeries } };
  }

  if (page === 'funnel') {
    function funnelStats(events) {
      let visits = 0, fnStarted = 0, bcStarted = 0, fnCompleted = 0, bcCompleted = 0, fnBuys = 0, bcBuys = 0, qubitWL = 0;
      for (const e of events) {
        if (e.type === 'homepage_visit') visits++;
        if (e.type === 'session_started') {
          if (e.gameType === 'fuzznet')  fnStarted++;
          if (e.gameType === 'byteclub') bcStarted++;
        }
        if (e.type === 'session_completed') {
          if (e.gameType === 'fuzznet')  fnCompleted++;
          if (e.gameType === 'byteclub') bcCompleted++;
        }
        if (e.type === 'button_click') {
          if (e.button === 'fuzznet_physical')  fnBuys++;
          if (e.button === 'byteclub_physical') bcBuys++;
          if (e.button === 'qubit_waitlist')    qubitWL++;
        }
      }
      return { visits, fnStarted, bcStarted, fnCompleted, bcCompleted, fnBuys, bcBuys, qubitWL };
    }
    const curr = funnelStats(ev);
    // Previous equivalent period for comparison
    const prevCutoff = cutoff - days * 24 * 60 * 60 * 1000;
    const prevEv = metricsEvents.filter(e => e.ts >= prevCutoff && e.ts < cutoff);
    const prev = funnelStats(prevEv);
    return { page: 'funnel', ...curr, prev };
  }

  // fuzznet or byteclub page
  const gt = page; // 'fuzznet' | 'byteclub'
  const MODE_KEYS = ['tutorial', '1p_bot', '2p', '3p', '4p'];
  const startedSeries   = new Array(n).fill(0);
  const completedSeries = new Array(n).fill(0);
  const byMode          = { tutorial: 0, '1p_bot': 0, '2p': 0, '3p': 0, '4p': 0 };
  // Per-mode time series for chart filtering
  const modeStarted    = {};
  const modeCompleted  = {};
  for (const mk of MODE_KEYS) {
    modeStarted[mk]   = new Array(n).fill(0);
    modeCompleted[mk] = new Array(n).fill(0);
  }
  let started = 0, completed = 0, tutorials = 0, rematches = 0;
  let totalDuration = 0, durationCount = 0;

  for (const e of ev) {
    if (e.gameType !== gt) continue;
    const i = bucketIdx(e.ts, cutoff, bucketMs, n);
    if (e.type === 'session_started') {
      started++;
      startedSeries[i]++;
      if (e.rematch) rematches++;
      const mk = (e.mode && byMode[e.mode] !== undefined) ? e.mode : null;
      if (mk) { byMode[mk]++; modeStarted[mk][i]++; }
    }
    if (e.type === 'session_completed') {
      completed++; completedSeries[i]++;
      if (e.duration) { totalDuration += e.duration; durationCount++; }
    }
    if (e.type === 'tutorial_started')  { tutorials++; byMode.tutorial++; modeStarted.tutorial[i]++; }
  }

  const pct         = (started + completed) > 0 ? Math.round(completed / (completed + Math.max(started - completed, 0)) * 100) : 0;
  const avgDuration = durationCount > 0 ? Math.round(totalDuration / durationCount / 60 * 10) / 10 : null; // minutes, 1 dp
  const rematchRate = started > 0 ? Math.round(rematches / started * 100) : 0;

  return { page: gt, started, completed, tutorials, pct, by_mode: byMode,
    avgDuration, rematches, rematchRate,
    chart: { labels, started: startedSeries, completed: completedSeries, modeStarted } };
}

// Public lightweight tracking endpoint — called from game/index pages
function handleTrack(req, res) {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    try {
      const e = JSON.parse(body);
      const ALLOWED = ['button_click', 'session_started', 'tutorial_started'];
      const ALLOWED_BUTTONS = ['fuzznet_physical', 'byteclub_physical', 'qubit_waitlist'];
      if (!ALLOWED.includes(e.type)) { res.writeHead(400); res.end(); return; }
      if (e.type === 'button_click' && !ALLOWED_BUTTONS.includes(e.button)) { res.writeHead(400); res.end(); return; }
      // Sanitise — only keep known fields; attach visitor key for funnel correlation
      const safe = { type: e.type, uvKey: visitorKey(req) };
      if (e.gameType) safe.gameType = e.gameType;
      if (e.mode)     safe.mode     = e.mode;
      if (e.button)   safe.button   = e.button;
      trackEvent(safe.type, safe);
    } catch(err) {}
    res.writeHead(204); res.end();
  });
}

async function handleAdminMetrics(req, res, verifyToken, getSessionCookie) {
  if (!verifyToken(getSessionCookie(req))) { res.writeHead(401); res.end('Unauthorized'); return; }
  try {
    const u    = new URL(req.url, `http://${req.headers.host}`);
    const days = parseInt(u.searchParams.get('days') || '30', 10);
    const page = u.searchParams.get('page') || 'homepage';
    const result = getMetrics(days, page);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch(e) {
    console.error('[admin/metrics] error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleAdminExportCSV(req, res, verifyToken, getSessionCookie) {
  if (!verifyToken(getSessionCookie(req))) { res.writeHead(401); res.end('Unauthorized'); return; }
  const u = new URL(req.url, `http://${req.headers.host}`);
  const days = parseInt(u.searchParams.get('days') || '365', 10);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const ev = metricsEvents.filter(e => e.ts >= cutoff);
  const lines = ['timestamp,type,gameType,mode'];
  for (const e of ev) {
    lines.push(`${new Date(e.ts).toISOString()},${e.type},${e.gameType||''},${e.mode||''}`);
  }
  res.writeHead(200, {
    'Content-Type': 'text/csv',
    'Content-Disposition': `attachment; filename="techgames-metrics-${days}d.csv"`,
  });
  res.end(lines.join('\n'));
}

// ==================== GOOGLE SHEETS SYNC ====================
// Credentials come from env vars — no JSON file needed.
// On localhost these vars are not set so all sync is silently skipped.

function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key   = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !key) return null;
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: email,
        private_key: key.replace(/\\n/g, '\n'), // PM2 stores \n as literal \\n
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
  } catch (e) { return null; }
}

// Real-time: append one row to the Events tab on every tracked event
async function syncEventToSheets(event) {
  const sheets = getSheetsClient();
  if (!sheets) return;
  const sid = process.env.SHEETS_ID;
  if (!sid) return;
  try {
    const row = [
      new Date(event.ts).toISOString(),
      event.type,
      event.gameType || '',
      event.mode     || '',
      event.button   || '',
      event.uvKey    || '',
      event.referrer || '',
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: sid,
      range: 'Events!A:G',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  } catch (e) { /* Sheets unavailable — local metrics still intact */ }
}

// Nightly: write one summary row per tab for yesterday (ET)
async function writeDailySummary() {
  const sheets = getSheetsClient();
  if (!sheets) return;
  const sid = process.env.SHEETS_ID;
  if (!sid) return;

  // Yesterday's window in ET
  const etNow       = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etToday     = new Date(etNow); etToday.setHours(0, 0, 0, 0);
  const etYesterday = new Date(etToday.getTime() - 24 * 60 * 60 * 1000);
  const dateStr     = etYesterday.toLocaleDateString('en-US', { timeZone: 'America/New_York' });
  const utcOffset   = new Date().getTime() - etNow.getTime();
  const startUTC    = etYesterday.getTime() - utcOffset;
  const endUTC      = etToday.getTime()     - utcOffset;
  const ev = metricsEvents.filter(e => e.ts >= startUTC && e.ts < endUTC);

  // ── Homepage summary ──
  let visits = 0, fnPhys = 0, bcPhys = 0, qubitWL = 0;
  let direct = 0, search = 0, linkedin = 0, refOther = 0;
  let bounces = 0, wsDC = 0;
  for (const e of ev) {
    if (e.type === 'homepage_visit') {
      visits++;
      if      (e.referrer === 'direct')   direct++;
      else if (e.referrer === 'search')   search++;
      else if (e.referrer === 'linkedin') linkedin++;
      else if (e.referrer === 'other')    refOther++;
    }
    if (e.type === 'button_click') {
      if (e.button === 'fuzznet_physical')  fnPhys++;
      if (e.button === 'byteclub_physical') bcPhys++;
      if (e.button === 'qubit_waitlist')    qubitWL++;
    }
    if (e.type === 'bounce')        bounces++;
    if (e.type === 'ws_disconnect') wsDC++;
  }
  const bounceRate = visits > 0 ? Math.round(bounces / visits * 100) : 0;

  // ── Per-game summary ──
  const gameStats = {};
  for (const gt of ['fuzznet', 'byteclub']) {
    let started = 0, completed = 0, tutorials = 0, rematches = 0;
    let totalDur = 0, durCount = 0;
    const byMode = { '1p_bot': 0, '2p': 0, '3p': 0, '4p': 0, tutorial: 0 };
    for (const e of ev) {
      if (e.gameType !== gt) continue;
      if (e.type === 'session_started')   { started++;   if (e.mode && byMode[e.mode] !== undefined) byMode[e.mode]++; }
      if (e.type === 'session_completed') { completed++; if (e.duration_ms) { totalDur += e.duration_ms; durCount++; } if (e.rematch) rematches++; }
      if (e.type === 'tutorial_started')  tutorials++;
    }
    gameStats[gt] = {
      started, completed,
      pct:    started  > 0 ? Math.round(completed / started * 100) : 0,
      avgDur: durCount > 0 ? Math.round(totalDur  / durCount / 1000) : 0,
      tutorials, rematches, byMode,
    };
  }

  // ── Funnel summary ──
  const totalStarted   = (gameStats.fuzznet.started   || 0) + (gameStats.byteclub.started   || 0);
  const totalCompleted = (gameStats.fuzznet.completed || 0) + (gameStats.byteclub.completed || 0);
  const totalBuys      = fnPhys + bcPhys;
  const r1 = visits        > 0 ? Math.round(totalStarted   / visits        * 100) : 0;
  const r2 = totalStarted  > 0 ? Math.round(totalCompleted / totalStarted  * 100) : 0;
  const r3 = totalCompleted > 0 ? Math.round(totalBuys      / totalCompleted * 100) : 0;

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sid, range: 'Daily Homepage!A:K', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[dateStr, visits, fnPhys, bcPhys, qubitWL, direct, search, linkedin, refOther, bounceRate + '%', wsDC]] },
    });
    for (const [gt, s] of Object.entries(gameStats)) {
      const name = gt === 'fuzznet' ? 'FuzzNet Labs' : 'Byte Club';
      await sheets.spreadsheets.values.append({
        spreadsheetId: sid, range: 'Daily Games!A:L', valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[dateStr, name, s.started, s.completed, s.pct + '%', s.tutorials, s.byMode['1p_bot'], s.byMode['2p'], s.byMode['3p'], s.byMode['4p'], s.avgDur + 's', s.rematches]] },
      });
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: sid, range: 'Daily Funnel!A:H', valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[dateStr, visits, totalStarted, totalCompleted, totalBuys, r1 + '%', r2 + '%', r3 + '%']] },
    });
    console.log('[sheets] Daily summary written for', dateStr);
  } catch (e) { console.error('[sheets] writeDailySummary error:', e.message); }
}

// Schedule writeDailySummary every night at midnight ET
function scheduleMidnightSync() {
  const etNow      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etMidnight = new Date(etNow); etMidnight.setHours(24, 0, 0, 0);
  const ms = etMidnight - etNow;
  setTimeout(() => { writeDailySummary(); scheduleMidnightSync(); }, ms);
}
scheduleMidnightSync();

module.exports = {
  trackEvent,
  getMetrics,
  handleTrack,
  handleAdminMetrics,
  handleAdminExportCSV,
  visitorKey,
  rawVisitorId,
  isRematch,
  seenVisitors,
  knownVisitors,
};
