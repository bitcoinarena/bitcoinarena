// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 a44 refute 55 s2 1 (variant of kanban #1729): the #1729 fix bounded one peer's GET /price-samples answer only on the
// protocol-5 path (#fetchReadings). A LEGACY round (protocol < 5) asks the committee for its ends through #fetchEnds, which still
// reads the answer whole (r.json(), no byte cap) and hands EVERY sample entry to hold(), which runs priceAttestationStands (up to
// n BIP-340 verifies per entry) before it looks at what is held. One committee seat answering one junk attestation of sample 0
// repeated COPIES times costs the honest seat COPIES x 7 verifies - and since a junk end never stands, every GET /round-result
// (anyone's, no throttle) asks again and pays again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { PriceFeed, closeSampleK } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;
const COPIES = 300;

test('a legacy round: one committee seat padding its GET /price-samples answer does not cost an honest seat a verify per copy, per ask', async () => {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const contract = decodeRoundContract(bytes);
  assert.ok(Number(contract.protocolVersion) < 5, 'a legacy round');
  const rid = roundIdOf(contract), rh = toHex(rid);
  const kClose = closeSampleK(Number(contract.blockTicks));
  const junk = (k) => ({ k, priceCents: 8297000, sigs: keys.map((x) => ({ key: toHex(x.pubkey), signature: 'ab'.repeat(64) })) });
  let asks = 0;
  const fetcher = async (url) => {
    asks++;
    // THE ATTACK: the peer seat6 answers one junk attestation of each end, repeated COPIES times; the others hold nothing
    const samples = url.startsWith('seat6/') ? Array.from({ length: COPIES }, () => [junk(0), junk(kClose)]).flat() : [];
    return { ok: true, status: 200, json: async () => ({ round: rh, samples, tape: null }) };
  };
  const t = START + Number(msForTicks(BigInt(contract.blockTicks)).ms) + 1000;
  const seat = new PriceFeed({ identity: keys[0], get pubkey() { return keys[0].pubkey; }, get: (id) => (toHex(id) === rh ? { contract: bytes } : null),
    openRounds: () => [{ roundId: rid, contract: bytes }], db: new DatabaseSync(':memory:') }, { priceRound: () => true, readPrice: async () => 8297000, now: () => t, fetcher,
    peersFor: () => keys.map((_, j) => `seat${j}`).filter((u) => u !== 'seat0'), log: () => {} });
  let checks = 0;
  const orig = seat.hold.bind(seat);
  seat.hold = (body) => { checks++; return orig(body); };
  const t0 = performance.now();
  for (let i = 0; i < 3; i++) await seat.result(rh);   // a stranger's GET /round-result, three times
  const ms = performance.now() - t0;
  console.log(`honest seat 0 (legacy round): 3 GET /round-result -> ${asks} peer asks, ${checks} attestations checked (each up to 7 BIP-340 verifies) in ${Math.round(ms)} ms`);
  // six peers, two ends: anything beyond that per ask - or a fresh full price on every outside ask - is one peer buying the seat's CPU
  assert.ok(checks <= 6 * 2 * 2, `one peer's padded answer cost ${checks} attestation checks (bound ${6 * 2 * 2})`);
});
