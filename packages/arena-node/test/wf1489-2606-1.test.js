// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2606, ruling #2587: A CONTESTED LOCK SET IS VOID, AND SIGNING TWO LOCK SETS FOR ONE ROUND IS A SLASHING OFFENCE.
// A protocol-28 committee of 2t - 1 seats has two thresholds overlapping in one seat; that seat signing both sets makes two certificates over
// different sets (#2585). Ruled: the round is VOID - every lock goes back by forfeit at once, neither side's settlement is signed - and
// earliest-wins is refused (each certificate's time is its signers' own clocks). The double signer is slashable: the proof is its two signed
// LockSets, and the whole bond goes to the reserves (no player lost money, #976).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LockSetBook } from '../src/lock-set-book.js';
import { LockSettlement } from '../src/settlement.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import * as LS from '../../arena-protocol/src/lock-set.js';
import * as SL from '../../arena-protocol/src/slash.js';

const { lockSetOf, lockSetId, lockSetSignatureId, lockSetViewId, LOCK_SET_WINDOW_MS } = LS;
const CLOSE = 1_900_000_000_000;
const rid = new Uint8Array(randomBytes(32));
const hex = () => toHex(new Uint8Array(randomBytes(32)));
const A = hex(), E = hex();   // A: every seat saw it; E: seen by seat 2 only
let now = CLOSE + 100;
const seat = (name) => { const secret = new Uint8Array(randomBytes(32)); return { name, secret, pubkey: schnorr.getPublicKey(secret) }; };
const s1 = seat('s1'), s2 = seat('s2'), x = seat('x');   // x signs both sets
const committee = [s1, s2, x].map((s) => s.pubkey);
const contract = { entryCloseMs: BigInt(CLOSE), stakeMsat: 1000n };
const books = new Map();
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
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };

test('#2606-1: two certificates over two sets - every seat holding both is VOID: no decide set, every lock back, no settlement', async () => {
  const b1 = bookOf(s1, [A]), b2 = bookOf(s2, [A, E]);
  const xv = signed(x, [A, E], lockSetViewId, CLOSE + 50);
  b1.take(rid, { views: [xv] }); b2.take(rid, { views: [xv] });
  for (let i = 0; i < 4; i++) { await b1.step(rid); await b2.step(rid); await tick(); }
  b1.take(rid, { signatures: [signed(x, [A], lockSetSignatureId, CLOSE + 150)] });
  b2.take(rid, { signatures: [signed(x, [A, E], lockSetSignatureId, CLOSE + 150)] });
  for (let i = 0; i < 6; i++) { await b1.step(rid); await b2.step(rid); await tick(); }
  now = CLOSE + LOCK_SET_WINDOW_MS + 10_000;
  books.set('x', { take: () => {}, state: () => ({ views: [], signatures: [] }) });   // every peer answers
  const facts = {};
  for (const [n, b] of [['s1', b1], ['s2', b2]]) {
    facts[n] = { contested: b.conflicted(rid), void: b.voidNow(rid), decideSet: await b.settle(rid), outA: await b.lockOut(rid, A), outE: await b.lockOut(rid, E), state: b.state(rid).contested || false };
  }
  books.delete('x');
  console.log('  FACTS (#2606 contest):', JSON.stringify(facts));
  for (const n of ['s1', 's2']) {
    const f = facts[n];
    assert.equal(f.contested, true, `${n} saw the second certificate`);
    assert.equal(f.void, true, `${n}: a contested set is VOID`);
    assert.equal(f.decideSet, null, `${n}: no set is decided on (every entry VOID), not the earliest`);
    assert.ok(f.outA && /contested/.test(f.outA), `${n}: a lock in both sets goes back at once: ${f.outA}`);
    assert.ok(f.outE && /contested/.test(f.outE), `${n}: a lock in one set goes back at once: ${f.outE}`);
    assert.equal(f.state, true, `${n}: GET /lock-set says contested`);
  }
  // NEITHER SIDE'S SETTLEMENT IS SIGNED: the settlement's message (every commit and share is built on it) refuses VOID
  const settle = new LockSettlement({}, { lockSetContested: (r) => toHex(r) === toHex(rid) && b1.conflicted(r) });
  const m = await settle.message(rid);
  console.log('  FACTS (#2606 settlement):', JSON.stringify({ ok: m.ok, state: m.state, why: m.why }));
  assert.equal(m.ok, false); assert.equal(m.state, 'VOID');
  const late = await settle.lateMessage(rid, fromHex(E));
  assert.equal(late.ok, false); assert.equal(late.state, 'VOID');
  // THE DOUBLE SIGNER'S EVIDENCE: the seat that signed both sets, found from the two certificates
  const ev = [...b1.doubleSigns(rid), ...b2.doubleSigns(rid)];
  console.log('  FACTS (#2606 double signers):', JSON.stringify(ev.map((e) => e.key.slice(0, 16))));
  assert.ok(ev.length >= 1 && ev.every((e) => e.key === toHex(x.pubkey)), 'only the seat that signed both sets is named');
  const [a, b] = ev[0].signedLockSets;
  const advert = { nodePubkey: x.pubkey, bondTxid: new Uint8Array(32).fill(7), bondVout: 1 };
  const proof = SL.twoLockSetsProof({ nodePubkey: x.pubkey, a, b, bondTxid: advert.bondTxid, bondVout: 1 });
  const held = SL.slashHoldsOnTwoLockSets({ proof, signedLockSets: [a, b], advert, committee, verify });
  assert.equal(held.slashed, true, held.why);
  assert.equal(held.offence, SL.TWO_LOCK_SETS);
  assert.equal(SL.lockSetSlashDistribution({ bondSats: 250000n }).toReserves, 250000n, 'the whole bond to the reserves');
});

