// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FEED LETS GO OF A FINISHED ROUND (kanban #742: the test host seats ran out of their 1,024 MB heap about hourly; the per-round
// maps of price-feed.js - samples, tapes, signed, heard, heardTapes, mine, endsAsked, built - kept every price round forever). A
// round closed on the seat and past max(closed, end) + its objection window leaves every one of them; an open round, or a closed
// one still inside its window, keeps all it holds. After that its result and its ends are still answered, from price_ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { PriceFeed, closeSampleK } from '../src/price-feed.js';

const TEN_MINUTES = 600000;   // the held line comes at most this often

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;
const OPEN = 0, CLOSED = 1;
const MAPS = ['samples', 'tapes', 'signed', 'heard', 'heardTapes', 'mine', 'built', 'endsAsked'];

// seven seats, each with its own database, on two price rounds A and B of protocol `version`; `rows` is the rounds table the seats
// share (state, closed_ms), `down` the seats a post or an ask does not reach
function network({ price, now, version, down = new Set(), lines = [] }) {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const rounds = [0, 1].map((i) => {
    const bytes = encodeRoundContract({ ...base, protocolVersion: version, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START), censusHeight: base.censusHeight + i });
    const contract = decodeRoundContract(bytes);
    const rid = roundIdOf(contract);
    return { bytes, contract, rid, rh: toHex(rid), state: OPEN, closed_ms: null };
  });
  const byHex = new Map(rounds.map((r) => [r.rh, r]));
  const dbs = keys.map(() => new DatabaseSync(':memory:'));
  const seats = [];
  const fetcher = async (url, o) => {
    const i = Number(/^seat(\d)\//.exec(url)[1]);
    if (down.has(i)) throw new Error('that seat is down');
    const q = /^seat\d\/price-samples\?round=([0-9a-f]{64})&ks=([0-9,]+)$/.exec(url);
    let got;
    if (q) got = seats[i].list(q[1], 0, q[2].split(',').map(Number));
    else {
      const door = /^seat\d\/(price-sign|price-attested|price-reading)$/.exec(url)[1];
      const body = JSON.parse(o.body);
      got = door === 'price-sign' ? seats[i].sign(body) : door === 'price-attested' ? seats[i].hold(body) : seats[i].reading(body);
    }
    return { ok: got.ok !== false, status: got.ok === false ? got.status : 200, json: async () => got };
  };
  keys.forEach((k, i) => {
    const round = { identity: k, get pubkey() { return k.pubkey; }, db: dbs[i],
      get: (id) => { const r = byHex.get(toHex(id)); return r ? { contract: r.bytes, state: r.state, closed_ms: r.closed_ms } : null; },
      openRounds: () => rounds.filter((r) => r.state === OPEN).map((r) => ({ roundId: r.rid, contract: r.bytes })) };
    seats.push(new PriceFeed(round, { priceRound: () => true, readPrice: async () => price(), now, fetcher, log: (l) => lines.push(l),
      peersFor: () => keys.map((_, j) => `seat${j}`).filter((u) => u !== `seat${i}`) }));
  });
  return { seats, rounds, dbs, keys };
}

// the round hexes a seat's maps hold, map by map (the `${round}:...` maps by their round part)
const held = (feed) => Object.fromEntries(MAPS.map((m) => [m, new Set([...feed[m].keys()].map((key) => key.slice(0, 64)))]));

// play both rounds: every seat reads the 64 moments before the start, then beats at the start, at sample 3 and at the close
async function play(net, setPrice, { shortAtClose = null } = {}, down) {
  const c = net.rounds[0].contract;
  const kClose = closeSampleK(Number(c.blockTicks));
  for (let j = 64; j >= 1; j--) { setPrice(START - j * 5000 + 300, 8297000); for (const s of net.seats) await s.read(); }
  for (const [k, p] of [[0, 8297000], [3, 8299000], [kClose, 8296000]]) {
    setPrice(START + (k - 1) * 5000 + 300, p);
    if (k === kClose && shortAtClose !== null) down.add(shortAtClose);
    for (const s of net.seats) await s.read();   // every seat has read the moment before a leader asks it to sign
    for (const s of net.seats) await s.beat();
    down.clear();
  }
  return kClose;
}

