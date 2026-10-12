// Admin panel of the clinic's support chat (the approved "design 2"). Everything shown comes from /api/admin/*.
// CSP: no inline styles and no innerHTML. Elements are built with h(); styles go through classes or el.style.

// ───────── Small helpers ─────────
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const fa = v => String(v).replace(/[0-9]/g, d => FA_DIGITS[d]);
const $ = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const PAGE_SIZE = 50;
let uid = 0;

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

// replaceChildren() that skips empty slots (null, false), like h() does.
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false));

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// Icons are <symbol>s in index.html.
function icon(id) {
  const svg = svgEl('svg', { class: 'ic', 'aria-hidden': 'true', focusable: 'false' });
  svg.append(svgEl('use', { href: `#${id}` }));
  return svg;
}

const btn = (label, onClick, kind = '', ic = null, props = {}) =>
  h('button', { type: 'button', class: `btn ${kind}`.trim(), onClick, ...props }, ic ? icon(ic) : null, label);
const iconBtn = (ic, label, onClick, props = {}) =>
  h('button', { type: 'button', class: 'btn icon', 'aria-label': label, title: label, onClick, ...props }, icon(ic));
const linkBtn = (label, href, kind = '', ic = null, props = {}) =>
  h('a', { class: `btn ${kind}`.trim(), href, ...props }, ic ? icon(ic) : null, label);

function field(label, input, hint) {
  input.id ||= `f${++uid}`;
  const hintEl = hint ? h('span', { class: 'f-hint', id: `${input.id}-hint`, text: hint }) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  return h('div', { class: 'field' }, h('label', { class: 'f-label', for: input.id, text: label }), input, hintEl);
}

function toggle(on, onChange, label) {
  const b = h('button', { type: 'button', class: 'tog', role: 'switch', 'aria-checked': String(Boolean(on)), 'aria-label': label }, h('i'));
  b.addEventListener('click', () => {
    const value = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(value));
    onChange(value, b);
  });
  return b;
}

const card = ({ title, sub, extra, cls = '' } = {}, ...body) => h('section', { class: `card ${cls}`.trim() },
  title ? h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: title }), sub ? h('p', { class: 'card-sub', text: sub }) : null), extra) : null,
  ...body);

// A row of toggle buttons; only one is pressed.
function seg(items, current, onPick, label) {
  const box = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const draw = cur => box.replaceChildren(...items.map(([key, text]) => h('button', {
    type: 'button', 'aria-pressed': String(cur === key), onClick: () => { draw(key); onPick(key); },
  }, text)));
  draw(current);
  return box;
}

const formError = () => h('div', { class: 'form-error', role: 'alert', hidden: true });
function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
  el.scrollIntoView({ block: 'nearest' });
}

const opPill = operated => h('span', { class: `pill ${operated ? 'op' : 'not'}`, text: operated ? 'عمل‌کرده' : 'عمل‌نکرده' });
const onlinePill = () => h('span', { class: 'pill on' }, h('i', { class: 'dot' }), 'آنلاین');
const initial = name => Array.from(String(name).trim())[0] || '؟';
const ini = v => h('span', { class: 'ini', 'aria-hidden': 'true' }, initial(v.name), v.online ? h('i', { class: 'dot' }) : null);
const avatarImg = src => h('img', { class: 'av', src, alt: '' });
const firstName = name => String(name).trim().split(/\s+/)[0] || name;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Same folding as the server's normalize(), for searching the knowledge base on the page.
const normalize = s => String(s)
  .replace(/[۰-۹]/g, d => FA_DIGITS.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
  .toLowerCase().replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[آأإ]/g, 'ا').replace(/ة/g, 'ه')
  .replace(/[ً-ٰٟـ]/g, '').replace(/[‌-‏]/g, ' ')
  .replace(/\s+/g, ' ').trim();
const splitKeywords = s => String(s).split(/[,،;؛\n]/).map(k => k.trim()).filter(Boolean);

// ───────── Time (the clinic's calendar is Tehran's) ─────────
const TZ = 'Asia/Tehran';
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, day: 'numeric', month: 'long' });
const fullDayFmt = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
const dayNumber = ms => {
  const [y, m, d] = dayKeyFmt.format(ms).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};
const clock = ms => fa(clockFmt.format(ms));

function relTime(ms, now = Date.now()) {
  if (!ms) return '—';
  const diff = now - ms;
  if (diff < 60000) return 'همین الان';
  if (diff < 3600000) return `${fa(Math.floor(diff / 60000))} دقیقه پیش`;
  const days = dayNumber(now) - dayNumber(ms);
  if (days <= 0) return `امروز ${clock(ms)}`;
  if (days === 1) return `دیروز ${clock(ms)}`;
  if (days < 30) return `${fa(days)} روز پیش`;
  return fullDayFmt.format(ms);
}

function dayTitle(ms, now = Date.now()) {
  const days = dayNumber(now) - dayNumber(ms);
  if (days <= 0) return 'امروز';
  if (days === 1) return 'دیروز';
  return days < 300 ? dayFmt.format(ms) : fullDayFmt.format(ms);
}

// ───────── Toast, modal ─────────
let toastTimer = 0;
function toast(message, kind = '') {
  const t = $('toast');
  t.textContent = message;
  t.className = `toast ${kind}`.trim();
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 4500 : 2800);
}
function fail(err) {
  if (!(err instanceof ApiError)) console.error(err);
  if (err?.status !== 401) toast(err?.message || 'خطایی رخ داد؛ دوباره تلاش کنید', 'error');
}

let modal = null; // { dirty, restore, onClose }
let drawer = null;

// While a modal or the preview is open, the page behind it can not be reached with Tab or a screen reader.
function syncInert() {
  const drawerOpen = Boolean(drawer && !drawer.el.hidden);
  $('app').inert = Boolean(modal) || drawerOpen;
  if (drawer) drawer.el.inert = Boolean(modal);
}

