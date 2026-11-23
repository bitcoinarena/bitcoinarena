// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #2694: the committee's liquidation feed. Every seat holds the exchange's forceOrder stream; an event becomes (tick, size) of a
// round from the exchange's own fields, the tick's leader signs it and asks the others, each signs only what its own stream saw,
// and the attestation that stands is held by every seat (GET /liquidations) - the batch then carries it as kind 4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { decodeRoundContract, encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { liquidationEventId, liquidationAttestationStands } from '../../arena-protocol/src/price-sample.js';
import { readFileSync } from 'node:fs';
import { ticksForMs } from '../../arena-protocol/src/tick.js';
import { DatabaseSync } from 'node:sqlite';
import { LiquidationFeed, parseForceOrder, liquidationSizeOf, liquidationTick, LIQ_DELAY_MS } from '../src/liquidation-feed.js';

const CONTRACT_HEX = readFileSync(new URL('../../arena-client/test/page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];
const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1791700000000;
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const frame = (T, q, ap, s = 'BTCUSDT') => JSON.stringify({ e: 'forceOrder', E: T + 3, o: { s, S: 'SELL', o: 'LIMIT', f: 'IOC', q, p: ap, ap, X: 'FILLED', l: q, z: q, T } });

function network({ now, dbs = null }) {
  const keys = [1, 2, 3, 4, 5, 6, 7].map((n) => { const secret = b32(n + 40); return { secret, pubkey: schnorr.getPublicKey(secret) }; });
  const base = decodeRoundContract(fromHex(CONTRACT_HEX));
  const contract = { ...base, nodes: keys.map((k) => k.pubkey), startTimeMs: BigInt(START), entryCloseMs: BigInt(START + 3600000) };
  const bytes = encodeRoundContract(contract);
  const rid = roundIdOf(decodeRoundContract(bytes));
  const seats = [];
  const fetcher = async (url, o) => {
    const m = /^seat(\d)\/(liquidation-sign|liquidation-attested)$/.exec(url);
    const s = seats[Number(m[1])];
    const got = m[2] === 'liquidation-sign' ? await s.sign(JSON.parse(o.body)) : s.hold(JSON.parse(o.body));
    return { ok: got.ok, status: got.ok ? 200 : got.status, json: async () => got, text: async () => JSON.stringify(got) };
  };
  const make = (i) => new LiquidationFeed({ identity: keys[i], get pubkey() { return keys[i].pubkey; },
    get: (id) => (toHex(id) === toHex(rid) ? { contract: bytes } : null), openRounds: () => [{ roundId: rid, contract: bytes }], ...(dbs ? { db: dbs[i] } : {}) },
  { liqRound: () => true, now, fetcher, signWaitMs: 0, later: () => {}, peersFor: () => keys.map((_, j) => `seat${j}`).filter((u) => u !== `seat${i}`) });
  keys.forEach((_, i) => seats.push(make(i)));
  const order = decodeRoundContract(bytes).nodes.map(toHex);
  const seatOf = (i) => seats[keys.findIndex((k) => toHex(k.pubkey) === order[i])];
  const restart = (i) => { seats[i] = make(i); return seats[i]; };
  return { seats, rid, keys, seatOf, restart, n: order.length };
}

test('#2694 a forceOrder frame reads as the exchange time and the notional; size and tick come from them alone', () => {
  const ev = parseForceOrder(frame(START + 60000, '12.500', '81766.45'));
  assert.deepEqual(ev, { atMs: START + 60000, usd: 12.5 * 81766.45 });
  assert.equal(parseForceOrder(frame(START, '1', '80000', 'ETHUSDT')), null, 'another symbol is not the round\'s market');
  assert.equal(parseForceOrder('{"e":"trade"}'), null);
  assert.equal(parseForceOrder('not json'), null);
  assert.equal(liquidationSizeOf(1e6), 65536, 'one million USD is 1.0 in Q16.16');
  assert.equal(liquidationSizeOf(12.5 * 81766.45), Math.round(12.5 * 81766.45 * 65536 / 1e6));
  assert.equal(liquidationSizeOf(1), 1, 'a liquidation is never size 0');
  // the strike lands LIQ_DELAY_MS after the exchange's own time, so the attestation reaches the page before its tick
  assert.equal(liquidationTick(START, START), Number(ticksForMs(BigInt(LIQ_DELAY_MS)).ticks));
  assert.equal(liquidationTick(START, START + 1000), Number(ticksForMs(BigInt(1000 + LIQ_DELAY_MS)).ticks));
});

test('#2694 the tick\'s leader signs what its stream saw, the others sign what theirs saw, every seat holds the attestation', async () => {
  const T = START + 60000;
  const net = network({ now: () => T + 500 });
  const f = frame(T, '12.500', '81766.45');
  const tick = liquidationTick(START, T), size = liquidationSizeOf(12.5 * 81766.45);
  for (const s of net.seats) await s.see(parseForceOrder(f), { lead: false });
  const got = await net.seatOf(tick % net.n).see(parseForceOrder(f));   // the same frame once more: kept once, led now
  assert.equal(got.length, 1); assert.equal(got[0].ok, true, got[0].why);
  for (const s of net.seats) {
    const held = s.held(toHex(net.rid));
    assert.equal(held.length, 1);
    assert.equal(held[0][0], tick); assert.equal(held[0][1], size);
    const st = liquidationAttestationStands({ id: liquidationEventId({ roundId: net.rid, tick, size }), sigs: held[0][2].map(([key, signature]) => ({ key, signature })), committee: net.keys.map((k) => k.pubkey), threshold: 5, verify });
    assert.equal(st.ok, true, st.why);
  }
});

test('#2694 a seat signs no event its own stream did not see, one size a tick, kept across a restart', async () => {
  const T = START + 60000;
  const dbs = Array.from({ length: 7 }, () => new DatabaseSync(':memory:'));
  const net = network({ now: () => T + 500, dbs });
  const tick = liquidationTick(START, T), size = liquidationSizeOf(12.5 * 81766.45);
  const s = net.seats[0];
  const ask = (sz) => s.sign({ round: toHex(net.rid), tick, size: sz });
  assert.match((await ask(size)).why, /did not see/);
  s.see(parseForceOrder(frame(T, '12.500', '81766.45')), { lead: false });
  assert.equal((await ask(size + 65536)).ok, false, 'a size the stream did not see');
  const one = await ask(size); assert.equal(one.ok, true, one.why);
  assert.ok(verify(fromHex(one.signature), liquidationEventId({ roundId: net.rid, tick, size }), fromHex(one.key)));
  // a second event at the same tick does not make the seat sign another size for it, after a restart either
  const again = net.restart(0);
  await again.see(parseForceOrder(frame(T, '12.500', '81766.45')), { lead: false });
  assert.equal((await again.sign({ round: toHex(net.rid), tick, size })).ok, true, 'the size it signed it signs again');
  await again.see(parseForceOrder(frame(T, '7.500', '81766.45')), { lead: false });
  assert.match((await again.sign({ round: toHex(net.rid), tick, size: liquidationSizeOf(20 * 81766.45) })).why, /signed another size/);
  // an event before the round's start or after its run is no strike of the round
  assert.match((await s.sign({ round: toHex(net.rid), tick: 0, size })).why, /did not see/);
  assert.deepEqual(await net.seats[1].see(parseForceOrder(frame(START - 60000, '1', '80000'))), []);
});

test('#2694 an attestation short of the threshold is not held; the first that stands is kept', async () => {
  const T = START + 60000;
  const net = network({ now: () => T + 500 });
  const tick = liquidationTick(START, T), size = liquidationSizeOf(12.5 * 81766.45);
  const id = liquidationEventId({ roundId: net.rid, tick, size });
  const sigs = net.keys.map((k) => ({ key: toHex(k.pubkey), signature: toHex(schnorr.sign(id, k.secret)) }));
  const s = net.seats[3];
  assert.equal(s.hold({ round: toHex(net.rid), tick, size, sigs: sigs.slice(0, 4) }).ok, false);
  assert.equal(s.hold({ round: toHex(net.rid), tick, size, sigs: sigs.slice(0, 5) }).ok, true);
  const id2 = liquidationEventId({ roundId: net.rid, tick, size: size + 1 });
  const sigs2 = net.keys.map((k) => ({ key: toHex(k.pubkey), signature: toHex(schnorr.sign(id2, k.secret)) }));
  assert.equal(s.hold({ round: toHex(net.rid), tick, size: size + 1, sigs: sigs2 }).ok, false, 'one attested liquidation a tick');
  assert.deepEqual(s.held(toHex(net.rid)).map(([t, z]) => [t, z]), [[tick, size]]);
  assert.deepEqual(s.held(toHex(net.rid), tick + 1), [], 'from a tick on');
});
