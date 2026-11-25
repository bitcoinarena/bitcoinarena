// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LOAD THE SEAT TAKES IS ONE AN HONEST BED COULD HAVE DECLARED (kanban #1488, feedback #011 by Hexbox Tools).
//
// A Next Block load is [tick, fee_sats, btc_hund, room]: the core sets the heat from fee and BTC and the cargo factor C
// from the room (C multiplies the score). The seat stored whatever was sent, so a player could declare a full bed with no
// fee and no BTC (C = 1, heat 0), or drive empty and declare an over-full bed one tick before the gate. The full fix is a
// load that names attested transactions (a later game version); this is the seat-side half: refuse every load no honest
// page sends. What an honest page sends (the app's own code, arena-app-next-block b9c9aa35):
//   - LoadoutPanel declares the bed while the bay is open (each change, at most one a tick - arena.jslib drops a second)
//     and once more at ROLL OUT (Confirm), and only then sets controlsLocked = false; CoreDrivenTruck writes throttle,
//     steer, brake and handbrake as 0 while the controls are locked. So every load comes before the first tick with a
//     non-zero control word. ResumeDriving (a reload mid-run) declares no second load.
//   - the room is arena.jslib's arenaRoomOf: the sum of the core's roomFor over the bed's vsizes - a sum of the four
//     parcel sizes below; the bed is two columns of 3.0 m (CargoBay.TryAdd), at most 393,214 of 393,216 room units.
//   - fee and BTC are sums over the same parcels (CargoBay.FeeCarried, BtcHundredths): an empty bed is 0 / 0 / 0, and a
//     parcel is a mempool transaction, which pays at least 1 sat; BTC is capped at CargoBay.BtcLimit, 20 BTC.
//   - the client publishes a load with the batch that carries its tick (client.js drain: `at < through`).
// Measured on the 149 loads a testnet4 seat holds (node-1.db, 2026-10-02 .. 11-11): every one of them from a page passes.

/** The room one parcel takes, by its size class - the app's rules/cargo.js roomFor (Q16.16 of 0.55, 0.78, 1.05, 1.35 m). */
export const PARCEL_ROOMS = Object.freeze([36044, 51118, 68812, 88474]);
/** The whole bed in room units: two columns of 3.0 m in Q16.16 (cargo.js BED_LENGTH x COLUMNS; fill() is ONE there). */
export const BED_ROOM_UNITS = 2 * 196608;
/** CargoBay.BtcLimit (20 BTC) in hundredths. */
export const BTC_MOST_HUND = 2000;

// THE BED AN ENTRY'S TRUCK HAS (kanban #3695, spec ruling #3707): Next Block sells the larger truck (2 x 3.9 m, 511180 units), and its honest
// loads above the stock bed were refused. An entry's bed capacity is the capacity of the truck its unlocks select, from the truck table the
// game's registration declares (`trucks`: { bedRoom, byUnlock: { unlock hex: room } }); a registration without one is 393216 for everyone
// (every game version before the table). Only the unlocks the entry carries count - its items, which round.enter verified it owns, through
// the round's game's catalogue (plugins.js itemUnlocksOf) - and an unknown unlock selects nothing. Batch door, objection checker and arbiter
// all take the bound from bedRoomOf.
/** The most room a truck table may name (two stock beds): it sizes the tables below. */
export const BED_ROOM_MOST = 2 * BED_ROOM_UNITS;
const roomOk = (r) => Number.isInteger(r) && r > 0 && r <= BED_ROOM_MOST;
/** A registration's truck table, checked: { bedRoom, byUnlock: Map(unlock hex -> room) }, or null (none, or one that does not stand). */
export function truckTableOf(trucks) {
  if (!trucks || typeof trucks !== 'object') return null;
  const bedRoom = trucks.bedRoom === undefined ? BED_ROOM_UNITS : trucks.bedRoom;
  if (!roomOk(bedRoom)) return null;
  const byUnlock = new Map();
  for (const [u, r] of Object.entries(trucks.byUnlock || {})) {
    if (!/^[0-9a-fA-F]{64}$/.test(u) || !roomOk(r)) return null;
    byUnlock.set(u.toLowerCase(), r);
  }
  return Object.freeze({ bedRoom, byUnlock });
}
/**
 * The bed capacity of an entry, in room units: `entry.items` through `unlocks` (item id -> unlock hex, the round's game's catalogue), the
 * first one the truck table names; else the table's default; with no table, the stock bed.
 */
