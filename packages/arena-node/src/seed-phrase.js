// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE RULE FOR A SEED PHRASE IN TEXT (kanban #1472, #1737, #1799, #1843, #1858; refute of hexbox #005): the feedback store, the faucet's chat post
// (both through feedback-store.js scrubKeys) and the node's log lines (log-level.js redact) all find a seed with this one function, so the copies
// never disagree again. A seed is a run of SEED_RUN (12) or more BIP39 words in a row:
//   - in any case; a word may also be written as its 4-letter BIP39 prefix ("aban abil able ..." - each prefix names exactly one word, the form steel
//     backups and many wallets use);
//   - the words are split by anything that is no letter: spaces, tabs, new lines, list numbers in any layout ("1 abandon", "1.", "(1)", "#1", "1-"),
//     punctuation, quotes and brackets (a JSON array), dots, underscores, plus signs, zero-width spaces;
//   - an invisible format character (zero-width space/joiner, word joiner, soft hyphen, BOM) inside a word does not hide it: it is read without them.
// Only BIP39 words count, and any other word between two of them ends the run, so an ordinary sentence stays.
// A mistyped seed word (kanban #3820, bypass of #1472): a word of 3-8 letters one edit (a letter changed, added, dropped, or two neighbours swapped)
// from a BIP39 word joins the run in its place, so one typo no longer splits a seed into two short runs that both stay ("absnet" for "absent": at most
// 2048 guesses and the checksum rebuild the wallet). Such words never start or end a run, never stand two in a row, and are at most one in six of
// it (two in a 12-word seed); a run with more of them counts only its parts of true seed words.
// ALL TEN BIP39 LISTS (kanban #3819, a way round #1472): a wallet set to Italian, Spanish, French, Czech, Portuguese, Japanese, Korean or Chinese
// writes its seed in that list, and the English-only word set and the A-Z-only TOKEN kept such a seed in the report row and the chat post. Now:
//   - a word is read in Unicode letters (\p{L}, with the combining marks \p{M} of a decomposed letter inside it), and looked up NFKD with the marks
//     taken off, so an accent is optional ("cadáver" = "cadaver", as typed on a keyboard without one) - the same on the list side;
//   - a run is one list's words (a real seed is in one language): each word carries the set of lists it is in, and the run keeps going only while
//     one list holds every word of it, so twelve common words from different languages in a row are no seed;
//   - the ideographic space U+3000 of a Japanese seed is no letter, so it parts words like any space;
//   - the 4-letter prefix form stays the English list's (the steel-backup form for that list; the other lists make no such promise).
// A Chinese seed is found when its characters are parted (space, comma, list numbers), the way wallets show it; an unbroken line of Han
// characters is read as one word, since ordinary Chinese text is made of the very characters of that list.
import { BIP39_ENGLISH } from '../../arena-client/src/bip39-wordlist.js';
import { BIP39_OTHER_WORDLISTS } from './bip39-wordlists.js';

export const SEED_RUN = 12;
const WORDS = new Set(BIP39_ENGLISH);   // the English list: a run-together seed is split into its words (kanban #3818)
// NFKD without the combining marks, lower case: the one form a word is looked up in (kanban #3819)
const foldWord = (w) => String(w).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
// each folded word -> the bit set of the lists it is in (bit 0 = English)
const LISTS = new Map();
[BIP39_ENGLISH, ...Object.values(BIP39_OTHER_WORDLISTS)].forEach((list, i) => {
  for (const w of list) { const k = foldWord(w); LISTS.set(k, (LISTS.get(k) || 0) | (1 << i)); }
});
// the 4-letter prefixes: unique in the BIP39 list by design (a 3- or 4-letter word is its own prefix and is in LISTS already)
const PREFIXES = new Set(BIP39_ENGLISH.filter((w) => w.length > 4).map((w) => w.slice(0, 4)));
const FORMAT = '\\u00AD\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF';
const TOKEN = new RegExp(`\\p{L}(?:[\\p{L}\\p{M}${FORMAT}]*[\\p{L}\\p{M}])?`, 'gu');
const LETTER = /\p{L}/u;
const FORMAT_RE = new RegExp(`[${FORMAT}]`, 'g');
const FORMAT_SPLIT = new RegExp(`[${FORMAT}]+`, 'g');

