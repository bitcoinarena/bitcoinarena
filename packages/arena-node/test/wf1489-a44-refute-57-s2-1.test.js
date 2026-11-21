// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 a44 refute 57 skeptic 2 (#1730 / #2170 variant, the RETRY path): #fetchEnds now bounds ONE peer answer (|missing| x n x n
// verifies), but nothing bounds how often it runs. GET /round-result is public and, on a pre-protocol-5 price round short of an end,
// asks the committee again on EVERY call - protocol 5 (#result5) asks at most once per ASK_ENDS_EVERY_MS, the legacy path never
// throttles. A stranger (or the lying seat itself) reloading GET /round-result makes the honest seat redo the 2 x 7 x 7 = 98 junk
// verifies a lying peer's answer carries, once per request: the cost per request is bounded, the total is not.
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

export function liarSetup() {
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, protocolVersion: 4, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const rid = roundIdOf(decodeRoundContract(bytes));
  // n junk signatures under each committee key (valid over another message): the n x n budget priceAttestationStands allows per sample
  const junkSigs = keys.flatMap((k) => [1, 2, 3, 4, 5, 6, 7].map((m) => ({ key: toHex(k.pubkey), signature: toHex(schnorr.sign(b32(m), k.secret)) })));
  let asked = 0;
  const feed = new PriceFeed({ identity: keys[0], get pubkey() { return keys[0].pubkey; },
    get: (x) => (toHex(x) === toHex(rid) ? { contract: bytes } : null), openRounds: () => [], db: { exec() { throw new Error('no sql'); } } },
  { priceRound: () => true, now: () => START + 1e10, peersFor: () => ['http://liar'],
    fetcher: async (u) => { asked++; const ks = new URL(u).searchParams.get('ks').split(',').map(Number);
      return { ok: true, headers: { get: () => null }, json: async () => ({ samples: ks.map((k) => ({ k, priceCents: 8297000, sigs: junkSigs })) }) }; } });
  return { feed, rh: toHex(rid), asked: () => asked };
}

test('a stranger reloading GET /round-result makes the seat redo a lying peer\'s junk verifies on every request', async () => {
  const one = liarSetup();
  let t0 = performance.now();
  await one.feed.result(one.rh);
  const tOne = performance.now() - t0;
  const many = liarSetup();
  t0 = performance.now();
  for (let i = 0; i < 40; i++) await many.feed.result(many.rh);
  const tMany = performance.now() - t0;
  console.log(`GET /round-result once: ${tOne.toFixed(1)} ms, 1 peer ask; 40 times in one moment: ${tMany.toFixed(1)} ms, ${many.asked()} peer asks`);
  assert.ok(many.asked() <= 2, `40 GET /round-result in one moment asked the lying peer ${many.asked()} times (protocol 5 asks at most once per ASK_ENDS_EVERY_MS)`);
  assert.ok(tMany < tOne * 5 + 50, `40 reloads held the seat's thread ${tMany.toFixed(0)} ms (one: ${tOne.toFixed(0)} ms)`);
});
