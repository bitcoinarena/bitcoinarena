// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// One round, held by one node.
//
// The ids are NOT this file's invention: a round is identified by
// `roundId(contract)` and an entry by `entryId(contract)`, both tagged hashes
// out of `arena-protocol`. The node stores what it is given and can prove what
// it stored, which is the whole of its job in M2.1 step 1.
//
// It does not step the core. There is no `step` in this package and no import
// of one; a round is a list of inputs until something verifies it, and that
// something is the checkpoints in step 3.
import { durably } from './store.js';
import { createInterner } from './intern.js';
import {
  encodeRoundContract, roundId, encodeEntryContract, entryId, decodeEntryContract,
  decodeRoundContract, roundWindowsAreValid, lastTickOfRun, sittingSeatsFitTheSlots } from '../../arena-protocol/src/contracts.js';
import { decodeInputBatch, batchTicks, batchId, splitSignedBatch } from '../../arena-protocol/src/batch.js';
import { tableAnchorOf } from '../../arena-protocol/src/known-game.js';
import { checkBatchPrices } from '../../arena-protocol/src/price-sample.js';
import { LATE_JOIN_LAST_ENTRY_MS, entryItemDigest } from '../../arena-protocol/src/contracts.js';
/** How long after a round's entry close an entry new to a seat is still taken (kanban #1216). */
export const ENTRY_CLOSE_GRACE_MS = 15000n;
import { LATE_JOIN_MS } from '../../arena-protocol/src/series.js';
import { ticksForMs } from '../../arena-protocol/src/tick.js';
import { worldSecretFits } from '../../arena-protocol/src/seed.js';
import { encodeTranscript, transcriptHash, checkTranscript, GENESIS } from '../../arena-protocol/src/transcript.js';
import {
  decodeCheckpoint, checkpointId, NO_PREVIOUS, splitSigned,
} from '../../arena-protocol/src/checkpoint.js';
import {
  encodeCheckpointReceipt, decodeCheckpointReceipt, receiptId,
  joinSignedReceipt, splitSignedReceipt, SIGNED_RECEIPT_BYTES,
} from '../../arena-protocol/src/receipt.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { namesNoDraw, mediansPrices, FRONTEND_FEE_VERSION, ITEMS_VERSION, objectionWindowFits } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { entryFeeBpsForRound, entryPaysReserves, roundSplit, RESERVES_NODE_FEE_BPS, entryGiftsInFee, giftsEntryExpected, giftsFeeBps, ROUND_SPLIT_BPS } from '../../arena-protocol/src/reserves.js';
import { roundSplitBps } from '../../arena-protocol/src/fee-proposal.js';
import { itemOf } from '../../arena-protocol/src/items.js';
import { itemPurchaseKept } from './item-purchase-seat.js';
import { readTranscript } from './transcript-read.js';
import { loadsRefusal } from './load-checks.js';
// 27A.7's node fee. The rate lives in one place and `genesis.js` writes it into
// the genesis parameters, so a round naming a config has committed to it.
import { feeMatchesEntry, feeBpsOf, entryFeeBpsOf, donationInFee, donationBpsOf, NODE_FEE_BPS } from '../../arena-protocol/src/fee.js';
import { PRICE_SCALE, TICK, SHARE_MSAT, MIN_SHARES, MIN_ORDER_MSAT, MAX_ORDER_MSAT } from '../../arena-protocol/src/order-book.js';
import { OPEN, CLOSED, nodeIdentity } from './store.js';
import { receiptsNeeded } from '../../arena-protocol/src/genesis.js';
import { decodeHandout } from '../../arena-protocol/src/handout.js';
import { stakePointIsTheHandouts } from '../../arena-protocol/src/contracts.js';
import { encodeFraudProof, fraudProofHash } from '../../arena-protocol/src/slash.js';
import { firstMarkOutcome, startDeadlineOf, roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { H2H_REVEAL_MIN_MS, marketOfRound } from '../../arena-protocol/src/manifest.js';
import { marketWindowOf } from '../../arena-protocol/src/attested.js';
import { pluginForRound, hostedPlugins, runLengthFits } from './plugins.js';
import { chainIndex } from './finality.js';
import { withinTolerance } from '../../arena-protocol/src/window.js';
import { decodeRerunResult, splitSignedRerun } from '../../arena-protocol/src/rerun.js';
import { statesBefore } from './send-state.js';

/**
 * 5-of-7 unless the round's contract is the 2-slot test genesis.
 */
export const RECEIPTS_FOR_CANONICAL = receiptsNeeded(7);
// A LATE ENTRY'S JOIN TICK MAY TRAIL THE ROUND'S CLOCK BY THIS MUCH: the device's clock and the post.
export const LATE_ENTRY_TICK_SLACK_MS = 10000n;

/**
 * A STORED ROUND THIS NETWORK CANNOT PARSE IS ABSENT (RULED 2026-09-22 22:59, §23.6): "a record
 * from before this ruling that carries the old value is not a round of this network and is neither
 * decoded, replayed, settled, listed nor counted; a node that holds such a record treats it as it treats
 * bytes that do not parse." So every read of the `rounds` table goes through this, and a row whose
 * contract does not decode - a past round of the withdrawn Lightning custody, custody byte 0 - is answered as no row at all.
 * Its bytes stay where they are: absent is not deleted, and nothing here writes to the store.
 */
// WHAT A STORED CONTRACT SAYS, READ ONCE PER CONTRACT (NODE-OPT-1648): every get() decoded the whole contract only to
// see that it parses, and a tick batch decoded it again for its blockTicks - on every batch from every player. Kept by
// the contract's bytes (a contract never changes), up to 8192; only these two answers leave, never the decoded object.
const contractFacts = new Map();
const factsOf = (contract) => {
  const key = Buffer.from(contract).toString('base64');
  let f = contractFacts.get(key);
  if (f === undefined) {
    try { const c = decodeRoundContract(new Uint8Array(contract)); f = { blockTicks: c.blockTicks }; } catch { f = null; }
    contractFacts.set(key, f);
    if (contractFacts.size > 8192) contractFacts.delete(contractFacts.keys().next().value);
  }
  return f;
};
const parses = (contract) => factsOf(contract) !== null;

function neededForRound(db, roundIdBytes) {
  const row = db.prepare('SELECT contract FROM rounds WHERE round_id = ?').get(roundIdBytes);
  if (!row || !parses(row.contract)) return RECEIPTS_FOR_CANONICAL;
  return receiptsNeeded(decodeRoundContract(new Uint8Array(row.contract)).gameVerifySlots);
}

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * A NODE'S SIGNATURE, BIP-340 under its one key (26's ruling). Answered rather
 * than thrown: a malformed key or signature is a refusal, and `schnorr.verify`
 * throws on both.
 */
const verifyNode = (signature, message, pubkey) => {
  try { return schnorr.verify(signature, message, pubkey); } catch { return false; }
};

const sendRow = (r) => ({ entryId: new Uint8Array(r.entry_id), attempt: r.attempt, roundId: new Uint8Array(r.round_id),
  address: r.address, invoice: r.invoice, paymentHash: r.payment_hash, invoiceMsat: BigInt(r.invoice_msat), payoutMsat: BigInt(r.payout_msat),
  owedMsat: BigInt(r.owed_msat), gatewayUrl: r.gateway_url, gatewayPk: r.gateway_pk, expiration: BigInt(r.expiration),
  txid: r.txid, outIdx: r.out_idx === null ? null : Number(r.out_idx), preimage: r.preimage, state: r.state, why: r.why, donation: !!r.donation });

/** A transcript (transcript.js) frames each batch with a u16 length: no batch longer than this can be in one. */
export const TRANSCRIPT_BATCH_MAX_BYTES = 65535;

const namedBatchRow = (r) => ({ bodyId: r.body_id, txid: r.txid, signers: JSON.parse(r.signers), signatures: JSON.parse(r.signatures).map((x) => new Uint8Array(Buffer.from(x, 'hex'))),
  slots: JSON.parse(r.slots), madeMs: Number(r.made_ms) });

/** Foreign receipts kept (kanban #1274): at most this many, none older than a day. */
export const FOREIGN_RECEIPTS_KEPT = 4096;
export const FOREIGN_RECEIPTS_MAX_AGE_MS = 24 * 3600000;

export class Round {
  /** How long openHeld trusts its last count of the open rows when this store wrote none (kanban #786). */
  static OPEN_HELD_MS = 250;
  /** How many closed rounds closedSince remembers (kanban #791). */
  static CLOSED_LOG = 4096;
  // kanban #1548: refused marks kept per entry (keepOffered) - the first 64, then at most 8 that contradict the chain.
  static OFFERED_KEEP = 64;
  static OFFERED_PROOF_KEEP = 8;
  constructor(db, now = () => Date.now(), { plugins = [] } = {}) {
    this.db = db;
    this.now = now;
    // A COUNT THAT MOVES WHENEVER A ROUND OPENS, CLOSES OR HAS ITS CONTRACT CHANGED (kanban #576): a caller that keeps what it read
    // of the open rounds reads them again only once this has moved
    this.openSeq = 0;
    // EACH OPEN ROUND'S CONTRACT, DECODED ONCE (kanban #742, test host seat 6 idle 2026-10-28: 46 MB/s allocated, 21 % of the seat in
    // the garbage collector; the committee draws, the listing, the attestor's `due`, the held/price/prune scans re-read and re-decoded
    // every one of ~11,400 open rounds' contracts each pass, past the 8,192-contract parse cache below). Round id hex -> the decoded
    // contract (null: it does not parse), kept only while the store holds the round OPEN: dropped at its close, when its contract is
    // rewritten, when it is deleted, and whenever the open list is read again. Callers share the object and never change it.
    this.contracts = new Map();
    this.interner = createInterner();      // a kept contract's equal values, one object (kanban #927)
    // THE OPEN IDS, read again only once a round opened, closed or was deleted (their count or newest row moved): the same id objects
    // are handed out again, so a caller keeps what it derived from them; `hexOf` is each one's hex
    this.openList = { key: null, ids: [] };
    this.closedSinceList = new Set();   // hex of the rounds this store closed since the open list was last read (kanban #791)
    this.closeSeq = 0;                  // how many rounds this store has closed, and the last CLOSED_LOG of them (closedSince)
    this.closedLog = [];
    this.hexOfId = new WeakMap();
    // THE GAMES THIS NODE HOSTS (§0A.4; M3 R1): a round is opened only on one of them, on a core installed for
    // it, and its run length is that core's.
    this.plugins = hostedPlugins(plugins);
    // Read once, and made on the first ask if the file has none. A node that
    // could not sign would have to answer a checkpoint with something other
    // than a receipt, and there is no such answer.
    this.identity = nodeIdentity(db);
    // the moves of rows made ACCEPTED on a history txid before #1249, put right once at open (kanban #1275)
    try { const fixed = this.repairAcceptedMoves(); if (fixed) console.log(`#1275 [settlement] ${fixed} ACCEPTED row(s) had another txid's moves: rewritten from the history`); } catch { /* a store without those tables */ }
  }

  /**
   * WHAT THE CENSUS ASSIGNED FOR THIS ROUND, written once by whoever derived it.
   *
   * The keys are the census's, not a list off the contract: `contract.nodes`
   * is what a round's author wrote down, and letter 26's ruling is that the
   * assigned set is the only list that counts. Kept here so `takeReceipt` and
   * the verdict read the same answer instead of each deciding for itself.
   */
  recordSignerNodes(roundIdBytes, keys) {
    if (!Array.isArray(keys) || !keys.length)
      throw new Error('a round is assigned the keys the census gave, not none');
    const put = this.db.prepare('INSERT OR IGNORE INTO signer_nodes (round_id, pubkey) VALUES (?, ?)');
    for (const k of keys) {
      if (!(k instanceof Uint8Array) || k.length !== 32)
        throw new Error('a signer node is a 32-byte key');
      put.run(roundIdBytes, k);
    }
    return keys.length;
  }

