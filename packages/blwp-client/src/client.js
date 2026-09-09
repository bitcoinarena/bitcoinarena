// THE PLAYER'S HALF OF THE PROTOCOL.
//
// The node is a store. It takes rounds, entries, batches and checkpoints and
// refuses the ones that break a rule, and it does not recompute any of them
// WHILE THE RUN IS ON: a daemon stepping the core alongside the player would
// be a second simulator, two engines each with its own idea of the present,
// and nothing to say which one is the game.
//
// So the state hash of a LIVE run has to come from HERE, off the same core the
// player is watching. That is the whole reason this file exists.
//
// After the run is over the node does replay it, in `blwp-node/src/replay.js`
// and nowhere else - section 13 makes a result final when five of seven nodes
// agree, and a node that could not replay would be agreeing to whatever it was
// told. That is one simulator run twice over the same inputs, which is the
// only claim determinism ever made; it is not a second engine.
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
  encodeRoundContract, encodeEntryContract, decodeEntryContract, roundId, entryId,
} from '../../protocol/src/contracts.js';
import {
  GENESIS, decodeTranscript, checkTranscript, transcriptBelongsToEntry,
} from '../../protocol/src/transcript.js';
import { encodeInputBatch, batchId, batchTicks } from '../../protocol/src/batch.js';
import { fromHex, toHex } from '../../protocol/src/hash.js';
import {
  decodeCheckpointReceipt, receiptId, splitSignedReceipt, SIGNED_RECEIPT_BYTES,
} from '../../protocol/src/receipt.js';
import { decodeGhost } from '../../protocol/src/ghost.js';
import { TYPE_GHOST } from '../../protocol/src/constants.js';
import { discover } from './directory.js';

/**
 * Five, out of the seven a committee has.
 *
 * Section 13C: the canonical transcript is "the longest checkpoint chain that
 * carries receipts from at least 5 committee nodes". It is a threshold and not
 * a preference - the point of it is that no smaller set of nodes can make a
 * mark count, so an operator cannot spend a short committee as a win.
 */
export const RECEIPTS_FOR_LIVE = 5;

