// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE KEPT PHRASE WITH A WALLET IS FOUND (2026-10-02: "I should have more than 0 sats on my wallet" - a tab took an
// empty kept phrase while the history showed the funded one's deposit and stake).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phraseWalletEntries, walletStoreFor, walletSecretFor, ledgerKey } from '../src/page-lock.js';

const mem = () => { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const hex = (n) => n.toString(16).padStart(2, '0').repeat(32);

test('a phrase whose player wallet keeps entries counts them; an empty one counts 0', () => {
  const L = mem();
  const fed = new Uint8Array(32).fill(0x33);
  L.setItem(ledgerKey(fed), JSON.stringify([{ kind: 'deposit', msat: '500000' }]));
  const funded = hex(0x0b), empty = hex(0x0a);
  const store = walletStoreFor(L, fed, walletSecretFor(Uint8Array.from(Buffer.from(funded, 'hex')), fed));
  store.put('note1', 'x'); store.put('note2', 'y');
  assert.equal(phraseWalletEntries(L, funded), 2);
  assert.equal(phraseWalletEntries(L, empty), 0);
  assert.equal(phraseWalletEntries(L, 'not hex'), 0);
});

test('a wallet in a federation this browser keeps no history for is found when that federation is named', () => {
  const mem2 = () => { const m = new Map(); return { get length() { return m.size; }, key: (i) => [...m.keys()][i], getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const L = mem2(); const fed = new Uint8Array(32).fill(0x44); const seed = '0c'.repeat(32);
  walletStoreFor(L, fed, walletSecretFor(Uint8Array.from(Buffer.from(seed, 'hex')), fed)).put('n', 'x');
  assert.equal(phraseWalletEntries(L, seed), 0, 'no ledger, no federation named');
  assert.equal(phraseWalletEntries(L, seed, Buffer.from(fed).toString('hex')), 1);
});
