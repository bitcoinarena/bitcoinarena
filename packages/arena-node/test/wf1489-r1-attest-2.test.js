// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// (fixture copied from price-feed-median.test.js) PROTOCOL 5 AT THE SEATS (RULED 2026-10-14 ~21:50Z): seven seats of a protocol-5 round, each reading its own
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


// kanban #1489 r1-attest-1: ONE committee seat equivocates on the closing sample and shows its second reading to only some seats.
// Seats that heard one reading count it (7 readings), seats that heard both count it for none (6) - every seat already holds a reading
// of every key, so none asks the committee again - and the two groups sign different closes: neither reaches 5 of 7, and no RoundResult
// of the round stands (a market on the game is VOID). Safe: the honest seats sign one result, or enough of them agree for it to stand.
test('wf1489 r1-attest-1: one seat showing a second closing reading to half the committee must not split the round result', async () => {
  let t; let base;
  const dbs = [0, 1, 2, 3, 4, 5, 6].map(() => new DatabaseSync(':memory:'));
  // honest seats 0..5 read base + 10 i; seat 6 (the attacker) reads far high
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map((i) => () => (i === 6 ? 999999999 : base + i * 10)), now: () => t, dbs });
  const kClose = closeSampleK(Number(net.contract.blockTicks));
  for (const [k, p] of [[0, 8297000], [3, 8299000], [kClose, 8296000]]) { t = START + (k - 1) * 5000 + 300; base = p; await beatAll(net); }
  // THE ATTACK: seat 6 signs a second, different closing reading and posts it to seats 3, 4 and 5 only (POST /price-reading)
  const atk = net.keys[6];
  const second = 1;
  const body = { round: net.rh, kind: 'sample', k: kClose, priceCents: second, key: toHex(atk.pubkey),
    signature: toHex(schnorr.sign(priceReadingId({ roundId: net.rid, tick: sampleTick(kClose), priceCents: second }), atk.secret)) };
  for (const i of [3, 4, 5]) assert.deepEqual(net.seats[i].reading(body), { ok: true, kept: true });
  t = START + Number(msForTicks(BigInt(net.contract.blockTicks)).ms) + 1000;
  const results = [];
  for (const i of [0, 1, 2, 3, 4, 5]) results.push(await net.seats[i].result(net.rh));
  const groups = new Map();
  for (const r of results) if (r.ok) { const k = `${r.openCents}:${r.closeCents}`; groups.set(k, (groups.get(k) || 0) + 1); }
  console.log('wf1489 r1-attest-1 honest results by close:', JSON.stringify([...groups]));
  // the attacker adds its own signature to whichever group it likes: the largest honest group plus one must still reach 5 of 7
  const best = Math.max(0, ...groups.values());
  assert.ok(best + 1 >= 5, `the honest seats split ${JSON.stringify([...groups])}: no result of the round can gather 5 of 7 signatures`);
});
