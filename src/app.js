import { mkdtempSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting, setSetting, transaction } from './db.js';
import {
  ADMIN_COOKIE, VISITOR_COOKIE, USERNAME_PATTERN, LoginLimiter, RateLimiter, createSession, createUser,
  createVisitorSession, destroySession, destroyUserSessions, destroyVisitorSession, hashPassword, sessionUser,
  sessionVisitor, validatePassword, verifyPassword,
} from './auth.js';
import {
  HttpError, cleanId, cleanMobile, cleanMultiline, cleanText, faDigits, intParam, toLatinDigits,
} from './validate.js';
import { findAnswer, normalize, splitKeywords } from './answer.js';
import { contactError, contactHref, contactLabel, publicContacts } from './contacts.js';
import { jalaliStamp, lastTehranDays, tehranDay } from './time.js';
import { buildXlsx } from './xlsx.js';
import { zip } from './zip.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const PROJECT_DIR = fileURLToPath(new URL('..', import.meta.url));
// Never copied into a full backup: runtime data, secrets, dependencies, build output, other backups, design mock-ups.
const BACKUP_SKIP_DIRS = new Set(['node_modules', 'data', '.git', 'source', 'dist', 'full-backups', 'design']);
const BACKUP_SKIP_FILE = /(^\.env$)|(\.zip$)|(\.sqlite(-wal|-shm)?$)/;
const MAX_BODY = 32 * 1024;
const MAX_AVATAR_BODY = 1024 * 1024;
const MAX_AVATAR_BYTES = 512 * 1024;
// The visitor page polls every 5 s while it is open, so 30 s without a request means the visitor left.
const ONLINE_MS = 30 * 1000;
const VISITOR_COOKIE_AGE = 365 * 24 * 3600;
const ADMIN_COOKIE_AGE = 7 * 24 * 3600;
const DAY_MS = 24 * 60 * 60 * 1000;

const NOT_FOUND = 'پیدا نشد';
const FORBIDDEN = 'شما اجازه انجام این کار را ندارید';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

// The first bytes of each accepted avatar format; a declared type must match the actual file.
const IMAGE_MAGIC = {
  png: data => data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: data => data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  webp: data => data.length > 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP',
};

// Static files are read once into memory; requests are matched against this map, never joined onto the filesystem.
function loadStatic() {
  const files = new Map();
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (MIME[extname(name)]) files.set(`/${relative(PUBLIC_DIR, full).split(sep).join('/')}`, { body: readFileSync(full), type: MIME[extname(name)] });
    }
  };
  walk(PUBLIC_DIR);
  return files;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// A JSON object body of at most maxBytes. A request with no body and no content type counts as {}.
async function readJson(req, maxBytes) {
  const type = req.headers['content-type'] || '';
  const isJson = /^application\/json\b/i.test(type);
  if (type && !isJson) throw new HttpError(415, 'فرمت درخواست نامعتبر است');
  if (Number(req.headers['content-length']) > maxBytes) throw new HttpError(413, 'حجم درخواست بیش از حد مجاز است');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, 'حجم درخواست بیش از حد مجاز است');
    chunks.push(chunk);
  }
  if (!size && !isJson) return {};
  if (!isJson) throw new HttpError(415, 'فرمت درخواست نامعتبر است');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'درخواست نامعتبر است');
  }
}

// Which client IP the limits use. 'cloudflare': the CF-Connecting-IP header set by Cloudflare's tunnel;
// 'proxy': the last X-Forwarded-For hop, added by the local reverse proxy (Caddy); otherwise the socket
// address. Only trust a header that the deployment's own proxy sets.
export function clientIpFrom(req, trustProxy) {
  if (trustProxy === 'cloudflare' || trustProxy === true) {
    const ip = String(req.headers['cf-connecting-ip'] || '').trim();
    if (ip) return ip;
  } else if (trustProxy === 'proxy') {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

const restoreText = (filename, host) => `پشتیبان کامل چت پشتیبانی
========================
این فایل این‌ها را دارد:
  app/   همه‌ی کدهای صفحه‌ی چت و پنل مدیریت
  data/  همه‌ی اطلاعات: گفتگوها، اسم و شماره‌ی مراجعه‌کننده‌ها، دیتابیس ربات، تنظیمات و حساب‌های مدیران

این فایل اسم و شماره‌ی مراجعه‌کننده‌ها را دارد؛ آن را جای امن نگه دارید و برای کسی نفرستید.

راه‌اندازی دوباره روی یک سرور جدید (بدون گیت‌هاب؛ فقط Docker لازم است):
فقط روی یک سرور تازه انجام دهید، نه روی سروری که چت همین الان رویش کار می‌کند.

  1. با SSH وارد سرور جدید شوید. اگر Docker ندارد (سرور تازه و خالی):
       apt-get update && apt-get install -y docker.io docker-compose-v2 docker-buildx
  2. پوشه را بسازید:
       mkdir -p ~/chat-poshtibani
  3. همین فایل zip را داخل پوشه‌ی /root/chat-poshtibani سرور جدید بگذارید. در MobaXterm: در پنل
     سمت چپ (SSH browser) وارد همین پوشه شوید و فایل را با موس داخلش بکشید. فقط یک فایل zip آن‌جا باشد.
  4. باز کردن فایل و نصب:
       cd ~/chat-poshtibani && python3 -m zipfile -e ${filename} .
       bash app/deploy/install.sh
  5. نصب از راه تونل Cloudflare کار می‌کند و هیچ پورتی لازم نیست باز شود. یک لینک ورود به Cloudflare
     نشان می‌دهد: آن را در مرورگری که در Cloudflare وارد شده‌اید باز کنید، دامنه را انتخاب کنید و
     Authorize را بزنید. اگر گفت رکورد ${host} از قبل هست و پرسید جایگزین شود، y بزنید
     (فقط رکورد همین یک ساب‌دامین عوض می‌شود).
بعد با همان نام‌های کاربری و رمزهای قبلی وارد پنل مدیریت شوید.
`;

const userPublic = u => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role });
const userRow = u => ({ ...userPublic(u), active: Boolean(u.active), lastLoginAt: u.last_login_at ?? null });

