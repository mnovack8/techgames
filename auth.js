'use strict';
const crypto = require('crypto');

// ==================== ADMIN AUTH ====================
// GOOGLE_CLIENT_ID is public — it's already embedded in admin.html
const GOOGLE_CLIENT_ID = '655697852569-e4uu415rmg73dlggn6ih4llh15lnneeo.apps.googleusercontent.com';
const ADMIN_EMAIL = 'mnovack8@gmail.com';
// Random secret generated at startup — no env vars required; sessions reset on server restart
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

// In-memory session store: token → { email, expires }
const adminSessions = new Map();

function makeSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function signToken(token) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex') + '.' + token;
}

function verifyToken(signed) {
  if (!signed) return null;
  const [sig, token] = signed.split('.');
  if (!token) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const sess = adminSessions.get(token);
  if (!sess || Date.now() > sess.expires) { adminSessions.delete(token); return null; }
  return sess;
}

function getSessionCookie(req) {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)admin_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function handleAdminVerify(req, res) {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', async () => {
    try {
      const { credential } = JSON.parse(body);
      // Verify token with Google's tokeninfo endpoint — no secret needed for GIS tokens
      const gRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
      const gData = await gRes.json();
      if (!gRes.ok || gData.aud !== GOOGLE_CLIENT_ID || gData.email !== ADMIN_EMAIL) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      // Issue a signed session cookie (httpOnly, SameSite=Strict — never readable by JS)
      const token  = makeSessionToken();
      const signed = signToken(token);
      adminSessions.set(token, { email: gData.email, expires: Date.now() + 8 * 60 * 60 * 1000 }); // 8h
      const secure = req.headers.host && !req.headers.host.startsWith('localhost') ? '; Secure' : '';
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `admin_session=${encodeURIComponent(signed)}; HttpOnly; SameSite=Strict; Path=/admin${secure}`
      });
      res.end(JSON.stringify({ ok: true, email: gData.email }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    }
  });
}

function handleAdminSession(req, res) {
  const sess = verifyToken(getSessionCookie(req));
  res.writeHead(sess ? 200 : 401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(sess ? { ok: true, email: sess.email } : { ok: false }));
}

function handleAdminSignout(req, res) {
  const raw = getSessionCookie(req);
  if (raw) { const token = raw.split('.')[1]; adminSessions.delete(token); }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': 'admin_session=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0'
  });
  res.end(JSON.stringify({ ok: true }));
}

module.exports = {
  handleAdminVerify,
  handleAdminSession,
  handleAdminSignout,
  verifyToken,
  getSessionCookie,
};
