// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #2585 (attacker audit, forfeit / lock return; after #018 and #023): TWO CERTIFIED LOCK SETS FOR ONE ROUND, AND A LOCK RETURNED BY ONE SIDE THAT
// THE OTHER SIDE CLAIMS. A protocol-28 committee is the round's draw - 2t - 1 seats (9 for 7 slots, 3 for 2; roster.js "every node drawn") -
// so two thresholds of it overlap in exactly ONE seat. Honest seats sign one set each, but not the same one when their views differ: a player
// lets only some seats see his stake before the close (the others hold his stake lock, not his fee lock, so it is not "seen"). Those that saw
// it sign the set with his entry, the others the set without it; one dishonest seat signs both, and each side certifies its own set. The side
// without the entry then returned his stake "at once" by forfeit (kanban #2561 lockSetOut) - with that dishonest seat's share it is a
// threshold - while the other side plays him and claims the same lock if he loses: a free option, the #1598 door the lock set was built to shut.
// Fixed: a second standing certificate over another set is kept as the round's conflict, and a lock outside the set goes back only after the
// close + the window + the gossip, one pull more, and never while the set is contested.
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

// THE BASE'S RULE, as server.js lockSetOut read it before #2585 (used only where the book has no lockOut of its own)
async function baseLockOut(b, r, eidHex) {
  let cert = b.certified(r);
  if (!cert && b.voidNow(r, contract)) cert = await b.settle(r);
  if (cert) return cert.entries.includes(eidHex) ? null : 'that lock is not in the round\'s certified lock set';
  return b.voidNow(r, contract) ? 'VOID' : null;
}
const lockOut = (b, eidHex) => (typeof b.lockOut === 'function' ? b.lockOut(rid, eidHex) : baseLockOut(b, rid, eidHex));

test('#2585 one dishonest seat in a 3-seat draw: two certificates over two sets; the side without the entry must not return its lock at once', async () => {
  const b1 = bookOf(s1, [A]), b2 = bookOf(s2, [A, E]);
  // the dishonest seat's view names E, to both honest seats
  const xv = signed(x, [A, E], lockSetViewId, CLOSE + 50);
  b1.take(rid, { views: [xv] }); b2.take(rid, { views: [xv] });
  // each honest seat makes its view, hears the other's and signs its one set
  for (let i = 0; i < 4; i++) { await b1.step(rid); await b2.step(rid); await tick(); }
  // the dishonest seat signs BOTH sets, each handed to the side that signed it
  b1.take(rid, { signatures: [signed(x, [A], lockSetSignatureId, CLOSE + 150)] });
  b2.take(rid, { signatures: [signed(x, [A, E], lockSetSignatureId, CLOSE + 150)] });
  for (let i = 0; i < 4; i++) { await b1.step(rid); await b2.step(rid); await tick(); }
  const c1 = b1.certified(rid), c2 = b2.certified(rid);
  // the window passes, and the gossip with it
  now = CLOSE + LOCK_SET_WINDOW_MS + 10_000;
  const out1 = await lockOut(b1, E);
  const out2 = await lockOut(b2, E);
  console.log('  FACTS (#2585):', JSON.stringify({ set1: c1 && c1.entries.length, set2: c2 && c2.entries.length, contested: typeof b1.conflicted === 'function' ? b1.conflicted(rid) : 'n/a', out1, out2 }));
  assert.ok(c1 && c2, 'both sides certified');
  // SINCE #035 a certificate assembled in take() is pushed at once, so the sides may converge on the first one; either way two
  // certificates over two sets exist (x signed both) and NEITHER side returns E's lock while that conflict can stand
  const split = JSON.stringify([...c1.entries].sort()) !== JSON.stringify([...c2.entries].sort());
  // RULING #2587 (kanban #2606): a seat that HOLDS both certificates reads the round VOID and returns every lock at once; one that does not
  // hold the second never returns E while seat 2 may play it
  if (split && b1.conflicted(rid)) assert.ok(out1 && /contested/.test(out1), `a contested round is VOID, every lock back: ${out1}`);
  else if (split) assert.equal(out1, null, `seat 1 returns E's lock at once while seat 2's certificate plays E: ${out1}`);
  // converged on one set (the first certificate travelled): E is played by no honest side, so its lock may go back - but never while
  // a seat that holds E in its certificate is unheard (the #035 case below)
  else assert.ok(!c1.entries.includes(E) || out1 === null);
});