const visitorMessage = m => ({ id: m.id, from: m.sender, text: m.text, contacts: Boolean(m.contacts), at: m.created_at });
const adminMessage = m => ({
  id: m.id,
  from: m.sender,
  text: m.text,
  kind: m.kind,
  contacts: Boolean(m.contacts),
  unanswered: m.sender === 'visitor' && Boolean(m.unanswered) && !m.resolved,
  at: m.created_at,
  staffName: m.sender === 'staff' ? (m.staff_name ?? '') : null,
});
const MESSAGE_COLUMNS = 'm.id, m.sender, m.text, m.kind, m.contacts, m.unanswered, m.resolved, m.created_at, u.display_name AS staff_name';

const SUMMARY_SELECT = `SELECT v.id, v.name, v.phone, v.operated, v.note, v.created_at, v.last_seen,
  (SELECT COUNT(*) FROM messages m WHERE m.visitor_id = v.id AND m.sender = 'visitor') AS questions,
  COALESCE((SELECT m.text FROM messages m WHERE m.visitor_id = v.id AND m.sender = 'visitor' ORDER BY m.id DESC LIMIT 1), '') AS last_question
  FROM visitors v`;

const kbEntry = e => ({ id: e.id, category: e.category, title: e.title, keywords: e.keywords, answer: e.answer, updatedAt: e.updated_at });

const likePattern = text => `%${text.replace(/[\\%_]/g, m => `\\${m}`)}%`;

// The digits of a phone search ('۰۹۱۲ ۳۴۵', '+98912…'), or '' when the search is not a number.
function phoneQuery(q) {
  let digits = toLatinDigits(q).replace(/[\s\-()]/g, '');
  if (digits.startsWith('+98')) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('0098')) digits = `0${digits.slice(4)}`;
  return /^\d+$/.test(digits) ? digits : '';
}

// Keywords are stored in one canonical spelling: «آدرس، کجاست، نشانی».
const cleanKeywords = value => {
  const text = splitKeywords(cleanMultiline(value, { max: Infinity }))
    .map(k => k.replace(/\s+/g, ' '))
    .join('، ');
  if (text.length > 500) throw new HttpError(400, 'کلمه‌های مشابه حداکثر ۵۰۰ حرف است');
  return text;
};

