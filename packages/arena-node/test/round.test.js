// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// One process holds a round: open it, take an entry, store batches, close it.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { openStore, OPEN, CLOSED } from '../src/store.js';
import { Round } from '../src/round.js';
import { roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
const fresh = () => new Round(openStore(), () => 1234, { plugins: HOSTED });

test('the round id is the tagged hash of its contract, not the node\'s idea', () => {
  const r = fresh(), c = contract();
  assert.equal(toHex(r.open(c)), toHex(roundId(c)));
});

test('the entry id is the tagged hash of its contract', () => {
  const r = fresh(), c = contract();
  const rid = r.open(c);
  const e = entryFor(rid);
  assert.equal(toHex(r.enter(e)), toHex(entryId(e)));
});

test('a batch is stored tick by tick, and a repeat writes nothing', () => {
  const r = fresh(), c = contract();
  const rid = r.open(c); const e = entryFor(rid); const eid = r.enter(e);
  const bytes = encodeInputBatch({
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
    ticks: [[65536, 0, 0, 0, 0], [65536, 100, 0, 0, 0], [65536, 200, 0, 0, 0]],
    liquidations: [[11, 3 * 65536]],
  });
  assert.equal(r.batch(bytes), 3, 'three ticks were new');
  assert.equal(r.batch(bytes), 0, 'the same message again writes nothing');
  assert.equal(r.batch(bytes), 0, 'and again');
  const t = r.transcript(rid, eid);
  assert.equal(t.ticks.length, 3);
  assert.deepEqual(t.liquidations, [[11, 3 * 65536]], 'nor is the strike doubled');
});

test('a batch that would leave a gap is refused, and says which tick is due', () => {
  const r = fresh(), c = contract();
  const rid = r.open(c); const e = entryFor(rid); const eid = r.enter(e);
  // The chain fixes the ORDER of batches; the ticks inside them may still
  // skip, which is what a gap is.
  const send = (first, n) => {
    const b = { roundId: rid, entryId: eid, previousHash: r.head(rid, eid), firstTick: first,
      ticks: Array.from({ length: n }, (_, i) => [65536, first + i, 0, 0, 0]), liquidations: [] };
    return r.batch(encodeInputBatch(b));
  };
  send(0, 12);
  // A gap is REFUSED, not stored. It used to be stored and shown by `gaps()`,
  // and that let the node accept a transcript it could not later hand over -
  // measured: ticks 0..9 then 20..29 went in, and handOver threw with nobody
  // left to ask. The refusal names the tick it is waiting for, which is the
  // one thing the client needs to carry on.
  assert.throws(() => send(20, 2), /expected tick 12, got 20/);
  assert.deepEqual(r.gaps(rid, eid), [], 'so there is never a hole to report');
  send(12, 8);
  assert.deepEqual(r.transcript(rid, eid).ticks.map((x) => x.tick).slice(-1), [19]);
});

test('the words come back exactly as they went in', () => {
  const r = fresh(), c = contract();
  const rid = r.open(c); const e = entryFor(rid); const eid = r.enter(e);
  const words = [[65536, -22000, 0, 65536, 1], [0, 0, 65536, 0, 0]];
  r.batch(encodeInputBatch({ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: words, liquidations: [] }));
  assert.deepEqual(r.transcript(rid, eid).ticks.map((x) => x.words), words);
});

test('a closed round takes nothing more', () => {
  const r = fresh(), c = contract();
  const rid = r.open(c); const e = entryFor(rid); const eid = r.enter(e);
  assert.equal(r.close(rid), true);
  assert.equal(r.close(rid), false, 'closing twice is not an error, it is a no-op');
  assert.equal(r.get(rid).state, CLOSED);
  assert.throws(() => r.enter(entryFor(rid)), /closed/);
  assert.throws(() => r.batch(encodeInputBatch({
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [] })), /closed/);
});

test('a batch for a round or an entry the node has not got is refused', () => {
  const r = fresh(), c = contract();
  const rid = r.open(c); const e = entryFor(rid); const eid = r.enter(e);
  assert.throws(() => r.batch(encodeInputBatch({
    roundId: b32(99), entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [] })), /no such round/);
  assert.throws(() => r.batch(encodeInputBatch({
    roundId: rid, entryId: b32(99), previousHash: GENESIS, firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [] })), /no such entry/);
});

/**
 * THE NODE REACHES FOR THE SIMULATOR THROUGH EXACTLY ONE DOOR.
 *
 * This test used to say "nothing here imports the core", and that was the
 * right rule while the daemon only stored and served. Section 13 needs the
 * other thing - seven nodes replay a finished run and five must agree - so
 * `replay.js` imports it, and NOTHING ELSE MAY. The rule did not get weaker;
 * it got a name. A second file stepping the core is the live parallel
 * simulator the client's own header argues against, and it would arrive
 * exactly like this: one more import, in one more place, for one good reason.
 */
//
// AND SINCE M3 R1 (2026-09-15 08:03/08:07: the signer nodes replay the core a round names; several
// cores at once) THE DOOR HAS TWO HALVES: one file brings the cores, and replay.js is the only file that STEPS one, the
// core it is handed. Since (a game is a plugin) NO engine file imports a core at all: the launcher, main.js,
// imports the game's registration (core/plugin/nextblock.js) and hands it to serve(), and plugins.js passes each round's
// core on. Measured before the split: the one file that did both was replay.js; before, cores.js imported the cores.
test('the node imports no core and registers no game, and only the sandbox\'s driver steps a core', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const imports = [];
  const registrations = [];
  const steps = [];
  // THE GUARD READS CODE, NOT PROSE. This file is written in long comments, and one of them in
  // preflight.js says "this M3 step (RULED 2026-09-20...)" - which the bare regex read as a core being
  // stepped inside the preflight. Comments are taken out first, so the rule is about what the node DOES.
  const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const f of readdirSync(new URL('../src/', import.meta.url).pathname)) {
    const src = codeOf(readFileSync(new URL('../src/' + f, import.meta.url).pathname, 'utf8'));
    if (/packages\/core|@blwp\/core|core\/src|core\/frozen/.test(src)) imports.push(f);
    if (/core\/plugin\//.test(src)) registrations.push(f);
    if (/\bstep\s*\(/.test(src)) steps.push(f);
  }
  assert.deepEqual(imports, [], 'an engine file imports a core');
  // since not even the launcher: main.js hosts what ARENA_GAMES names, arena-node/bin/node.mjs names Next Block
  assert.deepEqual(registrations, [], 'an engine file registers a game');
  // since (spec §0A.6) the one door is core-driver.js, run inside the core's sandbox; replay.js hands it the run
  assert.deepEqual(steps, ['core-driver.js'], 'a core is stepped somewhere other than the sandbox\'s driver, or nowhere');

  // and that door replays a finished transcript - neither it nor replay.js ticks anything
  for (const f of ['replay.js', 'core-driver.js']) {
    const src = readFileSync(new URL('../src/' + f, import.meta.url).pathname, 'utf8');
    assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(src), `${f} runs a clock, which is a live second simulator`);
  }
});

