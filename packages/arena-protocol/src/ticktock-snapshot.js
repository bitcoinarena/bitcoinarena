// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TICK TOCK'S PARCELS COME FROM THE ROUND'S BEACON BLOCK, AND THE OFFER IS DRAWN, NOT PICKED (spec ruling of kanban #2571, built
// in #2574; feedback #011 / kanban #1488: the load was the player's own word).
//
// THE SNAPSHOT. The non-coinbase transactions of the round's beacon block - the block its committee is drawn from
// (beacon.js beaconFromChain) - and, while fewer than SNAPSHOT_MIN_TXS are held, of the block before it, and so on back.
// Each is one entry, txid (32) || vsize (u32) || fee_sat (u64) || value_sat (u64, the sum of its outputs - ruled #2578), sorted by txid; at most SNAPSHOT_MAX_ENTRIES of them (the
// first by txid). Its id is
//
//     snapshot_id = tagged_hash("ARENA/v1/TickTockSnapshot", beacon block hash || count || entries)
//
// Every seat derives it from its own bitcoind (getblock verbosity 2 gives vsize and fee); nothing is trusted and nothing is
// proposed. It is not a Round Contract field: the round names a Tick Tock core that draws its parcels (a game version), and
// the snapshot follows from the round's beacon.
//
// THE DRAW. The parcel offered at an entry's pickup slot i is
//
//     entries[ H(round_id || entry_id || i) mod count ]       H = tagged_hash("ARENA/v1/TickTockOffer", ...), i a u32
//
// A load names its parcels by [slot, txid]; a seat takes it only if each txid is the one drawn for that entry and slot, with
// the size and fee the snapshot holds - the load's fee is their fees' sum and its room their rooms' sum. The player still
// chooses which offered parcels to take and how to load them.
//
// BYTE ORDER. Integers big-endian (encode.js Writer, like every Arena encoding). A txid is its 32 bytes as Bitcoin Core's RPC
// and every explorer print it (the display order; the merkle tree hashes them reversed), the beacon block hash as the round's
// beacon holds it (chain.js blockHashOf, hashing order).
//
// ONE FUNCTION FOR EVERY READER: the seat (arena-node: its snapshot from bitcoind, the load door, GET /snapshot, its signed
// listing), the client (arena-client ticktock-hold.js: the snapshot five of seven seats sign) and a replay (offers from the
// block alone) all derive through this file. The core that draws (nextblock frozen/<hash>/rules/offers.js) carries the same
// rule in the core's own integer arithmetic for the page; a test holds the two equal.
import { Writer } from './encode.js';
import { taggedHash, toHex, fromHex } from './hash.js';
import { TAG } from './constants.js';
import { hash256 } from './chain.js';
// a bed carries 0 .. 20 BTC in hundredths (arena-node load-checks.js BTC_MOST_HUND; the core's cargo clamps the same way)
export const BTC_MOST_HUND = 2000;

/** Fewer than this many transactions in the beacon block: the blocks before it are walked back until this many are held. */
export const SNAPSHOT_MIN_TXS = 256;
/** The most entries a snapshot holds: the first this many by txid. */
export const SNAPSHOT_MAX_ENTRIES = 4096;
/** The pickup slots an entry is offered (MempoolFeed.keep: the ramp shows 21 and holds the rest as its queue). */
export const OFFER_SLOTS = 40;
/** The room one parcel takes by its size class - the core's rules/cargo.js roomFor (Q16.16 of 0.55, 0.78, 1.05, 1.35 m). */
export const PARCEL_ROOMS = Object.freeze([36044, 51118, 68812, 88474]);
/** The core's roomFor: the room a transaction of this vsize takes on the bed. */
export const roomOfVsize = (vsize) => (vsize < 250 ? PARCEL_ROOMS[0] : vsize < 600 ? PARCEL_ROOMS[1] : vsize < 1500 ? PARCEL_ROOMS[2] : PARCEL_ROOMS[3]);

