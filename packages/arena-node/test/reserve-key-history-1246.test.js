// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1246 (audit 3 #1210 CONSENSUS-2): the level-2 payee check read the reserve key of the epoch now - null during key generation turned into an
// empty set read as "read", and an epoch moved since the settlement's plan read the key it paid as nobody's - so an honest market settlement's
// reserve row was unpayable, and slashable. The check now reads every key the seat held for the federation, and is unread when there is none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { reserveKeyCache, payeeReserveKeys } from '../src/reserve-key-cache.js';

const F = 'aa'.repeat(32), G = 'bb'.repeat(32);
const K1 = '02' + '11'.repeat(32), K2 = '02' + '22'.repeat(32);
const bytes = (hex) => Uint8Array.from(hex.match(/../g).map((x) => parseInt(x, 16)));

test('#1246 the cache keeps every key it held for a federation, across epochs and a restart; the key now answers for its epoch only', () => {
  const db = new DatabaseSync(':memory:');
  const c = reserveKeyCache({ db });
  c.setFor(F, 'e1', bytes(K1));
  c.setFor(F, 'e2', bytes(K2));
  const again = reserveKeyCache({ db });             // a restart over the same store
  console.log('  MEASURED #1246 history:', JSON.stringify({ now: c.getFor(F, 'e2') && 'K2', oldEpoch: c.getFor(F, 'e1'), history: c.historyOf(F).length, afterRestart: again.historyOf(F).length }));
  assert.equal(c.getFor(F, 'e1'), null, 'an earlier epoch\'s key is not the federation\'s key now');
  assert.deepEqual(c.historyOf(F).sort(), [K1, K2]);
  assert.deepEqual(again.historyOf(F).sort(), [K1, K2]);
});

test('#1246 the payee check\'s reserve keys: unread when a federation\'s key is unknown and none was held; the earlier epoch\'s key still counts', () => {
  const held = { [F]: [K1] };
  const historyOf = (f) => held[f] || [];
  const generating = payeeReserveKeys([F, G], [null, null], historyOf);     // G mid key generation, never held
  const moved = payeeReserveKeys([F], [K2], historyOf);                      // the epoch moved: K2 now, K1 paid
  const keyGen = payeeReserveKeys([F], [null], historyOf);                   // key generation, K1 held
  console.log('  MEASURED #1246 payees:', JSON.stringify({ generating, moved: moved && [...moved].map((k) => k.slice(2, 6)), keyGen: keyGen && [...keyGen].map((k) => k.slice(2, 6)) }));
  assert.equal(generating, null, 'an unknown key read as an empty set: every reserve row unpayable');
  assert.ok(moved.has(K1) && moved.has(K2), 'the key the settlement paid no longer counted after the epoch moved');
  assert.deepEqual([...keyGen], [K1]);
});