test('opening or joining twice is the same round and the same player', () => {
  const r = fresh(), c = contract();
  const first = r.open(c);
  const again = r.open(c);
  assert.equal(toHex(again), toHex(first), 'the id is the hash of the contract; a repeat is not a conflict');
  assert.equal(r.db.prepare('SELECT COUNT(*) n FROM rounds').get().n, 1);

  const e = entryFor(first);
  assert.equal(toHex(r.enter(e)), toHex(r.enter(e)));
  assert.equal(r.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 1, 'one player, not two');
});

test('a round outlives the process that opened it', async () => {
  const { rmSync } = await import('node:fs');
  const path = '/tmp/arena-node-persist.db';
  rmSync(path, { force: true });
  const c = contract();
  let id;
  // The clock is after the committee forms, because entry opens then (5A.5).
  // This test is about a round surviving a restart, not about the window.
  { const r = new Round(openStore(path), () => 600, { plugins: HOSTED }); id = r.open(c); r.enter(entryFor(id)); }
  { const r = new Round(openStore(path), () => 700, { plugins: HOSTED });
    assert.ok(r.get(id), 'the round is still there after a fresh handle');
    assert.equal(r.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 1); }
  rmSync(path, { force: true });
});


test('a player who joined late starts at his own joinTick, not at zero', () => {
  const r = fresh(), c = contract();
  const rid = r.open(c);
  const eid = r.enter({ ...entryFor(rid), joinTick: 50 });
  assert.equal(r.nextTick(rid, eid), 50, 'read off the contract he signed');
  assert.throws(() => r.batch(encodeInputBatch({
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
    ticks: [[0, 0, 0, 0, 0]], liquidations: [] })), /expected tick 50, got 0/);
  assert.equal(r.batch(encodeInputBatch({
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 50,
    ticks: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]], liquidations: [[51, 9]] })), 2);
  assert.equal(r.handOver(rid, eid).ticks, 2);
});

