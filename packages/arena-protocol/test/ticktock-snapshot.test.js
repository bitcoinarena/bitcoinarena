// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #2574 TICK TOCK'S PARCELS FROM THE ROUND'S BEACON BLOCK, THE OFFER DRAWN (spec ruling of kanban #2571): the snapshot, its id,
// the draw, the load check, the batch's parcels tail and the listing's snapshot id - one derivation for seat, client and replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotOfBlocks, encodeSnapshot, snapshotIdOf, offerIndex, offeredParcel, offersOf, drawnParcelsRefusal, merkleRootOfTxids,
  snapshotJson, snapshotFromJson, snapshotStandsOnHeaders, satsOf, roomOfVsize, SNAPSHOT_MIN_TXS, SNAPSHOT_MAX_ENTRIES, OFFER_SLOTS, PARCEL_ROOMS,
} from '../src/ticktock-snapshot.js';
import { encodeInputBatch, decodeInputBatch, batchId } from '../src/batch.js';
import { encodeLobbyListing, lobbyListingId } from '../src/lobby-listing.js';
import { taggedHash, toHex, fromHex, sha256 } from '../src/hash.js';
import { TAG } from '../src/constants.js';
import { blockHashOf } from '../src/chain.js';

const b32 = (n) => new Uint8Array(32).fill(n);
// a deterministic txid: sha256 of a label
const tx = (label, vsize, fee) => ({ txid: sha256(new TextEncoder().encode(label)), vsize, feeSat: BigInt(fee) });
const block = (height, n, tag = `b${height}`) => ({ height, hash: sha256(new TextEncoder().encode(`hash ${height}`)),
  txs: Array.from({ length: n }, (_, i) => tx(`${tag}/${i}`, 100 + ((i * 37) % 2000), 150 + i * 11)) });
const RID = b32(0x11), EID = b32(0x22);

test('#2574 the snapshot: the beacon\'s non-coinbase transactions, walked back while fewer than 256, sorted by txid, at most 4096', () => {
  const one = snapshotOfBlocks([block(500, 300), block(499, 50)]);
  assert.equal(one.blocksUsed, 1, 'a beacon of 300 transactions is the snapshot alone');
  assert.equal(one.count, 300);
  const three = snapshotOfBlocks([block(500, 100), block(499, 100), block(498, 100), block(497, 100)]);
  assert.equal(three.blocksUsed, 3, '100 + 100 is short of 256: the third block is walked to, the fourth is not');
  assert.equal(three.count, 300);
  for (let i = 1; i < three.entries.length; i++) assert.ok(toHex(three.entries[i - 1].txid) < toHex(three.entries[i].txid), 'sorted by txid');
  const big = snapshotOfBlocks([block(500, 5000)]);
  assert.equal(big.count, SNAPSHOT_MAX_ENTRIES);
  const all = block(500, 5000).txs.map((t) => toHex(t.txid)).sort();
  assert.deepEqual(big.entries.map((e) => toHex(e.txid)), all.slice(0, 4096), 'the first 4096 by txid');
  assert.throws(() => snapshotOfBlocks([block(500, 100), block(499, 100)]), /stops at 499 with 200 transactions/);
  assert.equal(snapshotOfBlocks([block(1, 10), block(0, 0)]).count, 10, 'the chain\'s first block ends a walk short of 256');
  assert.throws(() => snapshotOfBlocks([block(500, 100), block(498, 300)]), /walked back one at a time/);
  // the order the transactions came in does not matter
  const shuffled = { ...block(500, 300) }; shuffled.txs = [...shuffled.txs].reverse();
  assert.equal(toHex(snapshotIdOf(snapshotOfBlocks([shuffled]))), toHex(snapshotIdOf(one)));
});

