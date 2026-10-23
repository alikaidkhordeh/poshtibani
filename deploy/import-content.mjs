// Loads the clinic's prepared content (content/clinic.json) into the chat database: knowledge base topics
// (updated by title, added when new, renamed old ones removed; other topics written in the panel are kept), quick replies, contact links
// and a few settings. Safe to run again. Inside the running container:
//   docker exec chat-poshtibani node --disable-warning=ExperimentalWarning /app/source/deploy/import-content.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { contactError } from '../src/contacts.js';

const file = process.argv[2] || fileURLToPath(new URL('../content/clinic.json', import.meta.url));
const data = JSON.parse(readFileSync(file, 'utf8'));
const db = openDb(`${process.env.DATA_DIR || '/data'}/chat.sqlite`);
const now = Date.now();

for (const c of data.contacts || []) {
  const problem = contactError(c.id, c.value);
  if (problem) throw new Error(`${c.id}: ${problem}`);
}

let added = 0;
let removed = 0;
let updated = 0;
db.exec('BEGIN IMMEDIATE');
try {
  for (const title of data.removeTitles || []) removed += Number(db.prepare('DELETE FROM kb WHERE title = ?').run(title).changes);
  for (const e of data.kb || []) {
    const row = db.prepare('SELECT id FROM kb WHERE title = ?').get(e.title);
    if (row) {
      db.prepare('UPDATE kb SET category = ?, keywords = ?, answer = ?, updated_at = ? WHERE id = ?').run(e.category, e.keywords, e.answer, now, row.id);
      updated += 1;
    } else {
      db.prepare('INSERT INTO kb (category, title, keywords, answer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(e.category, e.title, e.keywords, e.answer, now, now);
      added += 1;
    }
  }
  for (const audience of ['op', 'not']) {
    const list = data.quickReplies?.[audience];
    if (!list) continue;
    db.prepare('DELETE FROM quick_replies WHERE audience = ?').run(audience);
    list.forEach((text, i) => db.prepare('INSERT INTO quick_replies (audience, text, enabled, sort) VALUES (?, ?, 1, ?)').run(audience, text, i));
  }
  for (const c of data.contacts || []) {
    db.prepare('UPDATE contacts SET enabled = ?, value = ? WHERE id = ?').run(c.enabled ? 1 : 0, c.value, c.id);
  }
  for (const [key, value] of Object.entries(data.settings || {})) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
db.close();
console.log(`Done: ${added} topics added, ${updated} updated, ${removed} old ones replaced; quick replies, contacts and settings saved.`);
