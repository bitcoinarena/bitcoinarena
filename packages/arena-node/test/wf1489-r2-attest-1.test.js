// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (price samples): A STRANGER GROWS A SEAT'S PROTOCOL-5 READINGS MAP WITHOUT BOUND, AND EVERY HONEST READ PAYS FOR IT.
// GET /price-samples?round=<a held protocol-5 round>&ks=a,b,c,d takes any four whole numbers (server.js: slice(0, 4), Number.isInteger,
// >= 0 - no upper bound, no check against the round's last sample closeSampleK). price-feed.js #list5 -> #allReadings -> #heardAt CREATES
// an empty Map for every k it is asked (m.set(k, new Map())), and keeps it until the round is finished (closed + its objection window).
// Every later plain GET /price-samples?round= (what pages and seats poll) sorts every one of those keys and builds a sample for each
// (#sample5 -> this.built), so the seat's memory and each honest read grow with the stranger's requests.
// SAFE: a k outside 0..closeSampleK of the round creates nothing (the held readings map stays bounded by the round's own samples).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { PriceFeed, closeSampleK } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;

test('wf1489-r2-attest-1: GET /price-samples?ks= of made-up samples does not grow the seat\'s readings map', () => {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, protocolVersion: 5, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const contract = decodeRoundContract(bytes);
  const rid = roundIdOf(contract), rh = toHex(rid);
  const k0 = keys[0];
  const seat = new PriceFeed({ identity: k0, get pubkey() { return k0.pubkey; }, get: (id) => (toHex(id) === rh ? { contract: bytes } : null),
    openRounds: () => [{ roundId: rid, contract: bytes }] }, { priceRound: () => true, readPrice: async () => 8300000, now: () => START + 20000 });
  const kMax = closeSampleK(Number(contract.blockTicks));
  // THE STRANGER: 25,000 requests of four made-up samples each, as server.js parses ?ks= (any whole number >= 0)
  const N = 25000;
  for (let i = 0; i < N; i++) {
    const ks = [0, 1, 2, 3].map((j) => kMax + 1 + i * 4 + j);
    seat.list(rh, 0, ks);
  }
  const sizes = seat.heldSizes();
  // AN HONEST READ afterwards (a page polling the round)
  const t0 = process.hrtime.bigint();
  seat.list(rh, 0, null);
  const honestMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const after = seat.heldSizes();
  console.log('  MEASURED:', JSON.stringify({ kMax, requests: N, heardSamples: sizes.heardSamples, builtAfterOneHonestRead: after.built, honestReadMs: Math.round(honestMs) }));
  assert.ok(sizes.heardSamples <= kMax + 1, `a stranger's ${N} requests left ${sizes.heardSamples} sample slots held for a round of ${kMax + 1} samples`);
  assert.ok(after.built <= kMax + 2, `one honest read built ${after.built} samples`);
});
