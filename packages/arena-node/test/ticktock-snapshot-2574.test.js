// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #2574 THE SEAT TAKES A TICK TOCK LOAD ONLY OF THE PARCELS DRAWN FOR IT (spec ruling of kanban #2571; feedback #011, kanban #1488).
//
// On core 383aa469 (the parcels drawn - a new Tick Tock game version) a load names its parcels by [slot, txid]; the seat holds it to
// the snapshot of the round's beacon block, derived from its own bitcoind. Before: a bed was the player's word within the #1488
// bounds - a self-declared bed of the most-paying size was taken. After: refused on the new core; every other core is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID, NEXTBLOCK_CORES_V8, TRUCK_383A_HASH, TRUCK_383A } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { fromHex, toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { snapshotOfBlocks, snapshotIdOf, offeredParcel, offerIndex, roomOfVsize, OFFER_SLOTS } from '../../arena-protocol/src/ticktock-snapshot.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { inputsFormOf, inputsLoadRefusal } from '../src/objection-check.js';
import { chainSnapshots } from '../src/ticktock-snapshots.js';
import { HOSTED } from './plugins/hosted.js';
import { testGame } from './plugins/sign.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const V8 = testGame({ name: 'nextblock', cores: NEXTBLOCK_CORES_V8, runTicksMax: BLOCK_TICKS, dev: 'ticktock v8 test' });
const contract = (drawn) => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7,
  settlementSlots: 7, gameId: drawn ? V8.gameId : NEXTBLOCK_GAME_ID, simCoreHash: drawn ? fromHex(TRUCK_383A_HASH) : TRUCK_CORE_HASH,
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n,
  bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(4)],
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey: b32(6), stakeCommitment: b32(7),
  stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0,
  worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
// a beacon block of 300 transactions of every size class, fees as a mempool pays them
const BLOCK = { height: 500, hash: sha256(new TextEncoder().encode('beacon 500')),
  txs: Array.from({ length: 300 }, (_, i) => ({ txid: sha256(new TextEncoder().encode(`tx ${i}`)), vsize: [140, 380, 900, 2100][i % 4] + i, feeSat: BigInt(200 + 37 * i) })) };
const SNAPSHOT = snapshotOfBlocks([BLOCK]);
const HELD = [0, 0, 0, 0, 0];

function seat({ drawn = true, snapshot = SNAPSHOT } = {}) {
  const r = new Round(openStore(), () => 1234, { plugins: [...HOSTED, V8] });
  r.snapshotOf = () => (snapshot ? { snapshot, id: snapshotIdOf(snapshot) } : { why: 'its beacon is not held yet' });
  const rid = r.open(contract(drawn));
  const eid = r.enter(entryFor(rid));
  let previousHash = GENESIS, next = 0;
  const send = (n, loads = []) => {
    const b = { roundId: rid, entryId: eid, previousHash, firstTick: next, ticks: Array.from({ length: n }, () => HELD), liquidations: [], loads };
    const took = r.batch(encodeInputBatch(b));
    previousHash = batchId(b); next += n;
    return took;
  };
  const bed = (slots) => {
    const ps = slots.map((s) => offeredParcel(SNAPSHOT, rid, eid, s));
    return { fee: ps.reduce((n, p) => n + Number(p.feeSat), 0), room: ps.reduce((n, p) => n + roomOfVsize(p.vsize), 0), parcels: slots.map((s, i) => [s, ps[i].txid]) };
  };
  return { r, rid, eid, send, bed, stored: () => r.transcript(rid, eid).loads };
}

test('#2574 an honest page: the drawn parcels at their fee and room, an empty bed - taken on the drawing core', () => {
  const { send, bed, stored } = seat();
  const a = bed([2, 11, 30]);
  assert.equal(send(10, [[0, 0, 0, 0, []], [5, a.fee, 0, a.room, a.parcels]]), 10);
  // the parcels are kept with the load (kanban #2574): the run's inputs carry them to an objection
  assert.deepEqual(stored(), [[0, 0, 0, 0], [5, a.fee, 0, a.room, a.parcels.map(([sl, t]) => [sl, toHex(t)])]]);
  console.log(`  MEASURED #2574 drawn bed taken: slots 2, 11, 30 -> ${a.fee} sats, room ${a.room}`);
});

