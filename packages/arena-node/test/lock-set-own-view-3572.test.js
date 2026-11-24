// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3572: a seat's own lock-set view is kept in the store and served again (after a restart, or a room dropped), so an honest seat never
// signs a second, different view of a round (#3347 would count it as an equivocator); and reads of other rounds never drop a room whose window
// is open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LockSetBook } from '../src/lock-set-book.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { LOCK_SET_WINDOW_MS, LOCK_SET_FINAL_AFTER_MS } from '../../arena-protocol/src/lock-set.js';

const CLOSE = 1_900_000_000_000;
const hex = () => toHex(new Uint8Array(randomBytes(32)));

function seat(db, clock, viewOf, roundOf) {
  const secret = new Uint8Array(randomBytes(32)), pubkey = schnorr.getPublicKey(secret);
  const others = [0, 1, 2, 3].map(() => schnorr.getPublicKey(new Uint8Array(randomBytes(32))));
  const round = { db, signerNodes: () => [pubkey, ...others], now: () => clock.now, pubkey, identity: { secret, pubkey } };
  const contract = { entryCloseMs: BigInt(CLOSE), stakeMsat: 1000n, protocolVersion: 33 };
  return (vo = viewOf) => new LockSetBook({ round, peersOf: () => [], roundOf: roundOf || (() => contract), viewOf: vo, fetchFn: async () => { throw new Error('down'); } });
}

test('#3572: a restarted seat serves the own view it signed before, not a new one over another set', async () => {
  const rid = new Uint8Array(randomBytes(32)), A = hex(), B = hex(), E = hex();
  const db = new DatabaseSync(':memory:'), clock = { now: CLOSE + 100 };
  const make = seat(db, clock, () => [A, B]);
  const first = make();
  await first.step(rid);
  const mine = toHex(first.round.pubkey);
  const v1 = first.state(rid).views.find((v) => v.key === mine);
  assert.ok(v1, 'the seat made its view');
  clock.now = CLOSE + 900;
  const again = make(() => [A, B, E]);   // a lock verified after the close now names E too
  await again.step(rid);
  const v2 = again.state(rid).views.find((v) => v.key === mine);
  assert.deepEqual(v2, v1, 'the same view, same time and signature');
});

test('#3572: 513 reads of other rounds do not drop a room whose window is open; closed rooms go first', async () => {
  const live = new Uint8Array(randomBytes(32)), A = hex();
  const clock = { now: CLOSE + 100 };
  const past = { entryCloseMs: BigInt(CLOSE - 60_000), stakeMsat: 1000n, protocolVersion: 33 };
  const open = { entryCloseMs: BigInt(CLOSE), stakeMsat: 1000n, protocolVersion: 33 };
  const liveHex = toHex(live);
  const book = seat(new DatabaseSync(':memory:'), clock, () => [A], (rid) => (toHex(rid) === liveHex ? open : past))();
  await book.step(live);
  const mine = toHex(book.round.pubkey);
  const v1 = book.state(live).views.find((v) => v.key === mine);
  for (let k = 0; k < 513; k++) book.state(new Uint8Array(randomBytes(32)));
  assert.ok(book.touched(live), 'the live room is still held');
  assert.equal(book.rooms.size, 512, 'a closed room went instead');
  assert.deepEqual(book.state(live).views.find((v) => v.key === mine), v1);
  // once the window and its final 2 s are over, the room may go like any other
  clock.now = CLOSE + LOCK_SET_WINDOW_MS + LOCK_SET_FINAL_AFTER_MS + 1;
  for (let k = 0; k < 513; k++) book.state(new Uint8Array(randomBytes(32)));
  assert.ok(!book.touched(live), 'a closed round\'s room is dropped');
});
