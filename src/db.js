import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

// Times are INTEGER milliseconds (Date.now()) in every table.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS visitors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  operated INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visitors_last_seen ON visitors(last_seen);
CREATE INDEX IF NOT EXISTS visitors_created_at ON visitors(created_at);
CREATE TABLE IF NOT EXISTS visitor_sessions (
  token_hash TEXT PRIMARY KEY,
  visitor_id INTEGER NOT NULL REFERENCES visitors(id),
  since_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  visitor_id INTEGER NOT NULL REFERENCES visitors(id),
  sender TEXT NOT NULL CHECK (sender IN ('visitor', 'bot', 'staff')),
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question', 'kb', 'talk', 'none', 'staff')),
  kb_id INTEGER,
  contacts INTEGER NOT NULL DEFAULT 0,
  unanswered INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  norm TEXT NOT NULL DEFAULT '',
  staff_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_visitor ON messages(visitor_id, id);
CREATE INDEX IF NOT EXISTS messages_unanswered ON messages(unanswered, resolved);
CREATE TABLE IF NOT EXISTS kb (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quick_replies (
  id INTEGER PRIMARY KEY,
  audience TEXT NOT NULL CHECK (audience IN ('op', 'not')),
  text TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY CHECK (id IN ('phone', 'whatsapp', 'instagram', 'rubika', 'telegram', 'site')),
  enabled INTEGER NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  clinic_name: 'کلینیک دکتر زاهدی',
  assistant_name: 'ننه پت',
  welcome: 'سلام {نام} جان، خوش اومدی 🌸\nمن ننه پت‌ام، دستیار کلینیک دکتر زاهدی. هر سؤالی درباره‌ی عمل، مراقبت‌ها، آدرس یا نوبت داری بپرس.',
  not_found: 'از این موضوع بی‌خبرم عزیزم 🌸 می‌تونی سؤال دیگه‌ای بپرسی، یا از این راه‌ها با پشتیبانی کلینیک در تماس باشی:',
  phrases: 'قربونت برم،\nالهی بگردم،\nعزیز دلم،',
  // Kept for a possible AI assistant later; the word-matching engine does not use it.
  persona: 'شما ننه پت هستید، دستیار دلسوز و مهربان کلینیک زیبایی دکتر زاهدی.\nبا لحن یک مادربزرگ مهربون و خودمونی جواب بده و از ایموجی مناسب استفاده کن.\nفقط از اطلاعات بخش ۲ جواب بده و هیچ چیزی از خودت نگو.',
  avatar_version: '0',
  public_url: '',
};

// Both entries come from the clinic's previous panel. No medical advice is ever seeded.
const SEED_KB = [
  { category: 'اطلاعات مطب', title: 'آدرس مطب', keywords: 'آدرس، کجاست، نشانی، لوکیشن', answer: 'مطب دکتر در اهواز است.' },
  { category: 'هزینه و نوبت', title: 'قیمت عمل بینی', keywords: 'قیمت، هزینه، تعرفه', answer: 'قیمت عمل بینی ۶۰ میلیون است.' },
];
const SEED_QUICK_REPLIES = {
  op: ['آدرس مطب', 'تماس با پشتیبانی'],
  not: ['قیمت عمل بینی', 'آدرس مطب', 'تماس با پشتیبانی'],
};
const SEED_CONTACTS = [
  ['phone', 1, ''], ['whatsapp', 0, ''], ['instagram', 1, 'dr.zahedi'], ['rubika', 1, ''], ['telegram', 0, ''], ['site', 0, ''],
];

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

const isEmpty = (db, table) => !db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();

function seed(db, now = Date.now()) {
  transaction(db, () => {
    const setting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) setting.run(key, value);
    if (isEmpty(db, 'kb')) {
      const insert = db.prepare('INSERT INTO kb (category, title, keywords, answer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const e of SEED_KB) insert.run(e.category, e.title, e.keywords, e.answer, now, now);
    }
    if (isEmpty(db, 'quick_replies')) {
      const insert = db.prepare('INSERT INTO quick_replies (audience, text, enabled, sort) VALUES (?, ?, 1, ?)');
      for (const [audience, texts] of Object.entries(SEED_QUICK_REPLIES)) texts.forEach((text, i) => insert.run(audience, text, i));
    }
    if (isEmpty(db, 'contacts')) {
      const insert = db.prepare('INSERT INTO contacts (id, enabled, value, sort) VALUES (?, ?, ?, ?)');
      SEED_CONTACTS.forEach(([id, enabled, value], i) => insert.run(id, enabled, value, i));
    }
  });
}

// Runs fn inside BEGIN IMMEDIATE so reads and the writes that depend on them cannot interleave.
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? DEFAULT_SETTINGS[key] ?? '';
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Consistent online backup into backupDir; keeps the newest `keep` files written by this function.
export function backup(db, backupDir, keep, fs) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${backupDir}/chat-${stamp}-${randomBytes(3).toString('hex')}.sqlite`;
  db.prepare('VACUUM INTO ?').run(file);
  const old = fs.readdirSync(backupDir).filter(f => /^chat-.*\.sqlite$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.unlinkSync(`${backupDir}/${f}`);
  return file;
}