function openModal({ title, body, actions = [], narrow = false, onClose }) {
  closeModal(true);
  const box = $('modal');
  const titleId = `m${++uid}`;
  const closeBtn = iconBtn('i-x', 'بستن', () => closeModal());
  const cardEl = h('div', { class: `modal-card${narrow ? ' narrow' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal-head' }, h('h2', { id: titleId, text: title }), closeBtn),
    body,
    actions.length ? h('div', { class: 'row end' }, actions) : null);
  modal = { dirty: false, restore: document.activeElement, onClose };
  const state = modal;
  // Typed text in a modal is never thrown away by a stray click outside it or by Escape.
  cardEl.addEventListener('input', () => { state.dirty = true; });
  box.replaceChildren(cardEl);
  box.hidden = false;
  syncInert();
  const first = cardEl.querySelector('input:not([type="hidden"]):not([readonly]):not([hidden]), textarea:not([readonly]), select');
  (first || actions[actions.length - 1] || closeBtn).focus();
  return { close: () => closeModal(), card: cardEl };
}

function closeModal(silent = false) {
  if (!modal) return;
  const state = modal;
  modal = null;
  $('modal').hidden = true;
  $('modal').replaceChildren();
  syncInert();
  if (!silent && state.restore?.isConnected) state.restore.focus();
  state.onClose?.();
}

let downOnBackdrop = false;
$('modal').addEventListener('pointerdown', e => { downOnBackdrop = e.target === e.currentTarget; });
$('modal').addEventListener('click', e => {
  if (e.target === e.currentTarget && downOnBackdrop && modal && !modal.dirty) closeModal();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (modal) {
    if (!modal.dirty) closeModal();
  } else if (drawer && !drawer.el.hidden) {
    closePreview();
  }
});

function confirmModal({ title, message, ok, cancel = 'انصراف', danger = false }) {
  return new Promise(resolve => {
    let answer = false;
    const okBtn = btn(ok, () => { answer = true; closeModal(); }, danger ? 'danger solid' : 'primary');
    const cancelBtn = btn(cancel, () => closeModal());
    openModal({ title, body: h('p', { class: 'modal-text', text: message }), actions: [cancelBtn, okBtn], narrow: true, onClose: () => resolve(answer) });
    cancelBtn.focus();
  });
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
  } catch {
    // No clipboard access (an old browser or plain http): show the text so it can be copied by hand.
    toast(text);
  }
}

// ───────── API ─────────
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  // POST and PUT always carry a JSON body, even when there is nothing to say (logout).
  if (body === undefined && (method === 'POST' || method === 'PUT')) body = {};
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError('ارتباط با سرور برقرار نشد؛ اینترنت را بررسی کنید', 0);
  }
  let data = {};
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (res.status === 401 && path !== '/api/admin/login') {
    signedOut(data.error);
    throw new ApiError(data.error || 'لطفاً دوباره وارد شوید', 401);
  }
  if (!res.ok) throw new ApiError(data.error || 'خطایی رخ داد؛ دوباره تلاش کنید', res.status);
  return data;
}

// Files come as attachments from the server. The session is checked first, so an expired session
// shows the login screen instead of saving an error message as the file.
async function download(url) {
  try {
    await api('GET', '/api/admin/me');
  } catch (err) {
    fail(err);
    return;
  }
  const a = h('a', { href: url, download: '', hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  toast('دانلود شروع شد');
}

// ───────── Polling: runs only while the tab is visible ─────────
const polls = new Set();
function poll(ms, fn, scope = 'page') {
  const p = { ms, fn, scope, last: Date.now(), busy: false };
  polls.add(p);
  return p;
}
async function runPoll(p) {
  if (p.busy) return;
  p.busy = true;
  p.last = Date.now();
  try {
    await p.fn();
  } catch {
    // A missed background refresh is not worth a message; the next one tries again.
  } finally {
    p.busy = false;
  }
}
function tick() {
  if (document.visibilityState !== 'visible') return;
  const t = Date.now();
  for (const p of polls) if (t - p.last >= p.ms) runPoll(p);
}
const stopPolls = scope => { for (const p of polls) if (!scope || p.scope === scope) polls.delete(p); };
setInterval(tick, 1000);
document.addEventListener('visibilitychange', tick);

// ───────── State ─────────
const state = {
  user: null, // { id, username, displayName, role }
  me: null, // { clinicName, assistantName, avatarUrl, publicUrl }
  stats: null,
  chats: { filter: 'all', q: '', want: PAGE_SIZE },
  dbTab: 'persona',
  kbQ: '',
  kbCat: 'all',
};
const isOwner = () => state.user?.role === 'owner';
const ROLE_SHORT = { owner: 'مالک', staff: 'پشتیبان' };
const ROLE_LONG = { owner: 'مالک (همه‌ی بخش‌ها)', staff: 'پشتیبان (گفتگوها)' };
const chatUrl = () => (state.me?.publicUrl || location.origin).replace(/\/+$/, '');

// The login screen shows the clinic's name and picture from the last visit (only a convenience).
const BRAND_KEY = 'chat-admin-brand';
function rememberBrand() {
  try {
    localStorage.setItem(BRAND_KEY, JSON.stringify({ clinicName: state.me.clinicName, avatarUrl: state.me.avatarUrl }));
  } catch { /* storage blocked */ }
}
function rememberedBrand() {
  try {
    const b = JSON.parse(localStorage.getItem(BRAND_KEY) || 'null');
    if (b && typeof b.clinicName === 'string' && typeof b.avatarUrl === 'string' && b.avatarUrl.startsWith('/api/chat/avatar')) return b;
  } catch { /* storage blocked or bad data */ }
  return null;
}

// ───────── Login ─────────
function renderLogin(message = '') {
  stopPolls();
  closeModal(true);
  if (drawer) drawer.el.hidden = true;
  syncInert();
  pageCtx = null;
  current = null;
  shell.main = null;
  state.user = null;
  state.stats = null;
  document.title = 'ورود به پنل مدیریت';
  const brand = rememberedBrand();
  const username = h('input', { class: 'inp ltr', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: '60' });
  const password = h('input', { class: 'inp ltr', name: 'password', type: 'password', autocomplete: 'current-password', maxlength: '200' });
  const error = formError();
  const submit = h('button', { type: 'submit', class: 'btn primary wide', text: 'ورود' });
  const form = h('form', { class: 'login-card', novalidate: true },
    h('span', { class: 'logo big' }, avatarImg(brand?.avatarUrl || '/api/chat/avatar')),
    h('h1', { text: 'ورود به پنل مدیریت' }),
    h('p', { text: brand?.clinicName || 'چت پشتیبانی آنلاین' }),
    field('نام کاربری', username),
    field('رمز عبور', password),
    error,
    submit,
    h('p', { class: 'login-note', text: 'بعد از چند بار رمز اشتباه، ورود برای ۱۵ دقیقه بسته می‌شود.' }));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    error.hidden = true;
    if (!username.value.trim() || !password.value) {
      showError(error, 'نام کاربری و رمز عبور را بنویسید');
      (username.value.trim() ? password : username).focus();
      return;
    }
    submit.disabled = true;
    try {
      const { user } = await api('POST', '/api/admin/login', { username: username.value.trim(), password: password.value });
      state.user = user;
      await enter();
    } catch (err) {
      if (!$('app').contains(form)) return;
      showError(error, err.message);
      password.select();
    } finally {
      submit.disabled = false;
    }
  });
  $('app').replaceChildren(h('main', { class: 'login' }, form));
  if (message) showError(error, message);
  username.focus();
}

// Any 401: back to the login screen. A login screen already on display is left alone, so its typed text stays.
function signedOut(message) {
  if (!state.user && $('app').querySelector('.login')) return;
  renderLogin(state.user ? (message || 'لطفاً دوباره وارد شوید') : '');
}

async function logout() {
  if (pageDirty() && !(await confirmLeave())) return;
  try {
    await api('POST', '/api/admin/logout');
  } catch (err) {
    if (err.status !== 401) {
      fail(err);
      return;
    }
  }
  renderLogin();
}

// ───────── Shell ─────────
const PAGES = {
  dash: { label: 'داشبورد', icon: 'i-grid', desc: 'خلاصه‌ی وضعیت چت‌بات', render: renderDash },
  chats: { label: 'گفتگوها', icon: 'i-chat', desc: 'کاربرها و گفتگوهایشان؛ از همین‌جا می‌توانید خودتان جواب بدهید', render: renderChats },
  unanswered: { label: 'سؤال‌های بی‌جواب', icon: 'i-help', desc: 'سؤال‌هایی که ربات جوابشان را در دیتابیس پیدا نکرد', render: renderUnanswered },
  db: { label: 'دیتابیس ربات', icon: 'i-db', desc: 'بخش ۱ شخصیت ربات است و بخش ۲ اطلاعات کلینیک', render: renderDb, sep: true },
  quick: { label: 'پیام‌های آماده', icon: 'i-bolt', desc: 'دکمه‌های آماده‌ی پایین صفحه‌ی چت', render: renderQuick, owner: true },
  contacts: { label: 'راه‌های ارتباطی', icon: 'i-link', desc: 'تلفن، واتس‌اپ، اینستاگرام، روبیکا و…', render: renderContacts, owner: true },
  brand: { label: 'ظاهر و برند', icon: 'i-user', desc: 'اسم‌ها، عکس پروفایل و لینک صفحه‌ی چت', render: renderBrand, owner: true },
  security: {
    label: 'مدیران و امنیت', icon: 'i-lock', render: renderSecurity,
    desc: () => (isOwner() ? 'رمز عبور، حساب‌های پنل و پشتیبان‌گیری' : 'تغییر رمز عبور حساب شما'),
  },
};
const pageAllowed = key => Object.hasOwn(PAGES, key) && (!PAGES[key].owner || isOwner());

const shell = { main: null };

async function enter() {
  const me = await api('GET', '/api/admin/me');
  state.user = me.user;
  state.me = { clinicName: me.clinicName, assistantName: me.assistantName, avatarUrl: me.avatarUrl, publicUrl: me.publicUrl || '' };
  rememberBrand();
  renderShell();
  shellPoll = poll(30000, refreshStats, 'shell');
  refreshStats().catch(() => {});
  onRoute();
}

function renderShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'بخش‌های پنل' });
  shell.links = {};
  for (const [key, p] of Object.entries(PAGES)) {
    if (!pageAllowed(key)) continue;
    if (p.sep) nav.append(h('div', { class: 'nav-sep', role: 'separator' }));
    let badge = null;
    if (key === 'chats') badge = shell.badgeChats = h('em', { class: 'on', hidden: true, title: 'آنلاین' });
    if (key === 'unanswered') badge = shell.badgeUna = h('em', { class: 'warn', hidden: true, title: 'بی‌جواب' });
    shell.links[key] = h('a', { href: `#/${key}` }, icon(p.icon), h('span', { text: p.label }), badge);
    nav.append(shell.links[key]);
  }
  shell.brandImg = avatarImg(state.me.avatarUrl);
  shell.brandName = h('b');
  shell.brandClinic = h('small');
  shell.title = h('h1');
  shell.desc = h('p');
  shell.online = h('span', { class: 'pill on', hidden: true });
  shell.main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const out = () => logout();
  $('app').replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'side' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, shell.brandImg), h('div', {}, shell.brandName, shell.brandClinic),
        iconBtn('i-out', 'خروج از حساب', out, { class: 'btn icon danger mobile-out' })),
      nav,
      h('div', { class: 'side-foot' },
        h('span', {}, state.user.displayName,
          state.user.displayName !== ROLE_SHORT[state.user.role] ? h('small', { text: ROLE_SHORT[state.user.role] || '' }) : null),
        btn('خروج', out, 'danger', 'i-out'))),
    h('div', { class: 'content' },
      h('header', { class: 'pagebar' },
        h('div', { class: 'grow' }, shell.title, shell.desc),
        shell.online,
        btn('پیش‌نمایش چت', openPreview, 'soft', 'i-eye')),
      shell.main)));
  updateBrand();
  updateBadges();
}

function updateBrand() {
  if (!shell.main) return;
  shell.brandImg.src = state.me.avatarUrl;
  shell.brandName.textContent = state.me.assistantName;
  shell.brandClinic.textContent = state.me.clinicName;
  if (current) document.title = `${PAGES[current.page].label} | ${state.me.clinicName}`;
}

function updateBadges() {
  const s = state.stats;
  if (!s || !shell.main) return;
  shell.badgeChats.textContent = fa(s.online);
  shell.badgeChats.hidden = !s.online;
  shell.badgeUna.textContent = fa(s.unanswered);
  shell.badgeUna.hidden = !s.unanswered;
  fill(shell.online, s.online ? h('i', { class: 'dot' }) : null, `${fa(s.online)} نفر آنلاین`);
  shell.online.className = `pill ${s.online ? 'on' : 'mute'}`;
  shell.online.hidden = false;
}

// The dashboard numbers also feed the menu badges, so they are refreshed on every page.
let shellPoll = null;
async function refreshStats() {
  if (shellPoll) shellPoll.last = Date.now();
  const data = await api('GET', '/api/admin/dashboard');
  state.stats = data.stats;
  updateBadges();
  pageCtx?.onStats?.(data);
  return data;
}

// ───────── Routing: #/page or #/page/arg ─────────
let current = null; // { page, arg }
let pageCtx = null; // per page: { onArg, onStats, onLeave, dirty }
const alive = ctx => ctx === pageCtx;
const pageDirty = () => Boolean(pageCtx?.dirty?.());
const hashOf = r => `#/${r.page}${r.arg ? `/${r.arg}` : ''}`;
const confirmLeave = () => confirmModal({
  title: 'تغییرها ذخیره نشده‌اند',
  message: 'تغییرهای این صفحه هنوز ذخیره نشده‌اند. اگر بروید، از بین می‌روند.',
  ok: 'رفتن بدون ذخیره',
  cancel: 'ماندن',
  danger: true,
});

