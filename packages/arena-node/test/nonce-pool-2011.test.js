// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489, #1996, #2011, #2044: THE ONE NONCE-PAIR RULE of the forfeit, the settlement and the winnings send (nonce-pool.js). A full pool
// refuses no commit, a flood after a pair never pushes it out once it is among the oldest quarter, the seat's own pair is never dropped,
// spent and old pairs go first, the cap over every signing holds, and the poisoned-list retry ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NoncePool, SignerLists, sharesRefused, BOUND_ELSEWHERE, commitmentKey } from '../src/nonce-pool.js';

let n = 0;
const pairOf = () => { n += 1; const h = new Uint8Array(33); const b = new Uint8Array(33); new DataView(h.buffer).setUint32(0, n); new DataView(b.buffer).setUint32(4, n);
  return { commitment: { id: 1, hiding: h, binding: b }, hiding: 1n, binding: 2n }; };

test('a full pool takes every commit and never drops its oldest quarter', () => {
  const pool = new NoncePool({ perKey: 64, all: 1 << 20 });
  const first = [];
  for (let i = 0; i < 64; i++) { const p = pairOf(); first.push(p.commitment); assert.equal(pool.add('k', p).ok, true); }
  for (let i = 0; i < 64 * 20; i++) assert.equal(pool.add('k', pairOf()).ok, true, 'a full pool refused a commit');
  assert.equal(pool.count, 64);
  for (const c of first.slice(0, 16)) assert.ok(pool.get('k', c), 'a pair of the oldest quarter was pushed out by a flood after it');
});

test('the seat\'s own pair is never the one dropped, a spent or old pair goes first', () => {
  const pool = new NoncePool({ perKey: 8, all: 1 << 20, holdMs: () => 60000 });
  const flood = [];
  for (let i = 0; i < 4; i++) { const p = pairOf(); flood.push(p.commitment); pool.add('k', p); }
  const mine = pairOf();
  pool.add('k', mine, { own: true });
  const spent = pairOf();
  pool.add('k', spent);
  NoncePool.spend(pool.get('k', spent.commitment), 'list', new Uint8Array(32));
  for (let i = 0; i < 2; i++) pool.add('k', pairOf());
  assert.equal(pool.count, 8);
  pool.add('k', pairOf());
  assert.equal(pool.get('k', spent.commitment), null, 'the spent pair was kept while a young unspent one went');
  assert.equal(pool.count, 8);
  for (let i = 0; i < 200; i++) pool.add('k', pairOf());
  assert.ok(pool.get('k', mine.commitment), 'the seat\'s own pair was dropped');
  assert.equal(pool.get('k', mine.commitment).hiding, 1n);
});

test('a repeated draw is refused, never kept over the pair it repeats', () => {
  const pool = new NoncePool();
  const p = pairOf();
  pool.add('k', p);
  NoncePool.spend(pool.get('k', p.commitment), 'list', new Uint8Array(32));
  const again = pool.add('k', { ...p, hiding: 1n, binding: 2n });
  assert.equal(again.ok, false);
  assert.equal(again.status, 500);
  assert.equal(pool.get('k', p.commitment).hiding, null, 'a spent pair got its nonces back');
  assert.equal(commitmentKey(p.commitment).length, 133);
});

test('the cap over every signing holds against a flood of many signings, and a signing\'s oldest pairs stay', () => {
  const pool = new NoncePool({ perKey: 64, all: 256 });
  const honest = [];
  for (let i = 0; i < 8; i++) { const p = pairOf(); honest.push(p.commitment); pool.add('honest', p, { own: i < 2 }); }
  for (let i = 0; i < 5000; i++) assert.equal(pool.add(`flood-${i % 97}`, pairOf()).ok, true);
  assert.ok(pool.count <= 256, `${pool.count} pairs kept over a cap of 256`);
  assert.ok(pool.get('honest', honest[0]) && pool.get('honest', honest[1]), 'the seat\'s own pairs were dropped by a flood of other signings');
});

test('a poisoned list tries the lists that leave out who read it, and ends', () => {
  const lists = new SignerLists({ trials: 4 });
  const peers = ['a', 'b', 'c', 'd', 'e', 'f'];
  const signers = [{ base: null }, ...peers.map((base) => ({ base }))];
  const asked = peers.map((peer) => (peer === 'f' ? { peer, value: { share: 1 } } : { peer, value: { status: BOUND_ELSEWHERE, why: 'keeps no second pair' } }));
  const failed = sharesRefused(asked);
  assert.equal(failed.poisoned, true);
  assert.deepEqual(failed.sharers, ['f']);
  lists.begin('q');
  assert.equal(lists.again('q', failed, signers, 5, peers), true);
  assert.deepEqual(lists.listed('q', signers, 5).map((s) => s.base), [null, 'a', 'b', 'c', 'd', 'e'], 'the seat that gave a share while the others were spent was not left out first');
  let more = 0;
  while (lists.again('q', failed, lists.listed('q', signers, 5), 5, peers)) more += 1;
  assert.equal(more, 3, 'the trials did not end at their bound');
  assert.equal(lists.listed('q', signers, 5).length, signers.length);
  const plain = sharesRefused([{ peer: 'a', value: { why: 'no' } }, { peer: 'b', value: { share: 1 } }]);
  assert.equal(plain.poisoned, undefined);
  assert.deepEqual(plain.withheld, ['a']);
  assert.equal(sharesRefused([{ peer: 'a', value: { share: 1 } }]), null);
});
