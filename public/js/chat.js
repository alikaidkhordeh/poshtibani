// Visitor chat page: a short entry form, then the conversation with the clinic's assistant.
// Everything that comes from the server or the visitor is inserted with textContent; the only markup in this
// file is fixed icon references to the sprite in index.html.

const POLL_MS = 5000;
const MIN_TYPING_MS = 600;
const NEAR_BOTTOM_PX = 120;
const MAX_MESSAGE = 500;
const FALLBACK_AVATAR = '/img/nana.svg';
const NET_ERROR = 'اتصال برقرار نشد؛ دوباره امتحان کن';
const STAFF_LABEL = 'پشتیبان کلینیک';
const NO_CONTACTS = 'فعلاً راه تماسی ثبت نشده.';
const STATUS = { online: 'آنلاین', typing: 'داره می‌نویسه…', offline: 'در حال اتصال…' };
// Same messages as the server (src/app.js), so a client-side check reads exactly like the server's answer.
const MSG = {
  name: 'اسمت رو بنویس',
  nameShort: 'اسمت رو کامل بنویس',
  nameLong: 'اسم حداکثر ۶۰ حرفه',
  phone: 'شماره موبایل باید ۱۱ رقم باشه و با ۰۹ شروع بشه',
  operated: 'یکی از دو گزینه رو انتخاب کن',
  messageLong: 'پیام حداکثر ۵۰۰ حرفه',
};
const CONTACT_ICONS = {
  phone: 'i-phone', whatsapp: 'i-whatsapp', instagram: 'i-instagram', rubika: 'i-rubika', telegram: 'i-telegram', site: 'i-globe',
};
// The server only produces tel: and http(s) links; anything else is dropped rather than trusted.
const SAFE_HREF = /^(tel:\+?\d{3,20}|https?:\/\/[^\s]+)$/i;
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');

const state = {
  config: null,
  visitor: null,
  session: 0, // bumped whenever the visitor changes, so late answers for an old session are ignored
  seen: new Set(),
  cursor: 0, // highest message id fetched by polling; never advanced past messages it has not seen
  sending: false,
  offline: false,
  pollTimer: 0,
  pollRun: null,
  unread: 0,
};

// ───────── Text helpers (mirror src/validate.js) ─────────
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const toFa = value => String(value).replace(/\d/g, d => FA_DIGITS[d]);
const toLatin = value => String(value)
  .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
  .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const cleanText = value => String(value).replace(CONTROL, ' ').replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
  .replace(/\s+/g, ' ').trim();

function cleanMobile(value) {
  let digits = toLatin(value).replace(/[\s\-().\u200c\u200e\u200f]/g, '');
  if (digits.startsWith('+98')) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('0098')) digits = `0${digits.slice(4)}`;
  else if (/^989\d{9}$/.test(digits)) digits = `0${digits.slice(2)}`;
  else if (/^9\d{9}$/.test(digits)) digits = `0${digits}`;
  return /^09\d{9}$/.test(digits) ? digits : '';
}

const firstWord = text => cleanText(text).split(' ')[0] || '';
const pad2 = n => String(n).padStart(2, '0');
const clock = ms => { const d = new Date(ms); return toFa(`${d.getHours()}:${pad2(d.getMinutes())}`); };
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const persianDay = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long' });
const persianDayYear = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', year: 'numeric' });

function dayLabel(ms) {
  const now = Date.now();
  if (dayKey(ms) === dayKey(now)) return 'امروز';
  if (dayKey(ms) === dayKey(now - 864e5)) return 'دیروز';
  return (new Date(ms).getFullYear() === new Date(now).getFullYear() ? persianDay : persianDayYear).format(ms);
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ───────── DOM helpers ─────────
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(id) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

let toastTimer = 0;
function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 3400);
}

// ───────── API ─────────
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError(0, NET_ERROR);
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON: e.g. the tunnel's error page while the app restarts */ }
  if (res.ok && data) return data;
  throw new ApiError(res.ok ? 0 : res.status, data?.error || NET_ERROR);
}

// ───────── Screens ─────────
function showScreen(name) {
  for (const id of ['loading', 'entry', 'chat']) $(id).hidden = id !== name;
  $('app').dataset.screen = name;
}

