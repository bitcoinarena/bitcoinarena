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
// THE RULE A PLAYER CHECKS AN INVOICE WITH, IMPORTED AND NOT REWRITTEN.
//
// `server.js` says at its own /invoice door that this rule "lives on their
// side too", and until M3.2 item 5 it did not: zero callers here. A second
// formula in the client would be a second opinion about what the player owes,
// which is the one number they are about to part with money over.
import { invoiceMatchesEntry } from '../../protocol/src/payout.js';
import { parseConnection, payInvoice } from './nwc.js';
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

/**
 * HOW LONG A CHECKPOINT WAITS FOR EVERY NODE TO HOLD ITS INPUTS, in ms.
 *
 * Longer than the reconnect backoff's 8 s ceiling, so a node that restarts
 * comes back inside it; short enough that a node which never comes back costs
 * a handful of the one-a-second marks, not the run's.
 */
export const MARK_INPUT_WAIT_MS = 10000;

/**
 * THE WORD FOR NO CONNECTION, distinct from every word a node says.
 *
 * A node's own refusal arrives as `error ...`. A peer that could not be reached
 * - down, restarting, unroutable - never said anything, and counting it with
 * the refusals put "inputs refused 20" on the line for a daemon that was off.
 * A refusal and a disconnect decide different things (a node that says no is
 * a node that holds something else; one that is gone holds nothing yet), so
 * they are kept apart from the first place they could be confused.
 */
