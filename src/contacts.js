// The clinic's contact buttons: turns what the owner typed (a number, an id or a link) into a safe link.
import { toLatinDigits } from './validate.js';

export const CONTACT_TYPES = [
  { id: 'phone', label: 'تماس تلفنی' },
  { id: 'whatsapp', label: 'واتس‌اپ' },
  { id: 'instagram', label: 'اینستاگرام' },
  { id: 'rubika', label: 'روبیکا' },
  { id: 'telegram', label: 'تلگرام' },
  { id: 'site', label: 'سایت' },
];

const LABELS = new Map(CONTACT_TYPES.map(t => [t.id, t.label]));
export const contactLabel = id => LABELS.get(id);

const MAX_VALUE = 200;
const HANDLE = /^[A-Za-z0-9._]{1,60}$/;
// Hosts whose own links are accepted as they are; a bare id is turned into a link on the first one.
const HOSTS = {
  instagram: ['instagram.com'],
  rubika: ['rubika.ir'],
  telegram: ['t.me', 'telegram.me'],
};

function parseUrl(text, protocols) {
  try {
    const url = new URL(text);
    return protocols.includes(url.protocol) && url.hostname ? url : null;
  } catch {
    return null;
  }
}

const onHost = (url, hosts) => hosts.some(h => url.hostname === h || url.hostname.endsWith(`.${h}`));

// Digits of a phone number written with spaces, dashes or brackets; null for anything else.
function phoneDigits(text) {
  if (!/^\+?[\d\s\-()]+$/.test(text)) return null;
  const digits = text.replace(/\D/g, '');
  return digits.length >= 3 && digits.length <= 15 ? digits : null;
}

// The link for a contact button, or null when the value is empty or not usable.
export function contactHref(id, value) {
  const text = toLatinDigits(String(value ?? '')).trim();
  if (!text || text.length > MAX_VALUE) return null;
  switch (id) {
    case 'phone': {
      const digits = phoneDigits(text);
      return digits ? `tel:${text.startsWith('+') ? '+' : ''}${digits}` : null;
    }
    case 'whatsapp': {
      if (/^https?:\/\//i.test(text)) return parseUrl(text, ['http:', 'https:'])?.href ?? null;
      let digits = phoneDigits(text);
      if (!digits) return null;
      if (/^09\d{9}$/.test(digits) && !text.startsWith('+')) digits = `98${digits.slice(1)}`;
      else if (digits.startsWith('00')) digits = digits.slice(2); // 0098… (or another country's 00 prefix)
      return digits.length >= 8 && !digits.startsWith('0') ? `https://wa.me/${digits}` : null;
    }
    case 'instagram':
    case 'rubika':
    case 'telegram': {
      if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
        const url = parseUrl(text, ['https:']);
        return url && onHost(url, HOSTS[id]) ? url.href : null;
      }
      const handle = text.replace(/^@/, '');
      return HANDLE.test(handle) ? `https://${HOSTS[id][0]}/${handle}` : null;
    }
    case 'site': {
      const url = parseUrl(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`, ['http:', 'https:']);
      return url && url.hostname.includes('.') && !/\s/.test(text) ? url.href : null;
    }
    default:
      return null;
  }
}

// Why a value cannot be saved, or null when it can (an empty value is fine: that button is just hidden).
export function contactError(id, value) {
  const label = LABELS.get(id);
  if (!label) return 'راه ارتباطی نامعتبر است';
  const text = String(value ?? '').trim();
  if (text.length > MAX_VALUE) return `مقدار «${label}» حداکثر ۲۰۰ حرف است`;
  if (!text || contactHref(id, text)) return null;
  if (id === 'phone') return `شماره «${label}» درست نیست`;
  if (id === 'whatsapp') return `شماره یا لینک «${label}» درست نیست`;
  if (id === 'site') return `لینک «${label}» درست نیست`;
  return `آیدی یا لینک «${label}» درست نیست`;
}

// What the visitor page shows: enabled rows that have a usable link, in the owner's order.
export function publicContacts(rows) {
  return [...rows]
    .filter(r => r.enabled)
    .sort((a, b) => a.sort - b.sort)
    .map(r => ({ id: r.id, label: LABELS.get(r.id), value: r.value, href: contactHref(r.id, r.value) }))
    .filter(r => r.label && r.href);
}