const is32 = (b) => b instanceof Uint8Array && b.length === 32;
const cmp = (a, b) => { for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const same = (a, b) => is32(a) && is32(b) && cmp(a, b) === 0;

/** A txid as 32 bytes (display order) from its hex, or the bytes themselves. */
export function txidBytes(t) {
  if (is32(t)) return t;
  if (typeof t === 'string' && /^[0-9a-f]{64}$/i.test(t)) return fromHex(t.toLowerCase());
  throw new Error('a txid is 32 bytes or 64 hex digits');
}

/**
 * THE SNAPSHOT OF A BEACON BLOCK, from the blocks walked back from it: `blocks` the beacon first, then its parent, ...,
 * each `{ height, hash (32 bytes, the beacon's hashing order), txs: [{ txid, vsize, feeSat, valueSat }] }` with only the non-coinbase
 * transactions. Takes blocks until SNAPSHOT_MIN_TXS transactions are held (or the chain's first block is reached) and refuses
 * a walk that stops short of that. Returns { beaconHash, beaconHeight, entries, count, blocksUsed }.
 */
export function snapshotOfBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw new Error('a snapshot is taken from its beacon block at least');
  const held = [];
  let used = 0;
  for (const b of blocks) {
    if (!b || !is32(b.hash) || !Number.isInteger(b.height) || b.height < 0) throw new Error('a block of a snapshot names its 32-byte hash and its height');
    if (used && b.height !== blocks[used - 1].height - 1) throw new Error(`the blocks of a snapshot are walked back one at a time: ${b.height} after ${blocks[used - 1].height}`);
    used++;
    for (const t of b.txs || []) {
      const vsize = t.vsize, fee = typeof t.feeSat === 'bigint' ? t.feeSat : BigInt(t.feeSat);
      if (!Number.isInteger(vsize) || vsize < 1 || vsize > 0xffffffff) throw new Error(`a transaction of block ${b.height} has no vsize`);
      if (fee < 0n || fee > 0xffffffffffffffffn) throw new Error(`a transaction of block ${b.height} has no fee`);
      const value = typeof t.valueSat === 'bigint' ? t.valueSat : BigInt(t.valueSat ?? -1);
      if (value < 0n || value > 0xffffffffffffffffn) throw new Error(`a transaction of block ${b.height} has no output value`);
      held.push({ txid: txidBytes(t.txid), vsize, feeSat: fee, valueSat: value });
    }
    if (held.length >= SNAPSHOT_MIN_TXS) break;
  }
  const last = blocks[used - 1];
  if (held.length < SNAPSHOT_MIN_TXS && last.height !== 0)
    throw new Error(`the walk back from block ${blocks[0].height} stops at ${last.height} with ${held.length} transactions: a snapshot takes blocks until ${SNAPSHOT_MIN_TXS} are held`);
  held.sort((a, b) => cmp(a.txid, b.txid));
  for (let i = 1; i < held.length; i++) if (cmp(held[i - 1].txid, held[i].txid) === 0) throw new Error(`transaction ${toHex(held[i].txid)} is in the walk twice`);
  const entries = held.slice(0, SNAPSHOT_MAX_ENTRIES);
  return Object.freeze({ beaconHash: blocks[0].hash, beaconHeight: blocks[0].height, entries: Object.freeze(entries), count: entries.length, blocksUsed: used });
}

/** beacon block hash || count (u32) || entries (txid 32 || vsize u32 || fee_sat u64 || value_sat u64, 52 bytes - ruled #2578), the bytes snapshot_id hashes. */
export function encodeSnapshot({ beaconHash, entries }) {
  if (!is32(beaconHash)) throw new Error('a snapshot names its 32-byte beacon block hash');
  if (!Array.isArray(entries) || entries.length > SNAPSHOT_MAX_ENTRIES) throw new Error(`a snapshot holds at most ${SNAPSHOT_MAX_ENTRIES} entries`);
  const w = new Writer();
  w.bytes32(beaconHash);
  w.u32(entries.length);
  let prev = null;
  for (const e of entries) {
    const txid = txidBytes(e.txid);
    if (prev && cmp(prev, txid) >= 0) throw new Error('a snapshot\'s entries are sorted by txid, each once');
    prev = txid;
    w.bytes32(txid); w.u32(e.vsize); w.u64(typeof e.feeSat === 'bigint' ? e.feeSat : BigInt(e.feeSat)); w.u64(typeof e.valueSat === 'bigint' ? e.valueSat : BigInt(e.valueSat));
  }
  return w.finish();
}