async function load() {
  showScreen('loading');
  $('loadText').textContent = 'در حال بارگذاری…';
  $('loadRetry').hidden = true;
  $('loading').setAttribute('aria-busy', 'true');
  try {
    const data = await api('GET', '/api/chat/state');
    applyConfig(data.config);
    if (data.visitor) openChat(data.visitor, data.messages || []);
    else showEntry();
  } catch (err) {
    $('loadText').textContent = err.status ? err.message : 'اتصال برقرار نشد؛ اینترنتت رو بررسی کن.';
    $('loadRetry').hidden = false;
    $('loading').removeAttribute('aria-busy');
  }
}

function applyConfig(config) {
  state.config = {
    clinicName: config?.clinicName || '',
    assistantName: config?.assistantName || '',
    welcome: config?.welcome || '',
    avatarUrl: config?.avatarUrl || '',
    quickReplies: { op: config?.quickReplies?.op || [], not: config?.quickReplies?.not || [] },
    contacts: (config?.contacts || []).filter(c => typeof c?.href === 'string' && SAFE_HREF.test(c.href)),
  };
  const { clinicName, assistantName, avatarUrl } = state.config;
  document.title = [assistantName, clinicName].filter(Boolean).join(' | ') || document.title;
  for (const node of document.querySelectorAll('[data-bind="assistant"]')) node.textContent = assistantName;
  for (const node of document.querySelectorAll('[data-bind="clinic"]')) node.textContent = clinicName;
  // Only a same-origin path is used for the avatar; the CSP would block anything else anyway.
  if (/^\/(?!\/)/.test(avatarUrl)) {
    for (const img of document.querySelectorAll('img[data-avatar]')) {
      img.addEventListener('error', () => { img.src = FALLBACK_AVATAR; }, { once: true });
      img.src = avatarUrl;
    }
  }
  renderSheetContacts();
}

function renderSheetContacts() {
  $('sheetContacts').replaceChildren(contactGrid());
  $('sheetLead').hidden = !state.config.contacts.length;
}

function showEntry(message) {
  state.session++;
  state.visitor = null;
  state.sending = false;
  stopPolling();
  closeSheet();
  setTyping(false);
  $('msgs').replaceChildren();
  $('startBtn').disabled = false;
  showScreen('entry');
  $('entry').scrollTop = 0;
  if (message) toast(message);
}

function openChat(visitor, messages) {
  state.session++;
  state.visitor = { firstName: String(visitor?.firstName || ''), operated: visitor?.operated === true };
  state.seen = new Set();
  state.cursor = 0;
  state.unread = 0;
  state.sending = false;
  setOffline(false);
  setBusy(false);
  renderChips();

  const box = $('msgs');
  box.replaceChildren();
  // The greeting is built here from the welcome template and never stored on the server.
  const greeting = state.config.welcome.replaceAll('{نام}', state.visitor.firstName).trim();
  if (greeting) appendNode(bubble({ from: 'bot', text: greeting, at: messages[0]?.at || Date.now() }));
  for (const m of messages) {
    state.cursor = Math.max(state.cursor, m.id);
    if (!state.seen.has(m.id)) {
      state.seen.add(m.id);
      appendNode(bubble(m));
    }
  }
  updateJump();
  showScreen('chat');
  box.scrollTop = box.scrollHeight;
  startPolling();
  // On phones the keyboard would cover the greeting and the quick replies, so focus only with a mouse.
  if (finePointer.matches) $('msgInput').focus();
}

// ───────── Entry form ─────────
const FIELD_ERRORS = { name: 'errName', phone: 'errPhone', operated: 'errOp', form: 'errForm' };

function setError(field, message) {
  const box = $(FIELD_ERRORS[field]);
  box.textContent = message || '';
  box.hidden = !message;
  if (field === 'name') $('fName').setAttribute('aria-invalid', String(!!message));
  if (field === 'phone') $('fPhone').setAttribute('aria-invalid', String(!!message));
  if (field === 'operated') $('opYes').closest('fieldset').classList.toggle('invalid', !!message);
}

function focusField(field) {
  const target = { name: 'fName', phone: 'fPhone', operated: 'opYes' }[field];
  if (target) $(target).focus();
}

// The server answers with a message only; route it to the field it is about.
function fieldOf(message) {
  if (message.startsWith('اسم')) return 'name';
  if (message.includes('موبایل')) return 'phone';
  if (message.includes('گزینه')) return 'operated';
  return 'form';
}

