// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 skeptic 4 for fix:attest:1 (9e48b1b24 + e353d64b0), edge value HUGE: the fix says "decoding the key cannot throw
// either" - priceAttestationStands wraps toHex(s.key) in a try for a key that is not a string. It does not bound it. toHex(bytes) is
// `new Array(bytes.length)` and a loop to bytes.length, so a JSON key { "length": 4294967295 } (30 bytes of body) makes one
// unauthenticated POST /price-attested (price-feed hold) - or POST /game-outcome, via roundResultStands - loop 4.3 billion times on the
// seat's only thread before the members check ever runs: the seat stops answering (measured on the Beelink: 1e7 0.6 s, 5e7 7.3 s,
// superlinear). A key is 32 bytes; nothing past that should be read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { priceAttestationStands } from '../../arena-protocol/src/price-sample.js';
import { PriceFeed } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;

test('wf1489-v1-refute-13-s4-2a: priceAttestationStands reads no more than a key\'s 32 bytes of a key that is not a string', () => {
  let reads = 0;
  const key = new Proxy({ length: 2 ** 32 - 1 }, { get(t, p) { if (p !== 'length' && typeof p === 'string') { reads++; if (reads > 1000) throw new Error('stop'); } return t[p]; } });
  const r = priceAttestationStands({ id: b32(9), sigs: [{ key, signature: '00'.repeat(64) }], committee: [b32(1)], threshold: 1, verify: () => true });
  console.log('  wf1489-v1-refute-13-s4-2a:', JSON.stringify({ ok: r.ok, indexReads: reads, wouldRead: 2 ** 32 - 1 }));
  assert.ok(reads <= 32, `one sig's key was read ${reads} times (stopped by the test at 1001; a JSON key { length: 4294967295 } loops 4.3e9 times)`);
});

test('wf1489-v1-refute-13-s4-2b: one POST /price-attested with a { length } key does not hold the seat\'s thread', async () => {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const rid = roundIdOf(decodeRoundContract(bytes));
  const seat = new PriceFeed({ identity: keys[0], get pubkey() { return keys[0].pubkey; }, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null),
    openRounds: () => [{ roundId: rid, contract: bytes }], db: new DatabaseSync(':memory:') }, { priceRound: () => true, readPrice: async () => 8297000,
    now: () => START + 10300, fetcher: async () => { throw new Error('no network'); }, peersFor: () => [], log: () => {} });
  // the body exactly as the server parses it; 4e7 here stands for the 4294967295 an attacker sends (that one would not return in a test)
  const body = JSON.parse(`{"round":"${toHex(rid)}","kind":"sample","k":2,"priceCents":8297000,"sigs":[{"key":{"length":40000000},"signature":"${'00'.repeat(64)}"}]}`);
  const t0 = Date.now();
  const got = seat.hold(body);
  const ms = Date.now() - t0;
  console.log('  wf1489-v1-refute-13-s4-2b:', JSON.stringify({ got, ms }));
  assert.ok(ms < 500, `one 30-byte key held the seat's thread ${ms} ms (length 4e7; the attacker's 4294967295 is ~100x that, superlinear)`);
});