export function createApp({ db, secureCookies = true, trustProxy = false, loginLimit, sourceDir = PROJECT_DIR, now = () => Date.now() } = {}) {
  const staticFiles = loadStatic();
  const defaultAvatar = staticFiles.get('/img/nana.svg');
  const baseHeaders = secureCookies ? { ...SECURITY_HEADERS, 'strict-transport-security': 'max-age=31536000' } : SECURITY_HEADERS;
  // Three login limits. Strict for one username from one address (5), so a stranger cannot lock the
  // owner out from elsewhere; looser for one username from anywhere (50) and for one address trying
  // any username (30, since a clinic's staff often share one office IP).
  const strict = loginLimit?.maxFailures ?? 5;
  const pairLimiter = new LoginLimiter(loginLimit);
  const userLimiter = new LoginLimiter({ ...loginLimit, maxFailures: strict * 10 });
  const ipLimiter = new LoginLimiter({ ...loginLimit, maxFailures: strict * 6 });
  const startLimiter = new RateLimiter({ max: 10, windowMs: 10 * 60 * 1000 });
  const sendLimiter = new RateLimiter({ max: 20, windowMs: 60 * 1000 });

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...baseHeaders, ...headers });
    res.end(body);
  };
  const json = (res, status, data, headers = {}) => send(res, status, JSON.stringify(data), {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers,
  });
  const download = (res, body, type, filename) => send(res, 200, Buffer.from(body), {
    'content-type': type, 'content-disposition': `attachment; filename="${filename}"`, 'cache-control': 'no-store',
  });

  const cookie = (name, value, maxAge, sameSite) => [
    `${name}=${value}`, 'Path=/', 'HttpOnly', `SameSite=${sameSite}`, `Max-Age=${maxAge}`, ...(secureCookies ? ['Secure'] : []),
  ].join('; ');
  const adminCookie = (value, maxAge = ADMIN_COOKIE_AGE) => cookie(ADMIN_COOKIE, value, maxAge, 'Strict');
  // Lax, so the chat link opened from Instagram or a text message still finds the visitor's conversation.
  const visitorCookie = (value, maxAge = VISITOR_COOKIE_AGE) => cookie(VISITOR_COOKIE, value, maxAge, 'Lax');

  const setting = key => getSetting(db, key);
  const avatarUrl = () => `/api/chat/avatar?v=${encodeURIComponent(setting('avatar_version'))}`;
  const hasAvatar = () => Boolean(db.prepare("SELECT 1 FROM files WHERE name = 'avatar'").get());
  const bumpAvatarVersion = () => setSetting(db, 'avatar_version', (Number(setting('avatar_version')) || 0) + 1);

  const contactRows = () => db.prepare('SELECT id, enabled, value, sort FROM contacts ORDER BY sort, id').all();
  const adminContacts = () => contactRows().map(r => ({
    id: r.id, label: contactLabel(r.id), enabled: Boolean(r.enabled), value: r.value, href: contactHref(r.id, r.value),
  }));
  const quickReplies = audience => db.prepare('SELECT text, enabled FROM quick_replies WHERE audience = ? ORDER BY sort, id').all(audience);

  const visitorSummary = (v, t) => ({
    id: v.id,
    name: v.name,
    phone: v.phone,
    operated: Boolean(v.operated),
    createdAt: v.created_at,
    lastSeen: v.last_seen,
    online: v.last_seen >= t - ONLINE_MS,
    questions: v.questions,
    lastQuestion: v.last_question,
  });
  const visitorPublic = v => ({ firstName: v.name.split(' ')[0], operated: Boolean(v.operated) });

  const answerFor = (text, prefixIndex) => findAnswer({
    entries: db.prepare('SELECT id, title, keywords, answer FROM kb ORDER BY id').all(),
    phrases: setting('phrases'),
    notFound: setting('not_found'),
    text,
    prefixIndex,
  });

  // Marks one group of unanswered questions (same normalized text) as handled.
  const resolveNorm = norm => Number(db.prepare(
    "UPDATE messages SET resolved = 1 WHERE sender = 'visitor' AND unanswered = 1 AND resolved = 0 AND norm = ?",
  ).run(norm).changes);
  const normInput = value => {
    if (typeof value !== 'string' || !value || value.length > 1000) throw new HttpError(400, 'سؤال نامعتبر است');
    return value;
  };

  const routes = [];
  // access: 'public' (anyone), 'visitor' (chat cookie), 'staff' (any signed-in account), 'owner'.
  const route = (method, pattern, handler, { access = 'owner', maxBody = MAX_BODY } = {}) => routes.push({ method, pattern, handler, access, maxBody });

  // ───────── Public and visitor endpoints ─────────

  // Docker health check.
  route('GET', /^\/api\/info$/, ({ res }) => {
    json(res, 200, { ok: true });
  }, { access: 'public' });

  route('GET', /^\/api\/chat\/state$/, ({ res, cookies, t }) => {
    const visitor = sessionVisitor(db, cookies[VISITOR_COOKIE], t);
    const messages = visitor
      ? db.prepare(`SELECT * FROM (SELECT id, sender, text, contacts, created_at FROM messages
          WHERE visitor_id = ? AND id > ? ORDER BY id DESC LIMIT 200) ORDER BY id`).all(visitor.id, visitor.sinceId).map(visitorMessage)
      : [];
    json(res, 200, {
      config: {
        clinicName: setting('clinic_name'),
        assistantName: setting('assistant_name'),
        welcome: setting('welcome'),
        avatarUrl: avatarUrl(),
        quickReplies: Object.fromEntries(['op', 'not'].map(a => [a, quickReplies(a).filter(q => q.enabled).map(q => q.text)])),
        contacts: publicContacts(contactRows()),
      },
      visitor: visitor ? visitorPublic(visitor) : null,
      messages,
    });
  }, { access: 'public' });

  route('POST', /^\/api\/chat\/start$/, ({ req, res, body, cookies, t }) => {
    const name = cleanText(body.name, {
      required: true, min: 2, max: 60, messages: { required: 'اسمت رو بنویس', min: 'اسمت رو کامل بنویس', max: 'اسم حداکثر ۶۰ حرفه' },
    });
    const phone = cleanMobile(body.phone);
    if (typeof body.operated !== 'boolean') throw new HttpError(400, 'یکی از دو گزینه رو انتخاب کن');
    if (!startLimiter.take(clientIpFrom(req, trustProxy), t)) throw new HttpError(429, 'چند دقیقه دیگه دوباره امتحان کن');
    const token = transaction(db, () => {
      // This device signs in again (maybe as someone else): its previous sign-in ends.
      destroyVisitorSession(db, cookies[VISITOR_COOKIE]);
      db.prepare(`INSERT INTO visitors (name, phone, operated, created_at, last_seen) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (phone) DO UPDATE SET name = excluded.name, operated = excluded.operated, last_seen = excluded.last_seen`)
        .run(name, phone, body.operated ? 1 : 0, t, t);
      const visitor = db.prepare('SELECT id FROM visitors WHERE phone = ?').get(phone);
      // A new device never shows an earlier conversation of the same number (someone else may own the phone now).
      const sinceId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get().m;
      return createVisitorSession(db, visitor.id, sinceId, t);
    });
    json(res, 200, { visitor: visitorPublic({ name, operated: body.operated }), messages: [] }, { 'set-cookie': visitorCookie(token) });
  }, { access: 'public' });

  route('POST', /^\/api\/chat\/send$/, ({ res, body, visitor, t }) => {
    const text = cleanText(body.text, { required: true, max: 500, messages: { required: 'پیامت رو بنویس', max: 'پیام حداکثر ۵۰۰ حرفه' } });
    if (!sendLimiter.take(`visitor:${visitor.id}`, t)) throw new HttpError(429, 'یه کم آروم‌تر عزیزم؛ چند لحظه دیگه بفرست');
    const ids = transaction(db, () => {
      const norm = normalize(text);
      const question = Number(db.prepare(`INSERT INTO messages (visitor_id, sender, text, kind, norm, created_at)
        VALUES (?, 'visitor', ?, 'question', ?, ?)`).run(visitor.id, text, norm, t).lastInsertRowid);
      const prefixIndex = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE visitor_id = ? AND sender = 'bot' AND kind = 'kb'").get(visitor.id).n;
      const answer = answerFor(text, prefixIndex);
      const reply = Number(db.prepare(`INSERT INTO messages (visitor_id, sender, text, kind, kb_id, contacts, created_at)
        VALUES (?, 'bot', ?, ?, ?, ?, ?)`).run(visitor.id, answer.text, answer.kind, answer.entryId ?? null, answer.contacts ? 1 : 0, t).lastInsertRowid);
      // Only real text is worth a place on the unanswered list (not «؟؟» alone).
      if (answer.kind === 'none' && norm) db.prepare('UPDATE messages SET unanswered = 1 WHERE id = ?').run(question);
      db.prepare('UPDATE visitors SET last_seen = ? WHERE id = ?').run(t, visitor.id);
      return [question, reply];
    });
    const messages = db.prepare('SELECT id, sender, text, contacts, created_at FROM messages WHERE id IN (?, ?) ORDER BY id').all(...ids);
    json(res, 200, { messages: messages.map(visitorMessage) });
  }, { access: 'visitor' });

  // Polled every 5 s by the open chat page; it is also the visitor's "online" heartbeat.
  route('GET', /^\/api\/chat\/messages$/, ({ res, query, visitor }) => {
    const after = intParam(query.get('after'), { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
    const messages = db.prepare(`SELECT id, sender, text, contacts, created_at FROM messages
      WHERE visitor_id = ? AND id > ? ORDER BY id LIMIT 100`).all(visitor.id, Math.max(after, visitor.sinceId));
    json(res, 200, { messages: messages.map(visitorMessage) });
  }, { access: 'visitor' });

  // The URL carries ?v=<avatar_version>, so a day of caching is safe: a new picture gets a new URL.
  route('GET', /^\/api\/chat\/avatar$/, ({ res }) => {
    const file = db.prepare("SELECT type, data FROM files WHERE name = 'avatar'").get();
    if (!file && !defaultAvatar) throw new HttpError(404, NOT_FOUND);
    send(res, 200, file ? Buffer.from(file.data) : defaultAvatar.body, {
      'content-type': file ? file.type : 'image/svg+xml',
      'cache-control': 'public, max-age=86400',
    });
  }, { access: 'public' });

  // ───────── Admin: account ─────────

  route('POST', /^\/api\/admin\/login$/, ({ req, res, body, t }) => {
    const username = cleanText(body.username, { field: 'نام کاربری', required: true, max: 60 }).toLowerCase();
    const ip = clientIpFrom(req, trustProxy);
    const pairKey = [`u:${username}|ip:${ip}`];
    const userKey = [`u:${username}`];
    const ipKey = [`ip:${ip}`];
    const wait = Math.max(pairLimiter.lockedMinutes(pairKey, t), userLimiter.lockedMinutes(userKey, t), ipLimiter.lockedMinutes(ipKey, t));
    if (wait) throw new HttpError(429, `تلاش‌های ناموفق زیاد بود. ${faDigits(wait)} دقیقه دیگر دوباره امتحان کنید`);
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    if (!verifyPassword(String(body.password ?? ''), user?.password_hash)) {
      pairLimiter.fail(pairKey, t);
      userLimiter.fail(userKey, t);
      ipLimiter.fail(ipKey, t);
      throw new HttpError(401, 'نام کاربری یا رمز عبور اشتباه است');
    }
    pairLimiter.succeed(pairKey);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(t, user.id);
    const token = createSession(db, user.id, t);
    json(res, 200, { user: userPublic(user) }, { 'set-cookie': adminCookie(token) });
  }, { access: 'public' });

  route('POST', /^\/api\/admin\/logout$/, ({ res, cookies }) => {
    destroySession(db, cookies[ADMIN_COOKIE]);
    json(res, 200, { ok: true }, { 'set-cookie': adminCookie('', 0) });
  }, { access: 'staff' });

  route('GET', /^\/api\/admin\/me$/, ({ res, user }) => {
    json(res, 200, {
      user: userPublic(user),
      clinicName: setting('clinic_name'),
      assistantName: setting('assistant_name'),
      avatarUrl: avatarUrl(),
      publicUrl: setting('public_url'),
    });
  }, { access: 'staff' });

  route('POST', /^\/api\/admin\/me\/password$/, ({ res, user, body, cookies }) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(String(body.current ?? ''), row.password_hash)) throw new HttpError(400, 'رمز فعلی اشتباه است');
    const problem = validatePassword(body.next);
    if (problem) throw new HttpError(400, problem);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.next), user.id);
    destroyUserSessions(db, user.id, cookies[ADMIN_COOKIE]);
    json(res, 200, { ok: true });
  }, { access: 'staff' });

  // ───────── Admin: dashboard and conversations ─────────

  route('GET', /^\/api\/admin\/dashboard$/, ({ res, t }) => {
    const counts = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(operated), 0) AS operated,
      COALESCE(SUM(last_seen >= ?), 0) AS online FROM visitors`).get(t - ONLINE_MS);
    // Days are Tehran calendar days of the first visit. Recent rows are bucketed here with the same
    // helper the labels use, so the chart and "today" always agree.
    const days = lastTehranDays(t, 14);
    const buckets = new Map(days.map(d => [d.day, { operated: 0, notOperated: 0 }]));
    for (const v of db.prepare('SELECT created_at, operated FROM visitors WHERE created_at >= ?').all(t - 15 * DAY_MS)) {
      const bucket = buckets.get(tehranDay(v.created_at));
      if (bucket) bucket[v.operated ? 'operated' : 'notOperated'] += 1;
    }
    const daily = days.map(d => ({ day: d.day, label: d.label, ...buckets.get(d.day) }));
    const today = daily[daily.length - 1];
    const unanswered = db.prepare(`SELECT COUNT(DISTINCT norm) AS n FROM messages
      WHERE sender = 'visitor' AND unanswered = 1 AND resolved = 0`).get().n;
    const topQuestions = db.prepare(`
      WITH g AS (SELECT norm, COUNT(*) AS count, MAX(id) AS last_id, MAX(unanswered = 1 AND resolved = 0) AS open
                 FROM messages WHERE sender = 'visitor' AND norm != '' GROUP BY norm)
      SELECT m.text, g.count, g.open FROM g JOIN messages m ON m.id = g.last_id
      ORDER BY g.count DESC, g.last_id DESC LIMIT 7`).all()
      .map(q => ({ text: q.text, count: q.count, unanswered: Boolean(q.open) }));
    const recent = db.prepare(`${SUMMARY_SELECT} ORDER BY v.created_at DESC, v.id DESC LIMIT 6`).all().map(v => visitorSummary(v, t));
    json(res, 200, {
      stats: {
        total: counts.total,
        online: counts.online,
        operated: counts.operated,
        notOperated: counts.total - counts.operated,
        today: today.operated + today.notOperated,
        unanswered,
      },
      daily,
      topQuestions,
      recent,
    });
  }, { access: 'staff' });

  // WHERE clause for the visitor list and the Excel export.
  const visitorFilter = (filter, t) => ({
    op: { sql: 'v.operated = 1', args: [] },
    not: { sql: 'v.operated = 0', args: [] },
    online: { sql: 'v.last_seen >= ?', args: [t - ONLINE_MS] },
  })[filter] ?? null;

  route('GET', /^\/api\/admin\/visitors$/, ({ res, query, t }) => {
    const where = [];
    const args = [];
    const filter = visitorFilter(query.get('filter'), t);
    if (filter) {
      where.push(filter.sql);
      args.push(...filter.args);
    }
    const q = cleanText(query.get('q') ?? '', { field: 'جستجو', max: 60 });
    if (q) {
      const phone = phoneQuery(q);
      where.push(`(v.name LIKE ? ESCAPE '\\'${phone ? " OR v.phone LIKE ? ESCAPE '\\'" : ''})`);
      // cleanText already turned Arabic ي/ك into ی/ک, the spelling names are stored in.
      args.push(likePattern(q), ...(phone ? [likePattern(phone)] : []));
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = intParam(query.get('limit'), { fallback: 50, min: 1, max: 200 });
    const offset = intParam(query.get('offset'), { fallback: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
    const total = db.prepare(`SELECT COUNT(*) AS n FROM visitors v ${whereSql}`).get(...args).n;
    const rows = db.prepare(`${SUMMARY_SELECT} ${whereSql} ORDER BY v.last_seen DESC, v.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    json(res, 200, { visitors: rows.map(v => visitorSummary(v, t)), total });
  }, { access: 'staff' });

  const visitorById = id => db.prepare(`${SUMMARY_SELECT} WHERE v.id = ?`).get(id);
  const requireVisitor = id => {
    const row = visitorById(cleanId(id));
    if (!row) throw new HttpError(404, NOT_FOUND);
    return row;
  };

  route('GET', /^\/api\/admin\/visitors\/(\d+)$/, ({ res, params, t }) => {
    const v = requireVisitor(params[0]);
    const messages = db.prepare(`SELECT * FROM (SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN users u ON u.id = m.staff_id
      WHERE m.visitor_id = ? ORDER BY m.id DESC LIMIT 500) ORDER BY id`).all(v.id);
    json(res, 200, { visitor: { ...visitorSummary(v, t), note: v.note }, messages: messages.map(adminMessage) });
  }, { access: 'staff' });

  route('PUT', /^\/api\/admin\/visitors\/(\d+)$/, ({ res, params, body }) => {
    const v = requireVisitor(params[0]);
    const note = cleanMultiline(body.note, { field: 'یادداشت', max: 500 });
    db.prepare('UPDATE visitors SET note = ? WHERE id = ?').run(note, v.id);
    json(res, 200, { ok: true });
  }, { access: 'staff' });

  // A staff reply; the visitor's page picks it up on its next poll.
  route('POST', /^\/api\/admin\/visitors\/(\d+)\/messages$/, ({ res, params, body, user, t }) => {
    const v = requireVisitor(params[0]);
    const text = cleanMultiline(body.text, { field: 'متن پیام', required: true, max: 1000 });
    const id = Number(db.prepare(`INSERT INTO messages (visitor_id, sender, text, kind, staff_id, created_at)
      VALUES (?, 'staff', ?, 'staff', ?, ?)`).run(v.id, text, user.id, t).lastInsertRowid);
    const row = db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN users u ON u.id = m.staff_id WHERE m.id = ?`).get(id);
    json(res, 200, { message: adminMessage(row) });
  }, { access: 'staff' });

  route('GET', /^\/api\/admin\/export\.xlsx$/, ({ res, query, t }) => {
    const name = ['op', 'not'].includes(query.get('filter')) ? query.get('filter') : 'all';
    const filter = visitorFilter(name, t);
    const rows = db.prepare(`SELECT v.name, v.phone, v.operated, v.created_at, v.last_seen,
      (SELECT COUNT(*) FROM messages m WHERE m.visitor_id = v.id AND m.sender = 'visitor') AS questions
      FROM visitors v ${filter ? `WHERE ${filter.sql}` : ''} ORDER BY v.created_at, v.id`).all(...(filter?.args ?? []));
    const xlsx = buildXlsx({
      sheetName: 'کاربران',
      columns: [
        { header: 'نام', width: 24 },
        { header: 'موبایل', width: 15 },
        { header: 'وضعیت عمل', width: 13 },
        { header: 'اولین ورود', width: 18 },
        { header: 'آخرین فعالیت', width: 18 },
        { header: 'تعداد سؤال‌ها', width: 13 },
      ],
      // The phone is written as text, so Excel keeps its leading 0.
      rows: rows.map(r => [r.name, r.phone, r.operated ? 'عمل‌کرده' : 'عمل‌نکرده', jalaliStamp(r.created_at), jalaliStamp(r.last_seen), r.questions]),
    });
    download(res, xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `chat-users-${name}-${tehranDay(t)}.xlsx`);
  }, { access: 'staff' });

  // ───────── Admin: unanswered questions and the knowledge base ─────────

  route('GET', /^\/api\/admin\/unanswered$/, ({ res }) => {
    const items = db.prepare(`
      WITH g AS (SELECT norm, COUNT(*) AS count, MAX(id) AS last_id FROM messages
                 WHERE sender = 'visitor' AND unanswered = 1 AND resolved = 0 GROUP BY norm)
      SELECT g.norm, g.count, m.text, m.created_at AS last_at, v.id AS visitor_id, v.name AS visitor_name
      FROM g JOIN messages m ON m.id = g.last_id JOIN visitors v ON v.id = m.visitor_id
      ORDER BY g.count DESC, m.created_at DESC, m.id DESC LIMIT 300`).all();
    json(res, 200, {
      items: items.map(i => ({
        norm: i.norm, text: i.text, count: i.count, lastAt: i.last_at, lastVisitorId: i.visitor_id, lastVisitorName: i.visitor_name,
      })),
    });
  }, { access: 'staff' });

  route('POST', /^\/api\/admin\/unanswered\/resolve$/, ({ res, body }) => {
    json(res, 200, { resolved: resolveNorm(normInput(body.norm)) });
  });

  route('GET', /^\/api\/admin\/kb$/, ({ res }) => {
    json(res, 200, { entries: db.prepare('SELECT * FROM kb ORDER BY id').all().map(kbEntry) });
  }, { access: 'staff' });

  const kbInput = body => ({
    category: cleanText(body.category, { field: 'دسته', max: 60 }),
    title: cleanText(body.title, { field: 'موضوع', required: true, max: 120 }),
    keywords: cleanKeywords(body.keywords),
    answer: cleanMultiline(body.answer, { field: 'جواب', required: true, max: 2000 }),
    // Set when the entry is written from the unanswered list: that group of questions is then handled.
    resolveNorm: body.resolveNorm === undefined || body.resolveNorm === null || body.resolveNorm === '' ? null : normInput(body.resolveNorm),
  });

  route('POST', /^\/api\/admin\/kb$/, ({ res, body, t }) => {
    const input = kbInput(body);
    const id = transaction(db, () => {
      const newId = Number(db.prepare('INSERT INTO kb (category, title, keywords, answer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(input.category, input.title, input.keywords, input.answer, t, t).lastInsertRowid);
      if (input.resolveNorm) resolveNorm(input.resolveNorm);
      return newId;
    });
    json(res, 200, { entry: kbEntry(db.prepare('SELECT * FROM kb WHERE id = ?').get(id)) });
  });

  route('PUT', /^\/api\/admin\/kb\/(\d+)$/, ({ res, body, params, t }) => {
    const id = cleanId(params[0]);
    const input = kbInput(body);
    transaction(db, () => {
      const { changes } = db.prepare('UPDATE kb SET category = ?, title = ?, keywords = ?, answer = ?, updated_at = ? WHERE id = ?')
        .run(input.category, input.title, input.keywords, input.answer, t, id);
      if (!changes) throw new HttpError(404, NOT_FOUND);
      if (input.resolveNorm) resolveNorm(input.resolveNorm);
    });
    json(res, 200, { entry: kbEntry(db.prepare('SELECT * FROM kb WHERE id = ?').get(id)) });
  });

  route('DELETE', /^\/api\/admin\/kb\/(\d+)$/, ({ res, params }) => {
    const { changes } = db.prepare('DELETE FROM kb WHERE id = ?').run(cleanId(params[0]));
    if (!changes) throw new HttpError(404, NOT_FOUND);
    json(res, 200, { ok: true });
  });

  // Tries a question against the current database; nothing is stored.
  route('POST', /^\/api\/admin\/test$/, ({ res, body }) => {
    const text = cleanText(body.text, { field: 'سؤال', required: true, max: 500 });
    const a = answerFor(text, 0);
    json(res, 200, { answer: { kind: a.kind, text: a.text, contacts: a.contacts, entryTitle: a.entryTitle ?? null } });
  }, { access: 'staff' });

  // ───────── Admin: settings, quick replies, contacts, avatar ─────────

  route('GET', /^\/api\/admin\/settings$/, ({ res }) => {
    json(res, 200, {
      clinicName: setting('clinic_name'),
      assistantName: setting('assistant_name'),
      welcome: setting('welcome'),
      notFound: setting('not_found'),
      phrases: setting('phrases'),
      persona: setting('persona'),
      publicUrl: setting('public_url'),
      avatarUrl: avatarUrl(),
      hasAvatar: hasAvatar(),
    });
  }, { access: 'staff' });

  // [body field, settings key, cleaner]. Multi-line fields keep their line breaks.
  const SETTING_FIELDS = [
    ['clinicName', 'clinic_name', v => cleanText(v, { field: 'اسم کلینیک', required: true, max: 80 })],
    ['assistantName', 'assistant_name', v => cleanText(v, { field: 'اسم دستیار', required: true, max: 40 })],
    ['welcome', 'welcome', v => cleanMultiline(v, { field: 'پیام خوش‌آمد', required: true, max: 1000 })],
    ['notFound', 'not_found', v => cleanMultiline(v, { field: 'پیام «جواب پیدا نشد»', required: true, max: 1000 })],
    // One phrase per line; empty lines carry no phrase, so they are dropped.
    ['phrases', 'phrases', v => cleanMultiline(v, { field: 'جمله‌های محبت‌آمیز', max: 1000 }).split('\n').filter(Boolean).join('\n')],
    ['persona', 'persona', v => cleanMultiline(v, { field: 'نقش و لحن', max: 4000 })],
  ];

  route('PUT', /^\/api\/admin\/settings$/, ({ res, body }) => {
    const updates = SETTING_FIELDS.filter(([field]) => body[field] !== undefined).map(([field, key, clean]) => [key, clean(body[field])]);
    transaction(db, () => {
      for (const [key, value] of updates) setSetting(db, key, value);
    });
    json(res, 200, { ok: true });
  });

  route('GET', /^\/api\/admin\/quick-replies$/, ({ res }) => {
    const list = audience => quickReplies(audience).map(q => ({ text: q.text, enabled: Boolean(q.enabled) }));
    json(res, 200, { op: list('op'), not: list('not') });
  }, { access: 'staff' });

  route('PUT', /^\/api\/admin\/quick-replies$/, ({ res, body }) => {
    const lists = {};
    for (const audience of ['op', 'not']) {
      const list = body[audience];
      if (list === undefined) continue;
      if (!Array.isArray(list)) throw new HttpError(400, 'فهرست پیام‌های آماده نامعتبر است');
      if (list.length > 20) throw new HttpError(400, 'هر گروه حداکثر ۲۰ پیام آماده دارد');
      lists[audience] = list.map(item => ({
        text: cleanText(typeof item === 'string' ? item : item?.text, {
          required: true, max: 60, messages: { required: 'متن پیام آماده را بنویسید', max: 'پیام آماده حداکثر ۶۰ حرف است' },
        }),
        enabled: typeof item === 'string' || item?.enabled !== false,
      }));
    }
    if (!Object.keys(lists).length) throw new HttpError(400, 'فهرست پیام‌های آماده نامعتبر است');
    transaction(db, () => {
      const insert = db.prepare('INSERT INTO quick_replies (audience, text, enabled, sort) VALUES (?, ?, ?, ?)');
      for (const [audience, list] of Object.entries(lists)) {
        db.prepare('DELETE FROM quick_replies WHERE audience = ?').run(audience);
        list.forEach((q, i) => insert.run(audience, q.text, q.enabled ? 1 : 0, i));
      }
    });
    json(res, 200, { ok: true });
  });

  route('GET', /^\/api\/admin\/contacts$/, ({ res }) => {
    json(res, 200, { contacts: adminContacts() });
  }, { access: 'staff' });

  route('PUT', /^\/api\/admin\/contacts$/, ({ res, body }) => {
    if (!Array.isArray(body.contacts) || body.contacts.length > 20) throw new HttpError(400, 'فهرست راه‌های ارتباطی نامعتبر است');
    const rows = body.contacts.map(c => {
      const id = String(c?.id ?? '');
      const label = contactLabel(id);
      if (!label) throw new HttpError(400, 'راه ارتباطی نامعتبر است');
      const value = cleanText(c.value, { field: `«${label}»`, max: 200 });
      const error = contactError(id, value);
      if (error) throw new HttpError(400, error);
      return { id, enabled: Boolean(c.enabled), value };
    });
    transaction(db, () => {
      const update = db.prepare('UPDATE contacts SET enabled = ?, value = ? WHERE id = ?');
      for (const r of rows) update.run(r.enabled ? 1 : 0, r.value, r.id);
    });
    json(res, 200, { contacts: adminContacts() });
  });

  route('POST', /^\/api\/admin\/avatar$/, ({ res, body, t }) => {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(typeof body.image === 'string' ? body.image : '');
    if (!match) throw new HttpError(400, 'عکس باید PNG، JPG یا WEBP باشد');
    const [, type, base64] = match;
    const data = Buffer.from(base64, 'base64');
    if (data.length > MAX_AVATAR_BYTES) throw new HttpError(400, 'حجم عکس حداکثر ۵۱۲ کیلوبایت است');
    if (!IMAGE_MAGIC[type](data)) throw new HttpError(400, 'فایل عکس خراب است یا با نوعش جور نیست');
    transaction(db, () => {
      db.prepare(`INSERT INTO files (name, type, data, updated_at) VALUES ('avatar', ?, ?, ?)
        ON CONFLICT (name) DO UPDATE SET type = excluded.type, data = excluded.data, updated_at = excluded.updated_at`).run(`image/${type}`, data, t);
      bumpAvatarVersion();
    });
    json(res, 200, { avatarUrl: avatarUrl() });
  }, { maxBody: MAX_AVATAR_BODY });

  route('DELETE', /^\/api\/admin\/avatar$/, ({ res }) => {
    transaction(db, () => {
      db.prepare("DELETE FROM files WHERE name = 'avatar'").run();
      bumpAvatarVersion();
    });
    json(res, 200, { avatarUrl: avatarUrl() });
  });

  // ───────── Admin: accounts (owner only) ─────────

  const userById = id => db.prepare('SELECT * FROM users WHERE id = ?').get(cleanId(id));
  const requireUser = id => {
    const target = userById(id);
    if (!target) throw new HttpError(404, 'کاربر پیدا نشد');
    return target;
  };

  route('GET', /^\/api\/admin\/users$/, ({ res }) => {
    const users = db.prepare("SELECT * FROM users ORDER BY role = 'owner' DESC, id").all();
    json(res, 200, { users: users.map(userRow) });
  });

  // New accounts are always support staff; there is exactly one owner, created from the server's settings.
  route('POST', /^\/api\/admin\/users$/, ({ res, body, t }) => {
    const displayName = cleanText(body.displayName, { field: 'اسم', required: true, max: 60 });
    const username = cleanText(body.username, { field: 'نام کاربری', required: true, max: 40 }).toLowerCase();
    if (!USERNAME_PATTERN.test(username)) throw new HttpError(400, 'نام کاربری فقط حروف کوچک انگلیسی، عدد و . _ - (۳ تا ۴۰ کاراکتر)');
    const problem = validatePassword(body.password);
    if (problem) throw new HttpError(400, problem);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'این نام کاربری قبلاً ثبت شده است');
    const id = createUser(db, { username, password: body.password, displayName, role: 'staff', now: t });
    json(res, 200, { user: userRow(userById(id)) });
  });

  route('PUT', /^\/api\/admin\/users\/(\d+)$/, ({ res, body, params }) => {
    const target = requireUser(params[0]);
    const displayName = body.displayName === undefined ? target.display_name : cleanText(body.displayName, { field: 'اسم', required: true, max: 60 });
    const active = body.active === undefined ? Boolean(target.active) : Boolean(body.active);
    if (target.role === 'owner' && !active) throw new HttpError(400, 'حساب مالک را نمی‌توان غیرفعال کرد');
    db.prepare('UPDATE users SET display_name = ?, active = ? WHERE id = ?').run(displayName, active ? 1 : 0, target.id);
    if (!active) destroyUserSessions(db, target.id);
    json(res, 200, { ok: true });
  });

  route('POST', /^\/api\/admin\/users\/(\d+)\/password$/, ({ res, body, params }) => {
    const target = requireUser(params[0]);
    const problem = validatePassword(body.password);
    if (problem) throw new HttpError(400, problem);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), target.id);
    destroyUserSessions(db, target.id);
    json(res, 200, { ok: true });
  });

  // ───────── Full backup (owner only): all code plus a consistent copy of the database ─────────
  const sourceEntries = () => {
    const entries = [];
    const walk = dir => {
      let names;
      try {
        names = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const name of names) {
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
          if (!BACKUP_SKIP_DIRS.has(name)) walk(full);
        } else if (stat.isFile() && !BACKUP_SKIP_FILE.test(name)) {
          entries.push([`app/${relative(sourceDir, full).split(sep).join('/')}`, readFileSync(full)]);
        }
      }
    };
    walk(sourceDir);
    return entries;
  };

  route('GET', /^\/api\/admin\/backup\.zip$/, ({ res, t }) => {
    const filename = `chat-poshtibani-backup-${jalaliStamp(t).slice(0, 10).replace(/\//g, '-')}.zip`;
    let host = 'ساب‌دامین چت';
    try {
      host = new URL(setting('public_url')).host || host;
    } catch { /* no public URL configured */ }
    const tmp = mkdtempSync(join(tmpdir(), 'chat-backup-'));
    const snapshot = join(tmp, 'chat.sqlite');
    let body;
    try {
      db.prepare('VACUUM INTO ?').run(snapshot);
      body = zip([['RESTORE.txt', restoreText(filename, host)], ['data/chat.sqlite', readFileSync(snapshot)], ...sourceEntries()], { date: new Date(t) });
    } finally {
      try { unlinkSync(snapshot); } catch { /* VACUUM failed before writing */ }
      rmdirSync(tmp);
    }
    download(res, body, 'application/zip', filename);
  });

  const sameOrigin = req => {
    const origin = req.headers.origin;
    if (origin) {
      try {
        return new URL(origin).host === (req.headers['x-forwarded-host'] && trustProxy ? req.headers['x-forwarded-host'] : req.headers.host);
      } catch {
        return false;
      }
    }
    return req.headers['sec-fetch-site'] !== 'cross-site';
  };

  const serveStatic = (req, res, path) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '', { allow: 'GET, HEAD' });
    const key = path === '/' ? '/index.html' : path === '/admin' || path === '/admin/' ? '/admin/index.html' : path;
    const file = staticFiles.get(key);
    if (!file) return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
    return send(res, 200, req.method === 'HEAD' ? '' : file.body, {
      'content-type': file.type,
      'content-length': file.body.length,
      'cache-control': key.startsWith('/fonts/') || key.startsWith('/img/') ? 'public, max-age=604800' : 'no-cache',
    });
  };

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://local');
      const path = url.pathname;
      if (!path.startsWith('/api/')) return serveStatic(req, res, path);
      const match = routes.map(r => ({ r, m: r.method === req.method && r.pattern.exec(path) })).find(x => x.m);
      if (!match) throw new HttpError(404, NOT_FOUND);
      const { r } = match;
      const isWrite = req.method !== 'GET';
      if (isWrite && !sameOrigin(req)) throw new HttpError(403, 'درخواست از مبدأ نامعتبر');
      const body = isWrite && req.method !== 'DELETE' ? await readJson(req, r.maxBody) : {};
      const cookies = parseCookies(req.headers.cookie);
      const t = now();
      let user = null;
      let visitor = null;
      if (r.access === 'staff' || r.access === 'owner') {
        user = sessionUser(db, cookies[ADMIN_COOKIE], t);
        if (!user) throw new HttpError(401, 'لطفاً دوباره وارد شوید');
        if (r.access === 'owner' && user.role !== 'owner') throw new HttpError(403, FORBIDDEN);
      } else if (r.access === 'visitor') {
        visitor = sessionVisitor(db, cookies[VISITOR_COOKIE], t);
        if (!visitor) throw new HttpError(401, 'لطفاً دوباره فرم رو پر کن');
      }
      await r.handler({ req, res, body, cookies, user, visitor, t, query: url.searchParams, params: match.m.slice(1) });
    } catch (err) {
      if (res.headersSent) {
        console.error(err);
        return res.destroy();
      }
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      console.error(err);
      json(res, 500, { error: 'خطای داخلی سرور؛ دوباره تلاش کنید' });
    }
  };
}
