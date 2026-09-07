// THE PLAYER'S HALF OF THE PROTOCOL.
//
// The node is a store. It takes rounds, entries, batches and checkpoints, it
// refuses the ones that break a rule, and it cannot recompute any of them -
// `blwp-node/src` imports no core on purpose, because a daemon that recomputed
// the state would be a second simulator and then two of them could disagree.
//
// So the state hash has to come from HERE, off the same core the player is
// watching. That is the whole reason this file exists.
//
// WHAT IT IS NOT. It is not a simulator and it holds no rule: it never decides
// a score, a crater, a hit or a winner. It reads a hash the core produced,
// wraps it in the protocol's own encoding, signs it, and puts it on a socket.
// Every byte that crosses the wire is written by `@blwp/protocol` - there is
// no second encoder here, and there must never be one, because a wire format
// with two implementations is a wire format with two answers.
//
// WHAT IS INJECTED, AND WHY. The core and the signing function are handed in
// rather than imported. In a browser the core is the bundle already running in
// the page - the very object the game is drawing from - and the session key
// belongs to the run, not to this module; in a test the core is that same
// bundle loaded through `require`. Importing either here would give this file
// an opinion about which core the player is running, which is the one thing it
// must not have.
import {
  encodeCheckpoint, decodeCheckpoint, checkpointId, joinSigned, splitSigned,
  NO_PREVIOUS, SIGNED_CHECKPOINT_BYTES,
} from '../../protocol/src/checkpoint.js';
import {
  encodeRoundContract, encodeEntryContract, roundId, entryId,
} from '../../protocol/src/contracts.js';
import {
  GENESIS, decodeTranscript, checkTranscript,
} from '../../protocol/src/transcript.js';
import { encodeInputBatch, batchId, batchTicks } from '../../protocol/src/batch.js';
import { fromHex, toHex } from '../../protocol/src/hash.js';
import {
  decodeCheckpointReceipt, receiptId, splitSignedReceipt, SIGNED_RECEIPT_BYTES,
} from '../../protocol/src/receipt.js';

/**
 * A checkpoint over the state a core is holding, signed and ready for the wire.
 *
 * `core.hash(st)` is the only thing read out of the simulation, and it is read
 * rather than computed: this file could not produce that number if it wanted
 * to, which is the property that keeps the client a television.
 *
 * The tagged id is what gets signed, never the raw encoding - every other
 * object in this protocol is committed to through its tagged hash, and keeping
 * that means a signature here can never be replayed as a signature over some
 * other object that happens to encode to the same bytes.
 *
 * `previousHash` names the chain head, `NO_PREVIOUS` for the first mark of a
 * round; `inputChainHash` names the batches this state claims to come from,
 * `GENESIS` for a mark taken before any batch was sent, which the node allows
 * by name.
 */
export async function markState(core, st, {
  roundId, entryId, tick,
  previousHash = NO_PREVIOUS,
  inputChainHash = GENESIS,
}, sign) {
  // THE ONE CONVERSION, and it is the client's to make. The core answers in
  // HEX - `hash(st)` returns 64 characters, and the WebGL bridge writes those
  // same characters as ASCII into a caller's buffer - while the protocol's
  // field is thirty-two raw bytes. `fromHex` is the protocol's own, so the two
  // ends of this line agree by construction rather than by two spellings of
  // the same loop.
  return markHashed(core.hash(st), { roundId, entryId, tick, previousHash, inputChainHash }, sign);
}

/**
 * The same mark, from a hash that was already taken.
 *
 * Separated because a checkpoint says where the world was AT A TICK, and the
 * hash therefore has to be read at that tick - not when a queue gets round to
 * it. Whoever takes it early passes it here. It used to be smuggled through a
 * fake core object whose `hash` returned the string it had been handed, which
 * worked and read like a trick; this is the same thing said plainly.
 */
export async function markHashed(hex, {
  roundId, entryId, tick,
  previousHash = NO_PREVIOUS,
  inputChainHash = GENESIS,
}, sign) {
  // Checked rather than trusted: a core that answered anything but 64 hex
  // characters would otherwise be silently truncated or padded into a mark
  // that signs cleanly and commits to the wrong state.
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex))
    throw new Error(`the core did not answer a state hash: ${String(hex).slice(0, 80)}`);
  const stateHash = fromHex(hex);
  const c = { roundId, entryId, tick, stateHash, inputChainHash, previousHash };
  const id = checkpointId(c);
  // AWAITED, so the browser's own Ed25519 can be used.
  //
  // `crypto.subtle` is async and a vendored JS curve is not - and vendoring
  // one would put a signing implementation in the trust path of the thing
  // that pins money, which is the same objection `tools/bundle.js` records
  // about bundlers. Awaiting a value that is not a promise costs nothing, so
  // a synchronous signer still works exactly as it did.
  return { checkpoint: c, id, bytes: joinSigned(encodeCheckpoint(c), await sign(id)) };
}