test('#2574 before/after: a self-declared bed the #1488 bounds take on the old core is refused on the drawing core', () => {
  // the most a bed's word could buy within #1488: a nearly full bed at the floor's fee (7 parcels, 245 sats), no parcel named
  const declared = [[0, 245, 0, 393214]];
  assert.equal(seat({ drawn: false }).send(10, declared), 10, 'BEFORE (v7 core): taken - the bed is the player\'s word');
  assert.throws(() => seat().send(10, declared), /with no parcel named: a bed names each parcel/, 'AFTER (383aa469): refused');
  // and parcels on the old core are refused: its rounds play exactly as before (no such batch decoded there before)
  const s = seat();
  const a = s.bed([1]);
  assert.throws(() => seat({ drawn: false }).send(10, [[0, a.fee, 0, a.room, a.parcels]]), /does not draw them/);
});

test('#2574 a txid not drawn for its slot, the right one at another slot, an inflated fee, BTC: refused at the door', () => {
  const { send, bed, rid, eid, stored } = seat();
  const a = bed([4, 8]);
  const notDrawn = SNAPSHOT.entries.find((e) => ![...Array(OFFER_SLOTS).keys()].some((s) => toHex(offeredParcel(SNAPSHOT, rid, eid, s).txid) === toHex(e.txid)));
  assert.throws(() => send(10, [[0, a.fee, 0, a.room, [a.parcels[0], [8, notDrawn.txid]]]]), /at slot 8, and slot 8 of this entry offers/);
  assert.throws(() => send(10, [[0, a.fee, 0, a.room, [a.parcels[0], [9, a.parcels[1][1]]]]]), /at slot 9, and slot 9 of this entry offers/);
  assert.throws(() => send(10, [[0, a.fee + 1000, 0, a.room, a.parcels]]), /and the parcels it names pay/);
  assert.throws(() => send(10, [[0, a.fee, 0, a.room + 36044, a.parcels]]), /and the parcels it names fill/);
  assert.throws(() => send(10, [[0, a.fee, 120, a.room, a.parcels]]), /a drawn bed carries none/);
  // the best-paying transaction of the block, wherever it was not drawn for this entry: not this entry's to take
  const richest = [...SNAPSHOT.entries].sort((x, y) => Number(y.feeSat - x.feeSat))[0];
  const drawnSlot = [...Array(OFFER_SLOTS).keys()].find((s) => toHex(offeredParcel(SNAPSHOT, rid, eid, s).txid) === toHex(richest.txid));
  if (drawnSlot === undefined) assert.throws(() => send(10, [[0, Number(richest.feeSat), 0, roomOfVsize(richest.vsize), [[0, richest.txid]]]]), /slot 0 of this entry offers/);
  assert.deepEqual(stored(), []);
  assert.equal(send(10, [[0, a.fee, 0, a.room, a.parcels]]), 10, 'and the honest load at the same tick after');
});