function parseHash() {
  const [page = '', arg = ''] = location.hash.replace(/^#\/?/, '').split('/');
  return pageAllowed(page) ? { page, arg } : { page: 'dash', arg: '' };
}

async function onRoute() {
  if (!state.user || !shell.main) return;
  const next = parseHash();
  if (hashOf(next) !== location.hash) history.replaceState(null, '', hashOf(next));
  if (current && next.page === current.page) {
    if (next.arg !== current.arg) {
      current = next;
      pageCtx?.onArg?.(next.arg);
    }
    return;
  }
  if (current && pageDirty()) {
    const from = current;
    if (!(await confirmLeave())) {
      history.replaceState(null, '', hashOf(from));
      return;
    }
  }
  show(next);
}
window.addEventListener('hashchange', onRoute);
window.addEventListener('beforeunload', e => {
  if (pageDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function show(next) {
  pageCtx?.onLeave?.();
  stopPolls('page');
  current = next;
  const ctx = pageCtx = { onArg: null, onStats: null, onLeave: null, dirty: null };
  const page = PAGES[next.page];
  for (const [key, a] of Object.entries(shell.links)) {
    if (key === next.page) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  shell.title.textContent = page.label;
  shell.desc.textContent = typeof page.desc === 'function' ? page.desc() : page.desc;
  document.title = `${page.label} | ${state.me.clinicName}`;
  shell.main.replaceChildren(h('div', { class: 'loading', role: 'status', text: 'در حال بارگذاری…' }));
  window.scrollTo(0, 0);
  // Fresh badges on every page change (the dashboard fetches the same numbers itself).
  if (next.page !== 'dash' && shellPoll && Date.now() - shellPoll.last > 5000) refreshStats().catch(() => {});
  Promise.resolve().then(() => page.render(shell.main, next.arg, ctx)).catch(err => {
    if (!alive(ctx) || err?.status === 401) return;
    if (!(err instanceof ApiError)) console.error(err);
    shell.main.replaceChildren(card({}, h('div', { class: 'empty' },
      h('p', { text: `بارگذاری انجام نشد: ${err.message}` }),
      btn('تلاش دوباره', () => show(next), 'primary'))));
  });
}

// ───────── Dashboard ─────────
async function renderDash(main, _arg, ctx) {
  const data = await refreshStats();
  if (!alive(ctx)) return;
  const draw = d => {
    const focusedId = main.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    main.replaceChildren(...dashView(d));
    if (focusedId) main.querySelector(`tr[data-id="${CSS.escape(focusedId)}"]`)?.focus();
  };
  draw(data);
  ctx.onStats = d => { if (alive(ctx)) draw(d); };
}

function dashView({ stats: s, daily, topQuestions, recent }) {
  const pct = (a, b) => (b ? Math.round((a * 100) / b) : 0);
  const tiles = [
    ['کل کاربرها', s.total, 'همه‌ی کسانی که فرم را پر کرده‌اند'],
    ['آنلاین الان', s.online, 'در همین لحظه در صفحه‌ی چت', 'on'],
    ['عمل‌کرده', s.operated, `${fa(pct(s.operated, s.total))}٪ از کاربرها`],
    ['عمل‌نکرده', s.notOperated, `${fa(pct(s.notOperated, s.total))}٪ از کاربرها`],
    ['کاربر جدید امروز', s.today, 'از ساعت ۰۰:۰۰ امروز'],
    ['سؤال بی‌جواب', s.unanswered, s.unanswered ? 'منتظر جواب شما' : 'همه‌ی سؤال‌ها جواب دارند', s.unanswered ? 'warn' : ''],
  ];
  const tilesEl = h('div', { class: 'tiles' }, tiles.map(([label, n, sub, kind]) => h('div', { class: `tile ${kind || ''}`.trim() },
    h('span', { class: 't-l' }, kind === 'on' ? h('i', { class: 'dot' }) : null, label),
    h('span', { class: 't-n', text: fa(n) }),
    h('span', { class: 't-s', text: sub }))));

  const top = card({ title: 'پرتکرارترین سؤال‌ها', sub: 'سؤال‌هایی که بیشتر از همه پرسیده شده' },
    topQuestions.length
      ? h('div', { class: 'toplist' }, topQuestions.map(q => h('div', {},
        h('span', { class: 'q', text: q.text }),
        q.unanswered ? h('span', { class: 'pill warn', text: 'بی‌جواب' }) : null,
        h('span', { class: 'c', text: fa(q.count), title: `${fa(q.count)} بار` }))))
      : h('div', { class: 'empty', text: 'هنوز سؤالی پرسیده نشده.' }));

  const openChat = id => { location.hash = `#/chats/${id}`; };
  const recentCard = card({ title: 'آخرین کاربرها', sub: 'روی هر ردیف بزنید تا گفتگوی آن کاربر باز شود.', extra: linkBtn('همه‌ی گفتگوها', '#/chats', 'soft') },
    recent.length
      ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['نام', 'موبایل', 'وضعیت عمل', 'ورود', 'آخرین سؤال'].map(t => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, recent.map(v => h('tr', {
          class: 'link', tabindex: '0', 'data-id': String(v.id), 'aria-label': `گفتگوی ${v.name}`,
          onClick: () => openChat(v.id),
          onKeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openChat(v.id); } },
        },
        h('td', {}, h('span', { class: 'who' }, ini(v), h('b', { text: v.name }))),
        h('td', { class: 'ltr num', text: v.phone }),
        h('td', {}, opPill(v.operated)),
        h('td', { text: relTime(v.createdAt) }),
        h('td', { class: 'cut', text: v.lastQuestion || '—', title: v.lastQuestion || null }))))))
      : h('div', { class: 'empty', text: 'هنوز کسی گفتگو را شروع نکرده. لینک صفحه‌ی چت را در بیو اینستاگرام بگذارید.' }));

  return [tilesEl, h('div', { class: 'side-col' }, chartCard(daily), top), recentCard];
}

// New visitors per day for 14 days, stacked: operated at the bottom, not operated on top.
function chartCard(daily) {
  const W = 640, H = 230, L = 30, R = 8, T = 12, B = 30;
  const n = Math.max(1, daily.length);
  const max = Math.max(2, ...daily.map(d => d.operated + d.notOperated));
  const topValue = Math.ceil(max / 2) * 2;
  const cw = (W - L - R) / n;
  const bw = Math.min(26, cw * 0.56);
  const y = v => T + (H - T - B) * (1 - v / topValue);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'نمودار کاربرهای جدید ۱۴ روز اخیر' });
  const add = (tag, attrs, text) => {
    const el = svgEl(tag, attrs);
    if (text !== undefined) el.textContent = text;
    svg.append(el);
    return el;
  };
  for (const v of [0, topValue / 2, topValue]) {
    add('line', { class: 'ch-grid', x1: L, x2: W - R, y1: y(v), y2: y(v) });
    add('text', { class: 'ch-txt', x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, fa(v));
  }
  const wrap = h('div', { class: 'chart-wrap' });
  const tip = h('div', { class: 'tip', hidden: true, 'aria-hidden': 'true' });
  const bar = (x, y0, y1, cls, roundTop) => {
    const height = y0 - y1;
    if (height <= 0) return;
    const r = roundTop ? Math.min(4, height) : 0;
    add('path', { class: cls, d: `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + bw - r} Q${x + bw},${y1} ${x + bw},${y1 + r} V${y0} Z` });
  };
  daily.forEach((d, i) => {
    const last = i === daily.length - 1;
    const label = last ? 'امروز' : d.label;
    const x = L + i * cw + (cw - bw) / 2;
    const yOp = y(d.operated);
    const yAll = y(d.operated + d.notOperated);
    bar(x, y(0), yOp, 'bar-op', d.notOperated === 0);
    if (d.notOperated) bar(x, yOp - (d.operated ? 2 : 0), yAll, 'bar-not', true);
    if (i % 2 === 1 || last) add('text', { class: 'ch-txt ch-day', x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, label);
    const text = `${label}: ${fa(d.operated)} عمل‌کرده، ${fa(d.notOperated)} عمل‌نکرده`;
    const hit = add('rect', { class: 'ch-hit', x: L + i * cw, y: T, width: cw, height: H - T - B, tabindex: '0', 'aria-label': text });
    const showTip = () => {
      tip.textContent = text;
      tip.hidden = false;
      const r = wrap.getBoundingClientRect();
      const s = svg.getBoundingClientRect();
      const half = tip.offsetWidth / 2;
      const left = ((x + bw / 2) / W) * s.width + (s.left - r.left);
      tip.style.left = `${Math.min(Math.max(left, half), r.width - half)}px`;
      tip.style.top = `${(yAll / H) * s.height + (s.top - r.top) - 6}px`;
    };
    const hideTip = () => { tip.hidden = true; };
    hit.addEventListener('mouseenter', showTip);
    hit.addEventListener('click', showTip);
    hit.addEventListener('focus', showTip);
    hit.addEventListener('mouseleave', hideTip);
    hit.addEventListener('blur', hideTip);
  });
  const totOp = daily.reduce((sum, d) => sum + d.operated, 0);
  const totNot = daily.reduce((sum, d) => sum + d.notOperated, 0);
  wrap.append(svg, tip);
  return card({ title: 'کاربرهای جدید، ۱۴ روز اخیر', sub: 'روی هر ستون بروید یا بزنید تا عددش را ببینید.' },
    h('div', { class: 'legend' },
      h('span', {}, h('i', { class: 'op' }), `عمل‌کرده: ${fa(totOp)}`),
      h('span', {}, h('i', { class: 'not' }), `عمل‌نکرده: ${fa(totNot)}`)),
    wrap);
}

// ───────── Conversations ─────────
async function renderChats(main, arg, ctx) {
  const C = state.chats;
  let list = [];
  let total = 0;
  let selected = Number(arg) || null;
  let conv = null;

  const search = h('input', { class: 'inp', type: 'search', value: C.q, maxlength: '60', placeholder: 'جست‌وجوی اسم یا شماره', 'aria-label': 'جست‌وجوی اسم یا شماره' });
  let searchTimer = 0;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      C.q = search.value;
      C.want = PAGE_SIZE;
      loadList().catch(fail);
    }, 300);
  });
  const filters = seg([['all', 'همه'], ['op', 'عمل‌کرده'], ['not', 'عمل‌نکرده'], ['online', 'آنلاین']], C.filter, key => {
    C.filter = key;
    C.want = PAGE_SIZE;
    loadList().catch(fail);
  }, 'فیلتر کاربرها');
  const count = h('span', { class: 'count grow', 'aria-live': 'polite' });
  const items = h('div', { class: 'items' }, h('div', { class: 'loading', text: 'در حال بارگذاری…' }));
  const moreBtn = btn('بیشتر', () => {
    C.want = Math.min(total, list.length + PAGE_SIZE);
    moreBtn.disabled = true;
    loadList().catch(fail).finally(() => { moreBtn.disabled = false; });
  }, 'more');
  const left = h('section', { class: 'card ulist', 'aria-label': 'فهرست کاربرها' },
    h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('i-search'), search), filters),
    h('div', { class: 'row' }, count, btn('خروجی اکسل', exportModal, 'soft', 'i-down')),
    items);
  const pane = h('section', { class: 'card cpane', 'aria-label': 'گفتگو' });
  const split = h('div', { class: 'split', 'data-open': String(Boolean(selected)) }, left, pane);
  main.replaceChildren(split);

  // A refresh asks again for every row already on screen (pages of 200, the server's maximum).
  let listSeq = 0;
  async function loadList() {
    const seq = ++listSeq;
    const want = Math.max(PAGE_SIZE, C.want);
    const rows = [];
    let found = 0;
    for (let offset = 0; offset < want; offset += 200) {
      const limit = Math.min(200, want - offset);
      const params = new URLSearchParams({ filter: C.filter, q: C.q.trim(), offset: String(offset), limit: String(limit) });
      const res = await api('GET', `/api/admin/visitors?${params}`);
      found = res.total;
      rows.push(...res.visitors);
      if (res.visitors.length < limit) break;
    }
    if (seq !== listSeq || !alive(ctx)) return;
    const seen = new Set();
    list = rows.filter(v => !seen.has(v.id) && seen.add(v.id));
    total = found;
    drawList();
  }

  function emptyText() {
    if (C.q.trim()) return 'کسی با این اسم یا شماره پیدا نشد.';
    if (C.filter === 'online') return 'الان کسی در صفحه‌ی چت نیست.';
    if (C.filter !== 'all') return 'کسی در این گروه نیست.';
    return 'هنوز کسی گفتگو را شروع نکرده. لینک صفحه‌ی چت را در بیو اینستاگرام بگذارید.';
  }

  function drawList() {
    const focusedId = items.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    count.textContent = total ? `${fa(total)} نفر` : '';
    if (!list.length) {
      items.replaceChildren(h('div', { class: 'empty', text: emptyText() }));
      return;
    }
    items.replaceChildren(...list.map(v => h('a', { class: 'uitem', href: `#/chats/${v.id}`, 'data-id': String(v.id), 'aria-current': String(v.id === selected) },
      ini(v),
      h('span', { class: 'u-txt' },
        h('span', { class: 'u-name' }, h('b', { text: v.name }), opPill(v.operated)),
        h('span', { class: 'u-last', text: v.lastQuestion || 'هنوز سؤالی نپرسیده' })),
      h('span', { class: `u-time${v.online ? ' on' : ''}`, text: v.online ? 'آنلاین' : relTime(v.lastSeen) }))));
    if (total > list.length) items.append(moreBtn);
    if (focusedId) items.querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus();
  }

  function markSelected() {
    split.dataset.open = String(Boolean(selected));
    for (const a of items.querySelectorAll('.uitem')) a.setAttribute('aria-current', String(Number(a.dataset.id) === selected));
  }

  async function openConversation(id) {
    conv?.saveNote();
    selected = id;
    conv = null;
    markSelected();
    if (!id) {
      pane.replaceChildren(h('div', { class: 'empty', text: total ? 'یک کاربر را از فهرست انتخاب کنید.' : 'وقتی کسی فرم صفحه‌ی چت را پر کند، گفتگویش اینجا دیده می‌شود.' }));
      return;
    }
    pane.replaceChildren(h('div', { class: 'loading', text: 'در حال بارگذاری…' }));
    if (matchMedia('(max-width: 900px)').matches) split.scrollIntoView({ block: 'start' });
    let data;
    try {
      data = await api('GET', `/api/admin/visitors/${id}`);
    } catch (err) {
      if (selected !== id || !alive(ctx) || err.status === 401) return;
      pane.replaceChildren(h('div', { class: 'empty' },
        h('p', { text: err.status === 404 ? 'این گفتگو پیدا نشد.' : err.message }),
        linkBtn('برگشت به فهرست', '#/chats', 'back-to-list')));
      return;
    }
    if (selected !== id || !alive(ctx)) return;
    conv = conversationView(id, data);
    pane.replaceChildren(...conv.nodes);
    conv.drawMessages(true);
  }

  // The pane is built once per conversation; refreshes only touch the status and the message list,
  // so a half-typed reply or note is never replaced.
  function conversationView(id, data) {
    const c = { id, visitor: data.visitor, messages: data.messages, sig: '', savedNote: data.visitor.note || '' };
    const nameEl = h('b');
    const phoneEl = h('span', { class: 'ltr num' });
    const opSlot = h('span');
    const statusSlot = h('span');
    const avatarSlot = h('span');
    const head = h('div', { class: 'cpane-head' },
      linkBtn('', '#/chats', 'icon back-to-list', 'i-back', { 'aria-label': 'برگشت به فهرست', title: 'برگشت به فهرست' }),
      avatarSlot,
      h('div', { class: 'grow' }, nameEl, phoneEl),
      opSlot,
      statusSlot,
      btn('کپی شماره', () => copyText(c.visitor.phone, 'شماره کپی شد'), '', 'i-copy'));
    const convo = h('div', { class: 'convo', role: 'log', tabindex: '0' });
    const reply = h('input', { class: 'inp grow', maxlength: '1000', autocomplete: 'off', 'aria-label': 'جواب پشتیبان' });
    const sendBtn = h('button', { type: 'submit', class: 'btn primary' }, icon('i-send'), 'فرستادن');
    const offline = h('span', { class: 'f-hint' });
    const form = h('form', { class: 'row' }, reply, sendBtn);
    const note = h('input', { class: 'inp', maxlength: '500', value: c.savedNote, placeholder: 'مثلاً: برای مشاوره‌ی شنبه هماهنگ شد' });
    const foot = h('div', { class: 'cpane-foot' }, form, offline, field('یادداشت پشتیبان (فقط برای شما)', note));

    c.drawHead = () => {
      const v = c.visitor;
      nameEl.textContent = v.name;
      phoneEl.textContent = v.phone;
      avatarSlot.replaceChildren(ini(v));
      opSlot.replaceChildren(opPill(v.operated));
      statusSlot.replaceChildren(v.online ? onlinePill() : h('span', { class: 'pill mute', text: `آخرین فعالیت: ${relTime(v.lastSeen)}` }));
      convo.setAttribute('aria-label', `گفتگوی ${v.name}`);
      reply.placeholder = `جواب شما به ${firstName(v.name)}…`;
      offline.textContent = v.online ? '' : 'این کاربر الان در صفحه‌ی چت نیست؛ دفعه‌ی بعد که صفحه را باز کند، جواب شما را می‌بیند.';
      offline.hidden = v.online;
    };

    c.drawMessages = (toBottom = false) => {
      const sig = c.messages.map(m => `${m.id}${m.unanswered ? 'u' : ''}`).join(',');
      if (sig === c.sig) return;
      c.sig = sig;
      const atBottom = convo.scrollHeight - convo.scrollTop - convo.clientHeight < 60;
      if (!c.messages.length) {
        convo.replaceChildren(h('div', { class: 'empty', text: 'این کاربر هنوز سؤالی نپرسیده.' }));
        return;
      }
      const nodes = [];
      let lastDay = null;
      for (const m of c.messages) {
        const day = dayNumber(m.at);
        if (day !== lastDay) {
          nodes.push(h('div', { class: 'day-sep', text: dayTitle(m.at) }));
          lastDay = day;
        }
        nodes.push(bubble(m));
      }
      convo.replaceChildren(...nodes);
      if (toBottom || atBottom) convo.scrollTop = convo.scrollHeight;
    };

    c.saveNote = async () => {
      const value = note.value.trim();
      if (value === c.savedNote.trim()) return;
      try {
        await api('PUT', `/api/admin/visitors/${id}`, { note: value });
        c.savedNote = value;
        toast('ذخیره شد');
      } catch (err) {
        fail(err);
      }
    };
    note.addEventListener('blur', () => c.saveNote());
    note.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        note.blur();
      }
    });

    let sending = false;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const text = reply.value.trim();
      if (!text || sending) return;
      sending = true;
      sendBtn.disabled = true;
      try {
        const { message } = await api('POST', `/api/admin/visitors/${id}/messages`, { text });
        if (!c.messages.some(m => m.id === message.id)) c.messages.push(message);
        reply.value = '';
        c.drawMessages(true);
      } catch (err) {
        fail(err);
      } finally {
        sending = false;
        sendBtn.disabled = false;
        if (reply.isConnected) reply.focus();
      }
    });

    c.refresh = async () => {
      const fresh = await api('GET', `/api/admin/visitors/${id}`);
      if (conv !== c || !alive(ctx)) return;
      c.visitor = fresh.visitor;
      c.messages = fresh.messages;
      c.drawHead();
      c.drawMessages();
      const serverNote = fresh.visitor.note || '';
      if (document.activeElement !== note && note.value.trim() === c.savedNote.trim() && serverNote !== c.savedNote) {
        note.value = serverNote;
        c.savedNote = serverNote;
      }
    };

    c.nodes = [head, convo, foot];
    c.drawHead();
    return c;
  }

  function bubble(m) {
    const time = h('span', { text: clock(m.at), title: relTime(m.at) });
    if (m.from === 'visitor') {
      return h('div', { class: 'bub visitor' }, m.text,
        h('span', { class: 'b-meta' }, m.unanswered ? h('span', { class: 'pill warn', text: 'بی‌جواب' }) : null, time));
    }
    if (m.from === 'staff') {
      return h('div', { class: 'bub staff' }, h('span', { class: 'b-who', text: m.staffName || 'پشتیبان' }), m.text,
        h('span', { class: 'b-meta' }, time));
    }
    return h('div', { class: 'bub bot' }, m.text,
      h('span', { class: 'b-meta' }, m.contacts ? h('span', { text: '+ دکمه‌های راه تماس' }) : null, time));
  }

  ctx.onArg = a => openConversation(Number(a) || null);
  ctx.onLeave = () => conv?.saveNote();
  await loadList();
  if (!alive(ctx)) return;
  openConversation(selected);
  poll(15000, loadList);
  poll(5000, async () => { if (conv) await conv.refresh(); });
}

