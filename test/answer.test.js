import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAnswer, normalize, splitKeywords } from '../src/answer.js';
import { DEFAULT_SETTINGS } from '../src/db.js';

// The two entries the database is seeded with.
const ENTRIES = [
  { id: 1, title: 'آدرس مطب', keywords: 'آدرس، کجاست، نشانی، لوکیشن', answer: 'مطب دکتر در اهواز است.' },
  { id: 2, title: 'قیمت عمل بینی', keywords: 'قیمت، هزینه، تعرفه', answer: 'قیمت عمل بینی ۶۰ میلیون است.' },
];
const NOT_FOUND = DEFAULT_SETTINGS.not_found;
const ask = (text, extra = {}) => findAnswer({ entries: ENTRIES, phrases: DEFAULT_SETTINGS.phrases, notFound: NOT_FOUND, text, ...extra });

test('normalize: digits, letters, diacritics, invisible marks and punctuation', () => {
  assert.equal(normalize('۰۱۲۳۴۵۶۷۸۹ ٠١٢٣٤٥٦٧٨٩'), '0123456789 0123456789');
  assert.equal(normalize('ABC Def'), 'abc def');
  assert.equal(normalize('علي كريمى'), 'علی کریمی');
  assert.equal(normalize('آدرس أحمد إيران'), 'ادرس احمد ایران');
  assert.equal(normalize('مدرسة'), 'مدرسه');
  assert.equal(normalize('مُحَمَّد ـــ سلام'), 'محمد سلام', 'harakat, shadda and tatweel are removed');
  assert.equal(normalize('رحمٰن'), 'رحمن', 'superscript alef is removed');
  assert.equal(normalize('می‌کنید'), 'می کنید', 'ZWNJ becomes a space');
  assert.equal(normalize('«سلام»، خوبی؟! (تست) [x] a-b_c/d\\e;f:g.h,i؛j\'k"l'), 'سلام خوبی تست x a b c d e f g h i j k l');
  assert.equal(normalize('   چند    فاصله \n\t خط  '), 'چند فاصله خط');
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
});

test('splitKeywords: commas, semicolons (Latin and Persian) and new lines', () => {
  assert.deepEqual(splitKeywords('آدرس، کجاست,نشانی ; لوکیشن؛ مسیر\nنقشه\r\n\n ، '), ['آدرس', 'کجاست', 'نشانی', 'لوکیشن', 'مسیر', 'نقشه']);
  assert.deepEqual(splitKeywords(''), []);
  assert.deepEqual(splitKeywords(undefined), []);
});

test('the clinic examples find the right entry', () => {
  let a = ask('آدرس مطب کجاست؟');
  assert.equal(a.kind, 'kb');
  assert.equal(a.entryId, 1);
  assert.equal(a.entryTitle, 'آدرس مطب');
  assert.equal(a.contacts, false);
  assert.equal(a.text, 'قربونت برم، مطب دکتر در اهواز است.');

  a = ask('ادرس');
  assert.equal(a.kind, 'kb');
  assert.equal(a.entryId, 1, 'آ and ا are the same letter after normalize');

  a = ask('قیمت عمل بینی چقدره');
  assert.equal(a.kind, 'kb');
  assert.equal(a.entryId, 2);
  assert.equal(a.text, 'قربونت برم، قیمت عمل بینی ۶۰ میلیون است.');

  assert.equal(ask('هزینه‌اش چنده؟').entryId, 2, 'a keyword inside a longer word still counts');
  assert.equal(ask('لوکیشن رو بفرست').entryId, 1);
});

test('nothing in the database: the not-found message with the contact buttons', () => {
  assert.deepEqual(ask('بیمه قبول می‌کنید؟'), { kind: 'none', text: NOT_FOUND, contacts: true });
  assert.deepEqual(ask('؟؟؟'), { kind: 'none', text: NOT_FOUND, contacts: true });
  assert.deepEqual(ask('بیمه', { entries: [] }), { kind: 'none', text: NOT_FOUND, contacts: true });
});

test('built-in replies: greeting, thanks and asking for a person, in that order of priority', () => {
  assert.deepEqual(ask('سلام'), { kind: 'talk', text: 'سلام به روی ماهت 🌸 من خوبم، تو خوبی؟ بگو ببینم چه سؤالی داری.', contacts: false });
  assert.equal(ask('سلام خوبی؟').kind, 'talk');
  assert.equal(ask('درود').kind, 'talk');
  assert.equal(ask('سلام وقت شما بخیر عزیزم').kind, 'none', 'a greeting with more than 3 words is a question');
  assert.equal(ask('سلامتی').kind, 'none', 'سلام must be a whole word');
  assert.deepEqual(ask('ممنون'), { kind: 'talk', text: 'خواهش می‌کنم عزیزم 🌸 سؤال دیگه‌ای داشتی، همین‌جا بپرس.', contacts: false });
  assert.equal(ask('مرسی از راهنماییتون').kind, 'talk');
  assert.deepEqual(ask('تماس با پشتیبانی'), { kind: 'talk', text: 'حتماً عزیزم 🌸 از هر راهی که برات راحت‌تره با همکارهام در تماس باش:', contacts: true });
  assert.equal(ask('شماره اپراتور').contacts, true);
  assert.equal(ask('سلام، ممنون').text, 'خواهش می‌کنم عزیزم 🌸 سؤال دیگه‌ای داشتی، همین‌جا بپرس.', 'thanks wins over the greeting');
  assert.equal(ask('ممنون، شماره تماس بدید').contacts, true, 'asking for a person wins over thanks');
  assert.equal(ask('سلام، آدرس مطب کجاست؟').kind, 'kb', 'the database wins over built-in replies');
});

