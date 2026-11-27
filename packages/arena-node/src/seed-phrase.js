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
// NFKD without the combining marks, lower case: the one form a word is looked up in (kanban #3819)
const fold = (w) => String(w).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
// each folded word -> the bit set of the lists it is in (bit 0 = English)
const LISTS = new Map();
[BIP39_ENGLISH, ...Object.values(BIP39_OTHER_WORDLISTS)].forEach((list, i) => {
  for (const w of list) { const k = fold(w); LISTS.set(k, (LISTS.get(k) || 0) | (1 << i)); }
});
// the 4-letter prefixes: unique in the BIP39 list by design (a 3- or 4-letter word is its own prefix and is in LISTS already)
const PREFIXES = new Set(BIP39_ENGLISH.filter((w) => w.length > 4).map((w) => w.slice(0, 4)));
const FORMAT = '\\u00AD\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF';
const TOKEN = new RegExp(`\\p{L}(?:[\\p{L}\\p{M}${FORMAT}]*[\\p{L}\\p{M}])?`, 'gu');
const LETTER = /\p{L}/u;
const FORMAT_RE = new RegExp(`[${FORMAT}]`, 'g');
const FORMAT_SPLIT = new RegExp(`[${FORMAT}]+`, 'g');

/** The lists (bit set, bit 0 English) this word is in - any case, accents optional - or the English 4-letter prefix of a word; 0 = no seed word. */
export const seedWordLists = (w) => { const x = fold(w); return (LISTS.get(x) || 0) | (x.length === 4 && PREFIXES.has(x) ? 1 : 0); };
/** Is this word (any case) a BIP39 word of any of the ten lists or the unique 4-letter prefix of an English one? */
export const isSeedWord = (w) => seedWordLists(w) !== 0;

/** The letter words of a text with where each stands: [{ w, s, e }]; a word with format characters inside it read as one word when that makes a seed word. */
function wordsOf(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN)) {
    const plain = m[0].replace(FORMAT_RE, '');
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

/** Where the seed phrases of a text stand: [[start, end], ...] in order, from the first seed word's first letter to the last one's last. */
export function seedRunSpans(text, least = SEED_RUN) {
  const t = String(text ?? '');
  const runs = [];
  let run = [];
  let lists = 0; // the lists that hold every word of the run (kanban #3819)
  for (const x of wordsOf(t)) {
    const m = seedWordLists(x.w);
    x.m = m;
    // a gap of no letter at all joins two seed words (the words between were found as tokens, so any letter there is a word of its own)
    if (m && run.length && !LETTER.test(t.slice(run[run.length - 1].e, x.s))) {
      if (lists & m) { run.push(x); lists &= m; continue; }
      // a word of another list: a whole seed so far stands as it is; else the run goes on from the words before this one that share a list with it
      if (run.length >= least) { runs.push(run); run = [x]; lists = m; continue; }
      let k = run.length;
      let acc = m;
      while (k > 0 && (acc & run[k - 1].m)) { acc &= run[k - 1].m; k--; }
      run = [...run.slice(k), x];
      lists = acc;
      continue;
    }
    if (run.length >= least) runs.push(run);
    run = m ? [x] : [];
    lists = m;
  }
  if (run.length >= least) runs.push(run);
  const spans = [];
  for (const r of runs) {
    // a label word in front ("seed:") is left standing - only while the rest is still a whole seed, so colons between the words hide nothing
    let i = 0;
    while (r.length - i - 1 >= least && labelled(t.slice(r[i].e, r[i + 1].s))) i++;
    spans.push([r[i].s, r[r.length - 1].e]);
  }
  return spans;
}
