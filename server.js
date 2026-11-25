'use strict';
const express = require('express');
const http = require('node:http');
const httpProxy = require('http-proxy');
const cookieParser = require('cookie-parser');
const fs = require('node:fs');
const path = require('node:path');

const db = require('./src/db');
const auth = require('./src/auth');
const containers = require('./src/containers');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MAX_SESSIONS = containers.MAX_SESSIONS;
const ALLOW_REGISTRATION = (process.env.ALLOW_REGISTRATION || 'false').toLowerCase() === 'true';

const app = express();
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; frame-src 'self'; frame-ancestors 'self';");
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function getSessionUser(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  const sid = cookies[auth.SESSION_COOKIE];
  if (!sid) return null;
  const session = db.getActiveSession(auth.hashToken(sid));
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  if (!session.active) return null;
  return { session, sid, user: { id: session.user_id, username: session.username, email: session.email, displayName: session.display_name || session.username, role: session.role } };
}

function requireAuthPage(req, res, next) {
  const su = getSessionUser(req);
  if (!su) return res.redirect('/login');
  req.user = su.user;
  req.sessionRow = su.session;
  req.sessionToken = su.sid;
  next();
}
function requireAdminPage(req, res, next) {
  const su = getSessionUser(req);
  if (!su) return res.redirect('/login');
  if (su.user.role !== 'admin') return res.status(403).send('Forbidden');
  req.user = su.user;
  req.sessionRow = su.session;
  req.sessionToken = su.sid;
  next();
}

// bootstrap admin
function bootstrapAdmin() {
  const users = db.listUsers();
  if (users.length > 0) return;
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.error('ADMIN_PASSWORD not set and no users exist.');
    return;
  }
  (async () => {
    const hash = await auth.hashPassword(password);
    const id = db.createUser({ username, passwordHash: hash, role: 'admin' });
    db.createAuditLog({ actorUserId: id, action: 'bootstrap_admin', targetType: 'user', targetId: id, details: 'Initial admin created' });
    console.log(`Bootstrap admin created: username=${username} id=${id}`);
  })().catch(e => console.error('bootstrap admin failed:', e));
}
bootstrapAdmin();

setInterval(() => { try { db.cleanupExpiredSessions(); } catch (e) {} }, 10 * 60 * 1000);

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: true });
proxy.on('error', (err, req, res) => {
  if (res && typeof res.status === 'function') {
    try { res.status(502).json({ error: 'Proxy error: ' + err.message }); } catch {}
  } else if (res && res.destroy) {
    res.destroy();
  }
});

function audit(req, action, targetType, targetId, details) {
  try {
    const uid = req?.user?.id || null;
    db.createAuditLog({ actorUserId: uid, action, targetType, targetId, details });
  } catch (e) {}
}

// rate limit login
const loginAttempts = new Map();
function rateLimitLogin(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const max = 10;
  const entry = loginAttempts.get(ip) || { count: 0, reset: now + windowMs };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
  if (entry.count >= max) {
    return res.status(429).json({ error: 'Trop de tentatives. Réessayez plus tard.' });
  }
  entry.count += 1;
  loginAttempts.set(ip, entry);
  next();
}

// --- health ---
app.get('/health', (req, res) => res.json({ ok: true, maxSessions: MAX_SESSIONS, active: containers.activeCount() }));

// --- public pages ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/home', (req, res) => res.redirect('/'));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/forgot-password', (req, res) => res.sendFile(path.join(__dirname, 'public', 'forgot-password.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));

