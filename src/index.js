import { createServer } from 'node:http';
import fs from 'node:fs';
import { openDb, backup, setSetting } from './db.js';
import { createApp } from './app.js';
import { USERNAME_PATTERN, createUser, pruneSessions, validatePassword } from './auth.js';

const env = process.env;
const dataDir = env.DATA_DIR || './data';
const port = Number(env.PORT || 3000);
const host = env.HOST || '0.0.0.0';

fs.mkdirSync(dataDir, { recursive: true });
const db = openDb(`${dataDir}/chat.sqlite`);

// First start: create the owner account from OWNER_USERNAME / OWNER_PASSWORD.
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const username = (env.OWNER_USERNAME || '').trim().toLowerCase();
  const password = env.OWNER_PASSWORD || '';
  const problem = validatePassword(password);
  if (!USERNAME_PATTERN.test(username) || problem) {
    console.error('First start: set OWNER_USERNAME (3+ latin chars) and OWNER_PASSWORD (8+ chars) in .env.', problem || '');
    process.exit(1);
  }
  createUser(db, { username, password, displayName: env.OWNER_DISPLAY_NAME || 'مالک', role: 'owner' });
  console.log(`Owner account "${username}" created.`);
}

// The address shown in the admin panel ("link of the chat page"), e.g. https://chat.enetvip.com.
const publicUrl = (env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
if (publicUrl) {
  if (/^https?:\/\/[^\s/]+$/i.test(publicUrl)) setSetting(db, 'public_url', publicUrl);
  else console.error(`PUBLIC_URL "${publicUrl}" is not like https://chat.example.com; ignored.`);
}

const app = createApp({
  db,
  secureCookies: env.COOKIE_SECURE !== 'false',
  // 'proxy' behind Caddy, 'cloudflare' behind the Cloudflare tunnel ('true' is the older spelling of it).
  trustProxy: new Map([['proxy', 'proxy'], ['cloudflare', 'cloudflare'], ['true', 'cloudflare']]).get(env.TRUST_PROXY) || false,
  sourceDir: env.SOURCE_DIR || undefined,
});

const server = createServer(app);
server.headersTimeout = 20000;
server.requestTimeout = 30000;
server.listen(port, host, () => console.log(`Chat listening on http://${host}:${port}`));

const backupDir = `${dataDir}/backups`;
const keep = Number(env.BACKUP_KEEP || 30);
const runBackup = () => {
  try {
    console.log('Backup written:', backup(db, backupDir, keep, fs));
  } catch (err) {
    console.error('Backup failed:', err);
  }
};
const runPrune = () => {
  try {
    const removed = pruneSessions(db);
    if (removed.staff || removed.visitors) console.log('Expired sessions removed:', removed);
  } catch (err) {
    console.error('Session cleanup failed:', err);
  }
};
runPrune();
setTimeout(runBackup, 60 * 1000);
setInterval(() => {
  runBackup();
  runPrune();
}, 24 * 60 * 60 * 1000);

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Polling clients keep connections alive; stop waiting for them after a moment.
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
