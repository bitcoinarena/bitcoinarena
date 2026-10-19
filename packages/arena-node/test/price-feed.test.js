// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE COMMITTEE'S PRICE FEED (§11): seven seats, each reading its own price; the sample's leader proposes its
// reading, the others sign only what they saw too, and an attested sample is held by every seat once it stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { priceAttestationStands, priceSampleId, sampleTick } from '../../arena-protocol/src/price-sample.js';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PriceFeed, closeSampleK } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;

function network({ readings, now, dbs = null }) {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const contract = { ...base, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) };
  const bytes = encodeRoundContract(contract);
  const rid = roundIdOf(decodeRoundContract(bytes));
  const seats = [];
  const fetcher = async (url, o) => {
    const q = /^seat(\d)\/price-samples\?round=([0-9a-f]{64})&ks=([0-9,]+)$/.exec(url);
    if (q) { const got = seats[Number(q[1])].list(q[2], 0, q[3].split(',').map(Number)); return { ok: true, status: 200, json: async () => got }; }
    const m = /^seat(\d)\/(price-sign|price-attested)$/.exec(url);
    const s = seats[Number(m[1])];
    const got = m[2] === 'price-sign' ? s.sign(JSON.parse(o.body)) : s.hold(JSON.parse(o.body));
    return { ok: got.ok, status: got.ok ? 200 : got.status, json: async () => got };
  };
  keys.forEach((k, i) => {
    const round = { identity: k, get pubkey() { return k.pubkey; }, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null),
      openRounds: () => [{ roundId: rid, contract: bytes }], ...(dbs ? { db: dbs[i] } : {}) };
    seats.push(new PriceFeed(round, { priceRound: () => true, readPrice: async () => readings[i](), now, fetcher,
      peersFor: () => keys.map((_, j) => `seat${j}`).filter((u) => u !== `seat${i}`) }));
  });
  // the leaders by the contract as it reads back (its seats in the order the encoding keeps)
  const order = decodeRoundContract(bytes).nodes.map(toHex);
  const seatOf = (i) => seats[keys.findIndex((k) => toHex(k.pubkey) === order[i])];
  const restart = (i) => { seats[i] = new PriceFeed({ ...seats[i].round }, { priceRound: () => true, readPrice: async () => readings[i](), now, fetcher,
    peersFor: () => keys.map((_, j) => `seat${j}`).filter((u) => u !== `seat${i}`) }); return seats[i]; };
  return { seats, rid, keys, contract, seatOf, restart };
}

test('sample k is led by seat k mod 7: its reading, signed by every seat that read the same within 0.5 %, held by all', async () => {
  let t = START + 1 * 5000 + 300;   // sample 2 reads the price of round time 5 s, one period ahead of its tick
  const prices = [8297193, 8297200, 8296900, 8298000, 8297193, 8297000, 8301000];
  const net = network({ readings: prices.map((p) => () => p), now: () => t });
  for (const s of net.seats) await s.read();
  const lead = net.seats[2];
  const got = await lead.leadSample(net.rid, 2);
  assert.equal(got.ok, true, got.why); assert.equal(got.priceCents, 8296900, 'the leader\'s own reading');
  assert.equal(got.signed, 7, 'all seven read within 0.5 %');
  for (const s of net.seats) {
    const held = s.list(toHex(net.rid)).samples;
    assert.equal(held.length, 1); assert.equal(held[0].tick, sampleTick(2)); assert.equal(held[0].priceCents, 8296900);
    const stands = priceAttestationStands({ id: priceSampleId({ roundId: net.rid, tick: held[0].tick, priceCents: 8296900 }), sigs: held[0].sigs,
      committee: net.keys.map((k) => k.pubkey), threshold: 5, verify: (sg, m, k) => schnorr.verify(sg, m, k) });
    assert.equal(stands.ok, true);
  }
});

test('a leader that proposes a price the others did not see gets no attestation; a seat signs one price per sample, and only now', async () => {
  let t = START + 0 * 5000 + 100;   // sample 1 reads round time 0
  const prices = [8297000, 9000000, 8297000, 8297000, 8297000, 8297000, 8297000];  // seat 1 reads 8.5 % off
  const net = network({ readings: prices.map((p) => () => p), now: () => t });
  for (const s of net.seats) await s.read();
  const lying = net.seats[1];
  const got = await lying.leadSample(net.rid, 1);
  assert.equal(got.ok, false); assert.match(got.why, /1 of the committee signed it, 5 are needed/);
  assert.equal(net.seats[3].list(toHex(net.rid)).samples.length, 0, 'nothing held anywhere');
  const rh = toHex(net.rid);
  assert.equal(net.seats[4].sign({ round: rh, kind: 'sample', k: 1, priceCents: 8297100 }).ok, true);
  assert.match(net.seats[4].sign({ round: rh, kind: 'sample', k: 1, priceCents: 8297050 }).why, /signed another price/);
  assert.match(net.seats[4].sign({ round: rh, kind: 'sample', k: 9, priceCents: 8297000 }).why, /not now/);
  const forged = { round: rh, kind: 'sample', k: 1, priceCents: 1, sigs: [] };
  assert.equal(net.seats[4].hold(forged).ok, false, 'an unattested sample is not held');
});