export function bedRoomOf(entry, { unlocks = {}, trucks = null } = {}) {
  const t = trucks && trucks.byUnlock instanceof Map ? trucks : truckTableOf(trucks);
  if (!t) return BED_ROOM_UNITS;
  for (const it of (entry && entry.items) || []) {
    const u = unlocks && Object.prototype.hasOwnProperty.call(unlocks, it.itemId) ? String(unlocks[it.itemId]).toLowerCase() : null;
    if (u && t.byUnlock.has(u)) return t.byUnlock.get(u);
  }
  return t.bedRoom;
}

// THE FEWEST PARCELS EACH ROOM NEEDS, 0 for an empty bed and -1 for a room no bed of parcels makes. A room's value does not depend on the
// bed (the walk only adds parcels), so one table up to BED_ROOM_MOST serves every bed; it is built on first use.
let FEWEST = null;
const fewestTable = () => {
  if (FEWEST) return FEWEST;
  const n = new Int8Array(BED_ROOM_MOST + 1).fill(-1);
  n[0] = 0;
  for (let r = 0; r <= BED_ROOM_MOST; r++) {
    if (n[r] < 0) continue;
    for (const p of PARCEL_ROOMS) {
      const t = r + p;
      if (t <= BED_ROOM_MOST && (n[t] < 0 || n[t] > n[r] + 1)) n[t] = n[r] + 1;
    }
  }
  return (FEWEST = n);
};

/** How many parcels a bed of `bed` room units holds at the fewest in this room, or -1 when no bed of parcels takes exactly this room. */
export const fewestParcels = (room, bed = BED_ROOM_UNITS) =>
  (Number.isInteger(room) && room >= 0 && room <= bed && bed <= BED_ROOM_MOST ? fewestTable()[room] : -1);

// THE FEWEST SATS EACH ROOM PAYS (kanban #1740, #1800 - a refute of #1488: a full bed at 1 sat a parcel, 7 sats, scored
// C = 1 at heat 22/65536, Hexbox #011's attack 1 by another price). A parcel is a transaction in the mempool, and a
// mempool takes none below the minimum relay feerate: 0.1 sat/vB since Bitcoin Core 29.1 (it was 1), Core's GetFee
// truncating. The size class sets the fewest vbytes a parcel of it has - 65 (MIN_STANDARD_TX_NONWITNESS_SIZE), then the
// class bounds of roomFor, 250, 600 and 1500 - so a parcel of each class pays at least 6, 25, 60 and 150 sats. A room is
// owed the cheapest set of parcels that makes it: a full bed is at least 98 sats (heat 321/65536, not 22), and a heat that
// follows C is the attested-transaction load of a later game version. Every page load measured on testnet4 pays far more.
/** The fewest sats a parcel of each size class pays (0.1 sat/vB of the class's fewest vbytes), PARCEL_ROOMS' order. */
export const PARCEL_FEWEST_SATS = Object.freeze([6, 25, 60, 150]);
let CHEAPEST = null;
const cheapestTable = () => {
  if (CHEAPEST) return CHEAPEST;
  const n = new Int32Array(BED_ROOM_MOST + 1).fill(-1);
  n[0] = 0;
  for (let r = 0; r <= BED_ROOM_MOST; r++) {
    if (n[r] < 0) continue;
    for (let i = 0; i < PARCEL_ROOMS.length; i++) {
      const t = r + PARCEL_ROOMS[i], f = n[r] + PARCEL_FEWEST_SATS[i];
      if (t <= BED_ROOM_MOST && (n[t] < 0 || n[t] > f)) n[t] = f;
    }
  }
  return (CHEAPEST = n);
};

/** The fewest sats a bed (of `bed` room units) of this room pays at the minimum relay feerate, or -1 when no bed of parcels takes this room. */
export const fewestSats = (room, bed = BED_ROOM_UNITS) =>
  (Number.isInteger(room) && room >= 0 && room <= bed && bed <= BED_ROOM_MOST ? cheapestTable()[room] : -1);

/**
 * Why this load could not come from an honest bed, or null. `load` is [tick, fee, btc] or [tick, fee, btc, room].
 * The values alone - where it sits in the run is loadsRefusal's. `bed`: the entry's bed capacity (bedRoomOf), the stock bed by default.
 */
