// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 skeptic 4 for fix:attest:1 (9e48b1b24 + e353d64b0): e353d64b0 says hold() keeps "only the signatures
// priceAttestationStands counted, one per key". It does not: priceAttestationStands decodes a key that is not a string with toHex(s.key),
// so a key sent as a JSON array of its 32 bytes counts, while countedSigs/sigShape take a key only as a string or a Uint8Array and drop
// it. Anybody (no committee seat needed) re-posting the round's public, honest signatures to POST /price-attested with the keys as byte
// arrays makes a seat that does not hold that sample yet - restarted (mid samples live only in memory) or one that missed the leader's
// hand-out (an end, kept first-wins in price_ends, so across every restart) - answer ok and keep the sample with ZERO signatures.
// GET /price-samples then serves it, the page (first seat that answers, first sample per tick) submits it with no attestation, and the
// seats refuse that batch: the attested sample that stood is gone at that seat for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { priceAttestationStands, priceSampleId, sampleTick } from '../../arena-protocol/src/price-sample.js';
import { PriceFeed } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };

function network({ now, dbs, down = () => false }) {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const rid = roundIdOf(decodeRoundContract(bytes));
  const seats = [];
  const fetcher = async (url, o) => {
    const m = /^seat(\d)\/(price-sign|price-attested)$/.exec(url);
    const i = Number(m[1]), s = seats[i];
    if (down(i)) throw new Error('that seat is down');
    const got = m[2] === 'price-sign' ? s.sign(JSON.parse(o.body)) : s.hold(JSON.parse(o.body));
    return { ok: got.ok, status: got.ok ? 200 : got.status, json: async () => got };
  };
  const make = (i) => new PriceFeed({ identity: keys[i], get pubkey() { return keys[i].pubkey; }, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null),
    openRounds: () => [{ roundId: rid, contract: bytes }], db: dbs[i] }, { priceRound: () => true, readPrice: async () => 8297000, now, fetcher,
    peersFor: () => keys.map((_, j) => `seat${j}`).filter((u) => u !== `seat${i}`), log: () => {} });
  keys.forEach((_, i) => seats.push(make(i)));
  const order = decodeRoundContract(bytes).nodes.map(toHex);
  const idxOf = (pos) => keys.findIndex((k) => toHex(k.pubkey) === order[pos]);
  return { seats, rid, keys, bytes, idxOf, restart: (i) => { seats[i] = make(i); return seats[i]; } };
}
// the relay: the same public signatures, each key as the JSON array of its 32 bytes
const asByteArrays = (sigs) => sigs.map((s) => ({ key: [...fromHex(s.key)], signature: s.signature }));
const servedStands = (net, k, sigs, priceCents) => priceAttestationStands({ id: priceSampleId({ roundId: net.rid, tick: sampleTick(k), priceCents }),
  sigs, committee: net.keys.map((x) => x.pubkey), threshold: 5, verify });

test('wf1489-v1-refute-13-s4-1a: a restarted seat does not keep a mid sample with zero signatures from a byte-array-key relay', async () => {
  const k = 2, t = START + (k - 1) * 5000 + 300;   // price-feed readingMoment: start + (k - 1) * 5 s
  const dbs = [0, 1, 2, 3, 4, 5, 6].map(() => new DatabaseSync(':memory:'));
  const net = network({ now: () => t, dbs });
  for (const s of net.seats) await s.read();
  const rh = toHex(net.rid);
  const leader = net.seats[net.idxOf(k % 7)];
  const lead = await leader.leadSample(net.rid, k);
  assert.equal(lead.ok, true, lead.why);
  const honest = leader.list(rh, 0).samples.find((x) => x.k === k);
  assert.ok(servedStands(net, k, honest.sigs, honest.priceCents).ok, 'the leader serves a standing sample');
  // a seat restarts (its mid samples were in memory only); then anybody relays the leader's public signatures, keys as byte arrays
  const x = net.seats.findIndex((s) => s !== leader);
  const restarted = net.restart(x);
  await restarted.read();
  const got = restarted.hold({ round: rh, kind: 'sample', k, priceCents: honest.priceCents, sigs: asByteArrays(honest.sigs) });
  const served = (restarted.list(rh, 0).samples.find((s) => s.k === k) || null);
  const stands = served ? servedStands(net, k, served.sigs, served.priceCents) : null;
  console.log('  wf1489-v1-refute-13-s4-1a:', JSON.stringify({ hold: got, served: served && { priceCents: served.priceCents, sigs: served.sigs.length }, stands: stands && stands.ok }));
  assert.ok(!served || stands.ok, `the seat answered ${JSON.stringify(got)} and now serves sample ${k} with ${served && served.sigs.length} signature(s): it does not stand (${stands && stands.why})`);
});

test('wf1489-v1-refute-13-s4-1b: an end sample a seat missed is not kept with zero signatures - first-wins in price_ends, across a restart', async () => {
  const k = 0, t = START - 5000 + 300;
  const dbs = [0, 1, 2, 3, 4, 5, 6].map(() => new DatabaseSync(':memory:'));
  let downSeat = -1;
  const net = network({ now: () => t, dbs, down: (i) => i === downSeat });
  for (const s of net.seats) await s.read();
  const rh = toHex(net.rid);
  const leaderIdx = net.idxOf(0);
  const leader = net.seats[leaderIdx];
  downSeat = (leaderIdx + 1) % 7;                 // that seat is unreachable while the leader asks and hands out (6 of 7 still sign)
  const lead = await leader.leadSample(net.rid, k);
  assert.equal(lead.ok, true, lead.why);
  downSeat = -1;
  const honest = leader.list(rh, 0).samples.find((x) => x.k === k);
  assert.ok(servedStands(net, k, honest.sigs, honest.priceCents).ok);
  const missed = net.seats[(leaderIdx + 1) % 7];
  assert.equal(missed.list(rh, 0).samples.find((x) => x.k === k), undefined, 'the seat that was down holds no sample 0');
  const got = missed.hold({ round: rh, kind: 'sample', k, priceCents: honest.priceCents, sigs: asByteArrays(honest.sigs) });
  // and the honest copy, handed in after, cannot repair it
  const again = missed.hold({ round: rh, kind: 'sample', k, priceCents: honest.priceCents, sigs: honest.sigs });
  const after = net.restart((leaderIdx + 1) % 7);
  const served = after.list(rh, 0, [k]).samples.find((s) => s.k === k) || null;
  const stands = served ? servedStands(net, k, served.sigs, served.priceCents) : null;
  console.log('  wf1489-v1-refute-13-s4-1b:', JSON.stringify({ relay: got, honestAfter: again, servedAfterRestart: served && { priceCents: served.priceCents, sigs: served.sigs.length }, stands: stands && stands.ok }));
  assert.ok(!served || stands.ok, `after a restart the seat still serves sample 0 with ${served && served.sigs.length} signature(s): it does not stand (${stands && stands.why})`);
});
