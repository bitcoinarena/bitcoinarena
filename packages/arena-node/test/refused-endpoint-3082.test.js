// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3082 (feedback #361, a gap in #2856): the address book refuses a census node's loopback advert endpoint (endpointOf -> null), but the
// peer list fell back to that same raw endpoint and dialed it. A refused endpoint is now no dial.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { endpointsOf } from '../src/roster.js';
import { createAddressBook } from '../src/address-book.js';

const keyOf = (b) => ({ pubkey: schnorr.getPublicKey(new Uint8Array(32).fill(b)) });
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };

test('#3082: a loopback advert endpoint the book refuses is left out of the peer list; a public one stays', () => {
  const me = keyOf(1), bad = keyOf(2), good = keyOf(3);
  const committee = [{ ...me, advert: { endpoint: 'https://me.example' } }, { ...bad, advert: { endpoint: 'http://127.0.0.1:31221' } },
    { ...good, advert: { endpoint: 'wss://good.example/' } }];
  const book = createAddressBook({ db: new DatabaseSync(':memory:'), verify, nowMs: () => 1_800_000_000_000 });
  assert.equal(book.endpointOf(committee[1]), null, 'the book refuses the loopback endpoint');
  assert.deepEqual(endpointsOf(committee, me.pubkey, book.endpointOf), ['https://good.example']);
});