test('#2574 snapshot_id = tagged_hash("ARENA/v1/TickTockSnapshot", beacon hash || count || entries): every byte in it', () => {
  const s = snapshotOfBlocks([block(500, 300)]);
  const bytes = encodeSnapshot(s);
  assert.equal(bytes.length, 32 + 4 + 300 * (32 + 4 + 8));
  assert.equal(toHex(bytes.slice(0, 32)), toHex(s.beaconHash));
  assert.deepEqual([...bytes.slice(32, 36)], [0, 0, 1, 44], 'count, big-endian');
  assert.equal(toHex(snapshotIdOf(s)), toHex(taggedHash('ARENA/v1/TickTockSnapshot', bytes)));
  assert.equal(TAG.ticktockSnapshot, 'ARENA/v1/TickTockSnapshot');
  const id = toHex(snapshotIdOf(s));
  const e0 = s.entries[0];
  for (const changed of [{ ...s, beaconHash: b32(9) }, { ...s, entries: s.entries.slice(1) },
    { ...s, entries: [{ ...e0, vsize: e0.vsize + 1 }, ...s.entries.slice(1)] }, { ...s, entries: [{ ...e0, feeSat: e0.feeSat + 1n }, ...s.entries.slice(1)] }])
    assert.notEqual(toHex(snapshotIdOf(changed)), id);
  assert.throws(() => encodeSnapshot({ ...s, entries: [s.entries[1], s.entries[0]] }), /sorted by txid/);
  console.log(`  MEASURED #2574 snapshot of 300 transactions: ${bytes.length} bytes, id ${id.slice(0, 16)}`);
});

test('#2574 the draw: entries[H(round_id || entry_id || slot) mod count] - fixed by the round, the entry and the slot, spread over the snapshot', () => {
  const s = snapshotOfBlocks([block(500, 300)]);
  const at = offerIndex(RID, EID, 7, s.count);
  const m = new Uint8Array(68); m.set(RID); m.set(EID, 32); m[67] = 7;
  assert.equal(at, Number(BigInt('0x' + toHex(taggedHash(TAG.ticktockOffer, m))) % 300n), 'the hash read big-endian, mod count');
  assert.equal(offerIndex(RID, EID, 7, s.count), at);
  assert.equal(toHex(offeredParcel(s, RID, EID, 7).txid), toHex(s.entries[at].txid));
  assert.notDeepEqual(offersOf(s, RID, EID).map((o) => o.slot === 0 ? null : toHex(o.txid)), offersOf(s, RID, b32(0x23)).map((o) => o.slot === 0 ? null : toHex(o.txid)), 'another entry is offered other parcels');
  assert.notDeepEqual(offersOf(s, RID, EID).map((o) => toHex(o.txid)), offersOf(s, b32(0x12), EID).map((o) => toHex(o.txid)), 'another round too');
  assert.equal(offersOf(s, RID, EID).length, OFFER_SLOTS);
  assert.throws(() => offerIndex(RID, EID, OFFER_SLOTS, 300), /0 \.\. 39/);
  // spread: 64 entries x 40 slots over a snapshot of 16 - every entry at least once
  const hits = new Array(16).fill(0);
  for (let e = 0; e < 64; e++) for (let i = 0; i < OFFER_SLOTS; i++) hits[offerIndex(RID, b32(e), i, 16)]++;
  assert.ok(Math.min(...hits) > 100 && Math.max(...hits) < 220, `spread ${hits}`);
});

