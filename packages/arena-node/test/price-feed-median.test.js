// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// PROTOCOL 5 AT THE SEATS (RULED 2026-10-14 ~21:50Z): seven seats of a protocol-5 round, each reading its own
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

test('every seat signs its own reading and posts it - no leader, no proposal - and every seat holds the median of the seven', async () => {
  const t = START + 1 * 5000 + 300;   // sample 2 reads the price of round time 5 s, one period ahead of its tick
  const prices = [8297193, 8297200, 8296900, 8298000, 8297193, 8297000, 8301000];
  const net = network({ readings: prices.map((p) => () => p), now: () => t });
  const out = await beatAll(net);
  for (const o of out) assert.deepEqual(o.find(([what]) => what === 2)[1].ok, true);
  assert.ok(net.posts.length === 42 && net.posts.every((d) => d === 'price-reading'), 'each of seven posts its reading to the six others; nothing asks a seat to sign');
  for (const s of net.seats) {
    const held = s.list(net.rh).samples;
    assert.equal(held.length, 1);
    assert.deepEqual([held[0].k, held[0].tick, held[0].priceCents, held[0].readings.length], [2, sampleTick(2), 8297193, 7], 'the 4th of 8296900, 8297000, 8297193, 8297193, 8297200, 8298000, 8301000');
    const again = priceSampleStands5({ roundId: net.rid, tick: held[0].tick, readings: held[0].readings, committee: net.committee, threshold: 5, verify });
    assert.deepEqual([again.ok, again.priceCents], [true, 8297193], 'anyone recomputes it from the readings served');
    // each reading is its seat's own price, signed by that seat alone
    for (const r of held[0].readings) assert.equal(r.priceCents, prices[net.keys.findIndex((k) => toHex(k.pubkey) === r.key)]);
  }
  // the proposal doors refuse a protocol-5 round, both ways
  assert.match(net.seats[3].sign({ round: net.rh, kind: 'sample', k: 2, priceCents: 8297193 }).why, /takes no proposed price/);
  assert.match(net.seats[3].hold({ round: net.rh, kind: 'sample', k: 2, priceCents: 8297193, sigs: [] }).why, /takes no proposed price/);
  assert.equal((await net.seats[0].leadSample(net.rid, 2)).ok, false, 'nobody leads a price');
});

test('an outlier seat cannot move the median beyond the honest range; a seat signs one reading a sample, and only at its moment', async () => {
  let t = START + 0 * 5000 + 300;   // sample 1 reads round time 0
  const prices = [8297000, 8297100, 999999999, 8297200, 8297300, 1, 8297400];   // seats 2 and 5 lie, one high and one low
  const net = network({ readings: prices.map((p) => () => p), now: () => t });
  await beatAll(net);
  const s = net.seats[0].list(net.rh).samples[0];
  assert.deepEqual([s.priceCents, s.readings.length], [8297200, 7]);
  assert.ok(s.priceCents >= 8297000 && s.priceCents <= 8297400);
  // the same seat's reading of sample 1 again is the same signed reading; of sample 9 it is not its moment
  const a = net.seats[4].ownReading(net.rid, 1), b = net.seats[4].ownReading(net.rid, 1);
  assert.deepEqual([a.ok, a.priceCents, a.signature === b.signature], [true, 8297300, true]);
  assert.match(net.seats[4].ownReading(net.rid, 9).why, /not now/);
  t += 20000;
  assert.match(net.seats[4].ownReading(net.rid, 2).why, /not now/, 'sample 2 read 5 s after the start: 25 s later is too late to sign one');
});

