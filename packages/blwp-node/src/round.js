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
  encodeRoundContract, roundId, encodeEntryContract, entryId, decodeEntryContract,
  decodeRoundContract,
} from '../../protocol/src/contracts.js';
import { decodeInputBatch, batchTicks, batchId } from '../../protocol/src/batch.js';
import { encodeTranscript, transcriptHash, checkTranscript, GENESIS } from '../../protocol/src/transcript.js';
import {
  decodeCheckpoint, checkpointId, NO_PREVIOUS, splitSigned,
} from '../../protocol/src/checkpoint.js';
import {
  encodeCheckpointReceipt, decodeCheckpointReceipt, receiptId,
  joinSignedReceipt, splitSignedReceipt, SIGNED_RECEIPT_BYTES,
} from '../../protocol/src/receipt.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { toHex } from '../../protocol/src/hash.js';
import { OPEN, CLOSED, nodeIdentity } from './store.js';

/**
 * Five, of the seven a committee has (13C). The same number the client uses to
 * decide a mark is live, and for the same reason: no smaller set of nodes can
 * make a chain canonical, so an operator cannot spend a short committee.
 */
export const RECEIPTS_FOR_CANONICAL = 5;

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

export class Round {
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
    // Read once, and made on the first ask if the file has none. A node that
    // could not sign would have to answer a checkpoint with something other
    // than a receipt, and there is no such answer.
    this.identity = nodeIdentity(db);
  }

  /** This node's public key, which is what a client checks a receipt against. */
  get pubkey() { return this.identity.pubkey; }

  /**
   * The receipt for a mark: made once, kept, and re-served ever after.
   *
   * `IMPLEMENTATION.md` gives the wire as `S -> C RECEIPT { checkpoint_hash,
   * received_at, node_sig }`, and section 10 says what it is FOR: it proves
   * the player committed to that state at approximately that real time. So a
   * re-sent mark must get the same time back, not a new one - two times for
   * one commitment is exactly the claim the receipt is supposed to make
   * unambiguous. The store is what makes that true rather than a promise.
   *
   * What is signed is the tagged `receiptId`, not the raw encoding, for the
   * reason every other signature in this protocol is: a signature over bytes
   * can be replayed as a signature over a different object that happens to
   * encode the same way.
   */
  receiptFor(id) {
    const kept = this.db.prepare(
      'SELECT bytes FROM receipts WHERE checkpoint_id = ? AND node_pubkey = ?')
      .get(id, this.identity.pubkey);
    if (kept) return new Uint8Array(kept.bytes);

    const r = {
      checkpointId: id,
      receivedAtMs: BigInt(this.now()),
      nodePubkey: this.identity.pubkey,
    };
    const bytes = joinSignedReceipt(
      encodeCheckpointReceipt(r), ed25519.sign(receiptId(r), this.identity.secret));
    this.db.prepare('INSERT INTO receipts (checkpoint_id, node_pubkey, bytes) VALUES (?, ?, ?)')
      .run(id, this.identity.pubkey, bytes);
    return bytes;
  }

  /**
   * A receipt from SOMEBODY ELSE, offered by a peer.
   *
   * Section 10's gossip is what makes a player's equivocation surface quickly
   * rather than at settlement, and section 13C counts a chain as canonical
   * when it carries receipts from at least five committee nodes - so a node
   * has to be able to hold receipts it did not issue.
   *
   * It is stored only after the same three checks a client makes, and for the
   * same reason: a receipt is evidence, and evidence taken on trust is not
   * evidence. The mark must be one this node holds, or there is nothing for
   * the receipt to be about and no contract to read a committee from; the
   * signer must be on THAT round's committee, which the node reads off the
   * round contract it already stores; and the signature must verify.
   *
   * A repeat is byte-identical and a no-op. A DIFFERENT receipt from the same
   * member for the same mark is that member contradicting itself, and it is
   * refused by name rather than stored beside the first.
   */
  takeReceipt(bytes) {
    if (bytes.length !== SIGNED_RECEIPT_BYTES)
      throw new Error(`a signed receipt is ${SIGNED_RECEIPT_BYTES} bytes, got ${bytes.length}`);
    const { body, signature } = splitSignedReceipt(bytes);
    const r = decodeCheckpointReceipt(body);

    const mark = this.db.prepare(
      'SELECT round_id FROM checkpoints WHERE checkpoint_id = ?').get(r.checkpointId);
    if (!mark) {
      // KEPT, NOT DROPPED. This is 13B's divergence signal: a committee member
      // has receipted a mark this node never got, which is what a player
      // sending two chains to disjoint subsets looks like from here. The
      // signature is checked under the key the receipt names - the only check
      // available without a round to read a committee from - and it is filed
      // unattributed until the mark itself turns up.
      if (!ed25519.verify(signature, receiptId(r), r.nodePubkey))
        throw new Error(`the receipt from ${toHex(r.nodePubkey)} does not verify`);
      this.db.prepare(
        'INSERT OR IGNORE INTO foreign_receipts '
        + '(checkpoint_id, node_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?)')
        .run(r.checkpointId, r.nodePubkey, bytes, this.now());
      throw new Error('a receipt for a mark this node has not got');
    }

    const round = this.get(new Uint8Array(mark.round_id));
    const committee = decodeRoundContract(new Uint8Array(round.contract)).nodes;
    if (!committee.some((n) => same(n, r.nodePubkey)))
      throw new Error(
        `${toHex(r.nodePubkey)} is not on this round's committee`);

    let ok = false;
    try { ok = ed25519.verify(signature, receiptId(r), r.nodePubkey); } catch { ok = false; }
    if (!ok) throw new Error(`the receipt from ${toHex(r.nodePubkey)} does not verify`);

    const held = this.db.prepare(
      'SELECT bytes FROM receipts WHERE checkpoint_id = ? AND node_pubkey = ?')
      .get(r.checkpointId, r.nodePubkey);
    if (held) {
      if (same(new Uint8Array(held.bytes), bytes)) return 'held';
      throw new Error(
        `${toHex(r.nodePubkey)} has already receipted ${toHex(r.checkpointId)} differently`);
    }

    this.db.prepare('INSERT INTO receipts (checkpoint_id, node_pubkey, bytes) VALUES (?, ?, ?)')
      .run(r.checkpointId, r.nodePubkey, bytes);
    return 'held';
  }

  /**
   * Every receipt this node holds for an entry's marks, in tick order and then
   * by signer, as fixed-size records back to back - the same shape
   * `checkpoints` comes back in, so a reader cuts them apart without a framing
   * rule to agree on first.
   *
   * This is what a reconnecting client asks for. Its receipts are the only
   * thing it cannot rebuild by itself: it can recompute every mark it sent,
   * but not a signature over one.
   */
  receipts(roundId, entryId) {
    const rows = this.db.prepare(
      'SELECT r.bytes bytes FROM receipts r JOIN checkpoints c '
      + 'ON c.checkpoint_id = r.checkpoint_id '
      + 'WHERE c.round_id = ? AND c.entry_id = ? ORDER BY c.tick, r.node_pubkey')
      .all(roundId, entryId);
    const out = new Uint8Array(rows.length * SIGNED_RECEIPT_BYTES);
    rows.forEach((row, i) => out.set(new Uint8Array(row.bytes), i * SIGNED_RECEIPT_BYTES));
    return { count: rows.length, bytes: out };
  }

  /**
   * How many DIFFERENT committee members have receipted a mark.
   *
   * Section 13C: the canonical transcript is the longest chain carrying
   * receipts from at least five committee nodes. This counts; it does not
   * decide. Whether five is enough for a given round is the committee's
   * business and needs the other six nodes to exist, which is the next
   * sub-item and not this one.
   */
  receiptCount(checkpointId) {
    return this.db.prepare(
      'SELECT COUNT(DISTINCT node_pubkey) n FROM receipts WHERE checkpoint_id = ?')
      .get(checkpointId).n;
  }

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

    // AND IT MUST NOT BE LONGER THAN THE ROUND. `blockTicks` is a field of
    // the contract this node already stores, so the ceiling comes from the
    // round the player signed up to rather than from a number invented here.
    // The transport already refuses a frame that could not decode at all;
    // this refuses one that decodes and still could not be honest.
    const blockTicks = decodeRoundContract(new Uint8Array(round.contract)).blockTicks;
    if (b.ticks.length > blockTicks)
      throw new Error(
        `a batch carries at most the round's ${blockTicks} ticks, got ${b.ticks.length}`);

    // AND IT MUST NOT LEAVE A HOLE. The chain fixes the order of the batches;
    // this fixes the order of the ticks inside them, and it belongs HERE
    // rather than at hand-over. A node that stores a gap has accepted a
    // transcript it cannot later serve - measured: it took ticks 0..9 and then
    // 20..29, and `handOver` then threw "expected tick 10, got 20" with
    // nobody left to ask. Refusing at intake tells the one party who can still
    // fix it, and names the tick it is waiting for.
    const at = batchTicks(b);
    if (!seen && at.length) {
      const next = this.nextTick(b.roundId, b.entryId);
      if (at[0] !== next)
        throw new Error(`expected tick ${next}, got ${at[0]}`);
    }

    let fresh = 0;
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

  /**
   * The tick this entry's next batch has to start at.
   *
   * Not zero when it has none yet: `joinTick` is a field of the entry
   * contract and a player who joined at tick 50 starts at 50. Reading it off
   * the stored contract rather than assuming a start means the node uses the
   * number the player already signed instead of one of its own.
   */
  nextTick(roundIdBytes, entryIdBytes) {
    const row = this.db.prepare(
      'SELECT MAX(tick) t FROM ticks WHERE round_id = ? AND entry_id = ?')
      .get(roundIdBytes, entryIdBytes);
    if (row && row.t !== null) return row.t + 1;
    const e = this.db.prepare('SELECT contract FROM entries WHERE entry_id = ?').get(entryIdBytes);
    return e ? decodeEntryContract(new Uint8Array(e.contract)).joinTick : 0;
  }

  /** The id of the last batch in the chain, or the genesis if there is none. */
  head(roundIdBytes, entryIdBytes) {
    const row = this.db.prepare(
      'SELECT batch_id FROM batches WHERE round_id = ? AND entry_id = ? ORDER BY seq DESC LIMIT 1')
      .get(roundIdBytes, entryIdBytes);
    return row ? new Uint8Array(row.batch_id) : GENESIS;
  }

  /**
   * A checkpoint in. Answers with this node's signed RECEIPT for it, whether
   * it was stored now or had already been stored; equivocation throws.
   *
   * It used to answer the words 'stored' and 'repeat'. Those said whether the
   * database had changed, which is the node's business and not the player's:
   * what a player needs back is evidence, and a receipt is evidence a third
   * party can check without asking this node anything. The two cases answer
   * the SAME bytes on purpose - a client that re-sends because it never
   * learned the first one landed is not in a different position from one that
   * did, and telling them apart would only invite them to be handled
   * differently.
   *
   * THE THREE CASES, and only the middle one is a judgement call the code
   * makes. Nothing at this key: store it. The SAME bytes again: a repeat,
   * answered like a repeated batch is, because re-sending is the right thing
   * for a client that never learned the first one landed. DIFFERENT bytes at
   * the same (round, entry, tick): that is section 13B, and the refusal names
   * both ids so the message itself is the proof rather than a report of one.
   *
   * The primary key would refuse the third case on its own - that is why it is
   * shaped that way - but the error would be SQLite's wording and would not
   * carry the other id. The key is still the guarantee; this only makes the
   * reason legible.
   *
   * The node does not check the state hash. It cannot: nothing here imports
   * the core, and that is deliberate - a daemon that recomputed the state
   * would be a second simulator, and then two of them could disagree.
   */
  checkpoint(bytes) {
    // The wire record is the checkpoint and then the 64 bytes that sign its
    // id. A message of any other length is refused before anything is parsed,
    // which is also what refuses an unsigned mark: there is no shorter form
    // that means "no signature", so it cannot be omitted by accident.
    const { body, signature } = splitSigned(bytes);
    const c = decodeCheckpoint(body);
    const round = this.get(c.roundId);
    if (!round) throw new Error('no such round');
    if (round.state !== OPEN) throw new Error('the round is closed');
    const entry = this.db.prepare('SELECT round_id, contract FROM entries WHERE entry_id = ?')
      .get(c.entryId);
    if (!entry) throw new Error('no such entry');
    if (!same(new Uint8Array(entry.round_id), c.roundId)) throw new Error('entry is not in this round');

    const id = checkpointId(c);

    // THE SIGNATURE, over the tagged id and under the SESSION key.
    //
    // The key is not sent with the mark and is not trusted from it: it is read
    // off the Entry Contract this node already stores, which the player's
    // long-term key certified when they joined. A mark that carried its own
    // key would prove only that whoever wrote it owned some key.
    //
    // The tagged id is signed rather than the raw encoding, so a signature
    // here cannot be replayed as a signature over a different object that
    // encodes to the same bytes.
    //
    // Checked BEFORE the chain and the tick, so an unsigned or forged mark
    // never reaches a rule that could store it, and the refusal names the
    // signature rather than whatever it collided with.
    const sessionPubkey = decodeEntryContract(new Uint8Array(entry.contract)).sessionPubkey;
    let ok = false;
    try { ok = ed25519.verify(signature, id, sessionPubkey); } catch { ok = false; }
    if (!ok) throw new Error('the signature does not verify under the entry\'s session key');
    const at = this.db.prepare(
      'SELECT checkpoint_id FROM checkpoints WHERE round_id = ? AND entry_id = ? AND tick = ?')
      .get(c.roundId, c.entryId, c.tick);
    if (at) {
      if (same(new Uint8Array(at.checkpoint_id), id)) return this.receiptFor(id);

      // KEPT, THEN REFUSED. The mark does not become a checkpoint and the
      // chain the committee carries is untouched - but the two signed marks
      // together are 13B's complete portable proof, and a node that refuses
      // the second and throws it away has destroyed the only thing that shows
      // what the player did. 13B: "Nodes MUST publish such a proof when they
      // hold one."
      const stored = this.db.prepare(
        'SELECT bytes FROM checkpoints WHERE round_id = ? AND entry_id = ? AND tick = ?')
        .get(c.roundId, c.entryId, c.tick);
      this.db.prepare(
        'INSERT OR IGNORE INTO equivocations '
        + '(round_id, entry_id, tick, stored_bytes, offered_bytes, seen_ms) '
        + 'VALUES (?, ?, ?, ?, ?, ?)')
        .run(c.roundId, c.entryId, c.tick, stored.bytes, bytes, this.now());

      throw new Error(
        `equivocation at tick ${c.tick}: ${toHex(at.checkpoint_id)} already stored, `
        + `now ${toHex(id)}`);
    }

    // THE CHAIN, the same rule the batches follow. A `previousHash` nothing
    // ever compares is decoration: it would let a checkpoint be re-parented
    // onto a different history and still be accepted. The first one of a
    // round chains to thirty-two zero bytes. Naming anything that is not the
    // current head - including a parent the node has never stored - is
    // refused here, because only the head can be named.
    const head = this.checkpointHead(c.roundId, c.entryId);
    if (!same(c.previousHash, head.id)) {
      // AND THIS ONE IS KEPT TOO. A mark that names a parent which is not the
      // head is usually an honest client with a stale head - it is refused
      // either way and it does not join the chain. But it is ALSO what the
      // other limb of 13B looks like arriving here: a second chain, built on a
      // parent this node never made the head. Throwing it away destroyed the
      // record, exactly as the same-tick case used to. Whether it proves
      // anything is `provesEquivocation`'s answer, not this door's.
      this.keepOffered(c, id, bytes);
      throw new Error('the checkpoint does not follow the chain head');
    }

    // AND TIME RUNS ONE WAY. Naming the right parent is not enough: a mark at
    // tick 30 that chains onto the mark at tick 60 passed every check above
    // and was stored, and `GET /checkpoints` then handed back [30, 60] - the
    // chain saying one order and the ticks another. That is the re-parenting
    // defect `previousHash` exists to prevent, on the time axis instead of the
    // history axis, so it is refused the same way and with the same shape of
    // message the batch path uses.
    if (head.tick !== null && c.tick <= head.tick) {
      // AND THIS ONE IS KEPT TOO, the third door that used to throw the record
      // away. A mark at tick 30 naming the mark at 60 as its parent passes the
      // head check and dies here - and if the player later sends an honest
      // child of that same parent, those two name one parent and are a fork by
      // 13B's own rule, with the earlier record already gone. Same shape as the
      // two before it: a refusal that discards evidence, in a door no test
      // crossed.
      this.keepOffered(c, id, bytes);
      throw new Error(`expected a tick after ${head.tick}, got ${c.tick}`);
    }

    // AND THE INPUTS MUST BE ONES THIS NODE HAS. `inputChainHash` says which
    // inputs claim to have produced that state; unchecked it is the same
    // decoration `previousHash` would have been, and a checkpoint could name
    // a transcript nobody has.
    //
    // WHAT THIS DOES NOT CHECK, and cannot: that those inputs actually
    // produce that state. That needs a replayer, and nothing in this package
    // imports the core. The node checks it KNOWS the inputs named; proving
    // they lead there is verification, and it has its own stage.
    //
    // The head at the moment of arrival is not demanded. A client may take a
    // mark at tick 60 and send the batch covering 0..119 afterwards, which is
    // a legitimate order over one socket, so what is required is that the
    // named batch is one the node holds for this entry - or the genesis, for
    // a mark taken before any batch was sent.
    if (!same(c.inputChainHash, GENESIS)) {
      const known = this.db.prepare(
        'SELECT 1 k FROM batches WHERE round_id = ? AND entry_id = ? AND batch_id = ?')
        .get(c.roundId, c.entryId, c.inputChainHash);
      if (!known) throw new Error('the checkpoint names inputs this node has not seen');
    }

    this.db.prepare(
      'INSERT INTO checkpoints (round_id, entry_id, tick, checkpoint_id, bytes, received_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.roundId, c.entryId, c.tick, id, bytes, Date.now());
    return this.receiptFor(id);
  }

  /**
   * The last checkpoint in the chain: its id and its tick.
   *
   * The tick comes back with it because both are needed to accept the next
   * one - the id says which history it belongs to, the tick says it comes
   * after. `null` means there is none yet, and the id is then the genesis.
   */
  checkpointHead(roundIdBytes, entryIdBytes) {
    const row = this.db.prepare(
      'SELECT checkpoint_id, tick FROM checkpoints WHERE round_id = ? AND entry_id = ? '
      + 'ORDER BY tick DESC LIMIT 1')
      .get(roundIdBytes, entryIdBytes);
    return row
      ? { id: new Uint8Array(row.checkpoint_id), tick: row.tick }
      : { id: NO_PREVIOUS, tick: null };
  }

  /**
   * Every checkpoint for an entry, in tick order, as the bytes that arrived.
   *
   * Concatenated and nothing else: a signed mark carries no variable-length
   * field, so the stream is self-delimiting and a reader can cut it into
   * fixed-size records - 167 bytes of checkpoint and 64 of signature - without
   * a framing convention to agree on first.
   */
  checkpoints(roundIdBytes, entryIdBytes) {
    const rows = this.db.prepare(
      'SELECT bytes FROM checkpoints WHERE round_id = ? AND entry_id = ? ORDER BY tick')
      .all(roundIdBytes, entryIdBytes);
    const parts = rows.map((r) => new Uint8Array(r.bytes));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return { bytes: out, count: parts.length };
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

  /**
   * THE CANONICAL TRANSCRIPT, section 13C.
   *
   * "For each player, the canonical transcript is the longest checkpoint chain
   * that carries receipts from at least 5 committee nodes, together with the
   * input batches whose hashes it commits to. All nodes replay that object, so
   * 'node A saw more than node B' cannot by itself produce disagreement."
   *
   * SELECTION, NOT SIMULATION. Nothing here replays anything and nothing here
   * imports the core - a daemon that recomputed the state would be a second
   * simulator, and then two of them could disagree, which is the whole thing
   * this protocol is built to avoid. What this does is choose: which marks the
   * committee has actually carried, and which inputs those marks commit to.
   *
   * LONGEST, so a chain that goes live and then falls short is not served
   * whole. The marks the committee carried are canonical and the ones after
   * them are not - and the answer says how many were left behind rather than
   * quietly handing over a shorter object as if it were everything.
   *
   * DISTINCT MEMBERS, not receipts: `receiptCount` counts different keys, so
   * five answers from one node are one node saying it five times.
   */
  canonicalTranscript(roundIdBytes, entryIdBytes) {
    const marks = this.db.prepare(
      'SELECT checkpoint_id, tick, bytes FROM checkpoints '
      + 'WHERE round_id = ? AND entry_id = ? ORDER BY tick')
      .all(roundIdBytes, entryIdBytes);
    if (!marks.length) throw new Error('no checkpoints for that entry');

    // The longest PREFIX every mark of which the committee has carried. A gap
    // ends it: a later mark that five members receipted is not canonical if
    // the mark it chains onto was never carried, because the chain is what
    // makes it mean anything.
    let live = 0;
    while (live < marks.length
      && this.receiptCount(marks[live].checkpoint_id) >= RECEIPTS_FOR_CANONICAL) live++;

    if (live === 0) {
      const held = this.receiptCount(marks[0].checkpoint_id);
      throw new Error(
        `no checkpoint of that entry is carried by ${RECEIPTS_FOR_CANONICAL} committee `
        + `members: the first has ${held}`);
    }

    // AND THE INPUTS THOSE MARKS COMMIT TO. The last canonical mark names a
    // batch chain head, and the batches up to it are the ones it committed to;
    // anything after that head was never part of what the committee carried.
    const last = decodeCheckpoint(splitSigned(new Uint8Array(marks[live - 1].bytes)).body);
    const rows = this.db.prepare(
      'SELECT bytes FROM batches WHERE round_id = ? AND entry_id = ? ORDER BY seq')
      .all(roundIdBytes, entryIdBytes);

    const batches = [];
    let head = GENESIS;
    let found = toHex(last.inputChainHash) === toHex(GENESIS);
    for (const row of rows) {
      if (found) break;
      const b = decodeInputBatch(new Uint8Array(row.bytes));
      batches.push(b);
      head = batchId(b);
      if (toHex(head) === toHex(last.inputChainHash)) found = true;
    }
    if (!found)
      throw new Error(
        `the last carried checkpoint commits to input chain ${toHex(last.inputChainHash)}, `
        + 'which this node does not hold');

    const t = {
      roundId: new Uint8Array(roundIdBytes),
      entryId: new Uint8Array(entryIdBytes),
      batches,
    };
    const ok = checkTranscript(t);
    if (!ok.ok) throw new Error(`the carried transcript is broken at ${ok.at}: ${ok.why}`);

    return {
      bytes: encodeTranscript(t),
      hash: transcriptHash(t),
      ticks: ok.ticks,
      marks: live,
      dropped: marks.length - live,
      throughTick: marks[live - 1].tick,
    };
  }

  /**
   * 13B'S PROOF, IF THIS NODE HOLDS ONE.
   *
   * Two signed checkpoints for one `(round, entry, tick)` with different ids.
   * Anyone can check it: the ids differ, the tick is the same, and both
   * signatures verify under the entry's own session key. No replay, no
   * committee, no core - which is why it is the one part of the no-quorum rule
   * a single node can hold up on its own.
   *
   * Answered as the two records and nothing else; what a forfeit costs is
   * settlement, and this object is only the evidence for it.
   */
  equivocation(roundIdBytes, entryIdBytes) {
    const out = this.db.prepare(
      'SELECT tick, stored_bytes, offered_bytes, seen_ms FROM equivocations '
      + 'WHERE round_id = ? AND entry_id = ? ORDER BY tick')
      .all(roundIdBytes, entryIdBytes)
      .map((r) => ({
        how: 'two marks at one tick',
        tick: r.tick,
        stored: new Uint8Array(r.stored_bytes),
        offered: new Uint8Array(r.offered_bytes),
        seenMs: r.seen_ms,
      }));

    // AND THE FORK LIMB, which this node held and could not publish.
    //
    // A mark refused for not following the head sits in `offered_marks`; the
    // chain it contradicts sits in `checkpoints`. Both records were here and
    // the door answered 204, which is 13B's "nodes MUST publish such a proof
    // when they hold one" being false while every test passed - the same-tick
    // pair was measured through the door and the fork pair was measured
    // through `provesEquivocation`, and nothing crossed them.
    //
    // The pairing is the proof's own rule and not a new one: a stored mark at
    // the same TICK contradicts it, and a stored mark naming the same PARENT
    // is the other chain. Nothing here decides - `provesEquivocation` does -
    // and the bytes served are the same bytes a stranger already knows how to
    // check.
    const kept = this.db.prepare(
      'SELECT tick, checkpoint_id, bytes, seen_ms FROM offered_marks '
      + 'WHERE round_id = ? AND entry_id = ? ORDER BY tick')
      .all(roundIdBytes, entryIdBytes);
    if (kept.length) {
      const chain = this.db.prepare(
        'SELECT tick, checkpoint_id, bytes FROM checkpoints '
        + 'WHERE round_id = ? AND entry_id = ? ORDER BY tick')
        .all(roundIdBytes, entryIdBytes)
        .map((r) => ({
          tick: r.tick,
          id: new Uint8Array(r.checkpoint_id),
          bytes: new Uint8Array(r.bytes),
          mark: decodeCheckpoint(splitSigned(new Uint8Array(r.bytes)).body),
        }));

      for (const k of kept) {
        const offered = new Uint8Array(k.bytes);
        const mine = decodeCheckpoint(splitSigned(offered).body);
        const against = chain.find((c) => c.tick === k.tick)
          || chain.find((c) => same(c.mark.previousHash, mine.previousHash));
        if (!against) continue;                  // nothing of ours contradicts it
        if (same(against.id, new Uint8Array(k.checkpoint_id))) continue;   // the same mark
        out.push({
          how: against.tick === k.tick ? 'two marks at one tick' : 'two chains from one parent',
          tick: k.tick,
          stored: against.bytes,
          offered,
          seenMs: k.seen_ms,
        });
      }
    }
    return out.sort((a, b) => a.tick - b.tick);
  }

  /**
   * The entry contract, as the player signed it.
   *
   * The session key is in it, and 13B's proof cannot be checked without one -
   * so a node that publishes the proof and not this has published something
   * nobody can verify.
   */
  entry(entryIdBytes) {
    const row = this.db.prepare('SELECT contract FROM entries WHERE entry_id = ?')
      .get(entryIdBytes);
    return row ? new Uint8Array(row.contract) : null;
  }

  /** Receipts this node holds for marks it has never seen. 13B's signal. */
  foreignReceipts() {
    return this.db.prepare(
      'SELECT checkpoint_id, node_pubkey, bytes, seen_ms FROM foreign_receipts '
      + 'ORDER BY seen_ms').all()
      .map((r) => ({
        checkpointId: new Uint8Array(r.checkpoint_id),
        nodePubkey: new Uint8Array(r.node_pubkey),
        bytes: new Uint8Array(r.bytes),
        seenMs: r.seen_ms,
      }));
  }

  /**
   * A signed mark this node refused, kept beside the chain it accepted.
   *
   * ONE PLACE, because there is more than one way to be refused and every one
   * of them used to destroy the record. It never joins the chain and it is not
   * a head; whether it proves anything is `equivocation`'s pairing and
   * `provesEquivocation`'s answer.
   */
  keepOffered(c, id, bytes) {
    this.db.prepare(
      'INSERT OR IGNORE INTO offered_marks '
      + '(round_id, entry_id, tick, checkpoint_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.roundId, c.entryId, c.tick, id, bytes, this.now());
  }

  /** Signed marks this node refused and kept, beside the chain it did accept. */
  offeredMarks(roundIdBytes, entryIdBytes) {
    return this.db.prepare(
      'SELECT tick, bytes FROM offered_marks WHERE round_id = ? AND entry_id = ? ORDER BY tick')
      .all(roundIdBytes, entryIdBytes)
      .map((r) => ({ tick: r.tick, bytes: new Uint8Array(r.bytes) }));
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
