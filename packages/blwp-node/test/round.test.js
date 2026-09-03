// One process holds a round: open it, take an entry, store batches, close it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, OPEN, CLOSED } from '../src/store.js';
import { Round } from '../src/round.js';
import { roundId, entryId } from '../../protocol/src/contracts.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { toHex } from '../../protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  simCoreHash: b32(1), startTimeMs: 1000n, entryCloseMs: 2000n,
  censusHeight: 900000, censusRoot: b32(2), committeeSeed: b32(3),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6),
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: 1000n, donationMsat: 0n, joinTick: 0,
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
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 10,
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

test('batches out of order land in tick order, and a gap is visible', () => {
  const r = fresh(), c = contract();
  const rid = r.open(c); const e = entryFor(rid); const eid = r.enter(e);
  // The chain fixes the ORDER of batches; the ticks inside them may still
  // skip, which is what a gap is.
  const send = (first, n) => {
    const b = { roundId: rid, entryId: eid, previousHash: r.head(rid, eid), firstTick: first,
      ticks: Array.from({ length: n }, (_, i) => [65536, first + i, 0, 0, 0]), liquidations: [] };
    return r.batch(encodeInputBatch(b));
  };
  send(10, 2);            // 10, 11
  send(20, 2);            // 20, 21 - a gap the numbers themselves name
  assert.deepEqual(r.transcript(rid, eid).ticks.map((x) => x.tick), [10, 11, 20, 21]);
  assert.deepEqual(r.gaps(rid, eid), [12, 13, 14, 15, 16, 17, 18, 19],
    'the hole is the numbers themselves, not a shorter list');
  send(12, 8);
  assert.deepEqual(r.gaps(rid, eid), [], 'and it closes when they arrive');
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

test('the node does not step: nothing here imports the core', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  for (const f of readdirSync(new URL('../src/', import.meta.url).pathname)) {
    const src = readFileSync(new URL('../src/' + f, import.meta.url).pathname, 'utf8');
    assert.ok(!/packages\/core|@blwp\/core|\bstep\s*\(/.test(src),
      `${f} reaches for the simulator; the node stores and serves, it does not judge`);
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
  const path = '/tmp/blwp-node-persist.db';
  rmSync(path, { force: true });
  const c = contract();
  let id;
  { const r = new Round(openStore(path), () => 1); id = r.open(c); r.enter(entryFor(id)); }
  { const r = new Round(openStore(path), () => 2);
    assert.ok(r.get(id), 'the round is still there after a fresh handle');
    assert.equal(r.db.prepare('SELECT COUNT(*) n FROM entries').get().n, 1); }
  rmSync(path, { force: true });
});