let starting = false;
async function onStart(ev) {
  ev.preventDefault();
  if (starting) return;
  const form = $('entryForm');
  const name = cleanText($('fName').value);
  const phone = cleanMobile($('fPhone').value);
  const operated = form.elements.operated.value;
  const errors = {
    name: !name ? MSG.name : name.length < 2 ? MSG.nameShort : name.length > 60 ? MSG.nameLong : '',
    phone: phone ? '' : MSG.phone,
    operated: operated ? '' : MSG.operated,
  };
  for (const [field, message] of Object.entries(errors)) setError(field, message);
  setError('form', '');
  const invalid = Object.keys(errors).find(field => errors[field]);
  if (invalid) {
    focusField(invalid);
    return;
  }
  starting = true;
  const button = $('startBtn');
  button.disabled = true;
  button.textContent = 'یه لحظه…';
  try {
    const data = await api('POST', '/api/chat/start', { name, phone, operated: operated === 'yes' });
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    openChat(data.visitor || { firstName: firstWord(name), operated: operated === 'yes' }, data.messages || []);
  } catch (err) {
    const field = err.status === 400 ? fieldOf(err.message) : 'form';
    setError(field, err.message);
    focusField(field);
  } finally {
    starting = false;
    button.disabled = false;
    button.textContent = 'تأیید و شروع گفتگو';
  }
}

// ───────── Messages ─────────
const typingEl = el('div', 'typing');
typingEl.setAttribute('aria-hidden', 'true');
typingEl.append(el('i'), el('i'), el('i'));

