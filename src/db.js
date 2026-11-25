'use strict';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DB_PATH = process.env.DB_PATH || '/data/chromium-multi.sqlite';

let db;
function getDb() {
  if (db) return db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function tryAlter(sql) {
  try { getDb().exec(sql); } catch (e) { /* ignore duplicate column */ }
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      last_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  `);
  // backward-compat columns
  tryAlter('ALTER TABLE users ADD COLUMN last_login_at TEXT;');
  tryAlter('ALTER TABLE users ADD COLUMN display_name TEXT;');
  tryAlter('ALTER TABLE users ADD COLUMN updated_at TEXT;');
}

function nowIso() { return new Date().toISOString(); }
function addHours(date, h) { return new Date(date.getTime() + h*3600*1000).toISOString(); }

function createUser({ username, passwordHash, role = 'user', email = null, active = 1, displayName = null }) {
  const d = getDb();
  const stmt = d.prepare('INSERT INTO users (username,email,display_name,password_hash,role,active) VALUES (?,?,?,?,?,?)');
  const info = stmt.run(username, email, displayName, passwordHash, role, active ? 1 : 0);
  return Number(info.lastInsertRowid);
}

function getUserByUsername(username) {
  const d = getDb();
  return d.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
}

function getUserById(id) {
  const d = getDb();
  return d.prepare('SELECT id,username,email,display_name,role,active,created_at,last_login_at FROM users WHERE id = ?').get(id) || null;
}

function listUsers() {
  const d = getDb();
  return d.prepare('SELECT id,username,email,display_name,role,active,created_at,last_login_at FROM users ORDER BY id').all();
}

function updateUser(id, fields) {
  const d = getDb();
  const sets = [];
  const vals = [];
  if (fields.passwordHash !== undefined) { sets.push('password_hash = ?'); vals.push(fields.passwordHash); }
  if (fields.role !== undefined) { sets.push('role = ?'); vals.push(fields.role); }
  if (fields.active !== undefined) { sets.push('active = ?'); vals.push(fields.active ? 1 : 0); }
  if (fields.email !== undefined) { sets.push('email = ?'); vals.push(fields.email); }
  if (fields.displayName !== undefined) { sets.push('display_name = ?'); vals.push(fields.displayName); }
  if (fields.lastLoginAt !== undefined) { sets.push('last_login_at = ?'); vals.push(fields.lastLoginAt); }
  if (sets.length === 0) return;
  vals.push(id);
  d.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function deleteUser(id) {
  const d = getDb();
  d.prepare('DELETE FROM users WHERE id = ?').run(id);
}

function createSession(userId, tokenHash, csrfTokenHash, ttlHours = 8) {
  const d = getDb();
  const expires = addHours(new Date(), ttlHours);
  const info = d.prepare('INSERT INTO sessions (user_id,token_hash,csrf_token_hash,expires_at) VALUES (?,?,?,?)').run(userId, tokenHash, csrfTokenHash, expires);
  return Number(info.lastInsertRowid);
}

function getActiveSession(tokenHash) {
  const d = getDb();
  const row = d.prepare(`
    SELECT s.id AS session_id, s.user_id, s.csrf_token_hash, s.expires_at, s.created_at, s.last_seen,
           u.username, u.email, u.display_name, u.role, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`).get(tokenHash);
  return row || null;
}

function touchSession(sessionId) {
  const d = getDb();
  d.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").run(nowIso(), sessionId);
}

function revokeSession(tokenHash) {
  const d = getDb();
  d.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
}

function revokeAllUserSessions(userId) {
  const d = getDb();
  d.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function cleanupExpiredSessions() {
  const d = getDb();
  d.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
}

function countUsers() {
  const d = getDb();
  return d.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function countActiveAuthSessions() {
  const d = getDb();
  return d.prepare("SELECT COUNT(*) AS c FROM sessions WHERE expires_at >= ?").get(nowIso()).c;
}

function createAuditLog({ actorUserId = null, action, targetType = null, targetId = null, details = null }) {
  const d = getDb();
  d.prepare('INSERT INTO audit_log (actor_user_id,action,target_type,target_id,details) VALUES (?,?,?,?,?)')
    .run(actorUserId, action, targetType, targetId == null ? null : String(targetId), details);
}

function listAuditLogs(limit = 100) {
  const d = getDb();
  return d.prepare(`
    SELECT a.id,a.actor_user_id,u.username AS actor_username,a.action,a.target_type,a.target_id,a.details,a.created_at
    FROM audit_log a LEFT JOIN users u ON u.id=a.actor_user_id
    ORDER BY a.id DESC LIMIT ?`).all(limit);
}

module.exports = {
  getDb,
  createUser,
  getUserByUsername,
  getUserById,
  listUsers,
  updateUser,
  deleteUser,
  createSession,
  getActiveSession,
  touchSession,
  revokeSession,
  revokeAllUserSessions,
  cleanupExpiredSessions,
  countUsers,
  countActiveAuthSessions,
  createAuditLog,
  listAuditLogs,
};