test('at the door: a forged reading, a key outside the committee, a v4 round - refused; a key that reads twice counts for none', async () => {
  const t = START + 0 * 5000 + 300;
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map((i) => () => 8297000 + i * 100), now: () => t });
  const seat = net.seats[0];
  const sign = (k, priceCents, secret) => toHex(schnorr.sign(priceReadingId({ roundId: net.rid, tick: sampleTick(k), priceCents }), secret));
  const body = (i, priceCents, k = 1) => ({ round: net.rh, kind: 'sample', k, priceCents, key: toHex(net.keys[i].pubkey), signature: sign(k, priceCents, net.keys[i].secret) });
  assert.deepEqual(seat.reading(body(1, 8297100)), { ok: true, kept: true });
  assert.deepEqual(seat.reading(body(1, 8297100)), { ok: true, kept: false }, 'the same reading again (a new signature over it) is no second reading');
  assert.match(seat.reading({ ...body(2, 8297200), priceCents: 8299999 }).why, /does not verify/, 'forged: signed 8297200, posted as 8299999');
  assert.match(seat.reading({ ...body(2, 8297200), key: toHex(net.keys[3].pubkey) }).why, /does not verify/, 'one seat\'s signature under another\'s key');
  const stranger = b32(99);
  assert.match(seat.reading({ ...body(2, 8297200), key: toHex(schnorr.getPublicKey(stranger)), signature: sign(1, 8297200, stranger) }).why, /key of the round's committee/);
  assert.match(seat.reading(body(2, 8297200, 99999)).why, /names its sample, k 0\.\./);
  for (const i of [2, 3, 4, 5]) seat.reading(body(i, 8297000 + i * 100));
  assert.deepEqual(seat.list(net.rh, 0, [1]).samples[0].priceCents, 8297300, 'five readings (seats 1-5): their median');
  // seat 5 signs a second, different reading of the same sample: it counts for none, and the sample falls to four
  assert.deepEqual(seat.reading(body(5, 8297999)), { ok: true, kept: true });
  const held = seat.list(net.rh, 0, [1]).samples[0];
  assert.deepEqual([held.priceCents, held.readings.length], [null, 6], 'both of seat 5\'s readings are served - so a seat that fetches them sees it too - and none counts');
  assert.equal(seat.list(net.rh).samples.length, 0, 'four distinct readings stand nothing');
  // a round below protocol 5 takes no reading
  const v4 = network({ readings: [0, 1, 2, 3, 4, 5, 6].map(() => () => 8297000), now: () => t, version: 4 });
  assert.match(v4.seats[0].reading({ ...body(1, 8297100), round: v4.rh }).why, /proposed samples: a signed reading is a protocol 5 price/);
});

test('fewer than five readings stand nothing; six stand at the lower middle, served SERVE_AFTER_MS after the moment', async () => {
  let t = START + 0 * 5000 + 300;
  const prices = [8297000, 8297100, 8297200, 8297300, 8297400, 8297500, 8297600];
  const four = network({ readings: prices.map((p) => () => p), now: () => t });
  await beatAll(four, [0, 1, 2, 3]);
  assert.deepEqual(four.seats[0].list(four.rh).samples, [], 'four seats read: no sample');
  const six = network({ readings: prices.map((p) => () => p), now: () => t, down: new Set([6]) });
  await beatAll(six, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(six.seats[0].list(six.rh).samples, [], 'six of seven in: not served before SERVE_AFTER_MS, the seventh may still come');
  t = START + SERVE_AFTER_MS;
  const s = six.seats[0].list(six.rh).samples[0];
  assert.deepEqual([s.priceCents, s.readings.length], [8297200, 6], 'the lower of 8297200 and 8297300');
});

test('the tape: each seat signs its own 64 readings before the start once; every position is the median, and a seat that missed a moment signs none', async () => {
  let t = START - 64 * 5000;
  const off = (i) => (i === 6 ? 500000 : i);   // seat 6 reads far off on every moment
  // seat 5 reads nothing for 15 s (three grid points): no reading within one period of the moment between them
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map((i) => () => (i === 5 && Math.abs(t - (START - 30 * 5000)) <= 5000 ? null : 8290000 + Math.floor((t - START) / 5000) * 10 + off(i))), now: () => t });
  for (; t < START; t += 5000) for (const s of net.seats) await s.read();
  t = START - 4000;   // a period before the start: the tape goes out now (and sample 0)
  const out = await beatAll(net);
  assert.match(out[5].find(([w]) => w === 'tape')[1].why, /did not read every moment/, 'seat 5 missed one moment and fills none');
  assert.equal(out[0].find(([w]) => w === 'tape')[1].ok, true);
  assert.equal(net.seats[0].list(net.rh).tape, null, 'six of seven tapes: not served before SERVE_AFTER_MS');
  t = START - 5000 + SERVE_AFTER_MS;
  for (const s of net.seats) {
    const tape = s.list(net.rh).tape;
    assert.equal(tape.readings.length, 6);
    assert.deepEqual(tape.prices, Array.from({ length: 64 }, (_, j) => 8290000 + (j - 64) * 10 + 2), 'the lower middle of 0,1,2,3,4,(far): 2');
    assert.equal(priceTapeStands5({ roundId: net.rid, tapes: tape.readings, committee: net.committee, threshold: 5, verify }).ok, true);
  }
  // a page's batch carrying the tape and sample 0 as served stands at a seat as protocol 5 (round.js passes median)
  const s0 = net.seats[2].list(net.rh).samples.find((x) => x.k === 0);
  const tape = net.seats[2].list(net.rh).tape;
  const batch = decodeInputBatch(encodeInputBatch({ roundId: net.rid, entryId: b32(2), previousHash: b32(3), firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [], loads: [],
    samples: [[0, centsToTapeUnits(s0.priceCents)]], tapes: [[0, ...tape.prices.map(centsToTapeUnits)]],
    attests: [[0, 2, s0.priceCents, s0.readings.map((r) => [fromHex(r.key), r.priceCents, fromHex(r.signature)])], [0, 3, tape.prices, tape.readings.map((r) => [fromHex(r.key), r.prices, fromHex(r.signature)])]] }));
  assert.deepEqual(checkBatchPrices({ batch, roundId: net.rid, committee: net.committee, threshold: 5, verify, require: true, median: true }), { ok: true, attested: 2 });
});