function contactLink(contact) {
  const link = el('a', 'contact');
  link.href = contact.href;
  if (!contact.href.toLowerCase().startsWith('tel:')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  link.append(icon(CONTACT_ICONS[contact.id] || 'i-link'), el('span', null, contact.label));
  return link;
}

function contactGrid() {
  const contacts = state.config?.contacts || [];
  if (!contacts.length) return el('p', 'no-contacts', NO_CONTACTS);
  const grid = el('div', 'contacts');
  for (const contact of contacts) grid.append(contactLink(contact));
  return grid;
}

function metaRow(at, status) {
  const row = el('div', 'meta');
  const time = el('time', null, clock(at));
  time.dateTime = new Date(at).toISOString();
  row.append(time);
  if (status === 'pending') row.append(icon('i-clock'));
  else if (status === 'sent') row.append(icon('i-ticks'));
  return row;
}

function bubble({ id, from, text, contacts, at }, status) {
  const mine = from === 'visitor';
  const node = el('div', `msg ${mine ? 'user' : 'bot'}${from === 'staff' ? ' staff' : ''}${status === 'pending' ? ' pending' : ''}`);
  if (id) node.dataset.id = String(id);
  node.dataset.at = String(at);
  if (from === 'staff') node.append(el('span', 'who', STAFF_LABEL));
  else node.append(el('span', 'sr-only', mine ? 'شما: ' : `${state.config.assistantName}: `));
  const p = el('p', null, String(text ?? ''));
  p.dir = 'auto';
  node.append(p);
  if (contacts) node.append(contactGrid());
  node.append(metaRow(at, mine ? status || 'sent' : ''));
  return node;
}

function lastBubble() {
  const all = $('msgs').querySelectorAll('.msg');
  return all[all.length - 1] || null;
}

// Appends a bubble (with a day chip when the day changes), always above the typing dots.
function appendNode(node, animate = false) {
  const box = $('msgs');
  const before = typingEl.isConnected ? typingEl : null;
  const day = dayKey(Number(node.dataset.at));
  if (lastBubble()?.dataset.day !== day) {
    box.insertBefore(el('div', 'day', dayLabel(Number(node.dataset.at))), before);
  }
  node.dataset.day = day;
  if (animate && !reducedMotion.matches) node.classList.add('fresh');
  box.insertBefore(node, before);
}

function removeNode(node) {
  node.remove();
  const box = $('msgs');
  const last = [...box.children].filter(c => c !== typingEl).pop();
  if (last?.classList.contains('day')) last.remove();
}

// ───────── Scrolling ─────────
function isNearBottom() {
  const box = $('msgs');
  return box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
}

function scrollToBottom(smooth = true) {
  const box = $('msgs');
  box.scrollTo({ top: box.scrollHeight, behavior: smooth && !reducedMotion.matches ? 'smooth' : 'auto' });
  state.unread = 0;
  updateJump();
}

function updateJump() {
  const show = $('chat').hidden ? false : !isNearBottom();
  $('jump').hidden = !show;
  $('jumpCount').hidden = !state.unread;
  $('jumpCount').textContent = toFa(state.unread);
  if (!show) state.unread = 0;
}

// Messages the visitor did not write: follow them down only when already reading the end of the list.
function showIncoming(messages, animate = true) {
  if (!messages.length) return;
  const near = isNearBottom();
  for (const m of messages) appendNode(bubble(m), animate);
  if (near) scrollToBottom();
  else {
    state.unread += messages.length;
    updateJump();
  }
}

// ───────── Header status, typing, busy ─────────
function updateStatus() {
  $('headStatus').textContent = typingEl.isConnected ? STATUS.typing : state.offline ? STATUS.offline : STATUS.online;
}

function setTyping(on) {
  if (on) {
    const near = isNearBottom();
    $('msgs').append(typingEl);
    if (near) scrollToBottom();
  } else {
    typingEl.remove();
  }
  updateStatus();
}

function setOffline(offline) {
  state.offline = offline;
  updateStatus();
}

// The send button is really disabled (that also blocks Enter); chips are only marked, because disabling a
// focused button would drop keyboard focus. send() ignores them while busy.
function setBusy(busy) {
  $('sendBtn').disabled = busy;
  for (const chip of $('chips').children) chip.setAttribute('aria-disabled', String(busy));
}

function renderChips() {
  const row = $('chips');
  const list = state.visitor.operated ? state.config.quickReplies.op : state.config.quickReplies.not;
  row.replaceChildren(...list.map(text => {
    const chip = el('button', 'chip', text);
    chip.type = 'button';
    chip.addEventListener('click', () => send(text, false));
    return chip;
  }));
  row.hidden = !list.length;
  row.scrollLeft = 0;
}

// ───────── Sending ─────────
async function send(raw, typed) {
  const text = cleanText(raw);
  if (!text || state.sending || !state.visitor) return;
  const input = $('msgInput');
  if (text.length > MAX_MESSAGE) {
    toast(MSG.messageLong);
    return;
  }
  const session = state.session;
  state.sending = true;
  setBusy(true);
  if (typed) input.value = '';

  const pending = bubble({ from: 'visitor', text, at: Date.now() }, 'pending');
  appendNode(pending, true);
  setTyping(true);
  scrollToBottom();
  const startedAt = performance.now();

  try {
    // A poll and a send never overlap, so neither can show the other's messages early or twice.
    if (state.pollRun) await state.pollRun;
    if (session !== state.session) return;
    const data = await api('POST', '/api/chat/send', { text });
    if (session !== state.session) return;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    for (const m of messages) state.seen.add(m.id);
    const mine = messages.find(m => m.from === 'visitor');
    const replies = messages.filter(m => m !== mine);
    if (mine) {
      pending.dataset.id = String(mine.id);
      pending.querySelector('.meta').replaceWith(metaRow(mine.at, 'sent'));
    } else {
      pending.querySelector('.meta').replaceWith(metaRow(Date.now(), 'sent'));
    }
    pending.classList.remove('pending');
    setOffline(false);

    // Keep the dots up a moment, a little longer for a long answer, so the reply does not feel canned.
    const length = replies.reduce((n, m) => n + String(m.text || '').length, 0);
    const wait = Math.min(1400, MIN_TYPING_MS + length * 3) - (performance.now() - startedAt);
    if (wait > 0) await delay(wait);
    if (session !== state.session) return;
    setTyping(false);
    showIncoming(replies);
  } catch (err) {
    if (session !== state.session) return;
    setTyping(false);
    removeNode(pending);
    if (err.status === 401) {
      showEntry(err.message);
      return;
    }
    // Keep what the visitor wrote so one tap sends it again.
    if (typed && !input.value) input.value = text;
    toast(err.message);
  } finally {
    if (session === state.session) {
      state.sending = false;
      setBusy(false);
      if (!document.hidden && !state.pollTimer && !state.pollRun) schedulePoll(POLL_MS);
    }
  }
}

// ───────── Polling (also the "online" heartbeat for the admin panel) ─────────
function schedulePoll(ms) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(() => {
    state.pollTimer = 0;
    poll();
  }, ms);
}

function startPolling() {
  stopPolling();
  if (!document.hidden) schedulePoll(POLL_MS);
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = 0;
}

