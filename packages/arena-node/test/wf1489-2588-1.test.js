// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #2588 (attacker audit, protocol-28 head-to-head): A VOID ROUND RAISED FROM THE DEAD BY ONE SEAT'S BACKDATED SIGNATURE. A set signature's time is
// the signer's own word (atMs), and take() checked only that word against [close, close + window] - never when the signature reached this seat.
// A player lets only some seats see his stake (#2585), so the honest seats sign two sets and none reaches a threshold without the dishonest seat
// x of the 3-seat draw. x withholds: every seat answers VOID, the honest opponent's page stops at "VOID, every stake comes back" and never
// reveals. Any time later x signs the set with both entries, dated inside the window: the seat that signed it takes it, certifies, the reveal
// door opens again and the decide plays the round - the honest opponent FORFEITS, the attacker reveals and wins his stake.
// Fixed: a round's set is final at the close + the window + 2 s (the gossip a seat steps for): nothing is taken after that while no certificate
// is held, and VOID is said only from then (before it the set is pending), so a VOID answer is never taken back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as book from '../src/lock-set-book.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockSetOf, lockSetId, lockSetSignatureId, lockSetViewId, LOCK_SET_WINDOW_MS } from '../../arena-protocol/src/lock-set.js';

const { LockSetBook } = book;
const CLOSE = 1_900_000_000_000;
const rid = new Uint8Array(randomBytes(32));
const hex = () => toHex(new Uint8Array(randomBytes(32)));
const A = hex(), E = hex();   // A: an entry every seat saw; E: the attacker's, seen by seat 2 only
let now = CLOSE + 100;

function seat(name) {
  const secret = new Uint8Array(randomBytes(32));
  return { name, secret, pubkey: schnorr.getPublicKey(secret) };
}
const s1 = seat('s1'), s2 = seat('s2'), x = seat('x');   // x: the dishonest seat
const committee = [s1, s2, x].map((s) => s.pubkey);
const contract = { entryCloseMs: BigInt(CLOSE), stakeMsat: 1000n };
const books = new Map();
// peers talk through this: a POST is the peer's take(), a GET its state(); the dishonest seat answers nothing
const fetchFn = async (u, o = {}) => {
  const b = books.get(new URL(u).host);
  if (!b) throw new Error('down');
  if (o.method === 'POST') { b.take(rid, JSON.parse(o.body)); return { ok: true, body: null }; }
  const body = JSON.stringify(b.state(rid));
  return { ok: true, text: async () => body, body: null };
};
function bookOf(s, view) {
  const round = { db: new DatabaseSync(':memory:'), signerNodes: () => committee, now: () => now, pubkey: s.pubkey, identity: { secret: s.secret, pubkey: s.pubkey } };
  const peers = ['s1', 's2', 'x'].filter((n) => n !== s.name).map((n) => `http://${n}`);
  const b = new LockSetBook({ round, peersOf: () => peers, roundOf: () => contract, viewOf: () => view, fetchFn });
  books.set(s.name, b);
  return b;
}
const signed = (s, entries, idOf, atMs) => {
  const set = lockSetOf({ roundId: rid, entries }), setId = lockSetId(set);
  return { key: toHex(s.pubkey), atMs, entries: set.entries.map(toHex), sig: toHex(schnorr.sign(idOf({ setId, atMs }), s.secret)) };
};
const tick = () => new Promise((ok) => setTimeout(ok, 20));


test('#2588 a round every seat answered VOID is not certified later by the dishonest seat\'s backdated signature', async () => {
  now = CLOSE + 100;
  const b1 = bookOf(s1, [A]), b2 = bookOf(s2, [A, E]);
  const xv = signed(x, [A, E], lockSetViewId, CLOSE + 50);
  b1.take(rid, { views: [xv] }); b2.take(rid, { views: [xv] });
  for (let i = 0; i < 4; i++) { await b1.step(rid); await b2.step(rid); await tick(); }
  // x withholds its signature: no certificate anywhere; the window and the gossip pass, and the page is told VOID
  assert.equal(b1.certified(rid), null); assert.equal(b2.certified(rid), null);
  now = CLOSE + LOCK_SET_WINDOW_MS + 10_000;
  const saidVoid = [b1.voidNow(rid, contract), b2.voidNow(rid, contract)];
  const outBefore = await b2.lockOut(rid, A);
  // later: x's signature over {A, E}, dated inside the window
  const late = signed(x, [A, E], lockSetSignatureId, CLOSE + 150);
  b2.take(rid, { signatures: [late] }); b1.take(rid, { signatures: [late] });
  const c2 = b2.certified(rid);
  const stillVoid = b2.voidNow(rid, contract);
  console.log('  FACTS (#2588-1):', JSON.stringify({ saidVoid, outBefore: !!outBefore, certifiedAfter: c2 && c2.entries.length, stillVoid }));
  assert.deepEqual(saidVoid, [true, true], 'the round was not VOID, so the variant did not run');
  assert.ok(outBefore && /VOID/.test(outBefore), `the honest lock was not going back as VOID: ${outBefore}`);
  assert.equal(c2, null, 'a round this seat answered VOID was certified after the fact by a backdated signature - the honest player, told VOID, forfeits');
  assert.equal(stillVoid, true, 'a VOID answer was taken back');
});

test('#2588 between the window and the end of the gossip the set is pending, not VOID, and an honest late signature still certifies', async () => {
  books.clear();
  now = CLOSE + 100;
  const b1 = bookOf(s1, [A]), b2 = bookOf(s2, [A, E]);
  const xv = signed(x, [A, E], lockSetViewId, CLOSE + 50);
  b1.take(rid, { views: [xv] }); b2.take(rid, { views: [xv] });
  for (let i = 0; i < 4; i++) { await b1.step(rid); await b2.step(rid); await tick(); }
  now = CLOSE + LOCK_SET_WINDOW_MS + 500;
  const pending = b2.voidNow(rid, contract);
  b2.take(rid, { signatures: [signed(x, [A, E], lockSetSignatureId, CLOSE + 2900)] });
  const c2 = b2.certified(rid);
  console.log('  FACTS (#2588-1 control):', JSON.stringify({ voidAtWindowPlus500: pending, certified: c2 && c2.entries.length }));
  assert.equal(pending, false, 'VOID was said while a certificate signed inside the window may still be on its way');
  assert.ok(c2 && c2.entries.length === 2, 'a signature made inside the window and arriving inside the gossip was not taken');
});
