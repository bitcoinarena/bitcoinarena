// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
// After the run is over the node does replay it, in `arena-node/src/replay.js`
// and nowhere else - section 13 makes a result final when five of seven nodes
// agree, and a node that could not replay would be agreeing to whatever it was
// told. That is one simulator run twice over the same inputs, which is the
// only claim determinism ever made; it is not a second engine.
//
// WHAT IT IS NOT. It is not a simulator and it holds no rule: it never decides
// a score, a crater, a hit or a winner. It reads a hash the core produced,
// wraps it in the protocol's own encoding, signs it, and puts it on a socket.
// Every byte that crosses the wire is written by `arena-protocol` - there is
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
} from '../../arena-protocol/src/checkpoint.js';
import {
  encodeRoundContract, decodeRoundContract, encodeEntryContract, decodeEntryContract, roundId, entryId, lastTickOfRun,
} from '../../arena-protocol/src/contracts.js';
import {
  GENESIS, decodeTranscript, checkTranscript, transcriptBelongsToEntry, flatten,
} from '../../arena-protocol/src/transcript.js';
import { batchId, batchTicks, signBatch, encodeInputBatch, joinSignedBatch, SIGNED_BATCH_SIGNATURE_BYTES } from '../../arena-protocol/src/batch.js';
import { centsToTapeUnits } from '../../arena-protocol/src/price-sample.js';
import { fromHex, toHex, sha256 } from '../../arena-protocol/src/hash.js';
import {
  decodeCheckpointReceipt, receiptId, splitSignedReceipt, SIGNED_RECEIPT_BYTES,
} from '../../arena-protocol/src/receipt.js';
// THE RULE A PLAYER CHECKS AN INVOICE WITH, IMPORTED AND NOT REWRITTEN.
//
// `server.js` says at its own /invoice door that this rule "lives on their
// side too", and until M3.2 item 5 it did not: zero callers here. A second
// formula in the client would be a second opinion about what the player owes,
// which is the one number they are about to part with money over.
import { parseConnection, payInvoice } from './nwc.js';
import { STAKE_NOT_SEEN } from '../../arena-protocol/src/constants.js';
import { stakeSeenBy, settlementBy, settlementDecided, feeBpsForRound } from './join.js';
import { handLock } from './page-lock.js';
import { invoiceQrSvg } from './qr.js';
import { decodeGhost } from '../../arena-protocol/src/ghost.js';
import { TYPE_GHOST } from '../../arena-protocol/src/constants.js';
import { discover } from './directory.js';
import { readWithOneRetry } from './reread.js';
import { NO_SHARES } from '../../arena-protocol/src/handout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
// THE PLAYER'S DONATION (M3.2 6e): the split, the failure rule, the LNURL checks.
import { donationSetMatchesRound, splitDonation, donationAfterFailures, donationSetPaysKeys } from '../../arena-protocol/src/donation.js';
import { donationKeysForNetworkId } from '../../arena-protocol/src/donation-keys.js';
import { urlOfLnurl } from '../../arena-protocol/src/bech32.js';
import { payRequestStands, callbackFor, invoiceAnswersPayRequest } from '../../arena-protocol/src/lnurl-pay.js';
import { donationPaidRecord, noteDonationShare } from './donation-pay.js';

/**
 * A FEDERATION ROUND'S STAKE: THE INVOICE COMES FIRST (2026-09-11).
 *
 * Here, and not in join.js, because this is the file that asks a node what a
 * player pays (session-pay.test.js: one file quotes a player). V1's pool is a
 * federation, and an LNv2 invoice's secret belongs to its receiver - held by
 * the guardians threshold-wise, which is the job the player's dealt shares do
 * on a round without one. So no P is chosen and no handout is dealt: a node
 * asks the federation for the round's invoice (`GET /federation-invoice`),
 * and the entry commits to that invoice's hash, with `NO_SHARES` as its
 * shares reference. The amount must be the entry's net stake - the stake less
 * the 2% fee and the player's donation, `netStakeMsat` as at every other door -
 * or the committee's hold check refuses the entry. Measured before (M3.2 6e):
 * this asked for the stake less the fee only, so a 2% donor's entry was joined
 * on a 980000 msat invoice it could never be quoted (it holds 960000).
 */
export async function federationStakeFor(round, { nodes, fetcher = fetch, donationMsat = 0n } = {}) {
  const stakeMsat = BigInt((round && round.stakeMsat) || 0n);
  if (!(stakeMsat > 0n)) throw new Error('a round that asks no stake has nothing to invoice');
  const want = netStakeMsat({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat, feeBpsForRound(round)), donationMsat });
  const id = toHex(round.id);
  const refused = [];
  for (const node of nodes || []) {
    const base = String(node).replace(/\/+$/, '');
    try {
      const r = await readWithOneRetry(fetcher, `${base}/federation-invoice?round=${id}${donationMsat ? `&donation=${donationMsat}` : ''}`);
      const body = await r.text();
      if (!r.ok) { refused.push(`${base}: ${r.status} ${body.trim()}`); continue; }
      const said = JSON.parse(body);
      const hash = fromHex(String(said.paymentHash || ''));
      if (hash.length !== 32) { refused.push(`${base}: a payment hash is 32 bytes`); continue; }
      if (BigInt(said.amountMsat) !== want) {
        refused.push(`${base}: an invoice for ${said.amountMsat} msat, and this round's net stake is ${want}`);
        continue;
      }
      return { federation: true, stakeCommitment: hash, vssSharesRef: NO_SHARES,
        request: said.request, amountMsat: want, node: base };
    } catch (e) { refused.push(`${base}: ${e.message}`); }
  }
  throw new Error(`no node made this round's federation invoice: ${refused.join('; ') || 'no node to ask'}`);
}

/**
 * Five, out of the seven a committee has.
 *
 * Section 13C: the canonical transcript is "the longest checkpoint chain that
 * carries receipts from at least 5 committee nodes". It is a threshold and not
 * a preference - the point of it is that no smaller set of nodes can make a
 * mark count, so an operator cannot spend a short committee as a win.
 */
export const RECEIPTS_FOR_LIVE = 5;
/** How long a mark waits for the whole committee before enough of it will do (#quorumHoldsThrough): well inside the 900-tick first-mark window. */
export const MARK_QUORUM_WAIT_MS = 3000;

/** 2-of-2 on this build's test nets; 5-of-7 on a seven-signer node contract. */
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
 * HOW MANY BATCHES A BEHIND PEER IS CAUGHT UP WITH AT ONCE.
 *
 * A mark at tick T waits until every committee node holds the inputs before T, so a peer that starts late
 * decides when the player's FIRST mark can go out - and §13B judges that mark against a 900-tick window.
 * Measured on the Daily, one paid entry per line, both seats through the same quick tunnels:
 *
 *   peer round trip                  65 ms (median of 2084)
 *   one batch                        6 ticks (BatchEvery, 10 Hz of a 60 Hz run)
 *   one batch per round trip         92 ticks/s against a player making 60 - a surplus of 32 ticks/s
 *   a seat 2280 ticks behind         71 s to close it, and the run's first mark went out at tick 5940
 *                                    of a window ending at 900: FORFEIT, on a player who paid in 10 s
 *
 * The backlog was never the transport's fault - it was spent waiting for one answer before asking the next
 * question. The frames on a socket are ORDERED, `sendPeer` matches answers to askers in the order they were
 * sent, and the node's own handler queues each frame behind the one before it ("every frame on a socket
 * waits for the one before it", server.js), so a window of them is taken in exactly the order one at a time
 * would have been. Nothing here relaxes what a node checks; it only stops making the client wait a round
 * trip per batch. 32 of them turn that 71 s into about 2 s, and a steady run - which has one new batch to
 * send - is byte for byte what it was.
 */
export const FEED_WINDOW = 32;
// A SEAT STILL TAKING THE HANDOUT IS ASKED AGAIN (kanban #828, 2026-11-02 04:05:41Z, both players of round a5fc9c2f): postHandout goes on once enough seats
// took it, the entry goes to one seat, and that seat's handout can still be on its way; its 400 ended the join with the stake already locked. 8 s; any other refusal stands.
export async function postEntry(url, body, { fetcher = (...a) => fetch(...a), tries = 16, waitMs = 500 } = {}) {
  for (let n = 0; ; n++) {
    const r = await fetcher(url, { method: 'POST', body });
    if (r.status === 201) return r;
    const said = (await r.text()).trim();
    if (n + 1 >= tries || !/publish the handout first/.test(said)) throw new Error(`the node refused the entry: ${said}`);
    await new Promise((res) => setTimeout(res, waitMs));
  }
}

/** A peer that refused the entry is asked again after ENTRY_BACKOFF_MS, then twice as long each time, at most ENTRY_BACKOFF_MAX_MS. */
export const ENTRY_BACKOFF_MS = 2000;
export const ENTRY_BACKOFF_MAX_MS = 60000;

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

/** How long `finish` waits for the held ticks to go out before it ends the run anyway. */
const FINISH_WAIT_MS = 300;
// HOW OFTEN THE FINAL MARK IS OFFERED AGAIN to a signer node that has not receipted it - a cadence, not a timeout: the
// window is the ruled one (from the ask until the settlement is combined, or the page leaves), and nothing ends it early.
const FINAL_RELINK_EVERY_MS = 1000;
/** The core's own words for a run that is over (core rules/gate.js RUN_DELIVERED 1, RUN_WRECKED 2, RUN_MISSED 3), as they read off the state. */
const RUN_ENDING_WORDS = Object.freeze({ 1: 'DELIVERED', 2: 'WRECKED', 3: 'MISSED' });

// HOW LONG THE LOCKS ARE OFFERED TO THE SIGNER NODES IN THE BACKGROUND: past the start deadline (900 ticks, 15 s) a stake
// not yet seen voids the entry anyway; two minutes covers a join held to a round that starts later.
export const LOCK_HAND_MS = 120000;
const LOCK_ACCEPT_HEAD_MS = 3000;   // the lock client's acceptance first; the seats' own check after it

const OPENED_ROUNDS = new Map();

/**
 * IS THIS THE SESSION KEY'S SIGNATURE (kanban #1567): Ed25519 through the platform's own WebCrypto - the browser's, the
 * one the page's session key signs with, and Node's - so the bundle still carries no curve of its own. A page or a test
 * may hand its own as `verifySession`. Answers false for anything it cannot check.
 */
