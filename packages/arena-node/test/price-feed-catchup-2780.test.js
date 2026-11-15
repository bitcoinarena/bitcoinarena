// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2780: A BEAT THAT RAN PAST ITS MARK SKIPPED THAT MARK'S SAMPLE FOR GOOD. The feed's beat is set for the next 5 s mark once the last
// one ended; measured 11-15 09:00Z on rounds whose 7 seats are all ours, 9 and 10 of 17 samples were attested (k 5, 6, 9, 13-16 missing). Now
// each beat also reads the two samples before its own while their moment is still signable. The network fixture is price-feed-median's.
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


test('kanban #2780: a mark every seat passed over is caught up at the next beat - every seat holds k 2, 3 and 4', async () => {
  let t = START + 1 * 5000 + 300;   // k 2
  const prices = [8297193, 8297200, 8296900, 8298000, 8297193, 8297000, 8301000];
  const net = network({ readings: prices.map((p) => () => p), now: () => t });
  await beatAll(net);
  t = START + 3 * 5000 + 300;       // k 4: the beat of k 3 (round time 10 s) never ran
  const out = await beatAll(net);
  for (const o of out) assert.equal((o.find(([what]) => what === 3) || [null, { ok: false }])[1].ok, true, 'k 3 read late, still signable');
  for (const s of net.seats) assert.deepEqual(s.list(net.rh).samples.map((x) => [x.k, x.readings.length]), [[2, 7], [3, 7], [4, 7]]);
});

test('kanban #2780: a mark older than its signing slack, or with no reading of the seat near its moment, is not read late', async () => {
  let t = START + 1 * 5000 + 300;
  const net = network({ readings: [1, 2, 3, 4, 5, 6, 7].map(() => () => 8297193), now: () => t });
  await beatAll(net);
  t = START + 6 * 5000 + 300;       // k 7: k 3..6 passed over; 3 and 4 are past SIGN_SLACK_MS, and no beat read the price near 5's and 6's moments
  await beatAll(net);
  assert.deepEqual(net.seats[0].list(net.rh).samples.map((x) => x.k), [2, 7]);
});
