import { createServer } from 'node:http';
import fs from 'node:fs';
import { openDb, backup, setSetting } from './db.js';
import { createApp } from './app.js';
import { USERNAME_PATTERN, createUser, pruneSessions, validatePassword, verifyPassword } from './auth.js';
import { loginFilePath, saveLogin } from './login-file.js';

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

// data/login-info.txt keeps the current passwords for the server's owner. When it does not exist yet (first
// start, or an install from before it existed), the owner's password from .env is written to it, but only if
// it is still the password in use; a password changed earlier in the panel is unknown until it is set again.
if (!fs.existsSync(loginFilePath(dataDir))) {
  const owner = db.prepare("SELECT username, password_hash FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get();
  if (owner && env.OWNER_PASSWORD && verifyPassword(env.OWNER_PASSWORD, owner.password_hash)) {
    try {
      saveLogin(dataDir, { username: owner.username, password: env.OWNER_PASSWORD, role: 'owner' });
    } catch (err) {
      console.error('Could not write the login file:', err);
    }
  }
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
  onPasswordSet: login => saveLogin(dataDir, login),
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
