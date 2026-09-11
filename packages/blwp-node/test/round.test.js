// One process holds a round: open it, take an entry, store batches, close it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, OPEN, CLOSED } from '../src/store.js';
import { Round } from '../src/round.js';
import { roundId, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../protocol/src/fee.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: b32(1), startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'BURN', federationId: new Uint8Array(32), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: new Uint8Array(32).fill(0xd0),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
const fresh = () => new Round(openStore(), () => 1234);

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
test('the node reaches the simulator through replay.js and nowhere else', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const reaches = [];
  for (const f of readdirSync(new URL('../src/', import.meta.url).pathname)) {
    const src = readFileSync(new URL('../src/' + f, import.meta.url).pathname, 'utf8');
    if (/packages\/core|@blwp\/core|core\/src|\bstep\s*\(/.test(src)) reaches.push(f);
  }
  assert.deepEqual(reaches, ['replay.js'],
    'the simulator is reached from somewhere other than the one door, or from none');

  // and that door replays a finished transcript - it does not tick anything
  const src = readFileSync(new URL('../src/replay.js', import.meta.url).pathname, 'utf8');
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(src),
    'the replay door runs a clock, which is a live second simulator');
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
  const path = '/tmp/blwp-node-persist.db';
  rmSync(path, { force: true });
  const c = contract();
  let id;
  // The clock is after the committee forms, because entry opens then (5A.5).
  // This test is about a round surviving a restart, not about the window.
  { const r = new Round(openStore(path), () => 600); id = r.open(c); r.enter(entryFor(id)); }
  { const r = new Round(openStore(path), () => 700);
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
