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

/** Where the seed phrases of a text stand: [[start, end], ...] in order, from the first seed word's first letter to the last one's last. */
export function seedRunSpans(text, least = SEED_RUN) {
  // kanban #3818: searched in the folded copy; the spans answered are mapped back to the original text
  const { f: t, s: from, e: to } = fold(String(text ?? ''));
  const runs = [];
  let run = [];
  for (const x of wordsOf(t)) {
    const seed = isSeedWord(x.w);
    // a gap of no letter at all joins two seed words (the words between were found as tokens, so any letter there is a word of its own)
    if (seed && run.length && !/[A-Za-z]/.test(t.slice(run[run.length - 1].e, x.s))) { run.push(x); continue; }
    if (run.length >= least) runs.push(run);
    run = seed ? [x] : [];
  }
  if (run.length >= least) runs.push(run);
  const spans = [];
  for (const r of runs) {
    // a label word in front ("seed:") is left standing - only while the rest is still a whole seed, so colons between the words hide nothing
    let i = 0;
    while (r.length - i - 1 >= least && labelled(t.slice(r[i].e, r[i + 1].s))) i++;
    spans.push([from[r[i].s], to[r[r.length - 1].e - 1]]);
  }
  return spans;
}
