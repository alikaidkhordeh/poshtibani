// Input cleaning shared by the API handlers. Every helper throws an HttpError with a Persian message.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = message => new HttpError(400, message);

export function toLatinDigits(value) {
  return String(value)
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));
}

export function faDigits(value) {
  return String(value).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

// Arabic yeh/kaf typed on Arabic keyboards → the Persian letters, so names and searches match.
export function persianLetters(text) {
  return String(text).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
}

// Control characters other than tab and newline never belong in stored text.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function checkLength(text, { field, required, max, min = 0, messages = {} }) {
  if (required && !text) throw bad(messages.required || `${field} را وارد کنید`);
  if (text && text.length < min) throw bad(messages.min || messages.required || `${field} خیلی کوتاه است`);
  if (text.length > max) throw bad(messages.max || `${field} حداکثر ${faDigits(max)} حرف است`);
  return text;
}

// One-line text: all whitespace runs (newlines included) become one space.
export function cleanText(value, { field, required = false, max = 200, min = 0, messages } = {}) {
  const text = typeof value === 'string' || typeof value === 'number'
    ? persianLetters(String(value).replace(CONTROL, ' ')).replace(/\s+/g, ' ').trim()
    : '';
  return checkLength(text, { field, required, max, min, messages });
}

// Multi-line text (welcome message, answers, notes): keeps line breaks, trims each line's ends and allows
// at most one empty line between paragraphs.
export function cleanMultiline(value, { field, required = false, max = 1000, messages } = {}) {
  const text = typeof value === 'string' || typeof value === 'number'
    ? persianLetters(String(value))
      .replace(/\r\n?|[\u2028\u2029]/g, '\n')
      .replace(CONTROL, ' ')
      .split('\n').map(line => line.trim()).join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    : '';
  return checkLength(text, { field, required, max, messages });
}

// Iranian mobile numbers in any common spelling → 09xxxxxxxxx.
export function cleanMobile(value) {
  let digits = toLatinDigits(String(value ?? '')).replace(/[\s\-().\u200c\u200e\u200f]/g, '');
  if (digits.startsWith('+98')) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('0098')) digits = `0${digits.slice(4)}`;
  else if (/^989\d{9}$/.test(digits)) digits = `0${digits.slice(2)}`;
  else if (/^9\d{9}$/.test(digits)) digits = `0${digits}`;
  if (!/^09\d{9}$/.test(digits)) throw bad('شماره موبایل باید ۱۱ رقم باشه و با ۰۹ شروع بشه');
  return digits;
}

export function cleanId(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, 'پیدا نشد');
  return n;
}

// Integer query parameter clamped to [min, max]; anything unparsable gives the fallback.
export function intParam(value, { fallback, min, max }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