const SESSION_KEYS = new Map();
export async function verifySessionSignature(signature, message, publicKey) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) return false;
  try {
    const hex = toHex(publicKey);
    let key = SESSION_KEYS.get(hex);
    if (!key) { key = await subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']); SESSION_KEYS.set(hex, key); }
    return !!(await subtle.verify({ name: 'Ed25519' }, key, signature, message));
  } catch { return false; }
}

/**
 * THE CORE STEPPED THROUGH A TRANSCRIPT, as a seat replays it (arena-node replay.js, core adapter eventsOf): each tick's
 * tape, load, sample and liquidation BEFORE that tick, then its five words. The page's core after a reload is then the
 * state its marks were hashed from, and the run goes on from the tick the node is owed. `core` is the page's sim
 * (step(st, w0..w4), submitTape/Load/Sample/Liquidation(st, ...)). Answers the next tick.
 */
export function catchUpCore(core, st, transcript) {
  const f = flatten(transcript);
  const at = (rows) => new Map(rows.map(([i, ...v]) => [i, v]));
  const tapes = at(f.tapes), loads = at(f.loads), samples = at(f.samples), due = at(f.liquidations);
  for (let i = 0; i < f.ticks.length; i++) {
    if (tapes.has(i)) core.submitTape(st, tapes.get(i));
    if (loads.has(i)) core.submitLoad(st, ...loads.get(i));
    if (samples.has(i)) core.submitSample(st, samples.get(i)[0]);
    if (due.has(i) && core.submitLiquidation) core.submitLiquidation(st, due.get(i)[0]);
    const w = f.ticks[i];
    core.step(st, w[0], w[1], w[2], w[3], w[4]);
  }
  return f.firstTick + f.ticks.length;
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
  static async at(discovery, { core, sign, verify, verifySession, contract, roundIdGiven, stakeLock }) {
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

    // THE ANCHOR FOLLOWS THE ROUND'S NETWORK, read off the contract the round id was just checked against
    const seen = await discover({ ...discovery, committee: contract.nodes, networkId: contract.networkId });
    // WHICH PROVIDER, AND WHY (M3.3-27): `discover` hands back each provider's
    // own refusal, and the door used to drop it - the rehearsal's flake read
    // "only 1 of 2 providers gave a chain" and nothing more.
    if (!seen.ok)
      throw Object.assign(new Error(`no proven endpoint: ${seen.why}`
        + (seen.refused ? ` (${seen.refused})` : '')), { refused: seen.refused });

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
    // A CARRIED BOND: its ancestor advertisement and its re-affirmation are signed by the same key, or the
    // endpoint its update names is not that bond's
    for (const c of seen.checks || []) {
      if (!await verify(c.signature, c.message, c.key))
        throw new Error(`${c.what} for ${toHex(c.key)} is not signed by that node`);
    }

    const client = new Client({
      base: seen.endpoint.replace(/^ws/, 'http'), core, sign, verify, ...(verifySession ? { verifySession } : {}),
    });
    // THE CHAIN THIS CALL PROVED, carried on the client so the page can open its NEXT round from it rather than
    // proving the same headers again at a boundary where a starved tab misses the ten seconds (2026-09-18).
    client.provedChain = seen.chain || null;
    client.reusedChain = !!seen.reusedChain;
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
    // THE PLAYER'S STAKE LOCK, made by the page before the entry was built
    // (W1b), handed to the signer nodes by `join` once they hold the entry.
    if (stakeLock) client.stakeLock = stakeLock;
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

  constructor({ base, core, sign, verify, verifySession = verifySessionSignature }) {
    this.base = base;
    this.core = core;
    this.sign = sign;
    // THE SESSION KEY'S CURVE, to tell a batch this client signed from one a seat wrote into its own store (kanban #1567).
    // `verify` is the seats' curve (receipts, adverts); this one is the session key's.
    this.verifySession = verifySession;
    // EVERY FRAME THIS CLIENT SIGNED, by batch id (kanban #1567): the only frames it ever publishes again. A resume used to
    // sign whatever the home seat served past `published`, so a seat that appended a forged batch to its own store and
    // refused the next one had the player's own client sign the forgery and feed it to the whole committee.
    this.signedFrames = new Map();
    // A SEAT THAT SERVED THIS ENTRY A BATCH THIS CLIENT NEVER SIGNED: { base, firstTick, why }, null while none has
    this.nodeFault = null;
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
    // Batches answered "stake not seen" - a wallet still paying, not a refusal.
    this.stakeWaits = 0;
    this.stakeWhy = null;
    // How many settlement signer nodes have seen this entry's stake held (23.1 step 5).
    // `stakeCommitted` is a label: it gates nothing. NOT `stakeSeen`, which is a method of this class - a
    // field of that name once hid it and every call threw "this.stakeSeen is not a function".
    this.stakeCount = null;
    this.stakeCommitted = false;
    this.stakePolls = 0;
    this.stakeWatchStopped = false;
    this.stakeWatch = null;         // the running count, so a second start joins it
    // AND WHERE THE STAKE STANDS AFTER THE RUN (MF item 14), asked once it is
    // committed and until every signer node has moved the hold.
    this.settlement = null;
    this.settlementWatch = null;
    this.settlementPolls = 0;
    this.settlementOver = false;
    this.refusedWhy = null;
    this.refusedAt = null;
    this.resynced = false;
    this.recovering = null;
    this.nextTick = 0;            // the tick the node is owed next
    this.loads = [];              // [tick, feeSats, btcHundredths], not yet published
    this.samples = [];            // [tick, price], the live price samples not yet published
    this.tapes = [];              // [tick, p0 .. p63], the live tape not yet published
    this.attests = [];            // [tick, kind, cents, sigs], the committee's word on a sample (0) or the tape (1) (§11)
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
    this.peerJoins = [];
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
    this.marksHeadRecovered = 0;  // heads read back from the nodes after a mark neither carried nor pending
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
    // THE NODE'S ANSWER FOR THIS ROUND IS KEPT FOR THE PAGE (2026-10-02, the join's 2-3 s): POST /round took 1.4 s
    // of a paid join after the stake was locked, and the page can ask it at the click, beside the lock. Kept per node
    // and round, the promise itself; a refusal is not kept, so the session then asks afresh and is told why.
    const key = `${this.base}|${toHex(mine)}`;
    if (!OPENED_ROUNDS.has(key)) {
      const asked = (async () => {
        const r = await fetch(`${this.base}/round`, { method: 'POST', body: encodeRoundContract(contract) });
        if (r.status !== 201) throw new Error(`the node refused the round: ${(await r.text()).trim()}`);
        return agrees(mine, new Uint8Array(await r.arrayBuffer()), 'round');
      })();
      OPENED_ROUNDS.set(key, asked);
      asked.catch(() => OPENED_ROUNDS.delete(key));
    }
    return OPENED_ROUNDS.get(key);
  }

  /**
   * Joins it. The entry contract carries the session key the marks are signed
   * with, and its id is checked the same way and for the same reason.
   */
  async join(entry) {
    const mine = entryId(entry);
    // THE ENTRY THE STAKE LOCK IS NAMED IN, KEPT BEFORE THE ENTRY GOES OUT (kanban #1162): a lock already named in another entry throws here,
    // and this entry is not sent - the seats that took the first refuse the lock under any other
    if (this.stakeLock && typeof this.stakeLock.onNamed === 'function') this.stakeLock.onNamed(mine);
    const r = await postEntry(`${this.base}/entry`, encodeEntryContract(entry));

    // WHO THIS CLIENT JOINED, kept for the ghost field. A reload keeps the
    // player's key (sessionStorage) and draws a NEW entry, so the signer node this tab
    // held before the reload is still in the round, frozen - and it is this
    // player. A field that knew only its entry id kept it as somebody else:
    // measured 2026-09-10, each tab held its own pre-reload signer node as an "other",
    // and the chip named it because its frozen run had gone furthest.
    this.playerPubkey = entry.playerPubkey;

    const joined = agrees(mine, new Uint8Array(await r.arrayBuffer()), 'entry');

    // AND ON EVERY OTHER COMMITTEE NODE, or it refuses this entry's checkpoints
    // as "no such entry" - measured: daemon B answered 404 for every Daily signer node.
    // A node that will not take it is written down, not thrown: this node took
    // the entry, and the run can still be played.
    this.joinedEntry = entry;
    this.peerJoins = await Promise.all(this.peers.map((base) => this.joinOn(base)));

    // AND THE STAKE LOCK GOES TO EVERY SIGNER NODE NOW THAT THE ENTRY IS THERE (§23.1
    // step 5, W1b). A signer node verifies it in the federation and only then counts
    // the stake; before the entry is joined it has nothing to check it against.
    // The count is kept, not thrown: the round is joined either way, and the
    // stake is committed or not by the signer nodes' own answers.
    if (this.stakeLock) {
      // THE LOCKS GO TO THE SIGNER NODES IN THE BACKGROUND (JOIN-TIME, 2026-10-02: "Join click to the round actually
      // loaded: 2 to 3 seconds at most"; ruled the same day: the stake is confirmed in the background - the signer nodes hold
      // a player's ticks until they have seen it, and an unconfirmed stake by the start deadline voids the entry). The
      // session opens now. The stake lock and the fee lock go to every node at once, and a node that did not take one yet
      // (the federation still accepting the lock, a node slow to answer) is asked again until `needed` took each, or
      // LOCK_HAND_MS passes. `lockHanding` is the whole of it, for a caller that wants to wait.
      this.lockHanding = this.#handLocksUntilTaken(mine);
    }
    return joined;
  }

  async #handLocksUntilTaken(mine) {
    const nodes = [this.base, ...this.peers];
    // A LOCK STILL BEING ACCEPTED (OPEN-LIST-2140 item 3: the entry goes out on the lock's submission) is handed over the
    // moment the guardians accept it - measured on 0.0.2498, the backoff's first tries fell before acceptance and the one
    // that took landed late: the 5th of 7 signer nodes verified 3.5 s after PLAY. A lock refused there is handed to nobody.
    // NOT WAITED ON PAST LOCK_ACCEPT_HEAD_MS (playtest 2026-10-24, b2b7ced1: a lock client with too few guardian sockets open never hears the
    // acceptance): the seats are asked from then on - each verifies the lock with the guardians itself - and a refusal stops the handing
    let refused = false;
    if (this.stakeLock.accepted && typeof this.stakeLock.accepted.then === 'function') {
      const first = await Promise.race([this.stakeLock.accepted.then(() => 'yes', () => 'no'), this.sleep(LOCK_ACCEPT_HEAD_MS).then(() => 'late')]);
      if (first === 'no') return { lock: null, feeLock: null };
      if (first === 'late') this.stakeLock.accepted.catch(() => { refused = true; });
    }
    const needed = this.stakeLock.needed;
    const kinds = [{ door: 'lock', fields: this.stakeLock.fields, key: 'lockHanded' }];
    if (this.stakeLock.feeLock) kinds.push({ door: 'fee-lock', fields: this.stakeLock.feeLock.fields, key: 'feeLockHanded' });
    const took = new Map(kinds.map((k) => [k.door, new Set()]));
    // A MARKET ORDER'S LOCKS ARE HANDED UNTIL ITS ROUND'S ENTRY CLOSES (measured on the regtest stack: three
    // seats refused a stake lock while the federation was still accepting it, the 120 s ran out, and the order sat at 4 of 7
    // seats - a batch needs 5 signers, each holding the order's locks - so it never traded): `handUntilMs` from the page
    const until = Math.max(Date.now() + LOCK_HAND_MS, Number(this.stakeLock.handUntilMs || 0));
    for (let pause = 300; ; pause = Math.min(pause * 2, 3000)) {
      await Promise.all(kinds.map(async (k) => {
        const left = nodes.filter((n) => !took.get(k.door).has(n));
        if (!left.length) return;
        const r = await handLock({ entryId: mine, fields: k.fields, nodes: left, needed: 0, door: k.door });
        for (const s of r.said) if (s.status === 201) took.get(k.door).add(s.node);
        this[k.key] = { ok: took.get(k.door).size >= needed, committed: took.get(k.door).size, needed, said: r.said };
      }));
      if (this.lockHanded && this.lockHanded.ok && !this.lockCommittedSaid && typeof this.stakeLock.onCommitted === 'function') {
        this.lockCommittedSaid = true;
        try { this.stakeLock.onCommitted(mine); } catch { /* the page's bookkeeping, not the signer node's */ }
      }
      if (refused || kinds.every((k) => took.get(k.door).size >= nodes.length) || Date.now() >= until) break;
      await this.sleep(pause);
    }
    return { lock: this.lockHanded, feeLock: this.feeLockHanded };
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

  /** Signer nodes this client's entry on one other committee node. */
  async joinOn(base) {
    try {
      const p = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(this.joinedEntry) });
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

  /** The clock the peer feeds read (a test sets its own). */
  now() { return Date.now(); }

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
    // A PEER THAT REFUSED THE ENTRY IS LEFT ALONE UNTIL ITS BACKOFF IS OVER (2026-10-16: "Lower the amount of
    // concurrent connections and network load"): measured on live UI 154, three peers that answer the entry 400 were sent every
    // batch and the entry again at each one - a refused POST /entry every 1-2 s for the whole round
    if (f.entryBackoffUntil && this.now() < f.entryBackoffUntil) return Promise.resolve();
    f.running = (async () => {
      do {
        f.again = false;
        while (f.next < this.published.length) {
          // ASKED AS A WINDOW, READ AS A QUEUE (`FEED_WINDOW`). The frames go out back to back and the
          // answers are read in the order they were asked for, which is the order the node takes them in.
          // A steady run has one batch to send and this is one frame, as before; a peer that is behind
          // stops costing a round trip per batch of it.
          // ONE FRAME to a peer that refused the entry: its answer says whether it holds it now; the window once it does
          const window = this.published.slice(f.next, f.next + (f.entryRefused && f.entryBackoffUntil ? 1 : FEED_WINDOW));
          const asked = window.map((one) => ({ one, said: this.sendPeer(base, one.bytes) }));
          // EVERY ANSWER IS READ, INCLUDING THE ONES AFTER A REFUSAL. They are already on the wire, and a
          // promise nobody reads would leave `sendPeer`'s queue matching the next batch to this one's
          // answer. `stop` is what the old `return` said: the feed ends at the first batch that did not
          // land, `f.next` stays on it, and the next batch or mark asks again from exactly there.
          let stop = null;
          for (const { one, said } of asked) {
            const a = await said;
            if (stop) continue;
            // NO CONNECTION IS NOT A NO: counted as closed, and as one drop per
            // time the peer went away, never as a refusal. The feed stops and
            // the next batch or mark tries again, exactly as it did.
            if (typeof a === 'string' && a.startsWith(CLOSED)) {
              f.closed++;
              this.peerInputsClosed++;
              if (!f.down) { f.down = true; f.downs++; this.peerDowns++; }
              f.why = a;
              stop = 'closed';
              continue;
            }
            // A PEER THAT HAS NOT SEEN THE STAKE YET is waiting too: the feed
            // stops uncounted and the next batch or mark asks it again.
            if (typeof a === 'string' && a.startsWith(`error ${STAKE_NOT_SEEN}`)) {
              f.why = a;
              stop = 'waiting';
              continue;
            }
            if (typeof a !== 'string' || !/^[0-9]+$/.test(a)) {
              f.refused++;
              this.peerBatchesRefused++;
              f.why = typeof a === 'string' ? a : `${a.length} bytes where a tick count was due`;
              stop = /no such entry/.test(f.why) ? 'no entry' : 'refused';
              continue;
            }
            f.down = false;
            f.next++;
            f.ticks = one.through;
            this.#wakeMarks();
          }
          // A NODE THAT LOST THE SIGNER NODE IS GIVEN IT AGAIN; the next feed retries.
          if (stop === 'no entry' && this.joinedEntry) {
            const j = await this.joinOn(base);
            if (j.ok) { f.entryBackoffMs = 0; f.entryBackoffUntil = 0; }
            else {
              // refused: asked again after 2 s, then twice as long each time, at most ENTRY_BACKOFF_MAX_MS
              f.entryBackoffMs = Math.min(ENTRY_BACKOFF_MAX_MS, f.entryBackoffMs ? f.entryBackoffMs * 2 : ENTRY_BACKOFF_MS);
              f.entryBackoffUntil = this.now() + f.entryBackoffMs;
              f.entryRefused = (f.entryRefused || 0) + 1;
              f.why = `the entry refused: ${j.why}`;
            }
          }
          if (stop) return;
        }
      } while (f.again);
    })().finally(() => { f.running = null; });
    return f.running;
  }

  /**
   * THE FINAL MARK, RE-OFFERED (ruled 2026-09-23): the same object - its parent and tick the ones `finish` asked - to
   * every signer node that has not receipted it, feed first, once a second, from the ask until every signer node
   * holds it, the page leaves, or the round's settlement is combined. Never a second mark; never after the combine.
   */
  async #catchUpFinal() {
    if (this.catchingUp) return this.catchingUp;
    this.catchingUp = (async () => {
      for (;;) {
        const link = this.finalLink;
        if (!link || this.leftPage) return 'left';
        if (this.witnessed(link.id) >= this.nodes.length) return 'receipted';
        if (await this.#combined()) return 'combined';
        try {
          const got = await this.#relink(link);
          // WHAT A SIGNER NODE THAT HAS NOT RECEIPTED IT SAID, kept for the status line and a reader.
          this.finalRelinkWhy = [...got.refused, ...got.unreached].join('; ') || null;
        } catch (e) { this.finalRelinkWhy = e.message; }
        this.finalRelinks = (this.finalRelinks || 0) + 1;
        if (this.witnessed(link.id) >= this.nodes.length) return 'receipted';
        await new Promise((r) => { const t = setTimeout(r, FINAL_RELINK_EVERY_MS); if (t.unref) t.unref(); });
      }
    })().then((why) => { this.finalCatchUp = why; this.catchingUp = null; return why; });
    return this.catchingUp;
  }

  /** Whether the round's settlement is combined, as this client's own node answers it (none for a free round). */
  async #combined() {
    try {
      const r = await fetch(`${this.base}/lock-settlement?round=${toHex(this.where.roundId)}`);
      if (!r.ok) return false;
      const s = await r.json();
      return s && (s.state === 'SUBMITTING' || s.state === 'ACCEPTED');
    } catch { return false; }
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

  /**
   * ENOUGH OF THE COMMITTEE HOLDS THEM (kanban #827, measured 2026-10-31 12:48Z, round d1d3701c: five of six signers held both players' inputs, the sixth's
   * stake-lock read stalled two minutes, every first mark waited for it and both runs were FORFEIT at the 900-tick window). A mark needs RECEIPTS_FOR_LIVE
   * receipts to count, so that many holders can carry it: after MARK_QUORUM_WAIT_MS it goes without the rest, who stay on the feed and take the later marks.
   */
  #quorumHoldsThrough(tick) {
    const size = this.peers.length + 1;
    const need = size <= 2 ? size : Math.min(RECEIPTS_FOR_LIVE, size);
    if (size === need || this.nextTick < tick) return false;
    let held = 1;
    for (const base of this.peers) if (this.peerFeed(base).ticks >= tick) held++;
    return held >= need;
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
  async #relink(link = this.pendingLink) {
    // FEED FIRST, FOR THE FINAL MARK (ruled 2026-09-23): a peer behind on the inputs that mark commits to is fed from
    // the first batch it never answered - its feed restarts here, not only on a new batch that will never come - and
    // is offered the same mark only once it holds them. Nothing past the mark's tick exists to send: recording stopped.
    let peers = this.peers;
    if (link.final) {
      for (const b of this.peers) if (this.peerFeed(b).ticks < link.tick) await this.#feed(b);
      peers = this.peers.filter((b) => this.peerFeed(b).ticks >= link.tick);
    }
    const bases = [this.base, ...peers];
    const answers = await Promise.all([
      this.send(link.bytes), ...peers.map((b) => this.sendPeer(b, link.bytes))]);
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
    if (live && this.pendingLink && this.pendingLink.id === link.id) { this.pendingLink = null; this.marksRelinked++; }
    return { live, refused, unreached, tick: link.tick, witnessed: this.witnessed(link.id) };
  }

  /** Sends every waiting mark whose inputs every node now holds. */
  #wakeMarks() {
    if (!this.inputWaiters.length) return;
    const still = [];
    for (const w of this.inputWaiters) {
      if (w.final ? this.nextTick >= w.tick : this.#holdsThrough(w.tick)) { clearTimeout(w.timer); clearInterval(w.quorum); w.resolve(true); } else still.push(w);
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
   * THE FIRST SOCKET, TRIED UNTIL IT OPENS OR THE ROUND CANNOT USE IT (PRIORITIES 2026-10-02 12:13, the owner's playtest):
   * the entry was posted to all 7 signer nodes and the stake locked, but the one socket the page then opened failed while
   * the test host stalled - "Not joined ... socket error" - and the page gave up a join every node held; no first mark
   * came, and the door signed FORFEIT. A refused join is a refusal; a socket that did not open is the link, so it is
   * tried again with the same backoff `reconnect` uses (1 s doubling to 8 s), each attempt given `attemptMs`, until
   * `untilMs` (the page passes the round's start plus a few seconds, inside the first-mark deadline).
   */
  async connectFirst({ untilMs = Infinity, attemptMs = 10000, now = () => Date.now() } = {}) {
    let backoff = 0;
    this.firstTries = 0;
    for (;;) {
      this.firstTries++;
      try {
        let timer = null;
        try {
          return await Promise.race([this.connect(), new Promise((_, no) => { timer = setTimeout(() => no(new Error('socket did not open in ' + attemptMs + ' ms')), attemptMs); })]);
        } finally { clearTimeout(timer); }
      } catch (e) {
        this.error = String(e.message || e);
        if (this.sock) { const sk = this.sock; this.sock = null; try { sk.close(); } catch { /* gone */ } }
        backoff = backoff ? Math.min(backoff * 2, 8000) : 1000;
        if (this.ended || now() + backoff >= untilMs) throw new Error(`${this.error} (${this.firstTries} tries)`);
        await this.sleep(backoff);
      }
    }
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
          // AND THE SOCKET MUST STILL BE THERE (measured 2026-10-03 21:38:50Z, paid round 8bed315a: the new socket closed
          // while this was resuming; its close found this reconnect in flight, so the onDrop it fired got this same promise
          // back and started nothing, the resume answered from the CLOSED words, and the run was called ready with no socket
          // under it - nothing ever closed again, nothing reconnected, and all 1469 ticks stayed held). Round again instead.
          if (!this.sock || this.sock.readyState !== 1) throw new Error('the socket closed while the run was resuming');
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
  async mark(hex, { roundId, entryId, tick, inputChainHash = GENESIS, final = false }) {
    const built = await markHashed(hex, {
      roundId, entryId, tick, previousHash: this.head, inputChainHash,
    }, this.sign);
    // A FINAL MARK GOES ONLY TO THE PEERS THAT HOLD ITS INPUTS; the others get it, feed first, when they catch up.
    const to = final ? this.peers.filter((b) => this.peerFeed(b).ticks >= tick) : this.peers;
    // TO EVERY COMMITTEE NODE AT ONCE, and each receipt checked on its own.
    // `readReceipt` counts the signer and moves the head only when the mark is
    // LIVE, so the next checkpoint names this one exactly when enough of the
    // committee holds it - on the Daily's 2-of-2, both.
    const [answer, ...theirs] = await Promise.all([
      this.send(built.bytes), ...to.map((b) => this.sendPeer(b, built.bytes))]);
    // A PEER THAT NEVER GOT IT IS `unreached`, NOT `refused` - see CLOSED.
    const refused = [];
    const unreached = [];
    to.forEach((base, i) => {
      const a = theirs[i];
      if (typeof a === 'string') { (a.startsWith(CLOSED) ? unreached : refused).push(`${base}: ${a}`); return; }
      try { this.readReceipt(a, built.id); } catch (e) { refused.push(`${base}: ${e.message}`); }
    });
    let receipt = null;
    if (typeof answer === 'string')
      (answer.startsWith(CLOSED) ? unreached : refused).unshift(`${this.base}: ${answer}`);
    // THIS CLIENT'S OWN NODE'S RECEIPT IS CHECKED AS A PEER'S IS: one that fails the check is a refusal named
    // by its node, not an exception that loses the whole mark - measured in the 0.0.2815 control, a throw here left the
    // mark stored at every seat and nothing on this side to say so.
    else {
      try { receipt = this.readReceipt(answer, built.id); } catch (e) { refused.unshift(`${this.base}: ${e.message}`); }
    }
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
    else if (this.witnessed(built.id) > 0) this.pendingLink = { id: built.id, bytes: built.bytes, tick, final };
    // THE FINAL MARK IS RE-OFFERED UNTIL EVERY SIGNER NODE HAS RECEIPTED IT - five of seven ends the ask, not the
    // catch-up of a signer node still behind on its inputs - or the page leaves, or the settlement is combined.
    if (final && this.witnessed(built.id) > 0) {
      this.finalLink = { id: built.id, bytes: built.bytes, tick, final: true };
      if (this.witnessed(built.id) < this.nodes.length) this.#catchUpFinal();
    }
    return { ...built, answer: receipt ? 'receipted' : answer, receipt, refused, unreached, live, sentTo: to.length + 1 };
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
  async recoverReceipts({ roundId, entryId }, base = this.base) {
    const r = await readWithOneRetry(fetch,
      `${base}/receipts?round=${toHex(roundId)}&entry=${toHex(entryId)}`);
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
  async batch(ticks, { roundId, entryId, liquidations = [], loads = [], samples = [], tapes = [], attests = [] }) {
    const b = {
      roundId, entryId,
      previousHash: this.batchHead,
      firstTick: this.nextTick,
      ticks,
      liquidations,
      loads,
      samples,
      tapes,
      ...(attests.length ? { attests } : {}),
    };
    // SIGNED BY THE SESSION KEY, as every mark is (kanban #1503, feedback #012): a seat takes no unsigned batch, so
    // nobody who only knows this entry's public id can write ticks or a load into it. The same signed frame goes to
    // every peer below.
    const bytes = await signBatch(b, this.sign);
    // KEPT BEFORE IT GOES OUT (kanban #1567): a batch the node took whose answer was lost is still this client's own
    this.signedFrames.set(toHex(batchId(b)), bytes);
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

  // NO `invoice()` AND NO `payStake()` (§23.6, RULED 2026-09-22 22:59). They quoted a joined player the
  // hold invoice their entry named and paid it through the wallet - the withdrawn Lightning custody's stake-in, gone with it.
  // A lock round's stake is locked in the federation by `page-lock.js`, and the page already refused
  // to reach either of these for a lock round or a free one, which is every round that can exist now.

  /**
   * PAY THE ENTRY'S DONATION TO THE SET, SHARE BY SHARE. Takes an entry and a
   * set; there is no argument an invoice could arrive in.
   *
   * ONCE PER PLAYER PER ROUND, ACROSS A RELOAD, when handed the tab's
   * `storage`: every share is noted there before the wallet is asked, and a
   * share already noted is never asked again - a reload over a kept lock
   * reports what was paid and left unpaid, and sends nothing.
   */
  async payDonation(entry, set, { round, connection, curve, fetcher = (u) => fetch(u), log, random, storage, payWith = null, ...options } = {}) {
    const none = { paid: [], failed: [], unknown: [], paidMsat: 0n, asked: 0 };
    if (!entry || typeof entry.donationMsat !== 'bigint') return { ok: false, ...none, why: 'there is no entry whose donation to pay' };
    if (entry.donationMsat === 0n) return { ok: true, ...none, why: 'this entry donates nothing, so nothing is paid' };
    // A SET OF KEYS IS PAID IN THE LOCK TRANSACTION, not here (2026-10-03, FEDERATION.md): nothing to send over Lightning
    if (set && donationSetPaysKeys(set.recipients))
      return { ok: true, ...none, paidMsat: entry.donationMsat, inLock: true, why: 'paid in the federation, in the same transaction as the stake' };
    // NOT BEFORE THE SIGNER NODES HOLD THE STAKE (M3.2 6e, §22A): the donation is part of
    // one wallet commitment, counted over financially activated entries only.
    // Measured before: a joined entry whose stake nobody had seen paid 2000 msat
    // to the recipients - a player who never paid the stake had donated anyway.
    // `stakeCommitted` is the settlement signer nodes' own count (`watchStake`), not
    // this page's memory of having paid.
    if (this.stakeCommitted !== true)
      return { ok: false, ...none, why: 'the stake is not in yet: no signer node has counted it, so no donation leaves the wallet' };
    if (!set || !Array.isArray(set.recipients)) return { ok: false, ...none, why: 'there is no donation set to pay' };
    if (round) {
      const named = donationSetMatchesRound(round, set.recipients);
      if (!named.ok) return { ok: false, ...none, why: named.why };
    }
    // THE PLAYER WALLET PAYS IT (2026-10-01: "donation is paid by the player as well"): `payWith(invoice)` -
    // the federation player wallet's own send - in place of a wallet connection; each share's invoice is still the
    // recipient's own, checked against its pay request, as below.
    const where = payWith ? { ok: true } : (typeof connection === 'string' ? parseConnection(connection) : connection);
    if (!where || !where.ok) return { ok: false, ...none, why: (where && where.why) || 'there is no wallet connection to pay the donation with' };
    if (!payWith && (!curve || typeof curve.ecdhShared !== 'function' || typeof curve.signSchnorr !== 'function'))
      return { ok: false, ...none, why: 'talking to a wallet needs a curve, and none was injected' };
    const split = splitDonation({ donationMsat: entry.donationMsat, recipients: set.recipients });
    if (!split.owed) return { ok: false, ...none, why: split.why };
    const network = round && donationKeysForNetworkId(round.networkId) ? donationKeysForNetworkId(round.networkId).network : null;
    const comment = entry.playerPubkey instanceof Uint8Array ? toHex(entry.playerPubkey) : '';
    const whose = storage ? { roundId: entry.roundId || (this.where && this.where.roundId), playerPubkey: entry.playerPubkey } : null;
    if (whose && !(whose.roundId instanceof Uint8Array && whose.roundId.length === 32
      && whose.playerPubkey instanceof Uint8Array && whose.playerPubkey.length === 32))
      return { ok: false, ...none, why: 'the entry names no round and player to keep the donation\'s record under' };
    const noted = whose ? donationPaidRecord(storage, whose) : null;

    const paid = [];
    const failed = [];
    const unknown = [];
    let kept = 0;
    for (const share of split.shares) {
      if (share.amountMsat === 0n) continue;
      // ALREADY NOTED: paid, unpaid, or asked when the tab went away. Never asked again.
      const before = noted && noted.shares[share.lnurl];
      if (before) {
        kept++;
        const at = { lnurl: share.lnurl, amountMsat: BigInt(before.amountMsat), kept: true };
        if (before.state === 'paid') paid.push({ ...at, url: before.url });
        else if (before.state === 'unpaid') failed.push({ ...at, why: before.why });
        else unknown.push({ ...at, why: 'this tab asked its wallet for it before a reload and never heard the answer, so it is not asked again' });
        continue;
      }
      const note = (n) => (whose ? noteDonationShare(storage, whose, share.lnurl, { amountMsat: share.amountMsat, ...n }) : true);
      const unpaid = (why) => { failed.push({ lnurl: share.lnurl, amountMsat: share.amountMsat, why }); note({ state: 'unpaid', why }); };
      let url;
      try { url = urlOfLnurl(share.lnurl); } catch (e) { unpaid(`that recipient is no LNURL: ${e.message}`); continue; }
      let asks;
      try { asks = payRequestStands(await (await fetcher(url)).json(), share.amountMsat); }
      catch (e) { unpaid(`the recipient's endpoint did not answer: ${e.message}`); continue; }
      if (!asks.ok) { unpaid(asks.why); continue; }
      let answer;
      try { answer = await (await fetcher(callbackFor({ callback: asks.callback, amountMsat: share.amountMsat, comment, commentAllowed: asks.commentAllowed }))).json(); }
      catch (e) { unpaid(`the recipient's callback did not answer: ${e.message}`); continue; }
      if (answer && answer.status === 'ERROR') { unpaid(`the recipient refused: ${String(answer.reason || '').slice(0, 120)}`); continue; }
      const fits = invoiceAnswersPayRequest({ invoice: answer && answer.pr, amountMsat: share.amountMsat, metadata: asks.metadata, network });
      if (!fits.ok) { unpaid(fits.why); continue; }
      // NOTED BEFORE THE WALLET IS ASKED: a tab that cannot keep the note does
      // not ask, because a reload would ask again.
      if (!note({ state: 'asked' })) { unpaid('this tab could not keep a record of the payment, so the wallet is not asked - a reload would ask it again'); continue; }
      let wallet;
      if (payWith) { try { wallet = await payWith(answer.pr); } catch (e) { wallet = { ok: false, why: String((e && e.message) || e) }; } }
      else wallet = await payInvoice(where, answer.pr, {
        curve, random: random || ((n) => crypto.getRandomValues(new Uint8Array(n))), ...options,
      });
      if (!wallet.ok) { unpaid(`the wallet did not pay it: ${wallet.why}`); continue; }
      paid.push({ lnurl: share.lnurl, url, amountMsat: share.amountMsat, paymentHash: fits.paymentHash, preimage: wallet.preimage });
      note({ state: 'paid', url });
      if (log && typeof log.record === 'function') log.record({ amountMsat: share.amountMsat, paymentHash: fits.paymentHash, roundId: entry.roundId || (this.where && this.where.roundId), kind: 'donation' });
    }
    const after = donationAfterFailures({ shares: split.shares.filter((s) => s.amountMsat > 0n), failed: failed.map((f) => f.lnurl) });
    const sum = (list) => list.reduce((t, p) => t + p.amountMsat, 0n);
    return { ok: failed.length === 0 && unknown.length === 0, paid, failed, unknown, paidMsat: sum(paid),
      unpaidMsat: after.unpaidMsat, unknownMsat: sum(unknown), kept, asked: paid.length - paid.filter((p) => p.kept).length,
      why: unknown.length ? `${unknown.length} share(s) asked of the wallet before a reload, outcome unknown; ${after.why}` : after.why };
  }

  /**
   * COUNT THE SETTLEMENT SIGNER NODES THAT HAVE SEEN THIS STAKE HELD, until enough
   * have (23.1 step 5). Asked lightly - once every `everyMs` - and stopped the
   * moment N >= T, or when the run ends or this client closes.
   *
   * THE COUNT IS A LABEL AND NOTHING WAITS ON IT. The player drives the whole
   * time: ticks a node has not seen the stake for are held and sent once it
   * has (the late-payer path), and every node refuses its own receipt until it
   * has seen the hold. `stakeCommitted` says what the committee has seen; it
   * does not decide what the player may do.
   */
  //
  // ONE WATCH AT A TIME. The page starts it from the signer node and again after a
  // payment; a second start returns the watch already running rather than
  // polling every signer node twice.
  watchStake({ signerNodes, nodes, contract, everyMs = 2000, settlementEveryMs = 5000, fetcher } = {}) {
    if (this.stakeWatch) return this.stakeWatch;
    // A COUNT THAT IS OVER STAYS OVER. Committed, the run ended, or this client
    // closed: the last count is handed back and no node is asked. The chip
    // paints every 500 ms, and this is what stops it restarting a finished
    // count - a rule here, where the suite runs it, not only in index.html.
    // Measured before: a second call after committed polled every signer node again.
    if (this.stakeCommitted || this.ended || this.stakeWatchStopped)
      return Promise.resolve(this.stakeCount);
    const eid = (this.where && this.where.entryId) || (this.joinedEntry && entryId(this.joinedEntry));
    if (!eid) return Promise.reject(new Error('there is no entry to count: join first'));
    this.stakeWatch = (async () => {
      for (;;) {
        const s = await stakeSeenBy({ entryId: eid, signerNodes, nodes, contract, ...(fetcher ? { fetcher } : {}) });
        this.stakePolls++;
        this.stakeCount = s;
        this.stakeCommitted = s.committed;
        // COMMITTED IS WHERE THE NEXT WAIT BEGINS: the run, the close, the
        // objection window, the settle. The signer nodes are asked about that now.
        if (s.committed && !this.stakeWatchStopped)
          this.watchSettlement({ signerNodes, nodes, everyMs: settlementEveryMs, ...(fetcher ? { fetcher } : {}) })
            .catch(() => { /* a stake with no signer node to ask has nothing to say */ });
        if (s.committed || this.ended || this.stakeWatchStopped) return s;
        await new Promise((r) => setTimeout(r, everyMs));
        if (this.ended || this.stakeWatchStopped) return this.stakeCount;
      }
    })().finally(() => { this.stakeWatch = null; });
    return this.stakeWatch;
  }

  /**
   * WHERE THIS ENTRY'S STAKE STANDS, asked of every settlement signer node (MF item
   * 14): "the player is waiting on other people's machines and must be told
   * so, with the refund path visible the whole time". Started once the stake
   * is committed, asked every `everyMs`, and stopped when every signer node that
   * answers has moved the hold (settled, handed back, expired) or this client
   * closes. The answer rides on `stakeCount`, which is what the page already
   * hands the chip, so the chip says it with no new wiring.
   */
  watchSettlement({ signerNodes, nodes, everyMs = 5000, fetcher } = {}) {
    if (this.settlementWatch) return this.settlementWatch;
    if (this.settlementOver || this.stakeWatchStopped) return Promise.resolve(this.settlement);
    const eid = (this.where && this.where.entryId) || (this.joinedEntry && entryId(this.joinedEntry));
    if (!eid) return Promise.reject(new Error('there is no entry to ask about: join first'));
    this.settlementWatch = (async () => {
      for (;;) {
        const s = await settlementBy({ entryId: eid, signerNodes, nodes, ...(fetcher ? { fetcher } : {}) });
        this.settlementPolls++;
        this.settlement = s;
        this.stakeCount = { ...(this.stakeCount || {}), settlement: s };
        if (settlementDecided(s)) { this.settlementOver = true; return s; }
        if (this.stakeWatchStopped) return s;
        await new Promise((r) => setTimeout(r, everyMs));
        if (this.stakeWatchStopped) return this.settlement;
      }
    })().finally(() => { this.settlementWatch = null; });
    return this.settlementWatch;
  }

  /**
   * HAS THE NODE SEEN THIS ENTRY'S STAKE HELD? `GET /stake` (23.1 step 5).
   * An answer, never a throw: `{ ok, state, paidMsat }` or `{ ok: false, why }`.
   */
  async stakeSeen(eid) {
    try {
      const r = await readWithOneRetry(fetch, `${this.base}/stake?entry=${toHex(eid)}`);
      const body = await r.text();
      if (!r.ok) return { ok: false, status: r.status, why: body.trim() };
      const said = JSON.parse(body);
      return { ok: true, state: said.state, paidMsat: BigInt(said.paidMsat) };
    } catch (e) {
      return { ok: false, why: `the node would not say whether it saw the stake: ${e.message}` };
    }
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
    const r = await readWithOneRetry(fetch, `${this.base}/entry?id=${toHex(id)}`);
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

  /**
   * THE ROUND, BY ITS ID, CHECKED AS `entryFor` CHECKS AN ENTRY: its id is the hash of its bytes, so a
   * node that returned another round - or this one with another run length - fails the comparison.
   * What it answers is read, not trusted. (M3 R1 R3: a run's length is its round's, and a client that
   * reconnects before it was told the round still has to know it.)
   */
  async roundFor(id) {
    const r = await readWithOneRetry(fetch, `${this.base}/round?id=${toHex(id)}`);
    if (!r.ok) throw new Error(`the node has no round ${toHex(id)}: ${(await r.text()).trim()}`);
    let round;
    try { round = decodeRoundContract(new Uint8Array(await r.arrayBuffer())); }
    catch (e) { throw new Error(`that round will not decode: ${e.message}`); }
    if (toHex(roundId(round)) !== toHex(id))
      throw new Error(`the node returned round ${toHex(roundId(round))} for ${toHex(id)}, so that is not the round this player entered`);
    return round;
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

    const r = await readWithOneRetry(fetch,
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
    // AND IT ENDS WHERE ITS ROUND'S RUN ENDS: the run length off the round, fetched and hashed like the
    // entry (M3 R1 R3) - a reconnect may come before the page was told the round (setRound).
    const round = await this.roundFor(roundId);
    const belongs = transcriptBelongsToEntry(t, entry, round.blockTicks);
    if (!belongs.ok && t.batches.length)
      throw new Error(`the transcript is not this entry's run: ${belongs.why}`);

    // EVERY SERVED BATCH IS ONE THIS CLIENT SIGNED, or none of it is taken (kanban #1567, feedback #013 by Hexbox Tools).
    // Measured before: a home seat appended 120 forged ticks to its own store and refused the player's next batch; this
    // resume signed the forgery and fed it to the honest peer, which stored it as the player's, and the player's real
    // inputs went on 120 ticks late. Nothing served is signed here - ever.
    const frames = await this.#ownFrames(t, entry, roundId, entryId);

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
      this.samples = this.samples.filter(([at]) => at >= this.nextTick);
      this.tapes = this.tapes.filter(([at]) => at >= this.nextTick);
      this.attests = this.attests.filter(([at]) => at >= this.nextTick);
      this.batchesLandedUnheard++;
    }
    // AND THE PEERS ARE FED WHAT THIS NODE TOOK, including a batch whose answer
    // was lost, in the node's own order - a peer missing one refuses the rest.
    // THE FRAMES THIS CLIENT SIGNED, as it signed them (kanban #1567) - never a fresh signature over what a seat served.
    for (let i = this.published.length; i < t.batches.length; i++) {
      const b = t.batches[i];
      this.published.push({ bytes: frames[i], through: batchTicks(b).at(-1) + 1 });
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
    const { adopted, receipts, headWithheld } = await this.carriedHead({ roundId, entryId });
    if (adopted) this.head = adopted;
    // a home seat whose list left this client's live head out (kanban #1732): the head is kept, and it is still live
    const kept = headWithheld ? this.head : adopted;

    return { ticks: ok.ticks, batches: t.batches.length, nextTick: this.nextTick,
             batchHead: this.batchHead, head: this.head, receipts, ...(headWithheld ? { headWithheld: true } : {}),
             live: kept !== null, witnessed: kept ? this.witnessed(kept) : 0, transcript: t };
  }

  /**
   * THIS CLIENT'S OWN SIGNED FRAME FOR EVERY BATCH A SEAT SERVED (kanban #1567), in the transcript's order: the frame it
   * signed and kept, or - after a reload, when it kept nothing - the seat's copy of its signature (GET /batch-signatures),
   * VERIFIED under this entry's session key. A served batch with neither is not this player's: the seat that served it
   * wrote it itself. That is a node fault, named on `nodeFault`; the run ends there (VOID, the seat's fault, never the
   * player's) and nothing of it is signed or handed to a peer.
   */
  async #ownFrames(t, entry, roundId, entryId) {
    const frames = new Array(t.batches.length);
    const missing = [];
    t.batches.forEach((b, i) => {
      const kept = this.signedFrames.get(toHex(batchId(b)));
      if (kept) frames[i] = kept; else missing.push(i);
    });
    if (!missing.length) return frames;
    let sigs = null;
    let asked = null;
    try {
      const r = await readWithOneRetry(fetch, `${this.base}/batch-signatures?round=${toHex(roundId)}&entry=${toHex(entryId)}`);
      if (r.ok) sigs = new Uint8Array(await r.arrayBuffer());
      else asked = `it answered ${r.status} for the batches' signatures`;
    } catch (e) { asked = `it would not hand over the batches' signatures: ${e.message}`; }
    const W = SIGNED_BATCH_SIGNATURE_BYTES;
    for (const i of missing) {
      const b = t.batches[i];
      const id = batchId(b);
      const sig = sigs && sigs.length >= (i + 1) * W ? sigs.slice(i * W, (i + 1) * W) : null;
      if (sig && sig.some((x) => x !== 0) && await this.verifySession(sig, id, entry.sessionPubkey)) {
        frames[i] = joinSignedBatch(encodeInputBatch(b), sig);
        this.signedFrames.set(toHex(id), frames[i]);
        continue;
      }
      const ticks = batchTicks(b);
      const why = `the node at ${this.base} serves a batch at ticks ${b.firstTick}..${ticks.length ? ticks.at(-1) : b.firstTick} `
        + `as this entry's that this client never signed (${sig ? 'its signature does not verify under the session key' : (asked || 'no signature beside it')}) `
        + '- it is not signed or published again, and that node is not trusted with this run';
      this.nodeFault = { base: this.base, firstTick: b.firstTick, batch: i, why };
      this.endRun(`node fault: ${why}`);
      throw Object.assign(new Error(why), { nodeFault: true });
    }
    return frames;
  }

  /**
   * THE NEWEST MARK THE COMMITTEE CARRIES, READ BACK FROM THE NODES: this node's marks, newest first, and the first one
   * that five distinct committee keys have receipted - the receipts recovered from this node and from every peer, each
   * verified. Used by `resume` after a drop or a reload, and by `markNow` when a mark was neither carried nor pending
   *. Moves nothing itself; answers `{ adopted, receipts }`.
   */
  async carriedHead({ roundId, entryId }) {
    const marks = await this.recoverReceipts({ roundId, entryId });
    // AND EACH COMMITTEE PEER'S OWN RECEIPTS (2026-10-03, the reload in a running round): every node receipts a
    // mark to the client that sent it, so after a RELOAD the newest mark's receipts were in the closed tab - measured on
    // 0.0.2493, all 7 seats held mark 120 with one receipt each (their own), this node's /receipts showed 1, the resume
    // adopted mark 60 and every later mark was refused "does not follow the chain head". Each peer's receipts are
    // verified one by one exactly as this node's, so the 5-of-7 rule is the same; a peer that does not answer adds none.
    const fromPeers = await Promise.all((this.peers || []).map((base) =>
      this.recoverReceipts({ roundId, entryId }, base).catch(() => [])));
    for (const more of fromPeers) marks.push(...more);
    const c = await readWithOneRetry(fetch,
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
    //
    // AND NEVER BEHIND A HEAD THIS CLIENT ALREADY HOLDS AS LIVE (kanban #1732). The list is one seat's word: a home seat
    // that leaves its newest carried marks out of /checkpoints made the walk adopt an older live mark, and the next mark
    // the player signed was a second child of a parent that already had a carried child - "two chains from one parent",
    // which every honest seat signs FORFEIT. So when this client's own head is live (its own verified witnesses), the
    // walk stops AT that head: only a mark served after it may be adopted, and a list that leaves the live head out
    // moves nothing (`headWithheld`) - the head stays where this client can prove it belongs.
    // IN TICK ORDER, NOT THE LIST'S (feedback #032): the walk below picks the newest live mark and the #1732 floor is a place in
    // this list, so a home seat that served every mark newest first ([M1, M0]) - omitting nothing, forging nothing - made the walk
    // land on M0 and the next mark a second child of it (FORFEIT). The marks are put in order by their own ticks here, and only
    // this round's and this entry's count; a list with two marks at one tick is not one chain, and is taken in its own order.
    const listed = [];
    for (let at = 0; at < cb.length; at += SIGNED_CHECKPOINT_BYTES) {
      const m = decodeCheckpoint(splitSigned(cb.subarray(at, at + SIGNED_CHECKPOINT_BYTES)).body);
      if (toHex(m.roundId) !== toHex(roundId) || toHex(m.entryId) !== toHex(entryId)) continue;
      listed.push({ id: checkpointId(m), tick: m.tick, at });
    }
    listed.sort((x, y) => x.tick - y.tick || x.at - y.at);
    const ids = listed.map((x) => x.id);
    const headHex = toHex(this.head);
    const headLive = headHex !== toHex(NO_PREVIOUS) && this.live(this.head);
    let floor = 0;
    if (headLive) {
      floor = ids.findIndex((id) => toHex(id) === headHex);
      if (floor < 0) return { adopted: null, receipts: marks.length, headWithheld: true };
    }
    let adopted = null;
    for (let i = ids.length - 1; i >= floor; i--) {
      if (this.live(ids[i])) { adopted = ids[i]; break; }
    }
    // AND AFTER A RELOAD TOO (feedback #020, kanban #1732): a reloaded tab has no head of its own, so the floor above is
    // not there, and a home seat that left its newest carried mark out of the list made the fresh client adopt an older
    // live mark and sign a second child of it - FORFEIT. AND NOT ONLY A LIVE ONE (feedback #027): the home seat that also
    // withholds its own receipt leaves that mark short of live, yet it is still this player's signed mark, and a child of
    // its parent is still a fork. So after a reload every committee peer's list is read too, each mark checked against
    // this entry's session key (a seat cannot write one), and the head is never behind the newest signed mark any list
    // holds: it becomes that mark. A mark some committee member receipted that no list holds cannot be placed: the run
    // ends as the home seat's fault (VOID), never a mark signed on a guess.
    if (!headLive) {
      const listed = new Set(ids.map(toHex));
      const ticks = new Map(ids.map((id, k) => [toHex(id), null]));
      let entry = null;
      try { entry = await this.entryFor(entryId); } catch { entry = null; }
      const withheld = new Set();   // signed marks a peer lists and the home list leaves out
      const readList = async (base, home) => {
        const r = await readWithOneRetry(fetch, `${base}/checkpoints?round=${toHex(roundId)}&entry=${toHex(entryId)}`);
        const b = new Uint8Array(await r.arrayBuffer());
        if (!r.ok || b.length % SIGNED_CHECKPOINT_BYTES !== 0) return;
        for (let at = 0; at < b.length; at += SIGNED_CHECKPOINT_BYTES) {
          const { body, signature } = splitSigned(b.subarray(at, at + SIGNED_CHECKPOINT_BYTES));
          const m = decodeCheckpoint(body);
          const id = checkpointId(m);
          if (!entry || !(await this.verifySession(signature, id, entry.sessionPubkey))) continue;   // not this player's
          ticks.set(toHex(id), m.tick);
          if (!home && !listed.has(toHex(id))) withheld.add(toHex(id));
        }
      };
      await readList(this.base, true).catch(() => {});
      await Promise.all((this.peers || []).map((base) => readList(base, false).catch(() => {})));
      // NO RUN ENDS ON RECEIPTS ALONE (feedback #029, #030): a receipt names a checkpoint id and nothing else - no round, no
      // entry, no proof the mark is this player's - and every seat serves its receipts to anyone, so one seat could add receipts
      // over random bytes (#029) or GENUINE ones of another entry's carried mark (#030) and end every reloaded run on the honest
      // home seat's name. A receipted id that no list holds as a mark under this entry's session key is not this player's to
      // place: it is ignored. A withheld mark of this player is caught by the signed peer lists above (#027), which need no receipt.
      const at = (id) => ticks.get(id) ?? -1;
      let newest = null;
      // AND AFTER EVERY RELOAD (feedback #033): one seat that leaves only its OWN receipt for the newest mark out of /receipts kept
      // it under the live threshold - every list complete and in order, nothing withheld - and the walk took the older live mark,
      // whose next child forks the carried one (FORFEIT). A reloaded client takes the newest mark signed under its session key that
      // any list holds, live or not: a child of an older parent is a fork either way, and the lists show the committee holds it.
      if (withheld.size || this.reloading) for (const [id, tick] of ticks) if (tick !== null && (newest === null || tick > at(newest))) newest = id;
      const now = adopted ? toHex(adopted) : null;
      if (newest !== null && newest !== now && at(newest) > (now ? at(now) : -1)) adopted = fromHex(newest);
    }
    return { adopted, receipts: marks.length };
  }

  /**
   * A RUN TAKEN BACK AFTER THE TAB WAS RELOADED (2026-10-03: "a reload after the round has started ... That run
   * must not be lost"). The same entry and session key (the page kept both); this client is new and knows nothing of the
   * run, so it is told the round and then resumes from what the node holds - its input chain, its next tick and the newest
   * mark five committee members carried. NOTHING IS RECORDED UNTIL THAT IS DONE: the game ticks through the fetches, and a
   * tick recorded at this client's 0 would be published as the input of a tick the node already holds. The caller steps
   * its core through the returned transcript (`catchUpCore`) before it records again.
   */
  async resumeAfterReload({ roundId, entryId, blockTicks }) {
    this.setRound({ roundId, entryId, blockTicks });
    const where = this.where;
    this.where = null;
    this.reloading = true;   // carriedHead: a reload never falls behind the newest signed mark (feedback #033)
    try { return await this.resume(where); } finally { this.where = where; this.reloading = false; }
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
    // ANOTHER ENTRY'S RUN STARTS WITH NONE OF THIS ONE'S FRAMES (kanban #1567); the same entry again keeps them
    if (this.signedEntry !== toHex(entryId)) { this.signedFrames = new Map(); this.signedEntry = toHex(entryId); }
    this.nodeFault = null;
    this.where = { roundId, entryId };
    // A LATE ENTRY'S FIRST TICK IS ITS JOIN TICK: the round's tick it joined at, so its run ends with the round's.
    // An entry at tick 0 starts where it always did.
    const joinTick = this.joinedEntry && Number.isInteger(this.joinedEntry.joinTick) ? this.joinedEntry.joinTick : 0;
    if (joinTick > 0) this.nextTick = joinTick;
    this.maxHold = blockTicks | 0;
    this.chunk = Math.min(600, this.maxHold || 600);
    this.hold = [];
    this.held = 0;
    this.loads = [];
    this.samples = [];
    this.tapes = [];
    this.attests = [];
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
    for (const w of this.inputWaiters) { clearTimeout(w.timer); clearInterval(w.quorum); }
    this.inputWaiters = [];
    this.marksWaited = 0;
    this.markWaiting = null;
    this.marksTimedOut = 0;
    this.marksTimedOutWhy = null;
    this.pendingLink = null;
    this.marksRelinked = 0;
    this.marksHeadRecovered = 0;
    this.publishing = null;
    this.marking = null;
    // FROM THE JOIN TICK TOO (measured live on 0.0.2727, round f9857c83: a late entry at tick 1750 VOIDed on its first
    // batch - "2 ticks offered but 1750 published and 2 held" - because nextTick began at the join tick and this at 0).
    this.offered = joinTick;
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
   * THE CORE SAID THE RUN IS OVER, AND THE RUN STOPS THERE (2026-09-15 16:14).
   *
   * Measured before this, replaying every run a signer node held: each truck that drove into
   * the miner's mouth was DELIVERED in the core and signed so 2 of 2 - and its page went on
   * recording 620 to 5319 more ticks (10-89 s), the truck parked at the tunnel's back wall, the
   * HUD still counting metres to the drop-off, the round never over for the player.
   *
   * NOTHING HERE DECIDES THAT. The caller hands over the core's own word and the state hash at
   * the tick it said it; this stops taking ticks, puts every tick it holds on the wire, sends the
   * last checkpoint at that tick, and closes. Nothing is sent after. The word is FINISHED, not
   * the outcome: what the run came to is the replay's to say, from the ticks that went out.
   */
  finish({ stateHash = null, tick = 0, why = 'the core ended the run' } = {}) {
    if (this.ended) return Promise.resolve(null);
    if (this.finishing) return this.finishing;
    this.finishWhy = why;
    this.finishing = (async () => {
      const deadline = Date.now() + FINISH_WAIT_MS;
      while (!this.ended && (this.hold.length || this.publishing) && Date.now() < deadline) {
        const p = this.drain();
        if (p && p.then) { try { await p; } catch { /* the drain names its own fault */ } }
        else await new Promise((r) => setTimeout(r, 25));
      }
      await this.awaitPublishes();
      let mark = null;
      // THE RUN'S FINAL MARK (ruled 2026-09-23): sent to the nodes that already hold its inputs, not held for every
      // peer - it has no successor, so no second child of its parent can follow it. See `markNow` and `#catchUpFinal`.
      if (!this.ended && stateHash) { try { mark = await this.markNow(stateHash, tick, GENESIS, { final: true }); } catch { mark = null; } }
      const unsent = this.hold.length;
      if (!this.ended) {
        this.ended = true;
        this.ending = 'FINISHED';
        this.endingReason = unsent ? `${why}; ${unsent} tick(s) could not be sent` : why;
        this.state = 'ended';
        if (this.onEnd) this.onEnd(this.ending, this.endingReason);
        // AND THE SOCKET STAYS UP, FOR WATCHING (2026-09-18 19:30: "spectate after a round: no action in the
        // world, as if no longer connected to the nodes").
        //
        // This used to close here, and it is the only connection a page has: a player who pressed SPECTATE after
        // their run saw a world with nothing in it, because every other truck reaches them over this socket. Nothing
        // is SENT after a run ends - `ended` refuses every record, drain and mark above - so keeping the line open
        // cannot publish a tick past the end, which is what the closing was for. The page closes it itself when it
        // leaves the round: `close()`, which the bridge calls when another round is joined.
      }
      return { unsent, mark };
    })();
    return this.finishing;
  }

  /**
   * WHETHER THE RUN IS OVER FOR THE GAME: ended, or the core's word taken and the last of it on its
   * way (`finish`). Measured live on the Daily (0.0.1334): the lobby came back 2241 ms after the
   * core said DELIVERED, because the game was told only once the final publish had landed - the
   * held batches and the last checkpoint, one round trip each through the tunnels at 450-500 ms.
   * Nothing is recorded from the moment of the word, so the game is told then; the wire finishes
   * on its own, and `ended` still says when it has.
   */
  get over() { return this.ended || !!this.finishing; }

  /**
   * THE CORE'S WORD FOR THIS RUN, handed over after every tick: the state word (the core's own
   * RUN_* value) and the hash at that tick. On DELIVERED the run finishes; anything else is left
   * alone. Nothing is worked out here - the word is read, not computed.
   *
   * ONLY FOR A RUN THIS CLIENT HAS BEEN TOLD IT IS PLAYING (`setRound`, the same step that puts the
   * page's core into the round's world). Measured live (0.0.1342, the second PLAY in one tab): the
   * page had the new client a few seconds before the core entered the new round, the bridge read the
   * old core - still DELIVERED from the first run - and finished the new run at tick 1.
   */
  coreWord({ state, stateHash = null, tick = 0 } = {}) {
    if (!this.where || this.ended || this.finishing) return null;
    // DELIVERED, WRECKED AND MISSED ALL LATCH IN THE CORE (2026-09-15: "end the run here too,
    // same client path") - a run that has an outcome is over, whichever it is.
    const word = RUN_ENDING_WORDS[state | 0];
    if (!word) return null;
    return this.finish({ stateHash, tick, why: `the core said ${word} at tick ${tick}` });
  }

  /** The ending, as the game reads it: FINISHING while the last of the run goes out, then the word it ended with. */
  endingLine() {
    if (this.ended) return `${this.ending} ${this.endingReason || ''}`.trim();
    if (this.finishing) return `FINISHING ${this.finishWhy || ''}`.trim();
    return '';
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
  submitLoad(feeSats, btcHundredths, roomUsed) {
    if (this.ended || !this.where) return false;
    // AND THE ROOM THE BED TAKES when the page has one (2026-10-04 08:54: the cargo factor C is the bed fill), so
    // the signer nodes' replay sets the same C; a load without one crosses as before
    const room = roomUsed === undefined || roomUsed === null ? [] : [roomUsed | 0];
    this.loads.push([this.offered, feeSats | 0, btcHundredths | 0, ...room]);
    return true;
  }

  /**
   * A LIVE PRICE SAMPLE the page handed its core before the tick it is about to record (2026-09-17 16:01: the chart
   * was frozen because nothing ever did). It moves the tape, so it goes into the transcript beside that tick, published
   * with the batch that covers it, exactly as a load is. Refused once the run has ended.
   */
  submitSample(price) {
    if (this.ended || !this.where) return false;
    this.samples.push([this.offered, price | 0]);
    return true;
  }

  /**
   * THE COMMITTEE'S PRICE (§11): a sample the seats signed for `tick`, in cents, with their signatures
   * ([key, sig]). It must be applied at exactly that tick - the run is at it now (`offered`) - and goes into the transcript
   * in the tape's unit beside its attestation, which every seat checks. Refused at any other tick, or once the run ended.
   */
  submitAttestedSample({ tick, priceCents, sigs, readings }) {
    if (this.ended || !this.where || tick !== this.offered) return false;
    this.samples.push([tick, centsToTapeUnits(priceCents)]);
    // PROTOCOL 5: the median and the seats' own signed readings it is the median of ([key, cents, sig]), kind 2
    this.attests.push(readings ? [tick, 2, priceCents, readings] : [tick, 0, priceCents, sigs]);
    return true;
  }

  /** THE COMMITTEE'S TAPE: the 64 signed prices before the start, in cents, with their signatures - at tick `tick`. */
  submitAttestedTape({ tick, prices, sigs, readings }) {
    if (this.ended || !this.where || tick !== this.offered || !prices || prices.length !== 64) return false;
    this.tapes.push([tick, ...prices.map(centsToTapeUnits)]);
    // protocol 5: the per-position medians and the seats' own signed tapes ([key, prices, sig]), kind 3
    this.attests.push(readings ? [tick, 3, prices.slice(), readings] : [tick, 1, prices.slice(), sigs]);
    return true;
  }

  /** THE LIVE TAPE the page handed its core (64 prices, oldest first), published with the batch covering its tick. */
  submitTape(prices) {
    if (this.ended || !this.where || !prices || prices.length !== 64) return false;
    this.tapes.push([this.offered, ...Array.from(prices, (p) => p | 0)]);
    return true;
  }

  /**
   * WHETHER THIS RUN HAS REACHED ITS LAST TICK - the signer node's own line,
   * `lastTickOfRun(joinTick)`, and not a number of this file's. The game keeps
   * stepping after a run ends; those ticks are not inputs of the run, and a
   * batch that carries them is refused whole by every signer node. Measured live
   * (round 5, an idle page): recorded to 9113 of a run ending at 8999, refused
   * twice, and the run ended VOID - "inputs past the end". The page's tick loop
   * asks this before it records, drains or marks.
   */
  runOver() {
    if (!this.where || !(this.maxHold > 0)) return false;
    const join = this.joinedEntry && Number.isInteger(this.joinedEntry.joinTick) ? this.joinedEntry.joinTick : 0;
    return this.nextTick + this.hold.length > lastTickOfRun(join, this.maxHold);
  }

  record(words) {
    if (this.ended) return false;
    // AND NOT ONCE THE CORE HAS ENDED THE RUN: `finish` is putting the last of it on the wire.
    if (this.finishing) return false;

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
    // A DRAIN THAT FINDS A BATCH IN FLIGHT IS OWED, NOT DROPPED (2026-09-17 19:15: "updates only every 300-600 ms").
    // The page drains every sixth tick; a slot that found the last batch unanswered used to wait for the next slot, so
    // any link slower than 100 ms round trip halved the pictures - measured through a proxy holding 80 ms each way:
    // 5.0 pictures a second, 200 ms apart, 167 ms old on arrival. The answer now sends what is held at once.
    if (this.publishing && !this.ended) this.drainOwed = true;
    if (this.ended || this.publishing || !this.hold.length || !this.where) return this.publishing;
    this.drainOwed = false;
    // NOTHING GOES OUT WHILE THE TWO NUMBERS ARE BEING RE-READ. A batch built
    // from the old `nextTick` while `resume` is replacing it is the refusal
    // again, one tick later.
    // AND THE SAME WHILE A RECONNECT IS STILL RESUMING: its new socket is open -
    // `state` ready - before `resume` has read where the node is. Measured live
    // on the Daily (2026-09-15 12:21Z, a free round through a quick tunnel): the
    // page drained in that window, a batch went out from the pre-drop tick and
    // head, the node refused it, and the run ended at tick 180 with ticks stored
    // that the client never counted.
    if (this.recovering) return this.recovering;
    if (this.reconnecting) return this.reconnecting;

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
    const samples = this.samples.filter(([at]) => at < through);
    this.samples = this.samples.filter(([at]) => at >= through);
    const tapes = this.tapes.filter(([at]) => at < through).slice(0, 1);
    this.tapes = this.tapes.filter((t) => !tapes.includes(t));
    // the committee's word on the samples and the tape this batch carries, and on nothing else (§11)
    const attests = this.attests.filter(([at, kind]) => (kind === 0 || kind === 2 ? samples : tapes).some((x) => x[0] === at));
    this.attests = this.attests.filter((a) => !attests.includes(a));

    this.publishing = this.batch(words, { ...this.where, loads, samples, tapes, attests }).then((r) => {
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
        this.samples = samples.concat(this.samples);
        this.tapes = tapes.concat(this.tapes);
        this.attests = attests.concat(this.attests);
        if (typeof r.answer === 'string' && r.answer.startsWith(CLOSED)) {
          // THE LINK WENT WITH THE BATCH IN FLIGHT. The node refused nothing,
          // so this is not a refusal and does not resync towards VOID -
          // measured before this: two such drops, and an honest run ended
          // "VOID: the node refuses this run's inputs ... error the socket
          // closed". The words are held; the reconnect reads where the node
          // is (`resume`, which drops any the node did take) and the next
          // drain sends the rest.
          this.batchesInterrupted++;
        } else if (typeof r.answer === 'string' && r.answer.startsWith(`error ${STAKE_NOT_SEEN}`)) {
          // THE STAKE IS STILL ON ITS WAY (23.1 step 5). Measured before this:
          // a player paying at wallet speed had the first batch answered "not
          // paid", resynced, got the same again, and the run ended VOID. The
          // words are held and the next drain asks again; a stake never paid
          // ends the run when the hold is full, which is that rule's job.
          this.stakeWaits++;
          this.stakeWhy = r.answer;
        } else {
          this.refusals++;
          this.refusedWhy = typeof r.answer === 'string' ? r.answer : 'the node did not say';
          this.refusedAt = this.nextTick;
          this.#afterRefusal(r);
        }
      }
      this.publishing = null;
      // A MARK IS WAITING ON TICKS STILL HELD, OR A SLOT WAS MISSED WHILE THIS BATCH WAS IN FLIGHT: carry on draining now
      // rather than on the page's next call, so the mark goes as soon as it can and the pictures keep the page's cadence.
      if ((this.inputWaiters.length || (this.drainOwed && r.accepted)) && this.hold.length) {
        const d = this.drain();
        if (d && d.catch) d.catch(() => {});
      }
      return r;
    }).catch((e) => {
      this.hold = words.concat(this.hold);
      this.held = this.hold.length;
      this.loads = loads.concat(this.loads);
      this.samples = samples.concat(this.samples);
      this.tapes = tapes.concat(this.tapes);
      this.attests = attests.concat(this.attests);
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
  markNow(stateHash, tick, inputChainHash = GENESIS, { final = false } = {}) {
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
    // THE RUN'S FINAL MARK IS THE ONE EXCEPTION (ruled 2026-09-23): it waits only for this client's own node to hold its
    // inputs and goes to the nodes that hold them. Every other mark keeps the all-peers wait above and its timeout - it
    // exists so two marks cannot name the same parent, and a final mark has no successor to be that second child. A
    // peer that is behind is caught up afterwards, feed first, on the re-offer of this same mark (`#catchUpFinal`).
    const where = this.where;
    const holds = () => (final ? this.nextTick >= tick : this.#holdsThrough(tick));
    const ready = holds() ? true : new Promise((resolve) => {
      const w = { tick, final, resolve };
      w.timer = setTimeout(() => {
        clearInterval(w.quorum);
        this.inputWaiters = this.inputWaiters.filter((x) => x !== w);
        resolve(false);
      }, this.markWaitMs);
      if (w.timer && w.timer.unref) w.timer.unref();
      const since = Date.now();
      w.quorum = setInterval(() => {
        if (Date.now() - since < MARK_QUORUM_WAIT_MS || !this.#quorumHoldsThrough(tick)) return;
        clearInterval(w.quorum); clearTimeout(w.timer);
        this.inputWaiters = this.inputWaiters.filter((x) => x !== w);
        this.marksWithoutEvery = (this.marksWithoutEvery || 0) + 1;
        resolve(true);
      }, 250);
      if (w.quorum && w.quorum.unref) w.quorum.unref();
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
        // THE PLAYER'S OWN LINK MAY HAVE GONE WHILE THE MARK WAITED - the peers
        // are fed without it, so they can catch up and wake the mark with no
        // socket to this client's own node. Measured before this: the send
        // answered "error there is no socket", it was counted as a REFUSAL,
        // and the mark went to B alone and sat there pending. A mark that
        // cannot reach its own node is skipped and counted, the same rule as
        // when it is taken; nothing is sent to anybody.
        if (!this.sock || this.sock.readyState !== 1) {
          return {
            answer: `${CLOSED}the link to this client's own node went while the mark at tick ${tick} waited`,
            skippedNoSocket: true, refused: [], unreached: [], live: false, receipt: null,
          };
        }
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
        const r = await this.mark(stateHash, {
          roundId: where.roundId, entryId: where.entryId, tick, inputChainHash, final,
        });
        // A MARK NEITHER CARRIED NOR PENDING, AND REFUSED SOMEWHERE, MAY STILL BE THE SEATS' HEAD. Measured
        // live: all 7 seats stored and receipted a mark (testnet4 ea63aa94 @1620; the control on 0.0.2815, entry 0b68a08f,
        // @1140) while this client counted none of the answers, so it set no pending link, kept the mark before as its
        // head, and every later mark named that old parent - refused at every seat "does not follow the chain head", and
        // the rest of the run (63 s in the control) was never carried. So the head is read back from the nodes, as after a
        // drop: the newest mark five committee keys receipted (`carriedHead`) - the next mark chains onto it.
        if (!r.live && !this.pendingLink && r.refused && r.refused.length && !final) {
          try {
            const { adopted } = await this.carriedHead(where);
            if (adopted && toHex(adopted) !== toHex(this.head)) { this.head = adopted; this.marksHeadRecovered++; r.headRecovered = toHex(adopted); }
          } catch (e) { r.headRecoverFailed = e.message; }
        }
        return r;
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
      if (r.skippedForLink || r.skippedNoSocket) this.marksSkipped++;
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
      + (this.marksHeadRecovered ? ` head read back ${this.marksHeadRecovered}` : '')
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
    this.stakeWatchStopped = true;
    this.leftPage = true;              // the page left: the final mark is not re-offered any more
    if (this.sock) this.sock.close();
    for (const link of this.peerLinks.values()) if (link.sock) link.sock.close();
  }
}
