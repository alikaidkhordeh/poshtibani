// The answer engine: matches a visitor's question against the clinic's own entries by words and keywords.
// Pure functions, no database and no outside calls; the same input always gives the same answer.

const PUNCTUATION = /[؟?!.,،؛;:«»"'()[\]\-_/\\]/g;

export function normalize(text) {
  return String(text ?? '')
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .toLowerCase()
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[آأإ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u200C-\u200F]/g, ' ')
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitKeywords(text) {
  return String(text ?? '').split(/[,،;؛\r\n]/).map(k => k.trim()).filter(Boolean);
}

// Words too common to tell one topic from another.
const STOP = new Set(`از به با در که را رو این اون ان چی چه کی می تا و یا هم برای چند باید بعد قبل عمل من تو شما هست
  است کنم کنید میشه چطور چجوری چقدر چقدره داره دارم دارید خیلی اگه اگر ولی یه یک ها های بود شد شده کرد کنه لطفا سلام
  مطب کلینیک`.split(/\s+/).map(normalize).filter(Boolean));

const words = s => normalize(s).split(' ').filter(w => w.length >= 3 && !STOP.has(w));

// A word matches a token exactly, or as a prefix either way once the shorter side has 4+ letters
// (so «قیمتش» finds «قیمت» but «می» finds nothing).
const wmatch = (tokens, w) => tokens.some(t => t === w || (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t)));

const MIN_SCORE = 5;

function score(entry, norm, tokens) {
  let total = 0;
  for (const k of new Set(splitKeywords(entry.keywords).map(normalize).filter(Boolean))) {
    // At the start of a word, so «ورم» matches «ورمم» but not «بخورم».
    if (` ${norm}`.includes(` ${k}`)) total += 5;
  }
  for (const w of new Set(words(entry.title))) {
    if (wmatch(tokens, w)) total += 3;
  }
  for (const w of new Set(words(entry.answer).filter(x => x.length >= 4))) {
    if (wmatch(tokens, w)) total += 1;
  }
  return total;
}

const TALK = [
  { test: norm => /پشتیبان|تماس|شماره|اپراتور/.test(norm), text: 'حتماً عزیزم 🌸 از هر راهی که برات راحت‌تره با همکارهام در تماس باش:', contacts: true },
  { test: norm => /ممنون|مرسی|سپاس|تشکر|دستت درد نکنه/.test(norm), text: 'خواهش می‌کنم عزیزم 🌸 سؤال دیگه‌ای داشتی، همین‌جا بپرس.', contacts: false },
  {
    test: (norm, tokens) => /(^| )(سلام|درود|خوبی|چطوری|خسته نباشید)( |$)/.test(norm) && tokens.length <= 4,
    text: 'سلام به روی ماهت 🌸 من خوبم، تو خوبی؟ بگو ببینم چه سؤالی داری.',
    contacts: false,
  },
];

// Topics in this category (greetings, small talk) answer only when no real topic matches, and never get a phrase.
export const SMALL_TALK_CATEGORY = 'احوالپرسی';

// entries: [{ id, title, keywords, answer, category? }] in priority order; phrases: the stored newline-separated
// text. Every other answer (even prefixIndex) starts with one of the phrases, in turn, so they do not repeat
// on every message.
export function findAnswer({ entries, phrases, notFound, text, prefixIndex = 0 }) {
  const norm = normalize(text);
  const tokens = norm.split(' ');
  const pick = list => {
    let best = null;
    let bestScore = 0;
    for (const entry of list) {
      const s = norm ? score(entry, norm, tokens) : 0;
      if (s > bestScore) {
        best = entry;
        bestScore = s;
      }
    }
    return bestScore >= MIN_SCORE ? best : null;
  };
  const isTalk = e => String(e.category ?? '').trim() === SMALL_TALK_CATEGORY;
  const topic = pick(entries.filter(e => !isTalk(e)));
  const best = topic || pick(entries.filter(isTalk));
  if (best) {
    const list = String(phrases ?? '').split('\n').map(p => p.trim()).filter(Boolean);
    const index = Math.abs(Math.trunc(Number(prefixIndex) || 0));
    const phrase = topic && list.length && index % 2 === 0 ? `${list[(index / 2) % list.length]} ` : '';
    return { kind: 'kb', text: phrase + best.answer, contacts: false, entryId: best.id, entryTitle: best.title };
  }
  const rule = TALK.find(r => r.test(norm, tokens));
  if (rule) return { kind: 'talk', text: rule.text, contacts: rule.contacts };
  return { kind: 'none', text: notFound, contacts: true };
}