/** snapshot_id = tagged_hash("ARENA/v1/TickTockSnapshot", beacon block hash || count || entries). */
export const snapshotIdOf = (snapshot) => taggedHash(TAG.ticktockSnapshot, encodeSnapshot(snapshot));

/** The index of the entry drawn for an entry's pickup slot: H(round_id || entry_id || slot) mod count, the hash read big-endian. */
export function offerIndex(roundId, entryId, slot, count) {
  if (!is32(roundId) || !is32(entryId)) throw new Error('an offer is drawn for a 32-byte round id and entry id');
  if (!Number.isInteger(slot) || slot < 0 || slot >= OFFER_SLOTS) throw new Error(`a pickup slot is 0 .. ${OFFER_SLOTS - 1}`);
  if (!Number.isInteger(count) || count < 1) throw new Error('nothing is drawn from an empty snapshot');
  const m = new Uint8Array(68);
  m.set(roundId, 0); m.set(entryId, 32);
  m[64] = (slot >>> 24) & 255; m[65] = (slot >>> 16) & 255; m[66] = (slot >>> 8) & 255; m[67] = slot & 255;
  const h = taggedHash(TAG.ticktockOffer, m);
  let r = 0;
  for (let i = 0; i < 32; i++) r = (r * 256 + h[i]) % count;
  return r;
}

/** The parcel offered at this entry's slot, or null from an empty snapshot. */
export const offeredParcel = (snapshot, roundId, entryId, slot) =>
  (snapshot.entries.length ? snapshot.entries[offerIndex(roundId, entryId, slot, snapshot.entries.length)] : null);

/** Every slot's parcel for this entry, in slot order (a slot may draw the same transaction as another: it is offered once). */
export const offersOf = (snapshot, roundId, entryId, slots = OFFER_SLOTS) =>
  Array.from({ length: snapshot.entries.length ? slots : 0 }, (_, slot) => ({ slot, ...offeredParcel(snapshot, roundId, entryId, slot) }));

/**
 * WHY THIS LOAD DOES NOT NAME THE PARCELS DRAWN FOR IT, or null. `load` is [tick, fee, btc, room, parcels] with parcels
 * [[slot, txid], ...]; `snapshot` the round's (snapshotOfBlocks), `roundId` and `entryId` the entry's. An empty bed names no
 * parcel; every other bed names each of its parcels, each a slot of this entry and the txid drawn there, no slot or
 * transaction twice; its fee is their fees' sum, its room their rooms' sum, and it carries no BTC: the snapshot holds no
 * output value, so a BTC figure would be the player's word again.
 */