  /**
   * A V2 ROUND'S SEATS, WRITTEN IN BY THIS SEAT (2026.0.2RULED 2026-10-13: "Seats and the page work out
   * who serves from the census and the beacon ... Thresholds count the 7 seated nodes"). The contract names no draw; this
   * seat's own answer - the draw's first seats at the beacon, the certified seated set once the seating stands - goes into
   * its stored contract's `nodes` and into the signer nodes, so every count that reads them counts those seats. The round's
   * id does not move: a v2 id hashes the contract without `nodes`. A v1 round is never rewritten. Answers whether it changed.
   */
  seatDrawFree(roundIdBytes, keys) {
    const row = this.get(roundIdBytes);
    if (!row) return false;
    const c = decodeRoundContract(new Uint8Array(row.contract));
    if (!namesNoDraw(c)) return false;
    const want = [...keys].map((k) => toHex(k)).sort();
    const had = [...(c.nodes || [])].map((k) => toHex(k)).sort();
    const recorded = this.signerNodes(roundIdBytes).map((k) => toHex(k)).sort();
    if (want.join() === had.join() && want.join() === recorded.join()) return false;
    const bytes = encodeRoundContract({ ...c, nodes: keys });
    // ONE TRANSACTION FOR THE WRITE-IN (kanban #786, measured 2026-10-30 03:2xZ on second-host seat 3 over 60 s: 71 write-ins a minute, each an
    // UPDATE, a DELETE and ~6 INSERTs - 8 commits writing the same table and index pages into the WAL 8 times): one commit, unless the
    // caller already holds a transaction
    const own = !this.db.isTransaction;
    if (own) this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE rounds SET contract = ? WHERE round_id = ?').run(bytes, roundIdBytes);
      this.db.prepare('DELETE FROM signer_nodes WHERE round_id = ?').run(roundIdBytes);
      this.recordSignerNodes(roundIdBytes, keys);
      if (own) this.db.exec('COMMIT');
    } catch (e) { if (own) { try { this.db.exec('ROLLBACK'); } catch { /* none open */ } } throw e; }
    this.contracts.delete(this.hexOf(roundIdBytes));
    this.openSeq++;
    return true;
  }

  /** The assigned keys, or an empty list if this node was never assigned that round. */
  signerNodes(roundIdBytes) {
    return this.db.prepare('SELECT pubkey FROM signer_nodes WHERE round_id = ? ORDER BY pubkey')
      .all(roundIdBytes).map((r) => new Uint8Array(r.pubkey));
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
      encodeCheckpointReceipt(r), schnorr.sign(receiptId(r), this.identity.secret));
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
  /**
   * THIS VERY RECEIPT, BYTE FOR BYTE, ALREADY HELD (kanban #1569): the /play door asks before it takes one, so a public
   * receipt sent again and again starts no new replay - only a receipt that adds something can complete a run.
   */
  holdsReceipt(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length !== SIGNED_RECEIPT_BYTES) return false;
    let r;
    try { r = decodeCheckpointReceipt(splitSignedReceipt(bytes).body); } catch { return false; }
    const row = this.db.prepare('SELECT bytes FROM receipts WHERE checkpoint_id = ? AND node_pubkey = ?').get(r.checkpointId, r.nodePubkey);
    return !!row && Buffer.from(row.bytes).equals(Buffer.from(bytes));
  }

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
      if (!verifyNode(signature, receiptId(r), r.nodePubkey))
        throw new Error(`the receipt from ${toHex(r.nodePubkey)} does not verify`);
      this.db.prepare(
        'INSERT OR IGNORE INTO foreign_receipts '
        + '(checkpoint_id, node_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?)')
        .run(r.checkpointId, r.nodePubkey, bytes, this.now());
      // AND NOT FOREVER, NOT WITHOUT BOUND (kanban #1274, audit 4 #1257 outsider-2): the receipt's key is any key that signs it, and its checkpoint
      // id any 32 bytes, so a /play client wrote a row per frame for as long as it liked - never pruned, every row served at GET /foreign-receipts.
      // At most FOREIGN_RECEIPTS_KEPT are kept, none older than a day; the oldest go first (measured live: 224 rows on seat A1)
      this.db.prepare('DELETE FROM foreign_receipts WHERE seen_ms < ?').run(Number(this.now()) - FOREIGN_RECEIPTS_MAX_AGE_MS);
      const over = this.db.prepare('SELECT COUNT(*) AS n FROM foreign_receipts').get().n - FOREIGN_RECEIPTS_KEPT;
      if (over > 0) this.db.prepare('DELETE FROM foreign_receipts WHERE rowid IN (SELECT rowid FROM foreign_receipts ORDER BY seen_ms LIMIT ?)').run(over);
      throw new Error('a receipt for a mark this node has not got');
    }

    // THE ASSIGNED KEYS, NOT THE CONTRACT'S LIST.
    //
    // `contract.nodes` is what a round's author wrote down; the committee is
    // what THE CENSUS ASSIGNED at `census_height` (26's ruling). A key on the
    // contract that the chain did not assign is a stranger, and a node that
    // was never assigned this round has no committee to check against - so it
    // refuses rather than falling back to the author's list, which is the back
    // door this replaces.
    const roundId = new Uint8Array(mark.round_id);
    const committee = this.signerNodes(roundId);
    if (!committee.length)
      throw new Error('this node has not been assigned that round, so it knows no committee for it');
    if (!committee.some((n) => same(n, r.nodePubkey)))
      throw new Error(
        `${toHex(r.nodePubkey)} is not on this round's committee`);

    // THE SAME RECEIPT AGAIN IS NOT VERIFIED AGAIN (2026-10-02, the join's 2-3 s: "Cut whatever is between the click and
    // the loaded round"): a close retried for a run held short of final re-took every peer's receipts each time, and each
    // signature verified on the loop - 0.8-1.1 s held at a time on testnet4 seats (close take receipts), every PLAY behind it
    // waiting. Byte for byte the one this node verified and stored, it is answered as stored; any other bytes for the same
    // mark and node go the whole way, so a second, different receipt is still checked and caught.
    const already = this.db.prepare('SELECT bytes FROM receipts WHERE checkpoint_id = ? AND node_pubkey = ?').get(r.checkpointId, r.nodePubkey);
    if (already && Buffer.from(already.bytes).equals(Buffer.from(bytes))) return 'held';

    let ok = false;
    ok = verifyNode(signature, receiptId(r), r.nodePubkey);
    if (!ok) throw new Error(`the receipt from ${toHex(r.nodePubkey)} does not verify`);

    const held = this.db.prepare(
      'SELECT bytes FROM receipts WHERE checkpoint_id = ? AND node_pubkey = ?')
      .get(r.checkpointId, r.nodePubkey);
    if (held) {
      // WHAT WAS SIGNED, not the signature over it. BIP-340 is randomised, so
      // one node signing one receipt twice produces two different signatures -
      // and comparing the signed BYTES called that "receipted differently",
      // which is an equivocation charge against a node that said the same
      // thing twice. Equivocation is two different BODIES; two signatures over
      // one body are two ways of saying it.
      const heldBody = splitSignedReceipt(new Uint8Array(held.bytes)).body;
      if (same(heldBody, body)) return 'held';
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
  /** Does the store hold this round (by id)? A read of one key - no contract decoded. */
  has(roundIdBytes) {
    if (!this.hasStmt) this.hasStmt = this.db.prepare('SELECT 1 FROM rounds WHERE round_id = ? LIMIT 1');
    return Boolean(this.hasStmt.get(roundIdBytes));
  }

  open(contract) {
    // A ROUND NOBODY CAN JOIN IS NOT A ROUND. 5A.5: entry opens when the
    // committee forms, and `start_time >= committee_time + min_entry_window`
    // is the time anybody has to use it. A contract that leaves none is
    // refused here rather than stored and discovered later by a player whose
    // entry can never be built.
    const windows = roundWindowsAreValid(contract);
    if (!windows.ok) throw new Error(windows.why);

    // AND A ROUND THAT SAYS A RUN IS SOME OTHER LENGTH IS NOT A SHORTER ROUND.
    // The simulator ends every run at its own BLOCK_TICKS whatever a contract
    // claims, so a contract naming a different number is a second clock: this
    // node would bound batches with one number while the run really ended at
    // another. Measured before this existed: 9000, 4500 and 1 were all
    // accepted here.
    // THE ROUND'S OWN CORE AND CONFIG say how long a run is (M3 R1 R3), not the truck's rules.
    const runs = pluginForRound(contract, this.plugins);
    if (!runs.ok) throw new Error(runs.why);
    // THE ROUND'S RUN LENGTH ON THE CORE IT NAMES (the 82/90 fork): any the core takes - the old core only its own. An
    // attested round (§0A.7a) has no core and no run, so no length to fit.
    if (!runs.attested && !runs.headToHead) {
      const runLength = runLengthFits(runs.core, runs.config, contract.blockTicks);
      if (!runLength.ok) throw new Error(runLength.why);
    }
    // A HEAD-TO-HEAD ROUND HAS NO RUN: its end is its reveal deadline, which may lie no further from its entry
    // close than its game's reveal window
    // AND ITS OBJECTION WINDOW IS ITS GAME'S (§13A, RULED 2026-11-10, kanban #1398): a replayed game exactly 600 s; a head-to-head game 60 s
    // (5 s on a regtest) or 600 s
    { const regtest = contract.networkId instanceof Uint8Array && contract.networkId.length === NETWORK_ID_REGTEST.length && contract.networkId.every((b, i) => b === NETWORK_ID_REGTEST[i]);
      const fits = objectionWindowFits(contract.objectionWindowMs, { headToHead: !!runs.headToHead, regtest });
      if (!fits.ok) throw new Error(fits.why); }
    if (runs.headToHead) {
      const span = BigInt(roundEndMs(contract)) - contract.entryCloseMs;
      if (span < H2H_REVEAL_MIN_MS || span > runs.plugin.manifest.revealWindowMs)
        throw new Error(`that round gives its reveals ${span} ms after entry close; game "${runs.plugin.manifest.gameName}" allows ${H2H_REVEAL_MIN_MS} to ${runs.plugin.manifest.revealWindowMs}`);
    }

    // AND IT MAY NOT SEAT MORE SIGNER NODES THAN IT HAS SLOTS (§22A: "Not seven census slots when the round
    // is 2-of-2"). A fee lock is sized for the same seats the settlement pays, so a contract that names seven
    // seats on a two-slot round mints a lock divided seven ways and pays seats that never sat. Measured before
    // this line: `feeLockPays` read `contract.nodes` alone and answered `pays true, signerNodes 7` for exactly
    // that contract. Refused here, with the round, rather than found later in the settlement.
    const seats = sittingSeatsFitTheSlots(contract);
    if (!seats.ok) throw new Error(seats.why);

    const bytes = encodeRoundContract(contract);
    const id = roundId(contract);
    const added = this.db.prepare('INSERT OR IGNORE INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, ?, ?)')
      .run(id, bytes, OPEN, this.now());
    if (added.changes) { this.openSeq++; this.openList.askedMs = 0; }   // this store's own write: the next openHeld asks at once
    return id;
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM rounds WHERE round_id = ?').get(id);
    if (!row) return null;
    if (row.state === OPEN) return this.contractOf(id, row) ? row : null;
    return parses(row.contract) ? row : null;
  }

  /** A round id's hex, kept for the open list's id objects. */
  hexOf(id) {
    let h = this.hexOfId.get(id);
    if (h === undefined) { h = toHex(id); if (typeof id === 'object') this.hexOfId.set(id, h); }
    return h;
  }

  /**
   * A HELD ROUND'S CONTRACT, DECODED (kanban #742): once per open round, then the kept object; a closed round's is decoded on each
   * ask (nothing of it is kept). null for no such round, or a contract this network cannot parse. `row`: the round's row when the
   * caller already read it. The object is shared - read it, never change it.
   */
  contractOf(id, row = undefined) {
    const k = id instanceof Uint8Array ? this.hexOf(id) : null;
    if (k !== null && this.contracts.has(k)) return this.contracts.get(k);
    const r = row === undefined ? this.db.prepare('SELECT contract, state FROM rounds WHERE round_id = ?').get(id) : row;
    if (!r) return null;
    let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { c = null; }
    if (k !== null && r.state === OPEN) this.contracts.set(k, c && this.interner.share(c));
    return c;
  }

  /** Lets go of what is kept of a round (deleted from the store). */
  forget(id) { if (id instanceof Uint8Array || typeof id === 'string') this.contracts.delete(typeof id === 'string' ? id : this.hexOf(id)); }

  /**
   * THE OPEN ROUNDS' IDS, KEPT (kanban #742): read again only once their count or newest row moved; the ids are the same objects
   * from one read to the next while their rounds stay open. What is kept of rounds no longer open is let go on each read.
   */
  openHeld() {
    // ASKED AT MOST EVERY OPEN_HELD_MS (kanban #786, a seat's 30 s profile 2026-10-29 01:1xZ: openHeld 5 % of the CPU, its COUNT over the
    // open rows run by every sweep and every listing): a round opened or closed in the last quarter second is seen on the next ask
    const nowMs = Date.now();
    if (this.openList.key !== null && nowMs - (this.openList.askedMs || 0) < Round.OPEN_HELD_MS) return this.openList.ids;
    const q = this.db.prepare('SELECT count(*) AS n, max(rowid) AS m FROM rounds WHERE state = ?').get(OPEN);
    const key = `${q.n}:${q.m}`;
    if (this.openList.key === key) { this.openList.askedMs = nowMs; return this.openList.ids; }
    // ONLY ROUNDS ADDED, NONE CLOSED (the series writers open rounds all the time): the new rows appended, not the whole list read again
    // AND THE ROUNDS THIS STORE CLOSED, TAKEN OUT (kanban #791, allocation sampled 2026-10-30 02:3xZ on test host seat 6: openHeld 46 MB
    // in 30 s - an RPS grid closes a round every few seconds, and each close made the next ask read all ~24,000 open rows again): what
    // close() closed is dropped from the kept list. The count check stands: a round closed or deleted any other way reads the whole list.
    if (this.openList.key !== null && Number.isInteger(this.openList.m) && q.m >= this.openList.m) {
      const fresh = q.m > this.openList.m
        ? this.db.prepare('SELECT lower(hex(round_id)) AS h, opened_ms AS o FROM rounds WHERE state = ? AND rowid > ? ORDER BY opened_ms').all(OPEN, this.openList.m) : [];
      const gone = this.closedSinceList;
      const kept = gone.size ? this.openList.ids.filter((id) => !gone.has(this.hexOf(id))) : this.openList.ids;
      if (kept.length + fresh.length === q.n && (!fresh.length || fresh[0].o >= (this.openList.lastOpenedMs ?? -Infinity))) {
        const ids = kept === this.openList.ids ? kept.slice() : kept;
        for (const r of fresh) { const id = fromHex(r.h); this.hexOfId.set(id, r.h); ids.push(id); }
        this.closedSinceList = new Set();
        this.openList = { key, ids, m: q.m, askedMs: nowMs, lastOpenedMs: fresh.length ? fresh[fresh.length - 1].o : this.openList.lastOpenedMs };
        return ids;
      }
    }
    this.closedSinceList = new Set();
    const had = new Map();
    for (const id of this.openList.ids) had.set(this.hexOf(id), id);
    const ids = [];
    let lastOpenedMs = null;
    for (const r of this.db.prepare('SELECT lower(hex(round_id)) AS h, opened_ms AS o FROM rounds WHERE state = ? ORDER BY opened_ms').all(OPEN)) {
      let id = had.get(r.h);
      if (!id) { id = fromHex(r.h); this.hexOfId.set(id, r.h); }
      ids.push(id); lastOpenedMs = r.o;
    }
    const open = new Set(ids.map((id) => this.hexOf(id)));
    for (const k of this.contracts.keys()) if (!open.has(k)) this.contracts.delete(k);
    this.openList = { key, ids, m: q.m, askedMs: nowMs, lastOpenedMs };
    return ids;
  }

  /**
   * THE ROUNDS THIS STORE CLOSED SINCE `seq` (a closeSeq read earlier), as a Set of hex - or null when more were closed since than the
   * log keeps (kanban #791: a listing's kept scan drops them instead of being built again on every close).
   */
  closedSince(seq) {
    const n = this.closeSeq - seq;
    if (n <= 0) return new Set();
    if (n > this.closedLog.length) return null;
    return new Set(this.closedLog.slice(this.closedLog.length - n));
  }

  /** How many rounds the store held open at the last read of the open list (what per-round caches are bounded by). */
  get openCount() { return this.openList.ids.length; }

  /**
   * Takes an entry. Refused after the round is closed, and refused twice.
   * `accepted`: AN ENTRY THE ROUND HAS ACCEPTED (§17, kanban #1071), brought from a peer by entry-relay.js once the threshold of seats signed results naming
   * it. What only a door decides goes - the round being open, entry close, a table this seat thinks is full - and everything about the entry itself stays:
   * the stake, the fee, the handout, the commitment, every item's owner signature.
   */
  enter(contract, { accepted = false } = {}) {
    const round = this.get(contract.roundId);
    if (!round) throw new Error('no such round');
    if (round.state !== OPEN && !accepted) throw new Error('the round is closed');

    // AND NOT BEFORE THE COMMITTEE EXISTS. `entry_open_time == committee_time`
    // is 5A.5's own equality, and it is not a preference: 23.1 encrypts the
    // preimage shares TO the settlement committee, so an entry built earlier
    // would be encrypted to nobody. The lobby shows "committee: pending" until
    // then and offers no entry button; this is the same rule at the door,
    // where it cannot be skipped by a client that does not draw a lobby.
    const asks = decodeRoundContract(new Uint8Array(round.contract));
    // AN ENTRY NAMING THE WEBSITE THAT BROUGHT IT ONLY ON A ROUND OF 2026.0.9 OR LATER: its seats are then only
    // nodes that pay the website its 20% of the nodes' fee; on an older round the key would be a promise nobody keeps
    if (contract.frontendPk && !(asks.protocolVersion >= FRONTEND_FEE_VERSION))
      throw new Error(`that entry names the website that brought it, and a round pays a website from protocol version ${FRONTEND_FEE_VERSION} on; this round runs ${asks.protocolVersion}`);
    // THE ITEMS AN ENTRY PLAYS WITH (protocol 10): only on a round of version 10 or later, each an item the round's game
    // sells, bought by this entry's player - a purchase this seat keeps (POST /item-purchase) of this game's developer and name, whose
    // buyer signed for this entry (the owner's key is the same in every round, the entry's is fresh per round, so the
    // proof is the buyer's BIP340 signature over contracts.js entryItemDigest(round, entry key, purchase))
    if (contract.items) {
      if (!(asks.protocolVersion >= ITEMS_VERSION))
        throw new Error(`that entry plays with items, and a round takes items from protocol version ${ITEMS_VERSION} on; this round runs ${asks.protocolVersion}`);
      const g = pluginForRound(asks, this.plugins);
      if (!g.ok) throw new Error(g.why);
      const m = g.plugin.manifest;
      for (const it of contract.items) {
        if (!itemOf(m, it.itemId)) throw new Error(`game "${m.gameName}" sells no item "${it.itemId}"`);
        const kept = itemPurchaseKept(this.db, toHex(it.purchaseId));
        if (!kept || kept.itemId !== it.itemId || kept.gameName !== m.gameName || kept.gameDev !== toHex(m.gameDevPubkey))
          throw new Error(`purchase ${toHex(it.purchaseId).slice(0, 16)} of "${it.itemId}" is not one this seat keeps for this game: hand it to POST /item-purchase first`);
        if (!verifyNode(it.ownerSig, entryItemDigest({ roundId: contract.roundId, playerPubkey: contract.playerPubkey, purchaseId: it.purchaseId }), fromHex(kept.player)))
          throw new Error(`the item "${it.itemId}" is not signed for this entry by its owner ${kept.player.slice(0, 16)} (entryItemDigest)`);
      }
    }
    // AND NOT A ROUND WHOSE OBJECTION WINDOW IS NOT 600 000 ms (§13A, WINDOW-10-SPEC): one opened before the rule is held,
    // never entered.
    const windows = roundWindowsAreValid(asks);
    if (!windows.ok && /objection window/.test(windows.why)) throw new Error(windows.why);
    const opensAt = asks.committeeTimeMs;
    const now = BigInt(this.now());
    if (now < opensAt && !accepted)
      throw new Error(
        `that round's committee forms at ${opensAt} and it is ${now}: entry opens then`);
    // AND NOT WHEN 45 s OR LESS OF THE ROUND'S RUN REMAIN (2026-10-04 14:30: "Join closes when 45 s
    // remain. A player who would have 45 s or less left must not enter and waits for the next round"). Every run of the
    // round ends at its start + 82 s (lastTickOfRun), so an entry new to this node is refused from start + 37 s on
    // (LATE_JOIN_LAST_ENTRY_MS): at that instant 45 s remain. This replaces the 15 s grace after entry_close (start + 45 s,
    // which let an entry in up to start + 60 s with 22 s left); the series bytes still say start + 45 s, the door is
    // stricter. The same entry posted again - a retry, a reload's resend, a peer's copy - is still taken.
    // Only a series round whose entry closes after its start (a late-join series): a round closing entry at its start keeps the
    // old door, where a join held to the start may land its entry a few seconds after it.
    // A late-join series closes entry exactly LATE_JOIN_MS after its start (series.js); a grid series names its
    // own window and keeps the old door, as its rounds had it when each was published alone.
    const lateJoin = asks.seriesId instanceof Uint8Array && typeof asks.entryCloseMs === 'bigint' && asks.entryCloseMs - asks.startTimeMs === LATE_JOIN_MS;
    if (lateJoin && !accepted && !this.db.prepare('SELECT 1 FROM entries WHERE entry_id = ?').get(Buffer.from(entryId(contract)))) {
      const lastEntry = asks.startTimeMs + LATE_JOIN_LAST_ENTRY_MS;
      if (now >= lastEntry)
        throw new Error(`that round's entry closed at ${lastEntry} (start + ${LATE_JOIN_LAST_ENTRY_MS} ms: 45 s or less of its run left) and it is ${now}`);
      // AND A LATE ENTRY JOINS WHERE THE ROUND IS ("A later join does not extend the round. The late joiner has
      // less time"): its join tick is no earlier than the round's ticks already gone, less LATE_ENTRY_TICK_SLACK_MS for
      // the device's clock and the post; its run is then blockTicks - joinTick and ends with the round's.
      if (now > asks.startTimeMs) {
        const gone = now - asks.startTimeMs > LATE_ENTRY_TICK_SLACK_MS ? ticksForMs(now - asks.startTimeMs - LATE_ENTRY_TICK_SLACK_MS).ticks : 0n;
        if (BigInt(contract.joinTick) < gone)
          throw new Error(`that entry joins at tick ${contract.joinTick}, and ${now - asks.startTimeMs} ms of the round have gone: `
            + `a late entry joins at tick ${gone} or later, and its run ends with the round's`);
      }
    }

    // NO ENTRY NEW TO THIS SEAT AFTER ITS ROUND'S ENTRY CLOSE, FOR EVERY GAME (kanban #1216, audit 3 #1210 CONSENSUS-1): a replayed game's grid round
    // took an entry new to a seat until the round closed, so a player could post an entry and its lock to 4 seats only, play there, and post it to a
    // 5th once the run had won (paid), or not (VOID: the stake back) - a free option in every paid round. ENTRY_CLOSE_GRACE_MS lets a join held to
    // the start land (measured over 7 days at the 7 fed A seats: of 7,608 paid entries the latest reached its seat 5 s after the entry close).
    // A late-join series has its own door above; an entry the round accepted (entry-relay) and the same entry posted again are still taken.
    const grace = this.entryCloseGraceMs === undefined ? null : this.entryCloseGraceMs;   // set by serve (main.js gives every seat ENTRY_CLOSE_GRACE_MS)
    if (grace !== null && !lateJoin && !accepted && now > asks.entryCloseMs + grace && !this.db.prepare('SELECT 1 FROM entries WHERE entry_id = ?').get(Buffer.from(entryId(contract))))
      throw new Error(`that round's entry closed at ${asks.entryCloseMs} (and ${grace} ms for a join on its way) and it is ${now}: an entry new to this seat is not taken`);

    // AND NO WORLD OF THE PLAYER'S OWN ON A SHARED-WORLD ROUND (2026-10-04: "the player chooses nothing about
    // the world"): under a config that makes one world per round (config v4) the entry's world secret must be 32 zero
    // bytes - the field is kept so every stored entry keeps its id, and a secret there could only be a player picking.
    // which configs share one world is the round's game's to say
    { const game = pluginForRound(asks, this.plugins);
      const fits = worldSecretFits(asks, contract.worldSecret, game.ok ? [...game.plugin.sharedWorld] : []); if (!fits.ok) throw new Error(fits.why);
      // THE PICK (§0A.7a): an entry into an attested round backs one of its game's outcomes, by index; an entry
      // into a replayed round backs none - its result is its run
      const picked = contract.pick !== undefined && contract.pick !== null;
      if (game.ok && game.attested) {
        // A ROUND OF A TEMPLATE (feature 5) is picked among ITS OWN outcomes (contracts.js `event`), not the template's
        const outcomes = marketOfRound(game.plugin.manifest, asks).outcomes;
        if (!picked) throw new Error(`an entry into a round of attested game "${game.plugin.manifest.gameName}" backs one of its outcomes: it carries no pick`);
        if (contract.pick >= outcomes.length)
          throw new Error(`that entry picks outcome ${contract.pick}, out of range: game "${game.plugin.manifest.gameName}" has ${outcomes.length} outcomes (0 to ${outcomes.length - 1})`);
        // AND ONLY UNTIL THE ROUND'S ENTRY CLOSE (§0A.7a slice 2): the outcome may be taken from then on, so no pick after it
        if (typeof asks.entryCloseMs === 'bigint' && BigInt(this.now()) >= asks.entryCloseMs)
          throw new Error(`that round's entries closed at ${new Date(Number(asks.entryCloseMs)).toISOString()}: an attested round takes no pick after its entry close`);
        // AND NOT BEFORE ITS WINDOW OPENS (2026-10-11: "Der prediction market läuft immer z.B. zwischen 19:45 und 20:00.
        // Man darf davor und danach nicht am Markt teilnehmen und mit Wetten. Das ist die allgemeine Regel für prediction
        // markets"): a market on its game's period (attested.js marketWindowOf) takes a pick only from entry_close - period
        { const w = marketWindowOf(asks, game.plugin.manifest);
          if (w.ok && w.window && BigInt(this.now()) < w.window.startMs)
            throw new Error(`that market opens at ${new Date(Number(w.window.startMs)).toISOString()} and runs to ${new Date(Number(w.window.endMs)).toISOString()}: it takes no pick before its window`); }
        // AND NOT ONCE THE OUTCOME IS KNOWN HERE: a pick made after its attestation came is not a pick, it is a copy
        // (and a market on a game's held source result, feature 6 - its entries close before its source starts, so
        // this is the second guard)
        if (this.outcomeAttestations(contract.roundId).length || this.gameOutcomes(contract.roundId).length)
          throw new Error('that round\'s outcome is already attested at this signer node: it takes no pick after it');
        // A MARKET ORDER (comment 1127): a pick bought at a limit price on a two-outcome market - a whole cent,
        // at least 5 shares at its limit out of its stake less its fee, an expiry not past. A round is a book or a pool: it
        // takes orders or plain picks, never both, so its settlement is one or the other.
        const order = contract.limitPrice !== undefined && contract.limitPrice !== null;
        // ONLY ENTRIES BACKED BY A LOCK DECIDE IT (kanban #1270, audit 4 #1257 PLAYER-4): the door takes an entry before any lock is verified, so one
        // free plain pick with no lock behind it made a seat refuse every order of an Up/Down round - anyone could stop a market trading at no cost
        // (and a lockless order a pool's picks). An entry counts here once this seat has seen its stake
        // AND THE KIND IS THE CERTIFIED BATCHES' (§0A.7b, kanban #1411/#1417): a plain pick is refused once a certified batch holds an order here; an
        // order is taken while no batch is certified - a round that ends with none is a pool, and its orders' stakes come back
        if (!order && typeof this.isBookRound === 'function' && this.isBookRound(contract.roundId))
          throw new Error('that round is an order book: it takes orders, not a plain pick');
        if (order) {
          // A SCALAR MARKET TRADES ITS TWO SIDES TOO (§0A.7e): a share is worth its side's part of a sat at the value
          // (book-ledger.js bookSettlement `scalar`); a round is still a book or a pool, never both
          if (outcomes.length !== 2) throw new Error(`the order book trades a two-outcome market, and game "${game.plugin.manifest.gameName}" has ${outcomes.length}`);
          const price = BigInt(contract.limitPrice);
          if (price < 1n || price >= PRICE_SCALE || price % TICK !== 0n)
            throw new Error(`a limit price is a whole cent below 1: ${contract.limitPrice} of ${PRICE_SCALE} is not`);
          const net = contract.stakeMsat - contract.feeMsat - contract.donationMsat;
          const shares = (net * PRICE_SCALE) / price / SHARE_MSAT;
          if (shares < MIN_SHARES) throw new Error(`an order buys at least ${MIN_SHARES} shares at its limit, and that one buys ${shares}`);
          if (contract.orderExpiryMs && contract.orderExpiryMs !== 0n && contract.orderExpiryMs <= BigInt(this.now()))
            throw new Error('that order\'s expiry has passed');
        }
      } else if (picked) throw new Error('that entry carries a pick, and its round is a replayed game\'s: its result is its run, not an outcome');
      // ONE ENTRY PER SESSION KEY, IN EVERY GAME (kanban #1479, feedback #007 by Hexbox Tools 2026-11-11 - one session key stood three times in a Rock Paper
      // Scissors round, rock, paper and scissors, and revealed only the winner; Daniel 2026-11-11: "Auch bei allen anderen Spielen"): the same entry again - its
      // id - passes, as a resend after a reload does; another entry of the same session key in this round is refused. A client makes a new session key for every
      // entry (measured on seat 1: 7,326 entries of all games, no session key twice in a round), so only a forged second entry meets this. Entries a round
      // accepted and relayed are not touched.
      // BUT A SESSION KEY IS PUBLIC, AND AN ENTRY CARRIES NO SIGNATURE OF IT (kanban #1597, a bypass of #1479): GET /entry hands any entry's key to anyone,
      // so a copier who saw an honest entry at one seat posted an entry of his own naming the same key to a seat the honest one had not reached yet, and that
      // seat then refused the honest entry and every resend for good - fewer than the threshold of seats held it, and it was no member (§17). An earlier entry
      // of the key now holds it here only when it is more than the key's bare name: in a paying round only one backed by a lock at this seat (its stake seen
      // or its stake lock verified - what seats it, seatedEntriesOf), and in a free round only one that names the same player key - the same player entering
      // again, which is what #1479 saw. A lockless entry of another player that names the key shuts no one out; it can never play (every batch, mark,
      // reveal and address must be signed by the session key).
      if (!accepted) { const mine = entryId(contract);
        const holders = asks.stakeMsat === 0n
          ? this.entriesOf(contract.roundId).filter((x) => same(x.entry.playerPubkey, contract.playerPubkey))
          : this.seatedEntriesOf(contract.roundId, asks.stakeMsat);
        if (holders.some((x) => same(x.entry.sessionPubkey, contract.sessionPubkey) && !same(x.entryId, mine)))
          throw new Error('that session key already has an entry in this round: one entry per session key'); }
      // THE HIDDEN MOVE: an entry into a head-to-head round names its commitment, before entry close, and the
      // round seats no more than its game's players; an entry into any other round names none
      const hidden = contract.commit !== undefined && contract.commit !== null;
      if (game.ok && game.headToHead) {
        const m = game.plugin.manifest;
        if (!hidden) throw new Error(`an entry into a round of head-to-head game "${m.gameName}" hides its move: it carries no commitment`);
        if (!accepted && typeof asks.entryCloseMs === 'bigint' && BigInt(this.now()) >= asks.entryCloseMs)
          throw new Error(`that round's entries closed at ${new Date(Number(asks.entryCloseMs)).toISOString()}: a head-to-head round takes no entry after it - the moves are being revealed`);
        // ONLY ENTRIES BACKED BY A LOCK TAKE A SEAT OF A PAYING ROUND (kanban #1437, audit 8 R3); which ones, the same at every seat: seatedEntriesOf (kanban #1588)
        const me = entryId(contract);   // seats counted by entry id (kanban #1479)
        const seated = this.seatedEntriesOf(contract.roundId, asks.stakeMsat).filter((x) => !same(x.entryId, me)).length;
        if (seated >= m.players && !accepted) throw new Error(`that round already seats game "${m.gameName}"'s ${m.players} players`);
      } else if (hidden) throw new Error('that entry hides a move, and its round is not a head-to-head game\'s');
    }

    // AND IT PAYS WHAT THIS ROUND ASKS - THE STAKE, AND THE FEE AND THE
    // DONATION OUT OF IT (22A: inclusive, never on top).
    //
    // Both against the CONTRACT and never against the entry's own story, which
    // is the whole of why this is two checks and not one. `feeMatchesEntry` is
    // self-referential: it compares the fee to the entry's OWN stake, and the
    // entry names both - so an entry claiming `stakeMsat: 0, feeMsat: 0`
    // satisfies it perfectly. Measured at the door before this existed: six of
    // six wrong fees taken, and four of four self-named stakes taken, every one
    // of the four "standing" under the rule.
    //
    // A ZERO STAKE IS NOT A SMALL ENTRY, IT IS A FREE ROUND PAID FROM OTHER
    // PLAYERS' MONEY. `custody.hold` issues the hold invoice for the entry's
    // net stake, so that player pays nothing; `winnings` pays `amountMsat -
    // net`, so their whole table row comes out of the pool.
    //
    // THE DONATION IS CHECKED HERE TOO. The player chooses it and nobody may
    // rewrite it (22A), but it comes out of the same commitment as the fee, so
    // an entry whose fee and donation come to more than the stake does not
    // stand. Measured before 6e: a 200000 msat donation on a 100000 stake was
    // taken, because nothing at the door looked at the donation.
    // A door that checked only the fee would look checked and still pass it.
    //
    // THE RATE IS NOT A NUMBER THIS FILE KNOWS. `entryFeeMsat` is 27A.7's
    // `node_fee_bps`, and `genesis.js` writes that into the genesis parameters
    // - so a round naming a config has already committed to the rate, and a
    // second copy here would be a second place for it to drift.
    // AN ORDER IN A PAID MARKET ROUND STAKES ITS OWN AMOUNT (order-book.js MIN_ORDER_MSAT .. MAX_ORDER_MSAT); every
    // other entry stakes exactly the round's
    const ownAmount = contract.limitPrice !== undefined && contract.limitPrice !== null && asks.stakeMsat > 0n
      && (() => { const g = pluginForRound(asks, this.plugins); return g.ok && !!g.attested; })();
    if (ownAmount) {
      if (typeof contract.stakeMsat !== 'bigint' || contract.stakeMsat < MIN_ORDER_MSAT || contract.stakeMsat > MAX_ORDER_MSAT)
        throw new Error(`an order stakes ${MIN_ORDER_MSAT} to ${MAX_ORDER_MSAT} msat, and that one names ${contract.stakeMsat}`);
    } else if (contract.stakeMsat !== asks.stakeMsat)
      throw new Error(
        `that round asks a stake of ${asks.stakeMsat} msat and that entry names `
        + `${contract.stakeMsat}`);
    // THE ROUND'S GAME'S RATE: a market's own fee from its manifest - 0.5 % by default - and a game's the
    // network's; and a market's donation no more than its manifest's rate (0.5 % by default)
    const feeGame = pluginForRound(asks, this.plugins);
    // A MARKET'S DONATION IS IN ITS FEE LOCK, DUE AT RESOLUTION (2026-10-09): its entry's fee is node fee + donation
    // (entryFeeBpsOf, 1 % by default) and its donation field 0
    // ON PROTOCOL 11 A GAME'S ENTRY PAYS THE RESERVES (§27A.9): the nodes' fee is the mandatory 4 %, and its donation
    // field carries the developers' 4 % and the reserves' 2 % exactly, with its reserve lock named
    const reserves = entryPaysReserves(asks, feeGame.ok ? feeGame.plugin.manifest : null);
    // FROM PROTOCOL 27 (kanban #1486) the developers' 4 % and the reserves' 2 % ride in the fee lock beside the nodes' 4 %: the fee is the
    // whole 10 %, the donation 0, and no donation or reserve output is named - a refused entry gets them back with its stake
    // AT THE SPLIT IN FORCE AT THE ROUND'S CENSUS HEIGHT (`this.feesFor`, server.js: the fee set GET /fees?height= serves and the page reads) -
    // the one the seats' settlement splits it by (settlement.js giftsFor); today's split where no fee book is read
    const gifts = entryGiftsInFee(asks, feeGame.ok ? feeGame.plugin.manifest : null);
    const giftSplit = gifts ? (() => { const set = typeof this.feesFor === 'function' ? this.feesFor(asks) : null; return set ? roundSplitBps(set) : ROUND_SPLIT_BPS; })() : null;
    if (gifts) {
      const g = giftsEntryExpected({ entry: { ...contract, stakeMsat: ownAmount ? contract.stakeMsat : asks.stakeMsat }, split: giftSplit });
      if (!g.ok) throw new Error(g.why);
    }
    const feeBps = gifts ? giftsFeeBps(giftSplit) : reserves ? RESERVES_NODE_FEE_BPS : feeGame.ok ? entryFeeBpsOf(feeGame.plugin.manifest) : NODE_FEE_BPS;
    if (reserves) {
      const split = roundSplit(ownAmount ? contract.stakeMsat : asks.stakeMsat);
      const owed = split.protocolDevsMsat + split.gameDevsMsat + split.reservesMsat;
      if (contract.donationMsat !== owed)
        throw new Error(`on protocol version ${asks.protocolVersion} an entry pays the developers' 4 % and the reserves' 2 %: ${owed} msat, not ${contract.donationMsat}`);
      if (!contract.reserveOutpoint) throw new Error(`on protocol version ${asks.protocolVersion} an entry names its reserve lock`);
    }
    const fee = feeMatchesEntry({
      stakeMsat: ownAmount ? contract.stakeMsat : asks.stakeMsat, feeMsat: contract.feeMsat, donationMsat: contract.donationMsat,
    }, { feeBps, donationInFee: gifts || (feeGame.ok && donationInFee(feeGame.plugin.manifest)) });
    if (!fee.ok) throw new Error(fee.why);
    const donationCap = feeGame.ok ? donationBpsOf(feeGame.plugin.manifest) : null;
    if (donationCap !== null && contract.donationMsat > (asks.stakeMsat * BigInt(donationCap)) / 10000n)
      throw new Error(`that entry donates ${contract.donationMsat} msat, and game "${feeGame.plugin.manifest.gameName}" takes a donation of at most ${donationCap / 100}% of its ${asks.stakeMsat} msat stake`);
    // AND THE SHARES IT NAMES MUST BE SHARES THIS NODE CHECKED.
    //
    // 23.1: `vss_shares_ref` points at the published shares. An entry that
    // names a handout this node never accepted is an entry whose stake this
    // node could not settle - and the whole of letter 29 is that a dealer who
    // splits with two polynomials is caught HERE, at the door, rather than at
    // reconstruction when there is nothing left to do about it.
    //
    // 32 zero bytes means the entry publishes no shares, which is every entry
    // in M2 - there is no stake behind the preimage yet. That is accepted, and
    // it is not the same bytes as an entry that forgot the field, because the
    // field is in the signed id either way.
    const ref = contract.vssSharesRef;
    if (ref && !ref.every((b) => b === 0)) {
      const held = this.handout(ref);
      if (!held)
        throw new Error('that entry names shares this node has not accepted: '
          + 'publish the handout first, and it is refused if it is not one polynomial');
      if (!held.roundId.every((b, i) => b === contract.roundId[i]))
        throw new Error('that handout was published for another round');
      // AND THE SHARES OPEN TO THE ENTRY'S OWN STAKE POINT (§23.1 step 2, F1).
      // The door checked that the shares are ONE polynomial; this checks it is
      // the right one. Without it a player deals consistent shares of Q != P,
      // loses, watches reconstruction fail, and takes the stake back.
      const same = stakePointIsTheHandouts(contract, decodeHandout(new Uint8Array(held.bytes)));
      if (!same.ok) throw new Error(same.why);
    }

    // Same as the round above: the id is the hash of the contract, so the same
    // entry sent twice is one player joining once.
    const id = entryId(contract);
    this.db.prepare('INSERT OR IGNORE INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)')
      .run(id, contract.roundId, encodeEntryContract(contract), this.now());
    return id;
  }

  /**
   * AN ENTRY A CERTIFIED BATCH NAMES, BROUGHT FROM ANOTHER SEAT (kanban #620: round 42835aaa never settled - two seats had not received
   * one order's entry, refused the certified batch that carried it, and rebuilt another settlement than the rest). Kept only when its
   * bytes hash to the id the batch names (the id is the hash of the contract) and it is of a round this seat holds, open or closed:
   * the seats that certified the batch checked it at its door. Answers the id, or throws why not.
   */
  importEntry(bytes, idHex) {
    const contract = decodeEntryContract(new Uint8Array(bytes));
    const id = entryId(contract);
    if (Buffer.from(id).toString('hex') !== String(idHex).toLowerCase()) throw new Error('those bytes are another entry than the one named');
    if (!this.get(contract.roundId)) throw new Error('no such round');
    this.db.prepare('INSERT OR IGNORE INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)')
      .run(id, contract.roundId, encodeEntryContract(contract), this.now());
    return id;
  }

  /**
   * Keeps a handout this node has ALREADY CHECKED.
   *
   * The check needs a group and this class carries no curve, exactly as the
   * protocol package does not - `server.js` brings one to the door. What is
   * kept here is the answer, and only a yes: a refused handout leaves nothing
   * behind for a second attempt to inherit.
   */
  rememberHandout({ id, roundId, bytes }) {
    this.db.prepare(
      'INSERT OR IGNORE INTO handouts (handout_id, round_id, bytes, accepted_ms) VALUES (?, ?, ?, ?)')
      .run(id, roundId, bytes, this.now());
    return id;
  }

  /** An accepted handout by its id, or nothing. */
  handout(id) {
    const row = this.db.prepare('SELECT round_id, bytes FROM handouts WHERE handout_id = ?')
      .get(Buffer.from(id));
    if (!row) return null;
    return { roundId: new Uint8Array(row.round_id), bytes: new Uint8Array(row.bytes) };
  }

  /**
   * A PLAYER'S BATCH, SIGNED (kanban #1503, feedback #012 by Hexbox Tools): the only door a batch from outside comes in
   * by. The signature is over the batch's id under the SESSION key of the entry it names - read off the Entry Contract
   * this node stores, never off the frame - and it is checked before anything else, so a batch for somebody else's entry
   * never reaches the chain rule (measured before: an anonymous socket stored 120 ticks and a load as the victim, the
   * victim's own next batch no longer followed the chain head and its mark was refused - FORFEIT). Then `batch` as ever,
   * on the bare batch's bytes: what is stored, chained and served is unchanged.
   */
  signedBatch(bytes) {
    const { body, batch: b, id, signature } = splitSignedBatch(bytes);
    if (!this.get(b.roundId)) throw new Error('no such round');
    const contract = this.entry(b.entryId);
    if (!contract) throw new Error('no such entry');
    const sessionPubkey = decodeEntryContract(contract).sessionPubkey;
    let ok = false;
    try { ok = ed25519.verify(signature, id, sessionPubkey); } catch { ok = false; }
    if (!ok) throw new Error('the batch\'s signature does not verify under the entry\'s session key');
    return this.batch(body);
  }

  /**
   * THE BATCHES A SIGNED MARK ENDORSES (kanban #1503): a first mark handed on by another seat (/first-mark) carries the
   * batches it commits to, bare - a seat stores no player signatures over them. They are taken only when the mark's
   * own signature verifies under its entry's session key and the batches are exactly that entry's chain from genesis
   * to the mark's inputChainHash: then the player signed them, through the mark. Anything else stores nothing.
   * Answers { ok, why } and stores the batches through `batch` when ok.
   */
  batchesEndorsedBy(markBytes, batchBytes) {
    let c; let signature;
    try { const s = splitSigned(markBytes); signature = s.signature; c = decodeCheckpoint(s.body); }
    catch (e) { return { ok: false, why: `that is not a signed mark: ${e.message}` }; }
    const contract = this.entry(c.entryId);
    if (!contract) return { ok: false, why: 'no such entry' };
    const e = decodeEntryContract(contract);
    if (!same(e.roundId, c.roundId)) return { ok: false, why: 'entry is not in this round' };
    let ok = false;
    try { ok = ed25519.verify(signature, checkpointId(c), e.sessionPubkey); } catch { ok = false; }
    if (!ok) return { ok: false, why: 'the mark\'s signature does not verify under the entry\'s session key' };
    if (!batchBytes.length) return { ok: true, taken: 0 };
    let prev = GENESIS;
    const bodies = [];
    for (const raw of batchBytes) {
      let b;
      try { b = decodeInputBatch(raw); } catch (x) { return { ok: false, why: `a batch will not decode: ${x.message}` }; }
      if (!same(b.entryId, c.entryId) || !same(b.roundId, c.roundId)) return { ok: false, why: 'a batch handed on with the mark is not the mark\'s entry\'s' };
      if (!same(b.previousHash, prev)) return { ok: false, why: 'the batches handed on with the mark are not one chain from its start' };
      prev = batchId(b);
      bodies.push(raw);
    }
    if (!same(prev, c.inputChainHash)) return { ok: false, why: 'the batches handed on with the mark do not end at its input chain hash' };
    let taken = 0;
    for (const raw of bodies) { try { this.batch(raw); taken++; } catch { /* held already, or refused: the mark says which */ } }
    return { ok: true, taken };
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
    // NO BATCH A TRANSCRIPT CANNOT FRAME (measured live 2026-10-11 on round 6843f9fb: a 97,309-byte batch
    // was taken by all seven seats and every close then failed "u16 out of range" - the run could never be replayed)
    if (bytes.length > TRANSCRIPT_BATCH_MAX_BYTES)
      throw new Error(`a batch is at most ${TRANSCRIPT_BATCH_MAX_BYTES} bytes - a transcript frames each with a u16 length - and that one is ${bytes.length}: send its ticks as several batches`);
    const b = decodeInputBatch(bytes);
    const round = this.get(b.roundId);
    if (!round) throw new Error('no such round');
    // AFTER THE CLOSE ONLY FOR A HELD-BACK FINAL MARK (ruled 2026-09-23): the batches that mark commits to - ticks
    // before its tick - and nothing else. Any other batch after the close is refused as ever.
    if (round.state !== OPEN) {
      const held = this.heldFinalAsk(b.entryId);
      if (!held || b.firstTick + b.ticks.length - 1 >= held.tick) throw new Error('the round is closed');
    }
    const entry = this.db.prepare('SELECT round_id FROM entries WHERE entry_id = ?').get(b.entryId);
    if (!entry) throw new Error('no such entry');
    if (!same(new Uint8Array(entry.round_id), b.roundId)) throw new Error('entry is not in this round');

    const put = this.db.prepare(
      'INSERT OR IGNORE INTO ticks (round_id, entry_id, tick, words) VALUES (?, ?, ?, ?)');
    const putLiq = this.db.prepare(
      'INSERT OR IGNORE INTO liquidations (round_id, entry_id, tick, size) VALUES (?, ?, ?, ?)');
    const putLoad = this.db.prepare(
      'INSERT OR IGNORE INTO loads (round_id, entry_id, tick, fee_sats, btc_hund, room) '
      + 'VALUES (?, ?, ?, ?, ?, ?)');
    const putSample = this.db.prepare(
      'INSERT OR IGNORE INTO samples (round_id, entry_id, tick, price) VALUES (?, ?, ?, ?)');
    const putTape = this.db.prepare(
      'INSERT OR IGNORE INTO tapes (round_id, entry_id, tick, prices) VALUES (?, ?, ?, ?)');

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

    // AND THE PRICES IT PLAYED, WHERE IT CARRIES THE COMMITTEE'S WORD ON THEM (§11): an attestation that
    // does not stand, or a sample that is not the attested price at its tick, refuses the batch - the player never
    // chooses the price. A batch with none is taken as before - unless this seat runs the committee's feed for the round
    // (`pricesRequired`, slice 3): then a bare sample or tape is the player choosing the price and is refused; a run with no
    // samples at all plays the seeded tape (front_mode = SIM) and stands.
    const requirePrices = !!(this.pricesRequired && this.pricesRequired(round.contract));
    if ((b.attests && b.attests.length) || (requirePrices && ((b.samples && b.samples.length) || (b.tapes && b.tapes.length)))) {
      const c = decodeRoundContract(new Uint8Array(round.contract));
      // the ROUND's version picks the scheme: from protocol 5 the median of the seats' own signed readings
      const prices = checkBatchPrices({ batch: b, roundId: b.roundId, committee: c.nodes, threshold: (() => { try { return receiptsNeeded(c.gameVerifySlots); } catch { return c.nodes.length; } })(),
        verify: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } }, require: requirePrices, median: mediansPrices(c) });
      if (!prices.ok) throw new Error(prices.why);
    }

    // AND IT MUST NOT BE LONGER THAN THE ROUND. `blockTicks` is a field of
    // the contract this node already stores, so the ceiling comes from the
    // round the player signed up to rather than from a number invented here.
    // The transport already refuses a frame that could not decode at all;
    // this refuses one that decodes and still could not be honest.
    const blockTicks = factsOf(round.contract).blockTicks;
    if (b.ticks.length > blockTicks)
      throw new Error(
        `a batch carries at most the round's ${blockTicks} ticks, got ${b.ticks.length}`);

    // AND THE RUN ITSELF ENDS. Bounding one batch bounded nothing: measured,
    // a player published 9600 ticks of a 9000-tick run in sixteen batches and
    // this node stored every one of them, then replayed all 9600. The core
    // ends a run at BLOCK_TICKS elapsed - 0.8's mission duration, counted from
    // that player's own first tick so a late joiner gets a whole run - so a
    // tick at or past `joinTick + BLOCK_TICKS` is an input for a run that is
    // over, whatever it ended as.
    //
    // Refused at intake, where the one party who can still fix it is listening,
    // rather than at hand-over with nobody left to ask.
    const joined = this.entry(b.entryId);
    if (joined) {
      const joinTick = decodeEntryContract(joined).joinTick;
      const last = lastTickOfRun(joinTick, blockTicks);
      const reaches = b.firstTick + b.ticks.length - 1;
      if (reaches > last)
        throw new Error(
          `that run ends at tick ${last} - the round's last of ${blockTicks}, joined at ${joinTick} - `
          + `and this batch reaches ${reaches}: inputs past the end are inputs for a run `
          + 'that is over');
    }

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

    // AND THE LOAD IS ONE AN HONEST BED COULD HAVE DECLARED (kanban #1488): a room the parcels make, a fee for each of
    // them, no more than 20 BTC, at a tick this batch carries and before the truck was ever driven (load-checks.js).
    // A repeat of the head was checked when it first came.
    if (!seen && b.loads && b.loads.length) {
      const why = loadsRefusal(b, at, () => !!this.db.prepare(
        'SELECT 1 FROM ticks WHERE round_id = ? AND entry_id = ? AND substr(words, 1, 16) != zeroblob(16) LIMIT 1')
        .get(b.roundId, b.entryId));
      if (why) throw new Error(why);
    }

    // AND ONE EVENT PER TICK, THE SAME IN THE TABLES AS IN THE BYTES (kanban #1568). The tables below keep the FIRST
    // liquidation, load, sample or tape at a tick (INSERT OR IGNORE); the batch bytes go unchanged into the canonical
    // transcript, whose flatten() and the core's eventsOf keep the LAST. Two different events at one tick - in one batch
    // or across two - made every seat replay one run and sign the hash of another, and an objection then held against
    // every honest seat. A second event at a tick is refused unless it is the very same event (a harmless repeat).
    if (!seen) {
      const kinds = [
        ['liquidation', b.liquidations || [], ([, size]) => String(size),
          'SELECT size FROM liquidations WHERE round_id = ? AND entry_id = ? AND tick = ?', (r) => String(r.size)],
        ['load', b.loads || [], ([, fee, btc, room]) => `${fee},${btc},${room === undefined ? null : room}`,
          'SELECT fee_sats, btc_hund, room FROM loads WHERE round_id = ? AND entry_id = ? AND tick = ?',
          (r) => `${r.fee_sats},${r.btc_hund},${r.room}`],
        ['sample', b.samples || [], ([, price]) => String(price),
          'SELECT price FROM samples WHERE round_id = ? AND entry_id = ? AND tick = ?', (r) => String(r.price)],
        ['tape', b.tapes || [], ([, ...prices]) => Buffer.from(new Int32Array(prices).buffer).toString('hex'),
          'SELECT prices FROM tapes WHERE round_id = ? AND entry_id = ? AND tick = ?',
          (r) => Buffer.from(r.prices).toString('hex')],
      ];
      for (const [name, events, keyOf, sql, storedKey] of kinds) {
        const mine = new Map();
        const stored = this.db.prepare(sql);
        for (const ev of events) {
          const tick = ev[0], key = keyOf(ev);
          if (mine.has(tick) && mine.get(tick) !== key)
            throw new Error(`that batch carries two different ${name}s at tick ${tick}: one event per tick`);
          mine.set(tick, key);
          const row = stored.get(b.roundId, b.entryId, tick);
          if (row && storedKey(row) !== key)
            throw new Error(`a different ${name} is already stored at tick ${tick}: one event per tick`);
        }
      }
    }

    // ONE COMMIT FOR THE WHOLE BATCH, not one per row (2026-09-17 19:15, the ghost lag). Every `run` outside a
    // transaction is its own commit, so a batch of six ticks with a sample and a tape cost seven disk syncs on the
    // thread that also pushes other players' trucks: measured live on the Daily, `batch stored` held the loop 24-46 ms
    // and the frames around it made stalls of 263-280 ms. The rows are the same rows and the checks above are
    // unchanged; what changes is that they land together, which is also what a batch means.
    this.db.exec('BEGIN IMMEDIATE');
    let fresh = 0;
    try {
      for (let i = 0; i < b.ticks.length; i++) {
        const words = new Uint8Array(new Int32Array(b.ticks[i]).buffer);
        fresh += put.run(b.roundId, b.entryId, at[i], words).changes;
      }
      for (const [tick, size] of b.liquidations) putLiq.run(b.roundId, b.entryId, tick, size);
      for (const [tick, fee, btc, room] of (b.loads || []))
        putLoad.run(b.roundId, b.entryId, tick, fee, btc, room === undefined ? null : room);
      for (const [tick, price] of (b.samples || []))
        putSample.run(b.roundId, b.entryId, tick, price);
      for (const [tick, ...prices] of (b.tapes || []))
        putTape.run(b.roundId, b.entryId, tick, new Uint8Array(new Int32Array(prices).buffer));

      if (!seen) {
        // THE NEXT SEQUENCE OFF THE LAST ONE, not off a count of them all: a count walks every batch this entry has
        // published, which by the end of a run is fifteen hundred rows, on the thread that also pushes other players'
        // trucks. The rows are only ever appended, so the last one's number plus one is the same number.
        const last = this.db.prepare(
          'SELECT MAX(seq) m FROM batches WHERE round_id = ? AND entry_id = ?').get(b.roundId, b.entryId).m;
        const n = last === null ? 0 : last + 1;
        this.db.prepare(
          'INSERT INTO batches (round_id, entry_id, seq, batch_id, bytes) VALUES (?, ?, ?, ?, ?)')
          .run(b.roundId, b.entryId, n, id, bytes);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      // NOTHING HALF-STORED: a batch that threw leaves the store as it was, and the client is told, as before.
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
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
    // AFTER THE CLOSE ONLY THE HELD-BACK FINAL MARK ITSELF, byte for byte (ruled 2026-09-23) - never another mark.
    if (round.state !== OPEN) {
      const held = this.heldFinalAsk(c.entryId);
      if (!held || !same(new Uint8Array(held.mark), bytes)) throw new Error('the round is closed');
    }
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
    // THE PLAYER'S SESSION KEY IS STILL ED25519 and is not a node key: it
    // signs marks, it bonds nothing, and 26's one-key ruling is about
    // `node_pubkey`.
    try { ok = ed25519.verify(signature, id, sessionPubkey); } catch { ok = false; }
    if (!ok) throw new Error('the signature does not verify under the entry\'s session key');

    // A FIRST MARK SIGNED AFTER join_tick + THE START DEADLINE IS FORFEIT (§15).
    //
    // The first mark is the one that chains to nothing. Its tick is the
    // player's own, under the entry's session key, so every signer node reads the same
    // number and no clock is consulted. Past the round's line it is the
    // player's own late start: refused - no receipt - and kept as the evidence
    // the entry is FORFEIT. Not ENTRY_VOID: a refund the player could choose by
    // starting late is one §13C forbids. In time, it goes on as any mark. A
    // player with no first mark is decided at the door (server.js door sweep, ALL-BUT-MIN-1727).
    if (same(c.previousHash, NO_PREVIOUS)) {
      const joined = decodeEntryContract(new Uint8Array(entry.contract));
      // AFTER THE DOOR (ALL-BUT-MIN-1727): this signer node already signed the entry FORFEIT because no first mark came
      // before its start window passed. A first mark now is that same late start - refused, kept as the evidence.
      if (this.hasResult(c.roundId, c.entryId, this.pubkey)) {
        const why = 'this signer node signed the entry FORFEIT at the door: no first mark came before its start window passed';
        this.putStartForfeit({ entryId: c.entryId, roundId: c.roundId, markTick: c.tick, lastTick: joined.joinTick, mark: bytes, why });
        throw new Error(`FORFEIT: ${why}`);
      }
      let decided;
      try {
        const rc = decodeRoundContract(new Uint8Array(round.contract));
        const origin = this.startWindowOrigin(c.entryId, joined, rc);
        decided = firstMarkOutcome({ joinTick: joined.joinTick, ...origin,
          deadlineTicks: startDeadlineOf(rc),
          firstMark: { tick: c.tick, previousHash: c.previousHash } });
      } catch (e) { throw new Error(`that first mark is refused: ${e.message}`); }
      if (decided.outcome) {
        this.putStartForfeit({ entryId: c.entryId, roundId: c.roundId, markTick: c.tick, lastTick: decided.lastTick, mark: bytes, why: decided.why });
        throw new Error(`FORFEIT: ${decided.why}`);
      }
    }

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
      const kept = this.db.prepare(
        'INSERT OR IGNORE INTO equivocations '
        + '(round_id, entry_id, tick, stored_bytes, offered_bytes, seen_ms) '
        + 'VALUES (?, ?, ?, ?, ?, ?)')
        .run(c.roundId, c.entryId, c.tick, stored.bytes, bytes, this.now());
      // AND PUBLISHED (§25.2,: "equivocation proofs, objections - direct, AND any public broadcast channel"):
      // the first time this node holds the pair, whoever set `onEquivocation` (the server: the round's publication_relays[])
      // is handed both signed marks. A pair held already is not handed again, so relays that relay do not loop.
      if (kept.changes && typeof this.onEquivocation === 'function') {
        try { this.onEquivocation({ roundId: c.roundId, entryId: c.entryId, tick: c.tick, stored: new Uint8Array(stored.bytes), offered: bytes }); }
        catch { /* publishing never undoes the keeping */ }
      }

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
    // The batch head at the moment of arrival is not demanded - a batch
    // reaching past the mark may already be here - so what is required of the
    // NAME is that it is a batch the node holds for this entry, or the genesis.
    if (!same(c.inputChainHash, GENESIS)) {
      const known = this.db.prepare(
        'SELECT 1 k FROM batches WHERE round_id = ? AND entry_id = ? AND batch_id = ?')
        .get(c.roundId, c.entryId, c.inputChainHash);
      if (!known) throw new Error('the checkpoint names inputs this node has not seen');
    }

    // AND THE NODE HOLDS EVERY INPUT THAT STATE CAME FROM.
    //
    // A checkpoint at tick T is the core after T steps: it was produced by the
    // inputs of every tick before T. Measured 2026-09-10 on two real daemons:
    // a client that sent no batch at all got all four of its checkpoints
    // receipted by both - and on the Daily, daemon B held 0 ticks of runs it
    // had receipted. A receipt over a state whose inputs this node has never
    // seen is a signature on a claim. So the ticks before T must all be here
    // first (intake already refuses a hole, so "the next tick owed is at least
    // T" is the whole check). A mark sent ahead of its batch is refused, not
    // parked: the client sends it again once its inputs have landed.
    //
    // HOLDING IS NOT REPLAYING. This still does not show those inputs produce
    // that state - nothing in this package imports the core. That is the
    // next cut, and it is verification's.
    const owed = this.nextTick(c.roundId, c.entryId);
    if (c.tick > owed)
      throw new Error(
        `the checkpoint is at tick ${c.tick} and this node holds this run's inputs only `
        + `before tick ${owed}: send the batches first`);

    this.db.prepare(
      'INSERT INTO checkpoints (round_id, entry_id, tick, checkpoint_id, bytes, received_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.roundId, c.entryId, c.tick, id, bytes, Date.now());
    this.noteEvidenceBlock(c.roundId, c.entryId, id);
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

      // NO MARKS. This is the store's own copy, handed to a client that is
      // resuming, and the marks it needs travel on `/checkpoints` where the
      // client checks each one against the receipts it recovered - a node's
      // word for its own last mark is exactly what `resume` refuses to take.
      // An empty chain here is not a shortcut: it is the difference between
      // this object and the canonical one, and it shows in the hash.
      marks: [],
    };
    const ok = checkTranscript(t);
    if (!ok.ok)
      throw new Error(`the stored transcript is broken at ${ok.in} ${ok.at}: ${ok.why}`);
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
    const need = neededForRound(this.db, roundIdBytes);
    let live = 0;
    while (live < marks.length
      && this.receiptCount(marks[live].checkpoint_id) >= need) live++;

    if (live === 0) {
      const held = this.receiptCount(marks[0].checkpoint_id);
      throw new Error(
        `no checkpoint of that entry is carried by ${need} committee `
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

    // AND THE MARKS THEMSELVES GO IN THE OBJECT, not just their count in the
    // answer. §13C names the checkpoint chain FIRST and the batches second,
    // and for a while this served the second half only: two nodes carrying
    // different mark chains over one set of batches - even a node whose
    // player had committed to a different world at the last tick - handed
    // back one `transcriptHash`, so the committee signed results that were
    // indistinguishable by id. What every node replays has to include what
    // the replay is checked against.
    const t = {
      roundId: new Uint8Array(roundIdBytes),
      entryId: new Uint8Array(entryIdBytes),
      batches,
      marks: marks.slice(0, live).map((m) => new Uint8Array(m.bytes)),
    };
    const ok = checkTranscript(t);
    if (!ok.ok)
      throw new Error(`the carried transcript is broken at ${ok.in} ${ok.at}: ${ok.why}`);

    return {
      // WHICH RUN THIS IS, carried out with the digest. Without them a caller
      // holding a canonical transcript and an entry cannot check that the two
      // are the same run, and a result takes its player from the entry and its
      // hash from here - so a wrong pairing would sign one player's drive
      // under another's name.
      roundId: t.roundId,
      entryId: t.entryId,
      bytes: encodeTranscript(t),
      hash: transcriptHash(t),
      ticks: ok.ticks,
      marks: ok.marks,
      dropped: marks.length - live,
      throughTick: ok.throughTick,
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
    // AND TWO FIRST MARKS (M3, the guard case's leftover): the first mark this
    // signer node holds and a DIFFERENT one it refused as a late start. Both chain to
    // nothing - one parent, two chains, 13B's second limb - and the pair is the
    // same portable proof `provesEquivocation` checks. Measured before: without
    // it both signer nodes recorded ENTRY_VOID for the player's own split start.
    const late = this.startForfeit(entryIdBytes);
    const heldFirst = this.firstMarkHeld(roundIdBytes, entryIdBytes);
    if (late && heldFirst && !same(late.mark, heldFirst))
      out.push({ how: 'two first marks, one of them late', tick: late.markTick, stored: heldFirst, offered: late.mark,
        seenMs: late.decidedMs });
    // AND TWO FIRST MARKS KEPT AS A PAIR (first_mark_pairs): this signer node holds
    // neither as a checkpoint - e.g. a peer's voided one and a different one sent here.
    for (const r of this.db.prepare('SELECT first_a, first_b, seen_ms FROM first_mark_pairs WHERE round_id = ? AND entry_id = ?')
      .all(roundIdBytes, entryIdBytes)) {
      const a = new Uint8Array(r.first_a);
      const b = new Uint8Array(r.first_b);
      const tickOf = (m) => decodeCheckpoint(splitSigned(m).body).tick;
      out.push({ how: 'two first marks', tick: Math.min(tickOf(a), tickOf(b)), stored: a, offered: b, seenMs: r.seen_ms });
    }
    // AND A FORK PAIR PULLED FROM A PEER (fork_pairs, §13B at any tick)
    for (const r of this.db.prepare('SELECT mark_a, mark_b, seen_ms, receipted FROM fork_pairs WHERE round_id = ? AND entry_id = ?')
      .all(roundIdBytes, entryIdBytes)) {
      const a = new Uint8Array(r.mark_a);
      const b = new Uint8Array(r.mark_b);
      const ca = decodeCheckpoint(splitSigned(a).body), cb = decodeCheckpoint(splitSigned(b).body);
      out.push({ how: ca.tick === cb.tick ? 'two marks at one tick' : 'two chains from one parent', tick: Math.min(ca.tick, cb.tick),
        stored: a, offered: b, seenMs: r.seen_ms, receipted: r.receipted === 1 });
    }
    return out.sort((a, b) => a.tick - b.tick);
  }

  /**
   * KEEP A PEER'S PROOF OF A FORK AT ANY TICK (§13B "two different checkpoints for the same tick, or two chains that
   * diverge at any tick"): both signed by the entry's session key, one entry, different marks, and the same
   * tick or the same parent - the pair provesEquivocation checks. Anything else is not kept. Answers whether it is held.
   */
  /** Is this pair already kept, as a fork pair or a first-mark pair (each verified when it was stored)? */
  pairKept(entryIdBytes, a, b) {
    const [x, y] = Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0 ? [a, b] : [b, a];
    if (this.db.prepare('SELECT 1 FROM fork_pairs WHERE entry_id = ? AND mark_a = ? AND mark_b = ?').get(entryIdBytes, x, y)) return true;
    return !!this.db.prepare('SELECT 1 FROM first_mark_pairs WHERE entry_id = ? AND ((first_a = ? AND first_b = ?) OR (first_a = ? AND first_b = ?))')
      .get(entryIdBytes, a, b, b, a);
  }

  putForkPair({ a, b, receipted = false }) {
    let ca, cb;
    try { ca = this.playerSigned(a); cb = this.playerSigned(b); } catch { return false; }
    if (same(a, b) || !same(ca.entryId, cb.entryId) || !same(ca.roundId, cb.roundId)) return false;
    if (ca.tick !== cb.tick && !same(ca.previousHash, cb.previousHash)) return false;
    const [x, y] = Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0 ? [a, b] : [b, a];
    // `receipted`: both marks were receipted by a seat - this seat's own chain and a peer's (GET /checkpoints). Kept as the
    // stronger of what any source said, so a pair first pulled unreceipted and then found in two chains counts.
    this.db.prepare('INSERT INTO fork_pairs (round_id, entry_id, mark_a, mark_b, seen_ms, receipted) VALUES (?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT (entry_id, mark_a, mark_b) DO UPDATE SET receipted = MAX(receipted, excluded.receipted)')
      .run(ca.roundId, ca.entryId, x, y, this.now(), receipted ? 1 : 0);
    this.noteEvidenceBlock(ca.roundId, ca.entryId, checkpointId(ca));
    this.noteEvidenceBlock(cb.roundId, cb.entryId, checkpointId(cb));
    return true;
  }

  /**
   * DOES THIS SIGNER NODE HOLD THE PROOF OF A FORK AT ANY TICK? (§13B) Two different marks of this entry, both
   * signed by its session key, at the same tick or from the same parent - checked here from this node's own store (its
   * stored and refused marks, and the pairs it pulled). The first-mark pair is one such fork and is answered too.
   * Returns `{ tick, how }` - the tick where the chains part - or null. `window` as provenTwoFirstMarks'.
   */
  provenFork(roundIdBytes, entryIdBytes, window = null) {
    for (const f of this.equivocation(roundIdBytes, entryIdBytes)) {
      try {
        const a = f.stored, b = f.offered;
        if (same(a, b)) continue;
        if (window && !(this.markCounts(entryIdBytes, a, window.chain, window.end) && this.markCounts(entryIdBytes, b, window.chain, window.end))) continue;
        // DECIDED ON THE MARKS' FIELDS FIRST, THE SIGNATURES ONLY FOR A PAIR THAT WOULD COUNT (measured live
        // 2026-10-06 on 0.0.2815, entry 0b68a08f): a page stuck on an old head sent 63 refused marks, every one a "second
        // child" of that head and none receipted; verifying both signatures of every pair, on every call, held a seat's one
        // thread at 100% for minutes and five seats never signed the entry. A pair that cannot prove a fork costs a decode.
        const da = decodeCheckpoint(splitSigned(a).body), db = decodeCheckpoint(splitSigned(b).body);
        if (!same(da.entryId, entryIdBytes) || !same(db.entryId, entryIdBytes)) continue;
        if (da.tick !== db.tick && !(same(da.previousHash, db.previousHash) && f.receipted === true)) continue;
        const ca = this.playerSigned(a), cb = this.playerSigned(b);
        if (!same(ca.entryId, entryIdBytes) || !same(cb.entryId, entryIdBytes)) continue;
        // TWO MARKS AT ONE TICK forfeit as ever. TWO CHAINS FROM ONE PARENT forfeit only when BOTH marks were receipted by a
        // seat (RULED 2026-10-05 (b)): a mark the seat refused for not following its head - a page stuck on an old
        // head, measured on testnet4 (ea63aa94: 13 marks after @1620 all naming @1560; c35157df: all naming @60) - was never
        // carried, splits no seats, and costs the player nothing. Two first marks are their own path (provenTwoFirstMarks).
        if (ca.tick === cb.tick) return { tick: ca.tick, how: f.how };
        if (same(ca.previousHash, cb.previousHash) && f.receipted === true) return { tick: Math.min(ca.tick, cb.tick), how: f.how };
      } catch { /* not the player's two marks */ }
    }
    return null;
  }

  /** §13B'S PROOF, AT ANY TICK: two first marks, or a fork at any later tick. */
  provenEquivocation(roundIdBytes, entryIdBytes, window = null) {
    return this.provenTwoFirstMarks(roundIdBytes, entryIdBytes, window) || this.provenFork(roundIdBytes, entryIdBytes, window) !== null;
  }

  /**
   * KEEP TWO FIRST MARKS AS THE PLAYER'S PROOF (§13B; M3.3-34, ruled 2026-09-12):
   * both signed by the entry's session key, both chaining to nothing, and not
   * the same mark - the pair provesEquivocation checks. Anything else is not
   * kept. Answers whether the pair is held here now.
   */
  putFirstMarkPair({ a, b }) {
    let ca;
    let cb;
    try { ca = this.playerSigned(a); cb = this.playerSigned(b); } catch { return false; }
    if (same(a, b) || !same(ca.entryId, cb.entryId) || !same(ca.roundId, cb.roundId)) return false;
    if (!same(ca.previousHash, NO_PREVIOUS) || !same(cb.previousHash, NO_PREVIOUS)) return false;
    const [x, y] = Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0 ? [a, b] : [b, a];
    this.db.prepare('INSERT OR IGNORE INTO first_mark_pairs (round_id, entry_id, first_a, first_b, seen_ms) VALUES (?, ?, ?, ?, ?)')
      .run(ca.roundId, ca.entryId, x, y, this.now());
    this.noteEvidenceBlock(ca.roundId, ca.entryId, checkpointId(ca));
    this.noteEvidenceBlock(cb.roundId, cb.entryId, checkpointId(cb));
    return true;
  }

  /**
   * DOES THIS SIGNER NODE HOLD THE PROOF OF TWO FIRST MARKS? (§13B; M3.3-34) Two
   * different marks of this entry, both chaining to nothing, both signed by
   * its session key - checked here, synchronously, from this signer node's own store.
   * That pair forfeits the entry with no quorum, no replay and no window.
   */
  provenTwoFirstMarks(roundIdBytes, entryIdBytes, window = null) {
    const pairs = this.equivocation(roundIdBytes, entryIdBytes).map((f) => [f.stored, f.offered]);
    const voided = this.entryVoid(entryIdBytes);
    const late = this.startForfeit(entryIdBytes);
    if (voided && late) pairs.push([voided.firstMark, late.mark]);
    for (const [a, b] of pairs) {
      try {
        if (same(a, b)) continue;
        // IN A WINDOW (`window`: { chain, end }; RULED 2026-09-24): the pair counts only if both its marks do.
        if (window && !(this.markCounts(entryIdBytes, a, window.chain, window.end) && this.markCounts(entryIdBytes, b, window.chain, window.end))) continue;
        // two first marks only: the parents read before any signature is checked (as provenFork)
        const da = decodeCheckpoint(splitSigned(a).body), db = decodeCheckpoint(splitSigned(b).body);
        if (!same(da.previousHash, NO_PREVIOUS) || !same(db.previousHash, NO_PREVIOUS)) continue;
        const ca = this.playerSigned(a);
        const cb = this.playerSigned(b);
        if (same(ca.entryId, entryIdBytes) && same(cb.entryId, entryIdBytes)
          && same(ca.previousHash, NO_PREVIOUS) && same(cb.previousHash, NO_PREVIOUS)) return true;
      } catch { /* not the player's two first marks */ }
    }
    return false;
  }

  /** Another signer node's sealed answer with its share of an entry's preimage, kept as it came. */
  putHeldShare({ entryId, signerNode, bytes }) {
    this.db.prepare('INSERT OR IGNORE INTO held_shares (entry_id, signer_node, answer, seen_ms) VALUES (?, ?, ?, ?)')
      .run(entryId, signerNode, bytes, this.now());
  }

  heldShares(entryIdBytes) {
    return this.db.prepare('SELECT answer FROM held_shares WHERE entry_id = ? ORDER BY signer_node').all(entryIdBytes)
      .map((r) => new Uint8Array(r.answer));
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
    // AND NOT WITHOUT BOUND (kanban #1548): the player holds its own session key, so every refused frame was one more
    // offered_marks row and one more evidence_blocks row at every seat, read back on every GET /equivocation, every
    // first mark at the door and every close. A fork needs one pair, not thousands. The first OFFERED_KEEP refused marks
    // of an entry are kept as before (one of them may pair with a mark the chain only takes later); past that only a mark
    // that already contradicts the stored chain (same tick, or a parent that has a child here) is kept, and only
    // OFFERED_PROOF_KEEP of those. The rest is refused without a write.
    const held = this.db.prepare('SELECT COUNT(*) n FROM offered_marks WHERE round_id = ? AND entry_id = ?')
      .get(c.roundId, c.entryId).n;
    if (held >= Round.OFFERED_KEEP) {
      if (held >= Round.OFFERED_KEEP + Round.OFFERED_PROOF_KEEP) return;
      const head = this.checkpointHead(c.roundId, c.entryId);
      const pairsNow = !!this.db.prepare(
        'SELECT 1 FROM checkpoints WHERE round_id = ? AND entry_id = ? AND tick = ? AND checkpoint_id != ?')
        .get(c.roundId, c.entryId, c.tick, id)
        || (head.tick !== null && !same(c.previousHash, head.id) && (same(c.previousHash, NO_PREVIOUS)
          || !!this.db.prepare('SELECT 1 FROM checkpoints WHERE round_id = ? AND entry_id = ? AND checkpoint_id = ?')
            .get(c.roundId, c.entryId, c.previousHash)));
      if (!pairsNow) return;
    }
    this.db.prepare(
      'INSERT OR IGNORE INTO offered_marks '
      + '(round_id, entry_id, tick, checkpoint_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.roundId, c.entryId, c.tick, id, bytes, this.now());
    this.noteEvidenceBlock(c.roundId, c.entryId, id);
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
    this.openList.askedMs = 0;
    this.db.prepare('UPDATE rounds SET state = ?, closed_ms = ? WHERE round_id = ?')
      .run(CLOSED, this.now(), id);
    this.contracts.delete(this.hexOf(id));
    if (this.openList.key !== null) this.closedSinceList.add(this.hexOf(id));
    this.closeSeq++; this.closedLog.push(this.hexOf(id));
    if (this.closedLog.length > Round.CLOSED_LOG) this.closedLog.shift();
    this.openSeq++;
    return true;
  }

  /**
   * The transcript, in tick order: everything needed to replay the round and
   * nothing else. Absolute ticks, so a gap shows as a hole in the numbers
   * rather than as a shorter list nobody can size.
   */
  transcript(roundIdBytes, entryIdBytes) {
    return readTranscript(this.db, roundIdBytes, entryIdBytes);
  }


  /** The live tapes of a run, `[tick, p0 .. p63]`. */
  #tapes(roundIdBytes, entryIdBytes) {
    return this.db.prepare('SELECT tick, prices FROM tapes WHERE round_id = ? AND entry_id = ? ORDER BY tick')
      .all(roundIdBytes, entryIdBytes)
      .map((r) => [r.tick, ...new Int32Array(new Uint8Array(r.prices).slice().buffer)]);
  }

  /**
   * THE BATCHES AFTER ONE THIS NODE HAS ALREADY SEEN, by sequence.
   *
   * `handOver` reads and re-checks the WHOLE chain, which is right for a
   * client resuming and wrong for a picture of the newest six ticks: measured
   * at the end of a full 9000-tick round it walked 1500 batches per frame,
   * ten times a second, per watcher. The chain is append-only and every batch
   * was checked against the stored head on the way in, so a live watcher can
   * check the new ones and no others - once each, still all of them.
   */
  /** The longest batch held for a run, in bytes (0 for none). */
  largestBatch(roundIdBytes, entryIdBytes) {
    const r = this.db.prepare('SELECT max(length(bytes)) AS n FROM batches WHERE round_id = ? AND entry_id = ?').get(roundIdBytes, entryIdBytes);
    return (r && r.n) || 0;
  }

  batchesFrom(roundIdBytes, entryIdBytes, afterSeq = -1) {
    return this.db.prepare(
      'SELECT seq, bytes FROM batches WHERE round_id = ? AND entry_id = ? AND seq > ? ORDER BY seq')
      .all(roundIdBytes, entryIdBytes, afterSeq)
      .map((r) => ({ seq: r.seq, batch: decodeInputBatch(new Uint8Array(r.bytes)) }));
  }

  /**
   * THE TICKS FROM ONE POINT ON, for a run somebody is watching live.
   *
   * `transcript` reads the whole run, which is right for a replay that starts
   * at zero and wrong for a picture of the last six ticks: measured at tick
   * 3599 it cost 8.5 ms of the ~30 ms a live frame was spending on tables
   * rather than on simulation. The liquidations and the loads come whole
   * because there are a handful of them in a run, not thousands.
   */
  ticksFrom(roundIdBytes, entryIdBytes, from) {
    const ticks = this.db.prepare(
      'SELECT tick, words FROM ticks WHERE round_id = ? AND entry_id = ? AND tick >= ? ORDER BY tick')
      .all(roundIdBytes, entryIdBytes, from);
    const liq = this.db.prepare(
      'SELECT tick, size FROM liquidations WHERE round_id = ? AND entry_id = ? AND tick >= ? ORDER BY tick')
      .all(roundIdBytes, entryIdBytes, from);
    // THE LOADS COME WHOLE, and not from `from` on. A load is declared once at
    // roll-out - tick zero of the run - and a live watcher asking for the last
    // six ticks would get none of them and draw the truck at heat zero, which
    // is the fault letter 40 exists to close. There is a handful in a run.
    const loads = this.db.prepare(
      'SELECT tick, fee_sats, btc_hund, room FROM loads WHERE round_id = ? AND entry_id = ? ORDER BY tick')
      .all(roundIdBytes, entryIdBytes);
    // the price samples from `from` on, like the liquidations: each belongs to its own tick
    const samples = this.db.prepare(
      'SELECT tick, price FROM samples WHERE round_id = ? AND entry_id = ? AND tick >= ? ORDER BY tick')
      .all(roundIdBytes, entryIdBytes, from);
    return {
      // the tape comes whole, like the loads: it is handed over once, at the start
      tapes: this.#tapes(roundIdBytes, entryIdBytes),
      from,
      ticks: ticks.map((r) => ({ tick: r.tick, words: [...new Int32Array(new Uint8Array(r.words).buffer)] })),
      liquidations: liq.map((r) => [r.tick, r.size]),
      loads: loads.map((r) => (r.room === null || r.room === undefined ? [r.tick, r.fee_sats, r.btc_hund] : [r.tick, r.fee_sats, r.btc_hund, r.room])),
      samples: samples.map((r) => [r.tick, r.price]),
    };
  }

  /**
   * EVERY ENTRY OF A ROUND, so a daemon that has just closed one can find the
   * runs it must replay without being told what they are.
   */
  /**
   * EVERY ROUND THIS NODE HOLDS THAT IS STILL OPEN, for the lobby door (§25,
   * M3.3-34): the contract as stored and when this node opened it. A closed
   * round is nobody's lobby business.
   */
  /** The rounds this node has closed, the latest first (the /rounds page's finished list, ROUNDS-HTML-1617). */
  finishedRounds(limit = 200) {
    return this.db.prepare('SELECT round_id, contract, closed_ms FROM rounds WHERE state = ? ORDER BY closed_ms DESC LIMIT ?')
      .all(CLOSED, limit)
      .filter((r) => parses(r.contract))
      .map((r) => ({ roundId: new Uint8Array(r.round_id), contract: new Uint8Array(r.contract), closedMs: r.closed_ms }));
  }

  /**
   * THE OPEN ROUNDS' IDS ONLY, in the order they opened - no contract read (2026-10-02, the the test host's load: GET /rounds,
   * which every lobby asks of every node every few seconds, read all ~2,950 held contracts out of the store and decoded each
   * just to list ids it had already decoded and kept - ~24 % of an idle seat's loop while one round ran). A caller that
   * needs a contract it has not kept asks get(id).
   */
  openRoundIds() {
    return this.db.prepare('SELECT round_id FROM rounds WHERE state = ? ORDER BY opened_ms').all(OPEN).map((r) => new Uint8Array(r.round_id));
  }

  openRounds() {
    return this.db.prepare('SELECT round_id, contract, opened_ms FROM rounds WHERE state = ? ORDER BY opened_ms')
      .all(OPEN)
      .filter((r) => parses(r.contract))
      .map((r) => ({ roundId: new Uint8Array(r.round_id), contract: new Uint8Array(r.contract), openedMs: r.opened_ms }));
  }

  /**
   * How many PLAYERS joined at this node in a round, and how many of them it has taken ticks from.
   *
   * PLAYERS, NOT ENTRIES (2026-09-16 15:36: "after each successful run lobby says 1 joined then 2
   * then 3 as if he never left"). Every PLAY is a new entry, so one player's three runs counted three;
   * measured on the Daily, one round held 7 entries from 1 player key. An entry's player is the key in
   * its contract.
   */
  playersOf(roundIdBytes) {
    const ticked = new Set(this.db.prepare('SELECT DISTINCT entry_id FROM ticks WHERE round_id = ?')
      .all(roundIdBytes).map((r) => toHex(new Uint8Array(r.entry_id))));
    const joined = new Set(), playing = new Set();
    for (const r of this.db.prepare('SELECT entry_id, contract FROM entries WHERE round_id = ?').all(roundIdBytes)) {
      let player;
      try { player = toHex(decodeEntryContract(new Uint8Array(r.contract)).playerPubkey); } catch { continue; }
      joined.add(player);
      if (ticked.has(toHex(new Uint8Array(r.entry_id)))) playing.add(player);
    }
    return { joined: joined.size, playing: playing.size };
  }

  // A CANCELLED MARKET ENTRY IS NOT IN ITS ROUND: no table, no settlement, no count
  entriesOf(roundIdBytes) {
    return this.db.prepare(
      'SELECT entry_id, contract FROM entries WHERE round_id = ? AND entry_id NOT IN (SELECT entry_id FROM market_cancels) ORDER BY entry_id')
      .all(roundIdBytes)
      .map((r) => ({
        entryId: new Uint8Array(r.entry_id),
        entry: decodeEntryContract(new Uint8Array(r.contract)),
      }));
  }

  /**
   * THE ENTRIES THAT TAKE A SEAT OF A HEAD-TO-HEAD ROUND (kanban #1437, audit 8 R3): in a paying round only those backed by a lock here - its stake
   * seen, or its stake lock verified and waiting for its fee lock - since the /entry door takes an entry before any lock is verified, and two
   * lockless entries took both seats of a paying round at no cost. `stakeMsat` is the round's: a free round's every entry takes one, as before.
   *
   * `played` (kanban #1544): the entries the close plays and decides - its stake SEEN only, the set the settlement counts (settlement.js
   * entriesOnRecord). A stake lock still waiting for its fee lock holds its seat at the door but is played against nobody and signed VOID:
   * played, it lost into no settlement - its stake came back by refund and the honest winner was paid nothing (a free option).
   *
   * THE SAME SEATS AT EVERY SEAT (kanban #1588, state audit 2026-11-12 sm1-h2h-1): the seats were the first LOCKS to reach this seat, and locks
   * reach the seats in network order - seat 0 seated {A, B}, seat 1 {A, C}, each refused the other's lock as full, and at the close each waited
   * for a lock its own door refused: no seat signed anything, the winner A included. Now /lock keeps every valid lock (no "full" refusal; the
   * close fetches what is missing, server.js takeEntryParts), and a paying head-to-head round seats the game's `players` lock-backed entries in
   * the order their ENTRIES were first taken here (rowid): a client posts its entry to every seat before it hands any lock, so the seats hold the
   * entries in one order while their locks still cross - and a player who entered first is never unseated by a later entry's lock. A locked
   * entry outside the seats is played against nobody and signed VOID: its lock is never claimed and expires back to its player.
   */
  seatedEntriesOf(roundIdBytes, stakeMsat, { played = false } = {}) {
    const all = this.entriesOf(roundIdBytes);
    if (stakeMsat === 0n) return all;
    const locked = all.filter(({ entryId }) => !!this.stakeSeen(entryId) || !!this.stakeLock(entryId));
    // `played` (kanban #1544) keeps of the seats only the entries whose stake is SEEN - the seats themselves are the same as the door's (#1588)
    const playedOnly = (list) => played ? list.filter(({ entryId }) => !!this.stakeSeen(entryId)) : list;
    const players = this.#headToHeadPlayers(roundIdBytes);
    if (!players) return playedOnly(locked);
    const order = new Map(this.db.prepare('SELECT entry_id FROM entries WHERE round_id = ? ORDER BY rowid').all(roundIdBytes)
      .map((r, i) => [Buffer.from(r.entry_id).toString('hex'), i]));
    const at = ({ entryId }) => order.get(Buffer.from(entryId).toString('hex'));
    const seated = new Set([...locked].sort((x, y) => at(x) - at(y)).slice(0, players).map(({ entryId }) => Buffer.from(entryId).toString('hex')));
    return playedOnly(locked.filter(({ entryId }) => seated.has(Buffer.from(entryId).toString('hex'))));   // answered in entry id order, as before
  }

  /** The game's players when the round is a hosted head-to-head game's, else null (kanban #1588). */
  #headToHeadPlayers(roundIdBytes) {
    const row = this.get(roundIdBytes);
    if (!row) return null;
    let g;
    try { g = pluginForRound(decodeRoundContract(new Uint8Array(row.contract)), this.plugins); } catch { return null; }
    return g.ok && g.headToHead ? g.plugin.manifest.players : null;
  }

  /**
   * KEEP A SIGNED RESULT. `bytes` is the protocol's signed record - the body
   * this node encoded and the signature over its id - stored whole, so what is
   * served later is what was signed and not a re-encoding of it.
   *
   * One signer node, one result: a node that signed twice would be equivocating, and
   * the primary key says so rather than keeping both.
   */
  putResult(roundIdBytes, entryIdBytes, nodePubkey, resultIdBytes, bytes) {
    return this.db.prepare(
      'INSERT OR IGNORE INTO results (round_id, entry_id, node_pubkey, result_id, bytes, seen_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?)')
      .run(roundIdBytes, entryIdBytes, nodePubkey, resultIdBytes, bytes, this.now()).changes;
  }

  /** The result this node keeps for one signer of a run, or null. */
  heldResult(roundIdBytes, entryIdBytes, nodePubkey) {
    const r = this.db.prepare('SELECT result_id, bytes FROM results WHERE round_id = ? AND entry_id = ? AND node_pubkey = ?')
      .get(roundIdBytes, entryIdBytes, nodePubkey);
    return r ? { resultId: new Uint8Array(r.result_id), bytes: new Uint8Array(r.bytes) } : null;
  }

  /** Which run a mark belongs to, so a receipt can say what it completed. */
  runOf(checkpointIdBytes) {
    const row = this.db.prepare(
      'SELECT round_id, entry_id FROM checkpoints WHERE checkpoint_id = ?').get(checkpointIdBytes);
    return row
      ? { roundId: new Uint8Array(row.round_id), entryId: new Uint8Array(row.entry_id) }
      : null;
  }

  /** Has this node already signed a result for that run? */
  hasResult(roundIdBytes, entryIdBytes, nodePubkey) {
    return !!this.db.prepare(
      'SELECT 1 FROM results WHERE round_id = ? AND entry_id = ? AND node_pubkey = ?')
      .get(roundIdBytes, entryIdBytes, nodePubkey);
  }

  // (NO HOLD STORE: putHold, dropHold, hold, holdsOf and holdsInState were the hold invoice's record of a stake - the
  // withdrawn Lightning custody's, §23.6; cut 2b RULED 2026-09-25. A store from before keeps its `holds` table, unread.)

  /**
   * 23.1 STEP 5, THIS NODE'S HALF: the stake was seen paid and held. Written
   * once, the first time Lightning showed it, so later play does not ask again.
   */
  /**
   * WHEN THE 900-TICK START WINDOW OPENS: the tick this node saw the stake HELD (§23.1 step 5).
   *
   * MEASURED on the live Daily before this existed: a paid browser join reached its first mark 4320 ticks
   * after `joinTick + 900`, and 3803 of those ticks - 88% - were the round's clock running while the player
   * waited to pay the invoice. Only 188 fell after the stake was held. So the window was expiring on money,
   * not on driving, and it forfeited a stake that had been paid.
   *
   * `stake_seen.seen_ms` is already written once, the first time Lightning showed the hold, so the origin is
   * read rather than invented. A round with no stake to wait for - a free round - has no such row, and its
   * join tick IS when it can drive: those keep the old origin exactly.
   */
  startWindowOrigin(entryIdBytes, joined, contract) {
    const reached = this.stakeSeenTick(entryIdBytes);
    if (reached === null) return { originTick: joined.joinTick, originName: 'join' };
    // never before the join: a stake cannot be held before the entry that names it
    return { originTick: Math.max(joined.joinTick, reached), originName: 'stake held' };
  }


  putStakeSeen({ entryId, paidMsat }) {
    this.db.prepare('INSERT OR IGNORE INTO stake_seen (entry_id, paid_msat, seen_ms) VALUES (?, ?, ?)')
      .run(Buffer.from(entryId), String(paidMsat), this.now());
    // AND THE TICK THE PLAYER HAD REACHED BY THEN, which is where §15's start window opens. Written in the
    // same breath and once, because it is a fact about this instant: any later reading would be a different
    // tick. The highest tick already RECEIVED - not one the client asserts - so it is pinned by the same
    // replay as the rest of the transcript. A player who has sent nothing yet gets 0, which is where its run
    // begins anyway, so nothing changes for a free round or for an entry that never played.
    let reached = 0;
    try {
      const last = this.db.prepare('SELECT bytes FROM batches WHERE entry_id = ? ORDER BY seq DESC LIMIT 1')
        .get(Buffer.from(entryId));
      if (last) {
        const b = decodeInputBatch(new Uint8Array(last.bytes));
        const ticks = batchTicks(b);
        if (ticks.length) reached = ticks[ticks.length - 1];
      }
    } catch { reached = 0; }
    this.db.prepare('INSERT OR IGNORE INTO stake_seen_tick (entry_id, tick, seen_ms) VALUES (?, ?, ?)')
      .run(Buffer.from(entryId), reached, this.now());
  }

  /** The tick the player had reached when this node saw the stake held, or null if it never did. */
  stakeSeenTick(entryIdBytes) {
    const row = this.db.prepare('SELECT tick FROM stake_seen_tick WHERE entry_id = ?').get(Buffer.from(entryIdBytes));
    return row ? row.tick : null;
  }

  stakeSeen(entryIdBytes) {
    const row = this.db.prepare('SELECT paid_msat, seen_ms FROM stake_seen WHERE entry_id = ?')
      .get(Buffer.from(entryIdBytes));
    return row ? { paidMsat: BigInt(row.paid_msat), seenMs: row.seen_ms } : null;
  }

  /** The hold's HTLC expiry height, written once, when it was first seen paid (M3.3-30). */
  putHoldExpiry({ entryId, expiryHeight }) {
    this.db.prepare('INSERT OR IGNORE INTO hold_expiry (entry_id, expiry_height, seen_ms) VALUES (?, ?, ?)')
      .run(Buffer.from(entryId), expiryHeight, this.now());
  }

  holdExpiry(entryIdBytes) {
    const row = this.db.prepare('SELECT expiry_height FROM hold_expiry WHERE entry_id = ?')
      .get(Buffer.from(entryIdBytes));
    return row ? row.expiry_height : null;
  }

  /** When the invoice this node issued runs out unpaid - written once, at issue (M3.3-30). */
  putInvoiceExpiry({ entryId, expiresMs }) {
    this.db.prepare('INSERT OR IGNORE INTO invoice_expiry (entry_id, expires_ms) VALUES (?, ?)')
      .run(Buffer.from(entryId), expiresMs);
  }

  invoiceExpiry(entryIdBytes) {
    const row = this.db.prepare('SELECT expires_ms FROM invoice_expiry WHERE entry_id = ?')
      .get(Buffer.from(entryIdBytes));
    return row ? Number(row.expires_ms) : null;
  }

  /**
   * WHAT THIS NODE BELIEVES ABOUT A ROUND'S PAYOUT, and how it changed.
   *
   * One row per round, written before the spend leaves, the way a hold's
   * ACTING is. `txid` is null until a chain took it.
   */
  putPayout({ roundId, tableId, state, why, txid = null, raw = null,
    owedSats = null, owedCount = null }) {
    const had = this.db.prepare(
      'SELECT txid, raw, owed_sats, owed_count FROM payouts WHERE round_id = ?')
      .get(Buffer.from(roundId));
    this.db.prepare(
      'INSERT OR REPLACE INTO payouts (round_id, table_id, state, why, txid, raw, updated_ms, '
      + 'owed_sats, owed_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(roundId), Buffer.from(tableId), state, why,
        txid ? Buffer.from(txid) : (had && had.txid) || null,
        raw ? Buffer.from(raw) : (had && had.raw) || null,
        this.now(),
        owedSats === null ? (had ? had.owed_sats : 0) : Number(owedSats),
        owedCount === null ? (had ? had.owed_count : 0) : Number(owedCount));
    return state;
  }

  payout(roundIdBytes) {
    const row = this.db.prepare(
      'SELECT table_id, state, why, txid, raw, updated_ms, owed_sats, owed_count '
      + 'FROM payouts WHERE round_id = ?')
      .get(Buffer.from(roundIdBytes));
    if (!row) return null;
    return {
      tableId: new Uint8Array(row.table_id),
      state: row.state,
      why: row.why,
      txid: row.txid ? new Uint8Array(row.txid) : null,
      raw: row.raw ? new Uint8Array(row.raw) : null,
      updatedMs: row.updated_ms,
      owedSats: BigInt(row.owed_sats || 0),
      owedCount: row.owed_count || 0,
    };
  }

  /**
   * THIS SIGNER NODE'S NONCE PAIR FOR A ROUND'S SPEND, KEPT WHERE A RESTART CANNOT
   * REACH IT.
   *
   * `PoolSigning` used a Map and letter 19 measured the cost: after a restart
   * five signer nodes minted fresh nonces for a spend they had already signed, which
   * is a second signature over the same input and a second txid. The row is
   * the memory now.
   *
   * Scalars in, scalars out - 32 big-endian bytes each, the ciphersuite's own
   * serialisation - so nothing here decides how a secret is written down.
   */
  putPoolNonce({ roundId, signerNodeId, sighash, hiding, binding, commitHiding, commitBinding,
    spentList = null, spentShare = null, attempt = 0 }) {
    this.db.prepare(
      'INSERT OR REPLACE INTO pool_nonces (round_id, signer_node_id, sighash, hiding, binding, '
      + 'commit_hiding, commit_binding, spent_list, spent_share, attempt, updated_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(roundId), String(signerNodeId), Buffer.from(sighash),
        hiding === null ? null : Buffer.from(hiding),
        binding === null ? null : Buffer.from(binding),
        Buffer.from(commitHiding), Buffer.from(commitBinding),
        spentList === null ? null : Buffer.from(spentList),
        spentShare === null ? null : Buffer.from(spentShare),
        attempt, this.now());
    return true;
  }

  /** What this signer node committed to for that round, or null if it committed to nothing. */
  poolNonce(roundIdBytes) {
    const row = this.db.prepare(
      'SELECT signer_node_id, sighash, hiding, binding, commit_hiding, commit_binding, '
      + 'spent_list, spent_share, attempt FROM pool_nonces WHERE round_id = ?')
      .get(Buffer.from(roundIdBytes));
    if (!row) return null;
    return {
      signerNodeId: row.signer_node_id,
      sighash: new Uint8Array(row.sighash),
      hiding: row.hiding ? new Uint8Array(row.hiding) : null,
      binding: row.binding ? new Uint8Array(row.binding) : null,
      commitHiding: new Uint8Array(row.commit_hiding),
      commitBinding: new Uint8Array(row.commit_binding),
      spentList: row.spent_list ? new Uint8Array(row.spent_list) : null,
      spentShare: row.spent_share ? new Uint8Array(row.spent_share) : null,
      attempt: Number(row.attempt || 0),
    };
  }

  /**
   * THE COMMITTEE'S OWN KEY, PER EPOCH (M3.3 item 14).
   *
   * `putEpoch` is a merge: the row is written when this signer node deals, again as
   * contributions arrive, and once more when the key is finished, and none of
   * those may wipe what the others put there. The share in particular is
   * written once and must survive every later touch.
   */
  putEpoch({ epochId, signerNodes, mine = null, share = null, signerNodeNo = null,
    groupPubkey = null, negated = null }) {
    const had = this.db.prepare(
      'SELECT mine, share, signer_node_no, group_pubkey, negated FROM dkg_epochs WHERE epoch_id = ?')
      .get(Buffer.from(epochId));
    const flat = new Uint8Array(signerNodes.length * 32);
    signerNodes.forEach((k, i) => flat.set(k, i * 32));
    // AN EPOCH'S OWN CONTRIBUTION IS ON THE DISK BEFORE IT IS HANDED OUT (kanban #1243)
    durably(this.db, () => this.db.prepare(
      'INSERT OR REPLACE INTO dkg_epochs (epoch_id, signer_nodes, mine, share, signer_node_no, '
      + 'group_pubkey, negated, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(epochId), Buffer.from(flat),
        mine ? Buffer.from(mine) : (had && had.mine) || null,
        share ? Buffer.from(share) : (had && had.share) || null,
        signerNodeNo === null ? (had ? had.signer_node_no : null) : signerNodeNo,
        groupPubkey ? Buffer.from(groupPubkey) : (had && had.group_pubkey) || null,
        negated === null ? (had ? had.negated : 0) : (negated ? 1 : 0),
        this.now()));
    return true;
  }

  /** The committee of the newest key this node holds a share of, or null. */
  latestSharedEpochSignerNodes() {
    const row = this.db.prepare(
      'SELECT signer_nodes FROM dkg_epochs WHERE share IS NOT NULL ORDER BY updated_ms DESC LIMIT 1').get();
    if (!row) return null;
    const flat = new Uint8Array(row.signer_nodes);
    const signerNodes = [];
    for (let at = 0; at < flat.length; at += 32) signerNodes.push(flat.slice(at, at + 32));
    return signerNodes;
  }

  /** What this node holds for an epoch, or null if it has never seen one. */
  epoch(epochIdBytes) {
    const row = this.db.prepare(
      'SELECT signer_nodes, mine, share, signer_node_no, group_pubkey, negated FROM dkg_epochs WHERE epoch_id = ?')
      .get(Buffer.from(epochIdBytes));
    if (!row) return null;
    const flat = new Uint8Array(row.signer_nodes);
    const signerNodes = [];
    for (let at = 0; at < flat.length; at += 32) signerNodes.push(flat.subarray(at, at + 32));
    return {
      signerNodes,
      mine: row.mine ? new Uint8Array(row.mine) : null,
      share: row.share ? new Uint8Array(row.share) : null,
      signerNodeNo: row.signer_node_no === null ? null : row.signer_node_no,
      groupPubkey: row.group_pubkey ? new Uint8Array(row.group_pubkey) : null,
      negated: !!row.negated,
    };
  }

  /**
   * ONE CONTRIBUTION PER DEALER PER EPOCH, and the primary key is the rule.
   *
   * A signer node that deals twice - after seeing everybody else's commitments - is
   * how the group key would be steered. `INSERT OR IGNORE` means the FIRST
   * deal stands and the second writes nothing, which is the same shape the
   * ticks already use for a repeat.
   */
  rememberContribution({ epochId, dealer, bytes }) {
    return this.db.prepare(
      'INSERT OR IGNORE INTO dkg_contributions (epoch_id, dealer, bytes, accepted_ms) '
      + 'VALUES (?, ?, ?, ?)')
      .run(Buffer.from(epochId), Buffer.from(dealer), Buffer.from(bytes), this.now()).changes > 0;
  }

  /** Every contribution this node accepted for an epoch, in dealer order. */
  contributionsOf(epochIdBytes) {
    return this.db.prepare(
      'SELECT dealer, bytes FROM dkg_contributions WHERE epoch_id = ? ORDER BY dealer')
      .all(Buffer.from(epochIdBytes))
      .map((r) => ({ dealer: new Uint8Array(r.dealer), bytes: new Uint8Array(r.bytes) }));
  }

  /** Every payout this node was in the middle of, across every round. */
  payoutsInState(state) {
    return this.db.prepare('SELECT round_id FROM payouts WHERE state = ? ORDER BY round_id')
      .all(state)
      .map((r) => ({ roundId: new Uint8Array(r.round_id), ...this.payout(new Uint8Array(r.round_id)) }));
  }

  /** One signer node's signed posting of a run's transcript; one per signer node (P2). */
  putPosting(roundIdBytes, entryIdBytes, signerNodePubkey, bytes) {
    return this.db.prepare(
      'INSERT OR IGNORE INTO postings (round_id, entry_id, signer_node_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?)')
      .run(roundIdBytes, entryIdBytes, signerNodePubkey, bytes, this.now()).changes;
  }

  /** Every signed posting this node holds for a run, its own included, with when each arrived. */
  postings(roundIdBytes, entryIdBytes) {
    return this.db.prepare(
      'SELECT signer_node_pubkey, bytes, seen_ms FROM postings WHERE round_id = ? AND entry_id = ? ORDER BY signer_node_pubkey')
      .all(roundIdBytes, entryIdBytes)
      .map((r) => ({ signerNodePubkey: new Uint8Array(r.signer_node_pubkey), bytes: new Uint8Array(r.bytes), seenMs: Number(r.seen_ms) }));
  }

  /**
   * One signer node's signed re-run of a suspended result; one per signer node (13A). A re-run counts only if signed
   * within 5 s of this seat's clock when it came (§13A, WINDOW-10-SPEC), so a fresh one that counts replaces a held one;
   * one that does not count is kept only where none is held.
   */
  putRerun(roundIdBytes, entryIdBytes, signerNodePubkey, bytes) {
    const now = this.now();
    const counted = (b, seen) => { try { return withinTolerance(decodeRerunResult(splitSignedRerun(b).body).signedAtMs, seen); } catch { return false; } };
    // A HELD ONE THAT COUNTED IS KEPT: a later copy - this seat's own, signed again for a peer - must not move its arrival.
    const held = this.db.prepare('SELECT bytes, seen_ms FROM reruns WHERE round_id = ? AND entry_id = ? AND signer_node_pubkey = ?')
      .get(roundIdBytes, entryIdBytes, signerNodePubkey);
    const replace = !!held && !counted(new Uint8Array(held.bytes), held.seen_ms) && counted(bytes, now);
    return this.db.prepare(
      `INSERT OR ${replace ? 'REPLACE' : 'IGNORE'} INTO reruns (round_id, entry_id, signer_node_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?)`)
      .run(roundIdBytes, entryIdBytes, signerNodePubkey, bytes, now).changes;
  }

  /**
   * A SEAT'S FINAL SIGNATURE, AS IT ARRIVED (§13A, WINDOW-10-SPEC): `fault` is protocol finalSigFault's answer at this
   * seat's clock now. One that counts is kept (the latest per seat and run); one refused for its time is kept as
   * evidence against its signer; anything else is dropped. Returns 'kept', 'evidence' or 'refused'.
   */
  putFinalSig(roundIdBytes, entryIdBytes, x, bytes, fault, seenMs = this.now()) {
    if (!fault) {
      this.db.prepare('INSERT OR REPLACE INTO final_sigs (round_id, entry_id, run_id, signer_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(roundIdBytes, entryIdBytes, x.runId, x.signerPubkey, bytes, seenMs);
      return 'kept';
    }
    if (fault.evidence && fault.x) {
      this.db.prepare('INSERT OR IGNORE INTO final_sig_evidence (round_id, entry_id, signer_pubkey, bytes, seen_ms, why) VALUES (?, ?, ?, ?, ?, ?)')
        .run(roundIdBytes, entryIdBytes, fault.x.signerPubkey, bytes, seenMs, fault.why);
      return 'evidence';
    }
    return 'refused';
  }

  /** The FINAL signatures this seat holds on one run, each with when it came. */
  finalSigs(roundIdBytes, entryIdBytes, runIdBytes) {
    return this.db.prepare('SELECT signer_pubkey, bytes, seen_ms FROM final_sigs WHERE round_id = ? AND entry_id = ? AND run_id = ? ORDER BY signer_pubkey')
      .all(roundIdBytes, entryIdBytes, runIdBytes)
      .map((r) => ({ signerPubkey: new Uint8Array(r.signer_pubkey), bytes: new Uint8Array(r.bytes), seenMs: Number(r.seen_ms) }));
  }

  /** The seats whose FINAL signature on any entry of a round this seat holds, node keys hex (§5A.3 "Stalled in its rounds", kanban #1066). */
  finalSigners(roundIdBytes) {
    return this.db.prepare('SELECT DISTINCT signer_pubkey FROM final_sigs WHERE round_id = ?').all(Buffer.from(roundIdBytes)).map((r) => Buffer.from(r.signer_pubkey).toString('hex'));
  }

  /** Every FINAL signature this seat holds for one entry, on any run: GET /audit-run hands them on, the arbitration set reads what settled off them. */
  entryFinalSigs(roundIdBytes, entryIdBytes) {
    return this.db.prepare('SELECT bytes FROM final_sigs WHERE round_id = ? AND entry_id = ? ORDER BY run_id, signer_pubkey').all(roundIdBytes, entryIdBytes).map((r) => new Uint8Array(r.bytes));
  }

  /**
   * EVERY FINAL SIGNATURE THAT CAME BETWEEN TWO TIMES, by round (who served a round in the last 24 h): rows that
   * arrived in [fromMs, toMs + 5 s) - a FINAL counts only when signed within 5 s of its arrival, so its own time is then within the
   * window or just past it; the protocol's servedNodes reads the signed time itself.
   */
  finalSigsBetween(fromMs, toMs) {
    const byRound = new Map();
    for (const r of this.db.prepare('SELECT round_id, bytes FROM final_sigs WHERE seen_ms >= ? AND seen_ms < ? ORDER BY round_id')
      .all(Number(fromMs) - 5000, Number(toMs) + 5000)) {
      const k = toHex(r.round_id);
      if (!byRound.has(k)) byRound.set(k, { roundId: new Uint8Array(r.round_id), finals: [] });
      byRound.get(k).finals.push(new Uint8Array(r.bytes));
    }
    return [...byRound.values()];
  }

  /** The FINAL signatures refused for their time (§13A rule 3), as evidence. */
  finalSigEvidence(roundIdBytes, entryIdBytes) {
    return this.db.prepare('SELECT signer_pubkey, bytes, seen_ms, why FROM final_sig_evidence WHERE round_id = ? AND entry_id = ? ORDER BY seen_ms')
      .all(roundIdBytes, entryIdBytes)
      .map((r) => ({ signerPubkey: new Uint8Array(r.signer_pubkey), bytes: new Uint8Array(r.bytes), seenMs: Number(r.seen_ms), why: r.why }));
  }

  /** Every signed re-run this node holds for a run, its own included. */
  reruns(roundIdBytes, entryIdBytes) {
    return this.db.prepare(
      'SELECT signer_node_pubkey, bytes, seen_ms FROM reruns WHERE round_id = ? AND entry_id = ? ORDER BY signer_node_pubkey')
      .all(roundIdBytes, entryIdBytes)
      .map((r) => ({ signerNodePubkey: new Uint8Array(r.signer_node_pubkey), bytes: new Uint8Array(r.bytes), seenMs: Number(r.seen_ms) }));
  }

  /** A slash proof this node filed, with its evidence; one per accused signer node per run. */
  putSlashProof(roundIdBytes, entryIdBytes, nodePubkey, proofId, bytes) {
    return this.db.prepare(
      'INSERT OR IGNORE INTO slash_proofs (round_id, entry_id, node_pubkey, proof_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roundIdBytes, entryIdBytes, nodePubkey, proofId, bytes, this.now()).changes;
  }

  /** EVERY slash proof this node filed, newest first (the arbitration set's intake, GET /slashes). */
  allSlashProofs({ limit = 500 } = {}) {
    return this.db.prepare('SELECT round_id, entry_id, node_pubkey, proof_id, seen_ms FROM slash_proofs ORDER BY seen_ms DESC LIMIT ?').all(limit)
      .map((r) => ({ roundId: new Uint8Array(r.round_id), entryId: new Uint8Array(r.entry_id), nodePubkey: new Uint8Array(r.node_pubkey),
        proofId: new Uint8Array(r.proof_id), seenMs: Number(r.seen_ms) }));
  }

  /** Every slash proof this node filed for a run. */
  slashProofs(roundIdBytes, entryIdBytes) {
    return this.db.prepare(
      'SELECT node_pubkey, proof_id, bytes, seen_ms FROM slash_proofs WHERE round_id = ? AND entry_id = ? ORDER BY node_pubkey')
      .all(roundIdBytes, entryIdBytes)
      .map((r) => ({ nodePubkey: new Uint8Array(r.node_pubkey), proofId: new Uint8Array(r.proof_id),
        bytes: new Uint8Array(r.bytes), seenMs: Number(r.seen_ms) }));
  }

  /** A slash proof against one signer of an agreed re-run (slice C2c); one per signer, a second is ignored. */
  putRerunSlashProof(roundIdBytes, entryIdBytes, nodePubkey, proofId, bytes) {
    return this.db.prepare(
      'INSERT OR IGNORE INTO rerun_slash_proofs (round_id, entry_id, node_pubkey, proof_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roundIdBytes, entryIdBytes, nodePubkey, proofId, bytes, this.now()).changes;
  }

  /** EVERY proof this node filed against a re-run's signers, newest first. */
  allRerunSlashProofs({ limit = 500 } = {}) {
    return this.db.prepare('SELECT proof_id, seen_ms FROM rerun_slash_proofs ORDER BY seen_ms DESC LIMIT ?').all(limit)
      .map((r) => ({ proofId: new Uint8Array(r.proof_id), seenMs: Number(r.seen_ms) }));
  }

  /** Every slash proof this node filed against the signers of a run's agreed re-run. */
  rerunSlashProofs(roundIdBytes, entryIdBytes) {
    return this.db.prepare(
      'SELECT node_pubkey, proof_id, bytes, seen_ms FROM rerun_slash_proofs WHERE round_id = ? AND entry_id = ? ORDER BY node_pubkey')
      .all(roundIdBytes, entryIdBytes)
      .map((r) => ({ nodePubkey: new Uint8Array(r.node_pubkey), proofId: new Uint8Array(r.proof_id),
        bytes: new Uint8Array(r.bytes), seenMs: Number(r.seen_ms) }));
  }

  /** A slash proof against a contradicted AUDIT (§13A.1, kanban #724, #725); one per auditor and round, a second is ignored. */
  putAuditSlashProof(roundIdBytes, entryIdBytes, nodePubkey, proofId, bytes) {
    return this.db.prepare(
      'INSERT OR IGNORE INTO audit_slash_proofs (round_id, node_pubkey, entry_id, proof_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roundIdBytes, nodePubkey, entryIdBytes, proofId, bytes, this.now()).changes;
  }

  /** Every slash proof this node filed against a round's AUDITs, or all of them (newest first) for GET /slashes. */
  auditSlashProofs(roundIdBytes = null, { limit = 500 } = {}) {
    const rows = roundIdBytes
      ? this.db.prepare('SELECT round_id, node_pubkey, entry_id, proof_id, bytes, seen_ms FROM audit_slash_proofs WHERE round_id = ? ORDER BY node_pubkey').all(roundIdBytes)
      : this.db.prepare('SELECT round_id, node_pubkey, entry_id, proof_id, bytes, seen_ms FROM audit_slash_proofs ORDER BY seen_ms DESC LIMIT ?').all(limit);
    return rows.map((r) => ({ roundId: new Uint8Array(r.round_id), nodePubkey: new Uint8Array(r.node_pubkey), entryId: new Uint8Array(r.entry_id),
      proofId: new Uint8Array(r.proof_id), bytes: new Uint8Array(r.bytes), seenMs: Number(r.seen_ms) }));
  }

  /** A SECOND RESULT OF ONE SIGNER ABOUT ONE RUN, with the first (5A.3 row 1, kanban #986): kept once per (round, entry, node). */
  putDoubleResult(roundIdBytes, entryIdBytes, nodePubkey, first, second) {
    return this.db.prepare('INSERT OR IGNORE INTO double_results (round_id, entry_id, node_pubkey, first, second, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roundIdBytes, entryIdBytes, nodePubkey, first, second, this.now()).changes;
  }

  /** The proof filed from a kept pair: once, so two passes publish it once. */
  fileDoubleResult(roundIdBytes, entryIdBytes, nodePubkey, proofId, bytes) {
    return this.db.prepare('UPDATE double_results SET proof_id = ?, bytes = ? WHERE round_id = ? AND entry_id = ? AND node_pubkey = ? AND proof_id IS NULL')
      .run(proofId, bytes, roundIdBytes, entryIdBytes, nodePubkey).changes;
  }

  /** Every pair kept for a run, filed or not. */
  doubleResults(roundIdBytes, entryIdBytes) {
    return this.db.prepare('SELECT node_pubkey, first, second, proof_id, bytes FROM double_results WHERE round_id = ? AND entry_id = ? ORDER BY node_pubkey')
      .all(roundIdBytes, entryIdBytes)
      .map((r) => ({ nodePubkey: new Uint8Array(r.node_pubkey), first: new Uint8Array(r.first), second: new Uint8Array(r.second),
        proofId: r.proof_id ? new Uint8Array(r.proof_id) : null, bytes: r.bytes ? new Uint8Array(r.bytes) : null }));
  }

  /** The runs with a pair not filed yet, seen since `sinceMs`: a pair that names no bond for that long stays kept, and unfiled. */
  unfiledDoubleResults(sinceMs) {
    return this.db.prepare('SELECT DISTINCT round_id, entry_id FROM double_results WHERE proof_id IS NULL AND seen_ms >= ?').all(sinceMs)
      .map((r) => ({ roundId: new Uint8Array(r.round_id), entryId: new Uint8Array(r.entry_id) }));
  }

  /** Every proof of two results this node filed for a round, or all of them (newest first) for GET /slashes. */
  doubleSlashProofs(roundIdBytes = null, { limit = 500 } = {}) {
    const rows = roundIdBytes
      ? this.db.prepare('SELECT round_id, entry_id, node_pubkey, proof_id, bytes, seen_ms FROM double_results WHERE round_id = ? AND proof_id IS NOT NULL ORDER BY node_pubkey').all(roundIdBytes)
      : this.db.prepare('SELECT round_id, entry_id, node_pubkey, proof_id, bytes, seen_ms FROM double_results WHERE proof_id IS NOT NULL ORDER BY seen_ms DESC LIMIT ?').all(limit);
    return rows.map((r) => ({ roundId: new Uint8Array(r.round_id), entryId: new Uint8Array(r.entry_id), nodePubkey: new Uint8Array(r.node_pubkey),
      proofId: new Uint8Array(r.proof_id), bytes: new Uint8Array(r.bytes), seenMs: Number(r.seen_ms) }));
  }

  /** A proof of a false table (§5A.3, kanban #1040): kept once by its id, so two passes publish it once. */
  fileTableProof(roundIdBytes, nodePubkey, proofId, bytes) {
    return this.db.prepare('INSERT OR IGNORE INTO table_slash_proofs (proof_id, round_id, node_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?)')
      .run(proofId, roundIdBytes, nodePubkey, bytes, this.now()).changes;
  }

  /** Every proof of a false table this node filed for a round, or all of them (newest first) for GET /slashes. */
  tableSlashProofs(roundIdBytes = null, { limit = 500 } = {}) {
    const rows = roundIdBytes
      ? this.db.prepare('SELECT round_id, node_pubkey, proof_id, bytes, seen_ms FROM table_slash_proofs WHERE round_id = ? ORDER BY node_pubkey').all(roundIdBytes)
      : this.db.prepare('SELECT round_id, node_pubkey, proof_id, bytes, seen_ms FROM table_slash_proofs ORDER BY seen_ms DESC LIMIT ?').all(limit);
    return rows.map((r) => ({ roundId: new Uint8Array(r.round_id), nodePubkey: new Uint8Array(r.node_pubkey), proofId: new Uint8Array(r.proof_id), bytes: new Uint8Array(r.bytes), seenMs: Number(r.seen_ms) }));
  }

  /** A proof of a named claim's offence (§5A.3 rows (a), (b), kanban #1044 B1): kept once by its id. */
  fileNamedClaimProof(roundIdBytes, nodePubkey, row, proofId, bytes) {
    return this.db.prepare('INSERT OR IGNORE INTO named_claim_proofs (proof_id, round_id, node_pubkey, row, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(proofId, roundIdBytes, nodePubkey, row, bytes, this.now()).changes;
  }

  /** Every proof of a named claim this node filed for a round, or all of them (newest first). */
  namedClaimProofs(roundIdBytes = null, { limit = 500 } = {}) {
    const rows = roundIdBytes
      ? this.db.prepare('SELECT round_id, node_pubkey, row, proof_id, bytes, seen_ms FROM named_claim_proofs WHERE round_id = ? ORDER BY node_pubkey').all(roundIdBytes)
      : this.db.prepare('SELECT round_id, node_pubkey, row, proof_id, bytes, seen_ms FROM named_claim_proofs ORDER BY seen_ms DESC LIMIT ?').all(limit);
    return rows.map((r) => ({ roundId: new Uint8Array(r.round_id), nodePubkey: new Uint8Array(r.node_pubkey), row: Number(r.row), proofId: new Uint8Array(r.proof_id),
      bytes: new Uint8Array(r.bytes), seenMs: Number(r.seen_ms) }));
  }

  /** The finished-session count kept for this round in a federation (kanban #1044 B1): at POST /round or at its first verified lock (#1138 1), the lower stays. */
  keepFundingSessionFloor(roundIdBytes, federationHex, floor) {
    return this.db.prepare('INSERT INTO funding_session_floors (round_id, federation_id, floor) VALUES (?, ?, ?) '
      + 'ON CONFLICT (round_id, federation_id) DO UPDATE SET floor = MIN(floor, excluded.floor) WHERE excluded.floor < floor')
      .run(Buffer.from(roundIdBytes), String(federationHex).toLowerCase(), Number(floor)).changes;
  }

  fundingSessionFloor(roundIdBytes, federationHex) {
    const r = this.db.prepare('SELECT floor FROM funding_session_floors WHERE round_id = ? AND federation_id = ?').get(Buffer.from(roundIdBytes), String(federationHex).toLowerCase());
    return r ? Number(r.floor) : null;
  }

  markSettlementSuspect(roundIdBytes) {
    this.db.prepare('INSERT OR IGNORE INTO settlement_suspects (round_id, seen_ms) VALUES (?, ?)').run(Buffer.from(roundIdBytes), this.now());
  }

  /** The rounds marked since `sinceMs`. */
  settlementSuspects(sinceMs) {
    return this.db.prepare('SELECT round_id FROM settlement_suspects WHERE seen_ms >= ?').all(sinceMs).map((r) => new Uint8Array(r.round_id));
  }

  /** Every handout this signer node accepted for one round: its id and bytes. */
  handoutsOf(roundIdBytes) {
    return this.db.prepare('SELECT handout_id, bytes FROM handouts WHERE round_id = ?').all(Buffer.from(roundIdBytes))
      .map((r) => ({ id: new Uint8Array(r.handout_id), bytes: new Uint8Array(r.bytes) }));
  }

  /** §23.2 REFUSED: a lock for a round this signer node refuses, never entered, kept under its handout's id.
   *  THE FIRST KEPT LOCK STANDS (kanban #1489): the handout's A0, the player's refund key and the round's claim key are public,
   *  so anyone can lock 1 sat with them; INSERT OR REPLACE let that lock take the player's row, and the forfeit returned it. */
  putRefusedLock({ handoutId, roundId, outpoint, fields, contractId }) {
    this.db.prepare('INSERT OR IGNORE INTO refused_locks (handout_id, round_id, outpoint, fields, contract_id, kept_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(handoutId), Buffer.from(roundId), `${Buffer.from(outpoint.txid).toString('hex')}:${outpoint.outIdx}`,
        JSON.stringify(fields), contractId, this.now());
  }

  refusedLock(handoutIdBytes) {
    const r = this.db.prepare('SELECT round_id, outpoint, fields, contract_id, kept_ms FROM refused_locks WHERE handout_id = ?').get(Buffer.from(handoutIdBytes));
    return r ? { roundId: new Uint8Array(r.round_id), outpoint: r.outpoint, fields: JSON.parse(r.fields), contractId: r.contract_id, keptMs: Number(r.kept_ms) } : null;
  }

  /** The refused-round locks of one round that refund to `refundHex`, shaped as stakeLocksFor's (entryId = the handout id). */
  refusedLocksFor(roundIdBytes, refundHex) {
    return this.db.prepare('SELECT handout_id, outpoint, fields, contract_id FROM refused_locks WHERE round_id = ?')
      .all(Buffer.from(roundIdBytes))
      .map((r) => ({ entryId: Buffer.from(r.handout_id).toString('hex'), outpoint: r.outpoint, fields: JSON.parse(r.fields), contractId: r.contract_id, refused: true }))
      .filter((l) => String(l.fields.refundPk).toLowerCase() === String(refundHex).toLowerCase());
  }

  /** A stake lock this signer node verified: the handed contract (JSON), its id, its outpoint. */
  putStakeLock({ entryId, roundId, outpoint, fields, contractId }) {
    this.db.prepare('INSERT OR REPLACE INTO stake_locks (entry_id, round_id, outpoint, fields, contract_id, verified_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(entryId), Buffer.from(roundId), `${Buffer.from(outpoint.txid).toString('hex')}:${outpoint.outIdx}`,
        JSON.stringify(fields), contractId, this.now());
  }

  stakeLock(entryIdBytes) {
    const r = this.db.prepare('SELECT outpoint, fields, contract_id, verified_ms FROM stake_locks WHERE entry_id = ?').get(Buffer.from(entryIdBytes));
    return r ? { outpoint: r.outpoint, fields: JSON.parse(r.fields), contractId: r.contract_id, verifiedMs: Number(r.verified_ms) } : null;
  }

  /**
   * THE VERIFIED LOCKS OF ONE ROUND THAT REFUND TO `refundHex` (66 hex, the
   * lock's refund_pk): what a player who kept only their seed asks for to find
   * the lock to refund (W5a). Public, as every lock in the federation is.
   */
  stakeLocksFor(roundIdBytes, refundHex) {
    return this.db.prepare('SELECT entry_id, outpoint, fields, contract_id FROM stake_locks WHERE round_id = ?')
      .all(Buffer.from(roundIdBytes))
      .map((r) => ({ entryId: Buffer.from(r.entry_id).toString('hex'), outpoint: r.outpoint, fields: JSON.parse(r.fields), contractId: r.contract_id }))
      .filter((l) => String(l.fields.refundPk).toLowerCase() === String(refundHex).toLowerCase());
  }

  /** The committee's forfeit of a qualifier's lock, as this signer node keeps it (W5b). */
  /** §15: this signer node holds the entry FORFEIT for a late start - its first mark, kept whole, is after the line. */
  putStartForfeit({ entryId, roundId, markTick, lastTick, mark, why }) {
    this.db.prepare('INSERT OR IGNORE INTO start_forfeits (entry_id, round_id, mark_tick, last_tick, mark, why, decided_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)').run(entryId, roundId, markTick, lastTick, mark, why, this.now());
    this.noteEvidenceBlock(roundId, entryId, mark);
  }

  startForfeit(entryIdBytes) {
    const r = this.db.prepare('SELECT * FROM start_forfeits WHERE entry_id = ?').get(entryIdBytes);
    return r ? { roundId: new Uint8Array(r.round_id), markTick: r.mark_tick, lastTick: r.last_tick,
      mark: new Uint8Array(r.mark), why: r.why, decidedMs: r.decided_ms } : null;
  }

  /**
   * WHAT A QUALIFIER IS OWED OUT OF THE POOL, and how far it has got (§24A.2: "a payout contract to the
   * player's key; the client withdraws it over Lightning"). One row per qualifier: OWED when the money is
   * worked out, PAYING before the payment leaves, PAID when Lightning says it landed.
   */
  // (NO FEE HOLD STORE: putFeeHold, feeHold and feeHoldsOf were the §23.5 fee's hold invoice - the withdrawn Lightning
  // custody's record, RULED 2026-09-25. A store from before keeps its own table, unread.)

  putWinnings({ entryId, roundId, owedMsat, state, request = null, why, paidMs = null }) {
    this.db.prepare('INSERT INTO winnings (entry_id, round_id, owed_msat, state, request, why, owed_ms, paid_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET '
      + 'owed_msat = excluded.owed_msat, state = excluded.state, request = COALESCE(excluded.request, winnings.request), '
      + 'why = excluded.why, paid_ms = COALESCE(excluded.paid_ms, winnings.paid_ms)')
      .run(Buffer.from(entryId), Buffer.from(roundId), Number(owedMsat), state, request, why, this.now(), paidMs);
  }

  winnings(entryIdBytes) {
    const r = this.db.prepare('SELECT * FROM winnings WHERE entry_id = ?').get(Buffer.from(entryIdBytes));
    return r ? { entryId: new Uint8Array(r.entry_id), roundId: new Uint8Array(r.round_id),
      owedMsat: BigInt(r.owed_msat), state: r.state, request: r.request, why: r.why,
      owedMs: Number(r.owed_ms), paidMs: r.paid_ms === null ? null : Number(r.paid_ms) } : null;
  }

  /**
   * WHERE A PLAYER'S WINNING GOES, NAMED ONCE AND KEPT (2026-09-21 13:54).
   *
   * "There is no Collect and no pasted invoice after the round." A Lightning address signed by the entry's
   * session key is a standing instruction, not a claim: it is written the moment the player names it -
   * before the round has settled, before anything is owed - so the settle pass can send the winning with
   * no page open. Measured before this: the address lived only in the tab's sessionStorage, the probe's
   * Chrome closed at DELIVERED, and the round reached FINAL owing 98000 msat with nobody left to ask.
   */
  putPayoutAddress({ entryId, roundId, address, signature = null }) {
    this.db.prepare('INSERT INTO payout_address (entry_id, round_id, address, named_ms, signature) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT(entry_id) DO NOTHING')   // the first address stands
      .run(Buffer.from(entryId), Buffer.from(roundId), String(address), this.now(), signature ? Buffer.from(signature) : null);
  }

  payoutAddress(entryIdBytes) {
    const r = this.db.prepare('SELECT * FROM payout_address WHERE entry_id = ?').get(Buffer.from(entryIdBytes));
    return r ? { entryId: new Uint8Array(r.entry_id), roundId: new Uint8Array(r.round_id),
      address: r.address, namedMs: Number(r.named_ms), signature: r.signature ? new Uint8Array(r.signature) : null } : null;
  }

  /**
   * A winning's send plan, as this signer node checked it (protocol/winnings-send.js). One row per attempt. A DONATION
   * send (`donation`: a walk-away's 25% to one recipient of the round's donation set, RULED 2026-09-30) is kept in
   * donation_sends under its send id, since a recipient is no entry; every reader below reads both.
   */
  putSendPlan({ entryId, roundId, attempt = 0, address, invoice, paymentHash, invoiceMsat, payoutMsat, owedMsat, gatewayUrl, gatewayPk,
    expiration, state = 'PLANNED', why, donation = false }) {
    const now = this.now();
    return this.db.prepare(`INSERT INTO ${donation ? 'donation_sends' : 'winnings_sends'} (entry_id, attempt, round_id, address, invoice, payment_hash, invoice_msat, payout_msat, `
      + 'owed_msat, gateway_url, gateway_pk, expiration, state, why, planned_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(entry_id, attempt) DO NOTHING')
      .run(Buffer.from(entryId), attempt, Buffer.from(roundId), String(address), String(invoice), String(paymentHash).toLowerCase(),
        Number(invoiceMsat), Number(payoutMsat), Number(owedMsat), String(gatewayUrl), String(gatewayPk).toLowerCase(), Number(expiration),
        state, String(why), now, now).changes > 0;   // false: that (entry, attempt) was kept already, and the first row stands
  }

  /**
   * A KEPT RE-SEND GIVES WAY TO A LOWER ONE (kanban #1241, audit 3 FIXES-9: attempt 0's rule for attempt N+1): two seats on turn each kept their
   * own attempt N+1 and the peers split between them for good. A row still PLANNED (nothing signed on it, nothing funded) is replaced by a
   * seat's re-send whose payment hash is lower; true if it was.
   */
  replaceSendPlan({ entryId, attempt, invoice, paymentHash, invoiceMsat, payoutMsat, gatewayUrl, gatewayPk, expiration, why, donation = false }) {
    if (!(attempt > 0)) return false;
    return this.db.prepare(`UPDATE ${donation ? 'donation_sends' : 'winnings_sends'} SET invoice = ?, payment_hash = ?, invoice_msat = ?, payout_msat = ?, gateway_url = ?, `
      + "gateway_pk = ?, expiration = ?, why = ?, updated_ms = ? WHERE entry_id = ? AND attempt = ? AND state = 'PLANNED' AND payment_hash > ?")
      .run(String(invoice), String(paymentHash).toLowerCase(), Number(invoiceMsat), Number(payoutMsat), String(gatewayUrl), String(gatewayPk).toLowerCase(),
        Number(expiration), String(why), this.now(), Buffer.from(entryId), attempt, String(paymentHash).toLowerCase()).changes > 0;
  }

  /**
   * Where a send stands: its contract (txid, output), its preimage once the gateway paid, and its state - MOVED ONLY AS send-state.js
   * ALLOWS (kanban #1154): a compare-and-set on the row's state, so a final row never moves and nothing jumps a step. True if it moved.
   */
  markSend(args) {
    // A SEND MARKED FUNDING IS ON THE DISK BEFORE ITS FUNDING (kanban #1243): a lost FUNDING row funded the send a second time
    return args && args.state === 'FUNDING' ? durably(this.db, () => this.#markSendRow(args)) : this.#markSendRow(args);
  }

  #markSendRow({ entryId, attempt = 0, state, why, txid = null, outIdx = null, preimage = null }) {
    const from = statesBefore(state);
    if (!from.length) return false;
    let moved = 0;
    for (const table of ['winnings_sends', 'donation_sends'])
      moved += this.db.prepare(`UPDATE ${table} SET state = ?, why = ?, txid = COALESCE(?, txid), out_idx = COALESCE(?, out_idx), `
        + `preimage = COALESCE(?, preimage), updated_ms = ? WHERE entry_id = ? AND attempt = ? AND state IN (${from.map(() => '?').join(', ')})`)
        .run(state, String(why), txid, outIdx === null ? null : Number(outIdx), preimage, this.now(), Buffer.from(entryId), attempt, ...from).changes;
    return moved > 0;
  }

  /** A round's send rows, the winners' and the donation set's, in entry (send id) then attempt order. */
  sendRowsOf(roundIdBytes) {
    const rid = Buffer.from(roundIdBytes);
    return this.db.prepare('SELECT *, 0 AS donation FROM winnings_sends WHERE round_id = ? UNION ALL '
      + 'SELECT *, 1 AS donation FROM donation_sends WHERE round_id = ? ORDER BY entry_id, attempt').all(rid, rid);
  }

  /** Every attempt of every send of a round, in entry then attempt order. */
  sendAttemptsOf(roundIdBytes) {
    return this.sendRowsOf(roundIdBytes).map(sendRow);
  }

  /** Every send of a round, the latest attempt of each entry, in entry order. */
  sendPlansOf(roundIdBytes) {
    const latest = new Map();
    for (const r of this.sendRowsOf(roundIdBytes)) latest.set(Buffer.from(r.entry_id).toString('hex'), r);
    return [...latest.values()].map(sendRow);
  }

  /** A round's first send plans, dropped - only while every send of that round is still PLANNED (nothing went out). */
  dropPlannedSends(roundIdBytes) {
    const rid = Buffer.from(roundIdBytes);
    const moved = ['winnings_sends', 'donation_sends'].reduce((n, table) => n
      + this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE round_id = ? AND (state != 'PLANNED' OR attempt != 0)`).get(rid).n, 0);
    if (moved) return 0;
    return ['winnings_sends', 'donation_sends'].reduce((n, table) => n
      + this.db.prepare(`DELETE FROM ${table} WHERE round_id = ? AND attempt = 0 AND state = 'PLANNED'`).run(rid).changes, 0);
  }

  /** Every round holding a send that is not PAID - what the winnings sweep visits. */
  roundsWithUnpaidSends() {
    const out = new Map();
    for (const r of this.db.prepare('SELECT round_id, entry_id, attempt, state FROM winnings_sends UNION ALL '
      + 'SELECT round_id, entry_id, attempt, state FROM donation_sends ORDER BY entry_id, attempt').all()) {
      const k = Buffer.from(r.entry_id).toString('hex');
      out.set(k, { roundId: new Uint8Array(r.round_id), state: r.state });
    }
    const rounds = new Map();
    for (const v of out.values()) if (v.state !== 'PAID') rounds.set(Buffer.from(v.roundId).toString('hex'), v.roundId);
    return [...rounds.values()];
  }

  winningsOf(roundIdBytes) {
    return this.db.prepare('SELECT entry_id FROM winnings WHERE round_id = ?').all(Buffer.from(roundIdBytes))
      .map((r) => this.winnings(new Uint8Array(r.entry_id)));
  }

  /** Whether this signer node stores that mark in an entry's chain. */
  /**
   * THE RUN'S FINAL MARK THIS SIGNER NODE HOLDS BACK ITS CLOSE FOR (ruled 2026-09-23): a mark a peer holds and this node
   * does not, over inputs this node is short of. While it is kept, the batch and checkpoint doors take, after the
   * close, only that mark's batches and then that mark; dropped when the run is signed or the settlement is combined.
   */
  putHeldFinalAsk({ roundId, entryId, mark, tick }) {
    this.db.prepare('INSERT INTO held_final_ask (entry_id, round_id, mark, tick, held_ms) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT(entry_id) DO NOTHING').run(Buffer.from(entryId), Buffer.from(roundId), Buffer.from(mark), Number(tick), this.now());
  }

  heldFinalAsk(entryIdBytes) {
    const r = this.db.prepare('SELECT * FROM held_final_ask WHERE entry_id = ?').get(Buffer.from(entryIdBytes));
    return r ? { entryId: new Uint8Array(r.entry_id), roundId: new Uint8Array(r.round_id), mark: new Uint8Array(r.mark), tick: r.tick } : null;
  }

  dropHeldFinalAsk(entryIdBytes) {
    this.db.prepare('DELETE FROM held_final_ask WHERE entry_id = ?').run(Buffer.from(entryIdBytes));
  }

  /**
   * THE RUN'S FINAL MARK, HELD HERE AND NOT YET CARRIED: this node's last mark of the run, at the end of the inputs it
   * holds (so no input follows it - a mid-run mark never qualifies), with fewer receipts than the round needs. Its tick
   * and id, or null. What a signer node that holds the final mark's ask waits on before its close signs (ruled 2026-09-23).
   */
  pendingFinalMark(roundIdBytes, entryIdBytes) {
    const last = this.db.prepare('SELECT checkpoint_id, tick FROM checkpoints WHERE round_id = ? AND entry_id = ? ORDER BY tick DESC LIMIT 1')
      .get(Buffer.from(roundIdBytes), Buffer.from(entryIdBytes));
    if (!last) return null;
    if (last.tick !== this.heldInputTicks(roundIdBytes, entryIdBytes)) return null;
    const need = neededForRound(this.db, Buffer.from(roundIdBytes));
    const have = this.receiptCount(last.checkpoint_id);
    return have < need ? { tick: last.tick, receipts: have, need } : null;
  }

  /** The inputs this node holds for a run: one past its highest tick, 0 when none. */
  heldInputTicks(roundIdBytes, entryIdBytes) {
    const r = this.db.prepare('SELECT MAX(tick) AS t FROM ticks WHERE round_id = ? AND entry_id = ?').get(Buffer.from(roundIdBytes), Buffer.from(entryIdBytes));
    return r && r.t !== null ? r.t + 1 : 0;
  }

  holdsMark(checkpointIdBytes) {
    return !!this.db.prepare('SELECT 1 k FROM checkpoints WHERE checkpoint_id = ?').get(checkpointIdBytes);
  }

  /** This signer node's own receipt of a mark it holds, or null - never a new one. */
  ownReceipt(checkpointIdBytes) {
    const r = this.db.prepare('SELECT bytes FROM receipts WHERE checkpoint_id = ? AND node_pubkey = ?')
      .get(checkpointIdBytes, this.identity.pubkey);
    return r ? new Uint8Array(r.bytes) : null;
  }

  /** Every receipt this signer node holds of one mark, one per signer (§16's Void evidence, M3.3-34). */
  receiptsOfMark(checkpointIdBytes) {
    return this.db.prepare('SELECT bytes FROM receipts WHERE checkpoint_id = ? ORDER BY node_pubkey')
      .all(checkpointIdBytes).map((r) => new Uint8Array(r.bytes));
  }

  /** How many DIFFERENT joined members signed a receipt of that mark, among these - each checked here. Stores nothing. */
  receiptSigners(receipts, checkpointIdBytes, roundIdBytes) {
    const signers = new Set();
    for (const bytes of receipts) {
      if (!this.receiptVerifies(bytes, checkpointIdBytes, roundIdBytes)) continue;
      try { signers.add(toHex(decodeCheckpointReceipt(splitSignedReceipt(bytes).body).nodePubkey)); } catch { /* verified above */ }
    }
    return signers.size;
  }

  /** An entry's batches in chain order, through the one a mark names. */
  batchesThrough(roundIdBytes, entryIdBytes, inputChainHash) {
    const out = [];
    for (const r of this.db.prepare('SELECT batch_id, bytes FROM batches WHERE round_id = ? AND entry_id = ? ORDER BY seq')
      .all(roundIdBytes, entryIdBytes)) {
      out.push(new Uint8Array(r.bytes));
      if (same(new Uint8Array(r.batch_id), inputChainHash)) return out;
    }
    return same(inputChainHash, GENESIS) ? [] : out;
  }

  /** §16's evidence: what a peer answered when this signer node offered it the on-time first mark. */
  putFirstMarkOffer({ entryId, peer, answer }) {
    this.db.prepare(
      'INSERT INTO first_mark_offers (entry_id, peer, answer, at_ms, block_hash) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT (entry_id, peer) DO UPDATE SET answer = excluded.answer, at_ms = excluded.at_ms, '
      // THE SAME ANSWER AGAIN keeps the block it was first recorded in: a refusal sits where it was first given.
      + 'block_hash = CASE WHEN first_mark_offers.answer = excluded.answer AND first_mark_offers.block_hash IS NOT NULL '
      + 'THEN first_mark_offers.block_hash ELSE excluded.block_hash END '
      + "WHERE first_mark_offers.answer != 'receipted'")
      .run(entryId, peer, answer, this.now(), this.#tipForEntry(entryId));
  }

  /** Each peer's answer to the offered first mark with the block this node recorded it in (null: none named). */
  firstMarkOfferBlocks(entryIdBytes) {
    const out = {};
    for (const r of this.db.prepare('SELECT peer, answer, block_hash, at_ms FROM first_mark_offers WHERE entry_id = ?').all(entryIdBytes))
      out[r.peer] = { answer: r.answer, block: r.block_hash ? new Uint8Array(r.block_hash) : null, atMs: r.at_ms };
    return out;
  }

  /**
   * §13C'S EVIDENCE NAMES ITS BLOCK (RULED 2026-09-24). THIS NODE'S TIP for a round, or null when it reads no chain
   * for it: the block an evidence record made now sits in.
   */
  tipOf(roundIdBytes) {
    const row = this.get(roundIdBytes);
    if (!row) return null;
    let contract;
    try { contract = decodeRoundContract(new Uint8Array(row.contract)); } catch { return null; }
    const chain = chainIndex(this, roundIdBytes, contract);
    return chain.ok ? chain.tipHash() : null;
  }

  #tipForEntry(entryIdBytes) {
    const e = this.db.prepare('SELECT round_id FROM entries WHERE entry_id = ?').get(entryIdBytes);
    return e ? this.tipOf(new Uint8Array(e.round_id)) : null;
  }

  /**
   * A RECORD OF A PLAYER'S MARK AS EVIDENCE, AND THE BLOCK IT SITS IN: this node's tip now, or (`blockHash`) the block a
   * peer named for its own record of that mark - kept as the peer named it. `mark` is the signed mark or its id. Every
   * record is kept; the mark is placed at the earliest of them. No block (no chain here): nothing is kept.
   */
  noteEvidenceBlock(roundIdBytes, entryIdBytes, mark, blockHash = undefined, seenMs = undefined) {
    let id = mark;
    if (mark && mark.length !== 32) {
      try { id = checkpointId(decodeCheckpoint(splitSigned(mark).body)); } catch { return; }
    }
    // THE BLOCK IS KEPT AS IT WAS NAMED, AND THE MOMENT THIS SEAT MADE THE RECORD with it (WINDOW-10-SPEC): the moment is what
    // counts now. A seat that reads no chain records the mark all the same, under no block.
    const named = blockHash === undefined ? this.tipOf(roundIdBytes) : blockHash;
    const block = named && named.length === 32 ? named : new Uint8Array(32);
    if (!id) return;
    // A PULLED RECORD KEEPS WHEN ITS PEER MADE IT (`seenMs`); a record held twice keeps the earlier time.
    const at = Number.isSafeInteger(seenMs) ? seenMs : this.now();
    this.db.prepare('INSERT INTO evidence_blocks (entry_id, mark_id, block_hash, seen_ms) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT (entry_id, mark_id, block_hash) DO UPDATE SET seen_ms = MIN(COALESCE(seen_ms, excluded.seen_ms), excluded.seen_ms)')
      .run(entryIdBytes, id, block, at);
  }

  /** Every evidence record this node holds for an entry's marks: [{ markId, block }]. */
  evidenceBlocks(entryIdBytes) {
    return this.db.prepare('SELECT mark_id, block_hash, seen_ms FROM evidence_blocks WHERE entry_id = ?').all(entryIdBytes)
      .map((r) => ({ markId: new Uint8Array(r.mark_id), block: new Uint8Array(r.block_hash), seenMs: r.seen_ms }));
  }

  /**
   * DOES A MARK COUNT IN A WINDOW (RULED 2026-09-24)? Placed at the earliest block among this node's records of it that is
   * in `chain`, it counts when that block is strictly before `end` - the open is not a floor. A mark with no such record
   * counts nowhere. `mark` is the signed mark or its id.
   */
  markCounts(entryIdBytes, mark, chain, end) {
    let id = mark;
    if (mark && mark.length !== 32) {
      try { id = checkpointId(decodeCheckpoint(splitSigned(mark).body)); } catch { return false; }
    }
    // BY WHEN THIS SEAT HELD IT (§13A, WINDOW-10-SPEC): `end.untilMs`, the instant this seat decides - a record made here
    // before it counts; one made at or after it does not, whatever block it names.
    if (end && end.untilMs !== undefined) {
      const rows = this.db.prepare('SELECT seen_ms FROM evidence_blocks WHERE entry_id = ? AND mark_id = ?').all(entryIdBytes, id);
      return rows.some((r) => r.seen_ms === null || BigInt(r.seen_ms) < BigInt(end.untilMs));
    }
    const heights = this.db.prepare('SELECT block_hash FROM evidence_blocks WHERE entry_id = ? AND mark_id = ?').all(entryIdBytes, id)
      .map((r) => chain.heightOf(new Uint8Array(r.block_hash))).filter((h) => h !== null);
    return heights.length > 0 && Math.min(...heights) < end.height;
  }

  firstMarkOffers(entryIdBytes) {
    const out = {};
    for (const r of this.db.prepare('SELECT peer, answer FROM first_mark_offers WHERE entry_id = ?').all(entryIdBytes)) out[r.peer] = r.answer;
    return out;
  }

  /** §16: this signer node holds the entry ENTRY_VOID - an outage before the first financial tick. */
  /**
   * `learned` - HOW this signer node came to hold the Void (M3.3-34, ruled 2026-09-13):
   * 'own' (it held the first mark and decided the outage itself), 'player' (the
   * player's own catch-up reached it, with the Void signer nodes' receipts), 'forward'
   * (another signer node handed it on), 'forfeit-ask' (the push a forfeit ask makes).
   * The first record stands.
   */
  putEntryVoid({ entryId, roundId, firstMark, evidenceKind, evidence = null, why, learned = 'own' }) {
    this.db.prepare('INSERT OR IGNORE INTO entry_voids (entry_id, round_id, first_mark, evidence_kind, evidence, why, decided_ms, learned) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(entryId, roundId, firstMark, evidenceKind, evidence, why, this.now(), learned);
    this.noteEvidenceBlock(roundId, entryId, firstMark);
  }

  entryVoid(entryIdBytes) {
    const r = this.db.prepare('SELECT * FROM entry_voids WHERE entry_id = ?').get(entryIdBytes);
    return r ? { roundId: new Uint8Array(r.round_id), firstMark: new Uint8Array(r.first_mark), evidenceKind: r.evidence_kind,
      evidence: r.evidence ? new Uint8Array(r.evidence) : null, why: r.why, decidedMs: r.decided_ms, learned: r.learned || 'own' } : null;
  }

  /**
   * THE PLAYER'S TWO FIRST MARKS, AS THIS SIGNER NODE HOLDS THEM (§13B, §13C; ruled
   * 2026-09-12): a proof of equivocation here, or a late first mark kept for
   * FORFEIT that is not the on-time first mark this signer node voided or holds. Then
   * the entry is FORFEIT and never the outage refund - even when a real outage
   * made this signer node record ENTRY_VOID first; that record stays as history (§14).
   */
  twoFirstMarks(roundIdBytes, entryIdBytes) {
    if (this.equivocation(roundIdBytes, entryIdBytes).length) return true;
    const late = this.startForfeit(entryIdBytes);
    if (!late) return false;
    const voided = this.entryVoid(entryIdBytes);
    const onTime = voided ? voided.firstMark : this.firstMarkHeld(roundIdBytes, entryIdBytes);
    return !!onTime && !same(onTime, late.mark);
  }

  /**
   * A FIRST MARK THIS SIGNER NODE, UP, REFUSED (M3.3-34, one-signer node refusal) - kept only
   * when it is the player's own (the entry's session key signs it), a first mark
   * of an entry joined here, on time (a late one is FORFEIT, first-mark.js), and
   * this signer node holds no first mark of that entry (a second one is 13B's, not a
   * refusal). Anything else is not kept: a forged or conflicting mark proves no
   * refusal. Answers whether it was kept.
   */
  putRefusedFirstMark({ bytes, why }) {
    const c = this.onTimeFirstMark(bytes);
    if (!c || this.firstMarkHeld(c.roundId, c.entryId)) return false;
    const kept = this.db.prepare('INSERT OR IGNORE INTO refused_first_marks (entry_id, round_id, mark, why, at_ms) VALUES (?, ?, ?, ?, ?)')
      .run(c.entryId, c.roundId, bytes, String(why || 'refused').slice(0, 300), this.now()).changes > 0;
    this.noteEvidenceBlock(c.roundId, c.entryId, checkpointId(c));
    return kept;
  }

  /**
   * THE PLAYER'S OWN ON-TIME FIRST MARK of an entry joined here, decoded - or
   * null: not a signed mark, not a first mark, not an entry of a round held
   * here, not signed by the entry's session key, or past the start line (a late
   * start is FORFEIT, first-mark.js). One check for a refusal kept here and a
   * refusal another signer node shows.
   */
  onTimeFirstMark(bytes) {
    let c; let signature;
    try { const s = splitSigned(bytes); signature = s.signature; c = decodeCheckpoint(s.body); } catch { return null; }
    if (!same(c.previousHash, NO_PREVIOUS)) return null;
    const entry = this.db.prepare('SELECT round_id, contract FROM entries WHERE entry_id = ?').get(c.entryId);
    if (!entry || !same(new Uint8Array(entry.round_id), c.roundId)) return null;
    const round = this.get(c.roundId);
    if (!round) return null;
    const joined = decodeEntryContract(new Uint8Array(entry.contract));
    let ok = false;
    try { ok = ed25519.verify(signature, checkpointId(c), joined.sessionPubkey); } catch { ok = false; }
    if (!ok) return null;
    let decided;
    try {
      const rc2 = decodeRoundContract(new Uint8Array(round.contract));
      const origin2 = this.startWindowOrigin(c.entryId, joined, rc2);
      decided = firstMarkOutcome({ joinTick: joined.joinTick, ...origin2,
        deadlineTicks: startDeadlineOf(rc2),
        firstMark: { tick: c.tick, previousHash: c.previousHash } });
    } catch { return null; }
    return decided.outcome ? null : c;
  }

  /** The on-time first mark this signer node, up, refused - or null. */
  refusedFirstMark(entryIdBytes) {
    const r = this.db.prepare('SELECT * FROM refused_first_marks WHERE entry_id = ?').get(entryIdBytes);
    return r ? { roundId: new Uint8Array(r.round_id), mark: new Uint8Array(r.mark), why: r.why, atMs: r.at_ms } : null;
  }

  /** §13C's no-quorum outcome for an entry, decided here once: VOID or FORFEIT. */
  putNoQuorum({ entryId, roundId, outcome, why }) {
    return this.db.prepare('INSERT OR IGNORE INTO no_quorum (entry_id, round_id, outcome, why, decided_ms) VALUES (?, ?, ?, ?, ?)')
      .run(entryId, roundId, outcome, why, this.now()).changes;
  }

  /** How this seat's last settlement pass of a round stopped (§5A.3, protocol 26, kanban #1052). `silent`: node keys hex. */
  putSettlePass({ roundId, scope, step, silent }) {
    this.db.prepare('INSERT OR REPLACE INTO settle_passes (round_id, scope, step, silent, made_ms) VALUES (?, ?, ?, ?, ?)').run(Buffer.from(roundId), String(scope), step, JSON.stringify(silent), this.now());
  }
  settlePassesOf(roundIdBytes) {
    return this.db.prepare('SELECT scope, step, silent, made_ms FROM settle_passes WHERE round_id = ?').all(Buffer.from(roundIdBytes))
      .map((r) => ({ scope: r.scope, step: r.step, silent: JSON.parse(r.silent), madeMs: r.made_ms }));
  }

  /** The no-quorum outcome this signer node decided for an entry, or null. */
  noQuorum(entryIdBytes) {
    const r = this.db.prepare('SELECT * FROM no_quorum WHERE entry_id = ?').get(entryIdBytes);
    return r ? { roundId: new Uint8Array(r.round_id), outcome: r.outcome, why: r.why, decidedMs: r.decided_ms } : null;
  }

  /** A joined player's signed name record for a round (M3.3-34). A newer one replaces it; an older one does not. */
  // `identitySig` (kanban #1278, RULED #1276): the identity's own consent, checked at the door. A newer record naming the same identity keeps the proof held;
  // a proof for the record held (not newer) is still taken
  putLobbyName({ roundId, playerPubkey, record, signature, atMs, identitySig = null }) {
    const had = this.db.prepare('SELECT record, identity_sig, at_ms FROM lobby_names WHERE round_id = ? AND player_pubkey = ?').get(Buffer.from(roundId), Buffer.from(playerPubkey));
    const idOf = (b) => Buffer.from(b).subarray(64, 96).toString('hex');
    const sig = identitySig ? Buffer.from(identitySig) : null;
    if (had && !(Number(atMs) > Number(had.at_ms))) {
      if (sig && !had.identity_sig && idOf(had.record) === idOf(record))
        return this.db.prepare('UPDATE lobby_names SET identity_sig = ? WHERE round_id = ? AND player_pubkey = ?').run(sig, Buffer.from(roundId), Buffer.from(playerPubkey)).changes > 0;
      return false;
    }
    const keep = sig || (had && had.identity_sig && idOf(had.record) === idOf(record) ? had.identity_sig : null);
    return this.db.prepare('INSERT INTO lobby_names (round_id, player_pubkey, record, signature, at_ms, identity_sig) VALUES (?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT (round_id, player_pubkey) DO UPDATE SET record = excluded.record, signature = excluded.signature, '
      + 'at_ms = excluded.at_ms, identity_sig = excluded.identity_sig WHERE excluded.at_ms > lobby_names.at_ms')
      .run(roundId, playerPubkey, record, signature, Number(atMs), keep).changes > 0;
  }

  /** Every name record this signer node keeps for a round, as the players signed them. */
  lobbyNames(roundIdBytes) {
    return this.db.prepare('SELECT record, signature, identity_sig FROM lobby_names WHERE round_id = ? ORDER BY player_pubkey')
      .all(roundIdBytes).map((r) => ({ record: new Uint8Array(r.record), signature: new Uint8Array(r.signature), ...(r.identity_sig ? { identitySig: new Uint8Array(r.identity_sig) } : {}) }));
  }

  /**
   * THE ROUND'S SEATED SIGNER NODES' ADDRESSES, KEPT AT SEATING TIME (kanban #735, measured 2026-10-27: seat 1, restarted inside
   * round 2927d830's objection window, read no chain view for the round for ~15 min - "reads no signer node addresses: this node has
   * no chain view for that round" - so it gathered no FINAL signature from its peers while the other five held FINAL 6 of 6). When
   * the seating certificate stands here, each seated node's endpoint off the census advert held then is written per role; the
   * roster's answer stays first, and these are read when it has none. `peers`: [{ node (hex), endpoint (ws:// or http://) }].
   * A node with no endpoint is not written (an address is not guessed at). Written again, the row is replaced.
   */
  keepRoundPeers(roundIdBytes, role, peers) {
    const put = this.db.prepare('INSERT OR REPLACE INTO round_peers (round_id, role, node, endpoint) VALUES (?, ?, ?, ?)');
    let n = 0;
    for (const p of peers || []) {
      if (!p || !p.node || !p.endpoint) continue;
      put.run(Buffer.from(roundIdBytes), String(role), String(p.node).toLowerCase(), String(p.endpoint));
      n++;
    }
    return n;
  }

  /**
   * The seated signer nodes kept for a round and role: [{ node, endpoint }], [] where none were kept. A table's later round is
   * seated by its first round's certificate (known-game.js tableAnchorOf), so it reads what was kept for that round.
   */
  roundPeers(roundIdBytes, role) {
    const read = (rid) => this.db.prepare('SELECT node, endpoint FROM round_peers WHERE round_id = ? AND role = ? ORDER BY node')
      .all(Buffer.from(rid), String(role)).map((r) => ({ node: r.node, endpoint: r.endpoint }));
    const own = read(roundIdBytes);
    if (own.length) return own;
    let anchor = null;
    try { const row = this.get(roundIdBytes); const a = row ? tableAnchorOf(decodeRoundContract(new Uint8Array(row.contract))) : null; if (a && !a.first) anchor = a.anchorId; } catch { anchor = null; }
    return anchor ? read(anchor) : [];
  }

  /** The entry's first mark as this signer node stores it (the chain's first link), or null. */
  firstMarkHeld(roundIdBytes, entryIdBytes) {
    const r = this.db.prepare('SELECT bytes FROM checkpoints WHERE round_id = ? AND entry_id = ? ORDER BY tick LIMIT 1')
      .get(roundIdBytes, entryIdBytes);
    return r ? new Uint8Array(r.bytes) : null;
  }

  /** The entry's start line - join tick + the round's start deadline - and the round's threshold. */
  /** The rounds this node has closed. */
  closedRounds() {
    return this.db.prepare('SELECT round_id, contract FROM rounds WHERE state = ?').all(CLOSED)
      .filter((r) => parses(r.contract)).map((r) => new Uint8Array(r.round_id));
  }

  /** Where this signer node's close of a run stands (M3.3-34), kept across a restart. */
  putCloseHold({ roundId, entryId, state, attempts, sinceMs, lastWhy = null, signedMs = null }) {
    this.db.prepare('INSERT OR REPLACE INTO close_holds (round_id, entry_id, state, attempts, since_ms, last_why, signed_ms) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)').run(roundId, entryId, state, attempts, sinceMs, lastWhy, signedMs);
  }

  /** Every kept close state. */
  closeHolds() {
    return this.db.prepare('SELECT * FROM close_holds').all().map((r) => ({ roundId: new Uint8Array(r.round_id),
      entryId: new Uint8Array(r.entry_id), state: r.state, attempts: r.attempts, sinceMs: r.since_ms,
      lastWhy: r.last_why, signedMs: r.signed_ms }));
  }

  /** Keep the beacon this signer node's chain named for a round: the block, its height, its time. */
  // THE SAME BEACON AGAIN WRITES NOTHING (kanban #786, measured 2026-10-30 03:2xZ on second-host seat 3: 136 INSERT OR REPLACE a minute - the seat
  // keeps which beacons it wrote only in memory, so after each restart every held round's beacon was replaced by the same row): a row
  // that already says this block, height and time is left as it is. Answers whether anything was written.
  putBeacon(roundIdBytes, { hash, height, timeMs }) {
    return this.db.prepare('INSERT INTO round_beacons (round_id, hash, height, time_ms) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT (round_id) DO UPDATE SET hash = excluded.hash, height = excluded.height, time_ms = excluded.time_ms '
      + 'WHERE round_beacons.hash IS NOT excluded.hash OR round_beacons.height IS NOT excluded.height OR round_beacons.time_ms IS NOT excluded.time_ms')
      .run(roundIdBytes, hash, height, Number(timeMs)).changes > 0;
  }

  /** The beacon kept for a round, or nothing. */
  beaconOf(roundIdBytes) {
    const r = this.db.prepare('SELECT * FROM round_beacons WHERE round_id = ?').get(roundIdBytes);
    return r ? { hash: new Uint8Array(r.hash), height: r.height, timeMs: BigInt(r.time_ms) } : undefined;
  }

  /** The checkpoint ids this node holds for an entry, in tick order. */
  markIds(roundIdBytes, entryIdBytes) {
    return this.db.prepare('SELECT checkpoint_id FROM checkpoints WHERE round_id = ? AND entry_id = ? ORDER BY tick')
      .all(roundIdBytes, entryIdBytes).map((r) => new Uint8Array(r.checkpoint_id));
  }

  startLine(roundIdBytes, entryIdBytes) {
    const row = this.get(roundIdBytes);
    const e = this.db.prepare('SELECT contract FROM entries WHERE entry_id = ?').get(entryIdBytes);
    if (!row || !e) return null;
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    return { lastTick: decodeEntryContract(new Uint8Array(e.contract)).joinTick + startDeadlineOf(contract),
      needed: receiptsNeeded(contract.gameVerifySlots), closed: row.state === CLOSED };
  }

  /** A mark the entry's own session key signed: decoded, or a throw. Checks nothing else. */
  playerSigned(bytes) {
    const { body, signature } = splitSigned(bytes);
    const c = decodeCheckpoint(body);
    const e = this.db.prepare('SELECT contract FROM entries WHERE entry_id = ?').get(c.entryId);
    if (!e) throw new Error('no such entry');
    let ok = false;
    try { ok = ed25519.verify(signature, checkpointId(c), decodeEntryContract(new Uint8Array(e.contract)).sessionPubkey); } catch { ok = false; }
    if (!ok) throw new Error('that mark is not signed by the entry\'s session key');
    return c;
  }

  /** Is this a joined member's signed receipt of that mark? Stores nothing. */
  receiptVerifies(bytes, checkpointIdBytes, roundIdBytes) {
    try {
      const { body, signature } = splitSignedReceipt(bytes);
      const r = decodeCheckpointReceipt(body);
      if (!same(r.checkpointId, checkpointIdBytes)) return false;
      if (!this.signerNodes(roundIdBytes).some((n) => same(n, r.nodePubkey))) return false;
      return verifyNode(signature, receiptId(r), r.nodePubkey);
    } catch { return false; }
  }

  // `signers` (protocol 27, kanban #1044 B1): the seat indices a named forfeit names; `claimPk` then their KeyAgg (02 || x)
  putForfeit({ entryId, roundId, message, signature, claimPk, signers = null }) {
    this.db.prepare('INSERT OR IGNORE INTO forfeits (entry_id, round_id, message, signature, claim_pk, made_ms, signers) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(entryId), Buffer.from(roundId), Buffer.from(message), Buffer.from(signature), Buffer.from(claimPk), this.now(), signers ? JSON.stringify(signers) : null);
  }

  /** A round's retry row (kanban #1186): { state, tries, nextAtHeight, why } or null. */
  settleRetry(roundIdBytes, scope = '') {
    const r = this.db.prepare('SELECT state, tries, next_at_height, why FROM settle_retries WHERE round_id = ? AND scope = ?').get(Buffer.from(roundIdBytes), String(scope));
    return r ? { state: r.state, tries: Number(r.tries), nextAtHeight: r.next_at_height === null ? null : Number(r.next_at_height), why: r.why } : null;
  }

  /** A retry row moved, compare-and-set on the state it was read in (`from`: null for none): true if it moved. */
  putSettleRetry({ roundId, scope = '', from = null, state, tries, nextAtHeight = null, why }) {
    const args = [String(state), Number(tries), nextAtHeight === null ? null : Number(nextAtHeight), String(why), this.now()];
    if (from === null)
      return this.db.prepare('INSERT OR IGNORE INTO settle_retries (state, tries, next_at_height, why, updated_ms, round_id, scope) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(...args, Buffer.from(roundId), String(scope)).changes > 0;
    return this.db.prepare('UPDATE settle_retries SET state = ?, tries = ?, next_at_height = ?, why = ?, updated_ms = ? WHERE round_id = ? AND scope = ? AND state = ?')
      .run(...args, Buffer.from(roundId), String(scope), String(from)).changes > 0;
  }

  /** The highest expiration (block height) of the round's stake locks this seat verified, or null with none (kanban #1186). */
  lastLockExpiration(roundIdBytes) {
    let most = null;
    for (const r of this.db.prepare('SELECT fields FROM stake_locks WHERE round_id = ?').all(Buffer.from(roundIdBytes))) {
      let e;
      try { e = Number(JSON.parse(r.fields).expiration); } catch { return null; }
      if (!Number.isSafeInteger(e)) return null;
      most = most === null ? e : Math.max(most, e);
    }
    return most;
  }

  /** What this seat committed a lock to (kanban #1184): { state, roundId, txid, why } or null. */
  lockFate(outpoint) {
    const r = this.db.prepare('SELECT round_id, state, txid, why FROM lock_fates WHERE outpoint = ?').get(String(outpoint));
    return r ? { state: r.state, roundId: new Uint8Array(r.round_id), txid: r.txid, why: r.why } : null;
  }

  /** A lock's fate, written once (kanban #1184): true if this row is now the one held, i.e. it was written or it was already this state. */
  putLockFate({ outpoint, roundId, state, txid = null, why }) {
    this.db.prepare('INSERT OR IGNORE INTO lock_fates (outpoint, round_id, state, txid, why, made_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(String(outpoint), Buffer.from(roundId), String(state), txid === null ? null : String(txid), String(why), this.now());
    const held = this.lockFate(outpoint);
    return !!held && held.state === state;
  }

  /**
   * EVERY OUTPOINT A SETTLEMENT OF THE ROUND CLAIMS, AS THIS SEAT KEPT IT (kanban #1184): the round's moves, every txid it signed or was handed
   * (lock_settlement_txids) and every federation's and late entry's (scoped_settlement_txids). A Set of "txid:idx".
   */
  claimedOutpointsOf(roundIdBytes) {
    const rid = Buffer.from(roundIdBytes);
    const out = new Set();
    const add = (claims) => { try { for (const c of JSON.parse(claims)) out.add(String(c)); } catch { /* a row with no claims list claims nothing */ } };
    for (const r of this.db.prepare('SELECT claims FROM lock_settlement_moves WHERE round_id = ?').all(rid)) add(r.claims);
    for (const r of this.db.prepare('SELECT claims FROM lock_settlement_txids WHERE round_id = ?').all(rid)) add(r.claims);
    for (const r of this.db.prepare('SELECT claims FROM scoped_settlement_txids WHERE round_id = ?').all(rid)) add(r.claims);
    return out;
  }

  forfeit(entryIdBytes) {
    const r = this.db.prepare('SELECT message, signature, claim_pk, made_ms, signers FROM forfeits WHERE entry_id = ?').get(Buffer.from(entryIdBytes));
    return r ? { message: new Uint8Array(r.message), signature: new Uint8Array(r.signature), claimPk: new Uint8Array(r.claim_pk), madeMs: Number(r.made_ms),
      ...(r.signers ? { signers: JSON.parse(r.signers) } : {}) } : null;
  }

  /** A fee lock this signer node verified (Pick A): the handed contract (JSON), its id, its outpoint. */
  putFeeLock({ entryId, roundId, outpoint, fields, contractId }) {
    this.db.prepare('INSERT OR REPLACE INTO fee_locks (entry_id, round_id, outpoint, fields, contract_id, verified_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(entryId), Buffer.from(roundId), `${Buffer.from(outpoint.txid).toString('hex')}:${outpoint.outIdx}`,
        JSON.stringify(fields), contractId, this.now());
  }

  feeLock(entryIdBytes) {
    const r = this.db.prepare('SELECT outpoint, fields, contract_id, verified_ms FROM fee_locks WHERE entry_id = ?').get(Buffer.from(entryIdBytes));
    return r ? { outpoint: r.outpoint, fields: JSON.parse(r.fields), contractId: r.contract_id, verifiedMs: Number(r.verified_ms) } : null;
  }

  /** The round's one settlement of its losers' locks (W4): its intent, then where it stands. */
  putLockSettlement({ roundId, txid, message, signature, state, why }) {
    // A SUBMITTING ROW IS ON THE DISK BEFORE ITS SUBMIT (kanban #1243)
    const write = () => this.db.prepare('INSERT OR REPLACE INTO lock_settlements (round_id, txid, message, signature, state, why, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(roundId), String(txid), Buffer.from(message), Buffer.from(signature), state, why, this.now());
    const done = state === 'SUBMITTING' ? durably(this.db, write) : write();
    // ACCEPTED ON A TXID OF THE HISTORY CARRIES THAT TXID'S MOVES (kanban #1249, audit 2 SETTLEMENT-1): a row made ACCEPTED on another seat's landed
    // transaction (recordSubmit, the kept pass, recover) kept the moves of this seat's own txid - its claims, its payouts - so the own-claim guard,
    // the sends, the index of the landed outputs and the late splits all read a transaction that never landed
    if (state === 'ACCEPTED') {
      const m = this.lockSettlementMoves(roundId);
      if (!m || m.txid !== String(txid)) {
        const h = typeof this.settlementTxidsOf === 'function' ? this.settlementTxidsOf(roundId).find((x) => x.txid === String(txid)) : null;
        if (h && Array.isArray(h.claims)) this.putLockSettlementMoves({ roundId, txid: String(txid), claims: h.claims, payouts: h.payouts });
      }
    }
    return done;
  }

  lockSettlement(roundIdBytes) {
    const r = this.db.prepare('SELECT txid, message, signature, state, why, made_ms FROM lock_settlements WHERE round_id = ?').get(Buffer.from(roundIdBytes));
    return r ? { txid: r.txid, message: new Uint8Array(r.message), signature: new Uint8Array(r.signature), state: r.state, why: r.why, madeMs: Number(r.made_ms) } : null;
  }

  /** The acks a settlement's signing stood on, and their table (kanban #1040). The row with the most acks stands: a retry never shortens it. */
  putSettlementAcks({ roundId, scope, txid, tableId, table, acks }) {
    const held = this.db.prepare('SELECT length(acks) AS n FROM settlement_acks WHERE round_id = ? AND scope = ? AND txid = ?').get(Buffer.from(roundId), scope, String(txid));
    if (held && Number(held.n) >= acks.length) return;
    this.db.prepare('INSERT OR REPLACE INTO settlement_acks (round_id, scope, txid, table_id, tbl, acks, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(roundId), scope, String(txid), Buffer.from(tableId), Buffer.from(table), Buffer.from(acks), this.now());
  }

  /** The rounds this seat took an entry of since `sinceMs` (kanban #1044 B1: read again for a named claim's offence, acked or not). */
  entryRoundsSince(sinceMs) {
    return this.db.prepare('SELECT DISTINCT round_id FROM entries WHERE joined_ms >= ?').all(sinceMs).map((r) => new Uint8Array(r.round_id));
  }

  /** The rounds this seat kept acks of a settlement for since `sinceMs` (kanban #1044 B1: read again for a named claim's offence). */
  ackedRoundsSince(sinceMs) {
    return this.db.prepare('SELECT DISTINCT round_id FROM settlement_acks WHERE made_ms >= ?').all(sinceMs).map((r) => new Uint8Array(r.round_id));
  }

  settlementAcksOf(roundIdBytes, scope = null) {
    const rows = scope === null
      ? this.db.prepare('SELECT scope, txid, table_id, tbl, acks, made_ms FROM settlement_acks WHERE round_id = ? ORDER BY made_ms, txid').all(Buffer.from(roundIdBytes))
      : this.db.prepare('SELECT scope, txid, table_id, tbl, acks, made_ms FROM settlement_acks WHERE round_id = ? AND scope = ? ORDER BY made_ms, txid').all(Buffer.from(roundIdBytes), scope);
    return rows.map((r) => ({ scope: r.scope, txid: r.txid, tableId: new Uint8Array(r.table_id), table: new Uint8Array(r.tbl), acks: new Uint8Array(r.acks), madeMs: Number(r.made_ms) }));
  }

  /** One federation's settlement of a round that takes any federation (2026.0.3): the same row as a round's own. */
  putFedLockSettlement({ roundId, federation, txid, message, signature, state, why }) {
    // A SUBMITTING ROW IS ON THE DISK BEFORE ITS SUBMIT (kanban #1243)
    const write = () => this.db.prepare('INSERT OR REPLACE INTO fed_lock_settlements (round_id, federation_id, txid, message, signature, state, why, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(roundId), String(federation).toLowerCase(), String(txid), Buffer.from(message), Buffer.from(signature), state, why, this.now());
    return state === 'SUBMITTING' ? durably(this.db, write) : write();
  }

  fedLockSettlement(roundIdBytes, federation) {
    const r = this.db.prepare('SELECT txid, message, signature, state, why, made_ms FROM fed_lock_settlements WHERE round_id = ? AND federation_id = ?')
      .get(Buffer.from(roundIdBytes), String(federation).toLowerCase());
    return r ? { federation: String(federation).toLowerCase(), txid: r.txid, message: new Uint8Array(r.message), signature: new Uint8Array(r.signature), state: r.state, why: r.why, madeMs: Number(r.made_ms) } : null;
  }

  /**
   * WHERE A ROUND'S SETTLEMENT STANDS, in one federation or in several (2026.0.3 step 6): the one row's state; for a round
   * that takes any federation ACCEPTED once every federation's transaction is, SUBMITTING while one is not; null with none.
   */
  settlementState(roundIdBytes) {
    const one = this.lockSettlement(roundIdBytes);
    if (one) return one.state;
    const feds = this.fedLockSettlementsOf(roundIdBytes);
    if (!feds.length) return null;
    // EVERY FEDERATION OF THE SPLIT, NOT ONLY THE ROWS THERE ARE (kanban #1576): a federation the split names with no row yet (its part never built) keeps it SUBMITTING
    const accepted = new Set(feds.filter((r) => r.state === 'ACCEPTED').map((r) => r.federation));
    return feds.every((r) => r.state === 'ACCEPTED') && this.fedLockSplitOf(roundIdBytes).every((f) => accepted.has(f)) ? 'ACCEPTED' : 'SUBMITTING';
  }

  /**
   * THE FEDERATIONS A ROUND'S SPLIT NAMES (kanban #1576), kept before anything is signed: the round is settled only once each holds an ACCEPTED row.
   * Never removed; a federation already kept is kept once.
   */
  putFedLockSplit(roundIdBytes, federations) {
    const have = new Set(this.fedLockSplitOf(roundIdBytes));
    const fresh = [...new Set(federations.map((f) => String(f).toLowerCase()))].filter((f) => !have.has(f));
    if (!fresh.length) return;
    const put = this.db.prepare('INSERT OR IGNORE INTO fed_lock_split (round_id, federation_id) VALUES (?, ?)');
    durably(this.db, () => { for (const f of fresh) put.run(Buffer.from(roundIdBytes), f); });
  }

  fedLockSplitOf(roundIdBytes) {
    return this.db.prepare('SELECT federation_id FROM fed_lock_split WHERE round_id = ? ORDER BY federation_id').all(Buffer.from(roundIdBytes)).map((r) => r.federation_id);
  }

  /** A series' proven publication fee (§5A.5): kept once; { txid, feeSats } or null. */
  putSeriesPublication(seriesIdBytes, { txid, feeSats }) {
    this.db.prepare('INSERT OR IGNORE INTO series_publications (series_id, txid, fee_sats) VALUES (?, ?, ?)').run(Buffer.from(seriesIdBytes), String(txid), String(feeSats));
  }

  seriesPublication(seriesIdBytes) {
    const r = this.db.prepare('SELECT txid, fee_sats FROM series_publications WHERE series_id = ?').get(Buffer.from(seriesIdBytes));
    return r ? { txid: r.txid, feeSats: BigInt(r.fee_sats) } : null;
  }

  /** A round's creator signature (§6): kept once, the first that stood; 64 bytes or null. */
  putCreatorSignature(roundIdBytes, signature) {
    this.db.prepare('INSERT OR IGNORE INTO round_creators (round_id, signature) VALUES (?, ?)').run(Buffer.from(roundIdBytes), Buffer.from(signature));
  }

  creatorSignature(roundIdBytes) {
    const r = this.db.prepare('SELECT signature FROM round_creators WHERE round_id = ?').get(Buffer.from(roundIdBytes));
    return r ? new Uint8Array(r.signature) : null;
  }

  /** Every federation's settlement row of a round (2026.0.3), in federation id order. */
  fedLockSettlementsOf(roundIdBytes) {
    return this.db.prepare('SELECT federation_id, txid, state, why, made_ms FROM fed_lock_settlements WHERE round_id = ? ORDER BY federation_id').all(Buffer.from(roundIdBytes))
      .map((r) => ({ federation: r.federation_id, txid: r.txid, state: r.state, why: r.why, madeMs: Number(r.made_ms) }));
  }

  /** Every round whose lock settlement this signer node holds in `state` (W6: SUBMITTING, asked again at start). */
  lockSettlementsIn(state) {
    return this.db.prepare('SELECT round_id FROM lock_settlements WHERE state = ? ORDER BY made_ms').all(state)
      .map((r) => new Uint8Array(r.round_id));
  }

  /**
   * THE CLOSED ROUNDS WITH A STAKE LOCK AND NO ACCEPTED SETTLEMENT HERE, closed between two times (kanban #803): what a settlement's
   * retry reads. A round that takes any federation counts until every row it holds is ACCEPTED, and every federation its split names
   * holds one (kanban #1576: a federation whose part was never built has no row and kept the round off this list).
   */
  closedLockRoundsUnsettled(fromMs, toMs) {
    // FROM THE LOCKS, NEVER FROM THE ROUNDS (kanban #927, measured 2026-11-01): left to choose, SQLite walked all 122,591 rounds with their contracts and held a seat's loop for 398 s, every minute. There are 4,736 locks
    return this.db.prepare(`SELECT r.round_id FROM (SELECT DISTINCT round_id FROM stake_locks) s CROSS JOIN rounds r ON r.round_id = s.round_id
      WHERE r.state = ? AND r.closed_ms >= ? AND r.closed_ms < ?
        AND NOT EXISTS (SELECT 1 FROM lock_settlements l WHERE l.round_id = r.round_id AND l.state = 'ACCEPTED')
        AND NOT EXISTS (SELECT 1 FROM settle_retries t WHERE t.round_id = r.round_id AND t.scope = '' AND t.state IN ('SETTLED', 'EXPIRED'))
        AND NOT (EXISTS (SELECT 1 FROM fed_lock_settlements f WHERE f.round_id = r.round_id)
          AND NOT EXISTS (SELECT 1 FROM fed_lock_settlements f WHERE f.round_id = r.round_id AND f.state <> 'ACCEPTED')
          AND NOT EXISTS (SELECT 1 FROM fed_lock_split p WHERE p.round_id = r.round_id AND NOT EXISTS
            (SELECT 1 FROM fed_lock_settlements f WHERE f.round_id = p.round_id AND f.federation_id = p.federation_id AND f.state = 'ACCEPTED')))`)
      .all(CLOSED, fromMs, toMs).map((r) => new Uint8Array(r.round_id));
  }

  /** What the signed settlement moves (W6): its claimed outpoints ("txid:idx") and its payout count. */
  putLockSettlementMoves({ roundId, txid, claims, payouts }) {
    this.db.prepare('INSERT OR REPLACE INTO lock_settlement_moves (round_id, txid, claims, payouts) VALUES (?, ?, ?, ?)')
      .run(Buffer.from(roundId), String(txid), JSON.stringify(claims), Number(payouts));
  }

  /** A settlement txid of the round (kanban #1171): kept once with what it moves; its signature filled in when it is known. */
  putSettlementTxid({ roundId, txid, message, signature = null, claims = null, payouts = null }) {
    const had = this.db.prepare('SELECT 1 FROM lock_settlement_txids WHERE round_id = ? AND txid = ?').get(Buffer.from(roundId), String(txid));
    if (!had) {
      if (claims === null || payouts === null) return;
      this.db.prepare('INSERT INTO lock_settlement_txids (round_id, txid, message, signature, claims, payouts, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(Buffer.from(roundId), String(txid), Buffer.from(message || new Uint8Array(0)), Buffer.from(signature || new Uint8Array(0)), JSON.stringify(claims), Number(payouts), this.now());
    } else if (signature && signature.length) {
      this.db.prepare('UPDATE lock_settlement_txids SET signature = ? WHERE round_id = ? AND txid = ? AND length(signature) = 0').run(Buffer.from(signature), Buffer.from(roundId), String(txid));
    }
  }

  /**
   * ROWS MADE ACCEPTED ON A HISTORY TXID BEFORE #1249 KEEP ANOTHER TXID'S MOVES (kanban #1275, audit 4 fixesB-4): once, at open, each ACCEPTED row whose
   * moves name another txid and whose own txid the history holds gets that txid's moves. Answers how many were repaired.
   */
  repairAcceptedMoves() {
    let n = 0;
    let rows = [];
    try {
      rows = this.db.prepare(`SELECT ls.round_id AS round_id, ls.txid AS txid FROM lock_settlements ls JOIN lock_settlement_moves mv ON mv.round_id = ls.round_id
        WHERE ls.state = 'ACCEPTED' AND mv.txid != ls.txid`).all();
    } catch { return 0; }
    for (const r of rows) {
      const h = this.settlementTxidsOf(r.round_id).find((x) => x.txid === String(r.txid));
      if (h && Array.isArray(h.claims)) { this.putLockSettlementMoves({ roundId: new Uint8Array(r.round_id), txid: String(r.txid), claims: h.claims, payouts: h.payouts }); n++; }
    }
    return n;
  }

  settlementTxidsOf(roundIdBytes) {
    return this.db.prepare('SELECT txid, message, signature, claims, payouts FROM lock_settlement_txids WHERE round_id = ? ORDER BY made_ms').all(Buffer.from(roundIdBytes))
      .map((r) => ({ txid: r.txid, message: new Uint8Array(r.message), signature: new Uint8Array(r.signature), claims: JSON.parse(r.claims), payouts: Number(r.payouts) }));
  }

  /** A stake lock of the round read gone at the federation (kanban #1183): kept once, never removed. */
  putGoneStake({ roundId, outpoint, why }) {
    this.db.prepare('INSERT OR IGNORE INTO gone_stakes (round_id, outpoint, why, made_ms) VALUES (?, ?, ?, ?)').run(Buffer.from(roundId), String(outpoint), String(why), this.now());
  }

  goneStakesOf(roundIdBytes) {
    return this.db.prepare('SELECT outpoint FROM gone_stakes WHERE round_id = ?').all(Buffer.from(roundIdBytes)).map((r) => r.outpoint);
  }

  lockSettlementMoves(roundIdBytes) {
    const r = this.db.prepare('SELECT txid, claims, payouts FROM lock_settlement_moves WHERE round_id = ?').get(Buffer.from(roundIdBytes));
    return r ? { txid: r.txid, claims: JSON.parse(r.claims), payouts: Number(r.payouts) } : null;
  }

  /** What the round's settlement paid each winner, in the table's order (slice C3b-1): [{ pubkey, msat }] or null. */
  putLockSettlementShares(roundIdBytes, shares) {
    this.db.prepare('INSERT OR REPLACE INTO lock_settlement_shares (round_id, shares) VALUES (?, ?)')
      .run(Buffer.from(roundIdBytes), JSON.stringify(shares.map((x) => ({ pubkey: Buffer.from(x.pubkey).toString('hex'), msat: String(x.msat) }))));
  }

  lockSettlementShares(roundIdBytes) {
    const r = this.db.prepare('SELECT shares FROM lock_settlement_shares WHERE round_id = ?').get(Buffer.from(roundIdBytes));
    return r ? JSON.parse(r.shares).map((x) => ({ pubkey: new Uint8Array(Buffer.from(x.pubkey, 'hex')), msat: BigInt(x.msat) })) : null;
  }

  /**
   * A protocol-27 settlement's batch (kanban #1044 B1): every batch kept once by (round, scope, txid), never replaced (kanban #1170); `standing` also
   * makes it the scope's batch (named_batches) - the caller decides that through namedBatchStep, never this store.
   */
  putNamedBatch({ roundId, scope = '', bodyId, txid, signers, signatures, slots, standing = true }) {
    const args = [Buffer.from(roundId), String(scope), String(bodyId), String(txid), JSON.stringify(signers), JSON.stringify(signatures.map((x) => Buffer.from(x).toString('hex'))),
      JSON.stringify(slots), this.now()];
    this.db.prepare('INSERT OR IGNORE INTO named_batch_txids (round_id, scope, body_id, txid, signers, signatures, slots, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...args);
    if (standing) this.db.prepare('INSERT OR REPLACE INTO named_batches (round_id, scope, body_id, txid, signers, signatures, slots, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(...args);
  }

  /** The batch the scope stands on (named_batches), or null. */
  namedBatch(roundIdBytes, scope = '') {
    const r = this.db.prepare('SELECT body_id, txid, signers, signatures, slots, made_ms FROM named_batches WHERE round_id = ? AND scope = ?').get(Buffer.from(roundIdBytes), String(scope));
    return r ? namedBatchRow(r) : null;
  }

  /** The scope's batch of one txid (kanban #1170): from every batch kept, else the standing one when it is that txid (kept before the history). */
  namedBatchOf(roundIdBytes, scope, txid) {
    const r = this.db.prepare('SELECT body_id, txid, signers, signatures, slots, made_ms FROM named_batch_txids WHERE round_id = ? AND scope = ? AND txid = ?')
      .get(Buffer.from(roundIdBytes), String(scope), String(txid));
    if (r) return namedBatchRow(r);
    const s = this.namedBatch(roundIdBytes, scope);
    return s && s.txid === String(txid) ? s : null;
  }

  /** Every batch of the scope kept, oldest first (kanban #1170). */
  namedBatchesOf(roundIdBytes, scope = '') {
    return this.db.prepare('SELECT body_id, txid, signers, signatures, slots, made_ms FROM named_batch_txids WHERE round_id = ? AND scope = ? ORDER BY made_ms, txid')
      .all(Buffer.from(roundIdBytes), String(scope)).map(namedBatchRow);
  }

  /** The kept batch of `txid` becomes the one the scope stands on (kanban #1170: the row moved onto that txid). False with no such batch kept. */
  standNamedBatch(roundIdBytes, scope, txid) {
    const b = this.namedBatchOf(roundIdBytes, scope, txid);
    if (!b) return false;
    this.db.prepare('INSERT OR REPLACE INTO named_batches (round_id, scope, body_id, txid, signers, signatures, slots, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(roundIdBytes), String(scope), b.bodyId, b.txid, JSON.stringify(b.signers), JSON.stringify(b.signatures.map((x) => Buffer.from(x).toString('hex'))),
        JSON.stringify(b.slots), b.madeMs);
    return true;
  }

  /** A txid of a federation's or a late entry's settlement (kanban #1172), `scope` 'fed:<hex>' | 'late:<hex>': kept once with what it moves; its signature filled in. */
  putScopedSettlementTxid({ roundId, scope, txid, message, signature = null, claims = null, payouts = null }) {
    const had = this.db.prepare('SELECT 1 FROM scoped_settlement_txids WHERE round_id = ? AND scope = ? AND txid = ?').get(Buffer.from(roundId), String(scope), String(txid));
    if (!had) {
      if (claims === null || payouts === null) return;
      this.db.prepare('INSERT INTO scoped_settlement_txids (round_id, scope, txid, message, signature, claims, payouts, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(Buffer.from(roundId), String(scope), String(txid), Buffer.from(message || new Uint8Array(0)), Buffer.from(signature || new Uint8Array(0)), JSON.stringify(claims), Number(payouts), this.now());
    } else if (signature && signature.length) {
      this.db.prepare('UPDATE scoped_settlement_txids SET signature = ? WHERE round_id = ? AND scope = ? AND txid = ? AND length(signature) = 0')
        .run(Buffer.from(signature), Buffer.from(roundId), String(scope), String(txid));
    }
  }

  scopedSettlementTxidsOf(roundIdBytes, scope) {
    return this.db.prepare('SELECT txid, message, signature, claims, payouts FROM scoped_settlement_txids WHERE round_id = ? AND scope = ? ORDER BY made_ms, txid')
      .all(Buffer.from(roundIdBytes), String(scope))
      .map((r) => ({ txid: r.txid, message: new Uint8Array(r.message), signature: new Uint8Array(r.signature), claims: JSON.parse(r.claims), payouts: Number(r.payouts) }));
  }

  /** Every (round, federation) row in `state` (kanban #1172: SUBMITTING and REFUSED rows are asked again at start). */
  fedLockSettlementsIn(state) {
    return this.db.prepare('SELECT round_id, federation_id FROM fed_lock_settlements WHERE state = ? ORDER BY made_ms').all(state)
      .map((r) => ({ roundId: new Uint8Array(r.round_id), federation: r.federation_id }));
  }

  /** Every (round, late entry) row in `state` (kanban #1172). */
  lateLockSettlementsIn(state) {
    return this.db.prepare('SELECT round_id, entry_id FROM late_lock_settlements WHERE state = ? ORDER BY made_ms').all(state)
      .map((r) => ({ roundId: new Uint8Array(r.round_id), entryId: new Uint8Array(r.entry_id) }));
  }

  /** A late loser's second settlement (slice C3b-1): its intent, then where it stands. One per (round, entry). */
  putLateLockSettlement({ roundId, entryId, txid, message, signature, state, why }) {
    // A SUBMITTING ROW IS ON THE DISK BEFORE ITS SUBMIT (kanban #1243)
    const write = () => this.db.prepare('INSERT OR REPLACE INTO late_lock_settlements (round_id, entry_id, txid, message, signature, state, why, made_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(roundId), Buffer.from(entryId), String(txid), Buffer.from(message), Buffer.from(signature), state, why, this.now());
    return state === 'SUBMITTING' ? durably(this.db, write) : write();
  }

  lateLockSettlement(roundIdBytes, entryIdBytes) {
    const r = this.db.prepare('SELECT txid, message, signature, state, why, made_ms FROM late_lock_settlements WHERE round_id = ? AND entry_id = ?')
      .get(Buffer.from(roundIdBytes), Buffer.from(entryIdBytes));
    return r ? { txid: r.txid, message: new Uint8Array(r.message), signature: new Uint8Array(r.signature), state: r.state, why: r.why, madeMs: Number(r.made_ms) } : null;
  }

  /**
   * THIS ROUND STORE, SEEN THROUGH ONE LATE SETTLEMENT'S SENDS (slice C3b-2a): the send-row methods `WinningsSend` uses
   * read and write late_winnings_sends for that (round, late entry); its settlement row is the late one; and a paid
   * late send records nothing in `winnings`, whose one row per entry is the first round's. Everything else is this store.
   */
  lateSendScope(lateEntryIdBytes) {
    const late = Buffer.from(lateEntryIdBytes);
    const base = this;
    const rowOf = (r) => ({ entryId: new Uint8Array(r.entry_id), attempt: r.attempt, roundId: new Uint8Array(r.round_id),
      address: r.address, invoice: r.invoice, paymentHash: r.payment_hash, invoiceMsat: BigInt(r.invoice_msat), payoutMsat: BigInt(r.payout_msat),
      owedMsat: BigInt(r.owed_msat), gatewayUrl: r.gateway_url, gatewayPk: r.gateway_pk, expiration: BigInt(r.expiration),
      txid: r.txid, outIdx: r.out_idx === null ? null : Number(r.out_idx), preimage: r.preimage, state: r.state, why: r.why });
    const all = (roundIdBytes) => base.db.prepare('SELECT * FROM late_winnings_sends WHERE round_id = ? AND late_entry_id = ? ORDER BY entry_id, attempt')
      .all(Buffer.from(roundIdBytes), late);
    return Object.assign(Object.create(base), {
      lateEntryId: new Uint8Array(late),
      replaceSendPlan({ roundId, entryId, attempt, invoice, paymentHash, invoiceMsat, payoutMsat, gatewayUrl, gatewayPk, expiration, why }) {
        if (!(attempt > 0)) return false;
        return base.db.prepare('UPDATE late_winnings_sends SET invoice = ?, payment_hash = ?, invoice_msat = ?, payout_msat = ?, gateway_url = ?, gateway_pk = ?, '
          + "expiration = ?, why = ?, updated_ms = ? WHERE round_id = ? AND late_entry_id = ? AND entry_id = ? AND attempt = ? AND state = 'PLANNED' AND payment_hash > ?")
          .run(String(invoice), String(paymentHash).toLowerCase(), Number(invoiceMsat), Number(payoutMsat), String(gatewayUrl), String(gatewayPk).toLowerCase(),
            Number(expiration), String(why), base.now(), Buffer.from(roundId), late, Buffer.from(entryId), attempt, String(paymentHash).toLowerCase()).changes > 0;
      },
      putSendPlan({ entryId, roundId, attempt = 0, address, invoice, paymentHash, invoiceMsat, payoutMsat, owedMsat, gatewayUrl, gatewayPk,
        expiration, state = 'PLANNED', why }) {
        const now = base.now();
        return base.db.prepare('INSERT INTO late_winnings_sends (round_id, late_entry_id, entry_id, attempt, address, invoice, payment_hash, invoice_msat, '
          + 'payout_msat, owed_msat, gateway_url, gateway_pk, expiration, state, why, planned_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) '
          + 'ON CONFLICT(round_id, late_entry_id, entry_id, attempt) DO NOTHING')
          .run(Buffer.from(roundId), late, Buffer.from(entryId), attempt, String(address), String(invoice), String(paymentHash).toLowerCase(),
            Number(invoiceMsat), Number(payoutMsat), Number(owedMsat), String(gatewayUrl), String(gatewayPk).toLowerCase(), Number(expiration),
            state, String(why), now, now).changes > 0;
      },
      // AS THE ROUND'S OWN (kanban #1154): a compare-and-set by send-state.js, true if it moved
      markSend({ entryId, attempt = 0, state, why, txid = null, outIdx = null, preimage = null }) {
        const from = statesBefore(state);
        if (!from.length) return false;
        // FUNDING on the disk before its funding (kanban #1243)
        const write = () => base.db.prepare('UPDATE late_winnings_sends SET state = ?, why = ?, txid = COALESCE(?, txid), out_idx = COALESCE(?, out_idx), '
          + `preimage = COALESCE(?, preimage), updated_ms = ? WHERE late_entry_id = ? AND entry_id = ? AND attempt = ? AND state IN (${from.map(() => '?').join(', ')})`)
          .run(state, String(why), txid, outIdx === null ? null : Number(outIdx), preimage, base.now(), late, Buffer.from(entryId), attempt, ...from).changes > 0;
        return state === 'FUNDING' ? durably(base.db, write) : write();
      },
      sendAttemptsOf(roundIdBytes) { return all(roundIdBytes).map(rowOf); },
      sendPlansOf(roundIdBytes) {
        const latest = new Map();
        for (const r of all(roundIdBytes)) latest.set(Buffer.from(r.entry_id).toString('hex'), r);
        return [...latest.values()].map(rowOf);
      },
      dropPlannedSends(roundIdBytes) {
        const rid = Buffer.from(roundIdBytes);
        const moved = base.db.prepare("SELECT COUNT(*) AS n FROM late_winnings_sends WHERE round_id = ? AND late_entry_id = ? AND (state != 'PLANNED' OR attempt != 0)")
          .get(rid, late).n;
        if (moved) return 0;
        return base.db.prepare("DELETE FROM late_winnings_sends WHERE round_id = ? AND late_entry_id = ? AND attempt = 0 AND state = 'PLANNED'").run(rid, late).changes;
      },
      putWinnings() { /* the first round's row stands; the late payment is its late_winnings_sends row */ },
      lockSettlement(roundIdBytes) { return base.lateLockSettlement(roundIdBytes, late); },
    });
  }

  /** Every late settlement holding a send that is not PAID - what the late sweep visits for its sends. */
  lateSettlementsWithUnpaidSends() {
    const latest = new Map();
    for (const r of this.db.prepare('SELECT round_id, late_entry_id, entry_id, attempt, state FROM late_winnings_sends ORDER BY entry_id, attempt').all())
      latest.set(`${Buffer.from(r.round_id).toString('hex')}:${Buffer.from(r.late_entry_id).toString('hex')}:${Buffer.from(r.entry_id).toString('hex')}`, r);
    const out = new Map();
    for (const r of latest.values()) if (r.state !== 'PAID')
      out.set(`${Buffer.from(r.round_id).toString('hex')}:${Buffer.from(r.late_entry_id).toString('hex')}`,
        { roundId: new Uint8Array(r.round_id), entryId: new Uint8Array(r.late_entry_id) });
    return [...out.values()];
  }

  /**
   * THE LATE LOSERS TO ASK ABOUT (slice C3b-1): every objected entry of a round whose own settlement is ACCEPTED and
   * which holds no ACCEPTED second settlement. An entry is left out of the round's settlement only while an objection
   * holds it in its re-run window - or, past its bound, a no-quorum entry whose FINAL signatures came late (kanban #1038): those have
   * re-runs and no objection - so nothing else can be one. A round that takes any federation has no row of its own (kanban #1172): its settlement is
   * ACCEPTED once every federation's row is (settlementState), and its late losers are asked about from then.
   */
  lateSettlementCandidates() {
    return this.db.prepare(`SELECT o.round_id, o.entry_id FROM (SELECT round_id, entry_id FROM objections UNION SELECT round_id, entry_id FROM reruns) o
      LEFT JOIN late_lock_settlements l ON l.round_id = o.round_id AND l.entry_id = o.entry_id
      WHERE (l.state IS NULL OR l.state <> 'ACCEPTED')
        AND (EXISTS (SELECT 1 FROM lock_settlements s WHERE s.round_id = o.round_id AND s.state = 'ACCEPTED')
          OR (NOT EXISTS (SELECT 1 FROM lock_settlements s WHERE s.round_id = o.round_id)
            AND EXISTS (SELECT 1 FROM fed_lock_settlements f WHERE f.round_id = o.round_id)
            AND NOT EXISTS (SELECT 1 FROM fed_lock_settlements f WHERE f.round_id = o.round_id AND f.state <> 'ACCEPTED')
            AND NOT EXISTS (SELECT 1 FROM fed_lock_split p WHERE p.round_id = o.round_id AND NOT EXISTS
              (SELECT 1 FROM fed_lock_settlements f WHERE f.round_id = p.round_id AND f.federation_id = p.federation_id AND f.state = 'ACCEPTED'))))`).all()
      .map((r) => ({ roundId: new Uint8Array(r.round_id), entryId: new Uint8Array(r.entry_id) }));
  }

  /**
   * THE ROUNDS WHOSE LOCKS WERE SETTLED SINCE `sinceMs`, oldest first, with their locks' refund keys
   * (spec §24, 2026-09-14: a withdrawal claimed on another device). Public, as the
   * contract and the settlement are; nothing here names a player - the device derives its own
   * key per round from its seed and asks for it.
   */
  settledSince(sinceMs, limit = 500) {
    const refunds = this.db.prepare('SELECT fields FROM stake_locks WHERE round_id = ?');
    return this.db.prepare('SELECT round_id, state, made_ms FROM lock_settlements WHERE made_ms >= ? ORDER BY made_ms LIMIT ?')
      .all(Number(sinceMs), limit)
      .map((x) => ({ roundId: new Uint8Array(x.round_id), state: x.state, madeMs: Number(x.made_ms),
        // THE REFUND KEYS OF THE LOCKS THIS SIGNER NODE VERIFIED - each a player key's, public in its entry.
        refunds: refunds.all(x.round_id).map((l) => String(JSON.parse(l.fields).refundPk).toLowerCase()) }));
  }

  /** Donation outputs this signer node verified for one entry (2026-10-03): kept, and indexed by recipient key. */
  putDonationOutputs(rows) {
    const put = this.db.prepare('INSERT OR REPLACE INTO donation_outputs (outpoint, entry_id, round_id, federation_id, recipient_pk, amount_msat, contract_id, verified_ms, sender_on_contract, image, item, parts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows)
      put.run(`${Buffer.from(r.outpoint.txid).toString('hex')}:${r.outpoint.outIdx}`, Buffer.from(r.entryId), Buffer.from(r.roundId),
        Buffer.from(r.federationId), Buffer.from(r.recipientPk).toString('hex'), String(r.amountMsat), r.contractId, this.now(), r.senderOnContract ? 1 : 0,
        typeof r.image === 'string' ? r.image : null, typeof r.item === 'string' ? r.item.slice(0, 120) : null,
        Array.isArray(r.parts) && r.parts.length ? JSON.stringify(r.parts.slice(0, 500)) : null);
  }

  /**
   * DERIVED RESERVE ROWS, KEPT ONCE (kanban #1156): a payout's change, refund, claim or winners' outputs. A row already kept at that
   * outpoint with the same federation, key, amount and contract is left as it is; one with other fields is never replaced - this throws,
   * and the payout step that asked for it is undone (reserve-payout.js transition).
   */
  putDonationOutputsOnce(rows) {
    const had = this.db.prepare('SELECT federation_id, recipient_pk, amount_msat, contract_id FROM donation_outputs WHERE outpoint = ?');
    const fresh = [];
    for (const r of rows) {
      const o = `${Buffer.from(r.outpoint.txid).toString('hex')}:${r.outpoint.outIdx}`;
      const h = had.get(o);
      if (!h) { if (!fresh.some((x) => `${Buffer.from(x.outpoint.txid).toString('hex')}:${x.outpoint.outIdx}` === o)) fresh.push(r); continue; }
      const same = Buffer.from(h.federation_id).equals(Buffer.from(r.federationId)) && h.recipient_pk === Buffer.from(r.recipientPk).toString('hex')
        && String(h.amount_msat) === String(r.amountMsat) && h.contract_id === r.contractId;
      if (!same) throw new Error(`${o.slice(0, 16)}… is kept already with other fields: not replaced`);
    }
    if (fresh.length) this.putDonationOutputs(fresh);
  }

  /** How many donation-key outputs of this round's settlement are indexed. */
  settlementDonationOutputs(roundIdBytes) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM donation_outputs WHERE round_id = ? AND contract_id LIKE 'settlement:%'").get(Buffer.from(roundIdBytes)).n;
  }

  /** A standing outcome attestation of an attested round (§0A.7a), kept once by the id of its signed body. */
  putOutcomeAttestation({ bodyId, roundId, outcome, observedAtMs, bytes, receivedMs = Date.now() }) {
    return this.db.prepare('INSERT OR IGNORE INTO outcome_attestations (body_id, round_id, outcome, observed_ms, bytes, received_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(bodyId), Buffer.from(roundId), outcome, Number(observedAtMs), Buffer.from(bytes), receivedMs).changes === 1;
  }

  /**
   * A MARKET ON A GAME'S STANDING OUTCOME (feature 6), kept once per (market round, source result): the evidence
   * an attestation's bytes are for an attested round - the source's RoundResult bytes, the committee signatures that made it
   * stand, the source contract. `outcome` 255 is a VOID (a refund, or a source that can never fit). Answers whether it is new.
   */
  putGameOutcome({ roundId, resultId, sourceRoundId, outcome, why = null, result, sigs, source, observedMs, receivedMs = Date.now() }) {
    return this.db.prepare('INSERT OR IGNORE INTO game_outcomes (round_id, result_id, source_round_id, outcome, why, result, sigs, source, observed_ms, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(roundId), Buffer.from(resultId), Buffer.from(sourceRoundId), outcome, why, Buffer.from(result), JSON.stringify(sigs),
        Buffer.from(source), Number(observedMs), Number(receivedMs)).changes === 1;
  }

  /**
   * A MARKET ROUND'S PERSISTED STATE (kanban #1151, store.js market_states): { state, outcome?, value?, observedAtMs?, firstMs?,
   * finalAtMs?, reason?, why?, atMs } - or null: OPEN, nothing persisted yet.
   */
  marketState(roundIdBytes) {
    const r = this.db.prepare('SELECT state, outcome, value, observed_ms, first_ms, final_at_ms, reason, why, at_ms FROM market_states WHERE round_id = ?').get(Buffer.from(roundIdBytes));
    if (!r) return null;
    const out = { state: r.state, atMs: Number(r.at_ms) };
    if (r.outcome !== null) out.outcome = Number(r.outcome);
    if (r.value !== null) out.value = BigInt(r.value);
    if (r.observed_ms !== null) out.observedAtMs = BigInt(r.observed_ms);
    if (r.first_ms !== null) out.firstMs = Number(r.first_ms);
    if (r.final_at_ms !== null) out.finalAtMs = Number(r.final_at_ms);
    if (r.reason !== null) out.reason = r.reason;
    if (r.why !== null) out.why = r.why;
    return out;
  }

  /**
   * COMPARE-AND-SET a market round's state: `from` the state the caller read (null: no row, OPEN; 'ATTESTED' with the `fromFirstMs`
   * it read), `next` the state attested.js marketTransition answered. Answers true only if this write moved it; a row that moved
   * meanwhile, or a terminal one (never written again - the store's triggers refuse it too), answers false.
   */
  casMarketState(roundIdBytes, from, next, fromFirstMs = null) {
    if (from === 'FINAL' || from === 'VOID' || next.state === 'OPEN') return false;
    const cols = [next.state, Number.isInteger(next.outcome) ? next.outcome : null, typeof next.value === 'bigint' ? String(next.value) : null,
      next.observedAtMs !== undefined && next.observedAtMs !== null ? Number(next.observedAtMs) : null,
      Number.isFinite(next.firstMs) ? next.firstMs : null, Number.isFinite(next.finalAtMs) ? next.finalAtMs : null,
      next.reason || null, next.why || null, Number.isFinite(next.atMs) ? next.atMs : this.now()];
    if (from === null || from === undefined || from === 'OPEN')
      return this.db.prepare('INSERT OR IGNORE INTO market_states (state, outcome, value, observed_ms, first_ms, final_at_ms, reason, why, at_ms, round_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(...cols, Buffer.from(roundIdBytes)).changes === 1;
    return this.db.prepare("UPDATE market_states SET state = ?, outcome = ?, value = ?, observed_ms = ?, first_ms = ?, final_at_ms = ?, reason = ?, why = ?, at_ms = ? WHERE round_id = ? AND state = 'ATTESTED' AND first_ms IS ?")
      .run(...cols, Buffer.from(roundIdBytes), fromFirstMs).changes === 1;
  }

  /** Every game outcome this seat holds for a market round, oldest first: [{ resultId, sourceRoundId, outcome, why, result, sigs, source, observedMs, receivedMs }]. */
  gameOutcomes(roundIdBytes) {
    return this.db.prepare('SELECT result_id, source_round_id, outcome, why, result, sigs, source, observed_ms, received_ms FROM game_outcomes WHERE round_id = ? ORDER BY received_ms, result_id')
      .all(Buffer.from(roundIdBytes)).map((r) => ({ resultId: new Uint8Array(r.result_id), sourceRoundId: new Uint8Array(r.source_round_id), outcome: Number(r.outcome),
        why: r.why, result: new Uint8Array(r.result), sigs: JSON.parse(r.sigs), source: new Uint8Array(r.source), observedMs: Number(r.observed_ms), receivedMs: Number(r.received_ms) }));
  }

  /** A market entry's cancel, kept once: its player's signature over cancelId. */
  putCancel({ roundId, entryId, signature, receivedMs = Date.now() }) {
    return this.db.prepare('INSERT OR IGNORE INTO market_cancels (entry_id, round_id, signature, received_ms) VALUES (?, ?, ?, ?)')
      .run(Buffer.from(entryId), Buffer.from(roundId), Buffer.from(signature), receivedMs).changes === 1;
  }

  cancelled(entryIdBytes) {
    return !!this.db.prepare('SELECT 1 FROM market_cancels WHERE entry_id = ?').get(Buffer.from(entryIdBytes));
  }

  /** Every cancel this seat holds for a round: [{ entryId, signature, receivedMs }]. */
  cancelsOf(roundIdBytes) {
    return this.db.prepare('SELECT entry_id, signature, received_ms FROM market_cancels WHERE round_id = ? ORDER BY entry_id')
      .all(Buffer.from(roundIdBytes)).map((r) => ({ entryId: new Uint8Array(r.entry_id), signature: new Uint8Array(r.signature), receivedMs: Number(r.received_ms) }));
  }

  /**
   * THE IDENTITY A PLAYER'S NAME RECORD NAMES IN A ROUND (kanban #1224): the record is signed by the entry's own round key and, since #1213,
   * fixed at the entry close - so a head-to-head reveal's identity is the player's only when it is this one. Hex, or null with no record held.
   */
  /** When this seat first took an entry of that player in that round (entries.joined_ms, this seat's clock), or null (kanban #1267). */
  joinedMsOfPlayer(roundIdBytes, playerPubkeyBytes) {
    const want = Buffer.from(playerPubkeyBytes).toString('hex');
    let at = null;
    for (const r of this.db.prepare('SELECT contract, joined_ms FROM entries WHERE round_id = ?').iterate(Buffer.from(roundIdBytes))) {
      let e; try { e = decodeEntryContract(new Uint8Array(r.contract)); } catch { continue; }
      if (Buffer.from(e.playerPubkey).toString('hex') === want && (at === null || Number(r.joined_ms) < at)) at = Number(r.joined_ms);
    }
    return at;
  }

  namedIdentityOf(roundIdBytes, playerPubkeyBytes) {
    const r = this.db.prepare('SELECT record FROM lobby_names WHERE round_id = ? AND player_pubkey = ?').get(Buffer.from(roundIdBytes), Buffer.from(playerPubkeyBytes));
    if (!r) return null;
    // the record's layout (lobby-name.js encodeLobbyName): round id (32), player key (32), identity key (32), ...
    const b = new Uint8Array(r.record);
    return b.length >= 96 ? Buffer.from(b.subarray(64, 96)).toString('hex') : null;
  }

  /**
   * THE IDENTITY A PLAYER CONSENTED TO FOR A ROUND (kanban #1278; audit 5 #1401): the identity its name record names, only where that record carries
   * the identity's own signature (identity_sig) - taken at the join, before the entry close (#1213/#1263/#1267). Hex, or null.
   */
  consentedIdentityOf(roundIdBytes, playerPubkeyBytes) {
    const r = this.db.prepare('SELECT record, identity_sig FROM lobby_names WHERE round_id = ? AND player_pubkey = ?').get(Buffer.from(roundIdBytes), Buffer.from(playerPubkeyBytes));
    if (!r || !r.identity_sig) return null;
    const b = new Uint8Array(r.record);
    return b.length >= 96 ? Buffer.from(b.subarray(64, 96)).toString('hex') : null;
  }

  /** A head-to-head entry's identity, kept once: the key and its signature over matchProofId. */
  putIdentity({ roundId, entryId, identity, sig }) {
    return this.db.prepare('INSERT OR IGNORE INTO h2h_identities (entry_id, round_id, identity, sig) VALUES (?, ?, ?, ?)')
      .run(Buffer.from(entryId), Buffer.from(roundId), Buffer.from(identity), Buffer.from(sig)).changes === 1;
  }

  identityOf(entryIdBytes) {
    const r = this.db.prepare('SELECT identity, sig FROM h2h_identities WHERE entry_id = ?').get(Buffer.from(entryIdBytes));
    return r ? { identity: new Uint8Array(r.identity), sig: new Uint8Array(r.sig) } : null;
  }

  /** The rounds an identity named an entry in, newest entry first: [{ roundId, entryId }]. */
  roundsOfIdentity(identity) {
    return this.db.prepare('SELECT round_id, entry_id FROM h2h_identities WHERE identity = ?').all(Buffer.from(identity))
      .map((r) => ({ roundId: new Uint8Array(r.round_id), entryId: new Uint8Array(r.entry_id) }));
  }

  /** A head-to-head entry's stood reveal, kept once: a second for the same entry changes nothing. */
  putReveal({ roundId, entryId, move, salt, receivedMs = Date.now() }) {
    return this.db.prepare('INSERT OR IGNORE INTO head_to_head_reveals (round_id, entry_id, move, salt, received_ms) VALUES (?, ?, ?, ?, ?)')
      .run(Buffer.from(roundId), Buffer.from(entryId), move, Buffer.from(salt), receivedMs).changes === 1;
  }

  /** Every reveal this seat holds for a round: [{ entryId, move, salt, receivedMs }]. */
  revealsOf(roundIdBytes) {
    return this.db.prepare('SELECT entry_id, move, salt, received_ms FROM head_to_head_reveals WHERE round_id = ? ORDER BY entry_id')
      .all(Buffer.from(roundIdBytes)).map((r) => ({ entryId: new Uint8Array(r.entry_id), move: Number(r.move), salt: new Uint8Array(r.salt), receivedMs: Number(r.received_ms) }));
  }

  /** Every standing attestation this seat holds for a round, oldest first. */
  outcomeAttestations(roundIdBytes) {
    return this.db.prepare('SELECT body_id, outcome, observed_ms, bytes, received_ms FROM outcome_attestations WHERE round_id = ? ORDER BY received_ms, body_id')
      .all(Buffer.from(roundIdBytes));
  }

  /** The backfill's counted tries at a round it could not rebuild: { tries, lastMs }, or null. */
  backfillTry(roundIdBytes) {
    const r = this.db.prepare('SELECT tries, last_ms FROM donation_backfill_tries WHERE round_id = ?').get(Buffer.from(roundIdBytes));
    return r ? { tries: Number(r.tries), lastMs: Number(r.last_ms) } : null;
  }

  putBackfillTry(roundIdBytes, tries, atMs) {
    this.db.prepare('INSERT OR REPLACE INTO donation_backfill_tries (round_id, tries, last_ms) VALUES (?, ?, ?)')
      .run(Buffer.from(roundIdBytes), Number(tries), Number(atMs));
  }

  /** The backfill's marker: a recovered settlement already passed over, so it is never asked again. */
  donationBackfilled(roundIdBytes) {
    return !!this.db.prepare('SELECT 1 FROM donation_backfill WHERE round_id = ?').get(Buffer.from(roundIdBytes));
  }

  markDonationBackfilled(roundIdBytes, { indexed = 0, why = null } = {}) {
    this.db.prepare('INSERT OR REPLACE INTO donation_backfill (round_id, indexed, why, made_ms) VALUES (?, ?, ?, ?)')
      .run(Buffer.from(roundIdBytes), Number(indexed), why, this.now());
  }

  /** The entry a verified donation output at this outpoint already pays for, or null: one output is one entry's. */
  donationOutputAt(outpoint) {
    const r = this.db.prepare('SELECT entry_id FROM donation_outputs WHERE outpoint = ?')
      .get(`${Buffer.from(outpoint.txid).toString('hex')}:${outpoint.outIdx}`);
    return r ? { entryId: new Uint8Array(r.entry_id) } : null;
  }

  /** WHAT A RECIPIENT KEY WAS DONATED, oldest first, from `sinceMs`: every output this signer node verified for it. */
  donationsFor(recipientHex, sinceMs = 0) {
    // READ ONCE PER CHANGE OF THE TABLE (kanban #576, measured on test host seat 1: GET /reserves - every seat asks every other every
    // 2 min - allocated ~218 MB/min here, each row's stored entry decoded again on every call): a recipient's whole list is kept until
    // a row is added, replaced or deleted (the table's newest rowid and its count), and handed out as a new array of the same rows
    const all = !(Number(sinceMs) > 0);
    if (all) {
      this._donationStamp ||= this.db.prepare('SELECT max(rowid) AS m, count(*) AS n FROM donation_outputs');
      const st = this._donationStamp.get(), tag = `${st.m}:${st.n}`;
      if (this._donationTag !== tag) { this._donationTag = tag; this._donationKept = new Map(); }
      const was = this._donationKept.get(String(recipientHex).toLowerCase());
      if (was) return was.slice();
    }
    // AND WHO SENT IT (2026-10-05): the entry's player key, read from the stored entry; whether that key
    // is also on the Fedimint contract (its payment image) or the contract carries the zero image of an older page.
    const playerOf = (entryId) => { const e = this.entry(entryId); try { return e ? Buffer.from(decodeEntryContract(e).playerPubkey).toString('hex') : null; } catch { return null; } };
    const rows = this.db.prepare('SELECT outpoint, entry_id, round_id, federation_id, amount_msat, contract_id, verified_ms, sender_on_contract, image, item, parts FROM donation_outputs WHERE recipient_pk = ? AND verified_ms >= ? ORDER BY verified_ms, outpoint LIMIT 5000')
      .all(String(recipientHex).toLowerCase(), Math.max(0, Math.floor(Number(sinceMs) || 0)))
      .map((r) => ({ outpoint: r.outpoint, entryId: Buffer.from(r.entry_id).toString('hex'), roundId: Buffer.from(r.round_id).toString('hex'),
        federationId: Buffer.from(r.federation_id).toString('hex'), amountMsat: r.amount_msat, contractId: r.contract_id, verifiedMs: Number(r.verified_ms),
        playerKey: playerOf(new Uint8Array(r.entry_id)) || r.image || null, senderOnContract: r.sender_on_contract === 1, ...(r.item ? { item: r.item } : {}),
        // a market's donation: each filled order's part (kanban #580)
        ...(r.parts ? (() => { try { return { parts: JSON.parse(r.parts) }; } catch { return {}; } })() : {}) }));
    if (all) this._donationKept.set(String(recipientHex).toLowerCase(), rows);
    return all ? rows.slice() : rows;
  }

  /**
   * THE DEV HAS READ THEM (2026-10-05 08:15-08:17): the rows of these outpoints, for this recipient key
   * only, deleted entirely - round id, entry, sender, amount. The durable record is the dev client's. Answers how many went.
   */
  deleteDonationsRead(recipientHex, outpoints) {
    const del = this.db.prepare('DELETE FROM donation_outputs WHERE recipient_pk = ? AND outpoint = ?');
    let n = 0;
    for (const o of outpoints) n += del.run(String(recipientHex).toLowerCase(), String(o)).changes;
    return n;
  }

  /** The entry a verified fee lock at this outpoint already pays for, or null (never returned as refused). */
  feeLockAt(outpoint) {
    const r = this.db.prepare('SELECT entry_id FROM fee_locks WHERE outpoint = ?')
      .get(`${Buffer.from(outpoint.txid).toString('hex')}:${outpoint.outIdx}`);
    return r ? { entryId: new Uint8Array(r.entry_id) } : null;
  }

  /**
   * THE ENTRY THAT FIRST NAMED THIS LOCK OUTPOINT HERE (kanban #1489): the id of the earliest entry of the round (by the time this seat took it)
   * whose `kind` ('stake' | 'fee') lock outpoint is `outpoint`, or null. A lock is handed only for the entry that named it first.
   */
  firstEntryNamingLock(roundIdBytes, kind, outpoint) {
    const field = kind === 'fee' ? 'feeLockOutpoint' : 'stakeLockOutpoint';
    const rows = this.db.prepare(
      'SELECT entry_id, contract FROM entries WHERE round_id = ? AND entry_id NOT IN (SELECT entry_id FROM market_cancels) ORDER BY joined_ms, rowid')
      .all(roundIdBytes);
    for (const r of rows) {
      const o = decodeEntryContract(new Uint8Array(r.contract))[field];
      if (o && same(o.txid, outpoint.txid) && o.outIdx === outpoint.outIdx) return new Uint8Array(r.entry_id);
    }
    return null;
  }

  /** The entry a verified lock at this outpoint already stakes, or null: one lock is one entry. */
  stakeLockAt(outpoint) {
    const r = this.db.prepare('SELECT entry_id FROM stake_locks WHERE outpoint = ?')
      .get(`${Buffer.from(outpoint.txid).toString('hex')}:${outpoint.outIdx}`);
    return r ? { entryId: new Uint8Array(r.entry_id) } : null;
  }

  /**
   * THE COMPLETE PROOF OF A FILED RECORD (5A.3B, kanban #1065), kept here under H(fraud_proof) as a relay keeps one: the record, the round's contract and, where `entryIdBytes` names an entry, its contract
   * and the objection that held (`bundle`, by default the one against the first run). A row from before bundles were kept has none, and no checker can judge it. Answers { id, bytes }.
   */
  fraudProof(roundIdBytes, entryIdBytes, evidence, bundle = entryIdBytes ? this.objectionBundle(roundIdBytes, entryIdBytes) : null) {
    const row = this.get(roundIdBytes);
    const bytes = encodeFraudProof({ evidence, contract: new Uint8Array(row.contract), ...(entryIdBytes ? { entry: this.entry(entryIdBytes) || undefined } : {}), ...(bundle ? { bundle } : {}) });
    const id = fraudProofHash(bytes);
    this.relayPut(id, bytes);
    return { id, bytes };
  }

  /** A transcript kept as a relay, under the hash its bytes have (checked by the door). */
  relayPut(hashBytes, bytes) {
    return this.db.prepare('INSERT OR IGNORE INTO relayed (hash, bytes, seen_ms) VALUES (?, ?, ?)')
      .run(hashBytes, bytes, this.now()).changes;
  }

  /** The bytes this node keeps as a relay, all doors together (kanban #1532: the doors refuse past a cap). */
  relayedBytes() {
    return Number(this.db.prepare('SELECT COALESCE(SUM(LENGTH(bytes)), 0) AS n FROM relayed').get().n);
  }

  relayGet(hashBytes) {
    const row = this.db.prepare('SELECT bytes FROM relayed WHERE hash = ?').get(hashBytes);
    return row ? new Uint8Array(row.bytes) : null;
  }

  /** Every signed result this node holds for a run, its own included. */
  results(roundIdBytes, entryIdBytes) {
    return this.db.prepare(
      'SELECT node_pubkey, result_id, bytes, seen_ms FROM results '
      + 'WHERE round_id = ? AND entry_id = ? ORDER BY node_pubkey')
      .all(roundIdBytes, entryIdBytes)
      .map((r) => ({
        nodePubkey: new Uint8Array(r.node_pubkey),
        resultId: new Uint8Array(r.result_id),
        bytes: new Uint8Array(r.bytes),
        seenMs: r.seen_ms,
      }));
  }

  /**
   * RECORD AN OBJECTION AGAINST A RUN (13A intake only).
   *
   * What an objection COSTS and who may make one is the objection protocol and
   * is not decided here. What is decided here is that the node knows one
   * exists, because the replay queue puts objected runs first and a priority
   * nothing can ever set is a priority that does not exist.
   */
  object(roundIdBytes, entryIdBytes, blockHash = null, bundle = null, seenMs = null) {
    if (!this.get(roundIdBytes)) throw new Error('no such round');
    const e = this.db.prepare('SELECT round_id FROM entries WHERE entry_id = ?').get(entryIdBytes);
    if (!e) throw new Error('no such entry');
    if (!same(new Uint8Array(e.round_id), roundIdBytes)) throw new Error('entry is not in this round');
    return this.db.prepare(
      'INSERT OR IGNORE INTO objections (round_id, entry_id, seen_ms, block_hash, bundle) VALUES (?, ?, ?, ?, ?)')
      .run(roundIdBytes, entryIdBytes, seenMs ?? this.now(), blockHash ? Buffer.from(blockHash) : null, bundle ? Buffer.from(bundle) : null).changes === 1;
  }

  /** The block the objection against this run names (§13A, RULED 2026-09-24), or null. */
  objectedBlock(roundIdBytes, entryIdBytes) {
    const row = this.db.prepare('SELECT block_hash FROM objections WHERE round_id = ? AND entry_id = ?').get(roundIdBytes, entryIdBytes);
    return row && row.block_hash ? new Uint8Array(row.block_hash) : null;
  }

  /** Is there an objection against this run? */
  objected(roundIdBytes, entryIdBytes) {
    return !!this.db.prepare(
      'SELECT 1 FROM objections WHERE round_id = ? AND entry_id = ?')
      .get(roundIdBytes, entryIdBytes);
  }

  /**
   * THE BUNDLE THE OBJECTION AGAINST THIS RUN CARRIED (§13A): checked at the door before it was stored, so a
   * row that has one holds a replay that contradicts the signed result. Null for none, or for a row from before.
   */
  objectionBundle(roundIdBytes, entryIdBytes) {
    const row = this.db.prepare('SELECT bundle FROM objections WHERE round_id = ? AND entry_id = ?').get(roundIdBytes, entryIdBytes);
    return row && row.bundle ? new Uint8Array(row.bundle) : null;
  }

  /** And the one against the agreed re-run. */
  rerunObjectionBundle(roundIdBytes, entryIdBytes) {
    const row = this.db.prepare('SELECT bundle FROM rerun_objections WHERE round_id = ? AND entry_id = ?').get(roundIdBytes, entryIdBytes);
    return row && row.bundle ? new Uint8Array(row.bundle) : null;
  }

  /** When the objection against this run arrived here, or null if none did. */
  objectedAt(roundIdBytes, entryIdBytes) {
    const row = this.db.prepare(
      'SELECT seen_ms FROM objections WHERE round_id = ? AND entry_id = ?')
      .get(roundIdBytes, entryIdBytes);
    return row ? row.seen_ms : null;
  }

  /** An objection being checked (kanban #1173): kept at its arrival, before its replay runs. */
  putPendingObjection(roundIdBytes, entryIdBytes, arrivedMs) {
    this.db.prepare('INSERT OR IGNORE INTO pending_objections (round_id, entry_id, arrived_ms) VALUES (?, ?, ?)')
      .run(Buffer.from(roundIdBytes), Buffer.from(entryIdBytes), Number(arrivedMs));
  }

  /** Its check answered (taken or refused): the pending row goes. */
  dropPendingObjection(roundIdBytes, entryIdBytes, arrivedMs) {
    this.db.prepare('DELETE FROM pending_objections WHERE round_id = ? AND entry_id = ? AND arrived_ms = ?')
      .run(Buffer.from(roundIdBytes), Buffer.from(entryIdBytes), Number(arrivedMs));
  }

  /** The earliest arrival of an objection still being checked, no older than `sinceMs` - or null. */
  pendingObjectionAt(roundIdBytes, entryIdBytes, sinceMs = 0) {
    const r = this.db.prepare('SELECT MIN(arrived_ms) AS at FROM pending_objections WHERE round_id = ? AND entry_id = ? AND arrived_ms >= ?')
      .get(Buffer.from(roundIdBytes), Buffer.from(entryIdBytes), Number(sinceMs));
    return r && r.at !== null && r.at !== undefined ? Number(r.at) : null;
  }

  /** A restarted seat's checks are gone with its process: their pending rows go too (kanban #1173). Answers how many. */
  clearPendingObjections() { return this.db.prepare('DELETE FROM pending_objections').run().changes; }

  /** The entry FINAL at this seat (kanban #1173): kept once, the first that stood; true when this call kept it. */
  putEntryFinal({ roundId, entryId, runId, finalAfterMs, onRerun = false, atMs }) {
    return this.db.prepare('INSERT OR IGNORE INTO entry_finals (round_id, entry_id, run_id, final_after_ms, on_rerun, at_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Buffer.from(roundId), Buffer.from(entryId), String(runId), Number(finalAfterMs), onRerun ? 1 : 0, Number(atMs)).changes === 1;
  }

  entryFinal(roundIdBytes, entryIdBytes) {
    const r = this.db.prepare('SELECT run_id, final_after_ms, on_rerun, at_ms FROM entry_finals WHERE round_id = ? AND entry_id = ?')
      .get(Buffer.from(roundIdBytes), Buffer.from(entryIdBytes));
    return r ? { runId: r.run_id, finalAfterMs: Number(r.final_after_ms), onRerun: r.on_rerun === 1, atMs: Number(r.at_ms) } : null;
  }

  /**
   * RECORD THE OBJECTION AGAINST AN AGREED RE-RUN (§13A, slice C2b), the same intake as `object` for the second
   * window: one per entry, when it arrived here. Whether it is in time and holds is `resultFinality`'s to say.
   */
  objectRerun(roundIdBytes, entryIdBytes, blockHash = null, bundle = null, seenMs = null) {
    if (!this.get(roundIdBytes)) throw new Error('no such round');
    const e = this.db.prepare('SELECT round_id FROM entries WHERE entry_id = ?').get(entryIdBytes);
    if (!e) throw new Error('no such entry');
    if (!same(new Uint8Array(e.round_id), roundIdBytes)) throw new Error('entry is not in this round');
    return this.db.prepare(
      'INSERT OR IGNORE INTO rerun_objections (round_id, entry_id, seen_ms, block_hash, bundle) VALUES (?, ?, ?, ?, ?)')
      .run(roundIdBytes, entryIdBytes, seenMs ?? this.now(), blockHash ? Buffer.from(blockHash) : null, bundle ? Buffer.from(bundle) : null).changes === 1;
  }

  /** The block the objection against this run's agreed re-run names, or null. */
  rerunObjectedBlock(roundIdBytes, entryIdBytes) {
    const row = this.db.prepare('SELECT block_hash FROM rerun_objections WHERE round_id = ? AND entry_id = ?').get(roundIdBytes, entryIdBytes);
    return row && row.block_hash ? new Uint8Array(row.block_hash) : null;
  }

  /** When the objection against this run's agreed re-run arrived here, or null if none did. */
  rerunObjectedAt(roundIdBytes, entryIdBytes) {
    const row = this.db.prepare(
      'SELECT seen_ms FROM rerun_objections WHERE round_id = ? AND entry_id = ?')
      .get(roundIdBytes, entryIdBytes);
    return row ? row.seen_ms : null;
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
