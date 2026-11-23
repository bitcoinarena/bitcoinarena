// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit h2h a6-1-1: ONE SEAT THAT SIGNS TWO DIFFERENT LOCK-SET VIEWS (views are not slashable, and a seat keeps the first view per key) SPLITS
// THE HONEST SEATS' SIGNED SETS: NO CERTIFICATE FORMS AND THE PAID HEAD-TO-HEAD ROUND IS VOID. Role (b), one seat M of 7 (threshold 5), together
// with an entry C whose stake 4 of the 6 honest seats saw before the close (the #3257 late-lock pattern, or simply a lock some seats verified late).
// After the #3257 fix (uncut views, protocol 33) C drops out alone: 4 views < 5. M now pushes its view {A, B, C} to seats 0-2 and {A, B} to
// seats 3-5 at the close, before any gossip. Seats 0-2 count C in 5 views and sign {A, B, C}; seats 3-5 count it in 4 and sign {A, B}. M signs
// nothing. Neither set reaches 5 signatures: no certificate, the round is VOID for the honest pair A, B (both locked everywhere).
// Safe behaviour: the honest pair A, B (seen at every seat) is certified - one seat's two views must not split the honest committee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LockSetBook } from '../src/lock-set-book.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import * as LS from '../../arena-protocol/src/lock-set.js';

const { lockSetOf, lockSetId, lockSetViewId, LOCK_SET_WINDOW_MS, LOCK_SET_FINAL_AFTER_MS } = LS;
const CLOSE = 1_900_000_000_000;
const rid = new Uint8Array(randomBytes(32));
const hex = () => toHex(new Uint8Array(randomBytes(32)));
const A = hex(), B = hex(), C = hex();
let now = CLOSE + 50;
const seat = (name) => { const secret = new Uint8Array(randomBytes(32)); return { name, secret, pubkey: schnorr.getPublicKey(secret) }; };
const honest = [0, 1, 2, 3, 4, 5].map((i) => seat(`s${i}`));
const m = seat('m');
const committee = [...honest, m].map((s) => s.pubkey);
const contract = { entryCloseMs: BigInt(CLOSE), stakeMsat: 1000n, protocolVersion: 33 };
const books = new Map();
const fetchFn = async (u, o = {}) => {
  const host = new URL(u).host;
  if (host === 'm') { if (o.method === 'POST') return { ok: true, body: null }; const body = JSON.stringify({ views: [], signatures: [] }); return { ok: true, text: async () => body, body: null }; }
  const b = books.get(host);
  if (!b) throw new Error('down');
  if (o.method === 'POST') { b.take(rid, JSON.parse(o.body)); return { ok: true, body: null }; }
  const body = JSON.stringify(b.state(rid));
  return { ok: true, text: async () => body, body: null };
};
function bookOf(s, view) {
  const round = { db: new DatabaseSync(':memory:'), signerNodes: () => committee, now: () => now, pubkey: s.pubkey, identity: { secret: s.secret, pubkey: s.pubkey } };
  const peers = [...honest.map((h) => h.name), 'm'].filter((n) => n !== s.name).map((n) => `http://${n}`);
  const b = new LockSetBook({ round, peersOf: () => peers, roundOf: () => contract, viewOf: () => view, fetchFn });
  books.set(s.name, b);
  return b;
}
const view = (s, entries, atMs) => {
  const set = lockSetOf({ roundId: rid, entries }), setId = lockSetId(set);
  return { key: toHex(s.pubkey), atMs, entries: set.entries.map(toHex), sig: toHex(schnorr.sign(lockSetViewId({ setId, atMs }), s.secret)) };
};
const tick = () => new Promise((ok) => setTimeout(ok, 15));

test('audit h2h a6-1-1: one seat\'s two lock-set views do not void an honest pair seen at every seat', async () => {
  // C's stake seen before the close at honest seats 0-3 only (and at M); A and B at every seat
  const b = honest.map((s, i) => bookOf(s, i < 4 ? [A, B, C] : [A, B]));
  // M, at the close: POST /lock-set to each honest seat - {A, B, C} to seats 0-2, {A, B} to seats 3-5 (two signed views, one key)
  const withC = view(m, [A, B, C], CLOSE + 10), withoutC = view(m, [A, B], CLOSE + 10);
  b.forEach((bk, i) => bk.take(rid, { views: [i < 3 ? withC : withoutC] }));
  for (let i = 0; i < 25; i++) { now += 60; for (const bk of b) await bk.step(rid); await tick(); }
  now = CLOSE + LOCK_SET_WINDOW_MS - 10;
  for (let i = 0; i < 5; i++) { for (const bk of b) await bk.step(rid); await tick(); }
  now = CLOSE + LOCK_SET_WINDOW_MS + LOCK_SET_FINAL_AFTER_MS + 100;
  const facts = b.map((bk, i) => {
    const st = bk.state(rid);
    const mine = (st.signatures || []).find((x) => x.key === toHex(honest[i].pubkey));
    return { seat: i, signed: mine ? mine.entries.length : null, certified: st.entries ? st.entries.length : null, void: st.void };
  });
  console.log('  FACTS:', JSON.stringify(facts));
  const played = b.filter((bk) => { const c = bk.certified(rid); return c && c.entries.includes(A) && c.entries.includes(B); }).length;
  assert.ok(played >= 5, `one seat's two signed views split the honest seats' sets: no certificate, the honest pair's round is VOID: ${JSON.stringify(facts)}`);
});