function exportModal() {
  const get = filter => () => {
    closeModal();
    download(`/api/admin/export.xlsx?filter=${filter}`);
  };
  openModal({
    title: 'خروجی اکسل',
    narrow: true,
    body: h('p', { class: 'modal-text', text: 'کدام فهرست دانلود شود؟ فایل اکسل اسم، موبایل، وضعیت عمل، اولین ورود، آخرین فعالیت و تعداد سؤال‌های هر نفر را دارد.' }),
    actions: [btn('عمل‌کرده‌ها', get('op'), 'soft', 'i-down'), btn('عمل‌نکرده‌ها', get('not'), 'soft', 'i-down'), btn('همه', get('all'), 'primary', 'i-down')],
  });
}

// ───────── Unanswered questions ─────────
async function renderUnanswered(main, _arg, ctx) {
  const owner = isOwner();
  const load = async () => {
    const { items } = await api('GET', '/api/admin/unanswered');
    if (!alive(ctx)) return;
    main.replaceChildren(card({
      title: items.length ? `${fa(items.length)} سؤال بی‌جواب` : 'سؤال‌های بی‌جواب',
      sub: owner
        ? 'برای هر سؤال جواب بنویسید تا به دیتابیس اضافه شود؛ دفعه‌ی بعد ربات خودش جواب می‌دهد.'
        : 'فقط مالک می‌تواند برای این سؤال‌ها جواب بنویسد. با «دیدن گفتگو» می‌توانید خودتان به آن کاربر جواب بدهید.',
    }, items.length ? h('div', { class: 'stack tight' }, items.map(item)) : h('div', { class: 'empty', text: 'سؤال بی‌جوابی نمانده.' })));
  };
  const changed = async () => {
    await load();
    refreshStats().catch(() => {});
  };
  const item = it => h('div', { class: 'una' },
    h('div', { class: 'grow' },
      h('b', { text: it.text }),
      h('small', { text: `${fa(it.count)} بار پرسیده شده؛ آخرین بار ${it.lastVisitorName}، ${relTime(it.lastAt)}` })),
    linkBtn('دیدن گفتگو', `#/chats/${it.lastVisitorId}`, '', 'i-chat'),
    owner ? btn('نادیده بگیر', async e => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        await api('POST', '/api/admin/unanswered/resolve', { norm: it.norm });
        toast('از فهرست برداشته شد');
        await changed();
      } catch (err) {
        fail(err);
        button.disabled = false;
      }
    }) : null,
    owner ? btn('نوشتن جواب', () => kbModal({ title: questionTitle(it.text), question: it.text, resolveNorm: it.norm, onSaved: changed }), 'primary', 'i-plus') : null);
  await load();
}

