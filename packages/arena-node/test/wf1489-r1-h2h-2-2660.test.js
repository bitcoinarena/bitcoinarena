// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-find-h2h candidate 3: A SEAT'S OWN LOCK-SET SIGNATURE STOPS COUNTING ONCE ANYONE READS GET /lock-set (P4, new in protocol 28).
// LockSetBook.state() - the answer to GET /lock-set: the peers' pulls every 150 ms, the page's polls, any stranger with the public round id -
// puts this seat's stored set signature back into the room as #signed(rid) returns it: { key, atMs, entries, sig } WITHOUT its setId.
// #assemble groups the room's signatures by setId, so from the first GET after the seat signed, its own signature sits under `undefined` and never
// counts toward a certificate there: every seat then needs a threshold of PEER signatures. A committee with exactly its threshold live (the 3-seat
// draw with one seat down or silent; 7 slots with two) holds a threshold of good signatures at every seat and may certify nothing - by close + 3 s
// the round is VOID. Measured in the 7-seat fixture with two seats silent: 5 good signatures at each live seat, no certificate, VOID (racy there:
// it depends on whether a pull lands between a seat's signing and its last peer signature). The design tolerates t missing seats; the code one
// fewer - so ONE dishonest seat that stays silent for the set, beside one honest seat that is late or down, voids a paid head-to-head round
// (role b), and any stranger's GET makes the race certain.
// Safe behaviour: reading GET /lock-set never changes what counts - a seat holding its own and its peer's signature over one set (threshold 2 of 3)
// certifies it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LockSetBook } from '../src/lock-set-book.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { LOCK_SET_VIEW_WAIT_MS } from '../../arena-protocol/src/lock-set.js';

const CLOSE = 1_900_000_000_000;
const rid = new Uint8Array(randomBytes(32));
const A = toHex(new Uint8Array(randomBytes(32))), B = toHex(new Uint8Array(randomBytes(32)));
let now = CLOSE + 100;
const seat = (name) => { const secret = new Uint8Array(randomBytes(32)); return { name, secret, pubkey: schnorr.getPublicKey(secret) }; };
const s1 = seat('s1'), s2 = seat('s2'), x = seat('x');   // x: down (or a dishonest seat that stays silent)
const committee = [s1, s2, x].map((s) => s.pubkey);
const contract = { entryCloseMs: BigInt(CLOSE), stakeMsat: 1000n };
// the network: every push is recorded and delivered by hand; every pull fails - so nothing but the test calls state()
const pushes = [];
const fetchFn = async (u, o = {}) => { if (o.method === 'POST') { pushes.push({ to: new URL(u).host, body: JSON.parse(o.body) }); return { ok: true, body: null }; } throw new Error('down'); };
const bookOf = (s) => new LockSetBook({
  round: { db: new DatabaseSync(':memory:'), signerNodes: () => committee, now: () => now, pubkey: s.pubkey, identity: { secret: s.secret, pubkey: s.pubkey } },
  peersOf: () => ['s1', 's2', 'x'].filter((n) => n !== s.name).map((n) => `http://${n}`), roundOf: () => contract, viewOf: () => [A, B], fetchFn });
const lastPush = (from, to) => [...pushes].reverse().find((p) => p.to === to && p.body.signatures.length && p.body.signatures[0].key === toHex(from.pubkey));

test('#1489 r1-h2h-3: a GET /lock-set between a seat\'s signing and its peer\'s signature does not keep the seat from certifying', async () => {
  const b1 = bookOf(s1), b2 = bookOf(s2);
  // the views: each seat's own, handed to the other (x is down)
  await b1.step(rid); await b2.step(rid);
  const v1 = pushes.find((p) => p.to === 's2' && p.body.views.length).body.views, v2 = pushes.find((p) => p.to === 's1' && p.body.views.length).body.views;
  b1.take(rid, { views: v2 }); b2.take(rid, { views: v1 });
  // past the view wait with a threshold (2) of views: both sign the same set {A, B}
  now = CLOSE + LOCK_SET_VIEW_WAIT_MS + 100;
  await b1.step(rid); await b2.step(rid);
  const sig1 = lastPush(s1, 's2'), sig2 = lastPush(s2, 's1');
  assert.ok(sig1 && sig2, 'the fixture: both seats signed and pushed their set signature');
  // CONTROL: seat 2 takes seat 1's signature with nobody having read its state - it certifies
  b2.take(rid, { signatures: sig1.body.signatures });
  // THE READ: anyone's GET /lock-set at seat 1 (a peer's pull, the page's poll, a stranger) - then seat 2's signature arrives
  const read = b1.state(rid);
  b1.take(rid, { signatures: sig2.body.signatures });
  await b1.step(rid);
  const facts = { control: !!b2.certified(rid), afterRead: !!b1.certified(rid), sigsSeenBySeat1: read.signatures.length, void: b1.voidNow(rid, contract) };
  console.log('  FACTS r1-h2h-3:', JSON.stringify(facts));
  assert.equal(facts.control, true, 'the control: two good signatures of three certify');
  assert.equal(facts.afterRead, true, `seat 1 holds its own and seat 2's signature over one set and certifies nothing, because its GET /lock-set was read in between: ${JSON.stringify(facts)}`);
});
