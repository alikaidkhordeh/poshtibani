import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTACT_TYPES, contactError, contactHref, publicContacts } from '../src/contacts.js';

test('the six contact types, in order', () => {
  assert.deepEqual(CONTACT_TYPES.map(t => t.id), ['phone', 'whatsapp', 'instagram', 'rubika', 'telegram', 'site']);
  assert.ok(CONTACT_TYPES.every(t => t.label));
});

test('phone: digits and a leading + become a tel: link', () => {
  assert.equal(contactHref('phone', '09123456789'), 'tel:09123456789');
  assert.equal(contactHref('phone', '۰۹۱۲ ۳۴۵-۶۷۸۹'), 'tel:09123456789');
  assert.equal(contactHref('phone', '+98 61 3333 4444'), 'tel:+986133334444');
  assert.equal(contactHref('phone', '(061) 3333-4444'), 'tel:06133334444');
  assert.equal(contactHref('phone', ''), null);
  assert.equal(contactHref('phone', '   '), null);
  assert.equal(contactHref('phone', 'تماس بگیرید'), null);
  assert.equal(contactHref('phone', 'javascript:alert(1)'), null);
  assert.equal(contactHref('phone', '12'), null, 'too short');
  assert.equal(contactHref('phone', '1234567890123456'), null, 'too long');
});

test('whatsapp: a link as is, or an Iranian or international number', () => {
  assert.equal(contactHref('whatsapp', '09123456789'), 'https://wa.me/989123456789');
  assert.equal(contactHref('whatsapp', '۰۹۱۲۳۴۵۶۷۸۹'), 'https://wa.me/989123456789');
  assert.equal(contactHref('whatsapp', '+98 912 345 6789'), 'https://wa.me/989123456789');
  assert.equal(contactHref('whatsapp', '00989123456789'), 'https://wa.me/989123456789');
  assert.equal(contactHref('whatsapp', '989123456789'), 'https://wa.me/989123456789');
  assert.equal(contactHref('whatsapp', 'https://wa.me/989123456789'), 'https://wa.me/989123456789');
  assert.equal(contactHref('whatsapp', 'https://chat.whatsapp.com/AbC123'), 'https://chat.whatsapp.com/AbC123');
  assert.equal(contactHref('whatsapp', 'javascript:alert(1)'), null);
  assert.equal(contactHref('whatsapp', 'wa.me/98912'), null);
  assert.equal(contactHref('whatsapp', '061333'), null, 'a local number cannot be used');
  assert.equal(contactHref('whatsapp', ''), null);
});

test('instagram, rubika and telegram: an id (with or without @) or a link on their own site', () => {
  assert.equal(contactHref('instagram', 'dr.zahedi'), 'https://instagram.com/dr.zahedi');
  assert.equal(contactHref('instagram', '@dr.zahedi'), 'https://instagram.com/dr.zahedi');
  assert.equal(contactHref('instagram', 'https://www.instagram.com/dr.zahedi/'), 'https://www.instagram.com/dr.zahedi/');
  assert.equal(contactHref('instagram', 'https://instagram.com/dr_zahedi'), 'https://instagram.com/dr_zahedi');
  assert.equal(contactHref('instagram', 'https://evil.example/instagram.com'), null);
  assert.equal(contactHref('instagram', 'https://instagram.com.evil.example/x'), null);
  assert.equal(contactHref('instagram', 'http://instagram.com/dr.zahedi'), null, 'only https links');
  assert.equal(contactHref('instagram', 'javascript:alert(1)'), null);
  assert.equal(contactHref('instagram', 'دکتر زاهدی'), null, 'ids are latin letters, digits, . and _');
  assert.equal(contactHref('instagram', 'dr zahedi'), null);
  assert.equal(contactHref('instagram', 'dr/zahedi'), null);
  assert.equal(contactHref('instagram', 'a'.repeat(61)), null);
  assert.equal(contactHref('instagram', '@'), null);

  assert.equal(contactHref('rubika', 'dr_zahedi'), 'https://rubika.ir/dr_zahedi');
  assert.equal(contactHref('rubika', '@dr_zahedi'), 'https://rubika.ir/dr_zahedi');
  assert.equal(contactHref('rubika', 'https://rubika.ir/joinc/ABCDEF'), 'https://rubika.ir/joinc/ABCDEF');
  assert.equal(contactHref('rubika', 'https://t.me/dr_zahedi'), null);

  assert.equal(contactHref('telegram', '@drzahedi'), 'https://t.me/drzahedi');
  assert.equal(contactHref('telegram', 'https://t.me/drzahedi'), 'https://t.me/drzahedi');
  assert.equal(contactHref('telegram', 'https://telegram.me/drzahedi'), 'https://telegram.me/drzahedi');
  assert.equal(contactHref('telegram', 'tg://resolve?domain=x'), null);
  assert.equal(contactHref('telegram', 'https://rubika.ir/x'), null);
});

