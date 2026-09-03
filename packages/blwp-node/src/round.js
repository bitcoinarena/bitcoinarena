// One round, held by one node.
//
// The ids are NOT this file's invention: a round is identified by
// `roundId(contract)` and an entry by `entryId(contract)`, both tagged hashes
// out of `@blwp/protocol`. The node stores what it is given and can prove what
// it stored, which is the whole of its job in M2.1 step 1.
//
// It does not step the core. There is no `step` in this package and no import
// of one; a round is a list of inputs until something verifies it, and that
// something is the checkpoints in step 3.
import {
  encodeRoundContract, roundId, encodeEntryContract, entryId,
} from '../../protocol/src/contracts.js';
import { decodeInputBatch, batchTicks, batchId } from '../../protocol/src/batch.js';
import { encodeTranscript, transcriptHash, checkTranscript, GENESIS } from '../../protocol/src/transcript.js';
import { OPEN, CLOSED } from './store.js';

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export class Round {
  constructor(db, now = () => Date.now()) { this.db = db; this.now = now; }

  /**
   * Opens a round. Returns its id - the tagged hash of the contract.
   *
   * Opening the same contract twice is the SAME round, not a conflict: the id
   * is the hash of the contract, so a repeat cannot mean anything else. It
   * writes nothing and answers the same id, for the same reason a repeated
   * batch answers zero - a client that never learned whether its message
   * arrived is right to send it again, and a node that punishes that is
   * making the client guess.
   */
  open(contract) {
    const bytes = encodeRoundContract(contract);
    const id = roundId(contract);
    this.db.prepare('INSERT OR IGNORE INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, ?, ?)')
      .run(id, bytes, OPEN, this.now());
    return id;
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM rounds WHERE round_id = ?').get(id);
    return row || null;
  }

  /** Takes an entry. Refused after the round is closed, and refused twice. */
  enter(contract) {
    const round = this.get(contract.roundId);
    if (!round) throw new Error('no such round');
    if (round.state !== OPEN) throw new Error('the round is closed');
    // Same as the round above: the id is the hash of the contract, so the same
    // entry sent twice is one player joining once.
    const id = entryId(contract);
    this.db.prepare('INSERT OR IGNORE INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)')
      .run(id, contract.roundId, encodeEntryContract(contract), this.now());
    return id;
  }

  /**
   * Takes a batch. Returns how many ticks were new.
   *
   * A repeat writes nothing and is not an error: the player has no way to know
   * his message arrived, so re-sending is the correct thing for him to do and
   * the wrong thing for the node to punish. `INSERT OR IGNORE` against the
   * primary key is the whole mechanism.
   */
  batch(bytes) {
    const b = decodeInputBatch(bytes);
    const round = this.get(b.roundId);
    if (!round) throw new Error('no such round');
    if (round.state !== OPEN) throw new Error('the round is closed');
    const entry = this.db.prepare('SELECT round_id FROM entries WHERE entry_id = ?').get(b.entryId);
    if (!entry) throw new Error('no such entry');
    if (!same(new Uint8Array(entry.round_id), b.roundId)) throw new Error('entry is not in this round');

    const put = this.db.prepare(
      'INSERT OR IGNORE INTO ticks (round_id, entry_id, tick, words) VALUES (?, ?, ?, ?)');
    const putLiq = this.db.prepare(
      'INSERT OR IGNORE INTO liquidations (round_id, entry_id, tick, size) VALUES (?, ?, ?, ?)');

    // THE CHAIN, checked before anything is written. A batch that does not
    // name the head is not a late arrival to be sorted later - it belongs to
    // a different history, and storing it would make the transcript a bag
    // again. A repeat of the CURRENT head is still a no-op, because that is
    // the message a client re-sends when it never learned the first landed.
    const id = batchId(b);
    const seen = this.db.prepare(
      'SELECT seq FROM batches WHERE round_id = ? AND entry_id = ? AND batch_id = ?')
      .get(b.roundId, b.entryId, id);
    const head = this.head(b.roundId, b.entryId);
    if (!seen && !same(b.previousHash, head))
      throw new Error('the batch does not follow the chain head');

    let fresh = 0;
    const at = batchTicks(b);
    for (let i = 0; i < b.ticks.length; i++) {
      const words = new Uint8Array(new Int32Array(b.ticks[i]).buffer);
      fresh += put.run(b.roundId, b.entryId, at[i], words).changes;
    }
    for (const [tick, size] of b.liquidations) putLiq.run(b.roundId, b.entryId, tick, size);

    if (!seen) {
      const n = this.db.prepare(
        'SELECT COUNT(*) c FROM batches WHERE round_id = ? AND entry_id = ?')
        .get(b.roundId, b.entryId).c;
      this.db.prepare(
        'INSERT INTO batches (round_id, entry_id, seq, batch_id, bytes) VALUES (?, ?, ?, ?, ?)')
        .run(b.roundId, b.entryId, n, id, bytes);
    }
    return fresh;
  }

  /** The id of the last batch in the chain, or the genesis if there is none. */
  head(roundIdBytes, entryIdBytes) {
    const row = this.db.prepare(
      'SELECT batch_id FROM batches WHERE round_id = ? AND entry_id = ? ORDER BY seq DESC LIMIT 1')
      .get(roundIdBytes, entryIdBytes);
    return row ? new Uint8Array(row.batch_id) : GENESIS;
  }

  /**
   * The transcript as ONE object, in chain order: what a node hands over.
   *
   * Checked before it leaves, because a node that serves a broken chain has
   * made the next verifier's problem out of its own.
   */
  handOver(roundIdBytes, entryIdBytes) {
    const rows = this.db.prepare(
      'SELECT bytes FROM batches WHERE round_id = ? AND entry_id = ? ORDER BY seq')
      .all(roundIdBytes, entryIdBytes);
    const t = {
      roundId: new Uint8Array(roundIdBytes),
      entryId: new Uint8Array(entryIdBytes),
      batches: rows.map((r) => decodeInputBatch(new Uint8Array(r.bytes))),
    };
    const ok = checkTranscript(t);
    if (!ok.ok) throw new Error(`the stored transcript is broken at ${ok.at}: ${ok.why}`);
    return { bytes: encodeTranscript(t), hash: transcriptHash(t), ticks: ok.ticks };
  }

  close(id) {
    const round = this.get(id);
    if (!round) throw new Error('no such round');
    if (round.state === CLOSED) return false;
    this.db.prepare('UPDATE rounds SET state = ?, closed_ms = ? WHERE round_id = ?')
      .run(CLOSED, this.now(), id);
    return true;
  }

  /**
   * The transcript, in tick order: everything needed to replay the round and
   * nothing else. Absolute ticks, so a gap shows as a hole in the numbers
   * rather than as a shorter list nobody can size.
   */
  transcript(roundIdBytes, entryIdBytes) {
    const ticks = this.db.prepare(
      'SELECT tick, words FROM ticks WHERE round_id = ? AND entry_id = ? ORDER BY tick').all(roundIdBytes, entryIdBytes);
    const liq = this.db.prepare(
      'SELECT tick, size FROM liquidations WHERE round_id = ? AND entry_id = ? ORDER BY tick').all(roundIdBytes, entryIdBytes);
    return {
      ticks: ticks.map((r) => ({ tick: r.tick, words: [...new Int32Array(new Uint8Array(r.words).buffer)] })),
      liquidations: liq.map((r) => [r.tick, r.size]),
    };
  }

  /** Which tick numbers are missing between the first and the last stored. */
  gaps(roundIdBytes, entryIdBytes) {
    const rows = this.db.prepare(
      'SELECT tick FROM ticks WHERE round_id = ? AND entry_id = ? ORDER BY tick').all(roundIdBytes, entryIdBytes);
    if (rows.length === 0) return [];
    const have = new Set(rows.map((r) => r.tick));
    const out = [];
    for (let t = rows[0].tick; t <= rows[rows.length - 1].tick; t++) if (!have.has(t)) out.push(t);
    return out;
  }
}