/**
 * A player against one node: the two HTTP doors, the socket, and the mark.
 *
 * `fetch` and `WebSocket` are the platform's, in a browser and in Node alike,
 * so this carries no transport dependency of its own.
 */
function agrees(mine, theirs, what) {
  if (theirs.length !== mine.length || mine.some((b, i) => b !== theirs[i]))
    throw new Error(
      `the node calls this ${what} ${toHex(theirs)}, and its contract hashes to ${toHex(mine)}`);
  return mine;
}

export class Client {
  constructor({ base, core, sign, verify }) {
    this.base = base;
    this.core = core;
    this.sign = sign;
    // Verifying is injected for the same reason signing is: the curve belongs
    // to whoever runs the client, and this file should not decide it.
    this.verify = verify;
    this.sock = null;
    this.head = NO_PREVIOUS;      // the mark chain head this client has published
    this.batchHead = GENESIS;     // and the input chain's, which is a separate chain
    this.nextTick = 0;            // the tick the node is owed next
    this.nodes = [];              // the committee, off the round's own contract
    this.hold = [];               // ticks waiting to go out
    this.held = 0;
    this.dropped = 0;
    this.maxHold = 0;
    this.chunk = 600;
    this.batchesSent = 0;
    this.marksSent = 0;
    this.marksSkipped = 0;
    this.publishing = null;
    this.marking = null;
    this.said = [];
  }

  /**
   * Opens a round, and does NOT take the node's word for what it is called.
   *
   * An id here is the tagged hash of a contract the client itself wrote, so
   * the client can compute it and has no reason to be told it. Taking the
   * answer instead would mean every mark of the round is filed under an id
   * the player cannot show belongs to their own contract - and the whole
   * point of this protocol is that a node is not trusted. The node's answer
   * is still read, and it is read as AGREEMENT: if it names something else,
   * that is a disagreement about which round this is and there is nothing to
   * play until it is settled.
   */
  async openRound(contract) {
    // The committee is in the contract the client itself wrote, so the key a
    // receipt must carry is known before a single mark is sent - no census,
    // no directory, nothing taken on a node's word.
    this.nodes = [...contract.nodes];
    const mine = roundId(contract);
    const r = await fetch(`${this.base}/round`, {
      method: 'POST', body: encodeRoundContract(contract),
    });
    if (r.status !== 201) throw new Error(`the node refused the round: ${(await r.text()).trim()}`);
    return agrees(mine, new Uint8Array(await r.arrayBuffer()), 'round');
  }

  /**
   * Joins it. The entry contract carries the session key the marks are signed
   * with, and its id is checked the same way and for the same reason.
   */
  async join(entry) {
    const mine = entryId(entry);
    const r = await fetch(`${this.base}/entry`, {
      method: 'POST', body: encodeEntryContract(entry),
    });
    if (r.status !== 201) throw new Error(`the node refused the entry: ${(await r.text()).trim()}`);
    return agrees(mine, new Uint8Array(await r.arrayBuffer()), 'entry');
  }

