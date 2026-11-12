// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S TICK TOCK SNAPSHOTS, FROM ITS OWN BITCOIND (spec ruling of kanban #2571, #2574).
//
// A round on a Tick Tock core that draws its parcels plays the transactions of its beacon block (and of the blocks before it
// while fewer than 256 are held): arena-protocol ticktock-snapshot.js says which and how they are hashed and drawn. This reads
// them from the seat's own node - getblock verbosity 2 gives each transaction's vsize and fee - and holds the answer by the
// beacon's hash, as beacon-source.js holds a beacon: a block's transactions never change, and a beacon is held only at the
// round's depth. Nothing is trusted and nothing is proposed: every seat reads its own chain, and its signed listing names the id.
//
// The load door asks synchronously (Round.batch), so the read happens ahead of the question: `for()` answers what is held
// and starts a read of what is not; `refresh()` is the read. One read in flight per beacon; a failed read is tried again
// after a while and said once.
import { snapshotOfGetblocks, snapshotIdOf, snapshotJson, SNAPSHOT_MIN_TXS } from '../../arena-protocol/src/ticktock-snapshot.js';

const hex = (b) => Buffer.from(b).toString('hex');
/** How many beacons' snapshots a seat keeps (a beacon is shared by every round whose committee time it follows). */
export const SNAPSHOTS_KEPT = 64;
/** A read that failed is not tried again for this long. */
export const SNAPSHOT_RETRY_MS = 15000;

export function chainSnapshots({ call, kept = SNAPSHOTS_KEPT, retryMs = SNAPSHOT_RETRY_MS, log = (l) => console.log(l) } = {}) {
  if (typeof call !== 'function') throw new Error('a seat\'s snapshots are read from its bitcoind: give it a call');
  const held = new Map();              // beacon hash hex (hashing order) -> { snapshot, id, blocks }
  const reading = new Map();
  const failed = new Map();            // beacon hash hex -> { atMs, why }

  /** Walk back from the beacon: its getblock (verbosity 2) and header, then its parents', until 256 transactions are held. */
  async function read(beacon) {
    const answers = [], blocks = [];
    let at = Buffer.from(beacon.hash).reverse().toString('hex');          // the RPC names a block in display order
    let txs = 0;
    for (;;) {
      const g = await call('getblock', [at, 2]);
      const header = await call('getblockheader', [at, false]);
      answers.push(g);
      blocks.push({ height: g.height, header: Uint8Array.from(Buffer.from(header, 'hex')), txids: g.tx.map((t) => t.txid) });
      txs += g.tx.length - 1;
      if (txs >= SNAPSHOT_MIN_TXS || g.height === 0 || !g.previousblockhash) break;
      at = g.previousblockhash;
    }
    if (answers[0].height !== beacon.height) throw new Error(`the beacon is block ${beacon.height}, and this node has that hash at ${answers[0].height}`);
    const snapshot = snapshotOfGetblocks(answers, Uint8Array.from(beacon.hash));
    return { snapshot, id: snapshotIdOf(snapshot), blocks };
  }

  const api = {
    /** Read the snapshot of this beacon ({ hash, height }) from the chain and keep it; answers what is held. */
    async refresh(beacon) {
      const key = hex(beacon.hash);
      if (held.has(key)) return held.get(key);
      if (reading.has(key)) return reading.get(key);
      const r = read(beacon).then((got) => {
        held.set(key, got); failed.delete(key);
        if (held.size > kept) held.delete(held.keys().next().value);
        log(`[snapshot] block ${beacon.height} ${key.slice(0, 16)}: ${got.snapshot.count} transactions over ${got.blocks.length} block(s), id ${hex(got.id).slice(0, 16)}`);
        return got;
      }, (e) => {
        const why = String((e && e.message) || e);
        const had = failed.get(key);
        if (!had || had.why !== why) log(`[snapshot] block ${beacon.height} ${key.slice(0, 16)} did not read: ${why}`);
        failed.set(key, { atMs: Date.now(), why });
        throw e;
      }).finally(() => reading.delete(key));
      reading.set(key, r);
      return r;
    },
    /** What is held for this beacon - { snapshot, id, blocks } - or undefined, a read started (unless one just failed). */
    for(beacon) {
      if (!beacon || !(beacon.hash instanceof Uint8Array) || beacon.hash.length !== 32 || !Number.isInteger(beacon.height)) return undefined;
      const key = hex(beacon.hash);
      const got = held.get(key);
      if (got) return got;
      const f = failed.get(key);
      if (!reading.has(key) && !(f && Date.now() - f.atMs < retryMs)) api.refresh(beacon).catch(() => {});
      return undefined;
    },
    /** Why the last read of this beacon failed, if it did. */
    whyNot(beacon) { const f = beacon && beacon.hash ? failed.get(hex(beacon.hash)) : null; return f ? f.why : null; },
    /** GET /snapshot's answer for a held snapshot. */
    json(got, roundId) { return snapshotJson(got.snapshot, { roundId, blocks: got.blocks }); },
    get size() { return held.size; },
  };
  return api;
}