export function loadValueRefusal([tick, fee, btc, room], bed = BED_ROOM_UNITS) {
  if (room === undefined || room === null)
    return `the load at tick ${tick} carries no room: every page has sent the room its bed fills since the cargo factor became the bed fill, and a load without one scores 0.7 of a bed with no parcel on it`;
  if (!Number.isInteger(fee) || fee < 0) return `the load at tick ${tick} pays ${fee} sats: a fee is not negative`;
  // kanban #2112 (#1489 v1-refute-66-s3-1, Hexbox #011): the core reads the fee as `feeSats | 0` (an i32), and a batch carries it as one;
  // a live run's inputs are free JSON, so 2^32 would pass the rule below and be played as 0 sats
  if (fee > 0x7fffffff) return `the load at tick ${tick} pays ${fee} sats: a fee is at most ${0x7fffffff} (the core reads it as a 32-bit integer)`;
  if (!Number.isInteger(btc) || btc < 0 || btc > BTC_MOST_HUND)
    return `the load at tick ${tick} carries ${btc} hundredths of a BTC: a truck carries 0 .. ${BTC_MOST_HUND} (20 BTC)`;
  if (!Number.isInteger(room) || room < 0 || room > bed)
    return `the load at tick ${tick} fills ${room} room units: ${bed === BED_ROOM_UNITS ? 'a bed' : 'this entry\'s bed'} is 0 .. ${bed}`;
  const parcels = fewestParcels(room, bed);
  if (parcels < 0)
    return `the load at tick ${tick} fills ${room} room units, which no bed of parcels fills (each parcel takes ${PARCEL_ROOMS.join(', ')})`;
  if (parcels === 0 && (fee !== 0 || btc !== 0))
    return `the load at tick ${tick} is an empty bed carrying ${fee} sats and ${btc} hundredths of a BTC: an empty bed carries nothing`;
  if (fee < parcels)
    return `the load at tick ${tick} fills ${room} room units - ${parcels} parcels at the fewest - and pays ${fee} sats: every parcel is a transaction that pays at least 1 sat`;
  const sats = fewestSats(room, bed);
  if (fee < sats)
    return `the load at tick ${tick} fills ${room} room units - ${parcels} parcels at the fewest - and pays ${fee} sats: parcels that fill it pay at least ${sats} sats at the minimum relay feerate (0.1 sat/vB)`;
  return null;
}

/**
 * Why the loads of this batch are refused, or null. `b` the decoded batch, `at` its ticks (batchTicks), `drivenBefore()`
 * true when a tick of this entry the seat already holds carries a non-zero control word (only asked when a load comes),
 * `next` the tick this entry's next batch has to start at (Round.nextTick), `bed` the entry's bed capacity (bedRoomOf).
 */
export function loadsRefusal(b, at, drivenBefore, next, bed = BED_ROOM_UNITS) {
  const loads = b.loads || [];
  if (!loads.length) return null;
  // NOT DECLARED AHEAD (kanban #1740, #1800 - a refute of #1488): Round.batch holds a batch's first tick to the next one
  // only when it carries ticks, so a batch of no ticks at firstTick 398, sent before the truck moved, put a full bed at
  // the gate that the replay applied after a whole run driven empty. A batch of no ticks reaches the next tick, no other.
  if (!at.length && b.firstTick !== next)
    return `the loads of a batch of no ticks at ${b.firstTick} are not at the next tick of this run (${next}): a load goes out with the batch that reaches its tick`;
  // the ticks this batch carries; a batch of no ticks reaches the one it starts at (a load there goes before that tick)
  const first = b.firstTick, last = at.length ? at[at.length - 1] : b.firstTick;
  const ticks = new Set();
  let stored = null;
  for (const l of loads) {
    const tick = l[0];
    if (tick < first || tick > last)
      return `the load at tick ${tick} is not at a tick this batch carries (${first} .. ${last}): a load goes out with the batch that reaches its tick`;
    if (ticks.has(tick)) return `two loads at tick ${tick}: a page declares at most one a tick`;
    ticks.add(tick);
    const why = loadValueRefusal(l, bed);
    if (why) return why;
    // AFTER ROLL OUT NOTHING GOES ON THE BED: the truck is held (every control word 0) until the load is declared
    if (stored === null) stored = !!drivenBefore();
    if (stored) return `the load at tick ${tick} comes after the truck was driven: a bed is declared before ROLL OUT`;
    for (let i = 0; i < at.length && at[i] < tick; i++) {
      const w = b.ticks[i];
      if (w[0] || w[1] || w[2] || w[3])
        return `the load at tick ${tick} comes after the truck was driven at tick ${at[i]}: a bed is declared before ROLL OUT`;
    }
  }
  return null;
}