/**
 * A BATCH LANDS WHOLE OR NOT AT ALL - and that is also why it is one commit (2026-09-17 19:15, the ghost lag).
 *
 * Every row written outside a transaction is its own commit, so a batch of six ticks with a sample cost seven disk
 * syncs on the thread that also pushes other players' trucks: measured live, `batch stored` held that loop 24-46 ms.
 * The rows land together now. What that must mean, and what this measures, is that a batch which fails part of the way
 * through leaves the store exactly as it was.
 */
test('a batch that fails part of the way through leaves no tick behind', () => {
  const r = fresh(), c = contract();
  const rid = r.open(c); const e = entryFor(rid); const eid = r.enter(e);
  const bytes = encodeInputBatch({
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
    ticks: [[65536, 0, 0, 0, 0], [65536, 100, 0, 0, 0], [65536, 200, 0, 0, 0]], liquidations: [],
  });
  // The rows go in and the batch row cannot: the store is left as it was, not three ticks into a batch nobody holds.
  r.db.exec('ALTER TABLE batches RENAME TO batches_away');
  assert.throws(() => r.batch(bytes));
  r.db.exec('ALTER TABLE batches_away RENAME TO batches');
  assert.equal(r.transcript(rid, eid).ticks.length, 0, 'a failed batch left its ticks in the store');
  assert.equal(r.nextTick(rid, eid), 0, 'a failed batch moved the run on');

  // AND THE SAME BATCH LANDS WHOLE once the store is whole again.
  assert.equal(r.batch(bytes), 3);
  assert.equal(r.transcript(rid, eid).ticks.length, 3);
});


// KANBAN (2026-10-04 14:30): the 15 s grace after entry_close is gone - a late-join round takes a new entry only
// before start + 37 s, when more than 45 s of its run (to start + 82 s) remain; late-entry-cutoff.test.js has the rest.
test('a late-join round takes a new entry until start + 37 s, refuses one from then, and takes the same entry again after (2026-10-04)', () => {
  let now = 0;
  const r = new Round(openStore(), () => now, { plugins: HOSTED });
  const c = { ...contract(), entryCloseMs: contract().startTimeMs + 45000n, seriesId: new Uint8Array(32).fill(3), roundIndex: 0 };
  const rid = r.open(c);
  now = Number(c.startTimeMs) + 5000;                         // 5 s in: a join tick of 0 is within the clock's 10 s
  const eid = r.enter(entryFor(rid));
  now = Number(c.startTimeMs) + 37000;                        // 45 s of the run left: a new entry is refused by name
  assert.throws(() => r.enter({ ...entryFor(rid), worldSecret: new Uint8Array(32).fill(9) }), /45 s or less of its run left/);
  assert.equal(toHex(r.enter(entryFor(rid))), toHex(eid), 'the same entry posted again is still taken');
});

test('a round closing entry at its start keeps the old door: no time limit at entry', () => {
  let now = 0;
  const r = new Round(openStore(), () => now, { plugins: HOSTED });
  const c = contract();
  const rid = r.open(c);
  now = Number(c.startTimeMs) + 600000;
  assert.ok(r.enter(entryFor(rid)));
});

