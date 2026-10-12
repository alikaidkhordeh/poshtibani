import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_SETTINGS } from '../src/db.js';
import { createApp, clientIpFrom } from '../src/app.js';
import { createUser } from '../src/auth.js';
import { readZipEntries } from './helpers.js';

const SOURCE_DIR = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = name => fileURLToPath(new URL(`../public/${name}`, import.meta.url));
const OWNER_PASS = 'owner-pass-123';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// Every client gets its own address (sent as X-Forwarded-For; the apps trust it like Caddy's), so the
// per-IP limits of one test never affect another.
let ipCounter = 0;
const nextIp = () => {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};
let phoneCounter = 0;
const nextPhone = () => {
  phoneCounter += 1;
  return `0915${String(phoneCounter).padStart(7, '0')}`;
};

// A fresh database and server. `clock.fixed` pins the app's time; `clock.offset` shifts real time.
async function startApp({ secureCookies = false, trustProxy = 'proxy' } = {}) {
  const db = openDb(':memory:');
  createUser(db, { username: 'owner', password: OWNER_PASS, displayName: 'مالک', role: 'owner' });
  const clock = { fixed: null, offset: 0 };
  const now = () => clock.fixed ?? Date.now() + clock.offset;
  const server = createServer(createApp({
    db, secureCookies, trustProxy, sourceDir: SOURCE_DIR, now, loginLimit: { maxFailures: 5, windowMs: MINUTE },
  }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db,
    base,
    clock,
    client: opts => makeClient(base, opts),
    close: () => new Promise(r => {
      server.closeAllConnections();
      server.close(r);
    }),
  };
}

function makeClient(base, { ip = nextIp() } = {}) {
  const jar = new Map();
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'x-forwarded-for': ip,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';')[0];
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (!value || /Max-Age=0\b/.test(line)) jar.delete(name);
      else jar.set(name, value);
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return {
    ip,
    jar,
    call,
    get: p => call('GET', p),
    post: (p, b = {}, h) => call('POST', p, b, h),
    put: (p, b = {}, h) => call('PUT', p, b, h),
    del: p => call('DELETE', p),
    login: (username, password) => call('POST', '/api/admin/login', { username, password }),
  };
}

async function loggedIn(app, username, password, opts) {
  const c = app.client(opts);
  const r = await c.login(username, password);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}

async function startVisitor(app, { name = 'سارا محمدی', phone = nextPhone(), operated = true, ip } = {}) {
  const c = app.client({ ip });
  const r = await c.post('/api/chat/start', { name, phone, operated });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return c;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24, 7)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 1), Buffer.from('WEBPVP8 '), Buffer.alloc(16, 7)]);
const dataUrl = (type, buf) => `data:image/${type};base64,${buf.toString('base64')}`;

// ───────────────────────── The main instance: tests below run in order and share it ─────────────────────────

let app;
let ownerC;
let staffC;
let staffId;
let v1;
let v1b;
let v1Id;

before(async () => {
  app = await startApp();
});

after(() => app.close());

