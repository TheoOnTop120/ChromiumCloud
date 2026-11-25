'use strict';
const crypto = require('node:crypto');
const db = require('./db');

const SESSION_COOKIE = 'chromium_session';
const SESSION_TTL_HOURS = 8;

function sessionCookieOptions() {
  return { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(value); } catch { continue; }
  }
  return result;
}

let argon2InFlight = 0;
const MAX_ARGON2_IN_FLIGHT = 2;

const argon2 = (message, nonce) => new Promise((resolve, reject) => {
  if (argon2InFlight >= MAX_ARGON2_IN_FLIGHT) {
    const error = new Error('Authentication capacity temporarily unavailable.');
    error.status = 503;
    reject(error);
    return;
  }
  argon2InFlight += 1;
  crypto.argon2('argon2id', {
    message,
    nonce,
    parallelism: 1,
    tagLength: 32,
    memory: 65536,
    passes: 3,
  }, (error, derivedKey) => {
    argon2InFlight -= 1;
    if (error) reject(error); else resolve(derivedKey);
  });
});

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) {
    throw new Error('Le mot de passe doit contenir entre 12 et 1024 caractères.');
  }
  const salt = crypto.randomBytes(16);
  const derived = await argon2(Buffer.from(password, 'utf8'), salt);
  return `argon2id$v=19$m=65536,t=3,p=1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const match = /^argon2id\$v=19\$m=65536,t=3,p=1\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(encoded);
  if (!match) return false;
  const salt = Buffer.from(match[1], 'base64url');
  const expected = Buffer.from(match[2], 'base64url');
  if (salt.length !== 16 || expected.length !== 32) return false;
  const actual = await argon2(Buffer.from(password, 'utf8'), salt);
  return crypto.timingSafeEqual(actual, expected);
}

function generateOpaqueToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
function csrfTokenForSession(sessionToken) { return crypto.createHmac('sha256', sessionToken).update('chromium-multi-csrf-v1').digest('base64url'); }

function requireSession(databaseIgnored) {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[SESSION_COOKIE];
    if (!sessionId) return res.status(401).json({ error: 'Authentification requise.' });
    const session = db.getActiveSession(hashToken(sessionId));
    if (!session) return res.status(401).json({ error: 'Session invalide ou expirée.' });
    // check expiry
    if (new Date(session.expires_at).getTime() < Date.now()) {
      db.revokeSession(hashToken(sessionId));
      return res.status(401).json({ error: 'Session expirée.' });
    }
    if (!session.active) return res.status(403).json({ error: 'Compte désactivé.' });
    req.user = {
      id: session.user_id,
      username: session.username,
      email: session.email,
      displayName: session.display_name || session.username,
      role: session.role,
    };
    req.sessionRow = session;
    req.sessionToken = sessionId;
    db.touchSession(session.session_id);
    next();
  };
}

function requireCsrf() {
  return (req, res, next) => {
    const provided = req.headers['x-csrf-token'];
    if (typeof provided !== 'string' || !req.sessionRow?.csrf_token_hash) {
      return res.status(403).json({ error: 'Jeton CSRF manquant.' });
    }
    const actual = Buffer.from(hashToken(provided), 'hex');
    const expected = Buffer.from(req.sessionRow.csrf_token_hash, 'hex');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(403).json({ error: 'Jeton CSRF invalide.' });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentification requise.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Accès administrateur requis.' });
  next();
}

function requireSameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') {
    // allow if no origin (same-origin navigation) but for API we require origin on POST
    if (req.method === 'GET') return next();
    return res.status(403).json({ error: 'Origine manquante.' });
  }
  try {
    const parsed = new URL(origin);
    if (parsed.host !== req.headers.host) {
      return res.status(403).json({ error: 'Origine refusée.' });
    }
  } catch {
    return res.status(403).json({ error: 'Origine invalide.' });
  }
  next();
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_HOURS*3600}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

module.exports = {
  SESSION_COOKIE,
  parseCookies,
  hashPassword,
  verifyPassword,
  generateOpaqueToken,
  hashToken,
  csrfTokenForSession,
  requireSession,
  requireCsrf,
  requireAdmin,
  requireSameOrigin,
  setSessionCookie,
  clearSessionCookie,
  SESSION_TTL_HOURS,
};