test('site: http and https only; a missing scheme becomes https', () => {
  assert.equal(contactHref('site', 'https://drzahedi.ir'), 'https://drzahedi.ir/');
  assert.equal(contactHref('site', 'http://drzahedi.ir/about'), 'http://drzahedi.ir/about');
  assert.equal(contactHref('site', 'drzahedi.ir'), 'https://drzahedi.ir/');
  assert.equal(contactHref('site', 'www.drzahedi.ir/fa?x=1'), 'https://www.drzahedi.ir/fa?x=1');
  assert.equal(contactHref('site', 'javascript:alert(1)'), null);
  assert.equal(contactHref('site', 'JavaScript:alert(1)'), null);
  assert.equal(contactHref('site', 'data:text/html,<script>alert(1)</script>'), null);
  assert.equal(contactHref('site', 'ftp://drzahedi.ir'), null);
  assert.equal(contactHref('site', 'سایت ما'), null);
  assert.equal(contactHref('site', 'localhost'), null, 'needs a real domain');
  assert.equal(contactHref('site', ''), null);
});

test('unknown types never get a link', () => {
  assert.equal(contactHref('email', 'a@b.c'), null);
  assert.equal(contactHref('__proto__', 'x'), null);
});

test('contactError: Persian messages for values that cannot be saved; empty is fine', () => {
  assert.equal(contactError('site', 'javascript:alert(1)'), 'لینک «سایت» درست نیست');
  assert.equal(contactError('site', ''), null);
  assert.equal(contactError('site', 'drzahedi.ir'), null);
  assert.match(contactError('phone', 'abc'), /تماس تلفنی/);
  assert.match(contactError('whatsapp', 'abc'), /واتس‌اپ/);
  assert.match(contactError('instagram', 'دکتر'), /اینستاگرام/);
  assert.match(contactError('telegram', 'x'.repeat(201)), /۲۰۰/);
  assert.equal(contactError('email', 'a@b.c'), 'راه ارتباطی نامعتبر است');
  assert.equal(contactError('instagram', 'dr.zahedi'), null);
});

test('publicContacts: enabled rows with a usable link, in sort order', () => {
  const rows = [
    { id: 'site', enabled: 1, value: 'drzahedi.ir', sort: 5 },
    { id: 'phone', enabled: 1, value: '', sort: 0 },
    { id: 'whatsapp', enabled: 0, value: '09123456789', sort: 1 },
    { id: 'instagram', enabled: 1, value: 'dr.zahedi', sort: 2 },
    { id: 'telegram', enabled: 1, value: 'javascript:alert(1)', sort: 4 },
    { id: 'rubika', enabled: 1, value: '@zahedi', sort: 3 },
  ];
  assert.deepEqual(publicContacts(rows), [
    { id: 'instagram', label: 'اینستاگرام', value: 'dr.zahedi', href: 'https://instagram.com/dr.zahedi' },
    { id: 'rubika', label: 'روبیکا', value: '@zahedi', href: 'https://rubika.ir/zahedi' },
    { id: 'site', label: 'سایت', value: 'drzahedi.ir', href: 'https://drzahedi.ir/' },
  ]);
  assert.deepEqual(publicContacts([]), []);
});
