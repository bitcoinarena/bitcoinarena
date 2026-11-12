// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE DOOR IS A SEAT'S OWN, A ROUND'S MEMBERSHIP IS NOT (kanban #1071, §17). Seven seats, 5 of 7. A seat short of an entry five seats hold takes it from
// a peer past its door and signs what they sign; an entry fewer than five seats took is no member: ENTRY_VOID where it is held, and the other entry
// has nobody to play. Measured on the rounds of #1068: the short seat signed VOID and answered "no loser's lock".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled, standing } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const player = (name, k) => ({ name, key: b32(k), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const signed = (d, w, eid) => d.round.results(w.rid, eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey))
  .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; });
const reveal = (w, played, move, salt, seats = w.nodes) => Promise.all(seats.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`,
  { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt) }) }).then((r) => r.text())));
// A DOOR THAT REFUSES ONE PLAYER, ON ITS OWN READ OF ITS OWN CHAIN (the backup rule measured on #1068: 13 of 39 misses): a client's copy and a peer's copy alike
const shutDoor = (d, playerKey) => {
  const real = d.round.enter;
  d.round.enter = function (contract, ...more) {
    if (!more.length && toHex(contract.playerPubkey) === toHex(playerKey)) throw new Error('entry refused: the backup rule');
    return real.call(this, contract, ...more);
  };
};
const seatsHolding = (w, eid) => w.nodes.filter((d) => d.round.entry(eid)).length;

test('a seat short of an entry five seats hold takes it past its door and signs what they sign; the plan reaches it', async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, player('scissors', 0x61), { hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true });
    const short = w.nodes[6];
    shutDoor(short, b32(0x62));
    const b = await lockAndPlay(w, player('rock', 0x62), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true, unreached: [6] });
    await new Promise((r) => setTimeout(r, 2500));                  // the relay has had its go at that door
    assert.equal(seatsHolding(w, b.eid), 6, 'six seats hold the second entry and the seventh refused it');
    assert.ok(!short.round.entry(b.eid), 'the door let it in');
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, SCISSORS, sa);
    await reveal(w, b, ROCK, sb, w.nodes.slice(0, 6));
    await closeRound(w);
    const settled = await untilSettled(w, 45000);
    const said = { a: signed(short, w, a.eid), b: signed(short, w, b.eid), held: !!short.round.entry(b.eid), state: settled.state, why: settled.why };
    console.log('  FACTS (short seat):', JSON.stringify(said));
    assert.deepEqual(said.a, ['FAILED 0'], `the short seat signed ${said.a} for the entry it held`);
    assert.ok(short.round.entry(b.eid), 'the short seat never took the entry');
    assert.ok(short.round.stakeLock(b.eid) && short.round.feeLock(b.eid), 'it took the entry without its locks');
    assert.ok(short.round.payoutAddress(b.eid), 'it took the winner without the address it is paid at');
    assert.deepEqual(said.b, ['DELIVERED 2']);
    assert.equal(settled.state, 'ACCEPTED', settled.why);
    for (const d of w.nodes) assert.ok(!d.round.entryVoid(b.eid));
    let own;
    for (const stop = Date.now() + 15000; Date.now() < stop && (own = await standing(short, w)).state !== 'ACCEPTED';) await new Promise((r) => setTimeout(r, 250));
    assert.equal(own.state, 'ACCEPTED', `the short seat's own settlement: ${own.why}`);
  } finally { await w.close(); }
});

test('an entry fewer than five seats took is no member: ENTRY_VOID where it is held, the other entry VOID at every seat, no seat signs a loser', async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, player('scissors', 0x63), { hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true });
    const refusers = [4, 5, 6];
    refusers.forEach((i) => shutDoor(w.nodes[i], b32(0x64)));
    const b = await lockAndPlay(w, player('rock', 0x64), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true, unreached: refusers });
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(seatsHolding(w, b.eid), 4);
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, SCISSORS, sa);
    await reveal(w, b, ROCK, sb, w.nodes.slice(0, 4));
    await closeRound(w);
    const said = w.nodes.map((d) => ({ a: signed(d, w, a.eid), b: signed(d, w, b.eid), held: !!d.round.entry(b.eid), void: !!d.round.entryVoid(b.eid) }));
    console.log('  FACTS (below five):', JSON.stringify(said));
    for (const [i, s] of said.entries()) {
      assert.deepEqual(s.a, ['VOID 0'], `seat ${i} signed ${s.a} for the entry with nobody to play`);
      assert.deepEqual(s.b, [], `seat ${i} signed ${s.b} for an entry that is no member`);
      assert.equal(s.void, i < 4, `seat ${i}: ENTRY_VOID where it is held and nowhere else`);
      assert.equal(s.held, i < 4, `seat ${i}: only a seat that took it holds it`);
    }
    const asked = await fetch(`http://127.0.0.1:${w.nodes[0].port}/settlement?entry=${toHex(b.eid)}`).then((r) => r.json());
    assert.equal(asked.finality, 'ENTRY_VOID', 'the seat tells the client the entry was not taken');
  } finally { await w.close(); }
});