test('scoring: +5 per keyword, +3 per title word, +1 per answer word; at least 5 to answer', () => {
  const entries = [{ id: 7, title: 'زمان کشیدن بخیه', keywords: '', answer: 'بخیه‌ها معمولاً هفت روز بعد کشیده می‌شوند.' }];
  // Title words «زمان» and «بخیه» (+3 each) are enough.
  assert.equal(findAnswer({ entries, phrases: '', notFound: 'x', text: 'زمان بخیه' }).kind, 'kb');
  // One title word (+3) is not.
  assert.equal(findAnswer({ entries, phrases: '', notFound: 'x', text: 'زمان' }).kind, 'none');
  // One title word (+3) plus two answer words of 4+ letters (+1 each) reaches 5; «روز» is too short to count.
  assert.equal(findAnswer({ entries, phrases: '', notFound: 'x', text: 'زمان معمولاً کشیده' }).kind, 'kb');
  assert.equal(findAnswer({ entries, phrases: '', notFound: 'x', text: 'زمان معمولاً روز' }).kind, 'none');
  // A title word written with an ending still matches by prefix («بخیه‌هام» → «بخیه»).
  assert.equal(findAnswer({ entries, phrases: '', notFound: 'x', text: 'زمان بخیه‌هام' }).kind, 'kb');
  // A single keyword is enough on its own.
  const kw = [{ id: 8, title: 'x', keywords: 'پانسمان', answer: 'y' }];
  assert.equal(findAnswer({ entries: kw, phrases: '', notFound: 'x', text: 'پانسمان' }).entryId, 8);
  // Stop words and words shorter than 3 letters never score.
  const stop = [{ id: 9, title: 'عمل مطب کلینیک در از', keywords: '', answer: 'است هست برای' }];
  assert.equal(findAnswer({ entries: stop, phrases: '', notFound: 'x', text: 'عمل مطب کلینیک در از است هست برای' }).kind, 'none');
});

test('the highest score wins; ties keep the earlier entry', () => {
  const entries = [
    { id: 1, title: 'مراقبت بعد از عمل', keywords: 'مراقبت', answer: 'استراحت کنید.' },
    { id: 2, title: 'مراقبت پانسمان', keywords: 'مراقبت، پانسمان', answer: 'پانسمان را خیس نکنید.' },
  ];
  assert.equal(findAnswer({ entries, phrases: '', notFound: 'x', text: 'مراقبت پانسمان' }).entryId, 2);
  assert.equal(findAnswer({ entries, phrases: '', notFound: 'x', text: 'مراقبت' }).entryId, 1, 'equal scores: the first entry');
  assert.equal(findAnswer({ entries: [...entries].reverse(), phrases: '', notFound: 'x', text: 'مراقبت' }).entryId, 2);
});

test('phrases go before every other answer, in turn, and are optional', () => {
  const texts = [0, 1, 2, 3, 4, 6].map(i => ask('ادرس', { prefixIndex: i }).text);
  assert.deepEqual(texts, [
    'قربونت برم، مطب دکتر در اهواز است.',
    'مطب دکتر در اهواز است.',
    'الهی بگردم، مطب دکتر در اهواز است.',
    'مطب دکتر در اهواز است.',
    'عزیز دلم، مطب دکتر در اهواز است.',
    'قربونت برم، مطب دکتر در اهواز است.',
  ]);
  assert.equal(ask('ادرس', { phrases: '  یک  \n\n دو \n' , prefixIndex: 2 }).text, 'دو مطب دکتر در اهواز است.', 'blank lines are skipped');
  assert.equal(ask('ادرس', { phrases: '' }).text, 'مطب دکتر در اهواز است.');
  assert.equal(ask('ادرس', { phrases: '\n \n' }).text, 'مطب دکتر در اهواز است.');
  assert.equal(ask('سلام', { prefixIndex: 1 }).text, 'سلام به روی ماهت 🌸 من خوبم، تو خوبی؟ بگو ببینم چه سؤالی داری.', 'built-in replies get no phrase');
});

test('Persian and Arabic spellings and digits in the question match the database', () => {
  const entries = [{ id: 3, title: 'ساعت کاری', keywords: 'ساعت كار، 9 صبح', answer: 'از ۹ صبح تا ۵ عصر.' }];
  assert.equal(findAnswer({ entries, phrases: '', notFound: 'x', text: 'ساعت کار مطب' }).entryId, 3, 'ك in the keyword matches ک');
  assert.equal(findAnswer({ entries, phrases: '', notFound: 'x', text: 'از ۹ صبح باز هستید؟' }).entryId, 3, 'Persian digits match Latin ones');
});

test('small-talk topics answer only when no real topic matches, without a phrase', () => {
  const entries = [
    { id: 1, category: 'احوالپرسی', title: 'سلام', keywords: 'سلام، خوبی، وقت بخیر', answer: 'سلام عزیزم!' },
    { id: 2, category: 'هزینه', title: 'قیمت عمل بینی', keywords: 'قیمت، هزینه', answer: 'حدود ۶۰ میلیون.' },
  ];
  const at = text => findAnswer({ entries, phrases: 'قربونت برم،', notFound: 'x', text, prefixIndex: 0 });
  assert.equal(at('سلام خوبی').text, 'سلام عزیزم!');
  assert.equal(at('سلام وقت بخیر، قیمت عمل چنده؟').entryId, 2);
  assert.equal(at('سلام وقت بخیر، قیمت عمل چنده؟').text, 'قربونت برم، حدود ۶۰ میلیون.');
});