const CLOSED = 'closed: ';

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

    const client = new Client({
      base: seen.endpoint.replace(/^ws/, 'http'), core, sign, verify,
    });
    // AND EVERY OTHER COMMITTEE NODE, for the checkpoints. Section 10: "a
    // checkpoint is accepted when enough nodes receive it"; section 11: "the
    // client periodically sends batches and checkpoints". The proven endpoint is
    // one node, and the rest arrive as `discovery.nodes` - handed in by the
    // page's own wrapper of this call, from the same list the bridge already
    // asks for the round's randomness; nothing in here reads the page. They
    // need no proof of their own because they are DELIVERY addresses, not
    // trust: an entry and a checkpoint are public, and a receipt only counts
    // once it verifies under a key the round's own contract names. A page that
    // lies here can make a checkpoint fail to go live, never make one live.
    client.deliverTo(discovery.nodes || []);
    return client;
  }

  /**
   * WHERE ELSE A CHECKPOINT GOES: every committee node's base, less this one.
   *
   * Measured 2026-09-10 on the Daily's 2-of-2: every checkpoint reached daemon A
   * alone, B held not even the entry, `receiptsForLive` is 2 there - so the
   * first checkpoint never went live, the head never moved, and every later one
   * was refused as "not following the chain head". 1 stored on A, 0 on B.
   */
  deliverTo(bases) {
    const norm = (u) => String(u).replace(/^ws/, 'http').replace(/\/+$/, '');
    const mine = norm(this.base);
    this.peers = [...new Set((bases || []).map(norm))].filter((b) => b && b !== mine);
    return this.peers;
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
    // What the node said about this seat's hold when it took the entry. NOT
    // `hold`, which is the tick buffer below.
    this.seatHold = null;
    this.loads = [];              // [tick, feeSats, btcHundredths], not yet published
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
    // WHAT BECAME OF EACH CHECKPOINT ON THE COMMITTEE. `marksSent` counts a
    // receipt from this client's own node, as it always has; `marksAccepted`
    // counts checkpoints that went LIVE (enough committee nodes receipted
    // them, so the head moved on); `marksRefused` counts checkpoints any node
    // refused, and the node's own words are kept. A refusal was counted as
    // nothing at all, which is how "sent 1, skipped 0" hid three refused.
    this.marksAccepted = 0;
    this.marksRefused = 0;
    this.marksRefusedWhy = null;
    this.peers = [];              // the other committee nodes' bases
    this.peerLinks = new Map();   // base -> { sock, said, opening }
    this.peerSeats = [];
    // THE RUN'S INPUTS, FOR THE OTHER COMMITTEE NODES. Measured 2026-09-10 on
    // the Daily: with checkpoints reaching both daemons, B held 0 ticks of
    // either run (A: 588 and 630) - B was receipting runs it could not replay.
    // Every batch this client's node took is kept here, and each peer is fed
    // them in order from where it last answered.
    this.published = [];          // { bytes, through } per accepted batch
    this.peerFeeds = new Map();   // base -> { next, ticks, refused, why, running }
    this.batchesInterrupted = 0;  // own socket closed with a batch in flight (not a refusal)
    this.batchesLandedUnheard = 0; // batches the node took whose answer was lost
    this.peerBatchesRefused = 0;  // a peer node SAID NO to a batch
    this.peerInputsClosed = 0;    // a batch could not reach a peer at all
    this.peerDowns = 0;           // times a peer went from answering to unreachable
    this.marksUnreached = 0;      // marks some peer never received (not refusals)
    this.marksUnreachedWhy = null;
    this.inputWaiters = [];       // marks waiting for every node to hold their inputs
    this.marksWaited = 0;
    this.markWaitMs = MARK_INPUT_WAIT_MS;
    this.markWaiting = null;      // the tick of the mark now waiting for its inputs
    this.marksTimedOut = 0;       // marks never sent: a node did not hold their inputs in time
    this.marksTimedOutWhy = null;
    this.pendingLink = null;      // { id, bytes, tick }: stored by some node, not carried by the committee
    this.marksRelinked = 0;       // pending links re-sent until the committee carried them
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

    // WHO THIS CLIENT SEATED, kept for the ghost field. A reload keeps the
    // player's key (sessionStorage) and draws a NEW entry, so the seat this tab
    // held before the reload is still in the round, frozen - and it is this
    // player. A field that knew only its entry id kept it as somebody else:
    // measured 2026-09-10, each tab held its own pre-reload seat as an "other",
    // and the chip named it because its frozen run had gone furthest.
    this.playerPubkey = entry.playerPubkey;

    // AND WHETHER THERE IS A HOLD ON THIS SEAT, WHICH THE NODE ALREADY SAID.
    //
    // 23.1 issues the hold invoice AT THE SEAT - `POST /entry` calls
    // `custody.hold` and answers `x-hold` with the state, or `x-hold-why` with
    // the reason there is none. Both headers were read by nothing, so a page
    // that wanted to tell a player whether their stake was funded had to
    // ASSUME, and letter 15's first wiring assumed: it printed "the stake is
    // not paid" as a constant while the node was answering the question.
    //
    // Kept rather than returned, because every caller of `join` wants the
    // entry id and none of them expected a second value.
    //
    // `seatHold` AND NOT `hold`, which is already the ticks waiting to go out.
    // Written as `this.hold` first and every suite stayed green by luck of
    // ordering: the jslib calls `setRound` after `join`, and `setRound` puts
    // the array back. A page that joined and published without one in between
    // would have called `.push` on an object and lost the run.
    this.seatHold = {
      state: r.headers.get('x-hold') || 'none',
      why: r.headers.get('x-hold-why') || null,
    };
    const seated = agrees(mine, new Uint8Array(await r.arrayBuffer()), 'entry');

    // AND ON EVERY OTHER COMMITTEE NODE, or it refuses this seat's checkpoints
    // as "no such entry" - measured: daemon B answered 404 for every Daily seat.
    // A node that will not seat it is written down, not thrown: this node took
    // the entry, and the run can still be played.
    this.seatEntry = entry;
    this.peerSeats = await Promise.all(this.peers.map((base) => this.seatOn(base)));
    return seated;
  }

  /** A socket to another committee node, for checkpoints only. */
  peerLink(base) {
    const had = this.peerLinks.get(base);
    if (had && had.sock && had.sock.readyState === 1) return Promise.resolve(had);
    if (had && had.opening) return had.opening;
    const link = { sock: null, said: [], opening: null };
    link.opening = new Promise((resolve) => {
      const sock = new WebSocket(`${base.replace(/^http/, 'ws')}/play`);
      sock.binaryType = 'arraybuffer';
      sock.addEventListener('message', (e) => {
        const waiting = link.said.shift();
        if (waiting) waiting(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
      });
      sock.addEventListener('open', () => { link.sock = sock; link.opening = null; resolve(link); });
      sock.addEventListener('error', () => { link.opening = null; resolve(link); });
      sock.addEventListener('close', () => {
        const waiting = link.said; link.said = [];
        for (const w of waiting) w(`${CLOSED}the socket to ${base} closed`);
        if (link.sock === sock) link.sock = null;
      });
    });
    this.peerLinks.set(base, link);
    return link.opening;
  }

  /** One message to another committee node, answered the way `send` answers. */
  async sendPeer(base, message) {
    const link = await this.peerLink(base);
    if (!link.sock || link.sock.readyState !== 1) return `${CLOSED}no socket to ${base}`;
    return new Promise((r) => { link.said.push(r); link.sock.send(message); });
  }

  /** Seats this client's entry on one other committee node. */
  async seatOn(base) {
    try {
      const p = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(this.seatEntry) });
      return { base, ok: p.status === 201, why: p.status === 201 ? null : (await p.text()).trim() };
    } catch (e) { return { base, ok: false, why: e.message }; }
  }

  /**
   * THE SAME INPUTS TO EVERY OTHER COMMITTEE NODE. Section 11: "the client
   * periodically sends batches and checkpoints" - both, to the committee.
   *
   * Each peer is fed the batches this client's node took, IN ORDER, from the
   * first one it has not answered: the node refuses a batch that does not
   * follow its own chain head, so a peer that missed one is caught up rather
   * than skipped past. A repeat is answered "0" and is not an error, so a
   * retry costs nothing. A refusal stops that peer's feed until the next batch
   * or checkpoint tries again, and is counted with the node's own words. The
   * node's answer to a batch is a count of new ticks and is not signed - there
   * is no batch receipt in the protocol to verify - so what is checked is that
   * the answer IS a count, from that node, for that batch.
   */
  pumpPeers() {
    for (const base of this.peers) this.#feed(base);
  }

  peerFeed(base) {
    let f = this.peerFeeds.get(base);
    if (!f) {
      f = { base, next: 0, ticks: 0, refused: 0, closed: 0, down: false, downs: 0,
        why: null, running: null, again: false };
      this.peerFeeds.set(base, f);
    }
    return f;
  }

  #feed(base) {
    const f = this.peerFeed(base);
    if (f.running) { f.again = true; return f.running; }
    f.running = (async () => {
      do {
        f.again = false;
        while (f.next < this.published.length) {
          const one = this.published[f.next];
          const a = await this.sendPeer(base, one.bytes);
          // NO CONNECTION IS NOT A NO: counted as closed, and as one drop per
          // time the peer went away, never as a refusal. The feed stops and
          // the next batch or mark tries again, exactly as it did.
          if (typeof a === 'string' && a.startsWith(CLOSED)) {
            f.closed++;
            this.peerInputsClosed++;
            if (!f.down) { f.down = true; f.downs++; this.peerDowns++; }
            f.why = a;
            return;
          }
          if (typeof a !== 'string' || !/^[0-9]+$/.test(a)) {
            f.refused++;
            this.peerBatchesRefused++;
            f.why = typeof a === 'string' ? a : `${a.length} bytes where a tick count was due`;
            // A NODE THAT LOST THE SEAT IS GIVEN IT AGAIN; the next feed retries.
            if (/no such entry/.test(f.why) && this.seatEntry) await this.seatOn(base);
            return;
          }
          f.down = false;
          f.next++;
          f.ticks = one.through;
          this.#wakeMarks();
        }
      } while (f.again);
    })().finally(() => { f.running = null; });
    return f.running;
  }

  /** Every peer's feed settled - for tests and for measuring the lag. */
  async awaitPeers() {
    for (;;) {
      const running = [...this.peerFeeds.values()].map((f) => f.running).filter(Boolean);
      if (!running.length) return;
      await Promise.all(running.map((p) => p.catch(() => {})));
    }
  }

  /** How far each peer holds this run's inputs, against this client's node. */
  peerBatches() {
    return [...this.peerFeeds.values()].map(({ base, ticks, refused, closed, down, downs, why }) =>
      ({ base, ticks, lag: this.nextTick - ticks, refused, closed, down, downs, why }));
  }

  /** Has every committee node answered that it holds this run's inputs before `tick`? */
  #holdsThrough(tick) {
    if (this.nextTick < tick) return false;
    for (const base of this.peers) if (this.peerFeed(base).ticks < tick) return false;
    return true;
  }

  /** Which committee nodes do not yet hold the inputs before `tick`, and how far they got. */
  #behind(tick) {
    const out = [];
    if (this.nextTick < tick) out.push(`${this.base} holds inputs before tick ${this.nextTick}`);
    for (const base of this.peers) {
      const f = this.peerFeed(base);
      if (f.ticks < tick)
        out.push(`${base} holds inputs before tick ${f.ticks}${f.why ? ` (${f.why})` : ''}`);
    }
    return out;
  }

  /**
   * THE PENDING LINK AGAIN, THE SAME BYTES, TO EVERY NODE.
   *
   * A node that already stored it answers with the receipt it issued (a repeat
   * writes nothing and is not an error); a node that missed it stores it now.
   * Each receipt is checked the way every receipt is, and when the committee
   * carries it `readReceipt` moves the head onto it.
   */
  async #relink() {
    const link = this.pendingLink;
    const bases = [this.base, ...this.peers];
    const answers = await Promise.all([
      this.send(link.bytes), ...this.peers.map((b) => this.sendPeer(b, link.bytes))]);
    const refused = [];
    const unreached = [];
    answers.forEach((a, i) => {
      if (typeof a === 'string') {
        (a.startsWith(CLOSED) ? unreached : refused).push(`${bases[i]}: ${a}`);
        return;
      }
      try { this.readReceipt(a, link.id); } catch (e) { refused.push(`${bases[i]}: ${e.message}`); }
    });
    const live = this.live(link.id);
    if (live) { this.pendingLink = null; this.marksRelinked++; }
    return { live, refused, unreached, tick: link.tick };
  }

  /** Sends every waiting mark whose inputs every node now holds. */
  #wakeMarks() {
    if (!this.inputWaiters.length) return;
    const still = [];
    for (const w of this.inputWaiters) {
      if (this.#holdsThrough(w.tick)) { clearTimeout(w.timer); w.resolve(true); } else still.push(w);
    }
    this.inputWaiters = still;
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
        // NOT A REFUSAL: the node said nothing. Answered with the CLOSED word,
        // so the batch and the mark that were waiting know it was the link.
        for (const w of waiting) w(`${CLOSED}the socket closed`);
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
    // TO EVERY COMMITTEE NODE AT ONCE, and each receipt checked on its own.
    // `readReceipt` counts the signer and moves the head only when the mark is
    // LIVE, so the next checkpoint names this one exactly when enough of the
    // committee holds it - on the Daily's 2-of-2, both.
    const [answer, ...theirs] = await Promise.all([
      this.send(built.bytes), ...this.peers.map((b) => this.sendPeer(b, built.bytes))]);
    // A PEER THAT NEVER GOT IT IS `unreached`, NOT `refused` - see CLOSED.
    const refused = [];
    const unreached = [];
    this.peers.forEach((base, i) => {
      const a = theirs[i];
      if (typeof a === 'string') { (a.startsWith(CLOSED) ? unreached : refused).push(`${base}: ${a}`); return; }
      try { this.readReceipt(a, built.id); } catch (e) { refused.push(`${base}: ${e.message}`); }
    });
    let receipt = null;
    if (typeof answer === 'string')
      (answer.startsWith(CLOSED) ? unreached : refused).unshift(`${this.base}: ${answer}`);
    else receipt = this.readReceipt(answer, built.id);
    const live = this.live(built.id);

    // A MARK SOME NODE STORED AND THE COMMITTEE DID NOT CARRY IS KEPT.
    //
    // Measured 2026-09-10 on two real daemons: B went down after it held the
    // inputs for tick 60, mark 60 reached A alone and never went live, and the
    // head stayed put - so the next mark named the old head. A refused it and
    // KEPT it: the second child of one parent, 13B's fork proof, published
    // against an honest player (/equivocation 200). B, which never had mark
    // 60, stored the new one, and the two daemons held two chains. So a mark
    // any node holds is remembered until the committee carries it, and no new
    // mark goes out before then - see `markNow`.
    if (live) this.pendingLink = null;
    else if (this.witnessed(built.id) > 0) this.pendingLink = { id: built.id, bytes: built.bytes, tick };
    return { ...built, answer: receipt ? 'receipted' : answer, receipt, refused, unreached, live };
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
  async batch(ticks, { roundId, entryId, liquidations = [], loads = [] }) {
    const b = {
      roundId, entryId,
      previousHash: this.batchHead,
      firstTick: this.nextTick,
      ticks,
      liquidations,
      loads,
    };
    const bytes = encodeInputBatch(b);
    const answer = await this.send(bytes);

    // The node answers how many ticks were NEW. A refusal is a named string
    // and the chain must not move on one, the same rule the marks follow.
    if (typeof answer !== 'string' || !/^[0-9]+$/.test(answer)) return { batch: b, answer };
    this.batchHead = batchId(b);
    this.nextTick = b.firstTick + ticks.length;
    // AND THE SAME BYTES GO TO EVERY OTHER COMMITTEE NODE, in the order this
    // node took them - see `pumpPeers`. Every batch is KEPT, peers or not: a
    // node refuses a batch that does not follow its own head, so a peer that
    // arrives late can only be caught up from the run's first batch. A whole
    // run is at most blockTicks x 20 bytes of words.
    this.published.push({ bytes, through: this.nextTick });
    if (this.peers.length) this.pumpPeers();
    this.#wakeMarks();
    return { batch: b, answer, accepted: Number(answer) };
  }

  /**
   * WHAT THIS SEAT OWES, ASKED OF THE NODE AND CHECKED AGAINST OUR OWN ENTRY.
   *
   * M3.2 item 5's PAY step, and it stops exactly where a satoshi would move.
   * This asks and verifies; nothing here pays, and the client has no method
   * that does - the wallet is item 6, and it is item 6 precisely because the
   * client is what defines the question it will be asked.
   *
   * THE CHECK IS THE PROTOCOL'S OWN AND IT IS NOT OPTIONAL. A hold invoice
   * names a payment hash and an amount; the entry the player SIGNED already
   * names both - `stakeCommitment` is the hash, and the amount is the net
   * stake: `stakeMsat` less the fee and the donation that come out of it
   * (22A) - so a node quoting anything else is quoting somebody else's
   * invoice, or one nobody could ever settle. `invoiceMatchesEntry` is that
   * rule and it is imported rather than restated.
   *
   * THE ENTRY IS THE CALLER'S, NOT THE NODE'S. Asking the node for the entry
   * and then checking the invoice against it would be asking one party both
   * questions - it could answer them consistently and still be wrong. The
   * client checks against the contract it built and signed.
   */
  async invoice(entry, { entryId: id } = {}) {
    if (!entry || !(entry.stakeCommitment instanceof Uint8Array))
      return { ok: false, why: 'there is no entry to check an invoice against' };
    const eid = id || (this.where && this.where.entryId);
    if (!(eid instanceof Uint8Array) || eid.length !== 32)
      return { ok: false, why: 'no entry id to ask about: setRound was never called and none was given' };

    // AND THE CONTRACT IS THE ONE BEING ASKED ABOUT.
    //
    // A crossed pair - one seat's contract, another seat's id - is refused
    // below anyway, because the hashes differ. That is a correct refusal for
    // the wrong reason, and it stops being correct the moment the two entries
    // share a commitment: one player re-entering a round keeps their preimage
    // and changes their world secret, so two ids, one hash, one amount, and
    // the quote for the other seat would be accepted as this one's. Checked
    // here, where the answer is "these are two entries" and not "these are two
    // hashes".
    if (toHex(entryId(entry)) !== toHex(eid))
      return {
        ok: false,
        why: `that entry is ${toHex(entryId(entry)).slice(0, 16)} and the invoice was asked `
          + `for ${toHex(eid).slice(0, 16)}: they are two seats`,
      };

    let said;
    try {
      const r = await fetch(`${this.base}/invoice?entry=${toHex(eid)}`);
      const body = await r.text();
      if (!r.ok) return { ok: false, status: r.status, why: body.trim() };
      said = JSON.parse(body);
    } catch (e) {
      return { ok: false, why: `the node would not quote this seat: ${e.message}` };
    }

    // WHAT CAME BACK HAS TO BE THE SHAPE BEFORE IT CAN BE THE RIGHT VALUE. A
    // missing field read as `undefined` would reach the rule as "not 32 bytes"
    // and be refused for the wrong reason.
    let paymentHash;
    let amountMsat;
    try {
      paymentHash = fromHex(String(said.paymentHash || ''));
      amountMsat = BigInt(said.amountMsat);
    } catch {
      return { ok: false, why: 'that node answered something that is not an invoice quote' };
    }
    if (typeof said.request !== 'string' || !said.request.length)
      return { ok: false, why: 'that quote carries no payment request to pay' };

    const stands = invoiceMatchesEntry({ paymentHash, amountMsat, entry });
    if (!stands.ok) return { ok: false, why: stands.why, quoted: said };

    return {
      ok: true,
      request: said.request,
      paymentHash,
      amountMsat,
      state: said.state,
      why: stands.why,
    };
  }

  /**
   * PAY THE HOLD INVOICE THIS SEAT OWES, AND NOTHING ELSE EVER.
   *
   * M3.2 item 6, and the only method in this client that moves a satoshi.
   *
   * IT TAKES AN ENTRY, NOT AN INVOICE. That is the whole safety property and
   * it is a signature, not a check: there is no argument here that could carry
   * an arbitrary bolt11, so no caller - page, test or a script somebody pastes
   * - can walk this into paying something. The invoice is fetched by
   * `invoice()`, which refuses an amount, a hash or a seat the entry did not
   * sign, and only what survives that is handed to the wallet.
   *
   * THE BUDGET PROVES NOTHING AND IS NOT ASKED TO. §24A.1: "an NWC budget is
   * wallet-side policy and encodes nothing about the round... The binding is
   * still `payment_hash` in the Entry Contract." A budget bounds the loss if
   * this client is compromised; what binds the payment to the round is that
   * the hash came off the contract the player signed.
   *
   * WHAT COMES BACK IS THE WALLET'S PREIMAGE, and it is handed up rather than
   * stored: a hold invoice's preimage is the wallet's proof it paid, and this
   * client keeps no money state between rounds (§24A.3).
   */
  async payStake(entry, { connection, curve, entryId: id, log, ...options } = {}) {
    const where = typeof connection === 'string' ? parseConnection(connection) : connection;
    if (!where || !where.ok)
      return { ok: false, why: (where && where.why) || 'there is no wallet connection to pay with' };
    // THE CURVE IS INJECTED, like `sign` and `verify` on this class and like
    // the one `stakeFor` takes: this bundle carries no crypto, and the page
    // loads `blwp-curve.js` beside it.
    if (!curve || typeof curve.ecdhShared !== 'function' || typeof curve.signSchnorr !== 'function')
      return { ok: false, why: 'talking to a wallet needs a curve, and none was injected' };

    // THE QUOTE FIRST, AND ITS REFUSAL IS THIS METHOD'S REFUSAL. A quote the
    // entry did not sign never reaches the wallet at all - not as a request it
    // declines, but as a request that is never sent.
    const quote = await this.invoice(entry, { entryId: id });
    if (!quote.ok) return { ...quote, paid: false, asked: false };

    const paid = await payInvoice(where, quote.request, {
      curve,
      random: options.random || ((n) => crypto.getRandomValues(new Uint8Array(n))),
      ...options,
    });
    if (!paid.ok) return { ...paid, paid: false, asked: true, quoted: quote };

    // WHAT WAS SPENT, WRITTEN DOWN WHERE THE SPENDING HAPPENS.
    //
    // §24A.1 is a requirement: "a client MUST show the running total and what
    // it was spent on". The log is handed in rather than owned here, because a
    // page runs one across many rounds and a Client is per round - but it is
    // recorded HERE, next to the payment, so a page cannot show a total of its
    // own arithmetic.
    if (log && typeof log.record === 'function') {
      log.record({
        amountMsat: quote.amountMsat,
        paymentHash: quote.paymentHash,
        roundId: this.where && this.where.roundId,
      });
    }

    return {
      ok: true, paid: true, asked: true,
      preimage: paid.preimage,
      amountMsat: quote.amountMsat,
      paymentHash: quote.paymentHash,
      request: quote.request,
      feesPaidMsat: paid.feesPaidMsat,
    };
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

    const before = this.nextTick;
    const last = t.batches[t.batches.length - 1];
    this.batchHead = last ? batchId(last) : GENESIS;
    this.nextTick = last ? batchTicks(last).at(-1) + 1 : entry.joinTick;

    // THE NODE MAY ALREADY HOLD WHAT THIS CLIENT STILL HOLDS: a batch it took
    // whose answer never arrived. Those words are published, so they leave the
    // hold here - or the next batch would carry them again at the node's next
    // tick. Measured before this: the node took ticks 60..89, the answer was
    // lost, and after the resume tick 90 held the input recorded for 60 - the
    // node ended up with 150 ticks for 120 recorded. Its loads leave with them.
    const landed = this.nextTick - before;
    if (landed > 0 && landed <= this.hold.length) {
      this.hold = this.hold.slice(landed);
      this.held = this.hold.length;
      this.loads = this.loads.filter(([at]) => at >= this.nextTick);
      this.batchesLandedUnheard++;
    }
    // AND THE PEERS ARE FED WHAT THIS NODE TOOK, including a batch whose answer
    // was lost, in the node's own order - a peer missing one refuses the rest.
    for (let i = this.published.length; i < t.batches.length; i++) {
      const b = t.batches[i];
      this.published.push({ bytes: encodeInputBatch(b), through: batchTicks(b).at(-1) + 1 });
    }

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
    this.loads = [];
    this.dropped = 0;
    this.batchesSent = 0;
    this.marksSent = 0;
    this.marksSkipped = 0;
    this.marksAccepted = 0;
    this.marksRefused = 0;
    this.marksRefusedWhy = null;
    this.published = [];
    this.peerFeeds = new Map();
    this.batchesInterrupted = 0;
    this.batchesLandedUnheard = 0;
    this.peerBatchesRefused = 0;
    this.peerInputsClosed = 0;
    this.peerDowns = 0;
    this.marksUnreached = 0;
    this.marksUnreachedWhy = null;
    for (const w of this.inputWaiters) clearTimeout(w.timer);
    this.inputWaiters = [];
    this.marksWaited = 0;
    this.markWaiting = null;
    this.marksTimedOut = 0;
    this.marksTimedOutWhy = null;
    this.pendingLink = null;
    this.marksRelinked = 0;
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
  /**
   * WHAT WENT ON THE BED, AT THE TICK IT WAS DECLARED.
   *
   * Heat used to be a host write straight into the core - `BlwpSetHeat` - in
   * no batch, no mark and no transcript, so a committee replaying the run and
   * every ghost it drew walked a world the war was hunting less hard than it
   * hunted the player. The LOAD travels instead of the answer: two integers a
   * host honestly knows, and the core's own rule decides what they cost.
   *
   * Held against the tick the run has reached, and published with the batch
   * that covers that tick - a load that went out ahead of its own ticks would
   * name a tick the node has not been given yet.
   *
   * Refused once the run has ended, like every other outbound thing here.
   */
  submitLoad(feeSats, btcHundredths) {
    if (this.ended || !this.where) return false;
    this.loads.push([this.offered, feeSats | 0, btcHundredths | 0]);
    return true;
  }

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

    // THE LOADS THIS BATCH COVERS, and no others. A load names an absolute
    // tick and the node checks it against the ticks the batch carries, so one
    // declared while these words were still held goes out with them and one
    // declared after waits for the batch that reaches it.
    const through = this.nextTick + words.length;
    const loads = this.loads.filter(([at]) => at < through);
    const later = this.loads.filter(([at]) => at >= through);
    this.loads = later;

    this.publishing = this.batch(words, { ...this.where, loads }).then((r) => {
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
        // gap. The loads go back with the ticks they were sliced out beside:
        // a load left behind here would be a run whose replay is hunted at
        // zero from the tick the refusal happened at.
        this.hold = words.concat(this.hold); this.held = this.hold.length;
        this.loads = loads.concat(this.loads);
        if (typeof r.answer === 'string' && r.answer.startsWith(CLOSED)) {
          // THE LINK WENT WITH THE BATCH IN FLIGHT. The node refused nothing,
          // so this is not a refusal and does not resync towards VOID -
          // measured before this: two such drops, and an honest run ended
          // "VOID: the node refuses this run's inputs ... error the socket
          // closed". The words are held; the reconnect reads where the node
          // is (`resume`, which drops any the node did take) and the next
          // drain sends the rest.
          this.batchesInterrupted++;
        } else {
          this.refusals++;
          this.refusedWhy = typeof r.answer === 'string' ? r.answer : 'the node did not say';
          this.refusedAt = this.nextTick;
          this.#afterRefusal(r);
        }
      }
      this.publishing = null;
      // A MARK IS WAITING ON TICKS STILL HELD: carry on draining now rather
      // than on the page's next call, so the mark goes as soon as it can.
      if (this.inputWaiters.length && this.hold.length) {
        const d = this.drain();
        if (d && d.catch) d.catch(() => {});
      }
      return r;
    }).catch((e) => {
      this.hold = words.concat(this.hold);
      this.held = this.hold.length;
      this.loads = loads.concat(this.loads);
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
    // A PEER WHOSE FEED STOPPED ON A REFUSAL IS TRIED AGAIN once a second,
    // here, so a peer that was briefly down catches up without a batch of its own.
    this.pumpPeers();
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
    // NOT BEFORE EVERY NODE HOLDS THE INPUTS IT COMES FROM. A node refuses a
    // checkpoint at tick T until it holds every input before T, and when the
    // mark is taken the last of those are still in the hold. So the mark waits
    // - the hold is pushed out now, not on the page's next drain - until this
    // client's node has taken them AND every other committee node has
    // answered that it holds them; then it goes. A mark cannot race its
    // batches and be refused for it, and a node that is behind is caught up
    // from the first batch before it is asked to sign anything.
    //
    // AND NOT FOR EVER. A node that never catches up - stopped, unreachable,
    // refusing - held the mark, and with it every later mark (skipped while
    // one waits) and `awaitPublishes`, which never returned. So the wait is
    // bounded by `markWaitMs`, and when it passes the mark is SENT TO NOBODY.
    // That is failing closed: sent to the nodes that do hold the inputs, it
    // would be stored there and not where the rest could agree, and the next
    // link would name a head the rest of the committee never had. The mark is
    // counted ("timed out N", naming who was behind and how far), the head
    // stays where every node has it, and the next mark tries again.
    const where = this.where;
    const ready = this.#holdsThrough(tick) ? true : new Promise((resolve) => {
      const w = { tick, resolve };
      w.timer = setTimeout(() => {
        this.inputWaiters = this.inputWaiters.filter((x) => x !== w);
        resolve(false);
      }, this.markWaitMs);
      if (w.timer && w.timer.unref) w.timer.unref();
      this.inputWaiters.push(w);
    });
    if (ready !== true) {
      this.marksWaited++;
      this.markWaiting = tick;
      const d = this.drain();
      if (d && d.catch) d.catch(() => {});
    }
    this.marking = Promise.resolve(ready).then(async (held) => {
      this.markWaiting = null;
      if (held) {
        // AND NEVER A SECOND CHILD OF ONE PARENT. If a mark some node stored
        // was not carried, it goes again first; a new mark chains onto it once
        // it is live. If it still is not, the new mark is NOT sent - it would
        // name the head before the pending link, which the node holding that
        // link reads as a fork - and it is counted as skipped.
        if (this.pendingLink) {
          const again = await this.#relink();
          if (!again.live) {
            return {
              answer: `skipped: the checkpoint at tick ${again.tick} is stored but not carried, `
                + 'and a new one would name the head before it',
              skippedForLink: true, relinkRefused: again.refused, refused: [], live: false, receipt: null,
            };
          }
        }
        return this.mark(stateHash, {
          roundId: where.roundId, entryId: where.entryId, tick, inputChainHash,
        });
      }
      return {
        answer: `timed out after ${this.markWaitMs} ms waiting for the inputs before tick ${tick}`,
        timedOut: true, behind: this.#behind(tick), refused: [], live: false, receipt: null,
      };
    }).then((r) => {
      if (r.timedOut) {
        this.marksTimedOut++;
        this.marksTimedOutWhy = `tick ${tick}: ${r.behind.join('; ')}`;
      }
      if (r.skippedForLink) this.marksSkipped++;
      if (r.answer === 'receipted') this.marksSent++;
      if (r.live) this.marksAccepted++;
      if (r.refused && r.refused.length) { this.marksRefused++; this.marksRefusedWhy = r.refused.join('; '); }
      if (r.unreached && r.unreached.length) {
        this.marksUnreached++;
        this.marksUnreachedWhy = r.unreached.join('; ');
      }
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
      + (this.peers.length ? ` accepted ${this.marksAccepted}` : '')
      + (this.marksRefused ? ` refused ${this.marksRefused}` : '')
      + (this.marksUnreached ? ` unreached ${this.marksUnreached}` : '')
      + (this.peerBatchesRefused ? ` inputs refused ${this.peerBatchesRefused}` : '')
      + (this.peerDowns ? ` peer drops ${this.peerDowns}` : '')
      + (this.markWaiting !== null ? ` waiting ${this.markWaiting}` : '')
      + (this.marksTimedOut ? ` timed out ${this.marksTimedOut}` : '')
      + (this.pendingLink ? ` pending link ${this.pendingLink.tick}` : '')
      + (this.marksRelinked ? ` relinked ${this.marksRelinked}` : '')
      + (this.drops ? ` drops ${this.drops} tries ${this.tries} resumed ${this.resumedAt}` : '')
      + (this.batchesInterrupted ? ` interrupted ${this.batchesInterrupted}` : '')
      + (this.ended ? ` ${this.ending} ${this.endingReason}` : '');
  }

  /**
   * WAITS FOR WHATEVER IS ON THE WIRE - the batch and the mark in flight.
   *
   * IT WAS CALLED `settle` AND IT SETTLES NOTHING. 9.4's settle is a stake
   * moving on Lightning after a round is final, decided by the committee from
   * the core's own outcome word; this awaits two promises so a caller can read
   * `status()` without racing it. Two things with one name, and the name
   * belonged to the other one - it is the fourth word of M3.2 item 5, and a
   * reader coming to the session flow would find this.
   */
  async awaitPublishes() {
    while (this.publishing || this.marking) {
      try { await Promise.all([this.publishing, this.marking]); } catch { /* named elsewhere */ }
    }
  }

  close() {
    if (this.sock) this.sock.close();
    for (const link of this.peerLinks.values()) if (link.sock) link.sock.close();
  }
}
