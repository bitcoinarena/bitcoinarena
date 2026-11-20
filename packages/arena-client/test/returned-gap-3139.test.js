// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3139 / #3138 (refute s4 of #3087, kanban #1489): Rescan's 'returned' row books only what the history lacks to agree with the
// wallet, at most the reissue; a row the browser refused is owed and written by the next read of the history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordReceived, ledgerRows, ledgerNetMsat } from '../src/page-lock.js';

const store = () => { const m = new Map(); let full = false; return { m, set full(v) { full = v; }, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null,
  setItem: (k, v) => { if (full) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' }); m.set(k, String(v)); }, removeItem: (k) => m.delete(k) }; };

test('#3139: an unknown stake\'s inputs fetched back book back the stake only; the change counted already books 0', () => {
  const fed = 'ab'.repeat(32);
  // deposit 1000, a stake of 100 the federation never knew: the wallet gets all 1000 back, the history said 900
  const a = store();
  a.setItem(`arena.ledger.${fed}`, JSON.stringify([{ atMs: 1, kind: 'deposit', msat: '1000000' }, { atMs: 2, kind: 'stake', round: 'cd'.repeat(32), msat: '100000' }]));
  recordReceived(a, fed, { kind: 'returned', msat: '1000000', outpoint: 'reissue:aa', walletMsat: '1000000' });
  assert.equal(ledgerNetMsat(a, fed), 1000000n);
  const row = ledgerRows(a, fed).find((r) => r.kind === 'returned');
  assert.deepEqual([row.msat, row.fetchedMsat], ['100000', '1000000']);
  // the same reissue again (a second tab) writes nothing more
  recordReceived(a, fed, { kind: 'returned', msat: '1000000', outpoint: 'reissue:aa', walletMsat: '2000000' });
  assert.equal(ledgerNetMsat(a, fed), 1000000n);
  // never below 0: a history that says more than the wallet holds books 0
  const b = store();
  b.setItem(`arena.ledger.${fed}`, JSON.stringify([{ atMs: 1, kind: 'deposit', msat: '5000000' }]));
  recordReceived(b, fed, { kind: 'returned', msat: '900000', outpoint: 'reissue:bb', walletMsat: '900000' });
  assert.equal(ledgerNetMsat(b, fed), 5000000n);
});

test('#3138: a returned row the full browser refused is written by the next read of the history', () => {
  const fed = 'ef'.repeat(32);
  const s = store();
  s.full = true;
  assert.equal(recordReceived(s, fed, { kind: 'returned', msat: '589000', outpoint: 'reissue:cc', walletMsat: '589000' }), false);
  assert.deepEqual(ledgerRows(s, fed), [], 'still full: nothing written, still owed');
  s.full = false;
  assert.deepEqual(ledgerRows(s, fed).map((r) => [r.kind, r.msat]), [['returned', '589000']]);
  assert.deepEqual(ledgerRows(s, fed).map((r) => [r.kind, r.msat]), [['returned', '589000']], 'written once');
});
