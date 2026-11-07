// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A NODE KEEPS OF THE CENSUS KEY (5A.3B, kanban #972): one run's deals, complaints and statements, its shares of a key that stands, and what the chain scan found.
// The tables are in store.js; this is their only reader. A deal is deleted once its run is over, because a run at 1000 nodes holds about 37 MB of them; the shares never are.
import { toHex } from '../../arena-protocol/src/hash.js';
import { durably } from './store.js';

const buf = (b) => Buffer.from(b);
const u8 = (b) => new Uint8Array(b);

export class CensusKeyStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
  }

  /** The run's state, { } for one not seen: phases only, nothing secret. */
  runState(runId) {
    const row = this.db.prepare('SELECT state FROM census_key_runs WHERE run_id = ?').get(buf(runId));
    return row ? JSON.parse(row.state) : {};
  }

  putRunState(runId, epoch, state) {
    this.db.prepare('INSERT OR REPLACE INTO census_key_runs (run_id, epoch, state, updated_ms) VALUES (?, ?, ?, ?)').run(buf(runId), epoch, JSON.stringify(state), this.now());
  }

  /** The first signed deal per dealer stands: a second deal by one dealer writes nothing. */
  keepDeal(runId, dealer, wire, { durable = false } = {}) {
    const write = () => this.db.prepare('INSERT OR IGNORE INTO census_key_deals (run_id, dealer, wire, accepted_ms) VALUES (?, ?, ?, ?)').run(buf(runId), buf(dealer), buf(wire), this.now()).changes > 0;
    // THIS NODE'S OWN DEAL IS ON THE DISK BEFORE IT LEAVES (kanban #1243): a lost one made the node deal a second, different deal after a power loss
    return durable ? durably(this.db, write) : write();
  }

  dealOf(runId, dealer) {
    const row = this.db.prepare('SELECT wire FROM census_key_deals WHERE run_id = ? AND dealer = ?').get(buf(runId), buf(dealer));
    return row ? u8(row.wire) : null;
  }

  dealers(runId) {
    return this.db.prepare('SELECT dealer FROM census_key_deals WHERE run_id = ? ORDER BY dealer').all(buf(runId)).map((r) => toHex(u8(r.dealer)));
  }

  deals(runId) {
    return this.db.prepare('SELECT dealer, wire FROM census_key_deals WHERE run_id = ? ORDER BY dealer').all(buf(runId)).map((r) => ({ dealer: toHex(u8(r.dealer)), wire: u8(r.wire) }));
  }

  keepComplaint(runId, dealer, node, bytes) {
    return this.db.prepare('INSERT OR IGNORE INTO census_key_complaints (run_id, dealer, node, bytes) VALUES (?, ?, ?, ?)').run(buf(runId), buf(dealer), buf(node), buf(bytes)).changes > 0;
  }

  complaints(runId) {
    return this.db.prepare('SELECT dealer, bytes FROM census_key_complaints WHERE run_id = ? ORDER BY dealer, node').all(buf(runId)).map((r) => ({ dealer: toHex(u8(r.dealer)), bytes: u8(r.bytes) }));
  }

  /** Every signed statement is kept, a second record by one node too: that is what names an equivocator. */
  keepStatement(runId, { node, recordId, signature }) {
    return this.db.prepare('INSERT OR IGNORE INTO census_key_statements (run_id, node, record_id, signature) VALUES (?, ?, ?, ?)').run(buf(runId), buf(node), buf(recordId), buf(signature)).changes > 0;
  }

  statements(runId) {
    return this.db.prepare('SELECT node, record_id, signature FROM census_key_statements WHERE run_id = ? ORDER BY node, record_id').all(buf(runId))
      .map((r) => ({ node: u8(r.node), recordId: u8(r.record_id), signature: u8(r.signature) }));
  }

  /** Written once, when holders of the threshold signed one record and this node combined its shares. */
  keepHeld({ publicKey, epoch, runId, record, negated, shares, commitments }) {
    const flat = new Uint8Array(commitments.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of commitments) { flat.set(c, at); at += c.length; }
    this.db.prepare('INSERT OR REPLACE INTO census_key_held (public_key, epoch, run_id, record, negated, shares, commitments, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(buf(publicKey), epoch, buf(runId), buf(record), negated ? 1 : 0, JSON.stringify([...shares].map(([x, v]) => [x, v.toString(16)])), buf(flat), this.now());
  }

  /**
   * A key's shares this node holds, or null: `epoch`'s, or by default the newest it holds. `commitments` are the even key's, 33 bytes each. A reshare's shares are kept beside the
   * old ones under their own epoch: a run can fail after them, and only the chain says which stand.
   */
  held(publicKey, epoch = null) {
    const row = epoch === null ? this.db.prepare('SELECT * FROM census_key_held WHERE public_key = ? ORDER BY epoch DESC LIMIT 1').get(buf(publicKey))
      : this.db.prepare('SELECT * FROM census_key_held WHERE public_key = ? AND epoch = ?').get(buf(publicKey), epoch);
    if (!row) return null;
    const flat = u8(row.commitments), commitments = [];
    for (let at = 0; at < flat.length; at += 33) commitments.push(flat.subarray(at, at + 33));
    return { publicKey: u8(row.public_key), epoch: row.epoch, runId: u8(row.run_id), record: u8(row.record), negated: !!row.negated, commitments,
      shares: new Map(JSON.parse(row.shares).map(([x, v]) => [x, BigInt(`0x${v}`)])) };
  }

  /** A reshare stands on the chain: the shares below it go. Anyone may keep a copy and nobody can prove a deletion, but a node holds no secret it has no use for. */
  dropHeldBefore(publicKey, epoch) {
    return this.db.prepare('DELETE FROM census_key_held WHERE public_key = ? AND epoch < ?').run(buf(publicKey), epoch).changes;
  }

  /** A run over: its deals, complaints and statements go. Its state stays, and the epochs that failed are read from it. */
  dropRunData(runId) {
    for (const t of ['census_key_deals', 'census_key_complaints', 'census_key_statements']) this.db.prepare(`DELETE FROM ${t} WHERE run_id = ?`).run(buf(runId));
  }

  /** Runs of epochs below `epoch`. */
  runsBefore(epoch) {
    return this.db.prepare('SELECT run_id FROM census_key_runs WHERE epoch < ?').all(epoch).map((r) => u8(r.run_id));
  }

  /** The epochs of every run and how each ended, newest first. */
  runsNewestFirst(limit = 8) {
    return this.db.prepare('SELECT epoch, state FROM census_key_runs ORDER BY epoch DESC, updated_ms DESC').all().map((r) => ({ epoch: r.epoch, ...JSON.parse(r.state) })).filter((r) => !r.ready).slice(0, limit);
  }

  /** The dealers this node named in the failed reshares of one generation of a key, `key hex:epoch`. Only its own reading: nobody else's list moves by it. */
  namedDealers(generation) {
    return new Set(this.runsNewestFirst(Infinity).filter((r) => r.reshareOf === generation).flatMap((r) => r.named || []));
  }

  // THE CHAIN SCAN

  /** The highest height the scan finished, { height, hash }, or null. */
  scanTop() { return this.db.prepare('SELECT height, hash FROM census_key_scan ORDER BY height DESC LIMIT 1').get() || null; }

  /** The kept hashes, highest first: where a reorg is walked back to. */
  scanHashes() { return this.db.prepare('SELECT height, hash FROM census_key_scan ORDER BY height DESC').all(); }

  /** One height finished, with its anchors. The height goes last: a stop between them reads the block again and writes the same rows. Keeps the last `keep` hashes. */
  scanned(height, hash, anchors, keep) {
    for (const a of anchors) {
      this.db.prepare('INSERT OR REPLACE INTO census_key_anchors (height, idx, block_hash, txid, record_id, kind, body, stands, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(height, a.index, hash, a.txid, buf(a.id), a.kind, a.stands ? buf(a.bodyBytes) : null, a.stands ? 1 : 0, a.why || null);
    }
    this.db.prepare('INSERT OR REPLACE INTO census_key_scan (height, hash) VALUES (?, ?)').run(height, hash);
    this.db.prepare('DELETE FROM census_key_scan WHERE height <= ?').run(height - keep);
  }

  /** Every anchor, chain order. `kind`: 'K' a new key, 'G' a reshare's record, 'R' a reshare's list. A refused one has no body and says why. */
  anchors() {
    return this.db.prepare('SELECT * FROM census_key_anchors ORDER BY height, idx').all()
      .map((r) => ({ height: r.height, index: r.idx, kind: r.kind, blockHash: r.block_hash, txid: r.txid, id: u8(r.record_id), body: r.body ? u8(r.body) : null, stands: !!r.stands, why: r.why }));
  }

  /** A reorg: nothing above `height` was ever seen. Null forgets it all, and the scan starts over from its first height. */
  forgetAbove(height) {
    const from = height === null ? -1 : height;
    this.db.prepare('DELETE FROM census_key_anchors WHERE height > ?').run(from);
    this.db.prepare('DELETE FROM census_key_scan WHERE height > ?').run(from);
  }
}