test('the tape of the 64 prices before the start: led by seat 0 at the start from its own readings, signed and held by all', async () => {
  let t = START - 64 * 5000;
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map((i) => () => 8290000 + Math.floor((t - START) / 5000) * 10 + i), now: () => t });
  for (; t < START; t += 5000) for (const s of net.seats) await s.read();
  t = START - 4000;   // a period before the start: the tape and sample 0 go out now
  const out = await net.seatOf(0).beat();
  const tape = out.find(([what]) => what === 'tape');
  assert.ok(tape && tape[1].ok, tape && tape[1].why);
  for (const s of net.seats) assert.equal(s.list(toHex(net.rid)).tape.prices.length, 64);
  assert.equal(out.find(([what]) => what === 0)[1].ok, true, 'and sample 0, which seat 0 also leads');
  assert.deepEqual(await net.seatOf(1).beat(), [], 'seat 1 leads neither the tape nor sample 0');
});

test('who won the round (§13 RoundResult): the open is sample 0 and the close the last sample at or before the last tick, BULLS, signed by all seven seats; the client takes it at the threshold', async () => {
  const { roundVerdict } = await import('../../arena-client/src/round-verdict.js');
  const { msForTicks } = await import('../../arena-protocol/src/tick.js');
  let t; let price;
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map(() => () => price), now: () => t });
  const rh = toHex(net.rid);
  const kClose = closeSampleK(Number(net.contract.blockTicks));
  assert.ok(sampleTick(kClose) <= Number(net.contract.blockTicks) && sampleTick(kClose + 1) > Number(net.contract.blockTicks), 'the closing sample is the last at or before the last tick');
  for (const [k, p] of [[0, 8297000], [3, 8299000], [kClose, 8300500]]) {
    t = START + (k - 1) * 5000 + 300; price = p;
    for (const s of net.seats) await s.read();
    const got = await net.seatOf(k % 7).leadSample(net.rid, k);
    assert.equal(got.ok, true, got.why);
  }
  assert.match((await net.seats[0].result(rh)).why, /its result is made at its end/, 'not before the round has ended');
  t = START + Number(msForTicks(BigInt(net.contract.blockTicks)).ms) + 1000;
  const r = await net.seats[0].result(rh);
  assert.deepEqual([r.ok, r.openCents, r.closeCents, r.front, r.samples], [true, 8297000, 8300500, 'BULLS', 2], r.why);
  const verify = (sg, m, k) => schnorr.verify(sg, m, k);
  const asking = (n) => async (url) => {
    const i = Number(/^seat(\d)\/round-result/.exec(url)[1]);
    const got = await net.seats[i].result(rh);
    return { ok: got.ok, status: got.ok ? 200 : 409, json: async () => got, text: async () => got.why || '' };
  };
  const committee = net.keys.map((k) => k.pubkey);
  const all = await roundVerdict({ roundId: net.rid, nodes: [0, 1, 2, 3, 4, 5, 6].map((i) => `seat${i}`), committee, verify, fetcher: asking() });
  assert.deepEqual([all.ok, all.front, all.signers, all.needed, all.says], [true, 'BULLS', 7, 5, 'THE BULLS WIN (+0.04%)'], all.why);
  const four = await roundVerdict({ roundId: net.rid, nodes: [0, 1, 2, 3].map((i) => `seat${i}`), committee, verify, fetcher: asking() });
  assert.equal(four.ok, false); assert.match(four.why, /no result is signed by 5 of the committee \(at most 4 agree\)/);
  // a seat outside the committee counts nothing
  const outsiders = await roundVerdict({ roundId: net.rid, nodes: [0, 1, 2, 3, 4, 5, 6].map((i) => `seat${i}`), committee: [b32(9), b32(8)], verify, fetcher: asking(), threshold: 1 });
  assert.equal(outsiders.ok, false);
});

