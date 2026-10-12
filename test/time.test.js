import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jalaliLabel, jalaliStamp, lastTehranDays, tehranDay } from '../src/time.js';

// 2026-10-11 20:45 UTC is 00:15 on 2026-10-12 (20 Mehr 1405) in Tehran (UTC+3:30).
const T = Date.UTC(2026, 9, 11, 20, 45);

test('tehranDay uses the Tehran calendar day, not UTC', () => {
  assert.equal(tehranDay(T), '2026-10-12');
  assert.equal(tehranDay(Date.UTC(2026, 9, 11, 20, 29, 59, 999)), '2026-10-11', 'one millisecond before Tehran midnight');
  assert.equal(tehranDay(Date.UTC(2026, 9, 11, 20, 30)), '2026-10-12', 'Tehran midnight');
});

test('jalaliLabel and jalaliStamp', () => {
  assert.equal(jalaliLabel(T), '۲۰ مهر');
  assert.equal(jalaliStamp(T), '1405/07/20 00:15');
  assert.equal(jalaliStamp(Date.UTC(2026, 2, 20, 12, 0)), '1404/12/29 15:30');
  assert.equal(jalaliLabel(Date.UTC(2026, 2, 21, 12, 0)), '۱ فروردین');
});

test('lastTehranDays: consecutive calendar days ending today, oldest first', () => {
  const days = lastTehranDays(T, 14);
  assert.equal(days.length, 14);
  assert.deepEqual(days[0], { day: '2026-09-29', label: '۷ مهر' });
  assert.deepEqual(days[12], { day: '2026-10-11', label: '۱۹ مهر' });
  assert.deepEqual(days[13], { day: '2026-10-12', label: '۲۰ مهر' });
  for (let i = 1; i < days.length; i += 1) {
    assert.equal(Date.parse(days[i].day) - Date.parse(days[i - 1].day), 24 * 3600 * 1000);
  }
  // Across a month and a year boundary.
  const nowruz = lastTehranDays(Date.UTC(2026, 2, 21, 12), 3).map(d => d.day);
  assert.deepEqual(nowruz, ['2026-03-19', '2026-03-20', '2026-03-21']);
});
