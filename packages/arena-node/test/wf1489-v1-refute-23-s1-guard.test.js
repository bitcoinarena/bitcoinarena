// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// (fixture copied from wf1489-r1-attest-2.test.js) kanban #1693 / #1759 / #1804: a seat signs a result another seat already signed only when it fits what it holds. PROTOCOL 5 AT THE SEATS (RULED 2026-10-14 ~21:50Z): seven seats of a protocol-5 round, each reading its own
// price. No leader proposes one: every seat signs its own reading and posts it to the others (POST /price-reading), every seat
// holds the sample once five readings are in, and its price is their median. The same seven seats on a round below 5 keep the
// proposed-and-countersigned path (test/price-feed.test.js, unchanged).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { priceSampleStands5, priceTapeStands5, priceReadingId, sampleTick, checkBatchPrices, centsToTapeUnits } from '../../arena-protocol/src/price-sample.js';
import { encodeInputBatch, decodeInputBatch } from '../../arena-protocol/src/batch.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { PriceFeed, closeSampleK, SERVE_AFTER_MS } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;
const verify = (sg, m, k) => schnorr.verify(sg, m, k);

// the network: seven seats on one protocol-5 round (or `version`), a fetcher that routes each door to the seat it names
function network({ readings, now, dbs = null, version = 5, down = new Set() }) {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, protocolVersion: version, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const contract = decodeRoundContract(bytes);
  const rid = roundIdOf(contract);
  const seats = [];
  const posts = [];
  const fetcher = async (url, o) => {
    const i = Number(/^seat(\d)\//.exec(url)[1]);
    if (down.has(i)) throw new Error('that seat is down');
    const q = /^seat\d\/price-samples\?round=([0-9a-f]{64})&ks=([0-9,]+)$/.exec(url);
    let got;
    if (q) got = seats[i].list(q[1], 0, q[2].split(',').map(Number));
    else {
      const door = /^seat\d\/(price-sign|price-attested|price-reading)$/.exec(url)[1];
      posts.push(door);
      const body = JSON.parse(o.body);
      got = door === 'price-sign' ? seats[i].sign(body) : door === 'price-attested' ? seats[i].hold(body) : seats[i].reading(body);
    }
    return { ok: got.ok !== false, status: got.ok === false ? got.status : 200, json: async () => got };
  };
  const make = (i, round) => new PriceFeed(round, { priceRound: () => true, readPrice: async () => readings[i](), now, fetcher,
    peersFor: () => keys.map((_, j) => `seat${j}`).filter((u) => u !== `seat${i}`) });
  keys.forEach((k, i) => {
    seats.push(make(i, { identity: k, get pubkey() { return k.pubkey; }, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null),
      openRounds: () => [{ roundId: rid, contract: bytes }], ...(dbs ? { db: dbs[i] } : {}) }));
  });
  const restart = (i) => { seats[i] = make(i, { ...seats[i].round }); return seats[i]; };
  return { seats, rid, rh: toHex(rid), keys, contract, committee: keys.map((k) => k.pubkey), posts, restart };
}
const beatAll = async (net, which = [0, 1, 2, 3, 4, 5, 6]) => { const out = []; for (const i of which) out.push(await net.seats[i].beat()); return out; };



async function setup() {
  const box = { t: 0, base: 0 };
  const dbs = [0, 1, 2, 3, 4, 5, 6].map(() => new DatabaseSync(':memory:'));
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map((i) => () => (i === 6 ? 999999999 : box.base + i * 10)), now: () => box.t, dbs });
  const kClose = closeSampleK(Number(net.contract.blockTicks));
  for (const [k, p] of [[0, 8297000], [3, 8299000], [kClose, 8296000]]) { box.t = START + (k - 1) * 5000 + 300; box.base = p; await beatAll(net); }
  const atk = net.keys[6];
  const second = (k, cents) => ({ round: net.rh, kind: 'sample', k, priceCents: cents, key: toHex(atk.pubkey),
    signature: toHex(schnorr.sign(priceReadingId({ roundId: net.rid, tick: sampleTick(k), priceCents: cents }), atk.secret)) });
  box.t = START + Number(msForTicks(BigInt(net.contract.blockTicks)).ms) + 1000;
  return { net, box, kClose, second };
}
function verdict(results, label) {
  const groups = new Map();
  for (const r of results) if (r.ok) { const k = `${r.openCents}:${r.closeCents}`; groups.set(k, (groups.get(k) || 0) + 1); }
  console.log(`${label} honest results by open:close:`, JSON.stringify([...groups]), 'refused:', results.filter((r) => !r.ok).map((r) => r.why || r.status).join(' | '));
  const best = Math.max(0, ...groups.values());
  assert.ok(best + 1 >= 5, `${label}: the honest seats split ${JSON.stringify([...groups])}: no result of the round can gather 5 of 7 signatures`);
}

import { roundResultFromReadings, roundResultId } from '../../arena-protocol/src/round-result.js';

// A SIGNED RESULT THAT DROPS AN HONEST READING IS NOT JOINED (kanban #1693 / #1759 / #1804): seat 6 serves, beside the ends, a result it
// signed over five readings of each end - every honest reading but keys 0's and 1's, which moves the median. It verifies and stands, but
// every honest seat holds one reading of keys 0 and 1, so none signs it: they all sign the result of all seven.
test('wf1489 v1-refute-23 guard: a served result without an honest reading is not signed by the honest seats', async () => {
  const { net, kClose } = await setup();
  const atk = net.keys[6];
  const drop = new Set([0, 1].map((i) => toHex(net.keys[i].pubkey)));
  const all = (k) => net.seats[6].list(net.rh, 0, [k]).samples[0].readings;
  const open = all(0).filter((r) => !drop.has(r.key)), close = all(kClose).filter((r) => !drop.has(r.key));
  const got = roundResultFromReadings({ roundId: net.rid, open: { tick: sampleTick(0), readings: open }, close: { tick: sampleTick(kClose), readings: close },
    endTick: Number(net.contract.blockTicks), committee: net.committee, threshold: 5, verify });
  assert.ok(got.ok, got.why);
  const id = roundResultId(got.result);
  const forged = { resultId: toHex(id), counted: { open, close }, key: toHex(atk.pubkey), signature: toHex(schnorr.sign(id, atk.secret)) };
  const real = net.seats[6].list.bind(net.seats[6]);
  net.seats[6].list = (rh, since, ks) => ({ ...real(rh, since, ks), result: forged });
  const results = [];
  for (const i of [0, 1, 2, 3, 4, 5]) results.push(await net.seats[i].result(net.rh));
  assert.equal(results.filter((r) => r.ok).length, 6, JSON.stringify(results.map((r) => r.why)));
  assert.equal(new Set(results.map((r) => r.resultId)).size, 1);
  assert.notEqual(results[0].resultId, forged.resultId, 'the honest seats signed the result that drops keys 0 and 1');
  assert.equal(results[0].readings.open, 7);
  verdict(results, 'v1-refute-23 guard');
});
