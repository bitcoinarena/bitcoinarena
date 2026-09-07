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
  encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS,
} from '../../protocol/src/checkpoint.js';
import { encodeRoundContract, encodeEntryContract } from '../../protocol/src/contracts.js';
import { GENESIS } from '../../protocol/src/transcript.js';
import { fromHex } from '../../protocol/src/hash.js';

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
export function markState(core, st, {
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
  //
  // Checked rather than trusted: a core that answered anything but 64 hex
  // characters would otherwise be silently truncated or padded into a mark
  // that signs cleanly and commits to the wrong state.
  const hex = core.hash(st);
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex))
    throw new Error(`the core did not answer a state hash: ${String(hex).slice(0, 80)}`);
  const stateHash = fromHex(hex);
  const c = { roundId, entryId, tick, stateHash, inputChainHash, previousHash };
  const id = checkpointId(c);
  return { checkpoint: c, id, bytes: joinSigned(encodeCheckpoint(c), sign(id)) };
}

/**
 * A player against one node: the two HTTP doors, the socket, and the mark.
 *
 * `fetch` and `WebSocket` are the platform's, in a browser and in Node alike,
 * so this carries no transport dependency of its own.
 */
export class Client {
  constructor({ base, core, sign }) {
    this.base = base;
    this.core = core;
    this.sign = sign;
    this.sock = null;
    this.head = NO_PREVIOUS;      // the chain head this client has published
    this.said = [];
  }

  /** Opens a round. The node answers with the round's own id. */
  async openRound(contract) {
    const r = await fetch(`${this.base}/round`, {
      method: 'POST', body: encodeRoundContract(contract),
    });
    if (r.status !== 201) throw new Error(`the node refused the round: ${(await r.text()).trim()}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  /** Joins it. The entry contract carries the session key the marks are signed with. */
  async join(entry) {
    const r = await fetch(`${this.base}/entry`, {
      method: 'POST', body: encodeEntryContract(entry),
    });
    if (r.status !== 201) throw new Error(`the node refused the entry: ${(await r.text()).trim()}`);
    return new Uint8Array(await r.arrayBuffer());
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
      sock.addEventListener('error', (e) => reject(new Error(e.message || 'socket error')));
      sock.addEventListener('message', (e) => {
        const waiting = this.said.shift();
        if (waiting) waiting(typeof e.data === 'string' ? e.data : e.data);
      });
      sock.addEventListener('open', () => { this.sock = sock; resolve(this); });
    });
  }

  send(message) {
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
  async checkpoint(st, { roundId, entryId, tick, inputChainHash = GENESIS }) {
    const mark = markState(this.core, st, {
      roundId, entryId, tick, previousHash: this.head, inputChainHash,
    }, this.sign);
    const answer = await this.send(mark.bytes);
    if (answer === 'stored') this.head = mark.id;
    return { ...mark, answer };
  }

  close() { if (this.sock) this.sock.close(); }
}