test('the ends survive a restart and are asked of the committee (measured on testnet4 2026-10-14: the samples lived in memory only, and seats restarted during a 6 h round each held a different first sample)', async () => {
  const { msForTicks } = await import('../../arena-protocol/src/tick.js');
  let t; let price;
  const dbs = [0, 1, 2, 3, 4, 5, 6].map(() => new DatabaseSync(':memory:'));
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map(() => () => price), now: () => t, dbs });
  const rh = toHex(net.rid);
  const kClose = closeSampleK(Number(net.contract.blockTicks));
  for (const [k, p] of [[0, 8300000], [2, 8299000], [5, 8301000], [kClose, 8290000]]) {
    t = START + (k - 1) * 5000 + 300; price = p;
    for (const s of net.seats) await s.read();
    assert.equal((await net.seatOf(k % 7).leadSample(net.rid, k)).ok, true);
  }
  t = START + Number(msForTicks(BigInt(net.contract.blockTicks)).ms) + 1000;
  // every seat restarts after the round: what it keeps is its database, and only the two ends are written there
  for (let i = 0; i < 7; i++) net.restart(i);
  const rows = dbs[0].prepare('SELECT k FROM price_ends WHERE round = ? ORDER BY k').all(rh).map((x) => Number(x.k));
  assert.deepEqual(rows, [0, kClose], 'sample 0 and the closing sample are written, the samples between are not');
  const a = await net.seats[0].result(rh);
  assert.deepEqual([a.ok, a.openCents, a.closeCents, a.front], [true, 8300000, 8290000, 'BEARS'], a.why);
  // a seat whose database lost them asks the committee, and keeps them only as they stand
  dbs[3].exec('DELETE FROM price_ends'); net.restart(3);
  const b = await net.seats[3].result(rh);
  assert.deepEqual([b.ok, b.openCents, b.closeCents, b.signature === a.signature], [true, 8300000, 8290000, false], b.why);
  assert.equal(dbs[3].prepare('SELECT count(*) AS n FROM price_ends').get().n, 2, 'and writes what it fetched');
  // no seat holds them: no result, never an open of its own (the samples between are no stand-in for sample 0)
  for (const d of dbs) d.exec('DELETE FROM price_ends');
  for (let i = 0; i < 7; i++) net.restart(i);
  t = START + (6 - 1) * 5000 + 300;
  const late = net.seats[0];
  const c = (t = START + Number(msForTicks(BigInt(net.contract.blockTicks)).ms) + 1000, await late.result(rh));
  assert.equal(c.ok, false); assert.match(c.why, /no attested opening sample \(k 0\)/);
});

// THE INTERIM RULES (RULED 2026-10-14 ~21:50Z: B, C and D until protocol 5 signs each seat's own reading)
test('C: a reading older than one period (5 s) is no reading - a seat that holds only that signs nothing', async () => {
  let t = START + 0 * 5000 + 100;   // sample 1 reads round time 0
  // every seat's price is a trade 6 s old when it is read (the cached-feed case): not kept
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map(() => () => ({ cents: 8297000, atMs: t - 6000 })), now: () => t });
  for (const s of net.seats) assert.equal(await s.read(), null, 'a price older than one period is not read');
  const rh = toHex(net.rid);
  assert.match(net.seats[4].sign({ round: rh, kind: 'sample', k: 1, priceCents: 8297000 }).why, /no reading of its own/);
  // a fresh trade (1 s old) is a reading, and is signed
  const fresh = network({ readings: [0, 1, 2, 3, 4, 5, 6].map(() => () => ({ cents: 8297000, atMs: t - 1000 })), now: () => t });
  for (const s of fresh.seats) await s.read();
  assert.equal(fresh.seats[4].sign({ round: toHex(fresh.rid), kind: 'sample', k: 1, priceCents: 8297000 }).ok, true);
});

test('C: a reading more than one period away from the moment a sample reads is not used for it', async () => {
  let t = START + 0 * 5000 + 100;
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map(() => () => ({ cents: 8297000, atMs: t })), now: () => t });
  for (const s of net.seats) await s.read();
  assert.equal(net.seats[0].ownAt(START), 8297000, 'within one period');
  assert.equal(net.seats[0].ownAt(START + 5100 + 100), null, '5.1 s later: no reading of its own for that moment');
  assert.equal(net.seats[0].ownAt(START - 5100 + 100), null, '5.1 s earlier: none either');
});

test('D: a proposed price outside 0.05 % of the seat\'s own reading is refused; inside, it is signed', async () => {
  let t = START + 0 * 5000 + 100;
  const own = 8297000;
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map(() => () => own), now: () => t });
  for (const s of net.seats) await s.read();
  const rh = toHex(net.rid);
  const out = Math.round(own * 1.00051), edge = Math.floor(own * 1.0005), below = Math.ceil(own * 0.9995);
  assert.match(net.seats[3].sign({ round: rh, kind: 'sample', k: 1, priceCents: out }).why, /not within 0.05 %/);
  assert.match(net.seats[5].sign({ round: rh, kind: 'sample', k: 1, priceCents: Math.round(own * 1.005) }).why, /not within 0.05 %/, 'what 0.5 % let through is refused');
  assert.equal(net.seats[2].sign({ round: rh, kind: 'sample', k: 1, priceCents: edge }).ok, true);
  assert.equal(net.seats[6].sign({ round: rh, kind: 'sample', k: 1, priceCents: below }).ok, true);
});
