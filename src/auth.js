import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const VISITOR_SESSION_MAX_MS = 400 * 24 * 60 * 60 * 1000;
export const ADMIN_COOKIE = 'chat_admin';
export const VISITOR_COOKIE = 'chat_visitor';
export const MIN_PASSWORD_LENGTH = 8;
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,40}$/;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// Used when the username does not exist, so a failed login costs the same time either way.
const DUMMY_HASH = hashPassword(randomBytes(12).toString('hex'));

export function verifyPassword(password, stored) {
  const [scheme, N, r, p, saltB64, hashB64] = (stored || DUMMY_HASH).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected) && Boolean(stored);
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `رمز عبور باید حداقل ${MIN_PASSWORD_LENGTH} کاراکتر باشد`;
  if (password.length > 200) return 'رمز عبور بیش از حد طولانی است';
  return null;
}

export function createUser(db, { username, password, displayName, role, now = Date.now() }) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(username, hashPassword(password), displayName, role, now);
  return Number(lastInsertRowid);
}

export const tokenHash = token => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
// Cookie values are ours (43 base64url chars); anything else is not looked up at all.
const plausibleToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(token);

// ───────── Staff sessions ─────────

export function createSession(db, userId, now = Date.now()) {
  const token = newToken();
  db.prepare('DELETE FROM sessions WHERE last_seen < ? OR created_at < ?').run(now - SESSION_IDLE_MS, now - SESSION_MAX_MS);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)').run(tokenHash(token), userId, now, now);
  return token;
}

export function sessionUser(db, token, now = Date.now()) {
  if (!plausibleToken(token)) return null;
  const row = db.prepare(`
    SELECT s.token_hash, s.created_at, s.last_seen, u.id, u.username, u.display_name, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND u.active = 1`).get(tokenHash(token));
  if (!row || row.last_seen < now - SESSION_IDLE_MS || row.created_at < now - SESSION_MAX_MS) return null;
  if (now - row.last_seen > 60000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, row.token_hash);
  return { id: row.id, username: row.username, display_name: row.display_name, role: row.role };
}

export function destroySession(db, token) {
  if (plausibleToken(token)) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function destroyUserSessions(db, userId, exceptToken = null) {
  if (exceptToken) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, tokenHash(exceptToken));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// ───────── Visitor sessions (one per device; only the hash of the cookie is stored) ─────────

// sinceId hides older messages of the same phone number from this device.
export function createVisitorSession(db, visitorId, sinceId, now = Date.now()) {
  const token = newToken();
  db.prepare('INSERT INTO visitor_sessions (token_hash, visitor_id, since_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?)')
    .run(tokenHash(token), visitorId, sinceId, now, now);
  return token;
}

// The visitor behind a cookie, or null. Marks both the visitor and the session as seen now.
export function sessionVisitor(db, token, now = Date.now()) {
  if (!plausibleToken(token)) return null;
  const row = db.prepare(`
    SELECT s.token_hash, s.since_id, s.last_seen AS session_seen, v.id, v.name, v.phone, v.operated
    FROM visitor_sessions s JOIN visitors v ON v.id = s.visitor_id WHERE s.token_hash = ?`).get(tokenHash(token));
  if (!row || row.session_seen < now - VISITOR_SESSION_MAX_MS) return null;
  db.prepare('UPDATE visitors SET last_seen = ? WHERE id = ?').run(now, row.id);
  if (now - row.session_seen > 60000) db.prepare('UPDATE visitor_sessions SET last_seen = ? WHERE token_hash = ?').run(now, row.token_hash);
  return { id: row.id, name: row.name, phone: row.phone, operated: row.operated, sinceId: row.since_id };
}

export function destroyVisitorSession(db, token) {
  if (plausibleToken(token)) db.prepare('DELETE FROM visitor_sessions WHERE token_hash = ?').run(tokenHash(token));
}

// Drops long-expired sign-ins (at startup and daily): staff sessions past their limits, visitor sessions
// unused for 400 days.
export function pruneSessions(db, now = Date.now()) {
  const staff = db.prepare('DELETE FROM sessions WHERE last_seen < ? OR created_at < ?').run(now - SESSION_IDLE_MS, now - SESSION_MAX_MS).changes;
  const visitors = db.prepare('DELETE FROM visitor_sessions WHERE last_seen < ?').run(now - VISITOR_SESSION_MAX_MS).changes;
  return { staff: Number(staff), visitors: Number(visitors) };
}

// ───────── Limits ─────────

// Locks a key (username, IP, or both) after maxFailures failed logins inside windowMs.
export class LoginLimiter {
  constructor({ maxFailures = 5, windowMs = 15 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.failures = new Map();
  }

  #recent(key, now) {
    const list = (this.failures.get(key) || []).filter(t => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  // Minutes until the attempt is allowed again, or 0 if it is allowed now.
  lockedMinutes(keys, now = Date.now()) {
    let wait = 0;
    for (const key of keys) {
      const list = this.#recent(key, now);
      if (list.length >= this.maxFailures) wait = Math.max(wait, list[0] + this.windowMs - now);
    }
    return Math.ceil(wait / 60000);
  }

  fail(keys, now = Date.now()) {
    for (const key of keys) this.failures.set(key, [...this.#recent(key, now), now]);
    if (this.failures.size > 10000) this.failures.clear();
  }

  succeed(keys) {
    for (const key of keys) this.failures.delete(key);
  }
}

// At most `max` actions per key inside a sliding window of windowMs (visitor starts and messages).
export class RateLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  // Records the action and returns true, or returns false (recording nothing) when the key is over its limit.
  take(key, now = Date.now()) {
    const list = (this.hits.get(key) || []).filter(t => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10000) this.#sweep(now);
    return true;
  }

  #sweep(now) {
    for (const [key, list] of this.hits) {
      if (!list.some(t => now - t < this.windowMs)) this.hits.delete(key);
    }
    if (this.hits.size > 10000) this.hits.clear();
  }
}