test('a batch that carries the committee\'s word on its price: taken when it stands and is the price played; refused otherwise', async () => {
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const { priceSampleId, centsToTapeUnits } = await import('../../arena-protocol/src/price-sample.js');
  const { receiptsNeeded } = await import('../../arena-protocol/src/genesis.js');
  const sks = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0x30 + n)); const seats = sks.map((sk) => schnorr.getPublicKey(sk));
  const need = receiptsNeeded(7);
  const r = fresh(), c = { ...contract(), nodes: seats };
  const rid = r.open(c); const eid = r.enter(entryFor(rid));
  const words = [[65536, 0, 0, 0, 0], [65536, 0, 0, 0, 0]];
  const cents = 8297193;
  const att = (priceCents, n = need) => [1, 0, priceCents, sks.slice(0, n).map((sk, i) => [seats[i], schnorr.sign(priceSampleId({ roundId: rid, tick: 1, priceCents }), sk)])];
  const bad = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: words, liquidations: [], samples: [[1, centsToTapeUnits(cents) + 7]], attests: [att(cents)] };
  assert.throws(() => r.batch(encodeInputBatch(bad)), /not the attested 8297193 cents/);
  const short = { ...bad, samples: [[1, centsToTapeUnits(cents)]], attests: [att(cents, need - 1)] };
  assert.throws(() => r.batch(encodeInputBatch(short)), new RegExp(`not attested: ${need - 1} of the committee signed it`));
  const good = { ...bad, samples: [[1, centsToTapeUnits(cents)]] };
  r.batch(encodeInputBatch(good));
  assert.equal(r.transcript(rid, eid).ticks.length, 2, 'taken');
});

test('a seat running the committee\'s feed for the round refuses a bare price; a batch with no price, or an attested one, is taken', async () => {
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const { priceSampleId, centsToTapeUnits } = await import('../../arena-protocol/src/price-sample.js');
  const { receiptsNeeded } = await import('../../arena-protocol/src/genesis.js');
  const sks = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0x40 + n)); const seats = sks.map((sk) => schnorr.getPublicKey(sk));
  const r = fresh(), c = { ...contract(), nodes: seats };
  const rid = r.open(c); const eid = r.enter(entryFor(rid));
  const w = [65536, 0, 0, 0, 0];
  const cents = 8297193;
  const bare = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: [w], liquidations: [], samples: [[0, centsToTapeUnits(cents)]] };
  r.pricesRequired = () => false;
  assert.doesNotThrow(() => r.batch(encodeInputBatch(bare)), 'a seat without the feed takes a bare price as before');
  const r2 = fresh(); const rid2 = r2.open(c); const eid2 = r2.enter(entryFor(rid2));
  r2.pricesRequired = (contractBytes) => contractBytes instanceof Uint8Array || Buffer.isBuffer(contractBytes);
  const b = { ...bare, roundId: rid2, entryId: eid2 };
  assert.throws(() => r2.batch(encodeInputBatch(b)), /a sample without the committee's attestation: the player never chooses the price/);
  assert.throws(() => r2.batch(encodeInputBatch({ ...b, samples: [], tapes: [[0, ...Array(64).fill(1)]] })), /a tape without the committee's attestation/);
  const sim = { ...b, samples: [] };
  r2.batch(encodeInputBatch(sim));                                                    // no price at all: the seeded tape (SIM)
  const att = [1, 0, cents, sks.slice(0, receiptsNeeded(7)).map((sk, i) => [seats[i], schnorr.sign(priceSampleId({ roundId: rid2, tick: 1, priceCents: cents }), sk)])];
  r2.batch(encodeInputBatch({ ...b, previousHash: r2.head(rid2, eid2), firstTick: 1, samples: [[1, centsToTapeUnits(cents)]], attests: [att] }));
  assert.equal(r2.transcript(rid2, eid2).ticks.length, 2, 'the SIM batch and the attested one are taken');
});
