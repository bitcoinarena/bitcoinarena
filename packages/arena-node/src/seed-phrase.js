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
import { BIP39_ENGLISH } from '../../arena-client/src/bip39-wordlist.js';

export const SEED_RUN = 12;
const WORDS = new Set(BIP39_ENGLISH);
// the 4-letter prefixes: unique in the BIP39 list by design (a 3- or 4-letter word is its own prefix and is in WORDS already)
const PREFIXES = new Set(BIP39_ENGLISH.filter((w) => w.length > 4).map((w) => w.slice(0, 4)));
const FORMAT = '\\u00AD\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF';
const TOKEN = new RegExp(`[A-Za-z](?:[A-Za-z${FORMAT}]*[A-Za-z])?`, 'g');
const FORMAT_RE = new RegExp(`[${FORMAT}]`, 'g');
const FORMAT_SPLIT = new RegExp(`[${FORMAT}]+`, 'g');

/** Is this word (any case) a BIP39 word or the unique 4-letter prefix of one? */
export const isSeedWord = (w) => { const x = String(w).toLowerCase(); return WORDS.has(x) || (x.length === 4 && PREFIXES.has(x)); };

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
  const t = String(text ?? '');
  const runs = [];
  let run = [];
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
    const seed = isSeedWord(x.w);
    // a gap of no letter at all joins two seed words (the words between were found as tokens, so any letter there is a word of its own)
    const joined = run.length && !/[A-Za-z]/.test(t.slice(run[run.length - 1].e, x.s));
    if (seed && joined) { run.push(x); continue; }
    // kanban #3820: a typo of a seed word stands in for it, never two in a row
    if (!seed && joined && !run[run.length - 1].typo && isSeedTypo(x.w)) { run.push({ ...x, typo: true }); continue; }
    close();
    run = seed ? [x] : [];
  }
  close();
  const spans = [];
  for (const r of runs) {
    // a label word in front ("seed:") is left standing - only while the rest is still a whole seed, so colons between the words hide nothing
    let i = 0;
    while (r.length - i - 1 >= least && labelled(t.slice(r[i].e, r[i + 1].s))) i++;
    spans.push([r[i].s, r[r.length - 1].e]);
  }
  return spans;
}