  /**
   * The play socket. One connection carries both kinds - the first byte is the
   * protocol's type - so there is no second socket and no envelope.
   *
   * Answers are matched to sends in order, which is what the node does: it
   * replies to each message on the same socket in the order they arrive.
   */
  connect() {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(`${this.base.replace(/^http/, 'ws')}/play`);
      // Binary arrives as a Blob otherwise, and `new Uint8Array(blob)` is
      // silently EMPTY rather than an error - measured: a 139-byte receipt
      // read back as a zero-length array and the reply was never understood.
      sock.binaryType = 'arraybuffer';
      sock.addEventListener('error', (e) => reject(new Error(e.message || 'socket error')));
      sock.addEventListener('message', (e) => {
        const waiting = this.said.shift();
        if (waiting) waiting(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
      });
      sock.addEventListener('open', () => { this.sock = sock; resolve(this); });

      // A DROPPED SOCKET IS NOT AN ERROR, it is the normal thing that happens
      // to a socket. Everything still waiting for an answer is told so by
      // name, or it would wait for one that can no longer arrive - a publish
      // that never settles stops the queue behind it for the rest of the run.
      sock.addEventListener('close', () => {
        if (this.sock !== sock) return;                 // already replaced
        this.sock = null;
        const waiting = this.said;
        this.said = [];
        for (const w of waiting) w('error the socket closed');
        if (this.onDrop) this.onDrop();
      });
    });
  }

  send(message) {
    // Answered rather than thrown, and in the same shape a refusal takes, so
    // a caller that already handles "the node said no" handles this too. A
    // throw here would escape the publish queue and take the run with it.
    if (!this.sock || this.sock.readyState !== 1)
      return Promise.resolve('error there is no socket');
    return new Promise((r) => { this.said.push(r); this.sock.send(message); });
  }

  /**
   * Commits to where the world is, at a tick, and remembers the head.
   *
   * The head is advanced only when the node says it STORED the mark. A client
   * that moved its own head on a refusal would chain the next one onto a
   * parent nobody has, and every mark after it would be refused for a reason
   * that had nothing to do with it.
   */
  /** A mark from a hash already taken - see `markHashed`. */
  async mark(hex, { roundId, entryId, tick, inputChainHash = GENESIS }) {
    const built = await markHashed(hex, {
      roundId, entryId, tick, previousHash: this.head, inputChainHash,
    }, this.sign);
    const answer = await this.send(built.bytes);
    if (typeof answer === 'string') return { ...built, answer, receipt: null };
    return { ...built, answer: 'receipted', receipt: this.readReceipt(answer, built.id) };
  }

  async checkpoint(st, { roundId, entryId, tick, inputChainHash = GENESIS }) {
    const mark = await markHashed(this.core.hash(st), {
      roundId, entryId, tick, previousHash: this.head, inputChainHash,
    }, this.sign);
    const answer = await this.send(mark.bytes);

    // A REFUSAL IS A STRING AND STAYS ONE. The node names its reasons -
    // "equivocation at tick 60", "expected a tick after 60" - and a client
    // that turned them into an exception would lose the name.
    if (typeof answer === 'string') return { ...mark, answer, receipt: null };

    return { ...mark, answer: 'receipted', receipt: this.readReceipt(answer, mark.id) };
  }

  /**
   * The node's answer to a mark, checked rather than believed.
   *
   * A receipt is the only thing the player gets back that is worth anything
   * later: section 12 puts `receipts[]` in the round record, and section 13B's
   * equivocation proof is built out of signed objects, not out of a node
   * having said a word once. So every part of it is checked here, and each
   * way it can be wrong is refused BY NAME - a receipt for another mark, a
   * key that is not on this round's committee, and a signature that does not
   * verify are three different failures and a client that reported them as
   * one would be hiding which.
   *
   * The head moves only after all three pass. It used to move on the word
   * 'stored'; a client that advanced its chain on an answer it had not
   * checked would be chaining onto a commitment nobody has promised to hold.
   */
  readReceipt(bytes, markId) {
    if (bytes.length !== SIGNED_RECEIPT_BYTES)
      throw new Error(`a receipt is ${SIGNED_RECEIPT_BYTES} bytes, the node sent ${bytes.length}`);
    const { body, signature } = splitSignedReceipt(bytes);
    const r = decodeCheckpointReceipt(body);

    if (toHex(r.checkpointId) !== toHex(markId))
      throw new Error(
        `the receipt is for ${toHex(r.checkpointId)}, and the mark just sent was ${toHex(markId)}`);

    if (!this.nodes.some((n) => toHex(n) === toHex(r.nodePubkey)))
      throw new Error(
        `the receipt is signed by ${toHex(r.nodePubkey)}, which is not on this round's committee`);

    if (!this.verify(signature, receiptId(r), r.nodePubkey))
      throw new Error(
        `the receipt from ${toHex(r.nodePubkey)} does not verify under its own key`);

    this.head = markId;
    return r;
  }

  /**
   * The receipts this node holds for a round, checked the same way as the ones
   * that came back live.
   *
   * This is what a client asks for after a reconnect. It can recompute every
   * mark it ever sent, because it built them; it cannot rebuild a signature
   * over one, so the receipts are the only part of its own round it has to
   * fetch. Verified rather than trusted for the same reason as before: a
   * receipt taken on a node's word is not evidence of anything.
   */
  async recoverReceipts({ roundId, entryId }) {
    const r = await fetch(
      `${this.base}/receipts?round=${toHex(roundId)}&entry=${toHex(entryId)}`);
    if (!r.ok) throw new Error(`the node refused the receipts: ${(await r.text()).trim()}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length % SIGNED_RECEIPT_BYTES !== 0)
      throw new Error(
        `${bytes.length} bytes is not a whole number of ${SIGNED_RECEIPT_BYTES}-byte receipts`);

    const out = [];
    for (let at = 0; at < bytes.length; at += SIGNED_RECEIPT_BYTES) {
      const one = bytes.subarray(at, at + SIGNED_RECEIPT_BYTES);
      const { body, signature } = splitSignedReceipt(one);
      const rec = decodeCheckpointReceipt(body);
      if (!this.nodes.some((n) => toHex(n) === toHex(rec.nodePubkey)))
        throw new Error(
          `a receipt signed by ${toHex(rec.nodePubkey)}, which is not on this round's committee`);
      if (!this.verify(signature, receiptId(rec), rec.nodePubkey))
        throw new Error(
          `the receipt from ${toHex(rec.nodePubkey)} does not verify under its own key`);
      out.push({ receipt: rec, bytes: one });
    }
    return out;
  }

  /**
   * Publishes a stretch of inputs.
   *
   * Section 11: inputs are hash-chained, and the client keeps its own copy -
   * "publishing is the client's duty, and unpublished inputs cost the player
   * the run". So the chain head and the next due tick live here, and the node
   * is never asked to remember them on the client's behalf.
   *
   * `ticks` is five Q16.16 words each, exactly what the core's `step` takes.
   * Nothing is computed from them here; they are carried.
   */
  async batch(ticks, { roundId, entryId, liquidations = [] }) {
    const b = {
      roundId, entryId,
      previousHash: this.batchHead,
      firstTick: this.nextTick,
      ticks,
      liquidations,
    };
    const answer = await this.send(encodeInputBatch(b));

    // The node answers how many ticks were NEW. A refusal is a named string
    // and the chain must not move on one, the same rule the marks follow.
    if (typeof answer !== 'string' || !/^[0-9]+$/.test(answer)) return { batch: b, answer };
    this.batchHead = batchId(b);
    this.nextTick = b.firstTick + ticks.length;
    return { batch: b, answer, accepted: Number(answer) };
  }

  /**
   * WHERE THE NODE GOT TO, after a socket dropped.
   *
   * The daemon never asks for a retransmission - publishing is the client's
   * duty - so what a reconnecting client needs is not its batches back but
   * the two numbers that let it carry on: the next tick this node is owed and
   * the chain head to hang it off. Both are in the transcript it already
   * serves, and the marks' head is in the checkpoints beside it.
   *
   * Checked, not taken. The node checks the chain before serving, and that is
   * exactly why the client must check it again: a client that resumed from a
   * head a node made up would build every later batch onto a history nobody
   * has, and would only find out at settlement.
   *
   * There is no signature to check here, and none is invented: an `InputBatch`
   * carries none in this protocol - the chain hash is its integrity - so the
   * checks that apply are that the transcript is for the round and entry this
   * client asked about, that the chain is unbroken, and that the records are
   * whole.
   */
  async resume({ roundId, entryId }) {
    const r = await fetch(
      `${this.base}/transcript?round=${toHex(roundId)}&entry=${toHex(entryId)}`);
    if (!r.ok) throw new Error(`the node refused the transcript: ${(await r.text()).trim()}`);

    let t;
    try { t = decodeTranscript(new Uint8Array(await r.arrayBuffer())); }
    catch (e) { throw new Error(`the transcript will not decode: ${e.message}`); }

    if (toHex(t.roundId) !== toHex(roundId) || toHex(t.entryId) !== toHex(entryId))
      throw new Error(
        `the transcript is for round ${toHex(t.roundId)} entry ${toHex(t.entryId)}, `
        + `and this client asked about ${toHex(roundId)} ${toHex(entryId)}`);

    const ok = checkTranscript(t);
    if (!ok.ok) throw new Error(`the transcript is broken at batch ${ok.at}: ${ok.why}`);

    const last = t.batches[t.batches.length - 1];
    this.batchHead = last ? batchId(last) : GENESIS;
    this.nextTick = last ? batchTicks(last).at(-1) + 1 : 0;

    // AND THE MARKS' HEAD, which is the other chain and is lost the same way.
    // A resume that left it at the start of the round would have every later
    // mark refused for not following the head - the reconnect would look
    // fixed until the first checkpoint after it.
    const marks = await this.recoverReceipts({ roundId, entryId });
    const c = await fetch(
      `${this.base}/checkpoints?round=${toHex(roundId)}&entry=${toHex(entryId)}`);
    const cb = new Uint8Array(await c.arrayBuffer());
    if (cb.length % SIGNED_CHECKPOINT_BYTES !== 0)
      throw new Error(
        `${cb.length} bytes is not a whole number of ${SIGNED_CHECKPOINT_BYTES}-byte marks`);
    if (cb.length) {
      const lastMark = cb.subarray(cb.length - SIGNED_CHECKPOINT_BYTES);
      this.head = checkpointId(decodeCheckpoint(splitSigned(lastMark).body));
    }

    return { ticks: ok.ticks, batches: t.batches.length, nextTick: this.nextTick,
             batchHead: this.batchHead, head: this.head, receipts: marks.length };
  }

  /**
   * Which round this client is playing, and how long it is.
   *
   * `blockTicks` is the round's own length, off the contract, and it is the
   * only bound on the hold that means anything: inputs for more ticks than the
   * round HAS are inputs for a round that is over. The node already refuses a
   * batch longer than it, so the number comes from the contract rather than
   * from taste.
   */
  setRound({ roundId, entryId, blockTicks }) {
    this.where = { roundId, entryId };
    this.maxHold = blockTicks | 0;
    this.chunk = Math.min(600, this.maxHold || 600);
    this.hold = [];
    this.held = 0;
    this.dropped = 0;
    this.batchesSent = 0;
    this.marksSent = 0;
    this.marksSkipped = 0;
    this.publishing = null;
    this.marking = null;
  }

  /**
   * One tick's five words, kept until they can go out.
   *
   * Ticks are the transcript, so they are never thrown away while there is
   * room: unpublished inputs cannot be replayed and cost the player the run.
   * Past the round's own length they are counted rather than kept, because a
   * hold longer than the round is inputs for a round that has ended - and a
   * count is what makes a stall visible instead of silent.
   */
  record(words) {
    if (this.hold.length >= this.maxHold) { this.dropped++; return false; }
    this.hold.push(words);
    this.held = this.hold.length;
    return true;
  }

  /**
   * Publish what is held, ONE batch at a time.
   *
   * The old shape appended a link to a promise chain on every sixth tick
   * whether or not the one before had finished, so a slow node grew a queue
   * nobody watched - and the `bufferedAmount` check sat inside a link, which
   * defers work without bounding anything. One in flight means there is no
   * queue to grow: what is not sent yet is simply still held, where it is
   * counted.
   */
  drain() {
    if (this.publishing || !this.hold.length || !this.where) return this.publishing;
    if (this.sock && this.sock.bufferedAmount > 262144) return null;

    const words = this.hold.slice(0, this.chunk);
    this.hold = this.hold.slice(words.length);
    this.held = this.hold.length;

    this.publishing = this.batch(words, this.where).then((r) => {
      if (r.accepted) this.batchesSent++;
      // A refused batch is not a published one, and dropping it would leave a
      // hole the node will not accept across - the run would end at the gap.
      else { this.hold = words.concat(this.hold); this.held = this.hold.length; }
      this.publishing = null;
      return r;
    }).catch((e) => {
      this.hold = words.concat(this.hold);
      this.held = this.hold.length;
      this.publishing = null;
      throw e;
    });
    return this.publishing;
  }

  /**
   * A mark for a tick, or a count that one was missed.
   *
   * A checkpoint says where the world WAS at a tick. One that could not go out
   * while its moment passed is not that moment any more, so it is skipped
   * rather than queued behind the traffic - which is also what stops a slow
   * link turning into a flood of marks the instant it clears. Ticks are the
   * opposite and are never dropped while there is room: they are the
   * transcript.
   */
  markNow(stateHash, tick, inputChainHash = GENESIS) {
    if (this.marking || !this.where) { this.marksSkipped++; return null; }
    this.marking = this.mark(stateHash, {
      roundId: this.where.roundId, entryId: this.where.entryId, tick, inputChainHash,
    }).then((r) => {
      if (r.answer === 'receipted') this.marksSent++;
      this.marking = null;
      return r;
    }).catch((e) => { this.marking = null; throw e; });
    return this.marking;
  }

  /** Waits for whatever is on the wire, so a test can measure a settled state. */
  async settle() {
    while (this.publishing || this.marking) {
      try { await Promise.all([this.publishing, this.marking]); } catch { /* named elsewhere */ }
    }
  }

  close() { if (this.sock) this.sock.close(); }
}