/** The lists (bit set, bit 0 English) this word is in - any case, accents optional - or the English 4-letter prefix of a word; 0 = no seed word. */
export const seedWordLists = (w) => { const x = foldWord(w); return (LISTS.get(x) || 0) | (x.length === 4 && PREFIXES.has(x) ? 1 : 0); };
/** Is this word (any case) a BIP39 word of any of the ten lists or the unique 4-letter prefix of an English one? */
export const isSeedWord = (w) => seedWordLists(w) !== 0;

// KANBAN #3818 (bypass of #1472): a seed typed with an IME in wide mode ("ａｂａｎｄｏｎ ａｂｉｌｉｔｙ ...") gave no ASCII token at all, and one written
// with the words run together ("AbandonAbilityAble...") was one long token that is no seed word - both stayed readable. Now the text is searched as
// a folded copy: every code point whose NFKC form is one ASCII letter (full-width, mathematical, circled ... letters) and the common Cyrillic/Greek
// look-alikes are read as that letter, with a map back to where each stands in the original, so the span cut is still the original's. A letter run
// that is no seed word is split into BIP39 words when it is made of them and nothing else (the shortest such split).
const LOOKALIKE = { а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ӏ: 'l', ԛ: 'q', ԝ: 'w',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S',
  α: 'a', ο: 'o', ν: 'v', ι: 'i', κ: 'k', ρ: 'p', τ: 't', υ: 'u', Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X' };
/** The text folded to ASCII letters where a letter is meant: { f, s, e } - f the folded text, s[i] / e[i] where its i-th unit starts / ends in the original. */
function fold(text) {
  let f = ''; const s = []; const e = [];
  let i = 0;
  for (const c of text) {
    let out = c;
    if (c.charCodeAt(0) > 0x7F) { const n = c.normalize('NFKC'); out = /^[A-Za-z]$/.test(n) ? n : (LOOKALIKE[c] || c); }
    for (let k = 0; k < out.length; k++) { s.push(i); e.push(i + c.length); }
    f += out; i += c.length;
  }
  return { f, s, e };
}
const MAX_WORD = Math.max(...BIP39_ENGLISH.map((w) => w.length));
/** A letter run made only of BIP39 words, as those words (fewest pieces; each a whole word, at least 3 letters); null when it is not. */
function splitRun(x) {
  if (x.length < 6 || x.length > 8 * 48) return null;
  const best = new Array(x.length + 1).fill(null); best[0] = [];
  for (let i = 0; i < x.length; i++) {
    if (!best[i]) continue;
    for (let l = 3; l <= MAX_WORD && i + l <= x.length; l++) {
      if (!WORDS.has(x.slice(i, i + l))) continue;
      const next = [...best[i], [i, i + l]];
      if (!best[i + l] || best[i + l].length > next.length) best[i + l] = next;
    }
  }
  const r = best[x.length];
  return r && r.length >= 2 ? r : null;
}

/** The letter words of a text with where each stands: [{ w, s, e }]; a word with format characters inside it read as one word when that makes a seed word. */
function wordsOf(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN)) {
    const plain = m[0].replace(FORMAT_RE, '');
    // kanban #3818: a run-together seed ("AbandonAbilityAble...") - each BIP39 word in it is a word of its own
    const parts = plain.length === m[0].length && !isSeedWord(plain) ? splitRun(plain.toLowerCase()) : null;
    if (parts) { for (const [a, b] of parts) out.push({ w: plain.slice(a, b).toLowerCase(), s: m.index + a, e: m.index + b }); continue; }
    if (plain.length === m[0].length || isSeedWord(plain)) { out.push({ w: plain.toLowerCase(), s: m.index, e: m.index + m[0].length }); continue; }
    // the format characters split words here ("abandon<ZWSP>ability"): each part is a word of its own
    let at = 0;
    for (const part of m[0].split(FORMAT_SPLIT)) {
      const s = m[0].indexOf(part, at);
      if (part) out.push({ w: part.toLowerCase(), s: m.index + s, e: m.index + s + part.length });
      at = s + part.length;
    }
  }
  return out;
}

