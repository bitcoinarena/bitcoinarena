// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FALLBACK CLAIM'S RULES (spec §23.2, kanban #1268 / #1290 / #1281).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taggedHash, toHex } from '../src/hash.js';
import { fallbackOpen, fallbackTurnOrder, fallbackFiler, fallbackEntries, fallbackEligible, FALLBACK_RESULT_SIGNERS, FALLBACK_NODE_GRACE_MS } from '../src/fallback-claim.js';

const rid = taggedHash('TEST/fb', Uint8Array.of(1));
const keys = Array.from({ length: 7 }, (_, i) => taggedHash('TEST/fb-seat', Uint8Array.of(i)));

test('open from fallback_after until expiration, never after', () => {
  const lock = { fallbackAfter: 303, expiration: 444 };
  assert.equal(fallbackOpen(lock, 302), false);
  assert.equal(fallbackOpen(lock, 303), true);
  assert.equal(fallbackOpen(lock, 443), true);
  assert.equal(fallbackOpen(lock, 444), false, 'from the expiration only the refund');
});

test('the filer: the seats by a hash of the round id and their key, one block each from fallback_after', () => {
  const order = fallbackTurnOrder(rid, keys);
  assert.deepEqual([...order].sort(), [0, 1, 2, 3, 4, 5, 6]);
  const h = (i) => { const m = new Uint8Array(64); m.set(rid); m.set(keys[i], 32); return toHex(taggedHash('ARENA/v1/FallbackTurn', m)); };
  for (let k = 1; k < order.length; k++) assert.ok(h(order[k - 1]) < h(order[k]), 'ascending by the tagged hash');
  assert.equal(fallbackFiler({ roundId: rid, seatKeys: keys, fallbackAfter: 303, height: 302 }), null);
  assert.equal(fallbackFiler({ roundId: rid, seatKeys: keys, fallbackAfter: 303, height: 303 }), order[0]);
  assert.equal(fallbackFiler({ roundId: rid, seatKeys: keys, fallbackAfter: 303, height: 304 }), order[1]);
  assert.equal(fallbackFiler({ roundId: rid, seatKeys: keys, fallbackAfter: 303, height: 310 }), order[0], 'round and round');
  const other = fallbackTurnOrder(taggedHash('TEST/fb', Uint8Array.of(2)), keys);
  assert.notDeepEqual(other, order, 'another round, another order');
});

test('an entry is paid by its FINAL, else by one result four seats signed, else as the seats wrote it', () => {
  const r = (seat, resultId, outcome = 'DELIVERED', score = 7) => ({ seat, resultId, outcome, score });
  const [a, b, c, d, e] = fallbackEntries([
    { entryId: 'a', outcome: 'VOID', final: { outcome: 'DELIVERED', score: 9 }, signedResults: [] },
    { entryId: 'b', outcome: 'ENTRY_VOID', final: null, signedResults: [r(0, 'x'), r(1, 'x'), r(2, 'x'), r(5, 'x')] },
    { entryId: 'c', outcome: 'ENTRY_VOID', final: null, signedResults: [r(0, 'x'), r(1, 'x'), r(2, 'x'), r(2, 'x')] },
    { entryId: 'd', outcome: 'ENTRY_VOID', final: null, signedResults: [r(0, 'x'), r(1, 'x'), r(2, 'x'), r(3, 'x'), r(4, 'y', 'FAILED'), r(5, 'y', 'FAILED'), r(6, 'y', 'FAILED'), r(3, 'y', 'FAILED')] },
    { entryId: 'e', outcome: 'VOID', final: null },
  ]);
  assert.equal(FALLBACK_RESULT_SIGNERS, 4);
  assert.deepEqual([a.outcome, a.score, a.by], ['DELIVERED', 9, 'final']);
  assert.deepEqual([b.outcome, b.score, b.by], ['DELIVERED', 7, 'four signatures']);
  assert.deepEqual([c.outcome, c.by], ['ENTRY_VOID', 'as written'], 'three distinct seats (one signed twice): below four');
  assert.deepEqual([d.outcome, d.by], ['ENTRY_VOID', 'as written'], 'two results with four signers each: neither');
  assert.deepEqual([e.outcome, e.by], ['VOID', 'as written']);
});

test('the node row: the seats whose signed result or FINAL reached the relays by final_after + 60 s', () => {
  const hx = keys.map(toHex);
  const seen = new Map([[hx[0], 1000], [hx[1], 1000 + FALLBACK_NODE_GRACE_MS], [hx[2], 1001 + FALLBACK_NODE_GRACE_MS]]);
  const el = fallbackEligible({ seats: keys, seenAtMs: seen, finalAfterMs: 1000 });
  assert.deepEqual([...el].sort(), [hx[0], hx[1]].sort(), 'seat 2 one ms late and the quiet seats earn nothing');
});