test('#2574 a seat that has not derived the snapshot takes no parcel - and says to send again', () => {
  const { send } = seat({ snapshot: null });
  assert.throws(() => send(10, [[0, 300, 0, 36044, [[0, b32(1)]]]]), /has not derived the snapshot of this round's beacon block yet \(its beacon is not held yet\)/);
  assert.equal(send(10), 10, 'a batch with no load is taken');
});

test('#2574 the core the round names draws the offer exactly as the seat checks it (383aa469 rng.js offerIndex)', () => {
  const core = TRUCK_383A.adapter;
  assert.equal(core.PARCELS_DRAWN, true);
  assert.equal(core.OFFER_SLOTS, OFFER_SLOTS);
  assert.equal(TRUCK_383A.parcelsDrawn, true);
  let n = 0;
  for (let r = 0; r < 12; r++) for (let e = 0; e < 6; e++) for (let s = 0; s < OFFER_SLOTS; s += 3) for (const count of [1, 7, 256, 300, 4096]) {
    const rid = sha256(Uint8Array.of(r)), eid = sha256(Uint8Array.of(100 + e));
    assert.equal(core.offerIndex(rid, eid, s, count), offerIndex(rid, eid, s, count)); n++;
  }
  console.log(`  MEASURED #2574 core offerIndex == protocol offerIndex on ${n} draws`);
});

test('#2574 the seat\'s snapshot from its bitcoind: getblock verbosity 2 walked back from the beacon, the same id', async () => {
  // a node of three blocks: 100 + 100 + 100 transactions, so the walk takes all three; fees as RPC prints them (BTC)
  const blocks = [500, 499, 498].map((h) => ({ height: h, hash: sha256(new TextEncoder().encode(`b ${h}`)),
    txs: Array.from({ length: 100 }, (_, i) => ({ txid: sha256(new TextEncoder().encode(`${h}/${i}`)), vsize: 150 + i * 13, feeSat: BigInt(141 + i * 7) })) }));
  const disp = (h) => Buffer.from(h).reverse().toString('hex');
  const byHash = new Map(blocks.map((b, i) => [disp(b.hash), { height: b.height, hash: disp(b.hash), previousblockhash: blocks[i + 1] ? disp(blocks[i + 1].hash) : disp(b32(0)),
    tx: [{ txid: toHex(b32(i + 9)), vsize: 100 }, ...b.txs.map((t) => ({ txid: toHex(t.txid), vsize: t.vsize, fee: Number(t.feeSat) / 1e8 }))] }]));
  const calls = [];
  const call = async (m, p) => { calls.push(m); if (m === 'getblock') return byHash.get(p[0]); if (m === 'getblockheader') return '00'.repeat(80); throw new Error(m); };
  const src = chainSnapshots({ call, log: () => {} });
  const beacon = { hash: blocks[0].hash, height: 500 };
  assert.equal(src.for(beacon), undefined, 'not held: a read starts');
  const got = await src.refresh(beacon);
  assert.equal(toHex(got.id), toHex(snapshotIdOf(snapshotOfBlocks(blocks))));
  assert.equal(got.snapshot.count, 300);
  assert.equal(src.for(beacon), got);
  assert.equal(calls.filter((c) => c === 'getblock').length, 3, 'three blocks read once');
  const j = src.json(got, b32(1));
  assert.equal(j.snapshotId, toHex(got.id));
  assert.equal(j.blocks.length, 3);
});

// THE OBJECTION PATH (kanban #2574): a live run's inputs carry the stored drawn bed, read back with its parcels, and are held to the
// round's snapshot as at the batch door - not to the declared-bed floors (#1488), which an honest drawn bed of cheap parcels is under
test('#2574 objection: the stored drawn bed reads back with its parcels and passes; a forged one, or parcels on an old core, do not', () => {
  const { r, rid, eid, send, bed } = seat();
  const a = bed([2, 11, 30]);
  assert.equal(send(10, [[5, a.fee, 0, a.room, a.parcels]]), 10);
  const t = r.transcript(rid, eid);
  const form = inputsFormOf({ ticks: Array.from({ length: 10 }, (_, i) => ({ tick: i, words: [...HELD] })), loads: t.loads });   // the 10 held ticks sent above
  const drawn = r.drawnFor(r.db.prepare('SELECT contract FROM rounds WHERE round_id = ?').get(rid).contract, rid, eid);
  assert.equal(inputsLoadRefusal(form, drawn), null, 'the honest drawn bed passes the objection check');
  const forged = inputsFormOf({ ticks: form.ticks, loads: [[5, a.fee, 0, a.room, [[3, toHex(a.parcels[0][1])], [11, toHex(a.parcels[1][1])], [30, toHex(a.parcels[2][1])]]]] });
  assert.match(inputsLoadRefusal(forged, drawn), /slot 3/, 'a txid at a slot that did not draw it is refused');
  assert.match(inputsLoadRefusal(form, null), /names parcels, and this round's core does not draw them/);
  const declared = inputsFormOf({ ticks: form.ticks, loads: [[5, 245, 0, 393214]] });
  assert.match(inputsLoadRefusal(declared, drawn), /no parcel named/, 'a self-declared bed is refused on the drawing core');
});
