// The panel's current usernames and passwords, kept in data/login-info.txt (readable only by the server's
// owner) so a forgotten password can be looked up on the server:  cat ~/chat-poshtibani/data/login-info.txt
// It is rewritten whenever a password is set: first start, a change in the panel, a new account, a reset.
import fs from 'node:fs';

const HEADER = [
  'نام کاربری و رمز فعلی حساب‌های پنل مدیریت چت',
  'هر بار رمزی در پنل عوض شود، این فایل خودش به‌روز می‌شود. این فایل را برای کسی نفرستید.',
  '',
];

export function loginFilePath(dataDir) {
  return `${dataDir}/login-info.txt`;
}

function readEntries(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(line => line.includes(' | ')).map(line => {
    const [username, password, role, updated] = line.split(' | ').map(x => x.replace(/^[^:]*:\s*/, '').trim());
    return { username, password, role, updated };
  });
}

export function saveLogin(dataDir, { username, password, role }, now = new Date()) {
  const file = loginFilePath(dataDir);
  const entries = readEntries(file).filter(e => e.username !== username);
  entries.push({ username, password, role: role === 'owner' ? 'مالک' : 'پشتیبان', updated: now.toISOString().slice(0, 16).replace('T', ' ') });
  entries.sort((a, b) => (a.role === 'مالک' ? -1 : 0) - (b.role === 'مالک' ? -1 : 0));
  const lines = entries.map(e => `نام کاربری: ${e.username} | رمز: ${e.password} | دسترسی: ${e.role} | آخرین تغییر (UTC): ${e.updated}`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${[...HEADER, ...lines].join('\n')}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