export function drawnParcelsRefusal(load, { snapshot, roundId, entryId }) {
  const [tick, fee, btc, room, parcels = []] = load;
  if (!Array.isArray(parcels)) return `the load at tick ${tick} names its parcels as a list`;
  if (!Number.isInteger(btc) || btc < 0) return `the load at tick ${tick} carries ${btc} hundredths of a BTC`;
  if (!parcels.length) {
    if (fee === 0 && room === 0 && btc === 0) return null;
    return `the load at tick ${tick} fills ${room} room units and pays ${fee} sats with no parcel named: a bed names each parcel it carries by the txid drawn for its slot`;
  }
  if (parcels.length > OFFER_SLOTS) return `the load at tick ${tick} names ${parcels.length} parcels: an entry is offered ${OFFER_SLOTS}`;
  if (!snapshot || !Array.isArray(snapshot.entries) || !snapshot.entries.length)
    return `the load at tick ${tick} names parcels, and this round's snapshot holds no transaction to draw from`;
  // A PARCEL IS ITS SLOT (ruled #2578): two slots of one entry may draw the same transaction, and each is its own parcel
  const slots = new Set();
  let feeSum = 0n, roomSum = 0, valueSum = 0n;
  for (const p of parcels) {
    const [slot, t] = Array.isArray(p) ? p : [];
    if (!Number.isInteger(slot) || slot < 0 || slot >= OFFER_SLOTS) return `the load at tick ${tick} names pickup slot ${slot}: an entry's slots are 0 .. ${OFFER_SLOTS - 1}`;
    let txid;
    try { txid = txidBytes(t); } catch { return `the load at tick ${tick} names no 32-byte txid at slot ${slot}`; }
    if (slots.has(slot)) return `the load at tick ${tick} names slot ${slot} twice`;
    slots.add(slot);
    const hex = toHex(txid);
    const drawn = offeredParcel(snapshot, roundId, entryId, slot);
    if (!same(drawn.txid, txid))
      return `the load at tick ${tick} names ${hex} at slot ${slot}, and slot ${slot} of this entry offers ${toHex(drawn.txid)}: a parcel is the one drawn for its slot`;
    feeSum += drawn.feeSat;
    roomSum += roomOfVsize(drawn.vsize);
    valueSum += drawn.valueSat;
  }
  if (BigInt(fee) !== feeSum) return `the load at tick ${tick} pays ${fee} sats, and the parcels it names pay ${feeSum}`;
  if (room !== roomSum) return `the load at tick ${tick} fills ${room} room units, and the parcels it names fill ${roomSum}`;
  // THE BTC THE BED CARRIES (ruled #2578, the whale term kept): the parcels' outputs in hundredths of a BTC (1,000,000 sats each),
  // rounded down and held to the bed's most (BTC_MOST_HUND, 20 BTC) - the same number every seat and the replay read from the block
  const btcWant = Math.min(Number(valueSum / 1000000n), BTC_MOST_HUND);
  if (btc !== btcWant) return `the load at tick ${tick} carries ${btc} hundredths of a BTC, and the parcels it names carry ${btcWant}`;
  return null;
}

/** Bitcoin's merkle root over txids in display order (each hashed reversed; an odd level pairs its last with itself), hashing order. */
export function merkleRootOfTxids(txids) {
  if (!txids.length) throw new Error('a block holds its coinbase at least');
  let level = txids.map((t) => txidBytes(t).slice().reverse());
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const pair = new Uint8Array(64);
      pair.set(level[i], 0); pair.set(level[i + 1] || level[i], 32);
      next.push(hash256(pair));
    }
    level = next;
  }
  return level[0];
}

/** What GET /snapshot answers: the snapshot, its id, and each walked block's header and txids (so a client checks it against headers). */
export function snapshotJson(snapshot, { roundId = null, blocks = [] } = {}) {
  return {
    ...(roundId ? { round: toHex(roundId) } : {}),
    snapshotId: toHex(snapshotIdOf(snapshot)),
    beacon: { hash: toHex(snapshot.beaconHash), height: snapshot.beaconHeight },
    count: snapshot.entries.length,
    entries: snapshot.entries.map((e) => [toHex(e.txid), e.vsize, String(e.feeSat), String(e.valueSat)]),
    blocks: blocks.map((b) => ({ height: b.height, header: toHex(b.header), txids: b.txids.map((t) => toHex(txidBytes(t))) })),
  };
}

/** A snapshot read back from GET /snapshot's JSON (its id recomputed by the reader, never taken from the answer). */
export function snapshotFromJson(j) {
  if (!j || typeof j !== 'object' || !j.beacon || !Array.isArray(j.entries)) throw new Error('that is not a snapshot');
  const entries = j.entries.map((e) => {
    if (!Array.isArray(e) || e.length !== 4) throw new Error('a snapshot entry is [txid, vsize, fee, value]');
    if (!/^\d{1,20}$/.test(String(e[2])) || !/^\d{1,20}$/.test(String(e[3]))) throw new Error('a snapshot entry\'s fee and value are whole sats');
    return { txid: txidBytes(String(e[0])), vsize: Number(e[1]), feeSat: BigInt(String(e[2])), valueSat: BigInt(String(e[3])) };
  });
  const s = { beaconHash: txidBytes(String(j.beacon.hash)), beaconHeight: Number(j.beacon.height), entries, count: entries.length };
  encodeSnapshot(s);                  // sorted, distinct, in range - or it throws
  return Object.freeze(s);
}