test('#2585 no conflict: a lock outside the one certificate still goes back (after the window and the gossip), a certified one does not', async () => {
  books.clear();
  now = CLOSE + 1300;   // past the view wait: the dishonest seat sends no view, two of three suffice
  const L = hex();
  const b1 = bookOf(s1, [A]), b2 = bookOf(s2, [A]);
  for (let i = 0; i < 6; i++) { await b1.step(rid); await b2.step(rid); await tick(); }
  assert.deepEqual(b1.certified(rid) && b1.certified(rid).entries, [A]);
  const early = await lockOut(b1, L);
  now = CLOSE + LOCK_SET_WINDOW_MS + 10_000;
  // SINCE #036 every peer must have answered: with x silent the lock waits for its round (or its expiry)
  const whileXSilent = await lockOut(b1, L);
  books.set('x', { take: () => {}, state: () => ({ views: [], signatures: [] }) });   // x answers (nothing to show)
  const later = await lockOut(b1, L), certified = await lockOut(b1, A);
  books.delete('x');
  if (typeof b1.lockOut === 'function') assert.equal(whileXSilent, null, `a lock outside the set came back with a peer unheard: ${whileXSilent}`);
  console.log('  FACTS (#2585 control):', JSON.stringify({ early, later, certified }));
  assert.ok(later && /not in the round's certified lock set/.test(later), `a lock outside the certificate does not come back: ${later}`);
  assert.equal(certified, null);
  if (typeof b1.lockOut === 'function') assert.equal(early, null, 'a lock outside the set came back inside the window, before a second certificate could reach this seat');
});

// feedback #035 (Hexbox): the pull before a return was made once per round and its misses swallowed - seat 2, holding the contesting
// certificate, unreachable for that ONE pull let seat 1 return E's lock for good. A missed peer is asked again, and the lock goes back
// only once enough peers answered that no other threshold can exist without one of them.
test('#035 one missed pull does not return a lock while a contesting certificate stands', async () => {
  books.clear();
  now = CLOSE + 100;
  const b1 = bookOf(s1, [A]), b2 = bookOf(s2, [A, E]);
  const xv = signed(x, [A, E], lockSetViewId, CLOSE + 50);
  b1.take(rid, { views: [xv] }); b2.take(rid, { views: [xv] });
  for (let i = 0; i < 4; i++) { await b1.step(rid); await b2.step(rid); await tick(); }
  // seat 2 is unreachable from here on until it comes back: the two certificates form apart, each side keeps its own
  const s2book = books.get('s2'); books.delete('s2');
  b1.take(rid, { signatures: [signed(x, [A], lockSetSignatureId, CLOSE + 150)] });
  s2book.take(rid, { signatures: [signed(x, [A, E], lockSetSignatureId, CLOSE + 150)] });
  for (let i = 0; i < 4; i++) { await b1.step(rid); await s2book.step(rid); await tick(); }
  now = CLOSE + LOCK_SET_WINDOW_MS + 10_000;
  const contestedWhileDown = b1.conflicted(rid);   // seat 2's push may already have handed seat 1 its certificate
  const whileDown = await b1.lockOut(rid, E);
  books.set('s2', s2book);                                         // seat 2 is back, its [A, E] certificate standing
  await new Promise((ok) => setTimeout(ok, 1100));                // past the per-peer pull spacing
  const afterBack = await b1.lockOut(rid, E);
  console.log('  FACTS (#035):', JSON.stringify({ whileDown, afterBack, conflicted: b1.conflicted(rid) }));
  // RULING #2587 (kanban #2606): holding both certificates, seat 1 reads the round VOID (every lock back); holding one, it waits for seat 2
  if (contestedWhileDown) assert.ok(whileDown && /contested/.test(whileDown), `a contested round is VOID: ${whileDown}`);
  else assert.equal(whileDown, null, `seat 1 returned E's lock with seat 2 unheard: ${whileDown}`);
  // RULING #2587 (kanban #2606): once seat 2 answered, seat 1 holds both certificates - the round is VOID and E's lock goes back as every lock
  // does (seat 2 is handed the contest by the same push and settles nothing either)
  assert.ok(afterBack && /contested/.test(afterBack), `seat 1, holding both certificates, reads the round VOID: ${afterBack}`);
  await tick();
  assert.equal(s2book.conflicted(rid), true, 'seat 2 was handed the contest once it was back');
  assert.deepEqual([...s2book.certified(rid).entries].sort(), [A, E].sort(), 'seat 2 kept the certificate that plays E');
  assert.equal(b1.conflicted(rid), true, 'the contesting certificate was pulled once seat 2 answered');
});

// feedback #036 (Hexbox): as #035, but the dishonest seat x ANSWERS seat 1's pulls (with its [A] signature) while honest seat 2, holding
// [A, E], stays unheard - x's answer alone met the n - t quorum. A lock outside the set waits until every peer answered.
test('#036 the double signer answering does not stand in for the unheard honest seat', async () => {
  books.clear();
  now = CLOSE + 100;
  const b1 = bookOf(s1, [A]), b2 = bookOf(s2, [A, E]);
  const xv = signed(x, [A, E], lockSetViewId, CLOSE + 50);
  b1.take(rid, { views: [xv] }); b2.take(rid, { views: [xv] });
  for (let i = 0; i < 4; i++) { await b1.step(rid); await b2.step(rid); await tick(); }
  // seats 1 and 2 cannot reach each other (both ways) while the two certificates form
  const s1book = books.get('s1'), s2book = books.get('s2'); books.delete('s1'); books.delete('s2');
  const xSigA = signed(x, [A], lockSetSignatureId, CLOSE + 150);
  b1.take(rid, { signatures: [xSigA] });
  s2book.take(rid, { signatures: [signed(x, [A, E], lockSetSignatureId, CLOSE + 150)] });
  for (let i = 0; i < 4; i++) { await b1.step(rid); await s2book.step(rid); await tick(); }
  books.set('s1', s1book);   // seat 1 is reachable again; seat 2 stays unheard
  // x answers seat 1's pulls with a valid body that reveals nothing of [A, E]
  books.set('x', { take: () => {}, state: () => ({ views: [], signatures: [xSigA] }) });
  now = CLOSE + LOCK_SET_WINDOW_MS + 10_000;
  const out = await b1.lockOut(rid, E);
  books.delete('x');
  console.log('  FACTS (#036):', JSON.stringify({ out, conflicted: b1.conflicted(rid) }));
  assert.equal(out, null, `seat 1 returned E's lock on the double signer's answer while seat 2 (holding [A, E]) is unheard: ${out}`);
});