// a colon that is no list number's ("3:") after a word: a label naming what follows ("my seed: abandon ...", '"seed":"abandon ...')
const labelled = (gap) => gap.replace(/\d\s*:/g, '').includes(':');

// kanban #3820: is this non-seed word (lower case) one edit from a BIP39 word? Damerau-Levenshtein distance 1, checked only against words of length +-1.
const BY_LEN = new Map();
for (const w of BIP39_ENGLISH) { if (!BY_LEN.has(w.length)) BY_LEN.set(w.length, []); BY_LEN.get(w.length).push(w); }
function oneEdit(a, b) {
  if (a === b) return false;
  if (a.length === b.length) {
    let i = 0; while (a[i] === b[i]) i++;
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // one letter changed
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // two neighbours swapped
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  if (l.length - s.length !== 1) return false;
  let i = 0; while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1); // one letter added or dropped
}
export const isSeedTypo = (w) => {
  const x = String(w).toLowerCase();
  if (x.length < 3 || x.length > 8 || isSeedWord(x)) return false;
  for (const n of [x.length - 1, x.length, x.length + 1]) for (const b of BY_LEN.get(n) || []) if (oneEdit(x, b)) return true;
  return false;
};

/** Where the seed phrases of a text stand: [[start, end], ...] in order, from the first seed word's first letter to the last one's last. */
export function seedRunSpans(text, least = SEED_RUN) {
  // kanban #3818: searched in the folded copy; the spans answered are mapped back to the original text
  const { f: t, s: from, e: to } = fold(String(text ?? ''));
  const runs = [];
  let run = [];
  let lists = 0; // the lists that hold every word of the run (kanban #3819)
  // kanban #3820: a run ends here; typos at its end are dropped, and a run with more than one typo in six words counts only its true seed parts
  const close = () => {
    while (run.length && run[run.length - 1].typo) run.pop();
    const typos = run.filter((x) => x.typo).length;
    if (run.length >= least && typos * 6 <= run.length) runs.push(run);
    else if (typos) {
      let part = [];
      for (const x of [...run, { typo: true }]) { if (!x.typo) { part.push(x); continue; } if (part.length >= least) runs.push(part); part = []; }
    }
  };
  for (const x of wordsOf(t)) {
    const m = seedWordLists(x.w);
    x.m = m;
    // a gap of no letter at all joins two seed words (the words between were found as tokens, so any letter there is a word of its own)
    const joined = run.length && !LETTER.test(t.slice(run[run.length - 1].e, x.s));
    if (m && joined) {
      if (lists & m) { run.push(x); lists &= m; continue; }
      // kanban #3819: a word of another list: a whole seed so far stands as it is; else the run goes on from the words before this one that
      // share a list with it (a typo of #3820 stands for a word of the run's lists, and never starts a run)
      if (run.length >= least) { close(); run = [x]; lists = m; continue; }
      let k = run.length;
      let acc = m;
      while (k > 0 && (acc & run[k - 1].m)) { acc &= run[k - 1].m; k--; }
      while (k < run.length && run[k].typo) k++;
      run = [...run.slice(k), x];
      lists = acc;
      continue;
    }
    // kanban #3820: a typo of a seed word stands in for it, never two in a row; it keeps the run's lists
    if (!m && joined && !run[run.length - 1].typo && isSeedTypo(x.w)) { run.push({ ...x, typo: true, m: lists }); continue; }
    close();
    run = m ? [x] : [];
    lists = m;
  }
  close();
  const spans = [];
  for (const r of runs) {
    // a label word in front ("seed:") is left standing - only while the rest is still a whole seed, so colons between the words hide nothing
    let i = 0;
    while (r.length - i - 1 >= least && labelled(t.slice(r[i].e, r[i + 1].s))) i++;
    spans.push([from[r[i].s], to[r[r.length - 1].e - 1]]);
  }
  return spans;
}
