// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 a44 refute 57 (#1730 variant): priceAttestationStands is now bounded per CALL (n x n verifies), but #fetchEnds
// (GET /round-result on a pre-protocol-5 price round that lacks an end) calls hold() once for EVERY entry of a peer's
// GET /price-samples answer whose k is missing - with no cap on the answer's size or on how often one k repeats. A lying
// committee seat answers the same sample k=0 N times, each with one junk signature under each committee key: 7 verifies a copy,
// so N copies cost 7N BIP-340 verifies on the honest seat's thread - the same effect #1730 closed, by repeating the sample
// instead of the signature. Safe: one peer's answer costs a bounded number of checks, however many copies it carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { PriceFeed } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;
const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });

test('one peer\'s GET /price-samples answer repeating one sample costs the seat one set of verifies per copy', async () => {
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, protocolVersion: 4, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const rid = roundIdOf(decodeRoundContract(bytes));
  // a real-looking but wrong signature per committee key (valid over another message): full work for the verifier, then false
  const junkSigs = keys.map((k) => ({ key: toHex(k.pubkey), signature: toHex(schnorr.sign(b32(1), k.secret)) }));
  const answerOf = (copies) => ({ samples: Array.from({ length: copies }, () => ({ k: 0, priceCents: 8297000, sigs: junkSigs })) });
  const feedWith = (copies) => new PriceFeed({ identity: keys[0], get pubkey() { return keys[0].pubkey; },
    get: (x) => (toHex(x) === toHex(rid) ? { contract: bytes } : null), openRounds: () => [], db: { exec() { throw new Error('no sql'); } } },
  { priceRound: () => true, now: () => START + 1e10, peersFor: () => ['http://liar'],
    fetcher: async () => ({ ok: true, headers: { get: () => null }, json: async () => answerOf(copies) }) });
  let t0 = performance.now();
  const a = await feedWith(1).result(toHex(rid));
  const tSmall = performance.now() - t0;
  t0 = performance.now();
  const b = await feedWith(400).result(toHex(rid));
  const tBig = performance.now() - t0;
  console.log(`GET /round-result, the liar's answer 1 copy: ${tSmall.toFixed(1)} ms (${a.why}); 400 copies (~200 kB): ${tBig.toFixed(1)} ms (${b.why})`);
  assert.equal(b.ok, false);
  assert.ok(tBig < tSmall * 5 + 50, `400 copies of one junk sample held the seat's thread ${tBig.toFixed(0)} ms (1 copy: ${tSmall.toFixed(0)} ms)`);
});
