// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYER IS NEVER TOLD "SEAT" (2026-09-15 16:22 and 19:56). The machines that sign a
// round are signer nodes; the player's own place is "joined"; a round that asks no stake is a
// "free round". Measured before this pass: the status chip read "1 player · waiting · free seat"
// and "round named · not seated", the lobby line "2 of 2 seats agree · 0 seated", and the join,
// stake, wallet and donation panels "no seat served a claim key", "asking the seats ...", "this
// seat owes". Protocol field names (seatEntry, seatsAgree, seatedHere) are code, not copy.
//
// EVERY STRING LITERAL COUNTS, because a thrown message or a `why` in this library becomes a line
// on the player's screen - the chip, the lobby hint, a refusal. Comments and the code inside a
// template's `${...}` are not text anybody reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const SEAT = /\bseat(s|ed|ing)?\b/i;
// code, not copy: a module path and a node's door (`/seating?round=`) are never on a screen
const CODE = (s) => /^\.\.?\/[\w./-]+\.js$/.test(s) || /^\s*\/[a-z-]+\?/.test(s);

/** The text of every string literal in a JavaScript source, comments and `${...}` code left out. */
export function stringLiterals(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  // A `/` starts a regular expression where an operand is expected.
  const regexAfter = /[(,=:[!&|?{};+\-*%<>~^]|^$|\breturn$|\btypeof$/;
  const lastToken = () => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (j < 0) return '';
    if (/[A-Za-z_$]/.test(src[j])) { let k = j; while (k >= 0 && /[A-Za-z_$0-9]/.test(src[k])) k--; return src.slice(k + 1, j + 1); }
    return src[j];
  };
  const code = (stopAtBrace) => {
    let depth = 0;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === '\'' || c === '"') { quoted(c); continue; }
      if (c === '`') { template(); continue; }
      if (c === '/' && regexAfter.test(lastToken())) { regex(); continue; }
      if (c === '{') depth++;
      if (c === '}') { if (stopAtBrace && depth === 0) { i++; return; } depth--; }
      i++;
    }
  };
  const quoted = (q) => {
    let s = ''; i++;
    while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; } s += src[i++]; }
    i++; out.push(s);
  };
  const template = () => {
    let s = ''; i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { s += src[i + 1]; i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; code(true); s += ' '; continue; }
      s += src[i++];
    }
    i++; out.push(s);
  };
  const regex = () => {
    i++; let cls = false;
    while (i < n && src[i] !== '\n') {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false; else if (src[i] === '/' && !cls) { i++; break; }
      i++;
    }
    while (i < n && /[a-z]/.test(src[i])) i++;
  };
  code(false);
  return out;
}

test('the scanner reads string text and skips comments and template code', () => {
  const got = stringLiterals("// a seat here is a comment\nconst a = 'free seat'; /* seats */ const b = `x ${c.seatsAgree} y`; const r = /['\"]/; const d = \"seated\";");
  assert.deepEqual(got, ['free seat', 'x   y', 'seated']);
});

test('no string the player can be shown says seat: the client library', () => {
  const dir = new URL('../src/', import.meta.url);
  const hits = [];
  // THE BIP-39 WORDLIST IS NOT COPY. It is the standard English list, fixed by
  // BIP-39 and verified against its published sha256, and one of its 2048 words
  // is "seat". Nobody is shown it as a sentence about a signer node, and it
  // cannot be reworded without breaking every seed phrase ever written down.
  // Scanning it says "player-facing copy still says seat: bip39-wordlist.js:
  // \"seat\"", which is the scanner reading a dictionary.
  const NOT_COPY = new Set(['bip39-wordlist.js']);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js') && !NOT_COPY.has(x))) {
    for (const s of stringLiterals(readFileSync(new URL(f, dir), 'utf8'))) if (SEAT.test(s) && !CODE(s)) hits.push(`${f}: ${JSON.stringify(s.slice(0, 90))}`);
  }
  assert.deepEqual(hits, [], `player-facing copy still says seat:\n${hits.join('\n')}`);
});

test('no string the player can be shown says seat: the page', () => {
  const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  const hits = [];
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const js of scripts) for (const s of stringLiterals(js)) if (SEAT.test(s)) hits.push(`script: ${JSON.stringify(s.slice(0, 90))}`);
  // AND EACH GAME'S PAGE PART (kanban #521): the code and markup lifted out of the page into packages/<game>/page/*-page.js
  const games = new URL('../../', import.meta.url);
  for (const g of readdirSync(games)) {
    let names = []; try { names = readdirSync(new URL(`${g}/page/`, games)).filter((n) => /-page\.js$/.test(n)); } catch { continue; }
    for (const n of names) for (const s of stringLiterals(readFileSync(new URL(`${g}/page/${n}`, games), 'utf8'))) if (SEAT.test(s)) hits.push(`${g}/${n}: ${JSON.stringify(s.slice(0, 90))}`);
  }
  const visible = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  if (SEAT.test(visible)) hits.push(`markup: ${JSON.stringify(visible.match(new RegExp('.{0,40}' + SEAT.source + '.{0,40}', 'i'))[0])}`);
  assert.deepEqual(hits, [], `the page still says seat:\n${hits.join('\n')}`);
});
