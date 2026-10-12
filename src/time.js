// Calendar helpers. The clinic counts days on the Asia/Tehran calendar, whatever the server's own zone is.

const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' });
const LABEL = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { timeZone: 'Asia/Tehran', day: 'numeric', month: 'long' });
const STAMP = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', {
  timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// 'YYYY-MM-DD' (Gregorian) of the Tehran calendar day that contains ms.
export function tehranDay(ms) {
  return DAY.format(ms);
}

// e.g. '۲۰ مهر'.
export function jalaliLabel(ms) {
  return LABEL.format(ms);
}

// e.g. '1405/07/20 14:05' with Latin digits, for spreadsheets.
export function jalaliStamp(ms) {
  const p = Object.fromEntries(STAMP.formatToParts(ms).map(x => [x.type, x.value]));
  return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

// The `count` Tehran days ending with the day of `ms`, oldest first: [{ day, label }].
// Steps by calendar date, not by 24 h, so it never skips or repeats a day.
export function lastTehranDays(ms, count) {
  const [y, m, d] = tehranDay(ms).split('-').map(Number);
  const days = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    // 09:00 UTC is midday in Tehran, safely inside that calendar day.
    const noon = Date.UTC(y, m - 1, d - i, 9);
    days.push({ day: tehranDay(noon), label: jalaliLabel(noon) });
  }
  return days;
}