for (const version of [5, 4]) {
  test(`protocol ${version}: a closed round past its objection window leaves every map, the open round keeps all it holds, and both still answer`, async () => {
    let t = 0; let p = 0;
    const down = new Set();
    const lines = [];
    const net = network({ price: () => p, now: () => t, version, down, lines });
    const setPrice = (at, cents) => { t = at; p = cents; };
    // protocol 5: seat 6 misses the others' closing readings, so its result asks the committee (endsAsked)
    const kClose = await play(net, setPrice, { shortAtClose: version >= 5 ? 6 : null }, down);
    const [A, B] = net.rounds;
    const c = A.contract;
    const endMs = START + Number(msForTicks(BigInt(c.blockTicks)).ms);
    t = endMs + 1000;
    const seat = version >= 5 ? net.seats[6] : net.seats[0];
    const before = {};
    for (const r of net.rounds) {
      const got = await seat.result(r.rh);
      assert.equal(got.ok, true, got.why);
      before[r.rh] = got;
    }
    // what this seat holds of both rounds, map by map: every map the protocol uses holds both
    const used = version >= 5 ? ['heard', 'heardTapes', 'mine', 'built', 'endsAsked'] : ['samples', 'tapes', 'signed'];
    for (const m of used) for (const r of net.rounds) assert.ok(held(seat)[m].has(r.rh), `${m} holds round ${r.rh.slice(0, 8)} before`);

    // A closes on every seat at the round's end; B stays open
    const finishAt = Math.max(endMs + 2000, Number(roundEndMs(c))) + Number(c.objectionWindowMs);
    A.state = CLOSED; A.closed_ms = endMs + 2000;
    // inside its objection window: nothing is let go of, and the first tidy logs the sizes
    t = finishAt - 1;
    assert.deepEqual(seat.tidy(), []);
    for (const m of used) for (const r of net.rounds) assert.ok(held(seat)[m].has(r.rh), `${m} still holds ${r.rh.slice(0, 8)} inside A's window`);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[prices\] held: samples \d+ \(\d+\), tapes \d+, signed \d+, heard \d+ \(\d+\), heardTapes \d+, mine \d+, built \d+, endsAsked \d+; 0 finished round\(s\) let go of since the last line$/);

    // past it: A leaves every map; B keeps every entry it had
    t = finishAt;
    const sizesB = Object.fromEntries(used.map((m) => [m, [...seat[m].keys()].filter((key) => key.startsWith(B.rh)).length]));
    assert.deepEqual(seat.tidy(), [A.rh]);
    for (const m of MAPS) assert.equal(held(seat)[m].has(A.rh), false, `${m} let go of A`);
    for (const m of used) assert.equal([...seat[m].keys()].filter((key) => key.startsWith(B.rh)).length, sizesB[m], `${m} keeps all of B`);
    assert.equal(lines.length, 1, 'at most one held line every 10 minutes');

    // A's result and its ends are still answered, from the database - the same result as before
    for (const r of [A, B]) {
      const got = await seat.result(r.rh);
      assert.equal(got.ok, true, got.why);
      assert.deepEqual([got.openCents, got.closeCents, got.front, got.readings], [before[r.rh].openCents, before[r.rh].closeCents, before[r.rh].front, before[r.rh].readings]);
      const ends = seat.list(r.rh, 0, [0, kClose]).samples;
      assert.deepEqual(ends.map((x) => x.k), [0, kClose]);
      if (version >= 5) for (const x of ends) assert.equal(x.readings.length, 7, `all seven readings of end ${x.k}`);
    }
    // B, open, still serves every sample it holds to a page
    assert.deepEqual(seat.list(B.rh).samples.map((x) => x.k), [0, 3, kClose]);
    // a peer short of A's ends gets them from this seat alone (the others do not answer), after the let-go
    const peer = net.seats[3];
    for (const m of MAPS) peer[m].clear();
    net.dbs[3].exec('DELETE FROM price_ends');
    for (let i = 0; i < 7; i++) if (net.seats[i] !== seat) down.add(i);
    const fromPeers = await peer.result(A.rh);
    down.clear();
    assert.deepEqual([fromPeers.ok, fromPeers.openCents, fromPeers.closeCents], [true, before[A.rh].openCents, before[A.rh].closeCents], fromPeers.why);

    // what those reads held again of A is let go of by the next tidy, and the line comes 10 minutes after the last
    t = finishAt + TEN_MINUTES;
    assert.deepEqual(seat.tidy(), [A.rh]);
    for (const m of MAPS) assert.equal(held(seat)[m].has(A.rh), false);
    assert.equal(lines.length, 2);
    assert.match(lines[1], /; 2 finished round\(s\) let go of since the last line$/);

    // B closes too and its window passes: the seat holds nothing of either
    B.state = CLOSED; B.closed_ms = t;
    t += Number(c.objectionWindowMs);
    assert.deepEqual(seat.tidy(), [B.rh]);
    for (const m of MAPS) assert.equal(seat[m].size, 0, `${m} is empty`);
    assert.equal((await seat.result(B.rh)).ok, true);
  });
}

test('a seat without a database lets go of nothing: its ends live in memory only', async () => {
  const keys = [{ secret: b32(41), pubkey: schnorr.getPublicKey(b32(41)) }];
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const bytes = encodeRoundContract({ ...base, protocolVersion: 5, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START) });
  const rh = toHex(roundIdOf(decodeRoundContract(bytes)));
  const feed = new PriceFeed({ identity: keys[0], pubkey: keys[0].pubkey, get: () => ({ contract: bytes, state: CLOSED, closed_ms: 0 }), openRounds: () => [] },
    { priceRound: () => true, now: () => START * 2, log: () => {} });
  feed.mine.set(`${rh}:0`, { k: 0 }); feed.heard.set(rh, new Map([[0, new Map()]]));
  assert.deepEqual(feed.tidy(), []);
  assert.equal(feed.mine.size + feed.heard.size, 2);
});