const questionTitle = text => text.replace(/[؟?]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

// ───────── Knowledge base: add / edit modal ─────────
function kbModal({ entry = null, title = '', question = '', resolveNorm = null, categories = null, onSaved }) {
  const listId = `kb-cats-${++uid}`;
  const titleIn = h('input', { class: 'inp', maxlength: '120', value: entry?.title ?? title });
  const catIn = h('input', { class: 'inp', maxlength: '60', list: listId, autocomplete: 'off', value: entry?.category ?? '', placeholder: 'مثلاً: بعد از عمل' });
  const keysIn = h('input', { class: 'inp', maxlength: '500', value: entry?.keywords ?? '', placeholder: 'مثلاً: بیمه، بیمه تکمیلی، دفترچه' });
  const answerIn = h('textarea', { class: 'inp', rows: '5', maxlength: '2000', value: entry?.answer ?? '', placeholder: 'جوابی که ربات باید بدهد' });
  const datalist = h('datalist', { id: listId });
  const fillCategories = cats => datalist.replaceChildren(...cats.map(c => h('option', { value: c })));
  if (categories) fillCategories(categories);
  else api('GET', '/api/admin/kb').then(({ entries }) => fillCategories(categoriesOf(entries))).catch(() => {});
  const error = formError();
  const save = h('button', { type: 'submit', class: 'btn primary' }, icon('i-save'), entry ? 'ذخیره' : 'ذخیره در دیتابیس');
  const form = h('form', { class: 'stack', novalidate: true },
    question ? h('div', { class: 'notice' }, icon('i-info'), `سؤال: «${question}». بعد از ذخیره، این سؤال از فهرست بی‌جواب برداشته می‌شود.`) : null,
    error,
    datalist,
    h('div', { class: 'grid2' }, field('موضوع', titleIn), field('دسته (اختیاری)', catIn)),
    field('کلمه‌های مشابه (اختیاری)', keysIn, 'کلمه‌هایی که مردم برای همین موضوع می‌نویسند، با «،» جدا. پیدا کردن جواب را دقیق‌تر می‌کند.'),
    field('جواب', answerIn),
    h('div', { class: 'row end' }, btn('انصراف', () => closeModal()), save));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    error.hidden = true;
    const missing = !titleIn.value.trim() ? [titleIn, 'موضوع را بنویسید'] : !answerIn.value.trim() ? [answerIn, 'جواب را بنویسید'] : null;
    if (missing) {
      showError(error, missing[1]);
      missing[0].focus();
      return;
    }
    save.disabled = true;
    const body = { category: catIn.value, title: titleIn.value, keywords: keysIn.value, answer: answerIn.value };
    if (resolveNorm) body.resolveNorm = resolveNorm;
    try {
      const res = entry ? await api('PUT', `/api/admin/kb/${entry.id}`, body) : await api('POST', '/api/admin/kb', body);
      closeModal();
      toast(entry ? 'ذخیره شد' : 'به دیتابیس اضافه شد');
      await onSaved?.(res.entry);
    } catch (err) {
      if (err.status !== 401) showError(error, err.message);
    } finally {
      save.disabled = false;
    }
  });
  openModal({ title: entry ? 'ویرایش موضوع' : resolveNorm ? 'افزودن جواب به دیتابیس' : 'موضوع جدید', body: form });
  if (title && !entry) answerIn.focus();
}

const categoriesOf = entries => [...new Set(entries.map(e => e.category).filter(Boolean))];