test('health check, security headers and static files', async () => {
  const c = app.client();
  const info = await c.get('/api/info');
  assert.equal(info.status, 200);
  assert.deepEqual(info.data, { ok: true });
  const csp = info.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /img-src 'self' data: blob:/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(info.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(info.headers.get('x-frame-options'), 'DENY');
  assert.equal(info.headers.get('strict-transport-security'), null, 'no HSTS without secure cookies');

  const svg = await fetch(`${app.base}/img/nana.svg`);
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.equal(svg.headers.get('cache-control'), 'public, max-age=604800');
  const font = await fetch(`${app.base}/fonts/Vazirmatn.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.equal(font.headers.get('cache-control'), 'public, max-age=604800');
  const head = await fetch(`${app.base}/img/nana.svg`, { method: 'HEAD' });
  assert.equal(head.status, 200);

  assert.equal((await fetch(`${app.base}/nope.html`)).status, 404);
  assert.equal((await fetch(`${app.base}/../src/db.js`)).status, 404);
  assert.equal((await fetch(`${app.base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${app.base}/img/nana.svg`, { method: 'POST' })).status, 405);
});

test('the visitor page at / and the admin panel at /admin', {
  skip: !(existsSync(PUBLIC('index.html')) && existsSync(PUBLIC('admin/index.html'))) && 'pages not written yet',
}, async () => {
  for (const path of ['/', '/index.html', '/admin', '/admin/']) {
    const res = await fetch(app.base + path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  }
  assert.equal(await (await fetch(`${app.base}/`)).text(), readFileSync(PUBLIC('index.html'), 'utf8'));
  assert.equal(await (await fetch(`${app.base}/admin`)).text(), readFileSync(PUBLIC('admin/index.html'), 'utf8'));
});

test('chat state without a cookie: the public config, no visitor', async () => {
  const r = await app.client().get('/api/chat/state');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(r.data, {
    config: {
      clinicName: 'کلینیک دکتر زاهدی',
      assistantName: 'ننه پت',
      welcome: DEFAULT_SETTINGS.welcome,
      avatarUrl: '/api/chat/avatar?v=0',
      quickReplies: { op: ['آدرس مطب', 'تماس با پشتیبانی'], not: ['قیمت عمل بینی', 'آدرس مطب', 'تماس با پشتیبانی'] },
      // Phone and Rubika are on but empty, so only Instagram is shown.
      contacts: [{ id: 'instagram', label: 'اینستاگرام', value: 'dr.zahedi', href: 'https://instagram.com/dr.zahedi' }],
    },
    visitor: null,
    messages: [],
  });
  assert.match(r.data.config.welcome, /\{نام\}/);
  assert.match(r.data.config.welcome, /\n/);
});

test('start: validation of name, mobile and the operated choice', async () => {
  const c = app.client();
  const start = body => c.post('/api/chat/start', { name: 'سارا محمدی', phone: '09123456789', operated: true, ...body });
  const expect = async (body, error) => {
    const r = await start(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.error, error);
  };
  await expect({ name: '' }, 'اسمت رو بنویس');
  await expect({ name: '   ' }, 'اسمت رو بنویس');
  await expect({ name: undefined }, 'اسمت رو بنویس');
  await expect({ name: 'س' }, 'اسمت رو کامل بنویس');
  await expect({ name: 'س'.repeat(61) }, 'اسم حداکثر ۶۰ حرفه');
  const PHONE_ERROR = 'شماره موبایل باید ۱۱ رقم باشه و با ۰۹ شروع بشه';
  for (const phone of ['', '12345', '02133334444', '0912345678', '091234567890', '+1 912 345 6789', 'abc', null]) {
    await expect({ phone }, PHONE_ERROR);
  }
  for (const operated of [undefined, 'yes', 1, null]) await expect({ operated }, 'یکی از دو گزینه رو انتخاب کن');
  assert.equal(c.jar.size, 0, 'no cookie after a failed start');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM visitors').get().n, 0);
});

test('start: Persian digits and +98 forms, the cookie, and one visitor per phone number', async () => {
  v1 = app.client();
  const r = await v1.post('/api/chat/start', { name: '  سارا   محمدي  ', phone: '۰۹۱۲ ۳۴۵-۶۷۸۹', operated: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { visitor: { firstName: 'سارا', operated: true }, messages: [] });
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^chat_visitor=[A-Za-z0-9_-]{43}; /);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.match(cookie, /; Max-Age=31536000/);
  assert.doesNotMatch(cookie, /Secure/);
  const row = app.db.prepare('SELECT * FROM visitors').get();
  assert.equal(row.phone, '09123456789');
  assert.equal(row.name, 'سارا محمدی', 'spaces collapsed and Arabic yeh replaced');
  assert.equal(row.operated, 1);
  v1Id = row.id;
  // Only the hash of the cookie is stored.
  const token = v1.jar.get('chat_visitor');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM visitor_sessions WHERE token_hash = ?').get(token).n, 0);

  for (const phone of ['+98 912 345 6789', '00989123456789', '9123456789', '+۹۸۹۱۲۳۴۵۶۷۸۹']) {
    const other = app.client();
    const res = await other.post('/api/chat/start', { name: 'سارا محمدی', phone, operated: true });
    assert.equal(res.status, 200, phone);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM visitors').get().n, 1, 'the same number is the same visitor');
});

test('send: answers from the database, rotating phrases, built-in replies and the unanswered flag', async () => {
  assert.equal((await app.client().post('/api/chat/send', { text: 'سلام' })).status, 401);
  const noCookie = await app.client().post('/api/chat/send', { text: 'سلام' });
  assert.equal(noCookie.data.error, 'لطفاً دوباره فرم رو پر کن');
  const forged = app.client();
  forged.jar.set('chat_visitor', 'x'.repeat(43));
  assert.equal((await forged.post('/api/chat/send', { text: 'سلام' })).status, 401);

  let r = await v1.post('/api/chat/send', { text: '' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'پیامت رو بنویس');
  r = await v1.post('/api/chat/send', { text: 'ب'.repeat(501) });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'پیام حداکثر ۵۰۰ حرفه');

  const before = Date.now();
  r = await v1.post('/api/chat/send', { text: 'آدرس مطب کجاست؟' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [question, answer] = r.data.messages;
  assert.deepEqual(Object.keys(question).sort(), ['at', 'contacts', 'from', 'id', 'text']);
  assert.equal(question.from, 'visitor');
  assert.equal(question.text, 'آدرس مطب کجاست؟');
  assert.equal(question.contacts, false);
  assert.ok(question.at >= before && question.at <= Date.now());
  assert.equal(answer.from, 'bot');
  assert.equal(answer.text, 'قربونت برم، مطب دکتر در اهواز است.');
  assert.equal(answer.contacts, false);
  assert.ok(answer.id > question.id);

  r = await v1.post('/api/chat/send', { text: 'قیمت عمل بینی چقدره' });
  assert.equal(r.data.messages[1].text, 'الهی بگردم، قیمت عمل بینی ۶۰ میلیون است.');

  r = await v1.post('/api/chat/send', { text: 'سلام' });
  assert.equal(r.data.messages[1].text, 'سلام به روی ماهت! بگو ببینم چه سؤالی داری؟');
  r = await v1.post('/api/chat/send', { text: 'تماس با پشتیبانی' });
  assert.equal(r.data.messages[1].contacts, true);
  r = await v1.post('/api/chat/send', { text: 'ادرس' });
  assert.equal(r.data.messages[1].text, 'عزیز دلم، مطب دکتر در اهواز است.', 'built-in replies do not move the rotation');

  r = await v1.post('/api/chat/send', { text: 'بیمه قبول می‌کنید؟' });
  assert.equal(r.data.messages[1].text, DEFAULT_SETTINGS.not_found);
  assert.equal(r.data.messages[1].contacts, true);
  const stored = app.db.prepare('SELECT * FROM messages WHERE id = ?').get(r.data.messages[0].id);
  assert.equal(stored.unanswered, 1);
  assert.equal(stored.resolved, 0);
  assert.equal(stored.norm, 'بیمه قبول می کنید');
  assert.equal(stored.kind, 'question');
  const bot = app.db.prepare('SELECT * FROM messages WHERE id = ?').get(r.data.messages[1].id);
  assert.equal(bot.kind, 'none');
  const kbBot = app.db.prepare("SELECT kb_id FROM messages WHERE sender = 'bot' AND kind = 'kb' ORDER BY id LIMIT 1").get();
  assert.equal(kbBot.kb_id, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE unanswered = 1').get().n, 1, 'answered questions are not flagged');

  r = await v1.post('/api/chat/send', { text: '؟؟؟' });
  assert.equal(r.data.messages[1].text, DEFAULT_SETTINGS.not_found);
  assert.equal(app.db.prepare('SELECT unanswered FROM messages WHERE id = ?').get(r.data.messages[0].id).unanswered, 0,
    'punctuation alone does not go to the unanswered list');
});

test('state with the cookie, polling, and a new device that never sees the earlier conversation', async () => {
  let r = await v1.get('/api/chat/state');
  assert.deepEqual(r.data.visitor, { firstName: 'سارا', operated: true });
  assert.equal(r.data.messages.length, 14);
  assert.equal(r.data.messages[0].text, 'آدرس مطب کجاست؟');
  const ids = r.data.messages.map(m => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ascending');

  r = await v1.get('/api/chat/messages?after=0');
  assert.equal(r.data.messages.length, 14);
  r = await v1.get(`/api/chat/messages?after=${ids[11]}`);
  assert.deepEqual(r.data.messages.map(m => m.id), ids.slice(12));
  r = await v1.get('/api/chat/messages?after=abc');
  assert.equal(r.data.messages.length, 14, 'a bad cursor reads from the start');
  assert.equal((await app.client().get('/api/chat/messages?after=0')).status, 401);

  // Polling is the online heartbeat.
  app.db.prepare('UPDATE visitors SET last_seen = 0 WHERE id = ?').run(v1Id);
  await v1.get(`/api/chat/messages?after=${ids.at(-1)}`);
  assert.ok(app.db.prepare('SELECT last_seen FROM visitors WHERE id = ?').get(v1Id).last_seen > Date.now() - 5000);

  // Someone signs in with the same number on another phone: the earlier messages stay hidden there.
  v1b = app.client();
  r = await v1b.post('/api/chat/start', { name: 'سارا', phone: '09123456789', operated: false });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.messages, []);
  r = await v1b.get('/api/chat/state');
  assert.deepEqual(r.data.visitor, { firstName: 'سارا', operated: false });
  assert.deepEqual(r.data.messages, []);
  assert.deepEqual((await v1b.get('/api/chat/messages?after=0')).data.messages, []);
  r = await v1b.post('/api/chat/send', { text: 'ادرس' });
  assert.equal(r.status, 200);
  assert.equal((await v1b.get('/api/chat/state')).data.messages.length, 2);
  assert.equal(app.db.prepare('SELECT operated FROM visitors WHERE id = ?').get(v1Id).operated, 0, 'the latest answer is kept');

  // A cookie that matches no session is just "no visitor".
  const stale = app.client();
  stale.jar.set('chat_visitor', 'A'.repeat(43));
  r = await stale.get('/api/chat/state');
  assert.equal(r.status, 200);
  assert.equal(r.data.visitor, null);

  // Starting again on the same device ends that device's previous sign-in.
  const sessions = app.db.prepare('SELECT COUNT(*) AS n FROM visitor_sessions').get().n;
  const again = app.client();
  await again.post('/api/chat/start', { name: 'نگار', phone: '09350000001', operated: true });
  const oldCookie = again.jar.get('chat_visitor');
  await again.post('/api/chat/start', { name: 'نگار', phone: '09350000001', operated: true });
  assert.notEqual(again.jar.get('chat_visitor'), oldCookie);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM visitor_sessions').get().n, sessions + 1);
});

test('admin login, the session cookie, /me and logout', async () => {
  const c = app.client();
  let r = await c.get('/api/admin/me');
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'لطفاً دوباره وارد شوید');
  r = await c.login('owner', 'wrong-password');
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'نام کاربری یا رمز عبور اشتباه است');
  r = await c.login('nobody', OWNER_PASS);
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'نام کاربری یا رمز عبور اشتباه است');

  r = await c.login('OWNER', OWNER_PASS);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { user: { id: 1, username: 'owner', displayName: 'مالک', role: 'owner' } });
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /^chat_admin=[A-Za-z0-9_-]{43}; /);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; Max-Age=604800/);
  assert.ok(app.db.prepare('SELECT last_login_at FROM users WHERE id = 1').get().last_login_at > Date.now() - 5000);

  r = await c.get('/api/admin/me');
  assert.deepEqual(r.data, {
    user: { id: 1, username: 'owner', displayName: 'مالک', role: 'owner' },
    clinicName: 'کلینیک دکتر زاهدی',
    assistantName: 'ننه پت',
    avatarUrl: '/api/chat/avatar?v=0',
    publicUrl: '',
  });

  // The visitor cookie is not an admin session and the admin cookie is not a visitor.
  const mixed = app.client();
  mixed.jar.set('chat_visitor', v1.jar.get('chat_visitor'));
  assert.equal((await mixed.get('/api/admin/me')).status, 401);
  const mixed2 = app.client();
  mixed2.jar.set('chat_visitor', c.jar.get('chat_admin'));
  assert.equal((await mixed2.get('/api/chat/state')).data.visitor, null);

  // A POST with no body at all is accepted as {} (logout needs nothing).
  const res = await fetch(`${app.base}/api/admin/logout`, { method: 'POST', headers: { cookie: `chat_admin=${c.jar.get('chat_admin')}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie'), /^chat_admin=; .*Max-Age=0/);
  assert.equal((await c.get('/api/admin/me')).status, 401, 'the session is gone on the server');

  ownerC = await loggedIn(app, 'owner', OWNER_PASS);
});

test('login is locked after repeated failures, but not for the owner elsewhere', async () => {
  const attacker = app.client({ ip: '198.51.100.7' });
  for (let i = 0; i < 5; i += 1) assert.equal((await attacker.login('owner', `nope-${i}`)).status, 401);
  const r = await attacker.login('owner', OWNER_PASS);
  assert.equal(r.status, 429);
  assert.match(r.data.error, /دقیقه/);
  assert.equal((await app.client({ ip: '203.0.113.50' }).login('owner', OWNER_PASS)).status, 200, 'the owner, elsewhere, still gets in');
  // The lock lasts the configured window (one minute in these tests).
  app.clock.offset = MINUTE + 1000;
  assert.equal((await attacker.login('owner', OWNER_PASS)).status, 200);
  app.clock.offset = 0;
});

test('owner manages accounts: create staff, list, validation and duplicates', async () => {
  let r = await ownerC.post('/api/admin/users', { username: 'Staff1', displayName: 'زهرا', password: 'staff-pass-123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual({ ...r.data.user, id: 0 }, { id: 0, username: 'staff1', displayName: 'زهرا', role: 'staff', active: true, lastLoginAt: null });
  staffId = r.data.user.id;

  r = await ownerC.post('/api/admin/users', { username: 'STAFF1', displayName: 'x', password: 'another-pass-1' });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'این نام کاربری قبلاً ثبت شده است');
  for (const username of ['ab', 'زهرا', 'has space', 'a'.repeat(41), '']) {
    assert.equal((await ownerC.post('/api/admin/users', { username, displayName: 'x', password: 'another-pass-1' })).status, 400, username);
  }
  assert.equal((await ownerC.post('/api/admin/users', { username: 'weak1', displayName: 'x', password: '1234567' })).status, 400);
  assert.equal((await ownerC.post('/api/admin/users', { username: 'noname', displayName: ' ', password: 'another-pass-1' })).status, 400);
  r = await ownerC.post('/api/admin/users', { username: 'boss2', displayName: 'x', password: 'another-pass-1', role: 'owner' });
  assert.equal(r.data.user.role, 'staff', 'new accounts are always staff');

  staffC = await loggedIn(app, 'staff1', 'staff-pass-123');
  r = await ownerC.get('/api/admin/users');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.users.map(u => [u.username, u.role, u.active]), [['owner', 'owner', true], ['staff1', 'staff', true], ['boss2', 'staff', true]]);
  assert.ok(r.data.users[1].lastLoginAt > 0);
  assert.equal(r.data.users[2].lastLoginAt, null);
  assert.ok(r.data.users.every(u => !('password_hash' in u) && !('passwordHash' in u)));
  const me = await staffC.get('/api/admin/me');
  assert.deepEqual(me.data.user, { id: staffId, username: 'staff1', displayName: 'زهرا', role: 'staff' });
});

test('a staff reply reaches the visitor through polling, on every device of that visitor', async () => {
  const last1 = (await v1.get('/api/chat/state')).data.messages.at(-1).id;
  const last2 = (await v1b.get('/api/chat/state')).data.messages.at(-1).id;
  let r = await staffC.post(`/api/admin/visitors/${v1Id}/messages`, { text: '  سلام سارا جان  \n  فردا تماس می‌گیریم  ' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual({ ...r.data.message, id: 0, at: 0 }, {
    id: 0, from: 'staff', text: 'سلام سارا جان\nفردا تماس می‌گیریم', kind: 'staff', contacts: false, unanswered: false, at: 0, staffName: 'زهرا',
  });
  const staffMessage = r.data.message;
  r = await v1.get(`/api/chat/messages?after=${last1}`);
  assert.deepEqual(r.data.messages, [{ id: staffMessage.id, from: 'staff', text: staffMessage.text, contacts: false, at: staffMessage.at }]);
  r = await v1b.get(`/api/chat/messages?after=${last2}`);
  assert.deepEqual(r.data.messages.map(m => m.id), [staffMessage.id]);

  assert.equal((await staffC.post(`/api/admin/visitors/${v1Id}/messages`, { text: ' ' })).status, 400);
  assert.equal((await staffC.post(`/api/admin/visitors/${v1Id}/messages`, { text: 'x'.repeat(1001) })).status, 400);
  assert.equal((await staffC.post('/api/admin/visitors/9999/messages', { text: 'سلام' })).status, 404);
  assert.equal((await app.client().post(`/api/admin/visitors/${v1Id}/messages`, { text: 'سلام' })).status, 401);
});

test('visitor detail and the support note', async () => {
  let r = await staffC.get(`/api/admin/visitors/${v1Id}`);
  assert.equal(r.status, 200);
  const { visitor, messages } = r.data;
  assert.deepEqual(Object.keys(visitor).sort(), ['createdAt', 'id', 'lastQuestion', 'lastSeen', 'name', 'note', 'online', 'operated', 'phone', 'questions']);
  assert.equal(visitor.name, 'سارا');
  assert.equal(visitor.phone, '09123456789');
  assert.equal(visitor.operated, false);
  assert.equal(visitor.online, true);
  assert.equal(visitor.questions, 8);
  assert.equal(visitor.lastQuestion, 'ادرس');
  assert.equal(visitor.note, '');
  assert.equal(messages.length, 17, 'every message of the visitor, from all devices');
  assert.deepEqual(Object.keys(messages[0]).sort(), ['at', 'contacts', 'from', 'id', 'kind', 'staffName', 'text', 'unanswered']);
  assert.deepEqual(messages.slice(0, 2).map(m => [m.from, m.kind, m.staffName]), [['visitor', 'question', null], ['bot', 'kb', null]]);
  assert.deepEqual(messages.filter(m => m.unanswered).map(m => m.text), ['بیمه قبول می‌کنید؟']);
  assert.equal(messages.find(m => m.kind === 'none').contacts, true);
  assert.equal(messages.at(-1).staffName, 'زهرا');

  r = await staffC.put(`/api/admin/visitors/${v1Id}`, { note: '  تماس گرفته شد  \n\n\n\n  دوباره پیگیری شود ' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
  assert.equal((await staffC.get(`/api/admin/visitors/${v1Id}`)).data.visitor.note, 'تماس گرفته شد\n\nدوباره پیگیری شود');
  assert.equal((await staffC.put(`/api/admin/visitors/${v1Id}`, { note: 'x'.repeat(501) })).status, 400);
  assert.equal((await staffC.put(`/api/admin/visitors/${v1Id}`, { note: '' })).status, 200, 'the note can be cleared');

  r = await staffC.get('/api/admin/visitors/9999');
  assert.equal(r.status, 404);
  assert.equal(r.data.error, 'پیدا نشد');
  assert.equal((await staffC.put('/api/admin/visitors/9999', { note: 'x' })).status, 404);
});

let insuranceNorm;

test('unanswered questions are grouped by their normalized text and resolved by the owner', async () => {
  const v2 = await startVisitor(app, { name: 'مریم کریمی' });
  await v2.post('/api/chat/send', { text: 'بیمه قبول می کنید' });
  await v2.post('/api/chat/send', { text: 'قسطی هم میشه پرداخت کرد؟' });

  let r = await staffC.get('/api/admin/unanswered');
  assert.equal(r.status, 200);
  assert.equal(r.data.items.length, 2);
  const [first, second] = r.data.items;
  assert.deepEqual(Object.keys(first).sort(), ['count', 'lastAt', 'lastVisitorId', 'lastVisitorName', 'norm', 'text']);
  assert.equal(first.norm, 'بیمه قبول می کنید');
  assert.equal(first.count, 2);
  assert.equal(first.text, 'بیمه قبول می کنید', 'the newest spelling');
  assert.equal(first.lastVisitorName, 'مریم کریمی');
  assert.ok(first.lastAt > 0);
  assert.equal(second.count, 1);
  assert.equal(second.text, 'قسطی هم میشه پرداخت کرد؟');
  insuranceNorm = first.norm;

  r = await staffC.post('/api/admin/unanswered/resolve', { norm: second.norm });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'شما اجازه انجام این کار را ندارید');
  assert.equal((await ownerC.post('/api/admin/unanswered/resolve', {})).status, 400);
  assert.equal((await ownerC.post('/api/admin/unanswered/resolve', { norm: 12 })).status, 400);
  r = await ownerC.post('/api/admin/unanswered/resolve', { norm: second.norm });
  assert.deepEqual(r.data, { resolved: 1 });
  assert.deepEqual((await ownerC.post('/api/admin/unanswered/resolve', { norm: second.norm })).data, { resolved: 0 });
  r = await staffC.get('/api/admin/unanswered');
  assert.deepEqual(r.data.items.map(i => i.norm), [insuranceNorm]);
  const resolved = (await staffC.get(`/api/admin/visitors/${r.data.items[0].lastVisitorId}`)).data.messages;
  assert.equal(resolved.find(m => m.text === 'قسطی هم میشه پرداخت کرد؟').unanswered, false);
});

test('knowledge base: list, create (resolving an unanswered group), edit, delete', async () => {
  let r = await staffC.get('/api/admin/kb');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.entries.map(e => [e.id, e.category, e.title, e.keywords, e.answer]), [
    [1, 'اطلاعات مطب', 'آدرس مطب', 'آدرس، کجاست، نشانی، لوکیشن', 'مطب دکتر در اهواز است.'],
    [2, 'هزینه و نوبت', 'قیمت عمل بینی', 'قیمت، هزینه، تعرفه', 'قیمت عمل بینی ۶۰ میلیون است.'],
  ]);
  assert.ok(r.data.entries[0].updatedAt > 0);

  const entry = {
    category: ' هزینه و نوبت ', title: 'بیمه', keywords: 'بیمه, تکمیلی\nقرارداد ;  بیمه  درمان ',
    answer: '  فعلاً با بیمه‌ی تکمیلی قرارداد نداریم.  \n\n\n\n  فاکتور برای بازپرداخت می‌دهیم. ', resolveNorm: insuranceNorm,
  };
  for (const [field, value] of [['title', ''], ['title', 'x'.repeat(121)], ['answer', ' '], ['answer', 'x'.repeat(2001)], ['category', 'x'.repeat(61)], ['keywords', 'x'.repeat(501)], ['resolveNorm', 5]]) {
    assert.equal((await ownerC.post('/api/admin/kb', { ...entry, [field]: value })).status, 400, field);
  }
  assert.equal((await staffC.get('/api/admin/unanswered')).data.items.length, 1, 'a refused entry resolves nothing');

  r = await ownerC.post('/api/admin/kb', entry);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const created = r.data.entry;
  assert.deepEqual(Object.keys(created).sort(), ['answer', 'category', 'id', 'keywords', 'title', 'updatedAt']);
  assert.equal(created.category, 'هزینه و نوبت');
  assert.equal(created.keywords, 'بیمه، تکمیلی، قرارداد، بیمه درمان');
  assert.equal(created.answer, 'فعلاً با بیمه‌ی تکمیلی قرارداد نداریم.\n\nفاکتور برای بازپرداخت می‌دهیم.');
  assert.deepEqual((await staffC.get('/api/admin/unanswered')).data.items, [], 'resolveNorm handled that group');

  // The bot answers it right away.
  const v = await startVisitor(app);
  r = await v.post('/api/chat/send', { text: 'بیمه قبول می‌کنید؟' });
  assert.equal(r.data.messages[1].text, `قربونت برم، ${created.answer}`);

  app.clock.offset = 5000;
  r = await ownerC.put(`/api/admin/kb/${created.id}`, { category: '', title: 'بیمه تکمیلی', keywords: '', answer: 'با بیمه‌ی تکمیلی قرارداد نداریم.' });
  app.clock.offset = 0;
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.entry.title, 'بیمه تکمیلی');
  assert.equal(r.data.entry.category, '');
  assert.ok(r.data.entry.updatedAt > created.updatedAt);
  assert.equal((await ownerC.put('/api/admin/kb/9999', { title: 'x', answer: 'y' })).status, 404);
  assert.equal((await ownerC.put(`/api/admin/kb/${created.id}`, { title: '', answer: 'y' })).status, 400);

  r = await ownerC.del(`/api/admin/kb/${created.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
  assert.equal((await ownerC.del(`/api/admin/kb/${created.id}`)).status, 404);
  assert.deepEqual((await staffC.get('/api/admin/kb')).data.entries.map(e => e.id), [1, 2]);
});

test('test endpoint answers like the bot and stores nothing', async () => {
  const count = () => app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const before = count();
  let r = await staffC.post('/api/admin/test', { text: 'آدرس مطب کجاست؟' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { answer: { kind: 'kb', text: 'قربونت برم، مطب دکتر در اهواز است.', contacts: false, entryTitle: 'آدرس مطب' } });
  r = await ownerC.post('/api/admin/test', { text: 'بیمه قبول می‌کنید؟' });
  assert.deepEqual(r.data, { answer: { kind: 'none', text: DEFAULT_SETTINGS.not_found, contacts: true, entryTitle: null } });
  r = await ownerC.post('/api/admin/test', { text: 'تماس با پشتیبانی' });
  assert.equal(r.data.answer.kind, 'talk');
  assert.equal(r.data.answer.contacts, true);
  assert.equal((await ownerC.post('/api/admin/test', { text: '' })).status, 400);
  assert.equal(count(), before);
});

test('settings: read, partial update, multi-line fields keep their line breaks', async () => {
  let r = await staffC.get('/api/admin/settings');
  assert.deepEqual(r.data, {
    clinicName: 'کلینیک دکتر زاهدی',
    assistantName: 'ننه پت',
    welcome: DEFAULT_SETTINGS.welcome,
    notFound: DEFAULT_SETTINGS.not_found,
    phrases: DEFAULT_SETTINGS.phrases,
    persona: DEFAULT_SETTINGS.persona,
    publicUrl: '',
    avatarUrl: '/api/chat/avatar?v=0',
    hasAvatar: false,
  });

  r = await ownerC.put('/api/admin/settings', { welcome: '  سلام {نام} جان  \r\n\r\n\r\n\r\n  خوش اومدی   ' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
  r = await staffC.get('/api/admin/settings');
  assert.equal(r.data.welcome, 'سلام {نام} جان\n\nخوش اومدی');
  assert.equal(r.data.clinicName, 'کلینیک دکتر زاهدی', 'fields that are not sent stay as they were');

  r = await ownerC.put('/api/admin/settings', {
    clinicName: ' مطب   دکتر زاهدی ', assistantName: 'ننه پت', notFound: 'نمی‌دونم عزیزم.\nاز این راه‌ها بپرس:',
    phrases: '  عزیزم،  \n\n\n جانم، \n', persona: 'خط یک\nخط دو',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await staffC.get('/api/admin/settings');
  assert.equal(r.data.clinicName, 'مطب دکتر زاهدی');
  assert.equal(r.data.notFound, 'نمی‌دونم عزیزم.\nاز این راه‌ها بپرس:');
  assert.equal(r.data.phrases, 'عزیزم،\nجانم،');
  assert.equal(r.data.persona, 'خط یک\nخط دو');
  const state = (await app.client().get('/api/chat/state')).data.config;
  assert.equal(state.clinicName, 'مطب دکتر زاهدی');
  assert.equal(state.welcome, 'سلام {نام} جان\n\nخوش اومدی');
  assert.equal((await staffC.post('/api/admin/test', { text: 'ادرس' })).data.answer.text, 'عزیزم، مطب دکتر در اهواز است.');
  assert.equal((await staffC.post('/api/admin/test', { text: 'بیمه' })).data.answer.text, 'نمی‌دونم عزیزم.\nاز این راه‌ها بپرس:');

  for (const body of [
    { clinicName: '' }, { clinicName: 'x'.repeat(81) }, { assistantName: ' ' }, { assistantName: 'x'.repeat(41) },
    { welcome: '' }, { welcome: 'x'.repeat(1001) }, { notFound: '' }, { phrases: 'x'.repeat(1001) }, { persona: 'x'.repeat(4001) },
  ]) {
    assert.equal((await ownerC.put('/api/admin/settings', body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  r = await ownerC.put('/api/admin/settings', { welcome: 'نو', clinicName: '' });
  assert.equal(r.status, 400);
  assert.equal((await staffC.get('/api/admin/settings')).data.welcome, 'سلام {نام} جان\n\nخوش اومدی', 'a refused update changes nothing');
  assert.equal((await ownerC.put('/api/admin/settings', { phrases: '' })).status, 200, 'phrases may be empty');
  assert.equal((await staffC.post('/api/admin/test', { text: 'ادرس' })).data.answer.text, 'مطب دکتر در اهواز است.');
  await ownerC.put('/api/admin/settings', { phrases: DEFAULT_SETTINGS.phrases, clinicName: 'کلینیک دکتر زاهدی' });
});

test('quick replies: replace both lists; the chat shows only the enabled ones', async () => {
  let r = await staffC.get('/api/admin/quick-replies');
  assert.deepEqual(r.data, {
    op: [{ text: 'آدرس مطب', enabled: true }, { text: 'تماس با پشتیبانی', enabled: true }],
    not: [{ text: 'قیمت عمل بینی', enabled: true }, { text: 'آدرس مطب', enabled: true }, { text: 'تماس با پشتیبانی', enabled: true }],
  });
  r = await ownerC.put('/api/admin/quick-replies', {
    op: [{ text: ' مراقبت بعد از عمل ', enabled: true }, { text: 'آدرس مطب', enabled: false }, { text: 'تماس با پشتیبانی', enabled: true }],
    not: [{ text: 'قیمت عمل بینی', enabled: true }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await staffC.get('/api/admin/quick-replies');
  assert.deepEqual(r.data.op, [{ text: 'مراقبت بعد از عمل', enabled: true }, { text: 'آدرس مطب', enabled: false }, { text: 'تماس با پشتیبانی', enabled: true }]);
  assert.deepEqual(r.data.not, [{ text: 'قیمت عمل بینی', enabled: true }]);
  const config = (await app.client().get('/api/chat/state')).data.config;
  assert.deepEqual(config.quickReplies, { op: ['مراقبت بعد از عمل', 'تماس با پشتیبانی'], not: ['قیمت عمل بینی'] });

  const item = { text: 'x', enabled: true };
  for (const body of [{}, { op: 'x' }, { op: Array(21).fill(item) }, { op: [{ text: '' }] }, { op: [{ text: 'x'.repeat(61) }] }, { op: [null] }]) {
    assert.equal((await ownerC.put('/api/admin/quick-replies', body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  r = await ownerC.put('/api/admin/quick-replies', { op: [{ text: 'x' }], not: [{ text: '' }] });
  assert.equal(r.data.error, 'متن پیام آماده را بنویسید');
  assert.equal((await staffC.get('/api/admin/quick-replies')).data.op.length, 3, 'a refused save changes nothing');
  assert.equal((await ownerC.put('/api/admin/quick-replies', { op: Array(20).fill(item), not: [] })).status, 200);
  r = await staffC.get('/api/admin/quick-replies');
  assert.equal(r.data.op.length, 20);
  assert.deepEqual(r.data.not, []);
});

test('contacts: six rows in order, validation, and what the chat shows', async () => {
  let r = await staffC.get('/api/admin/contacts');
  assert.deepEqual(r.data.contacts, [
    { id: 'phone', label: 'تماس تلفنی', enabled: true, value: '', href: null },
    { id: 'whatsapp', label: 'واتس‌اپ', enabled: false, value: '', href: null },
    { id: 'instagram', label: 'اینستاگرام', enabled: true, value: 'dr.zahedi', href: 'https://instagram.com/dr.zahedi' },
    { id: 'rubika', label: 'روبیکا', enabled: true, value: '', href: null },
    { id: 'telegram', label: 'تلگرام', enabled: false, value: '', href: null },
    { id: 'site', label: 'سایت', enabled: false, value: '', href: null },
  ]);

  r = await ownerC.put('/api/admin/contacts', { contacts: [{ id: 'site', enabled: true, value: 'javascript:alert(1)' }] });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'لینک «سایت» درست نیست');
  r = await ownerC.put('/api/admin/contacts', { contacts: [{ id: 'email', enabled: true, value: 'a@b.c' }] });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'راه ارتباطی نامعتبر است');
  assert.equal((await ownerC.put('/api/admin/contacts', { contacts: 'x' })).status, 400);
  assert.equal((await ownerC.put('/api/admin/contacts', {})).status, 400);
  assert.equal((await ownerC.put('/api/admin/contacts', { contacts: [{ id: 'phone', enabled: true, value: 'x'.repeat(201) }] })).status, 400);
  // One bad row refuses the whole save.
  r = await ownerC.put('/api/admin/contacts', { contacts: [{ id: 'phone', enabled: true, value: '09120000000' }, { id: 'telegram', enabled: true, value: 'نامعتبر' }] });
  assert.equal(r.status, 400);
  assert.equal((await staffC.get('/api/admin/contacts')).data.contacts[0].value, '');

  r = await ownerC.put('/api/admin/contacts', {
    contacts: [
      { id: 'phone', enabled: true, value: '۰۶۱ ۳۳۳۳ ۴۴۴۴' },
      { id: 'whatsapp', enabled: true, value: '09120000000' },
      { id: 'rubika', enabled: false, value: '@zahedi' },
      { id: 'site', enabled: true, value: 'drzahedi.ir' },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.contacts.map(c => [c.id, c.enabled, c.href]), [
    ['phone', true, 'tel:06133334444'],
    ['whatsapp', true, 'https://wa.me/989120000000'],
    ['instagram', true, 'https://instagram.com/dr.zahedi'],
    ['rubika', false, 'https://rubika.ir/zahedi'],
    ['telegram', false, null],
    ['site', true, 'https://drzahedi.ir/'],
  ]);
  const config = (await app.client().get('/api/chat/state')).data.config;
  assert.deepEqual(config.contacts.map(c => [c.id, c.label, c.value, c.href]), [
    ['phone', 'تماس تلفنی', '۰۶۱ ۳۳۳۳ ۴۴۴۴', 'tel:06133334444'],
    ['whatsapp', 'واتس‌اپ', '09120000000', 'https://wa.me/989120000000'],
    ['instagram', 'اینستاگرام', 'dr.zahedi', 'https://instagram.com/dr.zahedi'],
    ['site', 'سایت', 'drzahedi.ir', 'https://drzahedi.ir/'],
  ]);
});

test('avatar: default picture, upload with a magic-byte check, version bump, back to default', async () => {
  const nana = readFileSync(PUBLIC('img/nana.svg'));
  let r = await app.client().get('/api/chat/avatar?v=0');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/svg+xml');
  assert.equal(r.headers.get('cache-control'), 'public, max-age=86400');
  assert.ok(r.data.equals(nana));

  const bad = async (image, error) => {
    const res = await ownerC.post('/api/admin/avatar', { image });
    assert.equal(res.status, 400, String(image).slice(0, 30));
    if (error) assert.equal(res.data.error, error);
  };
  await bad(undefined, 'عکس باید PNG، JPG یا WEBP باشد');
  await bad('not a data url');
  await bad(dataUrl('gif', Buffer.from('GIF89a0000000000')));
  await bad(dataUrl('svg+xml', Buffer.from('<svg/>')));
  await bad(`${dataUrl('png', PNG)}!`);
  await bad(dataUrl('png', JPEG), 'فایل عکس خراب است یا با نوعش جور نیست');
  await bad(dataUrl('jpeg', PNG), 'فایل عکس خراب است یا با نوعش جور نیست');
  await bad(dataUrl('webp', Buffer.concat([Buffer.from('RIFF0000WAVE'), Buffer.alloc(8)])));
  // 600 KB decoded fits the 1 MB request limit but not the 512 KB picture limit.
  await bad(dataUrl('png', Buffer.concat([PNG, Buffer.alloc(600 * 1024)])), 'حجم عکس حداکثر ۵۱۲ کیلوبایت است');
  assert.equal((await staffC.get('/api/admin/settings')).data.avatarUrl, '/api/chat/avatar?v=0', 'refused uploads change nothing');

  // A 100 KB picture: more than the 32 KB limit of other requests.
  const big = Buffer.concat([PNG, Buffer.alloc(100 * 1024, 1)]);
  r = await ownerC.post('/api/admin/avatar', { image: dataUrl('png', big) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { avatarUrl: '/api/chat/avatar?v=1' });
  r = await app.client().get('/api/chat/avatar?v=1');
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.ok(r.data.equals(big));

  r = await ownerC.post('/api/admin/avatar', { image: dataUrl('jpeg', JPEG) });
  assert.deepEqual(r.data, { avatarUrl: '/api/chat/avatar?v=2' });
  assert.equal((await app.client().get('/api/chat/avatar')).headers.get('content-type'), 'image/jpeg');
  r = await ownerC.post('/api/admin/avatar', { image: dataUrl('webp', WEBP) });
  assert.deepEqual(r.data, { avatarUrl: '/api/chat/avatar?v=3' });
  r = await app.client().get('/api/chat/avatar');
  assert.equal(r.headers.get('content-type'), 'image/webp');
  assert.ok(r.data.equals(WEBP));
  assert.equal((await app.client().get('/api/chat/state')).data.config.avatarUrl, '/api/chat/avatar?v=3');
  assert.equal((await ownerC.get('/api/admin/me')).data.avatarUrl, '/api/chat/avatar?v=3');
  assert.equal((await staffC.get('/api/admin/settings')).data.hasAvatar, true);

  r = await ownerC.del('/api/admin/avatar');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { avatarUrl: '/api/chat/avatar?v=4' });
  r = await app.client().get('/api/chat/avatar?v=4');
  assert.equal(r.headers.get('content-type'), 'image/svg+xml');
  assert.ok(r.data.equals(nana));
  assert.equal((await staffC.get('/api/admin/settings')).data.hasAvatar, false);
});

test('request size limits: 1 MB for the avatar, 32 KB for everything else', async () => {
  let r = await ownerC.put('/api/admin/settings', { persona: 'x'.repeat(40 * 1024) });
  assert.equal(r.status, 413);
  r = await ownerC.post('/api/admin/avatar', { image: dataUrl('png', Buffer.concat([PNG, Buffer.alloc(800 * 1024)])) });
  assert.equal(r.status, 413);
  r = await app.client().post('/api/chat/start', { name: 'x'.repeat(33 * 1024), phone: '09120000000', operated: true });
  assert.equal(r.status, 413);
});

// Every owner-only route; staff get 403 on all of them, strangers 401.
const OWNER_ONLY = [
  ['POST', '/api/admin/unanswered/resolve', { norm: 'x' }],
  ['POST', '/api/admin/kb', { title: 'موضوع', answer: 'جواب' }],
  ['PUT', '/api/admin/kb/1', { title: 'موضوع', answer: 'جواب' }],
  ['DELETE', '/api/admin/kb/1'],
  ['PUT', '/api/admin/settings', { clinicName: 'هک' }],
  ['PUT', '/api/admin/quick-replies', { op: [] }],
  ['PUT', '/api/admin/contacts', { contacts: [] }],
  ['POST', '/api/admin/avatar', { image: 'data:image/png;base64,AAAA' }],
  ['DELETE', '/api/admin/avatar'],
  ['GET', '/api/admin/users'],
  ['POST', '/api/admin/users', { username: 'sneaky', displayName: 'x', password: 'sneaky-pass-1' }],
  ['PUT', '/api/admin/users/1', { displayName: 'هک', active: false }],
  ['POST', '/api/admin/users/1/password', { password: 'hacked-pass-1' }],
  ['GET', '/api/admin/backup.zip'],
];
const STAFF_ROUTES = [
  ['GET', '/api/admin/me'],
  ['GET', '/api/admin/dashboard'],
  ['GET', '/api/admin/visitors'],
  ['GET', '/api/admin/visitors/1'],
  ['PUT', '/api/admin/visitors/1', { note: 'یادداشت' }],
  ['GET', '/api/admin/export.xlsx?filter=all'],
  ['GET', '/api/admin/unanswered'],
  ['GET', '/api/admin/kb'],
  ['POST', '/api/admin/test', { text: 'سلام' }],
  ['GET', '/api/admin/settings'],
  ['GET', '/api/admin/quick-replies'],
  ['GET', '/api/admin/contacts'],
  ['POST', '/api/admin/me/password', { current: 'wrong', next: 'whatever-123' }, 400],
];

test('staff may use the conversation pages but get 403 on every owner-only route', async () => {
  for (const [method, path, body] of OWNER_ONLY) {
    const r = await staffC.call(method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.data.error, 'شما اجازه انجام این کار را ندارید');
  }
  for (const [method, path, body, status = 200] of STAFF_ROUTES) {
    assert.equal((await staffC.call(method, path, body)).status, status, `${method} ${path}`);
  }
  const stranger = app.client();
  for (const [method, path, body] of [...OWNER_ONLY, ...STAFF_ROUTES, ['POST', '/api/admin/logout', {}]]) {
    const r = await stranger.call(method, path, body);
    assert.equal(r.status, 401, `${method} ${path}`);
  }
  // Nothing changed.
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM kb').get().n, 2);
  assert.equal(app.db.prepare("SELECT display_name FROM users WHERE id = 1").get().display_name, 'مالک');
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'sneaky'").get().n, 0);
  assert.equal((await staffC.get('/api/admin/settings')).data.clinicName, 'کلینیک دکتر زاهدی');
});

test('owner protections, deactivation and password resets end sessions', async () => {
  let r = await ownerC.put('/api/admin/users/1', { active: false });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'حساب مالک را نمی‌توان غیرفعال کرد');
  assert.equal((await ownerC.get('/api/admin/me')).status, 200);
  assert.equal((await ownerC.put('/api/admin/users/1', { displayName: 'دکتر زاهدی' })).status, 200, 'the owner may rename itself');
  assert.equal((await ownerC.get('/api/admin/me')).data.user.displayName, 'دکتر زاهدی');
  assert.equal((await ownerC.put('/api/admin/users/9999', { active: false })).status, 404);
  assert.equal((await ownerC.put(`/api/admin/users/${staffId}`, { displayName: '' })).status, 400);

  r = await ownerC.put(`/api/admin/users/${staffId}`, { displayName: 'زهرا احمدی', active: false });
  assert.equal(r.status, 200);
  assert.equal((await staffC.get('/api/admin/me')).status, 401, 'deactivating ends the sessions');
  assert.equal((await app.client().login('staff1', 'staff-pass-123')).status, 401, 'and stops logins');
  r = await ownerC.get('/api/admin/users');
  assert.deepEqual(r.data.users.find(u => u.id === staffId).active, false);
  assert.equal((await ownerC.put(`/api/admin/users/${staffId}`, { active: true })).status, 200);
  staffC = await loggedIn(app, 'staff1', 'staff-pass-123');
  assert.equal((await staffC.get('/api/admin/me')).data.user.displayName, 'زهرا احمدی');

  assert.equal((await ownerC.post(`/api/admin/users/${staffId}/password`, { password: 'short' })).status, 400);
  assert.equal((await ownerC.post('/api/admin/users/9999/password', { password: 'long-enough-1' })).status, 404);
  r = await ownerC.post(`/api/admin/users/${staffId}/password`, { password: 'new-staff-pass-1' });
  assert.equal(r.status, 200);
  assert.equal((await staffC.get('/api/admin/me')).status, 401);
  assert.equal((await app.client().login('staff1', 'staff-pass-123')).status, 401);
  staffC = await loggedIn(app, 'staff1', 'new-staff-pass-1');
});

test('changing your own password needs the current one and ends your other sessions', async () => {
  const second = await loggedIn(app, 'staff1', 'new-staff-pass-1');
  let r = await staffC.post('/api/admin/me/password', { current: 'wrong-pass-1', next: 'brand-new-pass-1' });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'رمز فعلی اشتباه است');
  assert.equal((await staffC.post('/api/admin/me/password', { current: 'new-staff-pass-1', next: 'short' })).status, 400);
  assert.equal((await staffC.post('/api/admin/me/password', { current: 'new-staff-pass-1', next: 'x'.repeat(201) })).status, 400);
  r = await staffC.post('/api/admin/me/password', { current: 'new-staff-pass-1', next: 'brand-new-pass-1' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { ok: true });
  assert.equal((await staffC.get('/api/admin/me')).status, 200, 'this session keeps working');
  assert.equal((await second.get('/api/admin/me')).status, 401, 'the other session ended');
  assert.equal((await app.client().login('staff1', 'new-staff-pass-1')).status, 401);
  await loggedIn(app, 'staff1', 'brand-new-pass-1');
});

test('owner downloads a full backup: code, database and restore notes', async () => {
  const r = await ownerC.get('/api/admin/backup.zip');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="chat-poshtibani-backup-1[34]\d\d-\d\d-\d\d\.zip"$/);
  const files = readZipEntries(r.data);
  const restore = files['RESTORE.txt'].toString('utf8');
  assert.match(restore, /install\.sh/);
  assert.match(restore, /~\/chat-poshtibani/);
  assert.match(restore, /Cloudflare/);
  for (const f of ['app/package.json', 'app/src/app.js', 'app/src/db.js', 'app/test/api.test.js', 'app/public/img/nana.svg', 'app/public/fonts/Vazirmatn.woff2']) {
    assert.ok(files[f], `missing ${f}`);
  }
  assert.ok(files['app/src/app.js'].equals(readFileSync(join(SOURCE_DIR, 'src/app.js'))));
  const names = Object.keys(files);
  assert.ok(!names.some(f => /^app\/(design|data|node_modules|\.git)\//.test(f) || f.endsWith('.env') || /\.sqlite$/.test(f.replace('data/chat.sqlite', ''))));
  const dir = mkdtempSync(join(tmpdir(), 'chat-restore-'));
  try {
    writeFileSync(join(dir, 'chat.sqlite'), files['data/chat.sqlite']);
    const copy = new DatabaseSync(join(dir, 'chat.sqlite'));
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'staff1'").get().n, 1);
    assert.ok(copy.prepare('SELECT COUNT(*) AS n FROM messages').get().n > 10);
    assert.equal(copy.prepare("SELECT phone FROM visitors WHERE id = ?").get(v1Id).phone, '09123456789');
    copy.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cross-site writes, non-JSON bodies and unknown paths are refused', async () => {
  let r = await ownerC.call('PUT', '/api/admin/settings', { clinicName: 'هک' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'درخواست از مبدأ نامعتبر');
  r = await app.client().call('POST', '/api/chat/start', { name: 'هکر', phone: '09120000099', operated: true }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  r = await v1.call('POST', '/api/chat/send', { text: 'سلام' }, { 'sec-fetch-site': 'cross-site' });
  assert.equal(r.status, 403);
  r = await ownerC.call('DELETE', '/api/admin/avatar', undefined, { origin: 'null' });
  assert.equal(r.status, 403);
  r = await ownerC.call('PUT', '/api/admin/visitors/1', { note: 'از همین سایت' }, { origin: app.base });
  assert.equal(r.status, 200, 'same origin is fine');

  r = await app.client().call('POST', '/api/admin/login', JSON.stringify({ username: 'owner', password: OWNER_PASS }), { 'content-type': 'text/plain' });
  assert.equal(r.status, 415);
  assert.equal(r.data.error, 'فرمت درخواست نامعتبر است');
  r = await app.client().call('POST', '/api/chat/start', 'name=x', { 'content-type': 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 415);
  const res = await fetch(`${app.base}/api/chat/start`, { method: 'POST', body: Buffer.from('{"name":"x"}') });
  assert.equal(res.status, 415, 'a body without a content type is not JSON');
  r = await ownerC.call('PUT', '/api/admin/settings', '{not json', {});
  assert.equal(r.status, 400);
  r = await ownerC.call('PUT', '/api/admin/settings', '[1,2]', {});
  assert.equal(r.status, 400);

  for (const [method, path] of [['GET', '/api/nope'], ['GET', '/api/admin'], ['POST', '/api/info'], ['GET', '/api/admin/kb/abc'], ['DELETE', '/api/admin/kb/0'], ['GET', '/api/admin/visitors/0']]) {
    r = await ownerC.call(method, path, method === 'POST' ? {} : undefined);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(r.data, { error: 'پیدا نشد' });
  }
});

test('client IP: only the configured proxy header is trusted', () => {
  const req = headers => ({ headers, socket: { remoteAddress: '172.18.0.5' } });
  const spoof = { 'cf-connecting-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' };
  assert.equal(clientIpFrom(req(spoof), false), '172.18.0.5');
  assert.equal(clientIpFrom(req(spoof), 'proxy'), '203.0.113.9', 'behind Caddy: the last X-Forwarded-For hop');
  assert.equal(clientIpFrom(req(spoof), 'cloudflare'), '6.6.6.6');
  assert.equal(clientIpFrom(req({}), 'proxy'), '172.18.0.5');
  assert.equal(clientIpFrom(req({}), 'cloudflare'), '172.18.0.5');
});

// ───────────────────────── Separate instances ─────────────────────────

test('dashboard: totals, online, Tehran calendar days, top questions and recent visitors', async t => {
  const d = await startApp();
  t.after(() => d.close());
  // 2026-10-11 20:45 UTC = 00:15 on 20 Mehr 1405 (2026-10-12) in Tehran.
  const T = Date.UTC(2026, 9, 11, 20, 45);
  const at = async (ms, fn) => {
    d.clock.fixed = ms;
    return fn();
  };
  const visitorAt = (ms, name, operated) => at(ms, () => startVisitor(d, { name, operated }));
  const vd = await visitorAt(T - 14 * DAY, 'دنیا', false); // 28 Sep: before the chart
  const vc = await visitorAt(T - 13 * DAY, 'کاوه', true); // 29 Sep: the first day of the chart
  await at(T - 13 * DAY, () => vc.post('/api/chat/send', { text: 'پرداخت قسطی دارید؟' }));
  const va = await visitorAt(Date.UTC(2026, 9, 11, 20, 29, 59, 999), 'آرش', true); // 23:59:59.999 Tehran: yesterday
  await at(Date.UTC(2026, 9, 11, 20, 29, 59, 999), async () => {
    await va.post('/api/chat/send', { text: 'ادرس' });
    await va.post('/api/chat/send', { text: 'بیمه قبول می‌کنید؟' });
  });
  const vb = await visitorAt(Date.UTC(2026, 9, 11, 20, 30), 'بهار', false); // 00:00 Tehran: today
  await at(Date.UTC(2026, 9, 11, 20, 30), () => vb.post('/api/chat/send', { text: 'بیمه قبول می‌کنید' }));
  const ve = await visitorAt(T, 'الهام', true);
  await at(T, () => ve.post('/api/chat/send', { text: 'بیمه قبول می‌کنید؟؟' }));
  assert.ok(vd);

  d.clock.fixed = T;
  const staff = await loggedIn(d, 'owner', OWNER_PASS);
  let r = await staff.get('/api/admin/dashboard');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.stats, { total: 5, online: 1, operated: 3, notOperated: 2, today: 2, unanswered: 2 });
  const { daily } = r.data;
  assert.equal(daily.length, 14);
  assert.deepEqual(daily[0], { day: '2026-09-29', label: '۷ مهر', operated: 1, notOperated: 0 });
  assert.deepEqual(daily[12], { day: '2026-10-11', label: '۱۹ مهر', operated: 1, notOperated: 0 });
  assert.deepEqual(daily[13], { day: '2026-10-12', label: '۲۰ مهر', operated: 1, notOperated: 1 });
  assert.equal(daily.reduce((s, x) => s + x.operated + x.notOperated, 0), 4, 'the 15-day-old visitor is not on the chart');
  assert.deepEqual(r.data.topQuestions, [
    { text: 'بیمه قبول می‌کنید؟؟', count: 3, unanswered: true },
    { text: 'ادرس', count: 1, unanswered: false },
    { text: 'پرداخت قسطی دارید؟', count: 1, unanswered: true },
  ]);
  assert.deepEqual(r.data.recent.map(v => v.name), ['الهام', 'بهار', 'آرش', 'کاوه', 'دنیا']);
  assert.deepEqual(r.data.recent[0], {
    id: r.data.recent[0].id, name: 'الهام', phone: r.data.recent[0].phone, operated: true, createdAt: T, lastSeen: T,
    online: true, questions: 1, lastQuestion: 'بیمه قبول می‌کنید؟؟',
  });
  assert.equal(r.data.recent[1].online, false);
  assert.equal(r.data.recent[2].questions, 2);

  // 30 seconds later nobody is online any more.
  d.clock.fixed = T + 30 * 1000 + 1;
  assert.equal((await staff.get('/api/admin/dashboard')).data.stats.online, 0);
  // The next Tehran day starts at 20:30 UTC: yesterday's visitors move one bar to the left.
  d.clock.fixed = Date.UTC(2026, 9, 12, 20, 30);
  const nextDay = await loggedIn(d, 'owner', OWNER_PASS); // a day later the old session has expired
  r = await nextDay.get('/api/admin/dashboard');
  assert.equal(r.data.stats.today, 0);
  assert.deepEqual(r.data.daily[12], { day: '2026-10-12', label: '۲۰ مهر', operated: 1, notOperated: 1 });
  assert.equal(r.data.daily[13].day, '2026-10-13');

  d.clock.fixed = T;
  const owner = await loggedIn(d, 'owner', OWNER_PASS);
  const norm = (await owner.get('/api/admin/unanswered')).data.items[0].norm;
  assert.deepEqual((await owner.post('/api/admin/unanswered/resolve', { norm })).data, { resolved: 3 });
  r = await owner.get('/api/admin/dashboard');
  assert.equal(r.data.stats.unanswered, 1);
  assert.equal(r.data.topQuestions[0].unanswered, false);
});

test('visitor list: filters, search (Arabic letters, Persian digits, +98), wildcards, paging; Excel export', async t => {
  const l = await startApp();
  t.after(() => l.close());
  const T0 = Date.now() - 10 * MINUTE;
  const people = [
    ['سارا محمدی', '09121111111', true],
    ['علی رضایی', '09122222222', false],
    ['Maryam Karimi', '09123333333', true],
    ['ناهید ۵۰%', '09124444444', false],
    ['تست_زیرخط', '09125555555', true],
  ];
  const clients = [];
  for (const [i, [name, phone, operated]] of people.entries()) {
    l.clock.fixed = T0 + i * 1000;
    clients.push(await startVisitor(l, { name, phone, operated }));
  }
  l.clock.fixed = T0 + 10 * 1000;
  await clients[0].post('/api/chat/send', { text: 'ادرس' });
  await clients[0].post('/api/chat/send', { text: 'هزینه چقدره' });
  // Now: only علی polls, so only he is online.
  l.clock.fixed = T0 + 5 * MINUTE;
  await clients[1].get('/api/chat/messages?after=0');
  const owner = await loggedIn(l, 'owner', OWNER_PASS);
  const list = async query => {
    const r = await owner.get(`/api/admin/visitors${query}`);
    assert.equal(r.status, 200, query);
    return r.data;
  };

  let r = await list('');
  assert.equal(r.total, 5);
  assert.deepEqual(r.visitors.map(v => v.name), ['علی رضایی', 'سارا محمدی', 'تست_زیرخط', 'ناهید ۵۰%', 'Maryam Karimi'], 'newest activity first');
  assert.deepEqual(r.visitors[1], {
    id: r.visitors[1].id, name: 'سارا محمدی', phone: '09121111111', operated: true, createdAt: T0, lastSeen: T0 + 10 * 1000,
    online: false, questions: 2, lastQuestion: 'هزینه چقدره',
  });
  assert.equal(r.visitors[0].online, true);
  assert.equal(r.visitors[2].lastQuestion, '');

  assert.deepEqual((await list('?filter=op')).visitors.map(v => v.phone), ['09121111111', '09125555555', '09123333333']);
  assert.deepEqual((await list('?filter=not')).visitors.map(v => v.phone), ['09122222222', '09124444444']);
  assert.deepEqual((await list('?filter=online')).visitors.map(v => v.phone), ['09122222222']);
  assert.equal((await list('?filter=bogus')).total, 5);

  const search = async q => (await list(`?q=${encodeURIComponent(q)}`)).visitors.map(v => v.phone);
  assert.deepEqual(await search('علي'), ['09122222222'], 'Arabic yeh finds ی');
  assert.deepEqual(await search('maryam'), ['09123333333'], 'case-insensitive');
  assert.deepEqual(await search('KARIMI'), ['09123333333']);
  assert.deepEqual(await search('۰۹۱۲۲۲۲'), ['09122222222'], 'Persian digits');
  assert.deepEqual(await search('+98 912 222'), ['09122222222'], '+98 form');
  assert.deepEqual(await search('4444'), ['09124444444']);
  assert.deepEqual(await search('%'), ['09124444444'], '% is a literal character');
  assert.deepEqual(await search('_'), ['09125555555'], '_ is a literal character');
  assert.deepEqual(await search('نیست'), []);
  assert.deepEqual((await list(`?filter=op&q=${encodeURIComponent('سارا')}`)).visitors.map(v => v.phone), ['09121111111']);
  assert.equal((await list(`?filter=not&q=${encodeURIComponent('سارا')}`)).total, 0);

  r = await list('?limit=2');
  assert.equal(r.total, 5);
  assert.deepEqual(r.visitors.map(v => v.name), ['علی رضایی', 'سارا محمدی']);
  r = await list('?limit=2&offset=2');
  assert.deepEqual(r.visitors.map(v => v.name), ['تست_زیرخط', 'ناهید ۵۰%']);
  r = await list('?limit=2&offset=4');
  assert.deepEqual(r.visitors.map(v => v.name), ['Maryam Karimi']);
  assert.equal((await list('?limit=0')).visitors.length, 1, 'limit is at least 1');
  assert.equal((await list('?limit=999')).visitors.length, 5, 'limit is clamped to 200');
  assert.equal((await list('?offset=-5')).visitors.length, 5);
  assert.equal((await owner.get(`/api/admin/visitors?q=${'x'.repeat(61)}`)).status, 400);

  // Excel export: operated visitors, in order of their first visit.
  r = await owner.get('/api/admin/export.xlsx?filter=op');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(l.clock.fixed);
  assert.equal(r.headers.get('content-disposition'), `attachment; filename="chat-users-op-${day}.xlsx"`);
  const files = readZipEntries(r.data);
  assert.match(files['xl/workbook.xml'].toString('utf8'), /<sheet name="کاربران"/);
  const sheet = files['xl/worksheets/sheet1.xml'].toString('utf8');
  const rows = [...sheet.matchAll(/<row r="\d+">(.*?)<\/row>/g)].map(m => [...m[1].matchAll(/<c r="[A-Z]+\d+"[^>]*>(?:<is><t[^>]*>(.*?)<\/t><\/is>|<v>(.*?)<\/v>)<\/c>/g)].map(c => c[1] ?? Number(c[2])));
  assert.deepEqual(rows[0], ['نام', 'موبایل', 'وضعیت عمل', 'اولین ورود', 'آخرین فعالیت', 'تعداد سؤال‌ها']);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.slice(1).map(x => x[0]), ['سارا محمدی', 'Maryam Karimi', 'تست_زیرخط']);
  assert.deepEqual(rows[1].slice(1, 3), ['09121111111', 'عمل‌کرده']);
  assert.match(sheet, /<c r="B2" t="inlineStr"><is><t xml:space="preserve">09121111111<\/t><\/is><\/c>/, 'the phone is a text cell, so its 0 stays');
  assert.match(rows[1][3], /^14\d\d\/\d\d\/\d\d \d\d:\d\d$/);
  assert.equal(rows[1][5], 2);
  assert.equal(rows[2][5], 0);

  r = await owner.get('/api/admin/export.xlsx?filter=not');
  assert.match(r.headers.get('content-disposition'), /chat-users-not-/);
  const notRows = readZipEntries(r.data)['xl/worksheets/sheet1.xml'].toString('utf8');
  assert.match(notRows, /عمل‌نکرده/);
  assert.doesNotMatch(notRows, /سارا/);
  r = await owner.get('/api/admin/export.xlsx');
  assert.match(r.headers.get('content-disposition'), /chat-users-all-/);
  assert.equal((readZipEntries(r.data)['xl/worksheets/sheet1.xml'].toString('utf8').match(/<row /g) || []).length, 6);
});

test('rate limits: 10 starts per address in 10 minutes, 20 messages per visitor in a minute', async t => {
  const rl = await startApp();
  t.after(() => rl.close());
  const ip = '203.0.113.7';
  const c = rl.client({ ip });
  const start = phone => c.post('/api/chat/start', { name: 'آزمون', phone, operated: false });
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await start(`0936000000${i}`)).status, 200, `start ${i}`);
    assert.equal((await start('12345')).status, 400, 'invalid forms do not use up the limit');
  }
  let r = await start('09360000010');
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'چند دقیقه دیگه دوباره امتحان کن');
  assert.equal((await rl.client().post('/api/chat/start', { name: 'دیگری', phone: '09360000011', operated: true })).status, 200, 'other addresses are not affected');
  rl.clock.offset = 10 * MINUTE + 1000;
  assert.equal((await start('09360000010')).status, 200, 'allowed again after 10 minutes');

  const v = await startVisitor(rl);
  const other = await startVisitor(rl);
  for (let i = 0; i < 20; i += 1) assert.equal((await v.post('/api/chat/send', { text: `سؤال ${i}` })).status, 200, `message ${i}`);
  r = await v.post('/api/chat/send', { text: 'یکی دیگه' });
  assert.equal(r.status, 429);
  assert.equal(r.data.error, 'یه کم آروم‌تر عزیزم؛ چند لحظه دیگه بفرست');
  assert.equal((await other.post('/api/chat/send', { text: 'سلام' })).status, 200, 'other visitors are not affected');
  assert.equal((await v.get('/api/chat/messages?after=0')).status, 200, 'polling is not limited');
  rl.clock.offset += 61 * 1000;
  assert.equal((await v.post('/api/chat/send', { text: 'یکی دیگه' })).status, 200);
});

test('with secure cookies: Secure flags and HSTS', async t => {
  const s = await startApp({ secureCookies: true });
  t.after(() => s.close());
  const c = s.client();
  let r = await c.post('/api/chat/start', { name: 'سارا', phone: '09121234567', operated: true });
  assert.match(r.headers.get('set-cookie'), /; Secure/);
  assert.equal(r.headers.get('strict-transport-security'), 'max-age=31536000');
  r = await c.login('owner', OWNER_PASS);
  assert.match(r.headers.get('set-cookie'), /^chat_admin=.*; SameSite=Strict; Max-Age=604800; Secure$/);
});

test('admin sessions expire after 12 idle hours', async t => {
  const s = await startApp();
  t.after(() => s.close());
  const owner = await loggedIn(s, 'owner', OWNER_PASS);
  s.clock.offset = 11 * 60 * MINUTE;
  assert.equal((await owner.get('/api/admin/me')).status, 200, 'activity keeps the session alive');
  s.clock.offset += 11 * 60 * MINUTE;
  assert.equal((await owner.get('/api/admin/me')).status, 200);
  s.clock.offset += 12 * 60 * MINUTE + 1000;
  assert.equal((await owner.get('/api/admin/me')).status, 401);
});
