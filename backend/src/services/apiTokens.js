const crypto = require('crypto');
const { getDb } = require('../db/database');

// Read-only API tokens for headless clients (#9).
//
// Tokens have the form gav_<32 random bytes, base64url>. Only a SHA-256 hash is
// stored: the tokens carry 256 bits of entropy, so a salt or a slow hash would
// add cost without adding protection. The raw value is returned once, by
// createToken, and is never logged.

const TOKEN_PREFIX = 'gav_';
const DISPLAY_PREFIX_LENGTH = 8;
const LAST_USED_THROTTLE_MS = 60 * 1000;
const MAX_NAME_LENGTH = 100;
const TOKEN_PATTERN = /^gav_[A-Za-z0-9_-]{43}$/;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
    revokedAt: row.revoked_at || null,
  };
}

function normaliseName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null;
  return trimmed;
}

/**
 * Create a token. Returns the public record plus `token`, the only time the
 * full value is ever available.
 */
function createToken(name, createdBy = null) {
  const cleanName = normaliseName(name);
  if (!cleanName) {
    throw new Error(`Token name must be 1-${MAX_NAME_LENGTH} characters`);
  }
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const createdAt = new Date().toISOString();
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO api_tokens (name, token_hash, prefix, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(cleanName, hashToken(token), token.slice(0, DISPLAY_PREFIX_LENGTH), createdBy, createdAt);
  const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(info.lastInsertRowid);
  return { ...toPublic(row), token };
}

function listTokens() {
  return getDb()
    .prepare('SELECT * FROM api_tokens ORDER BY created_at DESC, id DESC')
    .all()
    .map(toPublic);
}

/** Revoke a token. Returns false when no such token exists. Idempotent. */
function revokeToken(id) {
  const db = getDb();
  const row = db.prepare('SELECT id, revoked_at FROM api_tokens WHERE id = ?').get(id);
  if (!row) return false;
  if (!row.revoked_at) {
    db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }
  return true;
}

/**
 * Look a raw token up. Returns { id, name } for a valid, unrevoked token and
 * null otherwise. Records last use at most once a minute per token.
 */
function verifyToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  const db = getDb();
  const row = db
    .prepare('SELECT id, name, revoked_at FROM api_tokens WHERE token_hash = ?')
    .get(hashToken(token));
  if (!row || row.revoked_at) return null;

  const now = Date.now();
  db.prepare(
    `UPDATE api_tokens SET last_used_at = ?
     WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`
  ).run(new Date(now).toISOString(), row.id, new Date(now - LAST_USED_THROTTLE_MS).toISOString());

  return { id: row.id, name: row.name };
}

module.exports = { createToken, listTokens, revokeToken, verifyToken, hashToken, MAX_NAME_LENGTH };