// ───────── Bot database: persona (part 1) and clinic information (part 2) ─────────
async function renderDb(main, _arg, ctx) {
  const owner = isOwner();
  const [settings, kb] = await Promise.all([api('GET', '/api/admin/settings'), api('GET', '/api/admin/kb')]);
  if (!alive(ctx)) return;
  let entries = kb.entries;

  // Part 1
  const saved = { welcome: settings.welcome, notFound: settings.notFound, phrases: settings.phrases, persona: settings.persona };
  const area = (key, rows, max) => h('textarea', { class: 'inp', rows: String(rows), maxlength: String(max), value: saved[key], readonly: !owner });
  const inputs = { welcome: area('welcome', 3, 1000), notFound: area('notFound', 3, 1000), phrases: area('phrases', 3, 1000), persona: area('persona', 6, 4000) };
  const personaError = formError();
  const personaSave = owner ? btn('ذخیره', savePersona, 'primary', 'i-save') : null;
  const personaCard = card({ title: 'شخصیت و لحن ربات', sub: 'ربات چطور حرف بزند.', extra: personaSave },
    personaError,
    field('پیام خوش‌آمد', inputs.welcome, '{نام} جای اسم مراجعه‌کننده می‌نشیند.'),
    field('پیام وقتی جواب پیدا نشد', inputs.notFound, 'زیر این پیام، راه‌های تماسِ روشن در صفحه‌ی چت نشان داده می‌شود.'),
    field('جمله‌های محبت‌آمیز اول جواب', inputs.phrases, 'هر خط یک جمله. ربات به نوبت یکی از این‌ها را اول جواب‌های دیتابیس می‌گذارد.'),
    field('نقش و لحن', inputs.persona, 'فعلاً استفاده نمی‌شود؛ اگر بعداً هوش مصنوعی اضافه شد، همین متن به آن داده می‌شود.'));
  ctx.dirty = () => owner && Object.keys(inputs).some(k => inputs[k].value !== saved[k]);

  async function savePersona() {
    personaError.hidden = true;
    if (!inputs.welcome.value.trim()) return showError(personaError, 'پیام خوش‌آمد را بنویسید');
    if (!inputs.notFound.value.trim()) return showError(personaError, 'پیام «جواب پیدا نشد» را بنویسید');
    const body = Object.fromEntries(Object.keys(inputs).map(k => [k, inputs[k].value]));
    personaSave.disabled = true;
    try {
      await api('PUT', '/api/admin/settings', body);
      Object.assign(saved, body);
      toast('ذخیره شد');
    } catch (err) {
      if (err.status !== 401) showError(personaError, err.message);
    } finally {
      personaSave.disabled = false;
    }
  }

  // Part 2
  const kbSearch = h('input', { class: 'inp', type: 'search', value: state.kbQ, maxlength: '60', placeholder: 'جست‌وجو در دیتابیس', 'aria-label': 'جست‌وجو در دیتابیس' });
  kbSearch.addEventListener('input', () => { state.kbQ = kbSearch.value; drawKb(); });
  const cats = h('div', { class: 'seg', role: 'group', 'aria-label': 'دسته‌ها' });
  const kbCount = h('span', { class: 'f-hint' });
  const kbList = h('div', { class: 'kb-list' });
  const newEntry = () => kbModal({ categories: categoriesOf(entries), onSaved: reloadKb });
  const kbCard = card({ title: 'اطلاعات کلینیک', sub: 'هر موضوع جدا، مثل آدرس، قیمت، ساعت کاری و مراقبت‌ها.', extra: owner ? btn('موضوع جدید', newEntry, 'primary', 'i-plus') : null },
    h('div', { class: 'toolbar' }, h('div', { class: 'search' }, icon('i-search'), kbSearch), cats),
    kbCount,
    kbList);

  async function reloadKb() {
    const res = await api('GET', '/api/admin/kb');
    if (!alive(ctx)) return;
    entries = res.entries;
    drawKb();
  }

  function drawKb() {
    const categories = categoriesOf(entries);
    if (state.kbCat !== 'all' && !categories.includes(state.kbCat)) state.kbCat = 'all';
    cats.hidden = !categories.length;
    cats.replaceChildren(...[['all', 'همه'], ...categories.map(c => [c, c])].map(([key, text]) => h('button', {
      type: 'button', 'aria-pressed': String(state.kbCat === key), onClick: () => { state.kbCat = key; drawKb(); },
    }, text)));
    const q = normalize(state.kbQ);
    const shown = entries.filter(e => (state.kbCat === 'all' || e.category === state.kbCat)
      && (!q || normalize(`${e.title} ${e.category} ${e.keywords} ${e.answer}`).includes(q)));
    kbCount.textContent = entries.length ? `${fa(shown.length)} از ${fa(entries.length)} موضوع` : '';
    if (!shown.length) {
      kbList.replaceChildren(h('div', { class: 'empty', text: entries.length ? 'موضوعی پیدا نشد.' : owner ? 'هنوز موضوعی ثبت نشده. با «موضوع جدید» اولین جواب را بنویسید.' : 'هنوز موضوعی ثبت نشده.' }));
      return;
    }
    kbList.replaceChildren(...shown.map(e => {
      const keys = splitKeywords(e.keywords);
      return h('article', { class: 'kb-item' },
        h('div', { class: 'kb-top' },
          e.category ? h('span', { class: 'pill op', text: e.category }) : null,
          h('b', { text: e.title }),
          owner ? iconBtn('i-edit', `ویرایش «${e.title}»`, () => kbModal({ entry: e, categories: categoriesOf(entries), onSaved: reloadKb })) : null,
          owner ? iconBtn('i-trash', `حذف «${e.title}»`, () => deleteEntry(e), { class: 'btn icon danger' }) : null),
        h('p', { text: e.answer }),
        keys.length ? h('div', { class: 'keys', 'aria-label': 'کلمه‌های مشابه' }, keys.map(k => h('span', { text: k }))) : null);
    }));
  }

  async function deleteEntry(e) {
    const ok = await confirmModal({ title: 'حذف موضوع', message: `موضوع «${e.title}» از دیتابیس حذف شود؟ ربات دیگر این جواب را نمی‌دهد.`, ok: 'حذف', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/api/admin/kb/${e.id}`);
      toast('حذف شد');
      await reloadKb();
    } catch (err) {
      fail(err);
    }
  }

  const tabs = seg([['persona', 'بخش ۱: شخصیت ربات'], ['info', 'بخش ۲: اطلاعات کلینیک']], state.dbTab, key => {
    state.dbTab = key;
    drawTab();
  }, 'بخش‌های دیتابیس');
  // Both parts stay in the page, so switching between them keeps unsaved edits.
  const drawTab = () => {
    personaCard.hidden = state.dbTab !== 'persona';
    kbCard.hidden = state.dbTab === 'persona';
  };
  drawKb();
  drawTab();
  fill(main,
    owner ? null : h('div', { class: 'notice warn' }, icon('i-lock'), 'فقط مالک می‌تواند تغییر بدهد. شما می‌توانید ببینید و ربات را امتحان کنید.'),
    h('div', {}, tabs),
    h('div', { class: 'side-col' }, h('div', { class: 'stack' }, personaCard, kbCard), testerCard()));
}

function testerCard() {
  const input = h('input', { class: 'inp grow', maxlength: '500', autocomplete: 'off', placeholder: 'مثلاً: آدرس مطب کجاست؟', 'aria-label': 'سؤال آزمایشی' });
  const ask = h('button', { type: 'submit', class: 'btn primary', text: 'بپرس' });
  const out = h('div', { class: 'result', 'aria-live': 'polite' }, h('span', { class: 'why', text: 'یک سؤال بنویسید تا ببینید ربات با دیتابیس فعلی چه جوابی می‌دهد.' }));
  const form = h('form', { class: 'row' }, input, ask);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    ask.disabled = true;
    try {
      const { answer } = await api('POST', '/api/admin/test', { text });
      out.replaceChildren(
        h('div', { class: 'bub bot wide' }, answer.text, answer.contacts ? h('span', { class: 'b-meta', text: '+ دکمه‌های راه‌های تماس' }) : null),
        h('span', { class: 'why', text: whyText(answer) }));
    } catch (err) {
      fail(err);
    } finally {
      ask.disabled = false;
    }
  });
  return card({ title: 'امتحان ربات', sub: 'جوابی که مراجعه‌کننده می‌بیند، همین‌جا. چیزی ذخیره نمی‌شود.' }, form, out);
}

function whyText(answer) {
  if (answer.kind === 'kb') return `جواب از موضوع «${answer.entryTitle}» آمد.`;
  if (answer.kind === 'talk') return 'جواب آماده‌ی خود ربات (سلام، تشکر یا درخواست تماس).';
  return 'در دیتابیس پیدا نشد؛ پیام «جواب پیدا نشد» و راه‌های تماس نشان داده می‌شود. اگر مراجعه‌کننده‌ای این را بپرسد، به «سؤال‌های بی‌جواب» اضافه می‌شود.';
}

// ───────── Quick replies ─────────
async function renderQuick(main, _arg, ctx) {
  const data = await api('GET', '/api/admin/quick-replies');
  if (!alive(ctx)) return;
  const lists = { op: data.op.map(q => ({ text: q.text, enabled: q.enabled })), not: data.not.map(q => ({ text: q.text, enabled: q.enabled })) };
  let saved = JSON.stringify(lists);
  ctx.dirty = () => JSON.stringify(lists) !== saved;
  const error = formError();
  const saveBtn = btn('ذخیره', save, 'primary', 'i-save');

  const column = (key, title) => {
    const box = h('div', { class: 'qcol' });
    const list = lists[key];
    const draw = focus => {
      const add = h('input', { class: 'inp grow', maxlength: '60', placeholder: 'پیام آماده‌ی جدید', 'aria-label': `پیام آماده‌ی جدید ${title}` });
      const addForm = h('form', { class: 'qrow' }, add, h('button', { type: 'submit', class: 'btn', disabled: list.length >= 20 }, icon('i-plus'), 'افزودن'));
      addForm.addEventListener('submit', e => {
        e.preventDefault();
        const text = add.value.trim();
        if (!text) {
          add.focus();
          return;
        }
        list.push({ text, enabled: true });
        draw({ add: true });
      });
      const rows = list.map((q, i) => {
        const row = h('div', { class: `qrow${q.enabled ? '' : ' off'}` });
        const move = d => () => {
          [list[i], list[i + d]] = [list[i + d], list[i]];
          draw({ index: i + d, act: d < 0 ? 'up' : 'down' });
        };
        const text = h('input', { class: 'inp grow', maxlength: '60', value: q.text, 'aria-label': 'متن پیام آماده' });
        text.addEventListener('input', () => { q.text = text.value; });
        row.append(
          iconBtn('i-cu', 'بالاتر', move(-1), { disabled: i === 0, 'data-act': 'up' }),
          iconBtn('i-cd', 'پایین‌تر', move(1), { disabled: i === list.length - 1, 'data-act': 'down' }),
          text,
          toggle(q.enabled, on => { q.enabled = on; row.classList.toggle('off', !on); }, `نمایش «${q.text}»`),
          iconBtn('i-trash', 'حذف', () => { list.splice(i, 1); draw({ index: Math.min(i, list.length - 1), act: 'del' }); }, { class: 'btn icon danger', 'data-act': 'del' }));
        return row;
      });
      fill(box, h('b', { text: title }), rows,
        list.length ? null : h('p', { class: 'f-hint', text: 'هنوز پیامی نیست؛ دکمه‌ای در صفحه‌ی چت نشان داده نمی‌شود.' }),
        addForm,
        h('span', { class: 'f-hint', text: `${fa(list.length)} از ۲۰ پیام` }));
      // Keyboard users keep their place after moving or removing a row.
      if (focus?.add) add.focus();
      else if (focus && rows[focus.index]) {
        const r = rows[focus.index];
        const target = r.querySelector(`[data-act="${focus.act}"]:not(:disabled)`) || r.querySelector('button:not(:disabled)');
        target?.focus();
      } else if (focus) add.focus();
    };
    draw();
    return box;
  };

  async function save() {
    error.hidden = true;
    for (const key of ['op', 'not']) {
      if (lists[key].some(q => !q.text.trim())) return showError(error, 'متن پیام آماده را بنویسید یا آن ردیف را حذف کنید');
    }
    const body = {
      op: lists.op.map(q => ({ text: q.text.trim(), enabled: q.enabled })),
      not: lists.not.map(q => ({ text: q.text.trim(), enabled: q.enabled })),
    };
    saveBtn.disabled = true;
    try {
      await api('PUT', '/api/admin/quick-replies', body);
      for (const key of ['op', 'not']) lists[key].forEach((q, i) => { q.text = body[key][i].text; });
      saved = JSON.stringify(lists);
      toast('ذخیره شد');
    } catch (err) {
      if (err.status !== 401) showError(error, err.message);
    } finally {
      saveBtn.disabled = false;
    }
  }

  main.replaceChildren(card({
    title: 'پیام‌های آماده',
    sub: 'بسته به جواب «عمل کرده‌ای یا نه؟» فهرست جدا نشان داده می‌شود. ترتیب، روشن/خاموش و متن را عوض کنید و بعد ذخیره بزنید.',
    extra: saveBtn,
  }, error, h('div', { class: 'grid2' }, column('op', 'برای کسانی که عمل کرده‌اند'), column('not', 'برای کسانی که هنوز عمل نکرده‌اند'))));
}

// ───────── Contact links ─────────
const CONTACT_UI = {
  phone: { icon: 'i-phone', placeholder: 'مثلاً 09120000000' },
  whatsapp: { icon: 'i-wa', placeholder: 'شماره یا لینک واتس‌اپ' },
  instagram: { icon: 'i-cam', placeholder: 'آیدی پیج، مثلاً dr.zahedi' },
  rubika: { icon: 'i-msg', placeholder: 'آیدی یا لینک روبیکا' },
  telegram: { icon: 'i-telegram', placeholder: 'آیدی یا لینک تلگرام' },
  site: { icon: 'i-globe', placeholder: 'https://…' },
};
const contactIcon = id => CONTACT_UI[id]?.icon || 'i-link';

async function renderContacts(main, _arg, ctx) {
  const res = await api('GET', '/api/admin/contacts');
  if (!alive(ctx)) return;
  let rows = res.contacts.map(c => ({ id: c.id, label: c.label, enabled: c.enabled, value: c.value }));
  let saved = JSON.stringify(rows);
  ctx.dirty = () => JSON.stringify(rows) !== saved;
  const error = formError();
  const saveBtn = btn('ذخیره', save, 'primary', 'i-save');
  const box = h('div', { class: 'stack tight' });
  const mini = h('div', { class: 'mini-sheet' });

  const drawMini = () => {
    const on = rows.filter(c => c.enabled && c.value.trim());
    mini.replaceChildren(h('div', { class: 'cp-sheet-card' }, h('b', { text: 'راه‌های تماس با کلینیک' }),
      on.length
        ? h('div', { class: 'cp-contacts' }, on.map(c => h('span', { class: 'cp-contact' }, icon(contactIcon(c.id)), h('span', { text: c.label }))))
        : h('span', { class: 'f-hint', text: 'فعلاً راه تماسی ثبت نشده.' })));
  };
  const drawRows = () => box.replaceChildren(...rows.map(c => {
    const row = h('div', { class: `crow${c.enabled ? '' : ' off'}` });
    const input = h('input', { class: 'inp grow ltr', maxlength: '200', value: c.value, placeholder: CONTACT_UI[c.id]?.placeholder || '', 'aria-label': c.label, autocomplete: 'off', spellcheck: 'false' });
    input.addEventListener('input', () => { c.value = input.value; drawMini(); });
    row.append(
      h('span', { class: 'c-ic' }, icon(contactIcon(c.id))),
      h('span', { class: 'c-l', text: c.label }),
      toggle(c.enabled, on => { c.enabled = on; row.classList.toggle('off', !on); drawMini(); }, `${c.label} روشن باشد`),
      input);
    return row;
  }));

  async function save() {
    error.hidden = true;
    saveBtn.disabled = true;
    try {
      const out = await api('PUT', '/api/admin/contacts', { contacts: rows.map(c => ({ id: c.id, enabled: c.enabled, value: c.value.trim() })) });
      rows = out.contacts.map(c => ({ id: c.id, label: c.label, enabled: c.enabled, value: c.value }));
      saved = JSON.stringify(rows);
      drawRows();
      drawMini();
      toast('ذخیره شد');
    } catch (err) {
      if (err.status !== 401) showError(error, err.message);
    } finally {
      saveBtn.disabled = false;
    }
  }

  drawRows();
  drawMini();
  main.replaceChildren(h('div', { class: 'side-col' },
    card({ title: 'راه‌های ارتباطی', sub: 'روشن و خاموش کنید، شماره یا لینک بدهید. در منوی سه‌نقطه‌ی صفحه‌ی چت و زیر پیام «جواب پیدا نشد» نشان داده می‌شوند.', extra: saveBtn },
      error, box, h('span', { class: 'f-hint', text: 'راهی که خاموش باشد یا خالی بماند، در صفحه‌ی چت نشان داده نمی‌شود.' })),
    card({ title: 'منوی سه‌نقطه در صفحه‌ی چت', sub: 'با هر تغییر به‌روز می‌شود.' }, mini)));
}

// ───────── Look and brand ─────────
async function renderBrand(main, _arg, ctx) {
  const s = await api('GET', '/api/admin/settings');
  if (!alive(ctx)) return;
  const saved = { clinicName: s.clinicName, assistantName: s.assistantName };
  const clinic = h('input', { class: 'inp', maxlength: '80', value: s.clinicName });
  const assistant = h('input', { class: 'inp', maxlength: '40', value: s.assistantName });
  ctx.dirty = () => clinic.value !== saved.clinicName || assistant.value !== saved.assistantName;
  const error = formError();
  const saveBtn = btn('ذخیره', save, 'primary', 'i-save');

  // Avatar: resized and re-encoded on the page, uploaded at once.
  let hasAvatar = s.hasAvatar;
  const preview = avatarImg(s.avatarUrl);
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/*', hidden: true });
  const pick = btn('انتخاب عکس', () => file.click(), '', 'i-image');
  const reset = btn('برگشت به عکس پیش‌فرض', resetAvatar, 'danger', null, { hidden: !hasAvatar });
  const setAvatar = (url, custom) => {
    state.me.avatarUrl = url;
    hasAvatar = custom;
    preview.src = url;
    reset.hidden = !custom;
    rememberBrand();
    updateBrand();
  };
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    pick.disabled = true;
    try {
      const image = await resizeImage(f);
      const res = await api('POST', '/api/admin/avatar', { image });
      setAvatar(res.avatarUrl, true);
      toast('عکس پروفایل عوض شد');
    } catch (err) {
      fail(err);
    } finally {
      pick.disabled = false;
    }
  });
  async function resetAvatar() {
    reset.disabled = true;
    try {
      const res = await api('DELETE', '/api/admin/avatar');
      setAvatar(res.avatarUrl, false);
      toast('عکس پیش‌فرض برگشت');
    } catch (err) {
      fail(err);
    } finally {
      reset.disabled = false;
    }
  }

  const link = chatUrl();
  const adminLink = `${link}/admin`;
  const linkField = (label, value, hint, extra) => {
    const input = h('input', { class: 'inp grow ltr', id: `f${++uid}`, value, readonly: true });
    input.addEventListener('focus', () => input.select());
    return h('div', { class: 'field' }, h('label', { class: 'f-label', for: input.id, text: label }),
      h('div', { class: 'row' }, input, btn('کپی', () => copyText(value, 'لینک کپی شد'), '', 'i-copy'), extra),
      hint ? h('span', { class: 'f-hint', text: hint }) : null);
  };

  async function save() {
    error.hidden = true;
    if (!clinic.value.trim()) return showError(error, 'اسم کلینیک را بنویسید');
    if (!assistant.value.trim()) return showError(error, 'اسم دستیار را بنویسید');
    const body = { clinicName: clinic.value.trim(), assistantName: assistant.value.trim() };
    saveBtn.disabled = true;
    try {
      await api('PUT', '/api/admin/settings', body);
      clinic.value = body.clinicName;
      assistant.value = body.assistantName;
      Object.assign(saved, body);
      Object.assign(state.me, body);
      rememberBrand();
      updateBrand();
      toast('ذخیره شد');
    } catch (err) {
      if (err.status !== 401) showError(error, err.message);
    } finally {
      saveBtn.disabled = false;
    }
  }

  main.replaceChildren(card({ title: 'ظاهر و برند', sub: 'اسم‌ها با «ذخیره» عوض می‌شوند؛ عکس همان لحظه.', extra: saveBtn },
    error,
    h('div', { class: 'grid2' },
      field('اسم کلینیک یا دکتر', clinic, 'در صفحه‌ی ورود چت و عنوان صفحه دیده می‌شود.'),
      field('اسم دستیار (ربات)', assistant, 'بالای صفحه‌ی چت نوشته می‌شود.'),
      h('div', { class: 'field' }, h('span', { class: 'f-label', text: 'عکس پروفایل صفحه‌ی چت' }),
        h('div', { class: 'row' }, h('span', { class: 'logo huge' }, preview), file, pick, reset),
        h('span', { class: 'f-hint', text: 'PNG، JPG یا WEBP. عکس خودکار مربع، کوچک و فشرده می‌شود.' })),
      h('div', { class: 'stack' },
        linkField('لینک صفحه‌ی چت', link, 'همین لینک را در بیو اینستاگرام بگذارید.',
          linkBtn('باز کردن صفحه‌ی چت', link, '', 'i-open', { target: '_blank', rel: 'noopener noreferrer' })),
        linkField('لینک پنل مدیریت', adminLink, 'این لینک را فقط به مدیرها بدهید.')))));
}

// Crops the picture to a centred square of at most 320×320 and re-encodes it as JPEG.
async function resizeImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('این فایل عکس نیست');
  if (file.size > 20 * 1024 * 1024) throw new Error('حجم عکس خیلی زیاد است');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      throw new Error('این عکس باز نشد؛ عکس دیگری انتخاب کنید');
    }
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error('این عکس باز نشد؛ عکس دیگری انتخاب کنید');
    const size = Math.min(320, side);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    g.fillStyle = '#ffffff'; // JPEG has no transparency
    g.fillRect(0, 0, size, size);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ───────── Accounts and security ─────────
async function renderSecurity(main, _arg, ctx) {
  const passwordCard = ownPasswordCard();
  if (!isOwner()) {
    main.replaceChildren(h('div', { class: 'grid2' }, passwordCard));
    return;
  }
  const backupCard = card({ title: 'پشتیبان‌گیری', sub: 'هر روز خودکار یک نسخه از اطلاعات روی سرور ذخیره می‌شود.' },
    h('p', { class: 'modal-text', text: 'فایل zip همه‌ی اطلاعات (کاربرها، گفتگوها، دیتابیس ربات و تنظیمات) و کد برنامه را با راهنمای برگرداندن دارد. آن را جای امنی نگه دارید.' }),
    h('div', { class: 'row' }, btn('دانلود پشتیبان کامل', () => download('/api/admin/backup.zip'), 'soft', 'i-down')));
  const tbody = h('tbody');
  const accounts = card({
    title: 'حساب‌های پنل',
    sub: 'پشتیبان داشبورد، گفتگوها و سؤال‌های بی‌جواب را می‌بیند و به کاربرها جواب می‌دهد؛ تنظیمات را نمی‌تواند تغییر بدهد.',
    extra: btn('حساب جدید', () => newAccountModal(load), 'primary', 'i-plus'),
  }, h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['اسم', 'نام کاربری', 'دسترسی', 'آخرین ورود', 'فعال', ''].map(t => h('th', { scope: 'col', text: t })))),
    tbody)));

  async function load() {
    const { users } = await api('GET', '/api/admin/users');
    if (!alive(ctx)) return;
    tbody.replaceChildren(...users.map(u => {
      const self = u.id === state.user.id;
      const active = u.role === 'owner'
        ? h('span', { class: 'f-hint', text: 'همیشه فعال' })
        : toggle(u.active, (on, el) => setActive(u, on, el), `حساب ${u.displayName} فعال باشد`);
      return h('tr', {},
        h('td', {}, h('b', { text: u.displayName }), self ? h('span', { class: 'f-hint', text: ' (شما)' }) : null),
        h('td', { class: 'ltr', text: u.username }),
        h('td', { text: ROLE_LONG[u.role] || u.role }),
        h('td', { text: u.lastLoginAt ? relTime(u.lastLoginAt) : 'هنوز وارد نشده' }),
        h('td', {}, active),
        h('td', {}, self ? null : btn('رمز جدید', () => resetPasswordModal(u), '', 'i-key')));
    }));
  }

  async function setActive(u, on, el) {
    if (!on && !(await confirmModal({
      title: 'غیرفعال کردن حساب',
      message: `حساب «${u.displayName}» غیرفعال شود؟ همان لحظه از پنل خارج می‌شود و تا وقتی دوباره فعالش نکنید نمی‌تواند وارد شود.`,
      ok: 'غیرفعال شود',
      danger: true,
    }))) {
      el.setAttribute('aria-checked', 'true');
      return;
    }
    try {
      await api('PUT', `/api/admin/users/${u.id}`, { active: on });
      toast(on ? 'حساب فعال شد' : 'حساب غیرفعال شد');
      await load();
    } catch (err) {
      el.setAttribute('aria-checked', String(!on));
      fail(err);
    }
  }

  await load();
  if (!alive(ctx)) return;
  main.replaceChildren(h('div', { class: 'grid2' }, passwordCard, backupCard), accounts);
}

function ownPasswordCard() {
  const pw = attrs => h('input', { class: 'inp ltr', type: 'password', maxlength: '200', ...attrs });
  const current = pw({ autocomplete: 'current-password' });
  const next = pw({ autocomplete: 'new-password' });
  const repeat = pw({ autocomplete: 'new-password' });
  const error = formError();
  const submit = h('button', { type: 'submit', class: 'btn primary' }, icon('i-lock'), 'تغییر رمز');
  const form = h('form', { class: 'stack', novalidate: true },
    // Lets password managers know which account this is.
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: state.user.username, hidden: true, readonly: true, tabindex: '-1' }),
    error,
    field('رمز فعلی', current),
    h('div', { class: 'grid2' }, field('رمز جدید', next, 'حداقل ۸ حرف'), field('تکرار رمز جدید', repeat)),
    h('div', { class: 'row' }, submit));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    error.hidden = true;
    const problem = !current.value ? [current, 'رمز فعلی را بنویسید']
      : next.value.length < 8 ? [next, 'رمز جدید باید حداقل ۸ حرف باشد']
        : next.value !== repeat.value ? [repeat, 'تکرار رمز با رمز جدید یکی نیست'] : null;
    if (problem) {
      showError(error, problem[1]);
      problem[0].focus();
      return;
    }
    submit.disabled = true;
    try {
      await api('POST', '/api/admin/me/password', { current: current.value, next: next.value });
      current.value = next.value = repeat.value = '';
      toast('رمز عوض شد. اگر در دستگاه دیگری وارد بودید، آنجا از حساب خارج شدید.');
    } catch (err) {
      if (err.status !== 401) showError(error, err.message);
    } finally {
      submit.disabled = false;
    }
  });
  return card({ title: 'تغییر رمز عبور', sub: `حساب ${state.user.displayName} (${state.user.username})` }, form);
}

function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

// The new password is shown as plain text: the owner has to pass it on to the staff member.
function passwordInput() {
  const input = h('input', { class: 'inp ltr grow', type: 'text', maxlength: '200', autocomplete: 'new-password', spellcheck: 'false', autocapitalize: 'none' });
  const wrap = h('div', { class: 'row' }, input, btn('رمز تصادفی', () => {
    input.value = randomPassword();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }, '', 'i-key'));
  return { input, wrap };
}

function newAccountModal(onSaved) {
  const name = h('input', { class: 'inp', maxlength: '60', placeholder: 'مثلاً: منشی کلینیک' });
  const username = h('input', { class: 'inp ltr', maxlength: '40', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'monshi' });
  const pass = passwordInput();
  pass.input.id = `f${++uid}`;
  const error = formError();
  const save = h('button', { type: 'submit', class: 'btn primary' }, icon('i-plus'), 'ساختن حساب');
  const form = h('form', { class: 'stack', novalidate: true },
    error,
    field('اسم', name),
    field('نام کاربری', username, 'فقط حروف کوچک انگلیسی، عدد و . _ - (۳ تا ۴۰ حرف)'),
    h('div', { class: 'field' }, h('label', { class: 'f-label', for: pass.input.id, text: 'رمز' }), pass.wrap,
      h('span', { class: 'f-hint', text: 'حداقل ۸ حرف. این رمز را به پشتیبان بدهید؛ بعد از ورود می‌تواند خودش عوضش کند.' })),
    h('div', { class: 'notice' }, icon('i-info'), 'حساب جدید «پشتیبان» است: داشبورد، گفتگوها و سؤال‌های بی‌جواب را می‌بیند و به کاربرها جواب می‌دهد.'),
    h('div', { class: 'row end' }, btn('انصراف', () => closeModal()), save));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    error.hidden = true;
    const user = username.value.trim().toLowerCase();
    const problem = !name.value.trim() ? [name, 'اسم را بنویسید']
      : !/^[a-z0-9._-]{3,40}$/.test(user) ? [username, 'نام کاربری فقط حروف کوچک انگلیسی، عدد و . _ - (۳ تا ۴۰ حرف)']
        : pass.input.value.length < 8 ? [pass.input, 'رمز باید حداقل ۸ حرف باشد'] : null;
    if (problem) {
      showError(error, problem[1]);
      problem[0].focus();
      return;
    }
    save.disabled = true;
    try {
      await api('POST', '/api/admin/users', { displayName: name.value.trim(), username: user, password: pass.input.value });
      closeModal();
      toast('حساب ساخته شد');
      await onSaved();
    } catch (err) {
      if (err.status !== 401) showError(error, err.message);
    } finally {
      save.disabled = false;
    }
  });
  openModal({ title: 'حساب جدید', body: form });
}

function resetPasswordModal(u) {
  const pass = passwordInput();
  pass.input.id = `f${++uid}`;
  const error = formError();
  const save = h('button', { type: 'submit', class: 'btn primary' }, icon('i-key'), 'ذخیره‌ی رمز');
  const form = h('form', { class: 'stack', novalidate: true },
    error,
    h('div', { class: 'field' }, h('label', { class: 'f-label', for: pass.input.id, text: 'رمز جدید' }), pass.wrap,
      h('span', { class: 'f-hint', text: 'حداقل ۸ حرف. این کاربر همان لحظه از پنل خارج می‌شود و باید با رمز جدید وارد شود.' })),
    h('div', { class: 'row end' }, btn('انصراف', () => closeModal()), save));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    error.hidden = true;
    if (pass.input.value.length < 8) {
      showError(error, 'رمز باید حداقل ۸ حرف باشد');
      pass.input.focus();
      return;
    }
    save.disabled = true;
    try {
      await api('POST', `/api/admin/users/${u.id}/password`, { password: pass.input.value });
      closeModal();
      toast(`رمز ${u.displayName} عوض شد`);
    } catch (err) {
      if (err.status !== 401) showError(error, err.message);
    } finally {
      save.disabled = false;
    }
  });
  openModal({ title: `رمز جدید برای ${u.displayName}`, body: form, narrow: true });
}

// ───────── Chat preview drawer: the visitor page's look, answered by /api/admin/test ─────────
const SAMPLE_NAME = 'سارا';

function buildDrawer() {
  const P = { op: true, msgs: [], typing: false, data: null, session: 0 };
  const opSeg = seg([['yes', 'عمل کرده'], ['no', 'عمل نکرده']], 'yes', key => {
    P.op = key === 'yes';
    resetChat();
  }, 'مراجعه‌کننده‌ی نمونه');
  const cp = h('div', { class: 'cp' });
  const realLink = h('a', { target: '_blank', rel: 'noopener noreferrer', text: 'باز کردن صفحه‌ی واقعی' });
  const closeBtn = iconBtn('i-x', 'بستن', () => closePreview());
  const el = h('div', { class: 'drawer', hidden: true },
    h('div', { class: 'drawer-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'پیش‌نمایش صفحه‌ی چت' },
      h('div', { class: 'drawer-head' }, h('b', { text: 'پیش‌نمایش صفحه‌ی چت' }), opSeg, closeBtn),
      cp,
      h('p', { class: 'drawer-note' }, `از تنظیمات ذخیره‌شده ساخته می‌شود و جواب‌ها از همان دیتابیس می‌آید (اسم نمونه: ${SAMPLE_NAME}). چیزی ذخیره نمی‌شود. `, realLink)));
  el.addEventListener('click', e => { if (e.target === el) closePreview(); });
  document.body.append(el);

  // Parts that never re-render while the drawer is open, so typed text stays.
  const status = h('small', { text: 'آنلاین' });
  const avatar = h('img', { class: 'av', alt: '' });
  const name = h('b');
  const msgs = h('div', { class: 'cp-msgs', role: 'log', 'aria-live': 'polite' });
  const chips = h('div', { class: 'cp-chips' });
  const input = h('input', { maxlength: '500', autocomplete: 'off', placeholder: 'سؤالت رو بنویس…', 'aria-label': 'پیام' });
  const comp = h('form', { class: 'cp-comp' }, input, h('button', { type: 'submit', class: 'cp-send', 'aria-label': 'فرستادن' }, icon('i-send')));
  const sheet = h('div', { class: 'cp-sheet', hidden: true });
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.hidden = true; });
  const head = h('div', { class: 'cp-head' },
    h('span', { class: 'cp-av' }, avatar, h('i', { class: 'dot' })),
    h('div', { class: 'grow' }, name, status),
    h('button', { type: 'button', class: 'cp-ib', 'aria-label': 'راه‌های تماس', onClick: () => { sheet.hidden = false; } }, icon('i-more')));
  comp.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (text && !P.typing) {
      input.value = '';
      ask(text);
    }
  });

  const contactLinks = () => {
    const list = (P.data?.contacts || []).filter(c => c.enabled && c.href);
    if (!list.length) return h('span', { class: 'f-hint', text: 'فعلاً راه تماسی ثبت نشده.' });
    return h('div', { class: 'cp-contacts' }, list.map(c => h('a', {
      class: 'cp-contact', href: c.href, target: c.href.startsWith('http') ? '_blank' : null, rel: 'noopener noreferrer',
    }, icon(contactIcon(c.id)), h('span', { text: c.label }))));
  };

  function drawMsgs() {
    fill(msgs, P.msgs.map(m => h('div', { class: `cp-msg ${m.from}` },
      m.text,
      m.contacts ? contactLinks() : null,
      h('span', { class: 'm' }, clock(m.at), m.from === 'visitor' ? icon('i-ticks') : null))),
    P.typing ? h('div', { class: 'cp-typing', 'aria-label': 'در حال نوشتن' }, h('i'), h('i'), h('i')) : null);
    msgs.scrollTop = msgs.scrollHeight;
    status.textContent = P.typing ? 'داره می‌نویسه…' : 'آنلاین';
  }

  function resetChat() {
    P.session += 1;
    P.typing = false;
    const s = P.data.settings;
    P.msgs = [{ from: 'bot', text: s.welcome.replaceAll('{نام}', SAMPLE_NAME), at: Date.now() }];
    const replies = P.data.quick[P.op ? 'op' : 'not'].filter(q => q.enabled);
    chips.replaceChildren(...replies.map(q => h('button', { type: 'button', class: 'cp-chip', text: q.text, onClick: () => ask(q.text) })));
    chips.hidden = !replies.length;
    sheet.replaceChildren(h('div', { class: 'cp-sheet-card' }, h('b', { text: 'راه‌های تماس با کلینیک' }), contactLinks()));
    sheet.hidden = true;
    drawMsgs();
  }

  async function ask(text) {
    if (P.typing) return;
    const session = P.session;
    P.msgs.push({ from: 'visitor', text, at: Date.now() });
    P.typing = true;
    drawMsgs();
    const started = Date.now();
    try {
      const { answer } = await api('POST', '/api/admin/test', { text });
      await wait(Math.max(0, 650 - (Date.now() - started)));
      if (session !== P.session) return;
      P.msgs.push({ from: 'bot', text: answer.text, contacts: answer.contacts, at: Date.now() });
    } catch (err) {
      if (session === P.session) fail(err);
    } finally {
      if (session === P.session) {
        P.typing = false;
        drawMsgs();
      }
    }
  }

  async function load() {
    P.session += 1;
    cp.replaceChildren(h('div', { class: 'loading', text: 'در حال بارگذاری…' }));
    opSeg.hidden = true;
    realLink.href = chatUrl();
    const session = P.session;
    try {
      const [settings, quick, contacts] = await Promise.all([
        api('GET', '/api/admin/settings'), api('GET', '/api/admin/quick-replies'), api('GET', '/api/admin/contacts'),
      ]);
      if (session !== P.session || el.hidden) return;
      P.data = { settings, quick, contacts: contacts.contacts };
      avatar.src = settings.avatarUrl;
      name.textContent = settings.assistantName;
      input.value = '';
      cp.replaceChildren(head, msgs, chips, comp, sheet);
      opSeg.hidden = false;
      resetChat();
    } catch (err) {
      if (session !== P.session || err.status === 401) return;
      cp.replaceChildren(h('div', { class: 'loading', text: err.message }));
    }
  }

  return { el, load, closeBtn };
}

function openPreview(e) {
  drawer ||= buildDrawer();
  drawer.opener = e?.currentTarget || document.activeElement;
  drawer.el.hidden = false;
  syncInert();
  drawer.closeBtn.focus();
  drawer.load();
}

function closePreview() {
  if (!drawer || drawer.el.hidden) return;
  drawer.el.hidden = true;
  syncInert();
  if (drawer.opener?.isConnected) drawer.opener.focus();
}

// ───────── Start ─────────
async function boot() {
  try {
    await enter();
  } catch (err) {
    if (err.status === 401) return; // the login screen is already up
    if (!(err instanceof ApiError)) console.error(err);
    $('app').replaceChildren(h('main', { class: 'login' }, h('div', { class: 'login-card' },
      h('h1', { text: 'پنل در دسترس نیست' }),
      h('p', { text: err.message }),
      btn('تلاش دوباره', () => {
        $('app').replaceChildren(h('div', { class: 'boot', role: 'status', text: 'در حال بارگذاری…' }));
        boot();
      }, 'primary wide'))));
  }
}

boot();