test('during a roll: seats on the old build still sign the two entries they hold, and the entry below five still comes to a refund at every seat', async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, player('scissors', 0x67), { hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true });
    const refusers = [4, 5, 6];
    refusers.forEach((i) => shutDoor(w.nodes[i], b32(0x68)));
    const b = await lockAndPlay(w, player('rock', 0x68), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true, unreached: refusers });
    await new Promise((r) => setTimeout(r, 2500));
    for (const d of w.nodes.slice(0, 2)) d.round.putEntryVoid = () => {};   // an old seat records no such void, so it decides the two entries it holds
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, SCISSORS, sa);
    await reveal(w, b, ROCK, sb, w.nodes.slice(0, 4));
    await closeRound(w);
    const { resultFinality } = await import('../src/finality.js');
    const decided = (d) => ['FINAL', 'VOID'].includes(resultFinality(d.round, w.rid, a.eid).state);
    for (const stop = Date.now() + 25000; Date.now() < stop && !w.nodes.every(decided);) await new Promise((r) => setTimeout(r, 250));
    const said = w.nodes.map((d) => ({ signedA: signed(d, w, a.eid), a: resultFinality(d.round, w.rid, a.eid).state, void: !!d.round.entryVoid(b.eid) }));
    console.log('  FACTS (roll):', JSON.stringify(said));
    assert.deepEqual(said.slice(0, 2).map((s) => s.signedA), [['FAILED 0'], ['FAILED 0']], 'the old seats sign as they always did');
    for (const s of said.slice(2)) assert.deepEqual(s.signedA, ['VOID 0']);
    for (const [i, s] of said.entries()) assert.ok(s.a === 'FINAL' || s.a === 'VOID', `seat ${i}: entry a is ${s.a}`);
    for (const d of w.nodes) assert.notEqual((await standing(d, w)).state, 'ACCEPTED', 'something was claimed from a round nobody played');
  } finally { await w.close(); }
});

test('a peer cannot talk a seat into an entry: a result with a bad signature or about another player counts for nothing', async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  let stub;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, player('scissors', 0x65), { hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true });
    const b = await lockAndPlay(w, player('rock', 0x66), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true });
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, SCISSORS, sa);
    await reveal(w, b, ROCK, sb);
    await closeRound(w);
    const seat = w.nodes[0], entry = (await import('../../arena-protocol/src/contracts.js')).decodeEntryContract(seat.round.entry(b.eid));
    const records = seat.round.results(w.rid, b.eid).map((r) => Buffer.from(r.bytes));
    assert.ok(records.length >= 5, `${records.length} results held`);
    const { createServer } = await import('node:http');
    let serve = Buffer.concat(records);
    stub = createServer((_, res) => { res.writeHead(200); res.end(serve); });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    const peers = seat.verifier.peers;
    seat.verifier.peers = [`http://127.0.0.1:${stub.address().port}`];
    const count = () => seat.verifier.signersNaming(w.rid, b.eid, entry.playerPubkey).then((s) => s.size);
    assert.equal(await count(), records.length, 'the true records count');
    // kanban #2063: about this entry (its reveal record) and seated (not VOID) - both entries were played, so every true record still counts;
    // read against the other entry's contract (another reveal record) none does
    const entryA = (await import('../../arena-protocol/src/contracts.js')).decodeEntryContract(seat.round.entry(a.eid));
    assert.equal(await seat.verifier.signersNaming(w.rid, b.eid, entry.playerPubkey, { seated: true, entry }).then((s) => s.size), records.length, 'a seated record about this entry did not count');
    assert.equal(await seat.verifier.signersNaming(w.rid, a.eid, entry.playerPubkey, { entry: entryA }).then((s) => s.size), 0, 'a record about another entry counted');
    serve = Buffer.concat(records.map((r) => { const x = Buffer.from(r); x[x.length - 1] ^= 1; return x; }));
    assert.equal(await count(), 0, 'a broken signature counted');
    const other = (await import('../../arena-protocol/src/contracts.js')).decodeEntryContract(seat.round.entry(a.eid)).playerPubkey;
    serve = Buffer.concat(records);
    assert.equal(await seat.verifier.signersNaming(w.rid, b.eid, other).then((s) => s.size), 0, 'a result about another player counted');
    seat.verifier.peers = peers;
  } finally { if (stub) stub.close(); await w.close(); }
});