test('RoundResult from medians, end to end: the ends\' readings are kept across restarts and asked of the committee; all seven sign one result', async () => {
  const { roundVerdict } = await import('../../arena-client/src/round-verdict.js');
  let t; let base;
  const dbs = [0, 1, 2, 3, 4, 5, 6].map(() => new DatabaseSync(':memory:'));
  // each seat's own reading: the market plus its own small offset; seat 6 lies far low on every reading
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map((i) => () => (i === 6 ? 100 : base + [0, 30, -20, 10, 0, 50, 0][i])), now: () => t, dbs });
  const kClose = closeSampleK(Number(net.contract.blockTicks));
  for (const [k, p] of [[0, 8297000], [3, 8299000], [kClose, 8296000]]) {
    t = START + (k - 1) * 5000 + 300; base = p;
    await beatAll(net);
  }
  // seat 4 restarts and its database lost the closing sample's readings: it asks the committee at the end
  dbs[4].exec(`DELETE FROM price_ends WHERE k = ${kClose}`); net.restart(4);
  assert.match((await net.seats[0].result(net.rh)).why, /its result is made at its end/);
  t = START + Number(msForTicks(BigInt(net.contract.blockTicks)).ms) + 1000;
  const r = await net.seats[0].result(net.rh);
  // open: 8297000 +[0,30,-20,10,0,50] and 100 -> sorted 100, 8296980, 8297000, 8297000, 8297010, 8297030, 8297050 -> 8297000
  // close: 8296000 + the same -> 8296000: the median of honest readings, never the liar's 100
  assert.deepEqual([r.ok, r.openCents, r.closeCents, r.front, r.readings], [true, 8297000, 8296000, 'BEARS', { open: 7, close: 7 }], r.why);
  const rows = dbs[0].prepare('SELECT k, cents FROM price_ends WHERE round = ? ORDER BY k').all(net.rh).map((x) => [Number(x.k), Number(x.cents)]);
  assert.deepEqual(rows, [[0, 8297000], [kClose, 8296000]], 'only the two ends are written, with their readings');
  // seat 4 lost the closing readings: it asks the committee, takes what verifies, and makes the same result
  const r4 = await net.seats[4].result(net.rh);
  assert.deepEqual([r4.ok, r4.openCents, r4.closeCents, r4.readings], [true, 8297000, 8296000, { open: 7, close: 7 }], r4.why);
  assert.equal(dbs[4].prepare('SELECT count(*) AS n FROM price_ends').get().n, 2, 'and writes what it fetched');
  // every seat restarts after the round: the ends come back from its database
  for (let i = 0; i < 7; i++) net.restart(i);
  const asking = async (url) => {
    const i = Number(/^seat(\d)\/round-result/.exec(url)[1]);
    const got = await net.seats[i].result(net.rh);
    return { ok: got.ok, status: got.ok ? 200 : 409, json: async () => got, text: async () => got.why || '' };
  };
  const all = await roundVerdict({ roundId: net.rid, nodes: [0, 1, 2, 3, 4, 5, 6].map((i) => `seat${i}`), committee: net.committee, verify, fetcher: asking });
  assert.deepEqual([all.ok, all.front, all.signers, all.needed], [true, 'BEARS', 7, 5], all.why);
  // no seat holds five readings of the open: no result, and no seat makes one up
  for (const d of dbs) d.exec('DELETE FROM price_ends WHERE k = 0');
  for (let i = 0; i < 7; i++) net.restart(i);
  const none = await net.seats[0].result(net.rh);
  assert.equal(none.ok, false); assert.match(none.why, /no opening sample \(k 0\) of the round stands/);
});
