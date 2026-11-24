// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit h2h a7-1-1: A STRANGER'S GET /lock-set OVER 513 OTHER ROUNDS EVICTS A LIVE ROUND'S ROOM (LockSetBook #room keeps 512, FIFO), AND THE SEAT
// THEN SIGNS A SECOND, DIFFERENT VIEW OF ITS OWN (#ownView is not kept: it is made again from viewOf "now"). Since #3347 a second view of one key
// over another set is that key's equivocation at every peer: the honest seat's view stops counting everywhere. Three honest seats so treated leave
// 4 views of 7 (< threshold 5): no seat signs, no certificate, the paid head-to-head round is VOID - an honest pair seen at every seat refunded.
// The view of an honest seat changes inside the window by itself whenever a stake lock handed before the close is verified after it (the /lock
// door keeps the door time as the lock's verified time, kanban #1805: live locks take 2.2-2.7 s); a borderline entry (seen at 3 of 7 seats) holds
// every seat's signature to close + LOCK_SET_VIEW_WAIT_MS (#3347), so the eviction lands before anyone signed.
// Safe behaviour: the honest pair A, B (seen at every seat) is certified; a stranger's reads of other rounds do not make honest seats equivocate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LockSetBook } from '../src/lock-set-book.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import * as LS from '../../arena-protocol/src/lock-set.js';

const { LOCK_SET_WINDOW_MS, LOCK_SET_FINAL_AFTER_MS } = LS;
const CLOSE = 1_900_000_000_000;
const hex = () => toHex(new Uint8Array(randomBytes(32)));
const tick = () => new Promise((ok) => setTimeout(ok, 15));

async function play({ evict, late = true }) {
  const rid = new Uint8Array(randomBytes(32));
  const A = hex(), B = hex(), D = hex(), E = hex();
  let now = CLOSE + 50;
  const seat = (name) => { const secret = new Uint8Array(randomBytes(32)); return { name, secret, pubkey: schnorr.getPublicKey(secret) }; };
  const seats = [0, 1, 2, 3, 4, 5, 6].map((i) => seat(`s${i}`));
  const committee = seats.map((s) => s.pubkey);
  const contract = { entryCloseMs: BigInt(CLOSE), stakeMsat: 1000n, protocolVersion: 33 };
  const books = new Map();
  const fetchFn = async (u, o = {}) => {
    const b = books.get(new URL(u).host);
    if (!b) throw new Error('down');
    if (o.method === 'POST') { b.take(rid, JSON.parse(o.body)); return { ok: true, body: null }; }
    const body = JSON.stringify(b.state(rid));
    return { ok: true, text: async () => body, body: null };
  };
  // seats 0-2: A, B and D (D's stake seen before the close at these 3 only: a borderline entry, every seat waits the view wait); E's stake lock was
  // handed to them just before the close and its federation check ends at close + 600 ms - its door time is before the close, so from then on
  // viewOf (stakeSeen.seenMs < close) names it. Seats 3-6: A and B.
  const viewOf = (i) => () => (i < 3 ? (now < CLOSE + 600 || !late ? [A, B, D] : [A, B, D, E]) : [A, B]);
  // every honest seat holds the round's contract; any other paid protocol-33 head-to-head round is answered the same (the grid's past rounds)
  const b = seats.map((s, i) => {
    const round = { db: new DatabaseSync(':memory:'), signerNodes: () => committee, now: () => now, pubkey: s.pubkey, identity: { secret: s.secret, pubkey: s.pubkey } };
    const peers = seats.map((x) => x.name).filter((n) => n !== s.name).map((n) => `http://${n}`);
    const bk = new LockSetBook({ round, peersOf: () => peers, roundOf: () => contract, viewOf: viewOf(i), fetchFn });
    books.set(s.name, bk);
    return bk;
  });
  for (let i = 0; i < 11; i++) { now += 60; for (const bk of b) await bk.step(rid); await tick(); }   // to close + 710 ms: views made and gossiped
  const signedBefore = b.filter((bk, i) => (bk.state(rid).signatures || []).some((x) => x.key === toHex(seats[i].pubkey))).length;
  // THE STRANGER: GET /lock-set?round=<id> for 513 other rounds at seats 0-2 (server.js answers lockSets.state(rid) for any round it holds)
  if (evict) for (const i of [0, 1, 2]) for (let k = 0; k < 513; k++) b[i].state(new Uint8Array(randomBytes(32)));
  for (let i = 0; i < 30; i++) { now = Math.min(now + 60, CLOSE + LOCK_SET_WINDOW_MS - 10); for (const bk of b) await bk.step(rid); await tick(); }
  now = CLOSE + LOCK_SET_WINDOW_MS + LOCK_SET_FINAL_AFTER_MS + 100;
  const facts = b.map((bk, i) => {
    const st = bk.state(rid);
    const mine = (st.signatures || []).find((x) => x.key === toHex(seats[i].pubkey));
    return { seat: i, signed: mine ? mine.entries.length : null, certified: st.entries ? st.entries.length : null, void: st.void };
  });
  const played = b.filter((bk) => { const c = bk.certified(rid); return c && c.entries.includes(A) && c.entries.includes(B); }).length;
  return { facts, played, signedBefore };
}

test('audit h2h a7-1-1 (control): without the stranger, the honest pair is certified', async () => {
  const r = await play({ evict: false });
  console.log('  CONTROL:', JSON.stringify(r.facts));
  assert.ok(r.played >= 5, `control: ${JSON.stringify(r.facts)}`);
});

test('audit h2h a7-1-1 (control 2): the same reads with no late-verified lock leave the round certified', async () => {
  const r = await play({ evict: true, late: false });
  console.log('  CONTROL 2:', JSON.stringify(r.facts));
  assert.ok(r.played >= 5, `control 2: ${JSON.stringify(r.facts)}`);
});

test('audit h2h a7-1-1: a stranger\'s GET /lock-set over 513 other rounds does not void an honest pair seen at every seat', async () => {
  const r = await play({ evict: true });
  console.log('  FACTS:', JSON.stringify(r.facts), 'signed before the reads:', r.signedBefore);
  assert.ok(r.played >= 5, `513 GET /lock-set of other rounds evicted the live room at 3 seats; each made a second own view, was counted as a two-view equivocator at every peer, and no set reached the threshold: the honest pair's round is VOID: ${JSON.stringify(r.facts)}`);
});