/** 2-of-2 on this build's test nets; 5-of-7 on a seven-seat contract. */
export function receiptsForLive(contract) {
  const slots = contract?.gameVerifySlots ?? contract?.nodes?.length;
  if (slots === 2) return 2;
  return RECEIPTS_FOR_LIVE;
}

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
  /**
   * A client that reaches a node because Bitcoin says where it is, AND because
   * this round's own contract says that node is one of its committee.
   *
   * The one door the game uses, and everything it refuses it refuses HERE -
   * before the round is opened, before an entry is joined, before a single
   * batch of section 11 input is published. That ordering is the whole point.
   * A proven advertisement for a node with no standing in this round used to
   * be caught at the first receipt, which is one round trip too late: by then
   * the entry contract and the opening batches are on a stranger's disk, and
   * section 11 makes publishing the client's duty, not something it can take
   * back.
   *
   * Asynchronous because the last check is a signature and the browser's
   * Ed25519 is asynchronous. `verify` is injected for the same reason it is
   * injected everywhere else here: the curve belongs to whoever runs the
   * client. The constructor below still takes a bare `base`, because tests and
   * the node's own fixtures talk to a process on localhost that has no bond
   * and never will - and a test that wants the real door calls this one.
   */
  static async at(discovery, { core, sign, verify, contract, roundIdGiven }) {
    if (!contract || !contract.nodes)
      throw new Error('no round contract, so there is no committee to check against');

    // WHICH ROUND, AND WHO SAYS SO. This is checked before anything else,
    // because everything else is checked AGAINST it.
    //
    // Section 25.1 step 1 is "a link, QR, copied round_id - carries nothing",
    // and the "carries nothing" is the point: the id is all the player has,
    // and it is enough, because every id in this protocol is the tagged hash
    // OF the object. So the contract the page hands over must hash to the id
    // the player was given, or it is a different round.
    //
    // Without this the committee check below is circular. The page writes the
    // contract, so the page writes `nodes`, so the page chooses the committee
    // its own advertisement then satisfies - with a real bond, a real merkle
    // proof and a real signature, every one of which would pass. Binding the
    // id costs one hash and makes the whole door mean something: change a
    // single node in that list and the contract hashes to something else.
    //
    // Required, not optional. A player who arrived with no id has nothing to
    // check and there is no safe way to guess one.
    if (!(roundIdGiven instanceof Uint8Array) || roundIdGiven.length !== 32)
      throw new Error('no round id from the player, so there is nothing to '
        + 'check the page\'s contract against');
    const named = roundId(contract);
    if (toHex(named) !== toHex(roundIdGiven))
      throw new Error(`the page offered round ${toHex(named)}, which is not `
        + `the round ${toHex(roundIdGiven)} you were given`);

    // THE CHAIN AND THE BOND ARE ASKED FOR, NEVER ACCEPTED. A ready-made chain
    // or a ready-made proof is refused here rather than verified, because
    // verifying a pair somebody else chose proves only that they agree with
    // each other. This is the door; the library below it will still check
    // anything it is handed, and that is exactly why the door must not hand it
    // what the page said.
    for (const handed of ['chain', 'chains', 'transaction', 'branch', 'position']) {
      if (discovery[handed] !== undefined)
        throw new Error(`the ${handed} must come from a provider, not from whoever `
          + 'opened the page: two things that agree with each other are not Bitcoin');
    }

    const seen = await discover({ ...discovery, committee: contract.nodes });
    if (!seen.ok) throw new Error(`no proven endpoint: ${seen.why}`);

    // 5A.1 ends the body with "signature - by node_pubkey over all of the
    // above". The tagged id is what is signed, as everywhere else in this
    // protocol, so a signature here can never be replayed as a signature over
    // some other object that happens to encode to the same bytes. Weaker than
    // the bond output's commitment - which already binds this body to money on
    // chain - but it is what says the key the advertisement NAMES is the key
    // that wrote it, and it is listed.
    if (!await verify(seen.signature, seen.advertId, seen.nodePubkey))
      throw new Error(`the advertisement for ${toHex(seen.nodePubkey)} `
        + 'is not signed by the node it names');

    return new Client({
      base: seen.endpoint.replace(/^ws/, 'http'), core, sign, verify,
    });
  }

  constructor({ base, core, sign, verify }) {
    this.base = base;
    this.core = core;
    this.sign = sign;
    // Verifying is injected for the same reason signing is: the curve belongs
    // to whoever runs the client, and this file should not decide it.
    this.verify = verify;
    this.sock = null;
    this.head = NO_PREVIOUS;      // the mark chain head this client has published
    // WHO HAS WITNESSED WHAT. Mark id -> the distinct committee keys that have
    // receipted it. A Set because five receipts from one node is one node
    // saying the same thing five times, and 13C counts NODES.
    this.witnesses = new Map();
    this.batchHead = GENESIS;     // and the input chain's, which is a separate chain
    // WHETHER THIS CLIENT'S OWN INPUTS ARE LANDING. A run whose batches are
    // refused looks exactly like a healthy one from outside - the socket is
    // up and the player is driving - so the fact is counted and the node's
    // own sentence is kept for whoever draws the page.
    this.refusals = 0;
    this.refusedWhy = null;
    this.refusedAt = null;
    this.resynced = false;
    this.recovering = null;
    this.nextTick = 0;            // the tick the node is owed next
    this.nodes = [];              // the committee, off the round's own contract
    this.gameVerifySlots = 7;
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

    // WHAT ARRIVES UNASKED. A GHOSTS frame is not an answer to anything: the
    // node pushes it when somebody else's truck moves, so it cannot go into
    // the queue that pairs replies with requests. Measured before this
    // existed: every message went to `said.shift()`, so a picture arriving
    // while a batch was in flight WAS the answer to that batch - the client
    // read "the node stored N ticks" off 147 bytes of somebody's truck, and
    // the real answer then went to the next request, and so on for the rest
    // of the run. One socket, two kinds, and the type byte says which - the
    // same rule the node applies to what comes the other way.
    this.ghosts = 0;
    this.onGhost = null;
    // WHAT THIS CLIENT ASKED TO BE SHOWN, remembered so a reconnect can ask
    // again. The node keys subscribers BY CONNECTION and a reconnect is a new
    // one, so without this a player who dropped for two seconds came back
    // publishing and blind for the rest of the run - no error and no counter,
    // the pictures just stopped.
    this.watchingWhat = null;
    this.rewatched = 0;

    // THE RECONNECT, which used to live in the jslib where nothing could
    // measure it. `reconnecting` is the one in flight; `drops`, `tries` and
    // `backoff` are what a status line reads. `sleep` and `now` are injected
    // for the same reason `sign` is: a test that had to wait eight real
    // seconds to see the cap would not be run.
    // THE SESSION'S ONE WORD, and it lives here rather than in the page.
    //
    // `opening` until a socket is up, `ready` while one is, `dropped` while
    // the loop is trying, `ended` once the run is over and never anything
    // again. It was the page's before: the page learned `ended` only when
    // `reconnect` answered null, which is the socket-DOWN path - so a VOID
    // that happened with the socket still up (a slow node filling the hold)
    // left the page printing `ready` beside the run's own ENDED VOID. Two
    // words about one session, and the first is the one a reader trusts.
    // Here there is one word, and `node --test` can load the file it is in.
    this.state = 'opening';
    this.reconnecting = null;
    this.drops = 0;
    this.tries = 0;
    this.backoff = 0;
    this.resumedAt = null;
    this.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    this.gameVerifySlots = contract.gameVerifySlots || this.nodes.length;
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
        if (typeof e.data !== 'string') {
          const bytes = new Uint8Array(e.data);
          // A PICTURE IS NOT A REPLY. Everything else binary that comes back -
          // a receipt for a mark - is, so the test is the type byte and not
          // "is it binary": a client that routed all bytes to a handler would
          // lose its receipts instead of its answers.
          if (bytes[0] === TYPE_GHOST) return this.takeGhost(bytes);
          const waitingForBytes = this.said.shift();
          if (waitingForBytes) waitingForBytes(bytes);
          return undefined;
        }
        const waiting = this.said.shift();
        if (waiting) waiting(e.data);
        return undefined;
      });
      sock.addEventListener('open', () => {
        this.sock = sock;
        if (!this.ended) this.state = 'ready';
        resolve(this);
      });

      // A DROPPED SOCKET IS NOT AN ERROR, it is the normal thing that happens
      // to a socket. Everything still waiting for an answer is told so by
      // name, or it would wait for one that can no longer arrive - a publish
      // that never settles stops the queue behind it for the rest of the run.
      sock.addEventListener('close', () => {
        if (this.ended) return;                         // the run is over, not dropped
        if (this.sock !== sock) return;                 // already replaced
        this.sock = null;
        const waiting = this.said;
        this.said = [];
        for (const w of waiting) w('error the socket closed');
        this.drops++;
        this.state = 'dropped';
        if (this.onDrop) this.onDrop();
      });
    });
  }

  /**
   * THE SOCKET CAME BACK, OR IT DID NOT YET.
   *
   * This loop was in `blwp.jslib`, which is the one file the JS suites cannot
   * reach - so the rule that decides whether a dropped player keeps their run
   * had no test at all, while the hold and the drain beside it had a file of
   * their own. It is here now and the page calls it, so there is one set of
   * rules instead of two that look alike.
   *
   * ONE IN FLIGHT, whatever the drop rate. A second caller gets the promise
   * the first is already waiting on: two loops would open two sockets, and the
   * `close` handler on the losing one would fire a third.
   *
   * IT KEEPS TRYING, with a backoff, and that is deliberate. One attempt was
   * the whole of it once, and a node still restarting at that moment left the
   * session finished - every tick and every mark after it unpublished, which
   * §11 is blunt about the cost of. A two-second restart must not end a run.
   *
   * AND IT STOPS WHEN THE RUN HAS ENDED. `endRun` has already said VOID on
   * the publish path; a loop that went on reconnecting would hand the page a
   * live socket for a run with no honest transcript, and the page would show
   * `ready`. Nothing here decides an outcome - it only declines to re-open a
   * door on a run that is over.
   */
  reconnect(where = this.where) {
    if (this.ended) return null;
    if (this.reconnecting) return this.reconnecting;
    if (!where) throw new Error('no round to reconnect to: setRound was never called');

    this.tries = 0;
    this.backoff = 0;
    this.reconnecting = (async () => {
      // Checked EVERY time round, not once on the way in: a run can end while
      // this is asleep - the game keeps handing over ticks, and the tick that
      // will not fit the hold ends it.
      while (!this.ended) {
        this.tries++;
        try {
          await this.connect();
          const r = await this.resume(where);
          // AND ASK TO BE SHOWN THE OTHERS AGAIN. Third of the three things a
          // reconnect owes a run: a socket, the tick to carry on from, and the
          // subscription the old connection took with it.
          if (this.watchingWhat) {
            const said = await this.send(
              `watch ${toHex(this.watchingWhat.round)} ${toHex(this.watchingWhat.entry)}`);
            if (/^watching /.test(said)) this.rewatched++;
            else this.error = `the subscription did not come back: ${said}`;
          }
          this.resumedAt = r.nextTick;
          this.backoff = 0;
          this.state = 'ready';
          return r;
        } catch (e) {
          this.error = String(e.message || e);
          this.state = this.ended ? 'ended' : 'dropped';
          if (this.sock) { const sk = this.sock; this.sock = null; try { sk.close(); } catch { /* gone */ } }
          this.backoff = this.backoff ? Math.min(this.backoff * 2, 8000) : 1000;
          await this.sleep(this.backoff);
        }
      }
      return null;
    })().finally(() => { this.reconnecting = null; });

    return this.reconnecting;
  }

  /**
   * ONE PICTURE IN. Decoded here so a page never sees bytes, counted so a
   * status line can say the world is populated, and handed on if anybody is
   * listening. A frame nobody listens for is dropped rather than queued: it is
   * a 5 Hz picture of a truck that has already moved, and a backlog of them is
   * worse than none.
   *
   * NOTHING HERE IS AN INPUT. 0.10: another player's truck is a picture, never
   * an input to my simulation. This client hands it to a renderer and to
   * nothing else.
   */
  takeGhost(bytes) {
    let ghost;
    try { ghost = decodeGhost(bytes); }
    catch { this.badGhosts = (this.badGhosts || 0) + 1; return; }
    this.ghosts++;
    if (this.onGhost) this.onGhost(ghost);
  }

  /**
   * SUBSCRIBE: tell the node which round and entry this is, and be shown the
   * others. The answer is `watching N` and the N frames follow it, which is
   * why they cannot share the answer queue.
   */
  watch(round, entry) {
    this.watchingWhat = { round, entry };
    return this.send(`watch ${toHex(round)} ${toHex(entry)}`);
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

    // THE HEAD MOVES ON LIVE, NOT ON THE FIRST RECEIPT.
    //
    // It used to move here, on one verified receipt out of seven - which was
    // true as far as it went and thinner than it sounded. Section 13C counts
    // FIVE committee nodes before a checkpoint chain is canonical, so between
    // one and four a mark is PENDING: witnessed by somebody, carried by
    // nobody. Chaining the next mark onto a parent that four nodes have never
    // agreed to would build a run on a link that cannot be canonical, and the
    // operator of a short committee could then be paid for it.
    //
    // Pending is not failed. Nothing here voids a run or loses it for the
    // player: what happens to a run whose marks never reach five is the
    // no-quorum rule, it decides FORFEIT against VOID, and it is settlement
    // rather than a client.
    this.witness(r);
    if (this.live(markId)) this.head = markId;
    return r;
  }

  /** Records one verified receipt against its mark, and answers the count. */
  witness(r) {
    const id = toHex(r.checkpointId);
    const seen = this.witnesses.get(id) || new Set();
    seen.add(toHex(r.nodePubkey));
    this.witnesses.set(id, seen);
    return seen.size;
  }

  /** How many DISTINCT committee members have receipted this mark. */
  witnessed(markId) {
    const seen = this.witnesses.get(toHex(markId));
    return seen ? seen.size : 0;
  }

  /** Is this mark carried by enough of the committee to be worth anything? */
  live(markId) {
    return this.witnessed(markId) >= receiptsForLive({
      gameVerifySlots: this.gameVerifySlots,
      nodes: this.nodes,
    });
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
      this.witness(rec);
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
  /**
   * This entry's own contract, fetched and then checked against its id.
   *
   * The id IS the hash of the bytes, so this needs no trust: a node that hands
   * back another entry, or the same one with a friendlier `joinTick`, does not
   * hash to what was asked for. 25.1's rule about chain providers is the same
   * rule - a provider may omit, and it may not forge.
   */
  async entryFor(id) {
    const r = await fetch(`${this.base}/entry?id=${toHex(id)}`);
    if (!r.ok) throw new Error(`the node has no entry ${toHex(id)}: ${(await r.text()).trim()}`);

    let entry;
    try { entry = decodeEntryContract(new Uint8Array(await r.arrayBuffer())); }
    catch (e) { throw new Error(`that entry will not decode: ${e.message}`); }

    if (toHex(entryId(entry)) !== toHex(id))
      throw new Error(
        `the node returned entry ${toHex(entryId(entry))} for ${toHex(id)}, `
        + 'so that is not the contract this player signed');
    return entry;
  }

  async resume({ roundId, entryId }) {
    // A RUN THAT ENDED STAYS ENDED, and a socket coming back does not undo it.
    //
    // `endRun` said VOID on the publish path: the hold filled, a tick was
    // dropped, and no transcript from there can be replayed. This used to
    // answer such a client with a tick number and a chain head anyway, and the
    // page read that as a healthy session - status `ready`, the player still
    // driving, every later tick silently discarded and nobody told. That is a
    // disconnect working as an escape hatch, and in the operator's favour: a
    // link the operator owns ends the run and the client shows no sign of it.
    //
    // Refused by name and with NO NUMBERS. This decides nothing - the outcome
    // was decided where the fault happened - it only declines to re-animate it.
    if (this.ended)
      throw new Error(
        `this run ended ${this.ending}: ${this.endingReason} - a socket coming `
        + 'back does not resume it');

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
    if (!ok.ok) throw new Error(`the transcript is broken at ${ok.in} ${ok.at}: ${ok.why}`);

    // AND IT BEGINS WHERE THIS PLAYER JOINED, which for a late entrant is not
    // tick zero.
    //
    // 0.8: "late join is a normal feature, not merely reconnect", and section
    // 7: "late joins simply add more Entry Contracts". So the tick a run
    // starts at is in the entry the player signed, and this line used to fall
    // back to 0 when the node returned an empty transcript - a player who
    // joined at 50 and reconnected before publishing anything would have
    // resumed numbering from 0, and every batch after that would be the inputs
    // of one tick carrying the number of another.
    //
    // THE ENTRY IS FETCHED AND THEN HASHED, not taken on the node's word: its
    // id is the hash of its bytes, so a node that returned somebody else's
    // entry - or an edited one with a friendlier join tick - fails the
    // comparison. Nothing here trusts the answer; it checks it.
    const entry = await this.entryFor(entryId);
    const belongs = transcriptBelongsToEntry(t, entry);
    if (!belongs.ok && t.batches.length)
      throw new Error(`the transcript is not this entry's run: ${belongs.why}`);

    const last = t.batches[t.batches.length - 1];
    this.batchHead = last ? batchId(last) : GENESIS;
    this.nextTick = last ? batchTicks(last).at(-1) + 1 : entry.joinTick;

    // AND THE COUNT OF WHAT THIS CLIENT HAS ACCEPTED IS RECONCILED WITH IT.
    //
    // `offered` exists so that `nextTick + held` can be checked against it
    // before a batch goes out. A resume moves `nextTick` to whatever the node
    // is owed, so the count has to move with it or the very next drain would
    // read as a client that had lost a tick and would end the run for it.
    this.offered = this.nextTick + this.hold.length;

    // AND THE MARKS' HEAD, which is the other chain and was lost the same way -
    // but it is NOT taken from the node's last mark.
    //
    // That is what this used to do, and it was the 5-of-7 rule standing in one
    // function and missing in the next: after a drop the client adopted
    // whatever the node held, on that node's word alone. A run that lost its
    // socket was then chaining onto a mark four committee members had never
    // seen, and the operator of a short committee was paid for it.
    //
    // So the marks are walked NEWEST FIRST and the first one that five
    // distinct committee keys have receipted becomes the head. The receipts
    // are the ones just recovered, each verified here; a duplicate signer
    // cannot inflate the count and a receipt that fails its mark, the
    // committee or its signature never reached the count at all.
    const marks = await this.recoverReceipts({ roundId, entryId });
    const c = await fetch(
      `${this.base}/checkpoints?round=${toHex(roundId)}&entry=${toHex(entryId)}`);
    const cb = new Uint8Array(await c.arrayBuffer());
    if (cb.length % SIGNED_CHECKPOINT_BYTES !== 0)
      throw new Error(
        `${cb.length} bytes is not a whole number of ${SIGNED_CHECKPOINT_BYTES}-byte marks`);

    // AND IF NONE OF THEM IS LIVE, THE HEAD STAYS WHERE THIS CLIENT CAN PROVE
    // IT BELONGS. Not the node's last mark, and not a refusal either: a
    // disconnect is not an escape hatch, and a slow committee must still be
    // able to carry the run. What comes after that head is published again,
    // which is what lets the committee catch up.
    let adopted = null;
    for (let at = cb.length - SIGNED_CHECKPOINT_BYTES; at >= 0; at -= SIGNED_CHECKPOINT_BYTES) {
      const id = checkpointId(decodeCheckpoint(splitSigned(cb.subarray(at, at + SIGNED_CHECKPOINT_BYTES)).body));
      if (this.live(id)) { adopted = id; break; }
    }
    if (adopted) this.head = adopted;

    return { ticks: ok.ticks, batches: t.batches.length, nextTick: this.nextTick,
             batchHead: this.batchHead, head: this.head, receipts: marks.length,
             live: adopted !== null, witnessed: adopted ? this.witnessed(adopted) : 0 };
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
    this.offered = 0;
    this.ended = false;
    this.ending = null;
    this.endingReason = '';
  }

  /**
   * THE RUN HAS NO HONEST TRANSCRIPT, so it ends here.
   *
   * Not a defeat and not a delivery: this is a publish-path failure, and the
   * spec's word for a fault that is not the player's is VOID. A slow node that
   * filled the hold must not become a house win, and a player must not be able
   * to use a drop as a way out of a run that was going badly - the round simply
   * has no transcript anybody can replay, and that is what is said.
   *
   * Everything outbound stops. A client that cannot be honest about which tick
   * carried which input should say so rather than keep publishing a stream
   * that reads as a valid round and is not one.
   */
  endRun(reason) {
    if (this.ended) return;
    this.ended = true;
    this.ending = 'VOID';
    this.endingReason = reason;

    // SAID BEFORE THE SOCKET IS CLOSED, and that ordering is the whole point.
    // The `close` listener returns at its first line once `ended` is set - the
    // run is over, not dropped - so nothing downstream would ever hear about a
    // VOID that happened while the socket was still up. The word is set and
    // the hook fires here, on the path the fault actually took.
    this.state = 'ended';
    if (this.onEnd) this.onEnd(this.ending, this.endingReason);

    if (this.sock) { const s = this.sock; this.sock = null; try { s.close(); } catch { /* gone */ } }
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
    if (this.ended) return false;

    // A CLIENT THAT HAS NOT BEEN TOLD WHICH ROUND IT IS PLAYING IS NOT
    // HOLDING A TRANSCRIPT, and must not end a run it never began.
    //
    // Found in a browser and only findable there. `Client.at` resolves before
    // `setRound` does - opening a round, joining it and connecting are three
    // more round trips - and the game is already ticking at 60 Hz through all
    // of them. So `record` ran against a client whose `maxHold` was still the
    // constructor's 0 and whose `offered` was undefined: the first tick of
    // every session read as a dropped one and VOIDed the run before a byte
    // had been published. `a tick was dropped at NaN: the hold was full at 0`.
    //
    // It was there before any of this door was, and it was invisible: nothing
    // was told, so the page carried on looking healthy while the client had
    // quietly given up. It shows now because a VOID stops the truck, which is
    // what makes this the bug a green suite could not have shown.
    //
    // Refused rather than held: the round these ticks would belong to does not
    // exist yet, and the entry's `joinTick` is what says where a player's
    // transcript begins.
    if (!this.where) return false;

    this.offered++;
    if (this.hold.length >= this.maxHold) {
      // THE FIRST DROPPED TICK ENDS THE RUN. It used to be counted and the
      // publishing carried on, and that was the fault: `batch` numbers a batch
      // by a COUNT of published ticks, so from the first drop onward the chain
      // says 600, 601, 602 while those words are the inputs from tick 1800 -
      // a stream that looks continuous while skipping inputs, which a verifier
      // would replay into a different world than the player was in.
      this.dropped++;
      this.endRun(`a tick was dropped at ${this.offered}: the hold was full at `
        + `${this.maxHold}, so no transcript from here can be replayed`);
      return false;
    }
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
    if (this.ended || this.publishing || !this.hold.length || !this.where) return this.publishing;
    // NOTHING GOES OUT WHILE THE TWO NUMBERS ARE BEING RE-READ. A batch built
    // from the old `nextTick` while `resume` is replacing it is the refusal
    // again, one tick later.
    if (this.recovering) return this.recovering;

    // AND NOTHING GOES OUT WHILE THERE IS NO SOCKET. Without this the words
    // were sliced out of the hold, handed to a `send` that answered `error
    // there is no socket`, and concatenated back - 550 of those in a 3000-tick
    // outage, and `held` read up to `chunk` short the whole time because the
    // rows were in a doomed promise rather than in the hold. A status line
    // that under-reports a hold is the one number a stalled player has.
    if (!this.sock || this.sock.readyState !== 1) return null;

    // AND THE NUMBERS MUST AGREE BEFORE ANYTHING LEAVES.
    //
    // A batch goes out as `firstTick: nextTick`, so every tick this client has
    // ever accepted is either published or still held: `nextTick + held` has to
    // equal what was offered. If it does not, a tick went missing somewhere
    // and the next batch would put the wrong words at the wrong tick. The
    // first drop already ends the run; this is the second line, and it catches
    // any other way the two could part.
    if (this.nextTick + this.hold.length !== this.offered) {
      this.endRun(`${this.offered} ticks offered but ${this.nextTick} published and `
        + `${this.hold.length} held: a batch here would name ticks it does not carry`);
      return null;
    }
    if (this.sock && this.sock.bufferedAmount > 262144) return null;

    const words = this.hold.slice(0, this.chunk);
    this.hold = this.hold.slice(words.length);
    this.held = this.hold.length;

    this.publishing = this.batch(words, this.where).then((r) => {
      if (r.accepted) {
        this.batchesSent++;
        // PUBLISHING AGAIN IS NEWS TOO. A run that recovered must stop
        // reporting a refusal, or the page shows a fault that has been over
        // for minutes.
        this.refusedWhy = null;
        this.resynced = false;
      } else {
        // A refused batch is not a published one, and dropping it would leave
        // a hole the node will not accept across - the run would end at the
        // gap.
        this.hold = words.concat(this.hold); this.held = this.hold.length;
        this.refusals++;
        this.refusedWhy = typeof r.answer === 'string' ? r.answer : 'the node did not say';
        this.refusedAt = this.nextTick;
        this.#afterRefusal(r);
      }
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
   * A BATCH THE NODE WOULD NOT TAKE IS RESYNCED ONCE, AND THEN IT ENDS THE RUN.
   *
   * Measured before this existed: a refusal put the words back at the head of
   * the hold and changed nothing else, so the very next `drain` sent the SAME
   * batch, and a node refusing for a reason that does not go away - "expected
   * tick 4242, got 4300", "the batch does not follow the chain head" - was
   * asked the same question for the rest of the round. The socket stayed up,
   * the player kept driving, `nextTick` never moved again, and every watcher's
   * picture of that truck froze at the last tick that landed. That is the 16:08
   * two-Chrome report: P1 in the field, P2's ghost still at P1's bay, tick
   * stuck at 4241, chip saying play and two players the whole time.
   *
   * So a refusal is treated as what it is - a disagreement about where this
   * run is - and the two numbers that could be wrong are re-read from the node
   * ONCE. `resume` is the same door a reconnect uses and it checks what it is
   * given rather than adopting it. If the next batch is refused after that,
   * the disagreement is not about the numbers and the run ends with the node's
   * own words: a player whose inputs nobody stores is not driving a round, and
   * saying so is the difference between a lost run and a lost run nobody knew
   * about.
   */
  #afterRefusal(r) {
    if (this.ended || !this.where) return;
    if (this.resynced) {
      this.endRun(`the node refuses this run's inputs at tick ${this.nextTick}: `
        + `${this.refusedWhy} - and it still refused after resyncing, so this `
        + 'client cannot publish and nothing from here can be replayed');
      return;
    }
    this.resynced = true;
    this.recovering = this.resume({ roundId: this.where.roundId, entryId: this.where.entryId })
      .then(() => { this.recovering = null; })
      .catch((e) => {
        this.recovering = null;
        this.endRun(`the node refuses this run's inputs at tick ${this.nextTick}: `
          + `${this.refusedWhy} - and it would not say where the run is: ${e.message}`);
      });
    void r;
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
    // A mark after the run has ended would commit to a world whose inputs
    // nobody can produce - it names a tick the transcript cannot reach.
    if (this.ended) return null;
    // A mark needs a socket for the same reason a batch does, and one that
    // cannot go out while its moment passes is skipped - which is what the
    // count is for. Counted rather than silently dropped, so an outage is
    // visible in the same number a slow link is.
    if (this.marking || !this.where || !this.sock || this.sock.readyState !== 1) {
      this.marksSkipped++;
      return null;
    }
    this.marking = this.mark(stateHash, {
      roundId: this.where.roundId, entryId: this.where.entryId, tick, inputChainHash,
    }).then((r) => {
      if (r.answer === 'receipted') this.marksSent++;
      this.marking = null;
      return r;
    }).catch((e) => { this.marking = null; throw e; });
    return this.marking;
  }

  /**
   * THE ONE LINE A DEBUG PANEL READS, built here rather than in the page.
   *
   * It was assembled in `blwp.jslib`, which is the file `node --test` cannot
   * load - and that is exactly how it came to print the page's `ready` beside
   * this run's own `ENDED VOID`, and survive an audit saying so. A line built
   * where it can be loaded is a line a test can read the first word of.
   *
   * `seen` is the game's tick counter and comes from the caller: the client
   * counts what it published, not what the renderer drew.
   */
  status(seen = 0) {
    return `${this.state} batches ${this.batchesSent} marks ${this.marksSent}`
      + ` tick ${seen} held ${this.held}`
      + (this.dropped ? ` dropped ${this.dropped}` : '')
      + (this.marksSkipped ? ` skipped ${this.marksSkipped}` : '')
      + (this.drops ? ` drops ${this.drops} tries ${this.tries} resumed ${this.resumedAt}` : '')
      + (this.ended ? ` ${this.ending} ${this.endingReason}` : '');
  }

  /** Waits for whatever is on the wire, so a test can measure a settled state. */
  async settle() {
    while (this.publishing || this.marking) {
      try { await Promise.all([this.publishing, this.marking]); } catch { /* named elsewhere */ }
    }
  }

  close() { if (this.sock) this.sock.close(); }
}