function poll() {
  if (!state.visitor || document.hidden) return;
  if (state.sending || state.pollRun) {
    schedulePoll(POLL_MS);
    return;
  }
  const session = state.session;
  state.pollRun = (async () => {
    try {
      const data = await api('GET', `/api/chat/messages?after=${state.cursor}`);
      if (session !== state.session) return;
      setOffline(false);
      const fresh = [];
      for (const m of Array.isArray(data.messages) ? data.messages : []) {
        state.cursor = Math.max(state.cursor, m.id);
        if (state.seen.has(m.id)) continue;
        state.seen.add(m.id);
        fresh.push(m);
      }
      showIncoming(fresh);
    } catch (err) {
      if (session !== state.session) return;
      if (err.status === 401) showEntry(err.message);
      else setOffline(true);
    }
  })().finally(() => {
    state.pollRun = null;
    if (session === state.session && state.visitor && !document.hidden && !state.pollTimer) schedulePoll(POLL_MS);
  });
}

// ───────── Contacts sheet ─────────
function openSheet() {
  const sheet = $('sheet');
  if (sheet.open) return;
  renderSheetContacts();
  sheet.showModal();
}

function closeSheet() {
  const sheet = $('sheet');
  if (sheet.open) sheet.close();
}

// ───────── Viewport (on-screen keyboard) ─────────
// iOS Safari shrinks only the visual viewport when the keyboard opens and pans it over the page; sizing the
// fixed shell to the visual viewport keeps the header visible and the composer right above the keyboard.
function fitViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv || vv.scale > 1.01) {
    root.classList.remove('vv'); // pinch zoom: leave the normal layout alone
    return;
  }
  root.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
  root.style.setProperty('--app-y', `${Math.round(vv.offsetTop)}px`);
  root.classList.add('vv');
}

let stickToBottom = true;
function bindViewport() {
  const vv = window.visualViewport;
  fitViewport();
  if (vv) {
    vv.addEventListener('resize', fitViewport);
    vv.addEventListener('scroll', fitViewport);
  }
  window.addEventListener('resize', fitViewport);

  // When the list gets shorter (keyboard opening, chips appearing), stay at the newest message if the
  // visitor was already there.
  const box = $('msgs');
  box.addEventListener('scroll', () => {
    stickToBottom = isNearBottom();
    if (stickToBottom && !$('jump').hidden) {
      state.unread = 0;
      updateJump();
    } else if (!stickToBottom && $('jump').hidden) {
      updateJump();
    }
  }, { passive: true });
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => { if (stickToBottom) box.scrollTop = box.scrollHeight; }).observe(box);
  }

  // Keep the focused form field in view above the keyboard on phones.
  $('entry').addEventListener('focusin', ev => {
    if (finePointer.matches || !(ev.target instanceof HTMLInputElement) || ev.target.type === 'radio') return;
    setTimeout(() => ev.target.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'auto' : 'smooth' }), 320);
  });
}

// ───────── Wiring ─────────
function bind() {
  const form = $('entryForm');
  form.addEventListener('submit', onStart);
  $('fName').addEventListener('input', () => setError('name', ''));
  $('fPhone').addEventListener('input', () => setError('phone', ''));
  for (const radio of form.elements.operated) radio.addEventListener('change', () => setError('operated', ''));
  // Enter in the name field moves on instead of submitting a half-filled form.
  $('fName').addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      $('fPhone').focus();
    }
  });

  // Tapping send must not take focus from the input, or the phone keyboard closes after every message.
  // mousedown covers desktop and Android; where a tap still blurs the input (iOS), it is focused again
  // inside the same tap, which keeps the keyboard up.
  const input = $('msgInput');
  let inputBlurAt = 0;
  input.addEventListener('blur', () => { inputBlurAt = performance.now(); });
  $('sendBtn').addEventListener('mousedown', ev => {
    if (document.activeElement === input) ev.preventDefault();
  });
  $('composer').addEventListener('submit', ev => {
    ev.preventDefault();
    if (document.activeElement !== input && performance.now() - inputBlurAt < 500) input.focus();
    send(input.value, true);
  });

  $('moreBtn').addEventListener('click', openSheet);
  $('sheetClose').addEventListener('click', closeSheet);
  // A click on the dialog element itself (not on the card) is a click on the dimmed backdrop.
  $('sheet').addEventListener('click', ev => { if (ev.target === ev.currentTarget) closeSheet(); });
  $('jump').addEventListener('click', () => scrollToBottom());
  $('loadRetry').addEventListener('click', load);

  document.addEventListener('visibilitychange', () => {
    if (!state.visitor) return;
    if (document.hidden) stopPolling();
    else schedulePoll(0);
  });
  window.addEventListener('online', () => { if (state.visitor && !document.hidden) schedulePoll(0); });
  window.addEventListener('pageshow', ev => { if (ev.persisted && state.visitor) schedulePoll(0); });
}

bind();
bindViewport();
load();