test('#2574 a load names the parcels drawn for its slots, at their fee and room: everything else is refused', () => {
  const s = snapshotOfBlocks([block(500, 300)]);
  const at = (slot) => offeredParcel(s, RID, EID, slot);
  const pick = [3, 9, 17];
  const fee = pick.reduce((n, i) => n + Number(at(i).feeSat), 0), room = pick.reduce((n, i) => n + roomOfVsize(at(i).vsize), 0);
  const parcels = pick.map((i) => [i, toHex(at(i).txid)]);
  const ok = (l) => drawnParcelsRefusal(l, { snapshot: s, roundId: RID, entryId: EID });
  assert.equal(ok([10, fee, 0, room, parcels]), null, 'the drawn parcels at their fee and room');
  assert.equal(ok([10, fee, 0, room, pick.map((i) => [i, at(i).txid])]), null, 'txids as bytes');
  assert.equal(ok([10, 0, 0, 0, []]), null, 'an empty bed');
  assert.equal(ok([10, 0, 0, 0]), null, 'an empty bed with no parcel list');
  const other = s.entries.find((e) => !pick.some((i) => toHex(at(i).txid) === toHex(e.txid)));
  assert.match(ok([10, fee, 0, room, [...parcels.slice(0, 2), [17, toHex(other.txid)]]]), /names [0-9a-f]{64} at slot 17, and slot 17 of this entry offers/);
  assert.match(ok([10, fee, 0, room, [[3, parcels[0][1]], [9, parcels[1][1]], [18, parcels[2][1]]]]), /at slot 18, and slot 18 of this entry offers/, 'the right txid at another slot');
  assert.match(ok([10, fee + 1, 0, room, parcels]), new RegExp(`pays ${fee + 1} sats, and the parcels it names pay ${fee}`));
  assert.match(ok([10, fee, 0, room + PARCEL_ROOMS[0], parcels]), /and the parcels it names fill/);
  assert.match(ok([10, fee, 5, room, parcels]), /carries 5 hundredths of a BTC: a drawn bed carries none/);
  assert.match(ok([10, fee, 0, room, []]), /with no parcel named/, 'a bed declared with no parcel');
  assert.match(ok([10, fee, 0, room, [...parcels, [3, parcels[0][1]]]]), /names slot 3 twice/);
  assert.match(ok([10, fee, 0, room, [[40, parcels[0][1]]]]), /pickup slot 40/);
  assert.match(drawnParcelsRefusal([10, fee, 0, room, parcels], { snapshot: s, roundId: RID, entryId: b32(0x23) }) || '', /offers/, 'another entry\'s draw is not this one\'s');
  // one transaction drawn at two slots is one parcel
  let a = 0, b = -1;
  for (; a < OFFER_SLOTS && b < 0; a++) for (let j = a + 1; j < OFFER_SLOTS; j++) if (toHex(at(a).txid) === toHex(at(j).txid)) { b = j; break; }
  if (b > 0) { a--; assert.match(ok([10, 2 * Number(at(a).feeSat), 0, 2 * roomOfVsize(at(a).vsize), [[a, toHex(at(a).txid)], [b, toHex(at(b).txid)]]]), /twice: a transaction is one parcel/); }
  assert.match(drawnParcelsRefusal([10, fee, 0, room, parcels], { snapshot: { entries: [] }, roundId: RID, entryId: EID }), /holds no transaction/);
});

test('#2574 the batch carries a load\'s parcels as a fifth optional tail; a batch without them keeps its bytes and id', () => {
  const s = snapshotOfBlocks([block(500, 300)]);
  const base = { roundId: RID, entryId: EID, previousHash: b32(0), firstTick: 0, ticks: [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]], liquidations: [] };
  const plain = { ...base, loads: [[1, 240, 0, 275248]] };
  const before = encodeInputBatch(plain);
  const p = [[9, offeredParcel(s, RID, EID, 9).txid], [3, offeredParcel(s, RID, EID, 3).txid]];
  const withParcels = { ...base, loads: [[1, 240, 0, 275248, p]] };
  const bytes = encodeInputBatch(withParcels);
  assert.equal(bytes.length, before.length + 2 + 2 + 2 * (4 + 2 + 32), 'the empty attestation tail, then two parcels');
  const back = decodeInputBatch(bytes);
  assert.deepEqual(back.loads, [[1, 240, 0, 275248, [[3, p[1][1]], [9, p[0][1]]]]], 'in slot order');
  assert.equal(toHex(batchId(back)), toHex(batchId(withParcels)));
  assert.notEqual(toHex(batchId(withParcels)), toHex(batchId(plain)), 'the parcels are in the batch id');
  assert.deepEqual([...encodeInputBatch(decodeInputBatch(before))], [...before], 'a batch without parcels: the same bytes');
  assert.throws(() => encodeInputBatch({ ...base, loads: [[1, 240, 0, undefined, p]] }), /carries its room/);
  assert.throws(() => encodeInputBatch({ ...base, loads: [[1, 240, 0, 275248, [[3, p[0][1]], [3, p[1][1]]]]] }), /each pickup slot once/);
  // a frame with its parcels out of order is not this encoder's
  const swapped = bytes.slice(); const tail = swapped.length - 2 * 38;
  swapped.set(bytes.slice(tail + 38, tail + 76), tail); swapped.set(bytes.slice(tail, tail + 38), tail + 38);
  assert.throws(() => decodeInputBatch(swapped), /tick and slot order/);
});

