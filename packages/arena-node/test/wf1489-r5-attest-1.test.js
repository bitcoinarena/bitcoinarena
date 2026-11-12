// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 r5 attest 1: ONE committee seat pads its GET /price-samples answer. An honest seat making a protocol-5 RoundResult asks
// the committee for the ends' readings (price-feed.js #fetchReadings) and hands every reading of the answer to reading(), which runs a
// BIP-340 verify BEFORE it sees that the reading is one it already holds. So one seat repeating its (valid) readings costs every
// honest seat one verify per copy, on its main thread. Safe: one peer's answer costs at most a bounded number of checks per sample
// (each committee key read at most twice), whatever its length.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { PriceFeed, closeSampleK } from '../src/price-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;
const COPIES = 300;

function network({ readings, now, dbs, padBy }) {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, protocolVersion: 5, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const contract = decodeRoundContract(bytes);
  const rid = roundIdOf(contract);
  const seats = [];
  const state = { pad: false };
  const fetcher = async (url, o) => {
    const i = Number(/^seat(\d)\//.exec(url)[1]);
    const q = /^seat\d\/price-samples\?round=([0-9a-f]{64})&ks=([0-9,]+)$/.exec(url);
    let got;
    if (q) {
      got = seats[i].list(q[1], 0, q[2].split(',').map(Number));
      // THE ATTACK: seat `padBy` answers its true readings, each repeated COPIES times
      if (state.pad && i === padBy) got = { ...got, samples: got.samples.map((s) => ({ ...s, readings: Array.from({ length: COPIES }, () => s.readings).flat() })) };
    } else {
      const body = JSON.parse(o.body);
      got = seats[i].reading(body);
    }
    return { ok: got.ok !== false, status: got.ok === false ? got.status : 200, json: async () => got };
  };
  const make = (i, round) => new PriceFeed(round, { priceRound: () => true, readPrice: async () => readings[i](), now, fetcher,
    peersFor: () => keys.map((_, j) => `seat${j}`).filter((u) => u !== `seat${i}`) });
  keys.forEach((k, i) => {
    seats.push(make(i, { identity: k, get pubkey() { return k.pubkey; }, get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null),
      openRounds: () => [{ roundId: rid, contract: bytes }], db: dbs[i] }));
  });
  const restart = (i) => { seats[i] = make(i, { ...seats[i].round }); return seats[i]; };
  return { seats, rid, rh: toHex(rid), keys, contract, state, restart };
}

test('one committee seat padding its GET /price-samples answer does not cost an honest seat one signature check per copy', async () => {
  let t; let base;
  const dbs = [0, 1, 2, 3, 4, 5, 6].map(() => new DatabaseSync(':memory:'));
  const net = network({ readings: [0, 1, 2, 3, 4, 5, 6].map((i) => () => base + i * 10), now: () => t, dbs, padBy: 6 });
  const kClose = closeSampleK(Number(net.contract.blockTicks));
  for (const [k, p] of [[0, 8297000], [kClose, 8296000]]) { t = START + (k - 1) * 5000 + 300; base = p; for (const s of net.seats) await s.beat(); }
  // seat 0 restarts with its ends lost: at the end it asks the committee, and seat 6 answers padded
  dbs[0].exec('DELETE FROM price_ends'); net.restart(0);
  net.state.pad = true;
  const seat = net.seats[0];
  let checks = 0;
  const orig = seat.reading.bind(seat);
  seat.reading = (body, persist) => { checks++; return orig(body, persist); };
  t = START + Number(msForTicks(BigInt(net.contract.blockTicks)).ms) + 1000;
  const t0 = performance.now();
  const r = await seat.result(net.rh);
  const ms = performance.now() - t0;
  console.log(`honest seat 0: result ok=${r.ok}, ${checks} readings checked (each one BIP-340 verify) in ${Math.round(ms)} ms; seat 6 answered ${COPIES} copies of its readings`);
  assert.equal(r.ok, true, r.why);
  // six peers, two ends, seven keys each read at most twice: anything beyond that is one peer buying the seat's CPU
  // per exchange at most 6 peers x 2 samples x 7 keys x 2 readings; since kanban #2077 a seat asks the committee a second time when an end
  // reading came in during its exchange (wf1489-fix-v1-refute-23), so two exchanges - bounded, never one check per copy
  assert.ok(checks <= 2 * 6 * 2 * 7 * 2, `one peer's padded answer cost ${checks} signature checks (bound ${2 * 6 * 2 * 7 * 2})`);
});
