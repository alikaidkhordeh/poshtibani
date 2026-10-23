// Gives the owner account (or the account named on the command line) a new random password, ends its
// sessions, and writes it to data/login-info.txt. Inside the running container:
//   docker exec chat-poshtibani node --disable-warning=ExperimentalWarning /app/source/deploy/reset-password.mjs
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { hashPassword, destroyUserSessions } from '../src/auth.js';
import { saveLogin, loginFilePath } from '../src/login-file.js';

const dataDir = process.env.DATA_DIR || '/data';
const db = openDb(`${dataDir}/chat.sqlite`);
const name = (process.argv[2] || '').trim().toLowerCase();
const user = name
  ? db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(name)
  : db.prepare("SELECT id, username, role FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get();
if (!user) {
  console.error(`No account named "${name}".`);
  process.exit(1);
}
const password = randomBytes(9).toString('base64url');
db.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?').run(hashPassword(password), user.id);
destroyUserSessions(db, user.id);
saveLogin(dataDir, { username: user.username, password, role: user.role });
db.close();
console.log(`New password for "${user.username}": ${password}`);
console.log(`Saved in ${loginFilePath(dataDir).replace(/^\/data/, '~/chat-poshtibani/data')}`);