// --- user pages ---
app.get('/dashboard', requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/portal', requireAuthPage, (req, res) => res.redirect('/dashboard'));
app.get('/session', requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'session.html')));
app.get('/session/:id', requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'session.html')));
app.get('/settings', requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/profile', requireAuthPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'profile.html')));

// --- admin pages ---
app.get('/admin', requireAdminPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/admin/*', requireAdminPage, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// --- auth api ---
app.get('/api/csrf', auth.requireSession(), (req, res) => {
  const su = getSessionUser(req);
  if (!su) return res.status(401).json({ error: 'Authentification requise.' });
  const token = auth.csrfTokenForSession(su.sid);
  res.json({ csrfToken: token });
});

app.post('/api/auth/login', auth.requireSameOrigin, rateLimitLogin, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Identifiants invalides.' });
  }
  const user = db.getUserByUsername(username.trim());
  if (!user || !user.active) {
    await auth.verifyPassword(password, await auth.hashPassword('dummydummydummy1')).catch(()=>false);
    return res.status(401).json({ error: 'Identifiants invalides.' });
  }
  const ok = await auth.verifyPassword(password, user.password_hash);
  if (!ok) {
    db.createAuditLog({ actorUserId: user.id, action: 'login_failed', targetType: 'user', targetId: user.id });
    return res.status(401).json({ error: 'Identifiants invalides.' });
  }
  const token = auth.generateOpaqueToken(32);
  const csrf = auth.csrfTokenForSession(token);
  db.createSession(user.id, auth.hashToken(token), auth.hashToken(csrf), auth.SESSION_TTL_HOURS || 8);
  auth.setSessionCookie(res, token);
  db.updateUser(user.id, { lastLoginAt: new Date().toISOString() });
  db.createAuditLog({ actorUserId: user.id, action: 'login_success', targetType: 'user', targetId: user.id });
  containers.startContainer(user.id).catch(e => console.error('start container failed:', e.message));
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/auth/register', auth.requireSameOrigin, async (req, res) => {
  if (!ALLOW_REGISTRATION) return res.status(403).json({ error: 'Inscription désactivée.' });
  const { username, password, email, displayName } = req.body || {};
  if (typeof username !== 'string' || !username.trim()) return res.status(400).json({ error: 'Nom d’utilisateur requis.' });
  if (typeof password !== 'string') return res.status(400).json({ error: 'Mot de passe requis.' });
  if (db.getUserByUsername(username.trim())) return res.status(409).json({ error: 'Utilisateur déjà existant.' });
  let hash;
  try { hash = await auth.hashPassword(password); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const id = db.createUser({ username: username.trim(), passwordHash: hash, role: 'user', email: email || null, displayName: displayName || null });
  db.createAuditLog({ actorUserId: id, action: 'register', targetType: 'user', targetId: id, details: 'Self-registration' });
  res.json({ ok: true, id });
});

app.post('/api/auth/forgot-password', auth.requireSameOrigin, (req, res) => {
  // Generic response to avoid user enumeration
  res.json({ ok: true, message: 'Si le compte existe, contactez l’administrateur pour la réinitialisation.' });
});

app.post('/api/auth/logout', auth.requireSession(), auth.requireCsrf(), (req, res) => {
  const cookies = auth.parseCookies(req.headers.cookie);
  const sid = cookies[auth.SESSION_COOKIE];
  if (sid) db.revokeSession(auth.hashToken(sid));
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', auth.requireSession(), (req, res) => {
  res.json({ user: req.user });
});

// container status api (user)
app.get('/api/container/status', auth.requireSession(), (req, res) => {
  const userId = req.user.id;
  const sessions = containers.listUserSessions();
  const mine = sessions.find(s => s.userId === userId);
  res.json({
    running: containers.isRunning(userId),
    state: containers.inspectState(userId),
    startedAt: containers.inspectStartedAt(userId),
    active: containers.activeCount(),
    max: MAX_SESSIONS,
    idleMs: mine ? mine.idleMs : null,
  });
});

app.post('/api/container/start', auth.requireSession(), auth.requireSameOrigin, auth.requireCsrf(), async (req, res) => {
  const userId = req.user.id;
  try {
    await containers.startContainer(userId);
    containers.touchActivity(userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

app.post('/api/container/stop', auth.requireSession(), auth.requireSameOrigin, auth.requireCsrf(), (req, res) => {
  const userId = req.user.id;
  containers.stopContainer(userId);
  res.json({ ok: true });
});

// profile update (user)
app.patch('/api/user/profile', auth.requireSession(), auth.requireSameOrigin, auth.requireCsrf(), async (req, res) => {
  const id = req.user.id;
  const fields = {};
  if (typeof req.body.displayName === 'string') fields.displayName = req.body.displayName;
  if (typeof req.body.email === 'string') fields.email = req.body.email;
  if (typeof req.body.password === 'string' && req.body.password.length > 0) {
    try { fields.passwordHash = await auth.hashPassword(req.body.password); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  db.updateUser(id, fields);
  res.json({ ok: true });
});

// admin api (keep from scaffold)
app.get('/api/admin/overview', auth.requireSession(), auth.requireAdmin, (req, res) => {
  const sys = containers.systemStats();
  const sessions = containers.listUserSessions();
  res.json({
    users: db.countUsers(),
    authSessions: db.countActiveAuthSessions(),
    activeBrowsers: containers.activeCount(),
    maxSessions: MAX_SESSIONS,
    available: Math.max(0, MAX_SESSIONS - containers.activeCount()),
    containers: sessions,
    system: sys,
    uptimeSeconds: sys.uptime,
  });
});

app.get('/api/admin/users', auth.requireSession(), auth.requireAdmin, (req, res) => {
  const users = db.listUsers();
  const sessions = containers.listUserSessions();
  const runningSet = new Set(sessions.filter(s => s.running).map(s => s.userId));
  const enhanced = users.map(u => ({
    ...u,
    hasActiveSession: runningSet.has(u.id),
    sessionState: sessions.find(s => s.userId === u.id)?.state || 'absent',
  }));
  res.json({ users: enhanced });
});

app.post('/api/admin/users', auth.requireSession(), auth.requireAdmin, auth.requireSameOrigin, auth.requireCsrf(), async (req, res) => {
  const { username, password, role, email, displayName } = req.body || {};
  if (typeof username !== 'string' || !username.trim()) return res.status(400).json({ error: 'Nom d’utilisateur requis.' });
  if (typeof password !== 'string') return res.status(400).json({ error: 'Mot de passe requis.' });
  if (db.getUserByUsername(username.trim())) return res.status(409).json({ error: 'Utilisateur déjà existant.' });
  let hash;
  try { hash = await auth.hashPassword(password); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const id = db.createUser({ username: username.trim(), passwordHash: hash, role: role === 'admin' ? 'admin' : 'user', email: email || null, displayName: displayName || null });
  audit(req, 'user_create', 'user', id, `username=${username.trim()} role=${role === 'admin' ? 'admin' : 'user'}`);
  res.json({ ok: true, id });
});

app.patch('/api/admin/users/:id', auth.requireSession(), auth.requireAdmin, auth.requireSameOrigin, auth.requireCsrf(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.getUserById(id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  const fields = {};
  if (typeof req.body.role === 'string') fields.role = req.body.role === 'admin' ? 'admin' : 'user';
  if (typeof req.body.active === 'boolean') fields.active = req.body.active;
  if (typeof req.body.email === 'string') fields.email = req.body.email;
  if (typeof req.body.displayName === 'string') fields.displayName = req.body.displayName;
  if (typeof req.body.password === 'string' && req.body.password.length > 0) {
    try { fields.passwordHash = await auth.hashPassword(req.body.password); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  db.updateUser(id, fields);
  if (fields.active === false) {
    containers.stopContainer(id);
    db.revokeAllUserSessions(id);
    audit(req, 'user_deactivate', 'user', id, 'account disabled');
  } else if (fields.passwordHash) {
    audit(req, 'user_password_reset', 'user', id, 'password changed by admin');
  } else {
    audit(req, 'user_update', 'user', id, JSON.stringify(fields));
  }
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', auth.requireSession(), auth.requireAdmin, auth.requireSameOrigin, auth.requireCsrf(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) return res.status(400).json({ error: 'Impossible de supprimer son propre compte.' });
  containers.stopContainer(id);
  containers.removeContainer(id);
  db.revokeAllUserSessions(id);
  db.deleteUser(id);
  audit(req, 'user_delete', 'user', id, 'user deleted');
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reset-access', auth.requireSession(), auth.requireAdmin, auth.requireSameOrigin, auth.requireCsrf(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = db.getUserById(id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
  containers.stopContainer(id);
  containers.removeContainer(id);
  db.revokeAllUserSessions(id);
  audit(req, 'user_access_reset', 'user', id, 'sessions revoked, container removed');
  res.json({ ok: true });
});

app.get('/api/admin/events', auth.requireSession(), auth.requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  const send = () => {
    try {
      const sys = containers.systemStats();
      const sessions = containers.userSessionStats();
      const payload = {
        ts: Date.now(),
        activeBrowsers: containers.activeCount(),
        available: Math.max(0, containers.MAX_SESSIONS - containers.activeCount()),
        users: db.countUsers(),
        authSessions: db.countActiveAuthSessions(),
        system: sys,
        sessions: sessions,
      };
      res.write('data: ' + JSON.stringify(payload) + '\n\n');
    } catch (e) {}
  };
  send();
  const iv = setInterval(send, 4000);
  req.on('close', () => clearInterval(iv));
});

function toCsv(rows, headers) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? '"' + s + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => esc(row[h])).join(','));
  return lines.join('\n');
}

app.get('/api/admin/export/users', auth.requireSession(), auth.requireAdmin, (req, res) => {
  const users = db.listUsers();
  const sessions = containers.listUserSessions();
  const running = new Set(sessions.filter(s=>s.running).map(s=>s.userId));
  const rows = users.map(u => ({
    id: u.id, username: u.username, email: u.email, role: u.role, active: u.active,
    created_at: u.created_at, last_login_at: u.last_login_at,
    has_active_session: running.has(u.id) ? 'yes' : 'no',
  }));
  const csv = toCsv(rows, ['id','username','email','role','active','created_at','last_login_at','has_active_session']);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
  res.send(csv);
});

app.get('/api/admin/export/sessions', auth.requireSession(), auth.requireAdmin, (req, res) => {
  const sessions = containers.userSessionStats();
  const users = db.listUsers();
  const umap = new Map(users.map(u=>[u.id,u]));
  const rows = sessions.map(s => ({
    user_id: s.userId, username: (umap.get(s.userId)||{}).username,
    container: s.name, state: s.state, running: s.running,
    started_at: s.startedAt, idle_ms: s.idleMs,
    cpu: s.stats?s.stats.cpu:'', ram: s.stats?s.stats.memUsage:'', pids: s.stats?s.stats.pids:'',
  }));
  const csv = toCsv(rows, ['user_id','username','container','state','running','started_at','idle_ms','cpu','ram','pids']);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="sessions.csv"');
  res.send(csv);
});

app.get('/api/admin/export/audit', auth.requireSession(), auth.requireAdmin, (req, res) => {
  const entries = db.listAuditLogs(1000);
  const rows = entries.map(e => ({
    id: e.id, date: e.created_at, actor: e.actor_username, action: e.action,
    target_type: e.target_type, target_id: e.target_id, details: e.details,
  }));
  const csv = toCsv(rows, ['id','date','actor','action','target_type','target_id','details']);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
  res.send(csv);
});

app.get('/api/admin/sessions', auth.requireSession(), auth.requireAdmin, (req, res) => {
  const sessions = containers.userSessionStats();
  const users = db.listUsers();
  const userMap = new Map(users.map(u => [u.id, u]));
  const enhanced = sessions.map(s => ({ ...s, user: userMap.get(s.userId) || null }));
  const withContainer = new Set(sessions.map(s => s.userId));
  const inactive = users.filter(u => !withContainer.has(u.id)).map(u => ({
    userId: u.id,
    name: containers.containerName(u.id),
    state: 'absent',
    running: false,
    startedAt: null,
    idleMs: null,
    stats: null,
    user: u,
  }));
  res.json({ active: enhanced.filter(s => s.running), all: enhanced, inactive });
});

app.post('/api/admin/sessions/:userId/stop', auth.requireSession(), auth.requireAdmin, auth.requireSameOrigin, auth.requireCsrf(), (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  containers.stopContainer(userId);
  audit(req, 'session_stop', 'session', userId, 'admin stopped browser');
  res.json({ ok: true });
});

app.post('/api/admin/sessions/:userId/restart', auth.requireSession(), auth.requireAdmin, auth.requireSameOrigin, auth.requireCsrf(), async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  try {
    containers.stopContainer(userId);
    containers.removeContainer(userId);
    await containers.startContainer(userId);
    audit(req, 'session_restart', 'session', userId, 'admin restarted browser');
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

app.post('/api/admin/sessions/:userId/remove', auth.requireSession(), auth.requireAdmin, auth.requireSameOrigin, auth.requireCsrf(), (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  containers.stopContainer(userId);
  containers.removeContainer(userId);
  audit(req, 'session_remove', 'session', userId, 'admin removed browser container');
  res.json({ ok: true });
});

app.get('/api/admin/resources', auth.requireSession(), auth.requireAdmin, (req, res) => {
  const sys = containers.systemStats();
  const stats = containers.userSessionStats();
  const dockerStats = containers.dockerStats();
  res.json({ system: sys, sessions: stats, docker: dockerStats, maxSessions: MAX_SESSIONS });
});

app.get('/api/admin/audit', auth.requireSession(), auth.requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  res.json({ entries: db.listAuditLogs(limit) });
});

app.get('/api/admin/settings', auth.requireSession(), auth.requireAdmin, (req, res) => {
  res.json({
    maxSessions: MAX_SESSIONS,
    idleStopMs: parseInt(process.env.IDLE_STOP_MS || '1800000', 10),
    chromiumImage: process.env.CHROMIUM_IMAGE || 'lscr.io/linuxserver/chromium:latest',
    sessionTtlHours: auth.SESSION_TTL_HOURS || 8,
    allowRegistration: ALLOW_REGISTRATION,
  });
});

app.get('/api/admin/logs', auth.requireSession(), auth.requireAdmin, (req, res) => {
  // recent audit as logs
  res.json({ entries: db.listAuditLogs(200) });
});

// --- /browser proxy (authenticated) ---
async function handleBrowser(req, res) {
  const su = getSessionUser(req);
  if (!su) return res.redirect('/login');
  const userId = su.user.id;
  containers.touchActivity(userId);
  try {
    await containers.startContainer(userId);
  } catch (e) {
    return res.status(503).send(e.message);
  }
  const target = `http://${containers.containerName(userId)}:3000`;
  proxy.web(req, res, { target }, (err) => {
    if (!res.headersSent) res.status(502).send('Proxy error: ' + err.message);
  });
}
app.use('/browser', handleBrowser);

// --- 404 ---
app.use((req, res) => {
  const su = getSessionUser(req);
  if (!su) {
    if (req.path === '/') return res.redirect('/');
    return res.status(401).json({ error: 'Authentification requise.' });
  }
  res.status(404).send('Not found');
});

const server = http.createServer(app);

server.on('upgrade', async (req, socket, head) => {
  if (!req.url.startsWith('/browser')) { socket.destroy(); return; }
  const su = getSessionUser(req);
  if (!su) { socket.destroy(); return; }
  const userId = su.user.id;
  containers.touchActivity(userId);
  try {
    await containers.startContainer(userId);
  } catch (e) {
    socket.destroy();
    return;
  }
  // strip prefix
  req.url = req.url.replace(/^\/browser/, '') || '/';
  const target = `http://${containers.containerName(userId)}:3000`;
  proxy.ws(req, socket, head, { target });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`chromium-cloud gateway listening on ${PORT}`);
});