/**
 * WHAT A CLIENT CAN CHECK OF A SNAPSHOT AGAINST HEADERS ALONE: the first block is the beacon, each next one its parent, every
 * block's txids hash to its header's merkle root, the walk took blocks only while fewer than SNAPSHOT_MIN_TXS were held, and
 * the entries are exactly the first SNAPSHOT_MAX_ENTRIES of the walked blocks' non-coinbase txids. The sizes and fees are not
 * in a header: those are what five of seven seats sign (the snapshot_id in their listing). { ok } or { ok: false, why }.
 */
export function snapshotStandsOnHeaders(snapshot, blocks, { blockHashOf }) {
  if (!Array.isArray(blocks) || !blocks.length) return { ok: false, why: 'no block came with the snapshot' };
  const txids = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const header = b.header instanceof Uint8Array ? b.header : fromHex(String(b.header));
    if (header.length !== 80) return { ok: false, why: `block ${b.height} carries no 80-byte header` };
    if (i === 0 && !same(blockHashOf(header), snapshot.beaconHash)) return { ok: false, why: 'the first block is not the snapshot\'s beacon' };
    if (i > 0) {
      const child = blocks[i - 1].header instanceof Uint8Array ? blocks[i - 1].header : fromHex(String(blocks[i - 1].header));
      if (!same(child.slice(4, 36), blockHashOf(header))) return { ok: false, why: `block ${b.height} is not the parent of the block before it` };
    }
    if (!Array.isArray(b.txids) || !b.txids.length) return { ok: false, why: `block ${b.height} carries no txids` };
    if (!same(merkleRootOfTxids(b.txids), header.slice(36, 68))) return { ok: false, why: `the txids of block ${b.height} do not hash to its merkle root` };
    if (i > 0 && txids.length >= SNAPSHOT_MIN_TXS) return { ok: false, why: `block ${b.height} was walked to with ${txids.length} transactions already held` };
    for (const t of b.txids.slice(1)) txids.push(txidBytes(t));
  }
  if (txids.length < SNAPSHOT_MIN_TXS && Number(blocks[blocks.length - 1].height) !== 0) return { ok: false, why: `the walk stops short with ${txids.length} transactions` };
  txids.sort(cmp);
  const want = txids.slice(0, SNAPSHOT_MAX_ENTRIES);
  if (want.length !== snapshot.entries.length || want.some((t, i) => !same(t, snapshot.entries[i].txid)))
    return { ok: false, why: 'the snapshot\'s txids are not the walked blocks\' first ones by txid' };
  return { ok: true };
}

/** The snapshot of the getblock (verbosity 2) answers of the blocks walked back from a beacon: the beacon's answer first. */
export function snapshotOfGetblocks(answers, beaconHash) {
  const blocks = answers.map((g) => ({
    height: g.height,
    hash: g === answers[0] ? beaconHash : fromHex(g.hash).reverse(),
    txs: g.tx.slice(1).map((t) => {
      if (typeof t.fee !== 'number' && typeof t.fee !== 'string') throw new Error(`block ${g.height} answers no fee for ${t.txid}: the node needs its undo data (not pruned below it)`);
      // value_sat (ruled #2578): the sum of the transaction's outputs, as getblock verbosity 2 prints each vout's value
      return { txid: t.txid, vsize: t.vsize, feeSat: satsOf(t.fee), valueSat: (t.vout || []).reduce((n, o) => n + satsOf(o.value), 0n) };
    }),
  }));
  if (!same(fromHex(answers[0].hash).reverse(), beaconHash)) throw new Error('the first block answered is not the beacon');
  return snapshotOfBlocks(blocks);
}

/** A BTC amount as RPC prints it (a JSON number with at most 8 decimals) in whole sats, exactly. */
export function satsOf(btc) {
  const s = typeof btc === 'number' ? btc.toFixed(8) : String(btc);
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) throw new Error(`${s} is not a BTC amount`);
  return BigInt(m[1]) * 100000000n + BigInt((m[2] || '').padEnd(8, '0'));
}