test('#2606-1: the double-sign proof holds only on two different sets, both set signatures of the accused, named in one order', () => {
  const sl = (s, entries, atMs, idOf = lockSetSignatureId) => { const set = lockSetOf({ roundId: rid, entries }), setId = lockSetId(set);
    return LS.encodeSignedLockSet({ set, atMs: BigInt(atMs), sig: schnorr.sign(idOf({ setId, atMs: BigInt(atMs) }), s.secret) }); };
  const advert = { nodePubkey: x.pubkey, bondTxid: new Uint8Array(32).fill(9), bondVout: 0 };
  const holds = (pair, who = x) => SL.slashHoldsOnTwoLockSets({ proof: SL.twoLockSetsProof({ nodePubkey: who.pubkey, a: pair[0], b: pair[1], bondTxid: advert.bondTxid, bondVout: 0 }),
    signedLockSets: pair, advert: { ...advert, nodePubkey: who.pubkey }, committee, verify });
  const one = sl(x, [A], CLOSE + 10), two = sl(x, [A, E], CLOSE + 20);
  assert.equal(holds([one, two]).slashed, true);
  assert.equal(holds([two, one]).slashed, true, 'either order of evidence, one commitment');
  assert.equal(toHex(holds([one, two]).commitment), toHex(holds([two, one]).commitment));
  assert.equal(holds([one, sl(x, [A], CLOSE + 30)]).slashed, false, 'the same set twice is no offence');
  assert.equal(holds([one, sl(x, [A, E], CLOSE + 20, lockSetViewId)]).slashed, false, 'a view is not a set signature');
  assert.equal(holds([one, sl(s1, [A, E], CLOSE + 20)]).slashed, false, 'another seat\'s signature is not the accused\'s');
  const outsider = seat('o');
  assert.equal(holds([sl(outsider, [A], CLOSE), sl(outsider, [E], CLOSE)], outsider).slashed, false, 'off the committee');
  const p = SL.twoLockSetsProof({ nodePubkey: x.pubkey, a: one, b: two, bondTxid: advert.bondTxid, bondVout: 0 });
  const swapped = { ...p, signedResultId: p.transcriptHash, transcriptHash: p.signedResultId };
  assert.equal(SL.slashHoldsOnTwoLockSets({ proof: swapped, signedLockSets: [one, two], advert, committee, verify }).slashed, false, 'named in the wrong order');
});
