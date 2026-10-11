// THE COMMITTEE'S PRICE FEED (§11, kanban #311): seven seats, each reading its own price; the sample's leader proposes its
// reading, the others sign only what they saw too, and an attested sample is held by every seat once it stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { priceAttestationStands, priceSampleId, sampleTick } from '../../arena-protocol/src/price-sample.js';
import { readFileSync } from 'node:fs';
import { PriceFeed } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;

function network({ readings, now }) {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const contract = { ...base, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) };
  const bytes = encodeRoundContract(contract);
  const rid = roundIdOf(decodeRoundContract(bytes));
  const seats = [];
  const fetcher = async (url, o) => {
    const m = /^seat(\d)\/(price-sign|price-attested)$/.exec(url);
    const s = seats[Number(m[1])];
    const got = m[2] === 'price-sign' ? s.sign(JSON.parse(o.body)) : s.hold(JSON.parse(o.body));
    return { ok: got.ok, status: got.ok ? 200 : got.status, json: async () => got };
  };
  keys.forEach((k, i) => {
    const round = { identity: k, get pubkey() { return k.pubkey; }, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null),
      openRounds: () => [{ roundId: rid, contract: bytes }] };
    seats.push(new PriceFeed(round, { priceRound: () => true, readPrice: async () => readings[i](), now, fetcher,
      peersFor: () => keys.map((_, j) => `seat${j}`).filter((u) => u !== `seat${i}`) }));
  });
  // the leaders by the contract as it reads back (its seats in the order the encoding keeps)
  const order = decodeRoundContract(bytes).nodes.map(toHex);
  const seatOf = (i) => seats[keys.findIndex((k) => toHex(k.pubkey) === order[i])];
  return { seats, rid, keys, contract, seatOf };
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
