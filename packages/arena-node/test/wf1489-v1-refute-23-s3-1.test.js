// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// (fixture copied from wf1489-v1-refute-23-s2-1.test.js) #1489 v1-refute-23 skeptic 3 (concurrent signing race), variants of #1516. PROTOCOL 5 AT THE SEATS (RULED 2026-10-14 ~21:50Z): seven seats of a protocol-5 round, each reading its own
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


// the network, as in s2-1, but each seat's fetcher knows who asks (`from`), and `hold(from, to)` may stall an answer: the attacker
// (seat 6) answers its own GET /price-samples as slowly as it likes - up to the 10 s timeout - and so picks when a seat's exchange ends
function network({ readings, now, dbs, hold }) {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, protocolVersion: 5, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const contract = decodeRoundContract(bytes);
  const rid = roundIdOf(contract);
  const seats = [];
  const fetcherOf = (from) => async (url, o) => {
    const i = Number(/^seat(\d)\//.exec(url)[1]);
    const q = /^seat\d\/price-samples\?round=([0-9a-f]{64})&ks=([0-9,]+)$/.exec(url);
    if (q) await hold.fn(from, i);
    let got;
    if (q) got = seats[i].list(q[1], 0, q[2].split(',').map(Number));
    else { const body = JSON.parse(o.body); got = seats[i].reading(body); }
    return { ok: got.ok !== false, status: got.ok === false ? got.status : 200, json: async () => got };
  };
  keys.forEach((k, i) => {
    seats.push(new PriceFeed({ identity: k, get pubkey() { return k.pubkey; }, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null),
      openRounds: () => [{ roundId: rid, contract: bytes }], db: dbs[i] }, { priceRound: () => true, readPrice: async () => readings[i](), now, fetcher: fetcherOf(i),
      peersFor: () => keys.map((_, j) => `seat${j}`).filter((u) => u !== `seat${i}`) }));
  });
  return { seats, rid, rh: toHex(rid), keys, contract };
}
function verdict(results, label) {
  const groups = new Map();
  for (const r of results) if (r.ok) groups.set(r.resultId, (groups.get(r.resultId) || 0) + 1);
  console.log(`${label} honest results by id:`, JSON.stringify([...groups].map(([id, n]) => [id.slice(0, 8), n])), 'refused:', results.filter((r) => !r.ok).map((r) => r.why || r.status).join(' | '));
  const best = Math.max(0, ...groups.values());
  assert.ok(best + 1 >= 5, `${label}: the honest seats split ${JSON.stringify([...groups].map(([id, n]) => [id.slice(0, 8), n]))}: no result of the round can gather 5 of 7 signatures`);
}

async function setup({ attackerReads }) {
  const box = { t: 0, base: 0 };
  const hold = { fn: async () => {} };
  const dbs = [0, 1, 2, 3, 4, 5, 6].map(() => new DatabaseSync(':memory:'));
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map((i) => () => box.base + i * 10), now: () => box.t, dbs, hold });
  const kClose = closeSampleK(Number(net.contract.blockTicks));
  const who = attackerReads ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 4, 5];
  for (const [k, p] of [[0, 8297000], [3, 8299000], [kClose, 8296000]]) { box.t = START + (k - 1) * 5000 + 300; box.base = p; for (const i of who) await net.seats[i].beat(); }
  const atk = net.keys[6];
  const signed = (k, cents) => ({ round: net.rh, kind: 'sample', k, priceCents: cents, key: toHex(atk.pubkey),
    signature: toHex(schnorr.sign(priceReadingId({ roundId: net.rid, tick: sampleTick(k), priceCents: cents }), atk.secret)) });
  box.t = START + Number(msForTicks(BigInt(net.contract.blockTicks)).ms) + 1000;
  return { net, box, kClose, signed, hold };
}

// The attacker's lever: seats 3-5 ask seat 6 last (peersFor order); seat 6 stalls its answer to them. Meanwhile seats 0-2 run their whole
// exchange (seats 3-5 have signed nothing, hold nothing new) and sign. Then seat 6 hands seats 3-5 its second reading and answers. Their
// exchange already passed seats 0-2 before those signed, so they hold no peer result - and #result5 signs at once (every key is in).
async function race(net, late, release) {
  let open; const gate = new Promise((r) => { open = r; });
  const stalled = new Set();
  net.hold.fn = async (from, to) => { if (to === 6 && [3, 4, 5].includes(from)) { stalled.add(from); await gate; await release(from); } };
  const later = [3, 4, 5].map((i) => late(i));
  for (let n = 0; n < 200 && stalled.size < 3; n++) await new Promise((r) => setImmediate(r));
  assert.equal(stalled.size, 3, 'seats 3-5 reached their ask of seat 6');
  return { later, open };
}

test('wf1489 v1-refute-23 s3 #1: a second close reading handed out in a stalled answer, while seats 0-2 sign, must not split the result', async () => {
  const s = await setup({ attackerReads: true });
  const { net, kClose, signed } = s; net.hold = s.hold;
  const { later, open } = await race(net, (i) => net.seats[i].result(net.rh), async (from) => { net.seats[from].reading(signed(kClose, 9000000)); });
  const results = [];
  for (const i of [0, 1, 2]) results.push(await net.seats[i].result(net.rh));
  open();
  results.push(...await Promise.all(later));
  verdict(results, 's3 #1 (stalled answer, second close)');
});

test('wf1489 v1-refute-23 s3 #2: a withheld close reading handed out once in a stalled answer, while seats 0-2 sign, must not split the result', async () => {
  const s = await setup({ attackerReads: false });
  const { net, box, kClose, signed } = s; net.hold = s.hold;
  // everyone asked once already (the "still short" wait starts) - a stranger's GET /round-result
  for (const i of [0, 1, 2, 3, 4, 5]) { const r = await net.seats[i].result(net.rh); assert.equal(r.ok, false); }
  box.t += 61000;
  const { later, open } = await race(net, (i) => net.seats[i].result(net.rh), async (from) => {
    net.seats[from].reading(signed(0, 8297060)); net.seats[from].reading(signed(kClose, 9000000)); });
  const results = [];
  for (const i of [0, 1, 2]) results.push(await net.seats[i].result(net.rh));
  open();
  results.push(...await Promise.all(later));
  verdict(results, 's3 #2 (stalled answer, withheld single reading)');
});