test('#2574 the listing signs the snapshot id only when given: every other listing keeps its bytes', () => {
  const l = { roundId: b32(1), nodePubkey: b32(2), nowMs: 1789200000000, phase: 'open', assignedHere: true, joined: 2, playing: 1 };
  assert.equal(encodeLobbyListing(l).length, 82);
  assert.equal(toHex(lobbyListingId({ ...l, snapshotId: null })), toHex(lobbyListingId(l)));
  const sid = snapshotIdOf(snapshotOfBlocks([block(500, 300)]));
  assert.equal(encodeLobbyListing({ ...l, snapshotId: sid }).length, 82 + 32);
  assert.notEqual(toHex(lobbyListingId({ ...l, snapshotId: sid })), toHex(lobbyListingId(l)));
  assert.notEqual(toHex(lobbyListingId({ ...l, snapshotId: sid })), toHex(lobbyListingId({ ...l, snapshotId: b32(3) })));
});

test('#2574 the merkle root over txids is Bitcoin\'s (mainnet block 100000), and a snapshot stands on its headers', () => {
  const txids = ['8c14f0db3df150123e6f3dbbf30f8b955a8249b62ac1d1ff16284aefa3d06d87', 'fff2525b8931402dd09222c50775608f75787bd2b87e56995a7bdd30f79702c4',
    '6359f0868171b1d194cbee1af2f16ea598ae8fad666d9b012c8ed2b79a236ec4', 'e9a66845e05d5abc0ad04ec80f774a7e585c6e8db975962d069a522137b80c1d'];
  assert.equal(toHex(merkleRootOfTxids(txids).slice().reverse()), 'f3e94742aca4b5ef85488dc37c06c3282295ffec960994b2c0d5ac2a25a95766');
  // three linked headers whose merkle roots commit to 100 transactions each (and a coinbase)
  const mk = (h, prev, ids) => { const hd = new Uint8Array(80); hd[0] = 1; hd.set(prev, 4); hd.set(merkleRootOfTxids(ids), 36); hd[68] = h; return hd; };
  const ids = (h) => [toHex(sha256(new TextEncoder().encode(`coinbase ${h}`))), ...block(h, 100).txs.map((t) => toHex(t.txid))];
  const h498 = mk(198, b32(0), ids(498)), h499 = mk(199, blockHashOf(h498), ids(499)), h500 = mk(200, blockHashOf(h499), ids(500));
  const blocks = [500, 499, 498].map((h, i) => ({ height: h, hash: blockHashOf([h500, h499, h498][i]), txs: block(h, 100).txs }));
  const s = snapshotOfBlocks(blocks);
  const wire = [[500, h500], [499, h499], [498, h498]].map(([height, header]) => ({ height, header, txids: ids(height) }));
  assert.deepEqual(snapshotStandsOnHeaders(s, wire, { blockHashOf }), { ok: true });
  const j = snapshotJson(s, { roundId: RID, blocks: wire });
  const back = snapshotFromJson(JSON.parse(JSON.stringify(j)));
  assert.equal(toHex(snapshotIdOf(back)), j.snapshotId, 'the JSON gives the same snapshot back');
  assert.equal(snapshotStandsOnHeaders(back, JSON.parse(JSON.stringify(j)).blocks, { blockHashOf }).ok, true);
  const bad = wire.map((b) => ({ ...b })); bad[1] = { ...bad[1], txids: [...bad[1].txids.slice(0, -1), toHex(b32(7))] };
  assert.match(snapshotStandsOnHeaders(s, bad, { blockHashOf }).why, /do not hash to its merkle root/);
  assert.match(snapshotStandsOnHeaders(s, [wire[0], wire[2]], { blockHashOf }).why, /not the parent/);
  assert.match(snapshotStandsOnHeaders({ ...s, entries: s.entries.slice(1) }, wire, { blockHashOf }).why, /first ones by txid/);
  assert.equal(SNAPSHOT_MIN_TXS, 256);
});

test('#2574 a BTC amount from the RPC is whole sats, exactly', () => {
  assert.equal(satsOf(0.00000141), 141n);
  assert.equal(satsOf(0.1), 10000000n);
  assert.equal(satsOf(20999999.9769), 2099999997690000n);
  assert.equal(satsOf('0.00012345'), 12345n);
  assert.throws(() => satsOf(-1), /not a BTC amount/);
  assert.equal(toHex(fromHex('00')), '00');
});
