// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1181: A LEGACY PRICE SAMPLE (protocol < 5) IS SIGNED ONLY ON ITS LEADER'S ASK. POST /price-sign took any caller's ask: an
// outsider asked every seat first with a price within 0.05 %, collected a threshold, chose BULLS, BEARS or FLAT, and the real leader was
// refused. What a seat signed lived in memory only, and an attested sample could be replaced. Now an ask carries the leader's own
// signature, the one value a seat signs is written to its database before the signature leaves, and the first sample that stands is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { priceSampleId, sampleTick } from '../../arena-protocol/src/price-sample.js';
import { PriceFeed } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;

function network({ price, now, dbs }) {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const rid = roundIdOf(decodeRoundContract(bytes));
  const seats = [];
  const fetcher = async (url, o) => {
    const m = /^seat(\d)\/(price-sign|price-attested)$/.exec(url);
    const s = seats[Number(m[1])];
    const got = m[2] === 'price-sign' ? s.sign(JSON.parse(o.body)) : s.hold(JSON.parse(o.body));
    return { ok: got.ok, status: got.ok ? 200 : got.status, json: async () => got };
  };
  const make = (i) => new PriceFeed({ identity: keys[i], get pubkey() { return keys[i].pubkey; }, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null),
    openRounds: () => [{ roundId: rid, contract: bytes }], db: dbs[i] }, { priceRound: () => true, readPrice: async () => price(), now, fetcher,
    peersFor: () => keys.map((_, j) => `seat${j}`).filter((u) => u !== `seat${i}`), log: () => {} });
  keys.forEach((_, i) => seats.push(make(i)));
  const order = decodeRoundContract(bytes).nodes.map(toHex);
  const seatOf = (i) => seats[keys.findIndex((k) => toHex(k.pubkey) === order[i])];
  return { seats, rid, keys, seatOf, restart: (i) => { seats[i] = make(i); return seats[i]; } };
}
const sigOf = (rid, k, cents, secret) => toHex(schnorr.sign(priceSampleId({ roundId: rid, tick: sampleTick(k), priceCents: cents }), secret));

test('#1181: an outsider asks every seat first with a price within tolerance: nobody signs it, and the real leader\'s sample stands', async () => {
  const t = START + 1 * 5000 + 300;   // sample 2 reads round time 5 s
  const net = network({ price: () => 8297000, now: () => t, dbs: [0, 1, 2, 3, 4, 5, 6].map(() => new DatabaseSync(':memory:')) });
  for (const s of net.seats) await s.read();
  const rh = toHex(net.rid), outsider = b32(0x99);
  const pick = 8297000 + 4000;                                       // within 0.05 % of every seat's reading, of the outsider's choosing
  const ask = { round: rh, kind: 'sample', k: 2, priceCents: pick, leaderSig: sigOf(net.rid, 2, pick, outsider) };
  const took = net.seats.filter((s) => s.sign(ask).ok).length;
  const lead = await net.seatOf(2).leadSample(net.rid, 2);
  console.log(`#1181 outsider's ask at ${pick} cents: ${took} of 7 seats signed it | the leader's own sample: ${lead.ok ? `stands, ${lead.signed} signatures` : `refused - ${lead.why}`}`);
  assert.equal(took, 0, 'no seat signs an ask its leader did not sign');
  assert.equal(lead.ok, true, lead.why);
  assert.equal(lead.priceCents, 8297000);
  assert.match(net.seats.find((s) => s !== net.seatOf(2)).sign({ round: rh, kind: 'sample', k: 2, priceCents: pick }).why, /leader's signature/, 'an ask without one is refused by name');
});

test('#1181: what a seat signed survives its restart: no second price for the same sample', async () => {
  const t = START + 1 * 5000 + 300;
  const dbs = [0, 1, 2, 3, 4, 5, 6].map(() => new DatabaseSync(':memory:'));
  const net = network({ price: () => 8297000, now: () => t, dbs });
  for (const s of net.seats) await s.read();
  const leader = net.seatOf(2), i = net.seats.findIndex((s) => s !== leader);
  const ask = (cents) => ({ round: toHex(net.rid), kind: 'sample', k: 2, priceCents: cents, leaderSig: sigOf(net.rid, 2, cents, leader.round.identity.secret) });
  assert.equal(net.seats[i].sign(ask(8297000)).ok, true);
  const again = net.restart(i); await again.read();
  const second = again.sign(ask(8297100));
  console.log(`#1181 after a restart, a second price for sample 2: ${second.ok ? 'SIGNED' : `refused - ${second.why}`}`);
  assert.equal(second.ok, false);
  assert.match(second.why, /signed another price/);
  assert.equal(again.sign(ask(8297000)).ok, true, 'the same price is signed again');
});

test('#1181: hold keeps the first attested sample of a moment; a second, also standing, does not replace it', async () => {
  const t = START + 1 * 5000 + 300;
  const net = network({ price: () => 8297000, now: () => t, dbs: [0, 1, 2, 3, 4, 5, 6].map(() => new DatabaseSync(':memory:')) });
  const rh = toHex(net.rid);
  const attested = (cents) => ({ round: rh, kind: 'sample', k: 0, priceCents: cents, sigs: net.keys.map((k) => ({ key: toHex(k.pubkey), signature: sigOf(net.rid, 0, cents, k.secret) })) });
  const s = net.seats[3];
  assert.equal(s.hold(attested(8297000)).ok, true);
  const second = s.hold(attested(8299000));
  const held = s.list(rh, 0, [0]).samples[0].priceCents;
  console.log(`#1181 a second attested sample 0: ${second.ok ? 'taken' : 'refused'}; held now ${held} cents`);
  assert.equal(second.ok, false);
  assert.equal(held, 8297000, 'the first stands');
  assert.equal(s.hold(attested(8297000)).ok, true, 'the same one is taken again');
  const back = net.restart(3);
  assert.equal(back.hold(attested(8299000)).ok, false, 'and across a restart (the end is in its database)');
});
