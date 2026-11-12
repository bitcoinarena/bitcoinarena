// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 r5 attest 2: priceAttestationStands (price-sample.js) skips a key only once one of its signatures VERIFIED - a key whose
// signature fails is checked again at its next copy. So a sigs list that repeats one committee key with junk signatures costs one
// BIP-340 verify per entry, with no bound. A stranger reaches it with one POST /price-attested on any pre-protocol-5 price round
// (PriceFeed.hold verifies before anything else is asked), a peer with its GET /price-samples answer (#fetchEnds), a player with a
// batch's attests (checkBatchPrices kind 0). Safe: at most one check per committee key, whatever the list's length.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { priceAttestationStands, priceSampleId, sampleTick } from '../../arena-protocol/src/price-sample.js';
import { PriceFeed } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;
const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });

test('priceAttestationStands checks each committee key at most once, however often a list repeats it', () => {
  const roundId = b32(9);
  const id = priceSampleId({ roundId, tick: sampleTick(3), priceCents: 8297000 });
  // a real-looking but wrong signature (a valid signature over another message): full work for the verifier, then false
  const junk = toHex(schnorr.sign(b32(1), keys[0].secret));
  let calls = 0;
  const verify = (s, m, k) => { calls++; return schnorr.verify(s, m, k); };
  const sigs = Array.from({ length: 5000 }, () => ({ key: toHex(keys[0].pubkey), signature: junk }));
  const s = priceAttestationStands({ id, sigs, committee: keys.map((k) => k.pubkey), threshold: 5, verify });
  console.log(`5000 copies of one committee key's junk signature: ${calls} BIP-340 verifies, stands ${s.ok}`);
  assert.equal(s.ok, false);
  assert.ok(calls <= keys.length, `one list cost ${calls} signature checks for a committee of ${keys.length}`);
});

test('a stranger\'s one POST /price-attested on a legacy price round costs the seat one verify per padded signature', () => {
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, protocolVersion: 4, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const rid = roundIdOf(decodeRoundContract(bytes));
  const feed = new PriceFeed({ identity: keys[0], get pubkey() { return keys[0].pubkey; }, get: (x) => (toHex(x) === toHex(rid) ? { contract: bytes } : null),
    openRounds: () => [], db: { exec() { throw new Error('no sql'); } } }, { priceRound: () => true, now: () => START + 20000 });
  const junk = toHex(schnorr.sign(b32(1), keys[1].secret));
  const small = Array.from({ length: 7 }, () => ({ key: toHex(keys[1].pubkey), signature: junk }));
  const big = Array.from({ length: 3000 }, () => ({ key: toHex(keys[1].pubkey), signature: junk }));
  let t0 = performance.now();
  const a = feed.hold({ round: toHex(rid), kind: 'sample', k: 3, priceCents: 8297000, sigs: small });
  const tSmall = performance.now() - t0;
  t0 = performance.now();
  const b = feed.hold({ round: toHex(rid), kind: 'sample', k: 3, priceCents: 8297000, sigs: big });
  const tBig = performance.now() - t0;
  console.log(`POST /price-attested, 7 junk sigs: ${tSmall.toFixed(1)} ms (${a.why}); 3000 junk sigs (~640 kB, under the 8 MiB body limit): ${tBig.toFixed(1)} ms (${b.why})`);
  assert.equal(b.ok, false);
  // a list of one key repeated is no more work than the committee's own seven
  assert.ok(tBig < tSmall * 5 + 50, `3000 copies of one key's junk signature held the seat's thread ${tBig.toFixed(0)} ms (7 copies: ${tSmall.toFixed(0)} ms)`);
});
