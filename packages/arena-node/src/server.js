// The node's two doors.
//
// HTTP for the things that happen once - open a round, read it, take an entry
// - and a WebSocket for the thing that happens all round: input batches, and
// the close that ends them. That split is not decoration: a batch arrives
// sixty times a second and a round opens once, and putting both through the
// same door would mean a handshake per tick.
//
// Bodies are the protocol's own bytes, not JSON of them. The contract that
// crosses the wire is the contract that is hashed, so a node cannot
// accidentally store something that encodes differently from what it was
// given. `application/octet-stream` throughout.
//
// One process, one player, no verification. There is no bond here, no quota
// and no committee; those are M2.1 steps 4 and later, and each is refused
// rather than half-built.
import { seriesWriter } from './series-writer.js';
import { isOldTestnet4Id, isOldTestnet4Series, OLD_TESTNET4_SERIES_BOND_HEIGHT } from '../../arena-protocol/src/old-series.js';
import { seriesRoundCheck, seriesId, seriesRound, ROUNDS_PER_SERIES, roundsPerSeries, isGridSeries, seriesLeadIsValid } from '../../arena-protocol/src/series.js';
import { parseSeriesLine, readSeriesLines, seriesLineOf } from './series-line.js';
import { federationGatewayCount } from '../../arena-protocol/src/gateways.js';
import { conflictedNodes, servingAfterConflicts } from '../../arena-protocol/src/operator-conflict.js';
import { receiptsNeeded as committeeThreshold } from '../../arena-protocol/src/threshold.js';
import { stateOf } from './settlement-state.js';
import { creatorSignatureStands } from '../../arena-protocol/src/creator.js';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { randomBytes, createPublicKey, verify as ecdsaVerify } from 'node:crypto';
import { displayNameFromKey } from '../../arena-protocol/src/display-name.js';
import { donationsReadMessage, DONATIONS_READ_WINDOW_MS, SECP256K1_SPKI_PREFIX } from '../../arena-protocol/src/donations-read.js';
import { WebSocketServer } from 'ws';
import { connect as netConnect } from 'node:net';
import { relayPost, relayMarks } from './relay.js';
import { CHOICE, voteMessage, encodeVote, SCHEDULES } from '../../arena-protocol/src/ballot.js';
import { createProposals } from './proposals.js';
import { createOperatorTokens, operatorUri } from './operator-tokens.js';
import { decodeRoundContract, encodeRoundContract, contractWarnings, decodeEntryContract, publicationRelaysAreValid, custodyFieldsAreValid, roundId as roundIdOf, entryFederation } from '../../arena-protocol/src/contracts.js';
import { revealStands } from '../../arena-protocol/src/head-to-head.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { lobbyListingId } from '../../arena-protocol/src/lobby-listing.js';
import { listingSigner } from './listing-sign.js';
import { decodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { roundEndMs, startDeadlineOf } from '../../arena-protocol/src/first-mark.js';
import { OBJECTION_WINDOW_MS, windowsOf } from '../../arena-protocol/src/window.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { entryFeeMsat, feeBpsOf, entryFeeBpsOf } from '../../arena-protocol/src/fee.js';
import { cancelId, BATCH_MS } from '../../arena-protocol/src/order-book.js';
import { OrderBook } from './order-batch.js';
import { PriceFeed } from './price-feed.js';
import { matchOf } from './match.js';
import { matchProofId, presenceId, PRESENCE_MS } from '../../arena-protocol/src/match.js';
import { dashboardData, dashboardHtml } from './dashboard.js';
import { createOwner } from './owner.js';
import { donationReport } from './owner-donations.js';
import { leaveStatus, takesRound } from './owner-leave.js';
import { packageOf, verifyPackage, installPackage, registrationFromPackage } from './plugin-package.js';
import { checkUpdate } from './plugin-check.js';
import { checkNetworkPackage, checkNetworkUpdate, networkPackageOf } from './network-check.js';
import { readInvite } from './invite.js';
import { federationRecords } from './federation-records.js';
import { createAbsences, readAbsenceHex, readDepartureHex } from './absences.js';
import { createLiquidations } from './liquidations.js';
import { CLOCKS as FEDERATION_CLOCKS } from '../../arena-protocol/src/federation-slash.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { lightningAddressEndpoint } from '../../arena-protocol/src/lnurl-pay.js';
import { WinningsSend, sendPlanToJson } from './winnings-send.js';
import { TYPE_CHECKPOINT, TYPE_INPUT_BATCH, STAKE_NOT_SEEN, takesAnyFederation } from '../../arena-protocol/src/constants.js';
import { splitSigned, decodeCheckpoint, checkpointId } from '../../arena-protocol/src/checkpoint.js';
import { MAX_INPUT_BATCH_BYTES, decodeInputBatch } from '../../arena-protocol/src/batch.js';
import { SIGNED_CHECKPOINT_BYTES } from '../../arena-protocol/src/checkpoint.js';
import { TYPE_CHECKPOINT_RECEIPT } from '../../arena-protocol/src/constants.js';
import { bearsAuthority } from '../../arena-protocol/src/frames.js';
import {
  decodeHandout, encodeHandout, handoutId, acceptHandout, openMyShare,
} from '../../arena-protocol/src/handout.js';
// THE GROUP THE HANDOUT CHECK NEEDS. The protocol package carries no curve on
// purpose, so the daemon brings one - the same secp256k1 it already brings to
// the census, and the same one the bonds and BIP-340 use.
import { feldmanGroup, tweakPoint } from './curve.js';
import {
  SIGNED_RECEIPT_BYTES, decodeCheckpointReceipt, splitSignedReceipt,
} from '../../arena-protocol/src/receipt.js';
import { SIGNED_RESULT_BYTES, resultId, decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';

/**
 * The largest frame this socket will accept, and it is derived rather than
 * chosen: it is the longest message the protocol can encode at all. A batch's
 * tick and liquidation vectors carry u16 lengths, so 1835087 bytes is the
 * ceiling the encoder itself sets; a signed checkpoint is 231 and a signed
 * receipt 139. Anything longer is not a large protocol message, it is not one.
 *
 * `ws` defaults to 104857600 - a hundred megabytes any stranger could ask the
 * daemon to allocate before a single byte was parsed. This is fifty-seven
 * times smaller and needs no policy number to justify.
 *
 * It is NOT tight. An honest client at the spec's 10 Hz sends six ticks, 227
 * bytes; a whole 9000-tick round is 180107. Tightening it further means
 * naming a maximum ticks per batch, which is a protocol-visible limit and a
 * decision rather than a measurement, so it is not made here.
 */
export const MAX_FRAME_BYTES = Math.max(
  MAX_INPUT_BATCH_BYTES, SIGNED_CHECKPOINT_BYTES, SIGNED_RECEIPT_BYTES);
import { CLOSED } from './store.js';
import { Round } from './round.js';
import { Verifier } from './verify.js';
import { Ghosts } from './ghosts.js';
import { gameLive } from './game-live.js';
import { readReserve } from './federation-reserve.js';
import { thresholdOf as thresholdOfFederation } from '../../arena-protocol/src/federation-record.js';
import { Roster, endpointsOf, NO_CHAIN_VIEW_WHY } from './roster.js';
import { seatingAgent } from './seating-agent.js';
import { decodeSeatingCertificate, encodeSeatingCertificate } from '../../arena-protocol/src/seating.js';
import { receiptsNeeded as roundThreshold, donationKeysForNetworkId } from '../../arena-protocol/src/genesis.js';
import { authorityAt, donationSetSignedBy, donationSetInForce, encodeDonationSetBody, encodeAuthorityRotation, donationSetBodyId, authorityRotationId } from '../../arena-protocol/src/authority.js';
import { donationSetId, donationOutputsExpected, encodeDonationSet } from '../../arena-protocol/src/donation.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { timed, watchLoop } from './slow.js';
import { resultFinality, finalSignatureNow } from './finality.js';
import { standingOf } from './standing.js';
import { outageOutcome } from '../../arena-protocol/src/entry-void.js';
import { ENTRY_VOID, netStakeMsat } from '../../arena-protocol/src/payout.js';
import { FINAL, PROVISIONALLY_FINAL, SUSPENDED } from '../../arena-protocol/src/objection.js';
import { transcriptBytesHash, SIGNED_POSTING_BYTES } from '../../arena-protocol/src/posting.js';
import { federationIsBonded } from '../../arena-protocol/src/federation.js';
import { hostedPlugins, pluginForRound, advertisedGamesCheck } from './plugins.js';
import { isHeadToHead } from '../../arena-protocol/src/manifest.js';
import { encodeManifest, decodeManifest, gameIdOf, RESULT_TYPE } from '../../arena-protocol/src/manifest.js';
import { gameTypeOf, gameInfoStands } from '../../arena-protocol/src/game-info.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { nonceGen as musigNonceGen, bondSigningContext as musigBondContext, bondPartialSign as musigBondPartial } from './musig2.js';
import { marketWindowOf, decodeAttestation, attestationStands, attestationBodyId, outcomeFinality, attestationTimely, pariMutuelTable } from '../../arena-protocol/src/attested.js';
import { verifyEd25519 } from './ed25519.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync, readdirSync, renameSync, appendFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { readTranscript } from './transcript-read.js';
import { SIGNED_RERUN_BYTES, rerunResultId, decodeRerunResult, splitSignedRerun, encodeRerunResult, joinSignedRerun } from '../../arena-protocol/src/rerun.js';
import { decodeFinalSig, splitSignedFinalSig, finalSigFault, SIGNED_FINAL_SIG_BYTES } from '../../arena-protocol/src/final-sig.js';
import { verifyStakeLock, verifyFeeLock, lockFieldsFromJson, roundMintsFees, federationTakesNoBaseFee } from './stake-lock-signer-node.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { encodeClaimKeyAttestation, claimKeyAttestationId } from '../../arena-protocol/src/claim-key.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { splitSlashEvidence, slashProofId, SLASH_EVIDENCE_BYTES, REPLAY_CONTRADICTS, splitRerunSlashEvidence, RERUN_SLASH_EVIDENCE_BYTES } from '../../arena-protocol/src/slash.js';
import { slashOwing, entriesForSlash } from './slash-owing.js';
import { StakeSecrets, encodeShareAnswer, SEALED_ANSWER_BYTES } from './stake-secret.js';
import { Dkg } from './dkg.js';
import { Forfeit } from './forfeit.js';
import { LockSettlement, locksStake, SUBMITTING } from './settlement.js';
import { decodeCommitments, encodeCommitments, encodeShare } from './pool-wire.js';

// who sits at each head-to-head round's table, per seat (POST /here): round hex -> identity key hex -> last said (ms)
const presenceByRound = new WeakMap();
const presenceTables = (round) => { let t = presenceByRound.get(round); if (!t) { t = new Map(); presenceByRound.set(round, t); } return t; };

const read = (req) => new Promise((resolve, reject) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => resolve(new Uint8Array(Buffer.concat(parts))));
  req.on('error', reject);
});

// A BROWSER IS THE CLIENT, and a browser will never be on this origin.
//
// The daemon has no cookies and no session: every write is authorised by a
// signature over a tagged hash, and every read is of things a player already
// holds. There is nothing for an origin check to protect, and without these
// headers a page cannot read a single answer - measured: a round was opened
// and the response was unreadable, so the client's own `join` failed with
// "Failed to fetch" and the round existed with nobody in it.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  // The headers a client actually reads answers out of. Without this a page
  // sees the body and none of the counts.
  'access-control-expose-headers':
    'x-state, x-ticks, x-transcript-hash, x-checkpoints, x-receipts, '
    + 'x-marks, x-dropped, x-through-tick, x-equivocations, x-ticks-at, x-no-quorum, '
    + 'x-foreign-receipts',
};

const bytes = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/octet-stream', ...CORS });
  res.end(Buffer.from(body));
};
const text = (res, code, msg) => {
  res.writeHead(code, { 'content-type': 'text/plain', ...CORS });
  res.end(msg + '\n');
};

/**
 * WHO PAYS FOR THE DISK.
 *
 * `IMPLEMENTATION.md`: "A funded entry is required before the node stores one
 * byte of transcript. Disk is spent only on stakes that exist - the main
 * anti-DoS lever." Measured before this existed: a stranger who had funded
 * nothing opened 200 rounds and the node answered 201 to every one and wrote
 * 200 rows, then took an entry in one of them for nothing as well.
 *
 * The node cannot decide funding by itself. A stake is a hold invoice on
 * Lightning, so what this daemon does is REFUSE until something it trusts
 * says otherwise - the operator supplies that, and the default is no. A daemon
 * that assumed funding would be the flood lever rather than the guard against
 * it, and a default of yes is the kind of thing nobody notices until the disk
 * is full.
 *
 * THE PAYMENT LAYER DID NOT REPLACE THIS. `funded` is still the operator's answer to "may this entry
 * cost me disk", and whether a stake is locked is a separate question answered by the federation.
 */
const hexOf = (b) => Buffer.from(b).toString('hex');

/**
 * HOW FAR BEHIND A SUBSCRIBER MAY BE BEFORE ITS PICTURES ARE DROPPED.
 *
 * A quarter of a megabyte, the same figure the client uses to decide it is too
 * far behind to publish - so both ends of one socket call "behind" the same
 * thing instead of each having a taste of its own.
 */
export const GHOST_BACKLOG_BYTES = 262144;

export const NOTHING_IS_FUNDED = () => false;

/**
 * THE OBJECTION INTAKE (13A), one function so the HTTP door and a test on a stubbed clock take the same path. The first
 * objection against a run is stored as before. A SECOND one is taken only against an agreed re-run while its own
 * objection window is open (RULED the owner 2026-09-24, slice C2b) - this node answering PROVISIONALLY_FINAL on the
 * re-run - and stored once; whether it holds is `resultFinality`'s to say. One while the run is still SUSPENDED is the
 * first objection again, and one after that window closed changes nothing: 409, nothing stored.
 */
/**
 * WHAT THE ROUND'S ONE SETTLEMENT STILL WAITS ON (slice C3a): a run PROVISIONALLY_FINAL inside its first objection
 * window. Not a SUSPENDED entry and not one PROVISIONALLY_FINAL on a re-run - those are left out and settle on their own.
 */
export const settleWaitsOn = (standing) => standing.filter((x) => x.state === PROVISIONALLY_FINAL && !x.rerun);

export function objectionIntake(round, rid, eid, blockHash = null, bundle = null, arrivedMs = null) {
  try {
    // AN OBJECTION COUNTS BY WHEN IT REACHED THIS SEAT, ON ITS OWN CLOCK (§13A, WINDOW-10-SPEC, RULED the owner 2026-10-01):
    // before this seat's window close + 5 s it suspends the run here; after, it suspends nothing and is kept as evidence.
    // A block it names is kept and decides nothing.
    if (blockHash !== null && (!(blockHash instanceof Uint8Array) || blockHash.length !== 32)) return { status: 400, text: 'a block an objection names is a 32-byte hash' };
    if (round.object(rid, eid, blockHash, bundle, arrivedMs)) return { status: 201, text: 'objected' };
    if (round.rerunObjectedAt(rid, eid) !== null) return { status: 200, text: 'already objected' };
    const f = resultFinality(round, rid, eid);
    const agreedRerun = !!(f.rerun && f.rerun.runId);
    // THE RE-RUN'S OWN WINDOW IS OVER FOR THIS SEAT at the round's end + 1805 s on its clock (§13A, WINDOW-10-SPEC).
    if (agreedRerun && f.finalAfterMs !== undefined && BigInt(arrivedMs ?? round.now()) >= BigInt(f.finalAfterMs))
      return { status: 409, text: 'the re-run\'s objection window has closed' };
    if (f.state === PROVISIONALLY_FINAL && agreedRerun)
      return round.objectRerun(rid, eid, blockHash, bundle, arrivedMs) ? { status: 201, text: 'objected' } : { status: 200, text: 'already objected' };
    if (agreedRerun) return { status: 409, text: 'the re-run\'s objection window has closed' };
    return { status: 200, text: 'already objected' };
  } catch (err) { return { status: 404, text: err.message }; }
}

/**
 * A PLAYER'S RESULT IN ONE ROUND, IN MONEY (the dashboard's rounds, the owner 2026-10-03 22:25): `result` won / lost / stake
 * back / pending / free, and `netMsat` - what the player's balance changed by (null while pending).
 */
export function playerBalance({ entry, best, won, settled, nobodyWon, minScore }) {
  if (entry.stakeMsat === 0n) return { result: 'free', netMsat: '0' };
  if (!settled || settled.state !== 'ACCEPTED' || !best) return { result: 'pending', netMsat: null };
  const costs = BigInt(entry.feeMsat || 0n) + BigInt(entry.donationMsat || 0n);
  const qualified = best.outcome === 'DELIVERED' && BigInt(best.score) >= BigInt(minScore || 0);
  if (qualified) return { result: 'won', netMsat: String(BigInt(won ? won.owedMsat : 0n) - costs) };
  if (nobodyWon && best.outcome !== 'FORFEIT') return { result: 'stake back', netMsat: String(-costs) };
  return { result: 'lost', netMsat: String(-BigInt(entry.stakeMsat)) };
}

export function serve(db, { port = 0, host = '127.0.0.1', funded = NOTHING_IS_FUNDED, seatingOn = null,
  // WSS FROM THE NODE ITSELF (spec §25.3, kanban #335: "Node software SHOULD make certificate provisioning a first-class setup
  // step"): { cert, key } PEM - the same doors and sockets over https/wss on the same port; none, plain http as ever
  tls = null,
  randomnessFor, chainFor, peers = [], headerBytes, bondProof, proposals: givenProposals = null,
  // THE BALLOT'S PROPOSALS (kanban #329): { confirmedTx(txidHex, blockHashHex), lowestBondMinSats } - main.js reads bitcoind
  ballot = null,
  // A LIGHTNING INVOICE READER, AND NOTHING MORE (§23.6, RULED 2026-09-22 22:59). `/federation-invoice`
  // uses its `decode` to read what the federation's LNv2 invoice commits to. It no longer issues, looks up,
  // settles or cancels holds, and it pays nothing: that was the withdrawn Lightning custody's custody by one operator.
  // (`preimageFor`, `preflight` and `secondsPerBlock` served only that hold, and are gone with it.)
  lightning = null,
  // WHAT THIS NODE HOSTS (hosts.js): a reader of its LND and gateway, only on a node whose environment names them; its last
  // reading goes into /dashboard.json (figures only, never the gateway's password or the LND's macaroon).
  hosts = null,
  // THIS NODE'S OWN GUARDIAN (§23A.2, RULED 2026-09-26 22:54): `{ apiPort, endpoint }` when the node started one
  // (guardian.js). Its websocket is carried on this server at /guardian, so the guardian's endpoint is the node's own
  // public address; null for a node that is not a guardian.
  guardian = null,
  // THE NODE'S OWNER (kanban #276, owner.js): `{ store }` - where the owner's public key and the claim code are kept
  // (files beside the database, from main.js). Without it the node has no owner area and /owner answers 404.
  owner: ownerFiles = null,
  // THE OPERATOR UI (§27A.7.7, kanban #332): { store, writePairing, endpoint } - scoped bearer tokens, none of which moves money
  operator: operatorFiles = null,
  // WHERE THE PLUGIN STORE KEEPS INSTALLED GAMES (kanban #276 step 5; main.js: <db>.plugins), loaded at start; installed
  // networks are kept in its networks/ directory
  pluginsDir = null,
  // THE CHAIN THIS SEAT READS, as its genesis names it ('bitcoin-regtest', 'bitcoin-testnet4'; main.js from ARENA_DONATION_NETWORK):
  // a network package for another chain is refused (network-check.js). Null: this seat takes no network package.
  chain = null,
  // THE FEDERATION INVITE THIS SEAT HANDS OUT WITH ITS NETWORK (GET /network; main.js ARENA_FEDERATION_INVITE), until an
  // installed network package names another
  federationInvite = null,
  // THE FEDERATION'S RECEIVING SIDE (V1's pool is a FEDERATION, the owner 2026-09-11): `receive({
  // amountMsat })` answers `{ request }`, an LNv2 invoice the federation's gateway holds.
  federation = null,
  // THE CURVE THE COMMITTEE'S KEY CEREMONY RUNS ON (the DKG: a round's claim key). It carries the taproot tweak.
  // The on-chain pool payout that also read it - its key, its broadcaster, its handed share - is gone with the
  // withdrawn custody (§23.6; RULED 2026-09-25): a round's winners are paid by its lock settlement.
  poolCurve = { ...feldmanGroup, tweakPoint },
  // AND SOMETHING THAT CAN ASK THE CHAIN WHICH OUTPUT HOLDS THE POOL.
  // `bitcoindRpc`'s `call`, injected the way everything else that reaches the
  // network is. Without it a close still queues the payout and stops - which
  // is exactly where item 18 found it - and says so rather than guessing at an
  // outpoint.
  // HOW LONG A CLOSED ROUND KEEPS ASKING ITS PEERS FOR THE RESULTS IT IS SHORT
  // OF (M3.3-25): every `everyMs`, until final or `windowMs` has passed -
  // the round's own objection window unless a test names another, counted
  // from the close and, while a run waits on its window, from that window's
  // end (M3.3-32).
  finality = {},
  // THE DAILY'S CLOSE (M3.3-34), OPT-IN: close each round this signer node holds by
  // its own clock once it is over (protocol roundEndMs). `true`, or
  // `{ everyMs }`. Off by default: a harness closes its rounds when it says so.
  closeAtEnd = false,
  // THE MARKET ORDER BOOK'S BATCHES (kanban #278 step 4): the interval - 0.5 s, measured to hold (order-book.js BATCH_MS) -
  // and whether this seat leads its batches on its own clock: on by default; a test that drives `orderBook.lead` turns it off
  orderBatchMs = Number(BATCH_MS), orderBatchTimer = true,
  // THE COMMITTEE'S PRICE FEED (§11, kanban #311): off by default (a harness seat reads no exchange); `true` reads Coinbase
  // every 5 s and leads/signs the attested samples of the price rounds it holds; `{ readPrice }` injects the reader
  priceFeed = false,
  // §15 AT THE DOOR (ALL-BUT-MIN-1727): how often the walk-away door is swept; on wherever the node closes its own rounds.
  doorSweepMs = closeAtEnd ? 5000 : 0,
  // THE SERIES THIS NODE WRITES AHEAD (NODE72-1131): series templates (arena-protocol/src/series.js `seriesTemplate`), each
  // round of which from now to now + 72 h is opened in this node's store and listed - again every `seriesEveryMs`.
  series = [], seriesEveryMs = 60000,
  // A SERIES ADDED WHILE RUNNING (main.js reads ARENA_SERIES_FILE again when it changes): a function that answers the whole
  // list when it changed, else null. Each series not held yet gets its writer on the next pass - no restart.
  seriesReload = null,
  // THE GRID SERIES POSTED HERE (POST /series, kanban #293), one line each (series-line.js): read at start, so a restart holds
  // them again, and appended as each is taken. Unset: a posted grid is held until the restart.
  gridSeriesFile = null,
  // THE ROUND STORE'S CLOCK, when a caller must set it before anything reads it (a series is written at start). Unset: the wall clock.
  roundClock = null,
  // THE SIGNER NODES' ADVERTISEMENTS, by round (Map node key hex -> advert), so a slash
  // proof names each accused signer node's own bond. Defaults to this node's census.
  advertsFor = null,
  // THE ROUND'S FEDERATION, as a port (23.1 step 5): `status(outpoint)` and
  // `contractId(fields)`, the stock client's answers (blwp-stake-lock). Null:
  // this node verifies no stake lock.
  stakeLocks = null,
  // HOW A WINNER'S LIGHTNING ADDRESS IS FETCHED (winnings-send.js), and the round network its invoices are for.
  lnurlFetch = (u) => fetch(u),
  winningsNetwork = 'regtest',
  // HOW OFTEN THE WINNINGS SWEEP VISITS unpaid winnings; the finality back-off unless a harness names its own.
  winningsEveryMs = null,
  // HOW THE SETTLEMENT READS A RUN'S FINALITY - `resultFinality`. A TEST AID, as `finality.rerunMs` is: two signer nodes
  // that agree on a run cannot hold a valid objection against it, so a lock round's late-loser tests hand another view.
  finalityOf = resultFinality,
  // A TEST AID, as the finality option above is (kanban #191): one more reason this node refuses to offer a round - contract -> why or null.
  // Production names none; the live reasons are the series and the donation set in force.
  refusedFor = null,
  // THE OPERATOR'S REFUSE-ROUNDS FILE (kanban #191, the owner 2026-10-06 path A): round ids, one per line, this node refuses at
  // every door from the moment the file changes - read again by its mtime, no restart. Empty in normal running.
  refuseRoundsFile = null,
  // THE CHAIN §13A'S WINDOWS ARE READ FROM (RULED the owner 2026-09-24): `(roundId, contract) => { firstHeight, blocks }`,
  // defaulting to this daemon's own `chainFor`. Given apart from `chainFor` so a harness can hand its daemons a block
  // clock without also making the verifier check its fixed beacon against that chain.
  windowChain = null,
  // THE ROUND'S CLAIM KEY, by round (33 bytes). Defaults to this signer node's own
  // DKG committee key - the key the settlement signer nodes hold for that round.
  claimKeyFor = null,
  // THE SIGNED DONATION SETS ITS OPERATOR HANDED THIS SIGNER NODE (M3.2 6e, §22A,
  // §27A.4), and any authority rotations: each checked here before it is ever
  // served. None by default: a signer node with none serves no set.
  donationSets = [], donationRotations = [],
  // THE GAMES THIS NODE HOSTS (kanban #202, §0A.4; M3 R1, the owner 08:07: several games and rule sets at once): each a
  // registration { name, manifest, gameId, cores } its launcher hands it (src/main.js hands nextblock,
  // core/plugin/nextblock.js), checked by plugins.js. None given hosts none; a round of a game this node does not host,
  // or naming a core or config it did not install for that game, is refused at the door.
  plugins = [],
  // THIS NODE'S OWN ADVERTISEMENT, decoded (kanban #204): when given, the games it names are held to the games hosted above
  // - an advertised game this node does not host refuses the start, by name (plugins.js advertisedGamesCheck).
  ownAdvert = null,
  // WHERE THIS NODE'S OWN CHAIN IS (M3.3-30): a height, asked of its own
  // bitcoind. Given none, the pool's chain call answers it when there is one.
  chainTip = null,
  expiry = {},
  // WHERE EVERY CORE A STORED ROUND NAMES IS KEPT FOR ITS REPLAY (the owner 2026-09-26 13:28: "the copied replay link must
  // keep working. Always ... Keep every core a stored round names, and serve it. Do not drop it when HEAD moves"): a
  // directory outside the checkout, <hash>.js per core (tools/archive-replay-cores.mjs fills it from history). This node
  // writes its own core there when it starts, so the next tree it runs keeps this one.
  replayCores = process.env.ARENA_REPLAY_CORES_DIR || null,
  // THE STABLE NAMES A COPIED REPLAY LINK USES (the owner 2026-09-26 13:28: a quick tunnel's name changes on every start,
  // so a link on it dies; "the button must copy the stable Funnel name ... https://seat.example.com/blwp-a or
  // /blwp-b, the path the page is published under"): the https bases of the nodes that hold these rounds, comma-separated
  // in ARENA_REPLAY_PUBLIC. /replay/nodes answers them first, as `stable`; the page copies from them when there are any.
  replayPublic = (process.env.ARENA_REPLAY_PUBLIC || '').split(',').map((u) => u.trim().replace(/\/+$/, '')).filter((u) => /^https:\/\//.test(u)) } = {}) {
  // THE GAMES THIS NODE HOSTS (kanban #202; M3 R1), made once: the round store opens only rounds of them, and the door,
  // the replay and the ghosts resolve each round's game and core through the same registry.
  const hosted = hostedPlugins(plugins);
  // THE NODE'S OPEN MUSIG2 SESSIONS (kanban #307): session id -> its message, tweak and secret nonce, each signed once
  const musigNodeSessions = new Map();
  let fedRecords = null;                       // federation-records.js (kanban #321), set once the roster and the invites are known
  // ABSENCE ATTESTATIONS (§23A.4, kanban #322): taken at POST /absence, and what proves a guardian ABANDONED in the record
  const absences = createAbsences({ verify: (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } } });
  let liquidations = null;                     // liquidations.js (kanban #323), over fedRecords
  // THE ROUNDS THIS NODE REFUSED BECAUSE IT DOES NOT HOST THEIR GAME (kanban #204), by round id, with the game: an entry
  // into one is refused by that game's name. Bounded: the oldest are forgotten past REFUSED_GAME_ROUNDS.
  const REFUSED_GAME_ROUNDS = 50000;
  const refusedGameOf = new Map();
  const rememberRefusedGame = (rid, game) => {
    refusedGameOf.set(rid, game);
    if (refusedGameOf.size > REFUSED_GAME_ROUNDS) refusedGameOf.delete(refusedGameOf.keys().next().value);
  };
  // A ROUND'S GAME AS THIS NODE HOSTS IT - { id, name } - or null for a game it does not host (kanban #204)
  const gameOfContract = (c) => {
    const p = c && c.gameId instanceof Uint8Array ? hosted.get(toHex(c.gameId)) : null;
    return p ? { id: toHex(p.gameId), name: p.name, title: p.title || p.name, icon: p.icon ? `game-icon?game=${toHex(p.gameId)}` : null } : null;
  };
  // AN ATTESTED ROUND'S OUTCOME (§0A.7a, kanban #206): what this seat holds for it - OPEN (no attestation yet), ATTESTED (one
  // outcome), DISPUTED (two standing attestations of different outcomes: the proof, and the round settles on neither) -
  // and, once ATTESTED, the pari-mutuel table the settlement seats pay from (built here from the entries' picks and the
  // outcome, no game code). null for a round of a replayed game, or of a game this node does not host.
  const attestedOf = (c) => { const f = pluginForRound(c, hosted); return f.ok && f.attested ? f.plugin : null; };
  const warningsOf = (c) => { const f = pluginForRound(c, hosted); try { return contractWarnings(c, f.ok ? f.plugin.roundWarnings : null); } catch { return []; } };
  const outcomeOf = (rid, c, { table = false } = {}) => {
    const plugin = attestedOf(c);
    if (!plugin) return null;
    const rows = round.outcomeAttestations(rid);
    const held = rows.map((r) => ({ ...decodeAttestation(new Uint8Array(r.bytes)), receivedMs: Number(r.received_ms) }));
    // FINAL 600 s AFTER THE FIRST STANDING ATTESTATION, on this seat's clock (§0A.7a slice 2)
    const standing = outcomeFinality(held, { windowMs: c.objectionWindowMs, nowMs: round.now() });
    const out = { state: standing.state, outcomes: plugin.manifest.outcomes, attestThreshold: plugin.manifest.attestThreshold,
      attestors: plugin.manifest.attestors.length, entryCloseMs: String(c.entryCloseMs) };
    if (standing.state === 'ATTESTED') {
      Object.assign(out, { outcome: standing.outcome, label: plugin.manifest.outcomes[standing.outcome],
        observedAtMs: String(held[0].observedAtMs), final: standing.final, finalAtMs: String(standing.finalAtMs),
        // the attestation's own bytes: a page checks its signatures against the manifest it pinned, not this seat's word
        attestation: toHex(new Uint8Array(rows[0].bytes)) });
      if (table) {
        // THE ENTRIES THAT COUNT: a free round's every entry; a paying round's only those whose stake this seat has seen
        const counted = round.entriesOf(rid).filter(({ entryId }) => c.stakeMsat === 0n || !!round.stakeSeen(entryId))
          .map(({ entryId, entry }) => ({ entryId, stakeMsat: entry.stakeMsat, feeMsat: entry.feeMsat, donationMsat: entry.donationMsat, pick: entry.pick }));
        const t = pariMutuelTable({ entries: counted, outcome: standing.outcome });
        out.table = JSON.parse(JSON.stringify(t, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
      }
    } else if (standing.state === 'DISPUTED') {
      Object.assign(out, { outcomesNamed: standing.outcomes, why: standing.why, proof: rows.map((r) => toHex(new Uint8Array(r.bytes))) });
    }
    return out;
  };
  // AN ATTESTED ROUND SETTLES ONCE ITS OUTCOME IS FINAL (§0A.7a slice 2): a sweep over the rounds holding an attestation and
  // no ACCEPTED settlement, every 5 s while any is waiting - each asked to settle; the settlement itself holds one that is
  // not final yet, or DISPUTED, so a round is only ever settled on a final outcome. Started by the first attestation held.
  let attestedSweep = null;
  const attestedWhy = new Map();
  const settleAttestedSoon = () => {
    if (attestedSweep || !settlements) return;
    let sweeping = false;
    attestedSweep = setInterval(async () => {
      // one sweep at a time (kanban #336): a sweep still settling is not started again on top of itself
      if (sweeping) return;
      sweeping = true;
      try {
      const ids = round.db.prepare('SELECT DISTINCT round_id FROM outcome_attestations').all().map((r) => new Uint8Array(r.round_id));
      const waiting = ids.filter((rid) => stateOf(round, rid) !== 'ACCEPTED');
      if (!waiting.length) { clearInterval(attestedSweep); attestedSweep = null; return; }
      for (const rid of waiting) {
        const got = await settlements.settle(rid).catch((e) => ({ ok: false, why: e.message }));
        if (got && got.state && got.state !== 'HELD') console.log(`[outcome] ${toHex(rid).slice(0, 16)} settlement: ${got.state} - ${got.why || ''}`);
        // WHY A FINAL ROUND IS NOT SETTLED, said once per reason (kanban #237: a paid market round final for minutes, its
        // settlement silent - the sweep logged only answers with a state, and a plan's refusal carries none)
        else if (got && !got.ok && !got.state && got.why) {
          const k = toHex(rid), was = attestedWhy.get(k);
          if (was !== got.why) { attestedWhy.set(k, got.why); console.log(`[outcome] ${k.slice(0, 16)} not settled yet: ${got.why}`); }
        }
      }
      } finally { sweeping = false; }
    }, 5000);
    if (attestedSweep.unref) attestedSweep.unref();
  };
  // A LISTING GROUPED BY GAME: each hosted game with the ids of its rounds in the listing, in listing order
  const groupedByGame = (rows) => {
    const by = new Map();
    for (const r of rows) {
      if (!r.game) continue;
      if (!by.has(r.game.id)) by.set(r.game.id, { id: r.game.id, name: r.game.name, rounds: [] });
      by.get(r.game.id).rounds.push(r.id);
    }
    return [...by.values()];
  };
  const unhostedRefusal = (contract) => {
    if (contract.gameId instanceof Uint8Array && hosted.has(toHex(contract.gameId))) return null;
    const game = contract.gameId instanceof Uint8Array ? toHex(contract.gameId) : '(none)';
    try { rememberRefusedGame(toHex(roundIdOf(contract)), game); } catch { /* a contract with no id names nothing to remember */ }
    return `this node does not host game ${game.slice(0, 16)}: it plays only the games it hosts (§0A.4) - not selectable for that round, it serves nothing there, and is not slashed`;
  };
  if (ownAdvert) {
    const games = advertisedGamesCheck(ownAdvert, hosted);
    if (!games.ok) throw new Error(games.why);
    if (games.unadvertised.length)
      console.error(`[games] hosting ${games.unadvertised.join(', ')}, which this node's advertisement does not name: not drawn for it until an advertisement update names it`);
  }
  const replayCoreFile = (hex) => (replayCores && /^[0-9a-f]{64}$/.test(hex) ? joinPath(replayCores, `${hex}.js`) : null);
  if (replayCores) {
    try {
      mkdirSync(replayCores, { recursive: true });
      // EVERY CORE IT INSTALLED, each its own game's replay bundle (kanban #202: a round's replay page is its plugin's)
      for (const p of hosted.values()) for (const [hash, core] of p.cores) {
        const own = replayCoreFile(hash);
        if (core.replayFile && !existsSync(own) && existsSync(core.replayFile)) writeFileSync(own, readFileSync(core.replayFile));
      }
    } catch (e) { console.error(`[replay] cannot keep this node's core in ${replayCores}: ${e.message}`); }
  }
  const round = new Round(db, undefined, { plugins: hosted });
  // A CHECKPOINT EQUIVOCATION THIS SEAT HOLDS FOR THE FIRST TIME GOES TO THE ROUND'S PUBLICATION RELAYS (§25.2, kanban #327): both
  // signed marks over each relay's /play, where the relay records the pair itself; unawaited, best effort
  round.onEquivocation = ({ roundId, entryId, tick, stored, offered }) => {
    let relays = [];
    try { relays = decodeRoundContract(new Uint8Array(round.get(roundId).contract)).publicationRelays || []; } catch { relays = []; }
    if (!relays.length) return;
    relayMarks(relays, [stored, offered])
      .then((r) => console.log(`[equivocation] ${toHex(entryId).slice(0, 16)} tick ${tick}: both marks relayed to ${r.sent} of ${relays.length} publication relay(s)${r.failed.length ? `; ${r.failed[0]}` : ''}`), () => {});
  };
  const operatorTokens = operatorFiles ? createOperatorTokens({ store: operatorFiles.store, log: (l) => console.log(l) }) : null;
  if (operatorTokens) { const t = operatorTokens.first(operatorFiles.endpoint); if (t && operatorFiles.writePairing) operatorFiles.writePairing(t.uri); }
  const owner = ownerFiles ? createOwner({ store: ownerFiles.store, node: toHex(round.pubkey), log: (l) => console.log(l),
    verify: (sig, msg, key) => schnorr.verify(sig, msg, key) }) : null;
  if (roundClock) round.now = roundClock;
  // THE CHAIN §13A'S WINDOWS ARE READ FROM (RULED the owner 2026-09-24): this node's own chain view - blocks at both ends of
  // every window, and the block its own postings and re-runs name. A node given no chain decides no window.
  if (windowChain) round.chainView = windowChain;
  else if (chainFor) round.chainView = (rid, contract) => chainFor({ contract, roundIdBytes: rid });

  // THE PLUGIN STORE ON THIS SEAT (kanban #276 step 5): a game taken from another seat - fetched, checked byte for byte and
  // scanned, run in the sandbox, kept on disk and ACTIVATED AT ONCE (the round store, the doors and the ghosts all read
  // `hosted`; no restart). An update must be the installed game's next version by the same developer; the version it
  // replaces stays hosted for the rounds it already holds, and new rounds use the new one.
  const superseded = new Map();     // old game id -> the id that replaced it
  // A GAME'S EARLIER VERSIONS, oldest first: from its own chain (an installed update's) and from the versions hosted here
  const chainOf = (g) => {
    const byId = new Map((g.ancestors || []).map((m) => [toHex(gameIdOf(m)), m]));
    for (let parent = toHex(g.manifest.parentManifestId); !/^0+$/.test(parent) && hosted.has(parent);) {
      const m = hosted.get(parent).manifest;
      if (!byId.has(parent)) byId.set(parent, m);
      parent = toHex(m.parentManifestId);
    }
    return [...byId.values()].sort((x, y) => x.version - y.version);
  };
  const hostedParent = (id) => { const g = hosted.get(toHex(id)); return g ? g.manifest : null; };
  const installedInfo = (id) => { const g = hosted.get(id); return g ? { gameId: id, devKey: toHex(g.manifest.gameDevPubkey), version: g.manifest.version, parent: toHex(g.manifest.parentManifestId) } : null; };
  async function takeGame({ game, from, replaces = null }) {
    if (!pluginsDir) return { ok: false, status: 409, why: 'this seat keeps no installed games (no plugins directory)' };
    from = String(from || '').replace(/\/+$/, '');
    if (!/^[0-9a-f]{64}$/.test(game) || !/^https?:\/\//.test(from)) return { ok: false, status: 400, why: 'name a game id and the seat to take it from' };
    if (hosted.has(game)) return { ok: false, status: 409, why: 'this seat already hosts that game' };
    if (replaces !== null && !hosted.has(replaces)) return { ok: false, status: 409, why: 'this seat does not host the game that version would replace' };
    let pkg;
    try { const r = await fetch(`${from}/plugin?game=${game}`, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`${r.status} ${(await r.text()).trim()}`); pkg = await r.json(); }
    catch (e) { return { ok: false, status: 502, why: `that seat did not hand the game over: ${e.message}` }; }
    const v = verifyPackage(pkg, { verify: verifyEd25519, want: game, parentOf: hostedParent });
    if (!v.ok) { console.log(`[plugins] refused ${game.slice(0, 16)} from ${from}: ${v.why}`); return { ...v, status: 422 }; }
    // the package kept with its whole chain, so it stands at the next start even once its old version is removed
    if (replaces !== null) { const chain = [...chainOf(hosted.get(replaces)), hosted.get(replaces).manifest]; pkg = { ...pkg, ancestors: chain.map((m) => toHex(encodeManifest(m))) }; }
    if (replaces !== null) {
      const u = checkUpdate(installedInfo(replaces), v);
      if (!u.ok) { console.log(`[plugins] refused update ${game.slice(0, 16)} of ${replaces.slice(0, 16)}: ${u.why}`); return { ...v, ok: false, status: 422, why: u.why }; }
    }
    const at = installPackage(pluginsDir, pkg, game);
    let reg;
    try { reg = await registrationFromPackage(at, pkg); } catch (e) { return { ok: false, status: 500, why: `kept, but it does not load: ${e.message}` }; }
    const entry = hostedPlugins([reg]).get(game);
    hosted.set(game, entry);
    if (replaces !== null) superseded.set(replaces, game);
    console.log(`[plugins] ${replaces ? `updated ${replaces.slice(0, 16)} to` : 'installed'} ${v.name} v${v.version} (${game.slice(0, 16)}) from ${from}: running now`);
    return { ...v, ok: true, game, from, installedAt: at, running: true, replaces };
  }
  // A GAME OFF THIS SEAT: only an installed one, and not while a round of it is unfinished here (its players are owed it)
  function removeGame(game) {
    if (!pluginsDir || !existsSync(joinPath(pluginsDir, game))) return { ok: false, status: 409, why: 'only a game installed from the store can be removed here' };
    const nowMs = round.now();
    let open = 0;
    for (const r of round.db.prepare('SELECT round_id, contract FROM rounds').all()) {
      let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
      if (toHex(c.gameId) !== game) continue;
      let end; try { end = Number(roundEndMs(c)); } catch { end = Number(c.entryCloseMs); }
      if (nowMs < end + Number(c.objectionWindowMs)) open++;
    }
    if (open) return { ok: false, status: 409, why: `${open} round(s) of that game are not finished on this seat: it is removed once they are` };
    hosted.delete(game);
    superseded.delete(game);
    renameSync(joinPath(pluginsDir, game), joinPath(pluginsDir, `.removed-${Date.now()}-${game}`));
    console.log(`[plugins] removed ${game.slice(0, 16)}`);
    return { ok: true, game, removed: true };
  }
  // AUTOMATIC UPDATES (the owner's setting): every 10 minutes the source seats are asked for a newer version of each game
  // hosted here - same developer, the hosted one as its parent, a higher version - and it is taken as an update would be
  const autoUpdate = async () => {
    if (!owner || !pluginsDir) return;
    const set = owner.storeSettings();
    if (!set.autoUpdate) return;
    // NAMED SOURCES, ELSE THE NETWORK'S OWN SEATS (kanban #276: found by this seat, not typed in)
    const sources = set.sources.length ? set.sources : networkSeats();
    for (const from of sources) {
      let got; try { got = await (await fetch(`${from}/games`, { signal: AbortSignal.timeout(10000) })).json(); } catch { got = { games: [] }; }
      for (const g of got.games || []) {
        if (hosted.has(g.id)) continue;
        let m; try { m = decodeManifest(fromHex(g.manifest)); } catch { continue; }
        const parent = toHex(m.parentManifestId);
        if (!hosted.has(parent) || superseded.has(parent)) continue;
        const u = checkUpdate(installedInfo(parent), { devKey: toHex(m.gameDevPubkey), parent, version: m.version });
        if (!u.ok) continue;
        const r = await takeGame({ game: g.id, from, replaces: parent });
        console.log(`[plugins] automatic update of ${parent.slice(0, 16)} from ${from}: ${r.ok ? 'taken' : r.why}`);
      }
      // AND EACH INSTALLED NETWORK (kanban #276): a newer package of it at a source seat - another package id, the same
      // federation - is taken as an update would be (checked, tried, never a lower donation serial). A package naming ANOTHER
      // federation is not taken automatically: it would make this seat's federation draining (succession), which is the
      // owner's own act from the owner page
      for (const [nid, held] of networksHeld) {
        let pkg; try { const r = await fetch(`${from}/network?network=${nid}`, { signal: AbortSignal.timeout(10000) }); if (!r.ok) continue; pkg = await r.json(); } catch { continue; }
        if (!pkg || !pkg.manifest || pkg.id === held.report.id) continue;
        if (pkg.manifest.federationId !== held.report.federationId) {
          console.log(`[networks] automatic update of ${nid.slice(0, 16)} from ${from}: not taken - it names federation ${String(pkg.manifest.federationId).slice(0, 16)}, a succession is the owner's to take`);
          continue;
        }
        const r = await takeNetwork({ network: nid, from, update: true });
        console.log(`[networks] automatic update of ${nid.slice(0, 16)} from ${from}: ${r.ok ? `taken (package ${String(r.id).slice(0, 16)})` : r.why}`);
      }
    }
  };
  // THE GAMES AND MARKETS ON THE NETWORK, FOUND BY THIS SEAT ITSELF (kanban #276, the owner 2026-10-11: "Es soll automatisch nach
  // anderen Spielen suchen nicht manuell ... games/market found on the Network ... Name/Typ/Version und der Action Install").
  // The seats it asks: those of the newest census it can read (their advertisements' endpoints), the peers it was given and
  // the owner's sources. Each one's GET /games is read and checked here - a manifest must hash to the id beside it, and its
  // description and website are shown only when its developer key signed them for that id (game-info.js) - so a listing
  // names what each seat claims and nothing this seat takes on trust. Read every NETWORK_GAMES_MS (5 min) and on an ask
  // older than that; one read at a time.
  const NETWORK_GAMES_MS = Number(process.env.ARENA_NETWORK_GAMES_MS || 300000);
  const networkGames = { atMs: 0, seats: [], games: [], reading: null };
  const baseOf = (u) => String(u).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '');
  const networkSeats = () => {
    const found = new Set((peers || []).map(baseOf));
    let rows = [];
    try { rows = round.db.prepare('SELECT round_id FROM rounds ORDER BY rowid DESC LIMIT 40').all(); } catch { rows = []; }
    for (const r of rows) {
      let c; try { c = roster.censusFor(new Uint8Array(r.round_id)); } catch { c = null; }
      if (c && c.ok && Array.isArray(c.entries) && c.entries.length) { for (const e of endpointsOf(c.entries, round.pubkey)) found.add(baseOf(e)); break; }
    }
    if (owner) for (const s of owner.storeSettings().sources || []) found.add(baseOf(s));
    return [...found].filter((u) => /^https?:\/\//.test(u));
  };
  const readNetworkGames = async () => {
    const seats = networkSeats();
    const byId = new Map();
    const asked = [];
    await Promise.all(seats.map(async (from) => {
      let got = null;
      try { const r = await fetch(`${from}/games`, { signal: AbortSignal.timeout(8000) }); got = r.ok ? await r.json() : null; } catch { got = null; }
      asked.push({ seat: from, answered: !!got, games: got && Array.isArray(got.games) ? got.games.length : 0 });
      for (const g of (got && got.games) || []) {
        let m; try { m = decodeManifest(fromHex(String(g.manifest))); } catch { continue; }
        const id = toHex(gameIdOf(m));
        if (id !== String(g.id).toLowerCase()) continue;              // a listing whose manifest is another game is not read
        const info = g.info ? gameInfoStands(g.info, { gameId: gameIdOf(m), manifest: m, verify: verifyEd25519 }) : null;
        const row = byId.get(id) || { id, name: m.gameName, title: String(g.title || m.gameName).slice(0, 80), type: gameTypeOf(m), version: m.version,
          devKey: toHex(m.gameDevPubkey), parent: toHex(m.parentManifestId), description: null, website: null, infoSigned: false, seats: [] };
        if (info && info.ok && !row.infoSigned) Object.assign(row, { description: info.description, website: info.website, infoSigned: true });
        row.seats.push(from);
        byId.set(id, row);
      }
    }));
    const games = [...byId.values()].map((g) => ({ ...g, hostedHere: hosted.has(g.id),
      updateOf: hosted.has(g.parent) && !hosted.has(g.id) ? g.parent : null })).sort((a, b) => a.title.localeCompare(b.title) || a.version - b.version);
    Object.assign(networkGames, { atMs: Date.now(), seats: asked.sort((a, b) => a.seat.localeCompare(b.seat)), games });
    return networkGames;
  };
  const networkGamesNow = async ({ fresh = false } = {}) => {
    if (!fresh && Date.now() - networkGames.atMs < NETWORK_GAMES_MS) return networkGames;
    if (!networkGames.reading) networkGames.reading = readNetworkGames().finally(() => { networkGames.reading = null; });
    return networkGames.reading;
  };
  const networkGamesTimer = setInterval(() => { networkGamesNow().catch((e) => console.error(`[plugins] network games: ${e.message}`)); }, NETWORK_GAMES_MS);
  if (networkGamesTimer.unref) networkGamesTimer.unref();
  const autoUpdateTimer = setInterval(() => { autoUpdate().catch((e) => console.error(`[plugins] automatic update: ${e.message}`)); }, Number(process.env.ARENA_AUTO_UPDATE_MS || 600000));
  if (autoUpdateTimer.unref) autoUpdateTimer.unref();
  // THE DONATION SET A ROUND NAMES, AS THIS SIGNER NODE CAN STAND BEHIND IT (M3.2 6e):
  // one of the handed sets whose recipients hash to the id the round's contract
  // names, for the round's network, in force at the round's census height, and
  // signed by that network's donation authority at that height - Ed25519
  // (ruled 2026-09-13), rotations included. Anything else is no set.
  const verifyDonation = (sig, msg, pub) => { try { return ed25519.verify(sig, msg, pub); } catch { return false; } };
  const donationSetFor = (contract) => {
    const keys = donationKeysForNetworkId(contract.networkId);
    if (!keys) return { ok: false, why: 'this round\'s network has no donation authority this signer node knows' };
    const want = toHex(contract.donationSetId);
    const named = donationSets.filter((s) => { try { return toHex(donationSetId(s.recipients)) === want; } catch { return false; } });
    if (!named.length) return { ok: false, why: 'this signer node holds no signed donation set with the id this round names' };
    const at = authorityAt({ networkId: contract.networkId, authority: keys.authority, recovery: keys.recovery,
      rotations: donationRotations, height: contract.censusHeight, verify: verifyDonation });
    // THE SET IN FORCE, A SOFT FORK (27A.4; LNURL-0822, the owner 2026-10-02): the highest validly signed serial whose valid_from
    // the round's census height has reached is the set the round must name. A round written below a newer set's valid_from
    // keeps the set it named (22A); one at or past it names the newer set or is no round with a set.
    const forced = donationSetInForce({ networkId: contract.networkId, authority: keys.authority, recovery: keys.recovery,
      sets: donationSets, rotations: donationRotations, height: contract.censusHeight, verify: verifyDonation });
    if (forced.ok && toHex(donationSetId(forced.recipients)) !== want)
      return { ok: false, why: `at census height ${contract.censusHeight} this network's donation set in force is serial ${forced.serial} `
        + `(${toHex(donationSetId(forced.recipients)).slice(0, 16)}), and this round names ${want.slice(0, 16)}` };
    for (const s of named) {
      if (toHex(s.networkId) !== toHex(contract.networkId) || !(s.validFrom <= contract.censusHeight)) continue;
      if (donationSetSignedBy(s, { authority: at.authority, verify: verifyDonation }).ok) return { ok: true, set: s };
    }
    return { ok: false, why: 'the set this round names is not signed by its network\'s donation authority at the round\'s height' };
  };
  // THE PROPOSALS THIS SEAT KEEPS (kanban #329, proposals.js): a deposit pays the network's donation set in force at its height
  const proposals = givenProposals || (ballot ? createProposals({ confirmedTx: ballot.confirmedTx,
    recipientsFor: (net, height) => {
      const networkId = fromHex(net); const keys = donationKeysForNetworkId(networkId);
      if (!keys) return null;
      const forced = donationSetInForce({ networkId, authority: keys.authority, recovery: keys.recovery, sets: donationSets,
        rotations: donationRotations, height, verify: verifyDonation });
      return forced.ok ? forced.recipients : null;
    },
    lowestBondMinSatsFor: () => ballot.lowestBondMinSats,
    // regtest votes on its short schedule (1 / 6 / 1); every other network on the genesis one (27A.7.4)
    scheduleFor: (net) => { const k = donationKeysForNetworkId(fromHex(net)); return k && k.network === 'regtest' ? SCHEDULES.regtest : SCHEDULES.mainnet; },
    verify: (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } },
    store: { read: () => { try { return round.db.prepare('SELECT json FROM ballot_proposals').all().map((r) => JSON.parse(r.json)); } catch { return []; } },
      write: (list) => { round.db.exec('CREATE TABLE IF NOT EXISTS ballot_proposals (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
        const put = round.db.prepare('INSERT OR REPLACE INTO ballot_proposals (id, json) VALUES (?, ?)'); for (const x of list) put.run(x.id, JSON.stringify(x)); } } }) : null);
  // WHAT A PLAYER'S DONATION IN THIS ROUND PAYS (§0A.8, kanban #205): half to the network's set - the protocol devs - and
  // half to the round's game's set - its developer's, as its registration carries it, checked against its manifest. A
  // round of a game this node does not host, or with no network set, has no target, and its entries' donations are judged
  // by no list of this node's.
  const donationTargetFor = (contract) => {
    const ds = donationSetFor(contract);
    if (!ds.ok) return ds;
    const game = contract.gameId instanceof Uint8Array ? hosted.get(toHex(contract.gameId)) : null;
    if (!game || !Array.isArray(game.donationSet)) return { ok: false, why: 'this node holds no donation set of that round\'s game' };
    return { ok: true, set: ds.set, target: { network: ds.set.recipients, game: game.donationSet } };
  };
  // A PAYING ROUND THAT NAMES A SET OTHER THAN THE ONE IN FORCE, AS A REFUSAL (kanban #191, the owner 2026-10-06: series
  // d37c1ef1 named serial 2 where serial 3 was in force; its rounds were written and listed 7 of 7, a page locked a stake into
  // one, and only the session refused it). One answer per network, census height and set id - every round of a series asks.
  const inForceKept = new Map();
  const donationInForceRefusal = (contract) => {
    if (!contract || !(contract.stakeMsat > 0n) || !donationSets.length || !donationKeysForNetworkId(contract.networkId)) return null;
    const key = `${toHex(contract.networkId)}:${contract.censusHeight}:${toHex(contract.donationSetId)}`;
    if (!inForceKept.has(key)) { const ds = donationSetFor(contract); inForceKept.set(key, !ds.ok && /in force/.test(ds.why) ? ds.why : null); }
    return inForceKept.get(key);
  };

  // THE BEACON IS KEPT WITH THE ROUND (M3.3-34). A signer node restarted while it holds
  // a close must still name the block its chain named: measured on the Daily,
  // whose chain reader keeps its answers in memory, a restarted signer node held its
  // pre-restart rounds for ever on "that randomness names no time". The first
  // block after committee_time does not change as the chain grows, so a kept
  // answer is the same answer - and `beaconFor` still checks it against this
  // signer node's own chain view. The reader's answer wins whenever it has one.
  if (randomnessFor) {
    const read = randomnessFor;
    const written = new Map();
    randomnessFor = (q) => {
      const given = read(q);
      const id = q && q.roundIdBytes;
      if (!id) return given;
      const key = Buffer.from(id).toString('hex');
      if (given && given.hash instanceof Uint8Array && given.hash.length === 32
          && Number.isInteger(given.height) && typeof given.timeMs === 'bigint') {
        const said = `${Buffer.from(given.hash).toString('hex')}:${given.height}:${given.timeMs}`;
        if (written.get(key) !== said) { round.putBeacon(id, given); written.set(key, said); }
        return given;
      }
      return given || round.beaconOf(id);
    };
  }

  // WHAT HOLDS THE PLAYERS' MONEY. 23.1's hold invoice and 23.2's table, and
  // the port is injected for the same reason the chain and the randomness are:
  // a daemon given none holds no stakes and says so rather than pretending.
  // Nothing about a stake is decided here - `custody.js` decides, off the
  // outcome word the core produced - and this file only says WHEN it is asked.
  // WHO CAN OPEN A STAKE. One share each, sealed, and five of them or nothing.
  // The peers are the same list the verifier gathers results from, because a
  // signer node that answers about a run is a signer node that can be asked about its share.
  const stakeSecrets = new StakeSecrets(round, {
    bookStanding: (rid, eid) => orderBook.standing(rid, eid),
    curve: feldmanGroup, peers, fetcher: (u, o) => fetch(u, o), random: (n) => new Uint8Array(randomBytes(n)),
    // AND WHEN THE OPERATOR SAID NOTHING, the round's SETTLEMENT signer nodes off the
    // census - they hold the shares. Read when a stake is opened, long after
    // `roster` below exists.
    peersFor: (roundIdBytes) => settlementPeers(roundIdBytes),
  });

  // THE ONE STAKE CHECK LEFT, AND IT IS THE FEDERATION'S (§23.1 step 5; §23.6, RULED 2026-09-22 22:59).
  //
  // A stake is SEEN when its round asks none, or when this signer node verified its lock - and, where the
  // round mints fee locks, its fee lock too - which is the row `putStakeSeen` writes. There is no other
  // way to see one. The half that used to ask this node's own Lightning whether a hold invoice was paid,
  // and the committee share-gathering that fed its settle, were the withdrawn Lightning custody's and are gone with it.
  const stakeSeen = async (entryId) => {
    const stored = round.entry(entryId);
    if (!stored) return { ok: false, why: 'this node holds no such entry' };
    const entry = decodeEntryContract(stored);
    if (entry.stakeMsat === 0n) return { ok: true, state: 'FREE' };
    const seen = round.stakeSeen(entryId);
    if (seen) return { ok: true, state: 'HELD', paidMsat: seen.paidMsat, already: true };
    return { ok: false, why: 'its stake lock has not been verified by this signer node (§23.1 step 5)' };
  };

  // TWO FIRST MARKS PROVEN HERE (§13B; M3.3-34, a signer node that stays down): ask
  // the other signer nodes for their shares NOW, while they are up, and keep the
  // envelopes (stakeSecrets.open) - so a signer node that goes down later and stays down
  // past the hold's expiry cannot hand the stake back. Measured before: A held
  // the proof, B went down before the close, "1 of 2 shares" - the hold stayed
  // in flight to expire back to the player. `pull`: this signer node learned of the
  // pair from a refused forward, and fetches the proof first.
  // THE PROOF, SPREAD THE MOMENT IT FORMS - on a lock as on a hold (M3.3-34):
  // every other signer node is asked to pull the pair and check it itself (POST
  // /proof-pull), while the signer nodes are still reachable. Measured before on 5 of
  // 7: receipts lost between signer nodes that are up, the signer node holding the proof cut
  // off from the Void signer nodes when the refund was asked - their pull found
  // nothing, five signed, 98000 msat back to the player; on a hold the proof had
  // spread through the share gathering and the stake settled.
  async function spreadProof(rid, eid) {
    const q = `round=${toHex(rid)}&entry=${toHex(eid)}`;
    await Promise.all(verifier.peersOf(rid).map((peer) => fetch(`${String(peer).replace(/\/+$/, '')}/proof-pull?${q}`,
      { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => null)));
  }
  const gathering = new Set();
  function gatherOnProof(rid, eid, { pull = false } = {}) {
    const key = toHex(eid);
    if (gathering.has(key)) return;
    gathering.add(key);
    (async () => {
      // two first marks, or a fork at any later tick (§13B; kanban #25)
      if (pull && !round.provenEquivocation(rid, eid)) await verifier.pullFirstMarkProof(rid, eid);
      if (!round.provenEquivocation(rid, eid)) return;
      await spreadProof(rid, eid);
    })().catch((e) => console.error(`[shares] ${e.message}`)).finally(() => gathering.delete(key));
  }

  // WHAT `funded` MAY KNOW OF THIS NODE (M3.3-31): whether it holds a round, and whether it reaches
  // the federation that round's stake is locked in - the launcher's rule funds an entry only into a
  // paying round this node holds and can verify the lock of. (Whether it reached Lightning was the
  // hold-invoice question, the withdrawn Lightning custody's, and is not asked any more.)
  const fundingView = {
    holds: (roundIdBytes) => round.get(roundIdBytes),
    // AND WHETHER IT REACHES A FEDERATION, which is how a lock round's stake is held (§23.1 step 5).
    get reachesFederation() { return !!stakeLocks; },
  };



  // THIS NODE'S HALF OF MAKING THE COMMITTEE'S KEY: one contribution each, one share kept, and a group key every
  // signer node computes from public data - the round's claim key.
  const dkg = new Dkg(round, {
    curve: poolCurve, random: (n) => new Uint8Array(randomBytes(n)),
    peers, fetcher: (u, o) => fetch(u, o),
  });

  // THE PLAYER'S FIRST MARK, FORWARDED TO THE ROUND'S OTHER SIGNER NODES.
  //
  // A signer node the player never reached cannot tell a late start from a run, and
  // cannot receipt a run it never saw start. So a signer node that takes a first mark
  // - or refuses it as a late start, FORFEIT - hands it on at once: the signed mark, the
  // batches it commits to (a signer node receipts only a mark whose inputs it holds),
  // and this signer node's own receipt. Each other signer node applies the same rule to the
  // same signed tick. What each answered is kept by entry, for whoever asks.
  const firstMarkForwards = new Map();
  const firstMarkOf = (data, isBinary) => {
    if (!isBinary) return null;
    const bytes = new Uint8Array(data);
    if (bytes[0] !== TYPE_CHECKPOINT) return null;
    try {
      const c = decodeCheckpoint(splitSigned(bytes).body);
      return c.previousHash.every((x) => x === 0) ? { bytes, c } : null;
    } catch { return null; }
  };
  /** One receipt this signer node issued, offered to every peer of the round over its play socket, as a peer offers one. */
  function offerReceipt(roundIdBytes, receiptBytes) {
    for (const peer of verifier.peersOf(roundIdBytes)) {
      try {
        const ws = new WebSocket(`${String(peer).replace(/\/+$/, '').replace(/^http/, 'ws')}/play`);
        ws.binaryType = 'arraybuffer';
        const done = () => { try { ws.close(); } catch { /* gone */ } };
        const t = setTimeout(done, 3000);
        if (t.unref) t.unref();
        ws.addEventListener('open', () => ws.send(receiptBytes));
        ws.addEventListener('message', () => { clearTimeout(t); done(); });
        ws.addEventListener('error', () => { clearTimeout(t); done(); });
      } catch { /* a peer that cannot be reached keeps the receipts it has */ }
    }
  }

  async function forwardFirstMark({ bytes, c }, { ask = null } = {}) {
    const id = checkpointId(c);
    const held = round.holdsMark(id);
    if (!held && !round.startForfeit(c.entryId)) return null;      // refused for another reason: nothing to hand on
    const batches = held ? round.batchesThrough(c.roundId, c.entryId, c.inputChainHash) : [];
    const own = held ? round.ownReceipt(id) : null;
    // AND ONCE THIS SIGNER NODE HOLDS THE ENTRY ENTRY_VOID (§16), THE EVIDENCE GOES WITH
    // IT: the player's own signed mark past the start line, or "closed". A signer node
    // that was down records the Void from it instead of taking the mark late.
    const voided = held ? round.entryVoid(c.entryId) : null;
    // WITH THE VOID, EVERY RECEIPT THIS SIGNER NODE HOLDS OF THE MARK (M3.3-34, ruled
    // 2026-09-13, pick A): the returning signer node counts them itself. Measured
    // before: one receipt went, the returning signer node read 1 of 5, took the mark
    // late, and all seven signed FAILED - the hold settled into the pool.
    const body = JSON.stringify({ mark: toHex(bytes), batches: batches.map((b) => toHex(b)), receipt: own ? toHex(own) : null,
      receipts: voided ? round.receiptsOfMark(id).map((r) => toHex(r)) : [], ask,
      entryVoid: voided ? { kind: voided.evidenceKind, evidence: voided.evidence ? toHex(voided.evidence) : null } : null });
    const offers = held ? round.firstMarkOffers(c.entryId) : {};
    const said = [];
    for (const peer of verifier.peersOf(c.roundId)) {
      const at = String(peer).replace(/\/+$/, '');
      if (held && !voided && offers[at] === 'receipted') continue;       // it has the mark already
      let answer;
      let why;
      try {
        const r = await fetch(`${at}/first-mark`, { method: 'POST', body, signal: AbortSignal.timeout(3000) });
        let got;
        try { got = JSON.parse(await r.text()); } catch { got = {}; }
        why = got.why ? String(got.why).slice(0, 120) : undefined;
        if (r.ok && got.receipt) { try { round.takeReceipt(fromHex(String(got.receipt))); } catch { /* not this mark's */ } answer = 'receipted'; }
        else if (got.entryVoid) answer = 'late';
        else if (got.forfeit) answer = 'FORFEIT';
        else answer = 'refused';
        said.push({ peer: at, status: r.status, answer, why });
      } catch (e) { answer = 'unanswered'; said.push({ peer: at, status: 0, answer, why: e.message }); }
      // WHAT THE PEER ANSWERED THE ON-TIME FIRST MARK is §16's evidence (entry-void.js).
      if (held && answer !== 'FORFEIT') round.putFirstMarkOffer({ entryId: c.entryId, peer: at, answer });
    }
    firstMarkForwards.set(toHex(c.entryId), said);
    // A PEER REFUSED THIS FIRST MARK AS A CONFLICT (409): it may hold another one
    // - pull its proof, and on two first marks gather the shares while the signer nodes
    // are up. Not on a 404 (a signer node that has not taken the entry yet holds no
    // mark of it): measured, payout-second-signer node pulled twice per run for nothing.
    if (said.some((s) => (s.answer === 'refused' && s.status === 409) || s.answer === 'FORFEIT')) gatherOnProof(c.roundId, c.entryId, { pull: true });
    return said;
  }

  // ENTRY_VOID (§16), THE OUTAGE REFUND, ON THIS SIGNER NODE'S OWN RECORD.
  //
  // The player's on-time first mark is forwarded at once and what each other
  // signer node answered is kept (forwardFirstMark). When the start deadline passes
  // HERE - this signer node takes a mark the player signed past join tick + deadline,
  // or its round closes - and the first mark is still short of the threshold's
  // receipts, with the signer nodes it is short of offered it and silent, the entry is
  // ENTRY_VOID (entry-void.js), and the evidence goes to the other signer nodes. A
  // signer node that was down refuses a first mark reaching it after that line -
  // forwarded, or sent by the player directly - and records the same Void, so a
  // run cannot be kept by catching a down signer node up after seeing it (§13C).
  // A late START is FORFEIT (first-mark.js) and is not decided here.
  const firstMarkMessage = (rid, eid) => {
    const bytes = round.firstMarkHeld(rid, eid);
    if (!bytes) return null;
    const c = decodeCheckpoint(splitSigned(bytes).body);
    return c.previousHash.every((x) => x === 0) ? { bytes, c } : null;
  };
  // THE PLAYER'S SECOND FIRST MARK (§13B; ruled 2026-09-12): a first mark this
  // signer node does not hold, while it keeps a DIFFERENT first mark as a late start or
  // holds a proof of two - refused, never taken and never voided here. Measured
  // before on a fresh federation: A voided on a real outage, the player sent B a
  // late first mark, A's forfeit showed B the Void, B recorded it too, both
  // signed the refund and the player redeemed the lock before its expiry.
  const TWO_FIRST_MARKS = 'the player signed another first mark for this entry (§13B): two first marks are FORFEIT, never an outage refund';
  // SAME-MARK ONLY (path 1): a first mark that differs from the one this signer node
  // voided or kept as a late start is the second one - refused, and the pair
  // kept as the proof other signer nodes pull at /equivocation. A first mark this signer node
  // HOLDS is counted only before a Void (`orHeld`): at the door a different
  // one already goes to the chain's own refusal, which keeps that proof
  // (equivocation at a tick, or a parent that is not the head).
  const secondFirstMark = (c, bytes, { orHeld = false } = {}) => {
    if (round.equivocation(c.roundId, c.entryId).length > 0) return true;
    const late = round.startForfeit(c.entryId);
    const voided = round.entryVoid(c.entryId);
    // A REFUSED FIRST MARK NOBODY CARRIED IS NOT A SIGNED FIRST MARK (§13B).
    //
    // Measured on the Daily, one paid entry: the first mark went out at tick 5940 against a window ending
    // at 900 and was refused as a late start (§15) - kept as evidence, never taken into the chain. The
    // client's head was therefore still ZERO, so it did what a client with no head does and marked again;
    // and every one of the 80 marks after it was answered "the player signed another first mark for this
    // entry (§13B): two first marks are FORFEIT, never an outage refund", with `checkpoints` and
    // `offered_marks` both holding 0 rows for that entry on both seats.
    //
    // 13B's fork is a player who got a first mark CARRIED and then signed a different one. A player whose
    // only mark was refused has signed nothing the committee holds; they retried after being told no. The
    // difference decides more than a word: that clause is the one that says "never an outage refund", so
    // charging it here would close §13C and §16 against a player on the strength of the operator's own
    // refusal. The operator must not profit from a technical failure. A start forfeit this signer node
    // never took into the chain is therefore not the other mark of a pair, no pair is kept, and the retry
    // is answered the way the first one was: the same late start, in the same words.
    //
    // AND ONLY A RETRY THAT IS ITSELF LATE. This is not an opening to mark again inside the window after
    // being told the start was missed: a mark at or before the start line would claim a start this signer
    // node refused, which is exactly the second first mark §13B is for. So the pair is skipped only while
    // the new mark is past the same line the old one was past - where it can ask for nothing the first one
    // was not already refused.
    const carried = (m) => {
      try { return round.holdsMark(checkpointId(decodeCheckpoint(splitSigned(m).body))); } catch { return false; }
    };
    const startLine = round.startLine(c.roundId, c.entryId);
    const retryOfRefusedLateStart = !!late && !carried(late.mark)
      && !!startLine && c.tick > startLine.lastTick && late.markTick > startLine.lastTick;
    const other = [late && !retryOfRefusedLateStart && late.mark,
      voided && voided.firstMark, orHeld && round.firstMarkHeld(c.roundId, c.entryId)]
      .find((m) => m && toHex(m) !== toHex(bytes));
    if (!other || !round.putFirstMarkPair({ a: other, b: bytes })) return false;
    // A VOID SIGNER NODE ALSO KEEPS THE PLAYER'S LATE FIRST MARK AS A LATE START (M3.3-34,
    // ruled 2026-09-13), next to the pair: the late start's own record, through
    // the chain's own first-mark rule (signature checked, kept, refused FORFEIT).
    // Measured before: signer node 4, voided from the full receipts, refused the late
    // mark as a second first mark and kept no late start of it.
    const line = round.startLine(c.roundId, c.entryId);
    if (voided && !late && line && c.tick > line.lastTick) {
      try { round.checkpoint(bytes); } catch { /* FORFEIT: the late start is kept */ }
    }
    return true;
  };
  // NO FREE STAND (RULED the owner 2026-09-24): an ENTRY_VOID never ends the close by itself. The close keeps it until §13C
  // writes the record every holder writes once the result window's end block is here - VOID, or FORFEIT on a pair that
  // sits before that block - and a node that closes after the end block writes it at its first pass. Measured before: two
  // holders shown a peer's Void by the forfeit doors closed after the end block and wrote nothing, while the four that
  // closed before it wrote VOID. Only a Void of a round this node does not hold stands.
  const voidStands = (rid, eid) => !!round.entryVoid(eid) && !round.get(rid);
  function decideOutage(rid, eid, { evidenceKind, evidence = null }) {
    const had = round.entryVoid(eid);
    if (had) return had;
    // THE PLAYER'S TWO FIRST MARKS ARE NOT AN OUTAGE (§13B, §13C). Measured: an
    // on-time first mark to B while A was down and a late one to A - both signer nodes
    // recorded ENTRY_VOID and forfeited the lock to the player at once, a refund
    // for the player's own split start. With the proof held here, no Void: the
    // close's no-quorum rule makes it FORFEIT (verify #noQuorum).
    if (round.equivocation(rid, eid).length) return null;
    const f = firstMarkMessage(rid, eid);
    const line = round.startLine(rid, eid);
    if (!f || !line) return null;
    const d = outageOutcome({ firstMark: true, lateStart: f.c.tick > line.lastTick, deadlinePassed: true,
      receipts: round.receiptCount(checkpointId(f.c)), needed: line.needed,
      offers: Object.values(round.firstMarkOffers(eid)), state: resultFinality(round, rid, eid).state });
    if (d.outcome !== ENTRY_VOID) return null;
    round.putEntryVoid({ entryId: eid, roundId: rid, firstMark: f.bytes, evidenceKind, evidence, why: d.why });
    return round.entryVoid(eid);
  }
  // AFTER A LATER MARK IS TAKEN HERE: inside the start line, offer the first mark
  // again to any signer node that has not taken it (it may be back); past it, decide.
  async function afterMarkTaken(bytes) {
    let c;
    try { c = decodeCheckpoint(splitSigned(bytes).body); } catch { return; }
    if (!round.holdsMark(checkpointId(c))) return;
    const f = firstMarkMessage(c.roundId, c.entryId);
    const line = round.startLine(c.roundId, c.entryId);
    if (!f || !line || toHex(checkpointId(f.c)) === toHex(checkpointId(c))) return;
    if (c.tick <= line.lastTick) {
      if (Object.values(round.firstMarkOffers(c.entryId)).some((a) => a !== 'receipted')) await forwardFirstMark(f);
      return;
    }
    if (round.entryVoid(c.entryId)) return;
    if (decideOutage(c.roundId, c.entryId, { evidenceKind: 'mark', evidence: bytes })) await forwardFirstMark(f);
  }
  // HAS THE START DEADLINE PASSED, as far as THIS signer node can check, for a first
  // mark it has never held? Its own record, its own round closed, or the
  // player's own signed mark past the line - never a peer's word alone.
  function lateEvidenceHere(c, claim, claimReceipt = null) {
    const line = round.startLine(c.roundId, c.entryId);
    if (!line || c.tick > line.lastTick) return null;             // a late START is FORFEIT's
    if (round.entryVoid(c.entryId)) return { kind: 'recorded', evidence: null };
    if (line.closed) return { kind: 'closed', evidence: null };
    // A ROUND SIGNER NODE THAT CLOSED WITH THE ENTRY VOID: this signer node does not hold the
    // first mark, and a signer node of the round - proven by its own signed receipt of
    // THIS first mark, taken in time - says the round closed without it reaching
    // the threshold. This signer node records only what it knows: it never took the
    // first mark. A signer node that holds it never gets here, so a run that started
    // cannot be voided this way; the lock goes back to the player, never to anyone else.
    if (claim && claim.kind === 'closed' && claimReceipt && round.receiptVerifies(claimReceipt, checkpointId(c), c.roundId))
      return { kind: 'closed', evidence: null };
    if (claim && claim.kind === 'mark' && claim.evidence) {
      try {
        const evidence = fromHex(String(claim.evidence));
        const e = round.playerSigned(evidence);
        if (toHex(e.entryId) === toHex(c.entryId) && e.tick > line.lastTick) return { kind: 'mark', evidence };
      } catch { /* not the player's mark: proves nothing */ }
    }
    return null;
  }
  function voidHere(c, bytes, late, givenReceipts = [], learned = 'forward') {
    const had = round.entryVoid(c.entryId);
    if (had) return had;
    if (secondFirstMark(c, bytes, { orHeld: true })) return null;
    // THE PLAYER'S OWN FIRST MARK, OR NO VOID HERE. A signer node records ENTRY_VOID
    // only for a first mark it holds in the player's own hand - signed by the
    // entry's session key, from the player or in a forward - never on another
    // signer node's word alone. Measured before this (closed-claim-probe.mjs): a mark
    // one signer node invented, with its own receipt over it and "closed", voided the
    // entry at the other signer node and the lock was forfeited though the player
    // never sent a mark. Such a mark now goes on to the door's own checks,
    // which refuse its signature.
    let signed;
    try { signed = round.playerSigned(bytes); } catch { return null; }
    if (toHex(checkpointId(signed)) !== toHex(checkpointId(c)) || !signed.previousHash.every((x) => x === 0)) return null;
    const line = round.startLine(c.roundId, c.entryId);
    const id = checkpointId(c);
    // THE VOID SIGNER NODES' RECEIPTS, each checked here and counted once per signer:
    // with this signer node silent, the signer nodes short of the threshold are the ones that
    // were down - §16's outage, recorded here as the Void signer nodes recorded it.
    const receipts = round.receiptSigners(givenReceipts, id, c.roundId);
    const d = outageOutcome({ firstMark: true, lateStart: false, deadlinePassed: true, receipts, needed: line.needed,
      offers: ['late'], state: null });
    if (d.outcome !== ENTRY_VOID) return null;
    round.putEntryVoid({ entryId: c.entryId, roundId: c.roundId, firstMark: bytes, evidenceKind: late.kind === 'recorded' ? 'mark' : late.kind,
      evidence: late.evidence, why: `this signer node was offered the on-time first mark only after the start deadline had passed; ${d.why}`, learned });
    return round.entryVoid(c.entryId);
  }
  /** The receipts a Void signer node handed over: its own, and every one it holds of the mark. */
  const receiptsGiven = (got) => [got.receipt, ...(Array.isArray(got.receipts) ? got.receipts : [])]
    .filter(Boolean).flatMap((r) => { try { return [fromHex(String(r))]; } catch { return []; } });
  async function lateByPeers(c, bytes) {
    for (const peer of verifier.peersOf(c.roundId)) {
      try {
        const r = await fetch(`${String(peer).replace(/\/+$/, '')}/entry-void?entry=${toHex(c.entryId)}`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) continue;
        const got = await r.json();
        // SAME-MARK VOID EVIDENCE ONLY (M3.3-34, ruled 2026-09-12, path 1): a
        // peer's Void of a DIFFERENT first mark is the player's second first
        // mark. Measured before: this signer node took it as a normal mark (the peer's
        // receipt was of its own mark, so no Void here), later recorded the
        // peer's Void too, and both signer nodes signed the refund - the player
        // redeemed the lock before its expiry. Now the pair is kept, the mark
        // refused. An ON-TIME mark only: a late one keeps its own rule (a late
        // start, FORFEIT, recorded as such), and the pair forms where the
        // on-time mark is held.
        const theirs = got.firstMark ? fromHex(String(got.firstMark)) : null;
        const line = round.startLine(c.roundId, c.entryId);
        if (theirs && line && c.tick <= line.lastTick && toHex(theirs) !== toHex(bytes)
          && round.putFirstMarkPair({ a: theirs, b: bytes })) return { twoFirst: true };
        const late = lateEvidenceHere(c, { kind: got.evidenceKind, evidence: got.evidence }, got.receipt ? fromHex(String(got.receipt)) : null);
        if (late) return { late, receipts: receiptsGiven(got) };
      } catch { /* a signer node that is down proves nothing */ }
    }
    return null;
  }
  async function pushVoid(rid, eid) {
    if (!round.entryVoid(eid)) return;
    const f = firstMarkMessage(rid, eid);
    // named as the forfeit ask's push: a signer node that learns the Void only from it
    // signs no lock refund before the result window passes (forfeit.js)
    if (f) await forwardFirstMark(f, { ask: 'forfeit' });
  }

  // THE SIGNER NODES' FORFEIT OF A QUALIFIER'S STAKE LOCK (W5b), with this signer node's share
  // of the round's claim key. Its peers are the round's settlement signer nodes, from
  // the census; a node with none (an in-process test) falls back to its DKG's.
  // AND OF AN ENTRY_VOID LOCK (§16, §23.2), at once: the evidence is shown to
  // the other signer nodes first, so a signer node that was down can record the same Void.
  // THE NAMES THIS SIGNER NODE KEEPS FOR A ROUND, as the players signed them (M3.3-34).
  const namesHeld = (rid) => round.lobbyNames(rid).map((n) => ({ record: toHex(n.record), sig: toHex(n.signature) }));

  const forfeits = new Forfeit(round, {
    bookStanding: (rid, eid) => orderBook.standing(rid, eid),
    dkg, port: stakeLocks, curve: poolCurve, random: (n) => new Uint8Array(randomBytes(n)),
    // §23.2 REFUSED (kanban #191): asked at the forfeit - does this node still refuse that round? (null: it offers it)
    refusedNow: (rid) => offerRefusalOfRound(rid),
    peersFor: (rid) => {
      const picked = roster.committeeFor(rid, 'settlement');
      return picked.ok ? endpointsOf(picked.committee, round.pubkey) : (dkg.peers || []);
    },
    onVoid: (rid, eid) => pushVoid(rid, eid),
    // Before a Void lock is refunded: the other signer nodes' proof of two first marks.
    pullProof: (rid, eid) => verifier.pullFirstMarkProofReach(rid, eid),
  });

  // AND THE LOSERS' LOCKS, CLAIMED INTO THE ROUND'S ONE SETTLEMENT (W4, the owner
  // 2026-09-14): the same signer nodes, the same claim key, each loser's P opened by the
  // share conversation, one txid rebuilt by every signer node and signed once.
  // WINNINGS ALWAYS SENT on a FEDERATION round (winnings-send.js): the same settlement committee, the same peers.
  const winningsPeers = (rid) => {
    const picked = roster.committeeFor(rid, 'settlement');
    return picked.ok ? endpointsOf(picked.committee, round.pubkey) : (dkg.peers || []);
  };
  const winnings = stakeLocks ? new WinningsSend({ round, port: stakeLocks, curve: poolCurve,
    random: (n) => new Uint8Array(randomBytes(n)), peersFor: winningsPeers, fetcher: (u, o) => fetch(u, o),
    lnurlFetch, network: winningsNetwork }) : null;
  // THE MARKET ORDER BOOK (kanban #278 step 4): orders taken here, each batch's set agreed with the round's other seats
  const orderBook = new OrderBook(round, { plugins: hosted, intervalMs: orderBatchMs, now: () => round.now(),
    peersFor: (rid) => { const picked = roster.committeeFor(rid, 'settlement'); return picked.ok ? endpointsOf(picked.committee, round.pubkey) : (dkg.peers || []); } });
  // AT EVERY CUTOFF: the batch whose cutoff just passed, for each round holding orders not in a batch, if this seat leads it.
  // A little after the cutoff (orderBatchGraceMs), so an order a page posted just before it has landed at every seat.
  let orderBatchTimeout = null;
  const orderBatchGraceMs = Math.min(100, Math.floor(orderBatchMs / 5));
  const orderBatchTick = async () => {
    const at = round.now();
    const k = Math.floor((at - orderBatchGraceMs) / orderBatchMs) - 1;
    // the rounds with orders: an entry with a limit price, open or within one interval of its close
    const rounds = round.db.prepare('SELECT DISTINCT round_id FROM market_orders UNION SELECT DISTINCT round_id FROM market_book_events UNION SELECT DISTINCT round_id FROM market_batches WHERE certificate IS NULL').all().map((r) => new Uint8Array(r.round_id));
    for (const rid of rounds) {
      if (!orderBook.leads(rid, k)) continue;
      const got = await orderBook.lead(rid, k).catch((e) => ({ ok: false, why: e.message }));
      if (got.ok && !got.empty) console.log(`[orders] ${toHex(rid).slice(0, 16)} batch ${k}: ${got.orderIds.length} order(s), ${got.cancels} cancel(s), ${got.sells} sell(s), signed by ${got.heldBy} of ${got.of}, certified ${got.certified} in ${got.timings.certifiedMs} ms`);
    }
  };
  const scheduleOrderBatch = () => {
    const at = Date.now();
    orderBatchTimeout = setTimeout(async () => { await orderBatchTick().catch(() => {}); if (orderBatchTimeout) scheduleOrderBatch(); },
      orderBatchMs - (at % orderBatchMs) + orderBatchGraceMs);
    if (orderBatchTimeout.unref) orderBatchTimeout.unref();
  };
  if (orderBatchTimer) scheduleOrderBatch();
  // A PRICE ROUND: a replayed game whose world moves with the price - nextblock (§0.5A, §11); attested markets and
  // head-to-head games have no front
  const priceRound = (c) => { const f = pluginForRound(c, hosted); return f.ok && !f.attested && f.plugin && (f.plugin.name === 'nextblock' || (f.plugin.manifest && f.plugin.manifest.gameName === 'nextblock')); };
  const prices = new PriceFeed(round, { priceRound, now: () => round.now(),
    ...(priceFeed && typeof priceFeed === 'object' && priceFeed.readPrice ? { readPrice: priceFeed.readPrice } : {}),
    peersFor: (rid) => { const picked = roster.committeeFor(rid, 'settlement'); return picked.ok ? endpointsOf(picked.committee, round.pubkey) : (dkg.peers || []); } });
  let priceTimeout = null;
  // ENFORCED (§11, kanban #311 slice 3): where this seat runs the feed, a price round's batches carry only attested prices
  const feedFor = (contractBytes) => { if (!priceFeed) return false; try { return priceRound(decodeRoundContract(new Uint8Array(contractBytes))); } catch { return false; } };
  round.pricesRequired = feedFor;
  if (priceFeed) {
    const schedulePrices = () => {
      priceTimeout = setTimeout(async () => {
        const out = await prices.beat().catch((e) => [['error', { ok: false, why: e.message }]]);
        for (const [what, got] of out) if (!got.ok) console.log(`[prices] ${what}: ${got.why}`);
        if (priceTimeout) schedulePrices();
      }, 5000 - (Date.now() % 5000) + 300);
      if (priceTimeout.unref) priceTimeout.unref();
    };
    schedulePrices();
  }
  // WHO IS CONFLICTED IN A ROUND (§5A.13, kanban #309): the committee nodes whose advertised operator plays it - a player's own
  // key or the operator its entry declares (operator-conflict.js); `self` this node's operator when it is one of them, and
  // whether the settlement committee still holds its threshold without them
  const conflictsFor = (rid) => {
    const game = roster.committeeFor(rid, 'game');
    const settle = roster.committeeFor(rid, 'settlement');
    const nodes = [...(game.ok ? game.committee : []), ...(settle.ok ? settle.committee : [])];
    let entries = [];
    try { entries = round.entriesOf(rid).map((x) => x.entry); } catch { entries = []; }
    const conflicted = conflictedNodes({ nodes, entries });
    const committee = settle.ok ? settle.committee.map((e) => e.pubkey) : [];
    let threshold;
    try { threshold = committeeThreshold(committee.length); } catch { threshold = undefined; }
    return { conflicted, self: conflicted.get(toHex(round.pubkey)) || null,
      serving: servingAfterConflicts({ committee, conflicted, ...(threshold ? { threshold } : {}) }) };
  };
  const settlements = new LockSettlement(round, {
    conflictsFor,
    dkg, port: stakeLocks, curve: poolCurve, random: (n) => new Uint8Array(randomBytes(n)), stakeSecrets, winnings, finalityOf, donationSetFor, donationTargetFor, orderBook,
    peersFor: (rid) => {
      const picked = roster.committeeFor(rid, 'settlement');
      return picked.ok ? endpointsOf(picked.committee, round.pubkey) : (dkg.peers || []);
    },
    // WHOSE TURN IT IS TO COMBINE (M3.3-19): the round's beacon height and this node's chain tip, as the payout reads them.
    turnClock: {
      beaconHeight: async (rid, contract) => {
        if (typeof randomnessFor !== 'function') return null;
        const g = await randomnessFor({ contract, roundIdBytes: rid });
        return g && Number.isInteger(g.height) ? g.height : null;
      },
      tip: typeof chainTip === 'function' ? async () => Number(await chainTip()) : null,
    },
    // WHO THE FEE LOCKS PAY (Pick A): the round's sitting signer nodes, drawn from the
    // census by role - the contract's own nodes where there is no census.
    signerNodesFor: (rid, contract) => {
      const game = roster.committeeFor(rid, 'game');
      const settle = roster.committeeFor(rid, 'settlement');
      // AND THE GUARDIAN POOL (§22A v4.6.4): the census nodes guarding the round's federation; none - the two-pool table
      let guardian = [];
      try { const g = roster.guardiansFor(rid); if (g.ok) guardian = g.guardians; } catch { guardian = []; }
      // A CONFLICTED NODE EARNS NO FEE SHARE (§5A.13): named for feeSettlement, which leaves it out of `eligible`
      return { gameVerify: game.ok ? game.committee.map((e) => e.pubkey) : contract.nodes,
        settlement: settle.ok ? settle.committee.map((e) => e.pubkey) : contract.nodes, guardian,
        conflicted: [...conflictsFor(rid).conflicted.keys()] };
    },
  });


  // WHO MAY HOLD A ROUND, from the chain. The census stopped being library
  // code here: this is the daemon's only caller of it, and `chainFor` is the
  // blocks - asked for, never invented, the same way the randomness is.
  // A MARKET'S WINDOW (the owner 2026-10-11: "Der prediction market läuft immer z.B. zwischen 19:45 und 20:00. Man darf davor
  // und danach nicht am Markt teilnehmen"): an attested round on its game's period takes orders only inside it
  const marketWindowFor = (c) => {
    const f = pluginForRound(c, hosted);
    if (!f.ok || !f.attested) return null;
    const w = marketWindowOf(c, f.plugin.manifest);
    return w.ok ? w.window : null;
  };
  const liveNow = gameLive(round, { windowOf: marketWindowFor });
  const roster = new Roster(round, {
    ...(chainFor ? { chainFor } : {}),
    // The same beacon the verifier reads: one source, so a node cannot assign
    // one committee and sign results against another.
    ...(randomnessFor ? { randomnessFor } : {}),
  });
  // RESERVE SEATS (§5A.7, kanban #301): ARENA_SEATING=1 - each role draws 9 for 7 seats, the drawn sign PRESENT before
  // start - 120 s, the seated sign one SEATING certificate, and a round takes entries only with it (seating-agent.js)
  const seating = (seatingOn ?? process.env.ARENA_SEATING === '1') ? seatingAgent({ round, roster,
    sign: (digest) => schnorr.sign(digest, round.identity.secret),
    verify: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } },
    log: (m) => console.log(m), windowOf: marketWindowFor,
    // A V2 ROUND'S SEATS (2026.0.2, kanban #348): the settlement seating's certified seated set is the round's 7 signer nodes
    onSeated: (rid, role, seated) => {
      if (role !== 'settlement') return;
      // a seating that differs from the draw's first seats deals the claim key again, to the seated (dkg epoch per committee)
      if (round.seatDrawFree(rid, seated)) { console.log(`[seating] ${toHex(rid).slice(0, 16)}: v2 round, its 7 seated written in`); makeClaimKey(rid); }
    } }) : null;
  if (seating) roster.seatedFor = seating.seatedFor;
  const seatingTimer = seating ? setInterval(() => { seating.tick(); }, Number(process.env.ARENA_SEATING_TICK_MS || 2000)) : null;
  if (seatingTimer) seatingTimer.unref();

  // WHAT HEARS A ROUND CLOSING. Section 13 replays once the run is over, so
  // the close is the event and this is what listens for it. The world secret
  // is on the entry now, so the seed derives itself; what is still outside is
  // the round's randomness beacon - a future Bitcoin block hash this daemon
  // does not read yet - and a node given none runs the whole path and stops
  // there, with the refusal recorded rather than a world invented.
  // WHAT SHOWS OTHER PLAYERS' TRUCKS. Pictures only: 0.10 says a ghost is
  // never an input to anybody's simulation, and the frames it hands out came
  // out of `replay.js` like everything else that touches the core.
  const ghosts = new Ghosts(round, { plugins: hosted, ...(randomnessFor ? { randomnessFor } : {}) });

  // THE ROUND'S SETTLEMENT SIGNER NODES, OFF THE CENSUS: who holds a stake's shares
  // and who signs its payout table. The same rule the receipt pull uses, for
  // the other committee. Called at a close, when `roster` exists.
  function settlementPeers(roundIdBytes) {
    const picked = roster.committeeFor(roundIdBytes, 'settlement');
    if (!picked.ok) {
      console.error(`[custody] ${toHex(roundIdBytes).slice(0, 16)} reads no settlement signer node addresses: ${picked.why}`);
      return [];
    }
    return endpointsOf(picked.committee, round.pubkey);
  }

  const verifier = new Verifier(round, {
    plugins: hosted,
    conflictsFor,
    advertsFor: advertsFor || ((rid) => {
      const census = roster.censusFor(rid);
      return census.ok ? new Map(census.entries.map((e) => [toHex(e.pubkey), e.advert])) : null;
    }),
    ...(randomnessFor ? { randomnessFor } : {}),
    // THE SAME CHAIN THE SIGNER NODE WAS CHECKED AGAINST. A node that closes a round
    // on a beacon its own chain does not name computes a different world for
    // every player in it, so the check belongs on both doors.
    ...(chainFor ? { chainFor } : {}),
    // WHERE THE OTHER SIGNER NODES ANSWER. A contract names a committee by KEY, and a
    // key is not an address - finding one is discovery's job (25.1), not this
    // letter's - so the operator says where they are and the contract still
    // says whose signatures count.
    peers,
    // AND WHEN THE OPERATOR SAID NOTHING, THE CENSUS SAYS: the round's game
    // committee, each signer node's endpoint off the signed advertisement in its bond
    // - the same record joining reads, and the rule the payout path uses below.
    // Measured before this: both daemons of the regtest rehearsal closed with
    // peers [], so no receipt and no result could ever be fetched.
    peersFor: (roundIdBytes) => {
      const picked = roster.committeeFor(roundIdBytes, 'game');
      if (!picked.ok) {
        console.error(`[verify] ${toHex(roundIdBytes).slice(0, 16)} reads no signer node addresses: ${picked.why}`);
        return [];
      }
      return endpointsOf(picked.committee, round.pubkey);
    },
  });
  // A SETTLEMENT COMBINED WHILE THIS NODE WAS DOWN (ruled window, 2026-09-23/24): a peer's settlement row counts only if
  // its combined signature verifies under the round's claim key over the message it names.
  verifier.combinedElsewhere = async (rid) => {
    const row = round.get(rid);
    if (!row) return false;
    const held = dkg.signerNodeFor(decodeRoundContract(new Uint8Array(row.contract)).nodes);
    if (!held.ok) return false;
    const claimPk = held.pool.groupPublicKey;
    for (const peer of verifier.peersOf(rid)) {
      try {
        const r = await fetch(`${String(peer).replace(/\/+$/, '')}/lock-settlement?round=${toHex(rid)}`, { signal: AbortSignal.timeout(3000) });
        const j = await r.json();
        if ((j.state === 'SUBMITTING' || j.state === 'ACCEPTED') && j.signature && j.message
          && schnorr.verify(fromHex(j.signature), fromHex(j.message), claimPk.subarray(1))) return true;
      } catch { /* the next peer */ }
    }
    return false;
  };


  /**
   * WHAT A CLOSED ROUND MEANS FOR THE MONEY.
   *
   * The outcome word is the CORE'S - it came out of `replay.js`, which is this
   * node's one door to the simulator - and finality is the committee's, out of
   * the gather the same close set off. Neither is decided here.
   *
   * AN ENTRY NOBODY AGREED ON IS SIMPLY NOT FINAL. It is not a refusal and not
   * an error: its hold stays HELD and expires back to its player, which is
   * 23.2's default and the same answer a crash gives.
   */
  let stakes = Promise.resolve({ ok: true, actions: [], why: 'no round has closed yet' });

  /**
   * FINALITY THAT DOES NOT DEPEND ON WHO CLOSES FIRST (M3.3-25).
   *
   * A close gathers each run's results once. Measured on the regtest rehearsal
   * in both orders: the first daemon to close answered 126-171 ms before the
   * other signer node had stored that run's result, so it was left at "1 of 2 agree"
   * and its payout table at "1 of 2 signer nodes signed", and nothing asked again.
   *
   * So after a close, every stored run that is not final is gathered again from
   * the round's peers every `everyMs` - results, the same pull as the close's -
   * and while the payout table is short the round's close logic runs again
   * too. When a run turns final, THIS ROUND'S OWN CLOSE LOGIC runs again:
   * settle and cancel (a hold that moved is left alone), then the table's
   * gather and queue (a row that moved on is kept). It stops when nothing is
   * short, or when the round's objection window has passed, and says which.
   *
   * A SETTLE THAT FOUND NO PREIMAGE IS SHORT TOO (M3.3-29). Measured on the
   * rehearsal, 6 of 21: the second daemon to close was final at its own close,
   * settled, and asked the first for its share while the first was still short
   * - "no share is handed out before the result is final" - so it wrote HELD,
   * and this watch stopped, having nothing short, while lnd settled the stake
   * through the first. A final run whose settle is still HELD is now asked
   * again on the same cadence, inside the same window; the settle asks for the
   * shares again, and a hold that moved meanwhile is left alone.
   *
   * AND A RUN INSIDE ITS OBJECTION WINDOW IS WAITING (M3.3-32). The close
   * settles nothing on a PROVISIONALLY_FINAL run, so this watch keeps going
   * until that run's window has closed, then runs the close logic again - and
   * its deadline moves out to a whole window past the latest close, so a
   * settle short of shares still has as long to ask as it had before.
   */
  const finalityTimers = new Set();

  // WHERE THIS SIGNER NODE'S CLOSE OF A RUN STANDS, for a run it could not sign at its
  // close (M3.3-34): HOLDING - its peer down or unreachable, the close tried
  // again on the finality watch's cadence - until SIGNED. Served at /closing.
  // Never a refund and never a VOID: a signer node that cannot reach its peer can
  // neither form the receipted transcript nor rule out a first mark it lacks.
  // KEPT IN THE STORE and read back at start, so a restart does not forget a
  // run it was holding or how long it had been asking.
  const closing = new Map();          // `${round}:${entry}` -> state
  // THE POOL 23.2's TABLE DECIDED FOR A ROUND, as this signer node's custody last ran
  // it (M3.2 6e): `lockActions`' own figure, served on /settlement so a
  // page can show it - nobody outside the committee works it out again.
  // AND EACH SIGNER NODE'S ROW OF THAT TABLE (M3.2 6e): computePayoutTable's own rows,
  // by player key, so a winner's page can show what the round owes it.
  for (const h of round.closeHolds())
    closing.set(`${toHex(h.roundId)}:${toHex(h.entryId)}`, { round: toHex(h.roundId), entry: toHex(h.entryId),
      // a run this signer node has signed is SIGNED, whatever an older build kept
      state: h.state === 'HOLDING' && round.hasResult(h.roundId, h.entryId, round.pubkey) ? 'SIGNED' : h.state,
      attempts: h.attempts, sinceMs: h.sinceMs, lastWhy: h.lastWhy, signedMs: h.signedMs });
  const holding = (rid, eid, { why = null, tried = false, signed = false, decided = null } = {}) => {
    const k = `${toHex(rid)}:${toHex(eid)}`;
    const s = closing.get(k) || { round: toHex(rid), entry: toHex(eid), state: 'HOLDING', attempts: 0,
      sinceMs: Date.now(), lastWhy: null, signedMs: null };
    if (tried) s.attempts++;
    if (why) s.lastWhy = String(why).slice(0, 220);
    if (signed) { s.state = 'SIGNED'; s.signedMs = Date.now(); }
    // §13C's no-quorum outcome, decided after the result window: not HOLDING.
    if (decided) s.state = decided;
    closing.set(k, s);
    round.putCloseHold({ roundId: rid, entryId: eid, state: s.state, attempts: s.attempts, sinceMs: s.sinceMs,
      lastWhy: s.lastWhy, signedMs: s.signedMs });
    return s;
  };

  /**
   * ONE SUSPENDED RUN'S RE-RUN, AND THE SLASH PROOFS ONCE IT IS AUTHORITATIVE.
   * Re-runs (13A) while SUSPENDED - this signer node's own once, the other signer nodes'
   * gathered each time - and, once the re-run has made the run FINAL, files a
   * REPLAY_CONTRADICTS proof against every signer node that signed the contradicted
   * result (5A.3B step 1). Returns whether it is done.
   */
  async function rerunAndFile(rid, eid) {
    const s = resultFinality(round, rid, eid);
    if (s.state === SUSPENDED && s.runId) {
      const r = await verifier.rerun(rid, eid, Buffer.from(s.runId, 'hex'));
      console.log(`[rerun] ${toHex(eid).slice(0, 16)} ${r.ok ? `agreed ${r.agreed} of ${r.needed}` : r.why}`);
    }
    let now = resultFinality(round, rid, eid);
    // §13C AT THE RE-RUN WINDOW'S END READS THE PAIR THE PEERS HOLD TOO (RULED 2026-09-24): their records and blocks are
    // asked for first, and the outcome read again - a pair counts only if both marks sit before the window's end block.
    if (now.noQuorum && !now.secondObjection) {
      try { await verifier.pullEvidence(rid, eid); } catch { /* a peer that cannot answer shows nothing */ }
      now = resultFinality(round, rid, eid);
      // DECIDED ONCE, ON THIS SEAT'S OWN CLOCK (§13C, WINDOW-10-SPEC): written, so evidence that arrives later changes nothing.
      if (now.noQuorum && (now.state === 'VOID' || now.state === 'FORFEIT') && !round.noQuorum(eid))
        round.putNoQuorum({ entryId: eid, roundId: rid, outcome: now.state, why: now.why });
    }
    // AN ENTRY THAT ENDED VOID OR FORFEIT AFTER THE OBJECTION - §13C at the re-run window's end, or a second objection -
    // still slashes the first result's signers (ruling C steps 2 and 3, RULED the owner 2026-09-24); the watch files them
    // and stops. Already stored, they dedupe.
    if ((now.state === 'VOID' || now.state === 'FORFEIT') && (now.noQuorum || now.secondObjection)) {
      const f = await verifier.fileFirstResultSlashProofs(rid, eid);
      for (const who of f.filed) console.log(`[slash] ${toHex(eid).slice(0, 16)} filed REPLAY_CONTRADICTS against first-result signer ${who.slice(0, 16)} (${now.state})`);
      return true;
    }
    if (now.state !== FINAL || !now.contradictedRunId) return false;
    const f = await verifier.fileSlashProofs(rid, eid, Buffer.from(now.contradictedRunId, 'hex'), Buffer.from(now.runId, 'hex'));
    for (const who of f.filed) console.log(`[slash] ${toHex(eid).slice(0, 16)} filed REPLAY_CONTRADICTS against ${who.slice(0, 16)}`);
    for (const why of f.refused) console.log(`[slash] ${toHex(eid).slice(0, 16)} ${why}`);
    return true;
  }

  /**
   * AND A WATCH FOR IT, started when an objection suspends a run: the other
   * signer nodes' re-runs arrive over time, so it asks again every `everyMs` until the
   * run is decided or its budget runs out: filed + 2W and one tick, which covers §13C at
   * filed + W and the latest FINAL before filed + 2W (`finality.rerunMs` is a test aid).
   */
  const rerunTimers = new Set();

  /**
   * THE ROUND'S CLAIM KEY AS THIS SIGNER NODE HOLDS IT (33 bytes), or null: the
   * `claimKeyFor` option, else this signer node's own DKG committee key for the round.
   * One place, so the key a signer node attests (/claim-key) and the key it checks a
   * lock against (/lock) cannot be two keys.
   */
  function claimKeyOf(rid) {
    try {
      if (claimKeyFor) return claimKeyFor(rid);
      const r = round.get(rid);
      const held = r ? dkg.signerNodeFor(decodeRoundContract(new Uint8Array(r.contract)).nodes) : null;
      return held && held.ok ? held.pool.groupPublicKey : null;
    } catch { return null; }
  }

  /**
   * THE ROUND'S CLAIM KEY, MADE BY ITS OWN SIGNER NODES WHEN THEY ARE ASSIGNED TO IT.
   *
   * Measured before (TASKBOOK, W5 step 1): on a Daily 2-of-2 assigned from its
   * census with no key injected, neither signer node held a group key and /claim-key
   * answered 409 on both - nothing in the daemon ran the key generation, and a
   * run by hand found no peer ("1 of the committee's 2 signer nodes have
   * contributed"). Every lock rehearsal had injected a key. So a signer node that
   * signer nodes a round runs its half of the key generation with the same signer nodes
   * `claimKeyOf` reads, reaching the others at the endpoints the census gives
   * (the rule the verify and payout paths use). A signer node that signer nodes first holds
   * only its own contribution until the other deals, and running twice is
   * harmless by design, so it runs again - every second while the round's
   * entries are open, and at least `CLAIM_KEY_MIN_TRIES` times - until the key
   * exists. A harness that hands a key (`claimKeyFor`) makes none.
   */
  /**
   * THE ROUND'S FEDERATION IS BONDED (§23.6, P3; the owner 2026-09-15 07:33: "every guardian / node
   * must have its own bond or it may not take part. federationIsBonded stays on"). Its guardians
   * come from the federation's own config, through this signer node's stake-lock port (blwp-stake-lock
   * --mode guardians: the broadcast keys and NumPeers' threshold); the census is the one this signer node
   * derived from the chain for the round. At least the federation's threshold of its guardian keys
   * must be advertised under guardian_of[] by distinct census nodes bonded at or above the round's
   * bond_min. A signer node that reaches no federation, or another one than the round names, cannot say,
   * and signer nodes nothing.
   */
  /**
   * THE PORT OF A ROUND'S FEDERATION (kanban #348, RULED the owner 2026-10-13: "Every node serves every federation"): the home
   * port for the federation this node founded with, another federation's own (joined on first need), or null.
   */
  async function portOfRound(contract) {
    if (!stakeLocks) return null;
    if (typeof stakeLocks.forFederation !== 'function') return stakeLocks;
    return contract && contract.federationId instanceof Uint8Array ? stakeLocks.forFederation(toHex(contract.federationId)) : null;
  }
  // THE PORT OF ONE FEDERATION, BY ITS ID (2026.0.3, kanban #348): a round that takes any federation has none of its own -
  // each entry's locks are in the federation the entry names (entryFederation)
  async function portOfFederation(fid) {
    if (!stakeLocks) return null;
    if (typeof stakeLocks.forFederation !== 'function') return stakeLocks;
    return fid instanceof Uint8Array ? stakeLocks.forFederation(toHex(fid)) : null;
  }
  /** The port of a stored entry's federation (its round's, or the one it names on a round that takes any), or null. */
  async function portOfEntryBytes(stored) {
    try {
      const e = decodeEntryContract(stored);
      const row = round.get(e.roundId);
      if (!row) return null;
      const fed = entryFederation(decodeRoundContract(new Uint8Array(row.contract)), e);
      return fed.ok ? portOfFederation(fed.federationId) : null;
    } catch { return null; }
  }
  async function portOfRid(rid) {
    const row = round.get(rid instanceof Uint8Array ? rid : new Uint8Array(rid));
    if (!row) return null;
    try { return await portOfRound(decodeRoundContract(new Uint8Array(row.contract))); } catch { return null; }
  }
  const portRefusal = (contract) => `this signer node cannot reach federation ${toHex(contract.federationId).slice(0, 16)} yet`
    + `${stakeLocks && typeof stakeLocks.whyNot === 'function' && stakeLocks.whyNot(toHex(contract.federationId)) ? `: ${stakeLocks.whyNot(toHex(contract.federationId))}` : ''}`;
  async function guardiansBonded(rid, contract, fid = contract.federationId) {
    if (!stakeLocks || typeof stakeLocks.guardians !== 'function')
      return { ok: false, why: REACHES_NO_FEDERATION };
    const fport = await portOfFederation(fid);
    if (!fport) return { ok: false, why: portRefusal({ federationId: fid }) };
    // THE POSTED CONTRACT, stored or not: POST /round asks this before round.open (RULED 2026-09-25).
    // PICK B (old-series.js): series 3cfbe516's guardians are counted where their advertisements name them (154300).
    const oldSeries = isOldTestnet4Id(contract.networkId) && contract.seriesId instanceof Uint8Array && isOldTestnet4Series(contract.seriesId);
    const read = () => (oldSeries ? roster.censusFor(rid, OLD_TESTNET4_SERIES_BOND_HEIGHT, { posted: contract, asRoundsOwn: false })
      : roster.censusFor(rid, null, { posted: contract }));
    // A VIEW STILL BEING READ IS WAITED FOR, NOT ANSWERED AS NONE (TWO-GAMES-1407, measured on testnet4 2026-09-30): after a
    // restart every node refused the first paying POST /round - "no chain view for that round" - while the view's first
    // read (~2000 blocks) was in flight; the page's join then dropped a deposit that had already landed and been locked.
    // Up to VIEW_WAIT_MS for the read to come in; a view that never comes is refused as before.
    let census = read();
    for (const until = Date.now() + VIEW_WAIT_MS; !census.ok && VIEW_NOT_YET.test(census.why || '') && Date.now() < until;) {
      await new Promise((r) => setTimeout(r, 1000));
      census = read();
    }
    if (!census.ok) return census;
    let g;
    try { g = await fport.guardians(); }
    catch (e) { return { ok: false, why: `this signer node could not read its federation's guardians: ${e.message}` }; }
    if (!g || toHex(g.federationId) !== toHex(fid))
      return { ok: false, why: `this signer node reaches federation ${g ? toHex(g.federationId).slice(0, 16) : 'none'} and that round names `
        + `${toHex(fid).slice(0, 16)}, so it cannot count that federation's guardians` };
    const bonded = federationIsBonded({ federationId: fid, guardianKeys: g.keys, threshold: g.threshold,
      census: census.entries, bondMinSats: contract.bondMinSats });
    return bonded.ok ? bonded : { ok: false, why: `this signer node assigns no round on an unbonded federation (§23.6): ${bonded.why}` };
  }

  const VIEW_WAIT_MS = 180000;
  const VIEW_NOT_YET = /no chain view for that round|still reading its chain view/;

  // THE ONE REFUSAL A SIGNER NODE THAT REACHES NO FEDERATION GIVES A PAYING ROUND: guardiansBonded's, and POST /round's
  // before anything of the round exists (RULED 2026-09-25).
  const REACHES_NO_FEDERATION = 'this signer node reaches no federation to read the guardians of, so it signer nodes no round that takes a stake into one (§23.6)';

  const CLAIM_KEY_EVERY_MS = 1000;
  const CLAIM_KEY_MIN_TRIES = 30;
  const claimKeyRuns = new Set();
  function makeClaimKey(rid) {
    if (claimKeyFor || !dkg.canDeal) return;
    const row = round.get(rid);
    if (!row) return;
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const signerNodes = contract.nodes;
    // ONE RUN PER COMMITTEE, not per round (kanban #345): the claim key is the committee's (dkg.js epochFor), and an RPS grid's
    // rounds all name one committee - one run per round was 30 (a 450-round grid: 450) loops redoing the same key every
    // second; profiled at grid density, 80 % of a seat's main thread, its seating ticks 35-86 s long
    const where = dkg.epochFor(signerNodes);
    if (!where.ok) return;
    const key = toHex(where.epochId);
    if (claimKeyRuns.has(key)) return;
    // A ROUND POSTED AGAIN - a player's session opens it too - to a signer node that
    // already holds its key makes nothing: measured, the key was made twice.
    if (dkg.signerNodeFor(signerNodes).ok) return;
    const peersOf = () => {
      const found = new Set();
      for (const role of ['settlement', 'game']) {
        const picked = roster.committeeFor(rid, role);
        if (picked.ok) for (const u of endpointsOf(picked.committee, round.pubkey)) found.add(u);
      }
      return [...found];
    };
    claimKeyRuns.add(key);
    let tries = 0;
    const attempt = async () => {
      if (shuttingDown) { claimKeyRuns.delete(key); return; }
      let said;
      try { said = await dkg.run(signerNodes, peersOf()); } catch (e) { said = { ok: false, why: e.message }; }
      tries++;
      if (dkg.signerNodeFor(signerNodes).ok) {
        claimKeyRuns.delete(key);
        console.log(`[claim-key] ${key.slice(0, 16)}: this signer node holds the round's key (${tries} run(s))`);
        return;
      }
      if (tries >= CLAIM_KEY_MIN_TRIES && Date.now() >= Number(contract.entryCloseMs)) {
        claimKeyRuns.delete(key);
        console.error(`[claim-key] ${key.slice(0, 16)}: no key after ${tries} runs - ${said && said.why}`);
        return;
      }
      const t = setTimeout(attempt, CLAIM_KEY_EVERY_MS);
      if (t.unref) t.unref();
    };
    attempt();
  }
  /**
   * THE SEATS' FINAL SIGNATURES ON ONE RUN (§13A, WINDOW-10-SPEC): once this seat may sign - its window's close + 5 s
   * passed on its clock, the transcript posted, no valid objection received in time - it signs, and asks every peer for
   * its own signature, fresh (GET /final-sig). Each is checked here on arrival (protocol finalSigFault) and kept, kept
   * as evidence, or dropped. Returns whether the run is FINAL here now.
   */
  const signHere = (digest) => schnorr.sign(digest, round.identity.secret);
  function takeFinalSig(rid, eid, bytes, f = resultFinality(round, rid, eid)) {
    let x;
    try { x = decodeFinalSig(splitSignedFinalSig(bytes).body); } catch (e) { return { kept: 'refused', why: e.message }; }
    const seenMs = round.now();
    const fault = finalSigFault({ bytes, seenMs }, { roundId: rid, entryId: eid, runId: null,
      committee: round.signerNodes(rid), finalAfterMs: f.finalAfterMs ?? 0n, verify: (sg, m, k) => schnorr.verify(sg, m, k) });
    const kept = round.putFinalSig(rid, eid, x, bytes, fault, seenMs);
    if (kept === 'evidence') console.log(`[final] ${toHex(eid).slice(0, 16)} a FINAL signature of ${toHex(x.signerPubkey).slice(0, 16)} does not count: ${fault.why}`);
    return { kept, why: fault ? fault.why : null };
  }
  const drawnPeers = new Map();
  // A RUN STILL SHORT OF FINAL IS ASKED LESS OFTEN WHILE NOTHING NEW ARRIVES (the owner 2026-10-02: "Focus on lowering the
  // load"): every finality tick signed this seat's FINAL afresh (new bytes, a store write), asked all six peers and
  // verified and rewrote each answer - for every run short of five, without end; profiled on an idle testnet4 seat,
  // 6.6 % of its loop. Its own signature is signed once; a pass that gains no signature doubles the wait (5 s to 5 min),
  // one that gains resets it.
  const gatherWait = new Map();                 // round+entry hex -> { nextMs, held, waitMs }
  async function gatherFinal(rid, eid) {
    let f = resultFinality(round, rid, eid);
    if (f.state === FINAL) { gatherWait.delete(toHex(rid) + toHex(eid)); return true; }
    if (!f.signable) return false;
    const gk = toHex(rid) + toHex(eid);
    const g = gatherWait.get(gk);
    if (g && Date.now() < g.nextMs) return false;
    const heldBefore = (f.finalSigs && f.finalSigs.signed) || 0;
    const ownHex = toHex(round.pubkey);
    const signedHere = round.finalSigs(rid, eid, f.signable.runId).some((r) => toHex(r.signerPubkey) === ownHex);
    const mine = signedHere ? null : finalSignatureNow(round, rid, eid, signHere);
    if (mine) takeFinalSig(rid, eid, mine, f);
    // THE PEERS: the round's game committee off the census, or - a node whose chain view no longer reaches the round's
    // census, measured on testnet4 for rounds of the day before - the settlement committee's, then its DKG peers, as the
    // settlement itself falls back.
    // THE DRAW IS KEPT PER ROUND (ORDER-2116, profiled on the free pair): a round's committee and the addresses it draws
    // come from its census - bond adverts at its census height - and do not change; drawing them again on every watch
    // tick re-derived that census each time (a series round shares one cached census, a free round has its own), 55 % of
    // a node's loop over 43 rounds past their window. A refusal is kept ten minutes, as the chain may yet reach the census.
    // The DKG peers, the last fallback, are read fresh.
    let peersHere = verifier.peers && verifier.peers.length ? verifier.peers : [];
    if (!peersHere.length) {
      const had = drawnPeers.get(toHex(rid));
      if (had && (had.peers.length || Date.now() - had.at < 600000)) peersHere = had.peers;
      else {
        let picked = roster.committeeFor(rid, 'game');
        if (picked.ok) peersHere = endpointsOf(picked.committee, round.pubkey);
        if (!peersHere.length) { picked = roster.committeeFor(rid, 'settlement'); if (picked.ok) peersHere = endpointsOf(picked.committee, round.pubkey); }
        drawnPeers.set(toHex(rid), { at: Date.now(), peers: peersHere });
        if (drawnPeers.size > 4096) drawnPeers.delete(drawnPeers.keys().next().value);
      }
    }
    if (!peersHere.length) peersHere = dkg.peers || [];
    const ask = (peers) => Promise.all(peers.map(async (peer) => {
      try {
        const r = await fetch(`${String(peer).replace(/\/+$/, '')}/final-sig?round=${toHex(rid)}&entry=${toHex(eid)}`, { signal: AbortSignal.timeout(3000) });
        if (r.status !== 200) return;
        takeFinalSig(rid, eid, new Uint8Array(await r.arrayBuffer()), f);
      } catch { /* a peer that does not answer signs nothing here */ }
    }));
    await ask(peersHere);
    f = resultFinality(round, rid, eid);
    {
      const held = (f.finalSigs && f.finalSigs.signed) || 0;
      const waitMs = held > heldBefore || !g ? 5000 : Math.min(g.waitMs * 2, 300000);
      gatherWait.set(gk, { nextMs: Date.now() + waitMs, held, waitMs });
      if (gatherWait.size > 8192) gatherWait.delete(gatherWait.keys().next().value);
    }
    // STILL SHORT, THE DKG PEERS TOO (ORDER-2116, measured on the free pair): the addresses a round's census gives are its
    // seats' bond adverts at its census height, and a seat whose address moved since (a quick tunnel renamed) answers
    // there no more - 44 runs sat at 1 of 2 FINAL signatures while the other seat served its own in 6 ms at home.
    if (f.state !== FINAL) {
      const more = (dkg.peers || []).filter((p) => !peersHere.includes(p));
      if (more.length) { await ask(more); f = resultFinality(round, rid, eid); }
    }
    if (f.state === FINAL) console.log(`[final] ${toHex(eid).slice(0, 16)} FINAL: ${String(f.why).slice(0, 160)}`);
    await fileLateObjection(rid, eid, f);
    return f.state === FINAL;
  }
  // A LATE OBJECTION THIS SEAT HOLDS (§13A): it suspended nothing, and once the run is FINAL it is filed for slashing -
  // however the run became FINAL. Before (measured with #24's bundle check at the door, kanban #24): filed only when this
  // seat's own gathering turned it FINAL; a run turned FINAL by the other seats' signatures at /final-sig was skipped by
  // every later tick, and its late objection was never filed. Filed once: nothing again while proofs are on record.
  async function fileLateObjection(rid, eid, f) {
    if (f.state !== FINAL || !f.lateObjection || round.slashProofs(rid, eid).length) return;
    const g = await verifier.fileFirstResultSlashProofs(rid, eid);
    for (const who of g.filed) console.log(`[slash] ${toHex(eid).slice(0, 16)} late objection: filed REPLAY_CONTRADICTS against ${who.slice(0, 16)}`);
  }
  function watchRerun(rid, eid) {
    const row = round.get(rid);
    if (!row) return;
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const everyMs = finality.everyMs ?? 2000;
    // THE WATCH RUNS TO THE RE-RUN'S OWN FINAL AND A MINUTE (§13A, WINDOW-10-SPEC, RULED the owner 2026-10-01): §13C decides at
    // the round's end + 1205 s, and an agreed re-run is signed FINAL from + 1805 s - both on the round's clock, carried
    // to this watch's.
    let lastMs;
    try { lastMs = Number(windowsOf(contract).ownFinalAfterMs) + 60000; } catch { lastMs = round.now() + 3600000; }
    const until = finality.rerunMs !== undefined ? Date.now() + finality.rerunMs : null;
    const tick = async () => {
      if (shuttingDown) return;
      let done = false;
      try { await gatherFinal(rid, eid); } catch (e) { console.error(`[final] ${e.message}`); }
      try { done = await rerunAndFile(rid, eid); } catch (e) { console.error(`[rerun] ${e.message}`); }
      if (done || shuttingDown) return;
      if (until !== null ? Date.now() >= until : round.now() >= lastMs) return;
      const t = setTimeout(() => { rerunTimers.delete(t); tick(); }, everyMs);
      rerunTimers.add(t);
    };
    tick();
  }
  let shuttingDown = false;
  function watchFinality(roundIdBytes, closed, money) {
    const row = round.get(roundIdBytes);
    if (!row) return;
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const everyMs = finality.everyMs ?? 2000;
    const windowMs = finality.windowMs ?? Number(contract.objectionWindowMs);
    let until = Date.now() + windowMs;
    // PAST THE WINDOW a run still short of its signatures is still asked for,
    // backing off to `maxEveryMs` (M3.3-34).
    let every = everyMs;
    let pastWindow = false;
    const maxEveryMs = finality.maxEveryMs ?? 60000;
    const gathered = [...((closed && closed.gathered) || [])];
    const stored = ((closed && closed.replayed) || []).filter((r) => r && r.stored);
    // A RUN THIS SIGNER NODE COULD NOT SIGN AT ITS CLOSE - a peer down or unreachable -
    // is tried again on this cadence (verifier.retryClose), HOLDING meanwhile.
    // A run already decided otherwise (ENTRY_VOID) is not, and neither is one
    // this signer node has already signed: one signer node, one result. Measured: a restart
    // re-ran the close of rounds with one run short, and their signed, FINAL
    // runs came back HOLDING and were retried. A late start IS tried again
    // (M3.3-34, ruled): it is signed FORFEIT 0 once no signer node is unreachable.
    // Nor one §13C's no-quorum rule already decided (VOID or FORFEIT, after the
    // result window): that is its outcome, not a hold.
    const unsigned = ((closed && closed.replayed) || [])
      .filter((r) => r && !r.stored && !r.decided && r.entryId && !voidStands(roundIdBytes, r.entryId)
        && !round.noQuorum(r.entryId) && !round.hasResult(roundIdBytes, r.entryId, round.pubkey));
    for (const u of unsigned) holding(roundIdBytes, u.entryId, { why: u.why });
    for (const r of (closed && closed.replayed) || [])
      if (r && r.decided && r.entryId) holding(roundIdBytes, r.entryId, { why: r.why, decided: r.decided });
    let latest = money;
    const isFinal = (eid) => gathered.some((g) => g && g.ok && g.final && toHex(g.entryId) === toHex(eid));
    // NO HOLD SETTLE, NO POOL TABLE, NO POOL PAYOUT TO BE SHORT OF (§23.6, RULED 2026-09-22 22:59). Three
    // checks stood here - a settle action left HELD, a payout table short of agreement, a queued payout not
    // seen paid - and all three read what the hold-invoice close used to return. A lock round's close
    // returns none of it: its money moves in the one settlement, which has its own recovery below.
    const waitingOn = () => (latest && latest.waiting) || [];
    // A WINDOW THAT HAS CLOSED runs the close logic once for that run and that close, not on every tick after it
    // (ORDER-2116: past the window a run short only of its peers' FINAL signatures kept it running each tick).
    const dueDone = new Set();
    const dueNow = () => waitingOn().filter((w) => w.closesAtMs !== null && round.now() >= w.closesAtMs)
      .map((w) => `${w.entryId}:${w.closesAtMs}`);
    const windowDue = () => dueNow().some((k) => !dueDone.has(k));
    // A RUN THE LAST PASS LEFT WAITING THAT IS FINAL NOW - its FINAL signatures came in by POST between ticks, so no
    // gather here turned it - runs the close logic, which settles it.
    const finalSince = () => waitingOn().some((w) => {
      try { return resultFinality(round, roundIdBytes, Uint8Array.from(Buffer.from(w.entryId, 'hex'))).state === FINAL; }
      catch { return false; }
    });
    // A run whose transcript is not posted yet: the close logic runs again,
    // which posts and gathers the signer nodes' postings (P2).
    const unposted = () => waitingOn().some((w) => w.published === false);
    // A SUSPENDED RUN: the close logic runs again, which re-runs and gathers (13A).
    const suspendedShort = () => !!(latest && (latest.suspended || []).length);
    // A NO-QUORUM DECISION STILL TO COME (path 3): the money waits for it, so the
    // watch keeps asking until it lands and the table can hold the FORFEIT.
    // Measured before: the watch stopped with "still to decide", no signer node settled.
    const pendingShort = () => !!(latest && latest.pendingNoQuorum && latest.pendingNoQuorum.length);
    // A RUN AGREED 2 OF 2 BUT NOT FINAL HERE YET - the other signer node's posting or
    // its window still pending - is short too, past the window as inside it
    // (M3.3-34). Measured: a signer node that signed after the window stopped here with
    // "1 of 2 settlement signer nodes have posted" while its peer was FINAL.
    // A RUN THIS SIGNER NODE HAS DECIDED BY §13C (past its result window: VOID, or FORFEIT) is not short of
    // anything: it is asked for no more. Measured before: a signer node's watch asked with no end for a run it
    // had signed 1 of 2 after its peer decided VOID.
    const decidedHere = (eid) => !!round.noQuorum(eid);
    const notFinalYet = () => stored.some((r) => !decidedHere(r.entryId) && resultFinality(round, roundIdBytes, r.entryId).state !== 'FINAL');
    // PAST THE WINDOW THE CLOSE LOGIC RUNS AGAIN ONLY FOR A RUN WHOSE TRANSCRIPT IS NOT POSTED YET (ORDER-2116, measured
    // 2026-10-01 on the free series pair). A run posted and signed FINAL here, short only of its peers' FINAL signatures,
    // is gathered by gatherFinal on every tick below; running the whole close for it again - its postings re-checked, its
    // committee drawn again - held each node's loop 60-80 s at a time over 43 such rounds, so neither node answered the
    // other's GET /final-sig and none of them ever became FINAL. A FINAL that lands still runs it (`turned`).
    const postingShort = () => stored.some((r) => {
      if (decidedHere(r.entryId)) return false;
      const f = resultFinality(round, roundIdBytes, r.entryId);
      return f.state !== 'FINAL' && f.published !== true;
    });
    // closesAtMs is on the round's clock and `until` on this watch's, so the
    // distance is carried across rather than the number.
    const stretch = () => {
      for (const w of waitingOn())
        if (w.closesAtMs !== null) until = Math.max(until, Date.now() + (w.closesAtMs - round.now()) + windowMs);
    };
    let timer = null;
    const tick = async () => timed(`finality ${toHex(roundIdBytes).slice(0, 8)}`, () => ticked(), { over: 100 });

    // ONE ENTRY, THEN LET THE SERVER BREATHE (the owner 2026-09-18 22:5x, measured on the Daily). Each entry's close work
    // holds the loop for its own synchronous share - 381 ms at the median, 1318 ms at the worst - and this watch ran
    // them back to back: the node's own log caught a loop held 26151 ms with 134 phases totalling 64785 ms in it, and
    // none of it waiting for the machine. Nothing is served in that window, so a page at the round boundary had its
    // 8 s names call aborted and its next session starved. The work and its order are unchanged; what changes is that
    // a queued request gets its turn between entries.
    const breathe = () => new Promise((go) => setImmediate(go));

    const ticked = async () => {
      finalityTimers.delete(timer);
      if (shuttingDown) return;
      stretch();
      for (const u of [...unsigned]) {
        await breathe();
        let r;
        try { r = await verifier.retryClose(roundIdBytes, u.entryId); } catch (e) { r = { stored: false, why: e.message }; }
        if (shuttingDown) return;
        const s = holding(roundIdBytes, u.entryId, { why: r && r.stored ? `signed ${r.outcome}/${r.score}` : r && r.why,
          tried: true, signed: !!(r && r.stored), decided: r && r.decided ? r.decided : null });
        if (r && r.decided) {
          // §13C, AFTER THE RESULT WINDOW: no quorum, and the outcome is decided
          // here (VOID, or FORFEIT on proven equivocation) - asked no more.
          unsigned.splice(unsigned.indexOf(u), 1);
          console.log(`[close] ${toHex(u.entryId).slice(0, 16)} ${r.decided} after ${s.attempts} attempt(s): ${String(r.why).slice(0, 140)}`);
        } else if (r && r.stored) {
          unsigned.splice(unsigned.indexOf(u), 1);
          stored.push(r);
          const at = closed.replayed.findIndex((x) => x && toHex(x.entryId) === toHex(u.entryId));
          if (at >= 0) closed.replayed[at] = r;
          console.log(`[close] ${toHex(u.entryId).slice(0, 16)} signed ${r.outcome}/${r.score} after ${s.attempts} attempt(s)`);
        } else if (s.attempts === 1 || s.attempts % 30 === 0) {
          console.log(`[close] ${toHex(u.entryId).slice(0, 16)} HOLDING (attempt ${s.attempts}): ${String(r && r.why).slice(0, 140)}`);
        }
      }
      const short = stored.filter((r) => !isFinal(r.entryId) && !decidedHere(r.entryId));
      if (!short.length && !unsigned.length && !waitingOn().length && !suspendedShort()
        && !notFinalYet() && !pendingShort()) return;
      if (Date.now() >= until && (unsigned.length || short.length || notFinalYet() || pendingShort())) {
        // THE WINDOW IS FOR OBJECTIONS, NOT FOR ABANDONING 2 OF 2 (M3.3-34).
        // Measured before: the watch stopped here, and a signer node whose peer came
        // back after it never signed and never gathered - stuck at 1 of 2. A
        // run unsigned here or short of final keeps being asked for, backing
        // off; only the one transcript every signer node can reach is ever signed.
        if (!pastWindow)
          console.log(`[close] ${toHex(roundIdBytes).slice(0, 16)} past the window with ${unsigned.length} run(s) unsigned here `
            + `and ${short.length} short of final: still asking, backing off to ${Math.round(maxEveryMs / 1000)} s`);
        pastWindow = true;
        every = Math.min(every * 2, maxEveryMs);
      } else if (Date.now() >= until) {
        console.log(`[verify] ${toHex(roundIdBytes).slice(0, 16)} the objection window passed with `
          + `${short.length} run(s) short of final`
          + `${waitingOn().length ? ' and a run still inside its objection window' : ''}`);
        return;
      }
      let turned = false;
      for (const r of short) {
        await breathe();
        let g;
        try { g = await verifier.gather(roundIdBytes, r.entryId); } catch { continue; }
        const at = gathered.findIndex((x) => x && toHex(x.entryId) === toHex(r.entryId));
        if (at >= 0) gathered[at] = g; else gathered.push(g);
        if (g && g.ok && g.final) turned = true;
        // PAST THIS SIGNER NODE'S RESULT WINDOW, a signed run no quorum can reach any more - enough signer nodes say they
        // decided it by §13C - is decided here too, on this signer node's own count (verifier.shortPastWindow).
        else if (g && g.ok) {
          let d = null;
          try { d = await verifier.shortPastWindow(roundIdBytes, r.entryId, g); } catch { d = null; }
          if (d && d.decided) {
            turned = true;
            console.log(`[close] ${toHex(r.entryId).slice(0, 16)} ${d.decided}: ${String(d.why).slice(0, 160)}`);
          }
        }
      }
      // AND THE SEATS' FINAL SIGNATURES (§13A, WINDOW-10-SPEC): every signed run not FINAL here yet, once this seat may sign.
      for (const r of stored) {
        if (decidedHere(r.entryId)) continue;
        await breathe();
        let was = null;
        let standing = null;
        try { standing = resultFinality(round, roundIdBytes, r.entryId); was = standing.state; } catch { continue; }
        if (was === FINAL) { try { await fileLateObjection(roundIdBytes, r.entryId, standing); } catch (e) { console.error(`[slash] ${e.message}`); } continue; }
        try { if (await gatherFinal(roundIdBytes, r.entryId)) turned = true; } catch (e) { console.error(`[final] ${e.message}`); }
      }
      if (shuttingDown) return;
      if (turned || windowDue() || finalSince() || unposted() || suspendedShort() || pendingShort()
        || (pastWindow && postingShort())) {
        for (const k of dueNow()) dueDone.add(k);
        stakes = settleTheStakes(roundIdBytes, { replayed: closed.replayed, gathered })
          .catch((e) => { console.error(`[verify] ${e.message}`); return { ok: false, why: e.message }; });
        latest = await stakes;
      }
      if (shuttingDown) return;
      timer = setTimeout(tick, every);
      finalityTimers.add(timer);
    };
    timer = setTimeout(tick, everyMs);
    finalityTimers.add(timer);
  }

  /**
   * WHAT A CLOSE SETS OFF: replay and gather, then the money, then the watch.
   * One function, because a close and a start that picks up a closed round
   * (M3.3-33) are the same work and must not become two paths.
   */
  function afterClose(roundIdBytes) {
    // §16 AT THE CLOSE: an entry whose on-time first mark is still short of the
    // threshold, the signer nodes it is short of offered it and silent, is ENTRY_VOID
    // with "closed" as the evidence - and the other signer nodes are shown it.
    (async () => {
      for (const { entryId } of round.entriesOf(roundIdBytes)) {
        const f = firstMarkMessage(roundIdBytes, entryId);
        if (!f || round.entryVoid(entryId)) continue;
        if (decideOutage(roundIdBytes, entryId, { evidenceKind: 'closed' })) await forwardFirstMark(f);
      }
    })().catch((e) => console.error(`[entry-void] ${e.message}`));
    stakes = timed(`close ${toHex(roundIdBytes).slice(0, 8)} settleRound`, () => verifier.settleRound(roundIdBytes))
      .then(async (closed) => {
        // A daemon taken away while it replayed acts on nothing afterwards.
        if (shuttingDown) return { ok: false, why: 'this node was shut down before its close logic ran' };
        const money = await timed(`close ${toHex(roundIdBytes).slice(0, 8)} settleTheStakes`,
          () => settleTheStakes(roundIdBytes, closed));
        watchFinality(roundIdBytes, closed, money);
        return money;
      })
      .catch((e) => { console.error(`[verify] ${e.message}`); return { ok: false, why: e.message }; });
    return stakes;
  }

  async function settleTheStakes(roundIdBytes, closed) {
    // FIRST THE TRANSCRIPTS GO WHERE ANYONE CAN REPLAY THEM (P2), whether or
    // not this node holds a stake: another signer node's finality counts this one's
    // posting. Every run the gather agreed on, each time the close logic runs.
    for (const g of (closed && closed.gathered) || []) {
      if (!(g && g.ok && g.final)) continue;
      try {
        const p = await timed(`publish ${toHex(g.entryId).slice(0, 8)}`, () => verifier.publish(roundIdBytes, g.entryId));
        for (const r of p.refused || []) console.log(`[publish] ${toHex(g.entryId).slice(0, 16)} ${r}`);
      } catch (e) { console.error(`[publish] ${e.message}`); }
    }
    // AND A SUSPENDED RESULT IS RE-RUN (13A), each time the close logic runs:
    // this signer node's own re-run once, and the other signer nodes' gathered every time.
    for (const g of (closed && closed.gathered) || []) {
      if (!(g && g.ok && g.final)) continue;
      try { await timed(`rerun ${toHex(g.entryId).slice(0, 8)}`, () => rerunAndFile(roundIdBytes, g.entryId), { over: 20 }); }
      catch (e) { console.error(`[rerun] ${e.message}`); }
    }
    const row = round.get(roundIdBytes);
    if (!row) return { ok: false, why: 'no such round' };
    const contract = decodeRoundContract(new Uint8Array(row.contract));

    const agreed = new Set((closed.gathered || [])
      .filter((g) => g && g.ok && g.final)
      .map((g) => toHex(g.entryId)));

    const entries = (closed.replayed || [])
      .filter((r) => r && r.stored && r.outcome)
      .map((r) => ({
        entryId: r.entryId, pubkey: r.playerPubkey, outcome: r.outcome,
        score: r.score, stakeMsat: r.stakeMsat, feeMsat: r.feeMsat, donationMsat: r.donationMsat,
      }));
    // A NO-QUORUM FORFEIT (§13C; M3.3-34, ruled 2026-09-13, path 3): the
    // player's proven equivocation, decided on this signer node's own record after the
    // result window - no run was carried, so no result was signed and none is
    // made up. It is a loser: FORFEIT, score 0, its stake from its own Entry
    // Contract, and its hold settles into the pool like any FORFEIT. Measured
    // before: left out of the table, its hold stayed HELD - expiring back to
    // the player - while the winner was paid its own stake from a pool of 0.
    // A no-quorum VOID stays out: nothing is forfeited (§13C).
    // Read LIVE from this signer node's store, not from `closed`: the finality watch
    // hands this the close's first snapshot again and again, and the rule
    // decides after it (measured: the snapshot's "pending" never cleared).
    // WHAT THE CLOSE MAKES OF WHAT CAME BACK - the continuation after the gathers, named so a stall in it is not "a
    // promise" (the owner 2026-09-17 19:15).
    const listed = timed(`close read its entries ${toHex(roundIdBytes).slice(0, 8)}`,
      () => new Set(entries.map((e) => toHex(e.entryId))), { over: 20 });
    const noQuorumForfeits = new Set();
    const pendingNoQuorum = [];
    for (const { entryId, entry } of round.entriesOf(roundIdBytes)) {
      const key = toHex(entryId);
      if (listed.has(key)) continue;
      const nq = round.noQuorum(entryId);
      if (nq && nq.outcome === 'FORFEIT') {
        noQuorumForfeits.add(key);
        entries.push({ entryId, pubkey: entry.playerPubkey, outcome: 'FORFEIT', score: 0,
          stakeMsat: entry.stakeMsat, feeMsat: entry.feeMsat, donationMsat: entry.donationMsat });
      } else if (!nq && (closed.replayed || []).some((r) => r && r.noQuorumPending && r.entryId && toHex(r.entryId) === key)) {
        pendingNoQuorum.push(key);
      }
    }
    // AND NOTHING MOVES WHILE THE RULE IS STILL TO DECIDE AN ENTRY: a table
    // without a FORFEIT to come would hand the winner a pool without it, and
    // the settled stake would stay with the operator. Bounded: the no-quorum
    // rule decides once the result window has passed.
    if (pendingNoQuorum.length)
      return { ok: false, why: `no stake moves while the no-quorum rule is still to decide ${pendingNoQuorum.length} entry(ies)`,
        waiting: [], suspended: [], pendingNoQuorum };
    if (!entries.length) return { ok: true, actions: [], why: 'that round produced no result to pay on' };

    // ONE PLACE DECIDES WHETHER A RUN IS FINAL, and the same answer is both
    // handed down and reported. Two - a predicate for the money and a list for
    // the operator - is two places to get it wrong, and a mutation that made
    // the predicate say yes to everything survived every test while the list
    // still said the truth.
    //
    // AND FINAL IS THE OBJECTION WINDOW'S WORD, NOT THE QUORUM'S (M3.3-32). A
    // run the threshold signed is PROVISIONALLY_FINAL; `resultFinality` says
    // FINAL once the contract's window has closed on this node's clock with no
    // valid objection, SUSPENDED if one arrived inside it. Measured before: the
    // loser settled and the winner cancelled 586-977 ms after the close of a
    // round whose contract named 3000 ms. Only a run the gather agreed on is
    // asked, so a run nobody agreed on is still simply not final.
    const standing = new Map(entries.map((e) => [toHex(e.entryId),
      agreed.has(toHex(e.entryId)) ? finalityOf(round, roundIdBytes, e.entryId) : { state: null }]));
    const stateOf = (entryId) => (standing.get(toHex(entryId)) || {}).state;
    // A no-quorum FORFEIT is final on its own record (written only after the window).
    const isFinal = (entryId) => stateOf(entryId) === FINAL || noQuorumForfeits.has(toHex(entryId));
    // ONE LINE PER SETTLE PASS, so a stake that does not move says why on the pass it did not move on.
    // §13A means nothing is final AT the close, and this is where that shows: `agreed` is the close's own
    // gather, `live` is what this node's store says right now, and when the two disagree the money is
    // being decided on the older one.
    {
      const at = round.get(roundIdBytes);
      const since = at && at.closed_ms !== null && at.closed_ms !== undefined ? round.now() - Number(at.closed_ms) : null;
      const per = entries.map((e) => {
        const k = toHex(e.entryId);
        const live = resultFinality(round, roundIdBytes, e.entryId).state;
        // (No hold= here: a hold invoice's state was the withdrawn Lightning custody's - cut 2b, RULED 2026-09-25.)
        return `${k.slice(0, 8)} ${e.outcome} agreed=${agreed.has(k) ? 'y' : 'n'} live=${live || '-'} `
          + `settle=${isFinal(e.entryId) ? 'final' : 'not-final'}`;
      });
      console.log(`[money] ${toHex(roundIdBytes).slice(0, 8)} +${since === null ? '?' : since}ms after close, `
        + `window ${contract.objectionWindowMs}ms | ${per.join(' | ')}`);
    }
    // A RUN WHOSE TRANSCRIPT IS NOT POSTED YET waits too, with no window end:
    // its window has not opened (P2).
    const waiting = entries.filter((e) => stateOf(e.entryId) === PROVISIONALLY_FINAL)
      .map((e) => {
        const s = standing.get(toHex(e.entryId));
        return { entryId: toHex(e.entryId), published: s.published !== false,
          closesAtMs: s.closesAtMs === undefined ? null : Number(s.closesAtMs), why: s.why };
      });
    const suspended = entries.filter((e) => stateOf(e.entryId) === SUSPENDED).map((e) => toHex(e.entryId));
    // THE SETTLEMENT NO LONGER WAITS ON AN ENTRY STILL IN ITS RE-RUN WINDOW (§13A, RULED the owner 2026-09-24, slice C3a):
    // SUSPENDED, or PROVISIONALLY_FINAL on a re-run, is left out of the table (`entriesOnRecord`) and the round settles
    // without it. A run inside its first objection window is still waited on.
    const waitsFor = settleWaitsOn(entries.map((e) => ({ entryId: toHex(e.entryId), ...(standing.get(toHex(e.entryId)) || {}) })));
    // EVERY ROUND SETTLES IN ITS FEDERATION (§23.6, RULED 2026-09-22 22:59: the custody field has ONE
    // value, FEDERATION). This node holds no invoice to act on - the hold-invoice settle that used to
    // follow here, and the on-chain pool payout that only ever ran after it, were the withdrawn Lightning custody's and
    // are gone with it. What is waiting is handed back and the finality watch keeps posting and
    // gathering; the forfeit waits on FINAL. Measured before (W5b): returning early here once ended
    // the watch after one pass, and the signer node that posted first never gathered the other's.
    // A LOCK ROUND'S LOSERS ARE CLAIMED (W4, the owner 2026-09-14 07:22: "a loser
    // loses the stake. The lock is claimed into the pool. Winners are paid from
    // that."): once nothing waits inside its first objection window (an entry in its re-run window is left out, C3a),
    // the signer nodes' one settlement claims every loser's lock and pays each
    // qualifier's payout contract. Measured before: nothing claimed a loser's
    // lock, and it went back to the loser at its expiry.
    let lockSettled = null;
    if (locksStake(contract) && !waitsFor.length) {
      lockSettled = await settlements.settle(roundIdBytes).catch((e) => ({ ok: false, why: e.message }));
      console.log(`[settle] ${toHex(roundIdBytes).slice(0, 16)} ${lockSettled.ok ? lockSettled.why : `nothing claimed: ${lockSettled.why}`}`);
    }
    // `ok: false` IS THE FINALITY WATCH'S SIGNAL TO KEEP GOING, as it always was on this path - a
    // lock round is settled by `settlements.settle` above, in its federation, not by this return.
    return { ok: false, why: 'a round settles in its federation: this node holds no invoice to act on',
      waiting, suspended, lockSettled };
  }

  // NO POOL PAYOUT TO RECONCILE OR SWEEP ON START (§23.6; RULED 2026-09-25). A committee pool output on chain, its
  // census peers, the reconcile of a spend this node died sending and the sweep of every round queued for one were the
  // withdrawn Lightning custody's payout, which only ever ran after its hold settle; nothing queues one any more. A
  // round's winners are paid by its lock settlement (and the winnings sends below).

  // NOTHING TO ASK LIGHTNING ON START, AND NO HELD STAKE TO RESUME (§23.6, RULED 2026-09-22 22:59).
  // Two steps used to run here first: `reconcile`, asking Lightning about any hold act this node died in
  // the middle of, and a resume of every closed round with a stake still HELD in a hold invoice. Both
  // were the withdrawn Lightning custody's and are gone with it. A lock round's restart is the two steps below: the closes
  // of runs still short of final, then the lock settlements this signer node was inside.

  // AND EVERY CLOSED ROUND WITH A RUN STILL SHORT OF FINAL HERE (M3.3-34).
  //
  // The finality watch - the retries of a close this signer node could not sign, the
  // asks for the second signature - lives in memory, and a restart used to drop
  // it for every round without a Lightning stake: a run held at 0 or 1 of 2
  // stayed there. Read off the store (results, entries), a start now runs the
  // close logic again for such a round, one at a time, after the stakes' own
  // pick-up. A run decided otherwise (ENTRY_VOID, a late start) does not count.
  const resumingCloses = Promise.resolve([]).then(async (already) => {
    const picked = [];
    for (const rid of round.closedRounds()) {
      if (shuttingDown) break;
      const key = toHex(rid);
      if ((already || []).includes(key)) continue;
      if (!round.signerNodes(rid).some((s) => toHex(s) === toHex(round.pubkey))) continue;
      const short = round.entriesOf(rid).filter(({ entryId }) => !voidStands(rid, entryId) && !round.noQuorum(entryId)
        && resultFinality(round, rid, entryId).state !== 'FINAL');
      if (!short.length) continue;
      console.log(`[close] ${key.slice(0, 16)} closed with ${short.length} run(s) short of final here: running its close logic again`);
      picked.push(key);
      await afterClose(rid);
    }
    return picked;
  }).catch((e) => { console.error(`[close] ${e.message}`); return []; });

  // AND EVERY LOCK SETTLEMENT THIS SIGNER NODE WAS INSIDE (W6, the owner 2026-09-15). Measured before: the
  // start above runs a close again only for a round with a run short of FINAL, and a lock
  // settlement happens only once every run is FINAL - so a signer node restarted inside one never asked
  // again and its row stayed SUBMITTING whether the money had moved or not. After the closes, each
  // SUBMITTING round goes through settle(), which asks the federation first; and again on a slow
  // cadence, so one whose rebuild waited on a signer node that was down is taken up once that signer node is back.
  let recoveringNow = null;
  const recoverSettlements = () => {
    if (recoveringNow || shuttingDown) return recoveringNow || Promise.resolve([]);
    recoveringNow = timed('settlement recover', () => settlements.recover())
      .then((done) => { for (const d of done) console.log(`[settle] ${d.round.slice(0, 16)} asked again: ${d.state} - ${d.why}`); return done; })
      .catch((e) => { console.error(`[settle] ${e.message}`); return []; })
      .finally(() => { recoveringNow = null; });
    return recoveringNow;
  };
  const recoveringSettlements = resumingCloses.then(() => recoverSettlements());
  // AN ATTESTED ROUND HELD BEFORE A RESTART is settled once final by the same sweep (§0A.7a slice 2)
  const attestedBoot = setTimeout(() => settleAttestedSoon(), 1000);
  if (attestedBoot.unref) attestedBoot.unref();
  const settleRecoverTimer = setInterval(() => {
    if (!shuttingDown && round.lockSettlementsIn(SUBMITTING).length) recoverSettlements();
  }, finality.maxEveryMs ?? 60000);
  // A BACKGROUND CHECK DOES NOT HOLD THE PROCESS UP: a running daemon's server does. Measured:
  // without this, a test that left a signer node open never let node --test exit.
  settleRecoverTimer.unref();
  // THE #152 BACKFILL, ONCE PER START (the owner 2026-10-07): recovered settlements whose donation-key outputs were never
  // indexed, by the same matched rebuild - two minutes in (after the start's catch-up and the recoveries above), paced.
  const donationBackfillTimer = setTimeout(() => {
    if (shuttingDown || typeof settlements.backfillDonationKeys !== 'function') return;
    recoveringSettlements.then(() => settlements.backfillDonationKeys()).catch((e) => console.error(`[settle] donation-key backfill: ${e.message}`));
  }, 120000);
  donationBackfillTimer.unref();
  // AND AGAIN ON A SLOW CLOCK (kanban #231): a recovered round whose plan could not be rebuilt yet is left unmarked; this
  // pass, every 6 h, asks only those again - no restart needed once their runs are FINAL
  let backfillingNow = null;
  const donationBackfillClock = setInterval(() => {
    if (shuttingDown || backfillingNow || typeof settlements.backfillDonationKeys !== 'function') return;
    backfillingNow = settlements.backfillDonationKeys().catch((e) => console.error(`[settle] donation-key backfill: ${e.message}`)).finally(() => { backfillingNow = null; });
  }, 6 * 3600 * 1000);
  donationBackfillClock.unref();

  // WINNINGS ARE ALWAYS SENT, WITH NO PAGE OPEN: every round holding a winning that is not PAID is visited on the same
  // clock - a send retried, an expired one re-sent through the next live gateway (winnings-send.js). Only the round's
  // proposer acts; the others answer it.
  // EACH SEND'S STATE SAID ONCE, WHEN IT CHANGES (kanban #232, the owner 2026-10-08): a held send - "the winner's invoice does
  // not stand" - is visited every minute and was said every minute, ~130 lines a minute on each testnet4 seat (its log
  // 246 MB). The same answer for the same round and entry is said once; a changed one is said again.
  let sweepingWinnings = false;
  const winningsSaid = new Map();                 // `${round}|${entry}` -> the line last said for it
  const sayOnChange = (said, key, line) => { if (said.get(key) === line) return; said.set(key, line); console.log(line); };
  const winningsTimer = setInterval(async () => {
    if (shuttingDown || sweepingWinnings || !winnings) return;
    sweepingWinnings = true;
    try {
      const unpaid = new Set();
      for (const rid of round.roundsWithUnpaidSends()) {
        const r = toHex(rid); unpaid.add(r);
        const got = await settlements.sendWinnings(rid).catch((e) => [{ ok: false, why: e.message }]);
        for (const g of got) if (!g.already) sayOnChange(winningsSaid, `${r}|${g.entry ?? ''}`, `[winnings] ${r.slice(0, 16)} ${JSON.stringify(g).slice(0, 200)}`);
      }
      // a round paid out is said no more, so its lines are let go
      for (const k of winningsSaid.keys()) if (!unpaid.has(k.slice(0, 64))) winningsSaid.delete(k);
    } finally { sweepingWinnings = false; }
  }, winningsEveryMs ?? finality.maxEveryMs ?? 60000);
  winningsTimer.unref();

  // AND EVERY LATE LOSER (§13A, RULED the owner 2026-09-24, slice C3b-1): an entry the round's settlement left out while it
  // was in its re-run window, which has since ended FINAL and FAILED, or FORFEIT, is claimed in its own second
  // settlement. Visited on a slow clock over the objected entries of rounds whose own settlement is ACCEPTED; only the
  // round's asker combines (settleLate), and an entry still in its window, VOID or a qualifier is refused there by name.
  let sweepingLate = false;
  const lateTimer = setInterval(async () => {
    if (shuttingDown || sweepingLate) return;
    sweepingLate = true;
    try {
      // THE ACCEPTED LATE SETTLEMENTS' UNPAID SENDS FIRST (C3b-2a): the asker carries each to PAID; a PAID one is left alone.
      for (const { roundId: rid, entryId: eid } of round.lateSettlementsWithUnpaidSends()) {
        if ((round.lateLockSettlement(rid, eid) || {}).state !== 'ACCEPTED') continue;
        const got = await settlements.sendLate(rid, eid).catch((e) => [{ ok: false, why: e.message }]);
        for (const g of got) if (!g.already) console.log(`[winnings] late ${toHex(eid).slice(0, 16)} ${JSON.stringify(g).slice(0, 200)}`);
      }
      for (const { roundId: rid, entryId: eid } of round.lateSettlementCandidates()) {
        const after = settlements.lockAfterSettlement(rid, eid);
        if (after.why !== 'claimed in the round\'s second settlement, not built yet' && !(round.lateLockSettlement(rid, eid) || {}).state) continue;
        const got = await settlements.settleLate(rid, eid).catch((e) => ({ ok: false, why: e.message }));
        if (got.ok && !got.kept) console.log(`[settle] ${toHex(rid).slice(0, 16)} late ${toHex(eid).slice(0, 16)}: ${got.state} - ${got.why}`);
      }
    } finally { sweepingLate = false; }
  }, finality.lateEveryMs ?? finality.maxEveryMs ?? 60000);
  lateTimer.unref();

  // AND EVERY ROUND THAT IS OVER, CLOSED BY THIS SIGNER NODE ITSELF (closeAtEnd).
  //
  // Measured before (M3.3-34): nothing on the Daily ever closed a round - only
  // a `close <round>` message does, and no launcher, opener or page sent one -
  // so no run there was ever replayed, signed or made final, a walk-away was
  // refunded at its lock's expiry and a delivery was never paid. With this on,
  // the signer node closes a round once `roundEndMs` has passed on its own clock, by
  // the very path that message takes, and at start for any round already over.
  // §15 AT THE DOOR (ALL-BUT-MIN-1727, the owner 2026-09-29 17:27: "A seated player whose stake was committed and who sent
  // no first mark is FORFEIT, score 0, at the door, not left undecided until the close"). A paying entry whose stake
  // this signer node has seen and that holds no first mark here is decided once its start window has passed - the later
  // of the round's start and the stake seen, plus the round's start deadline, plus DOOR_GRACE_MS - by the very
  // decision the close makes (verifier.retryClose): the peers' receipts carried, and FORFEIT over the empty transcript
  // only when no signer node holds a first mark and no ENTRY_VOID stands. Never ENTRY_VOID, never a refund. A signer
  // node it cannot reach still waits, as at the close. Free entries commit no stake and are left to the close.
  // THE OPEN ROUNDS, EACH CONTRACT DECODED ONCE (the owner 2026-10-02: "Focus on lowering the load as much as possible by
  // optimizing code and database of the node(s)"): the close sweep (every 2 s), the door sweep (every 5 s) and the finished
  // listing read every open round's contract out of the store and decoded it twice (openRounds' parse filter, then the
  // loop) - ~2,950 rounds held on testnet4, a series 72 h ahead. A contract never changes: ids are read, a contract only
  // the first time, and what is kept of rounds no longer open goes once it outgrows them by 500.
  const heldKept = new Map();                   // round id hex -> { c, endMs } or { bad: true }
  // an id's hex, kept for the id objects the open list below hands out again and again
  const hexOfId = new WeakMap();
  const hexId = (rid) => { let h = hexOfId.get(rid); if (h === undefined) { h = toHex(rid); hexOfId.set(rid, h); } return h; };
  const heldOf = (rid) => {
    const k = hexId(rid);
    let v = heldKept.get(k);
    if (!v) {
      const row = round.db.prepare('SELECT contract FROM rounds WHERE round_id = ?').get(rid);
      try {
        const c = decodeRoundContract(new Uint8Array(row.contract));
        let endMs = null; try { endMs = roundEndMs(c); } catch { endMs = null; }
        v = { c, endMs };
      } catch { v = { bad: true }; }
      heldKept.set(k, v);
    }
    return v;
  };
  // THE OPEN LIST READ AGAIN ONLY WHEN IT CHANGED (NODE-OPT-1648): the close sweep (2 s), the door sweep (5 s) and the
  // listing each read ~2,950 ids from the store and turned each into hex; a round opening or closing changes the open
  // rounds' count or their newest row, which one covering-index read tells.
  let openList = { key: null, ids: [] };
  let dashboardKept = null;   // /dashboard.json, kept 30 s
  // the dashboard's pools: the settlement's own (census committees and the round federation's guardians)
  const dashboardPools = (rid, contract) => {
    const game = roster.committeeFor(rid, 'game'); const settle = roster.committeeFor(rid, 'settlement');
    let guardian = []; try { const g = roster.guardiansFor(rid); if (g.ok) guardian = g.guardians; } catch { guardian = []; }
    return { gameVerify: game.ok ? game.committee.map((e) => e.pubkey) : contract.nodes,
      settlement: settle.ok ? settle.committee.map((e) => e.pubkey) : contract.nodes, guardian };
  };
  const openKeyQuery = () => round.db.prepare('SELECT count(*) AS n, max(rowid) AS m FROM rounds WHERE state = 0').get();
  const openHeld = () => {
    const q = openKeyQuery();
    const key = `${q.n}:${q.m}`;
    if (openList.key !== key) openList = { key, ids: round.openRoundIds() };
    const ids = openList.ids;
    if (heldKept.size > ids.length + 500) {
      const open = new Set(ids.map((r) => hexId(r)));
      for (const k of heldKept.keys()) if (!open.has(k)) heldKept.delete(k);
    }
    return ids;
  };
  const DOOR_GRACE_MS = 5000;
  let doorTimer = null;
  const doorTried = new Map();
  if (doorSweepMs > 0) {
    const doorSweep = () => timed('door sweep', () => {
      if (shuttingDown) return;
      const nowMs = round.now();
      for (const roundId of openHeld()) {
        const held = { roundId };
        const h = heldOf(roundId);
        if (h.bad) continue;
        const c = h.c;
        if (c.stakeMsat === 0n || BigInt(nowMs) < c.startTimeMs) continue;
        // NO RUN, NO FIRST MARK (kanban #344, measured on testnet4 round 4a0a77fc, 2026-10-11 20:12Z): a head-to-head round is
        // decided by its reveals and an attested market by its attestors - neither sends a first mark, so the start deadline
        // is not theirs. Swept here, both paid RPS entries were FORFEIT-signed at the door ~10 s after their stakes were seen,
        // minutes before their reveals; the h2h decide then signed DELIVERED / FAILED for the same entries.
        { const f = pluginForRound(c, hosted); if (f.ok && (f.headToHead || f.attested)) continue; }
        let deadlineMs;
        try { deadlineMs = Number(msForTicks(startDeadlineOf(c)).ms); } catch { continue; }
        for (const { entryId } of round.entriesOf(held.roundId)) {
          if (round.hasResult(held.roundId, entryId, round.pubkey) || round.firstMarkHeld(held.roundId, entryId)) continue;
          const seen = round.stakeSeen(entryId);
          if (!seen) continue;
          const door = Math.max(Number(c.startTimeMs), seen.seenMs) + deadlineMs + DOOR_GRACE_MS;
          if (nowMs < door) continue;
          const key = `${toHex(held.roundId)}:${toHex(entryId)}`;
          if (nowMs - (doorTried.get(key) || 0) < 15000) continue;
          doorTried.set(key, nowMs);
          verifier.retryClose(held.roundId, entryId).then((r) => {
            if (r && r.stored) console.log(`[door] ${key.slice(0, 16)} ${toHex(entryId).slice(0, 16)}: no first mark past the start deadline - signed at the door`);
          }).catch((e) => console.error(`[door] ${key.slice(0, 16)}: ${e.message}`));
        }
      }
    });
    doorTimer = setInterval(doorSweep, doorSweepMs);
    doorTimer.unref();
  }
  let endTimer = null;
  if (closeAtEnd) {
    const sweep = () => timed('close sweep', () => {
      if (shuttingDown) return;
      const nowMs = BigInt(round.now());
      for (const roundId of openHeld()) {
        const held = { roundId };
        const h = heldOf(roundId);
        if (h.bad || h.endMs === null) continue;
        const end = h.endMs;
        if (nowMs < end) continue;
        if (round.close(held.roundId)) {
          console.log(`[close] ${toHex(held.roundId).slice(0, 16)} is over at ${end}: closed by this signer node`);
          afterClose(held.roundId);
        }
      }
    });
    endTimer = setInterval(sweep, (closeAtEnd && closeAtEnd.everyMs) || 2000);
    sweep();
  }

  // AND EVERY ROUND OF THE NEXT 72 HOURS, WRITTEN (NODE72-1131). A series that leaves less than the 72 h lead is
  // refused at start, by name, rather than written short.
  // NOT ONE NAMING A DONATION SET OTHER THAN THE ONE IN FORCE (kanban #191): not written, not held - said once, by name
  // A DRAINING FEDERATION (kanban #276 custody succession, §23A.6 step 2): once this seat takes a network package whose
  // invite names a successor, the federation it named before is DRAINING here - no new paying round, series round, entry or
  // deposit names it; the rounds already holding stakes in it settle there. federation id hex -> { successor, sinceMs }
  const drainingFeds = new Map();
  const drainingRefusal = (contract) => {
    if (!contract || !(contract.stakeMsat > 0n) || !(contract.federationId instanceof Uint8Array)) return null;
    const d = drainingFeds.get(toHex(contract.federationId));
    // AND BY ITS GUARDIANS' OWN RECORD (§23A.4, kanban #321): DRAINING, CRITICAL, CLOSED or HALTED names no new round
    const byRecord = fedRecords ? fedRecords.draining(toHex(contract.federationId)) : null;
    if (!d && byRecord) return `federation ${toHex(contract.federationId).slice(0, 16)} is ${byRecord} by its guardians' signed record: no new round or deposit names it`;
    return d ? `federation ${toHex(contract.federationId).slice(0, 16)} is draining since ${new Date(d.sinceMs).toISOString()} (its successor is ${d.successor.slice(0, 16)}): no new round or deposit names it` : null;
  };
  const refusedSeries = new Set();
  const refuseSeries = (t) => {
    // A SERIES OF A GAME THIS NODE DOES NOT HOST (kanban #204): not written, said by name, and every round it derives
    // remembered as that game's, so entries into them are refused by the game
    if (!(t.gameId instanceof Uint8Array) || !hosted.has(toHex(t.gameId))) {
      const id = toHex(seriesId(t));
      const game = t.gameId instanceof Uint8Array ? toHex(t.gameId) : '(none)';
      if (!refusedSeries.has(id)) {
        refusedSeries.add(id);
        console.error(`[series] ${id.slice(0, 16)} not written: this node does not host game ${game.slice(0, 16)} (ARENA_GAMES; §0A.4)`);
        if (t.gameId instanceof Uint8Array) for (let i = 0; i < ROUNDS_PER_SERIES; i++) rememberRefusedGame(toHex(roundIdOf(seriesRound(t, i))), game);
      }
      return true;
    }
    const why = donationInForceRefusal(t) || drainingRefusal(t);
    if (!why) return false;
    const id = toHex(seriesId(t));
    if (!refusedSeries.has(id)) { refusedSeries.add(id); console.error(`[series] ${id.slice(0, 16)} not written: ${why}`); }
    return true;
  };
  const writers = series.filter((t) => !refuseSeries(t)).map((t) => seriesWriter(round, t));
  // A ROUND OF A SERIES IS TAKEN ONLY AS THE SERIES DERIVES IT (ALL-BUT-MIN-1727): its id H(series_id || i) of a series
  // this node holds, its index inside 0 .. round_count - 1, its entry window the derived one. Every door that takes
  // something for a round - the round itself, an entry, a lock, a settlement - asks this; a round naming no series
  // is not a series round and is not touched.
  const seriesRefusal = (contract) => { const c = seriesRoundCheck(contract, series); return c.ok ? null : c.why; };
  // A SERIES TAKEN OUT OF THE SERIES FILE (kanban #22, the owner 2026-10-06): its rounds are offered at no door - not listed,
  // not re-posted, no entry, no lock - while a stake already in one still settles (the settlement keeps seriesRefusal).
  const droppedSeries = new Set();
  const droppedRefusal = (contract) => (contract && contract.seriesId instanceof Uint8Array && droppedSeries.has(toHex(contract.seriesId))
    ? `series ${toHex(contract.seriesId).slice(0, 16)} was taken out of this node's series file: its rounds are not offered or entered` : null);
  const refuseFile = { seen: undefined, ids: new Set() };
  const fileRefusal = (contract) => {
    if (!refuseRoundsFile) return null;
    let m = null;
    try { m = statSync(refuseRoundsFile).mtimeMs; } catch { m = null; }
    if (m !== refuseFile.seen) {
      refuseFile.seen = m;
      let ids = new Set();
      try { ids = new Set(readFileSync(refuseRoundsFile, 'utf8').split(/\s+/).map((x) => x.toLowerCase()).filter((x) => /^[0-9a-f]{64}$/.test(x))); } catch { ids = new Set(); }
      refuseFile.ids = ids;
      console.log(`[refuse-rounds] ${ids.size} round(s) refused by the operator's file`);
    }
    if (!refuseFile.ids.size) return null;
    const id = toHex(roundIdOf(contract));
    return refuseFile.ids.has(id) ? `this signer node's operator refuses round ${id.slice(0, 16)} (refuse-rounds file)` : null;
  };
  const offerRefusal = (contract) => seriesRefusal(contract) || droppedRefusal(contract) || donationInForceRefusal(contract)
    || drainingRefusal(contract) || fileRefusal(contract) || (typeof refusedFor === 'function' ? refusedFor(contract) : null);
  const seriesRefusalOfRound = (rid) => {
    const row = rid ? round.get(rid) : null;
    if (!row) return null;
    let c;
    try { c = decodeRoundContract(new Uint8Array(row.contract)); } catch { return null; }
    return seriesRefusal(c);
  };
  const offerRefusalOfRound = (rid) => {
    const row = round.get(rid);
    if (!row) return null;
    let c;
    try { c = decodeRoundContract(new Uint8Array(row.contract)); } catch { return null; }
    return offerRefusal(c);
  };
  // ROUNDS POSTED AHEAD OF THEIR BEACON, assigned once it is on the chain: a pass every 5 s, a few a pass, each kept until
  // it is assigned or ten minutes past its committee time (then it is the 409 a late post gets). A restart forgets the set;
  // the opener posts what it holds again.
  const BEACON_NOT_YET = /no beacon|no chain view|no block in this view is after|is \d+ deep and this round asks for|not yet/i;
  const awaitingBeacon = new Set();
  // AND THE ONES POSTED BEFORE A RESTART (ORDER-2116, measured on the free pair 2026-10-01): the set lived in memory only, so
  // every round the opener had posted ahead of a node's restart stayed stored, unassigned and unjoinable for good. Refilled
  // from the store: a round with no signer nodes whose committee time is less than ten minutes past.
  if (chainFor) {
    try {
      for (const r of round.db.prepare('SELECT round_id, contract FROM rounds').all()) {
        const rid = new Uint8Array(r.round_id);
        if (round.signerNodes(rid).length) continue;
        let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
        if (BigInt(round.now()) <= c.committeeTimeMs + 600000n) awaitingBeacon.add(toHex(rid));
      }
    } catch (e) { console.error(`[round] posted rounds not re-read at start: ${e.message}`); }
  }
  if (chainFor) {
    const assignLater = setInterval(() => timed('assign posted rounds', () => {
      if (shuttingDown) return;
      let done = 0;
      for (const hex of [...awaitingBeacon]) {
        if (done >= 10) break;
        const rid = new Uint8Array(Buffer.from(hex, 'hex'));
        const row = round.get(rid);
        if (!row || round.signerNodes(rid).length) { awaitingBeacon.delete(hex); continue; }
        let c; try { c = decodeRoundContract(new Uint8Array(row.contract)); } catch { awaitingBeacon.delete(hex); continue; }
        if (BigInt(round.now()) > c.committeeTimeMs + 600000n) { awaitingBeacon.delete(hex); continue; }
        if (BigInt(round.now()) < c.committeeTimeMs) continue;
        const assigned = roster.assignSignerNodes(rid);
        done++;
        if (assigned.ok) { awaitingBeacon.delete(hex); makeClaimKey(rid); console.log(`[round] ${hex.slice(0, 16)} posted ahead: signer nodes assigned at its beacon`); }
      }
    }), 5000);
    assignLater.unref();
  }
  const seriesIds = () => { const all = new Set(); for (const w of writers) for (const x of w.ids()) all.add(x); return all; };
  let seriesTimer = null;
  let seriesVersion = 0;               // bumped when a series is added or dropped while running: the listing's verdicts are read again
  const storeSeries = new Set();       // series ids an installed network package holds (kanban #276): the series file does not drop them
  const postedSeries = new Set();      // grid series ids taken at POST /series (kanban #293): the series file does not drop them either
  const takeNewSeries = () => {
    if (typeof seriesReload !== 'function') return;
    let now;
    try { now = seriesReload(); } catch (e) { console.error(`[series] the series file did not read: ${e.message} - the series held stay`); return; }
    if (!now) return;
    // A FILE NAMING NO SERIES AT ALL (caught empty mid-write) drops nothing: the series held stay
    if (!now.length) { console.error('[series] the series file names no series - the series held stay'); return; }
    const held = new Set(writers.map((w) => toHex(w.id)));
    const named = new Set();
    for (const t of now) {
      if (refuseSeries(t)) { named.add(toHex(seriesId(t))); continue; }
      let w;
      try { w = seriesWriter(round, t); } catch (e) { console.error(`[series] a new line refused: ${e.message}`); continue; }
      const id = toHex(w.id);
      named.add(id);
      if (held.has(id)) continue;
      if (droppedSeries.delete(id)) seriesVersion++;
      series.push(t); writers.push(w); held.add(id); seriesVersion++;
      console.log(`[series] ${id.slice(0, 16)}: taken from the series file without a restart`);
    }
    // AND ONE THE FILE NO LONGER NAMES IS DROPPED (kanban #22: the reload only added, and a series taken out stayed held,
    // written and listed until a restart): its writer stops, its stored rounds stay in the store but are offered nowhere
    for (let i = writers.length - 1; i >= 0; i--) {
      const id = toHex(writers[i].id);
      if (named.has(id) || storeSeries.has(id) || postedSeries.has(id)) continue;   // a network package's, or one posted: not the file's
      writers.splice(i, 1); droppedSeries.add(id); seriesVersion++;
      console.log(`[series] ${id.slice(0, 16)}: taken out of the series file - no longer held; its rounds are offered nowhere`);
    }
  };
  // THE WRITER'S TIMER, started once: at start when a series is held or a file can add one, else when the network store
  // first holds one (kanban #276: no restart)
  let seriesTimerStarted = false;
  let writeSeriesNow = null;           // the writer's pass, once its timer runs: a grid posted later is written at once (kanban #293)
  const startSeriesTimer = () => {
    if (seriesTimerStarted || shuttingDown) return;
    seriesTimerStarted = true;
    // IN SLICES OF ~150 ms (a seat's start held its loop 21-33 s here, answering no join): what is left is written on
    // the next turn of the loop, the soonest rounds first.
    let sliceQueued = false;
    const writeAll = () => timed('series writer', () => {
      if (shuttingDown) return;
      takeNewSeries();
      const until = Date.now() + 150;
      let more = false;
      // A LEAVING SEAT WRITES NO NEW SERIES ROUND (kanban #276 step 2): the rounds already written are served
      const leaving = owner && owner.leavingAtMs() !== null;
      for (const w of writers) {
        const added = leaving ? 0 : w.write(round.now(), until);
        if (w.more) more = true;
        if (added) console.log(`[series] ${toHex(w.id).slice(0, 16)}: ${added} round(s) written, ${w.summary(round.now()).ahead} ahead to +72 h`);
        // AND ITS SIGNER NODES ASSIGNED, as POST /round assigns a posted round's (the owner 2026-09-30, measured on testnet4:
        // the writer only opened series 3cfbe516's rounds, no node listed itself assigned, and the page offered none
        // of them). The rounds starting in the next two hours, a few a pass so the loop is not held; a refusal (no view
        // yet) is asked again next pass. The claim key is the committee's - made once, not per round.
        // AND ALWAYS THE SOONEST ONE, however far ahead (the owner 2026-10-01 15:25, HARD: "The nodes always serve both at
        // once. Testnet4 rounds and free rounds ... A player opening the page sees a free row and a paid testnet4 row
        // together"): measured that afternoon, series 8172fffd's first round starts 00:00Z, ~8 h out, so no node listed
        // itself assigned and the page showed the free row alone. Its entry is open from its committee time; assigned,
        // it is a joinable row at once.
        if (chainFor) {
          let done = 0;
          const next = w.soonest(round.now());
          const upcoming = w.startingWithin(round.now(), 2 * 3600 * 1000);
          for (const hex of next && !upcoming.includes(next) ? [next, ...upcoming] : upcoming) {
            if (done >= 20) break;
            // THE ASSIGNING IS SLICED TOO: measured offline, opening a restarted seat's 2,123 rounds took 121 ms - the
            // 15-28 s holds were these assignments, each reading a census from the chain (cold after a restart)
            if (Date.now() >= until) { more = true; break; }
            const rid = new Uint8Array(Buffer.from(hex, 'hex'));
            if (round.signerNodes(rid).length) continue;
            const assigned = roster.assignSignerNodes(rid);
            done++;
            if (assigned.ok) makeClaimKey(rid);
          }
        }
      }
      if (more && !sliceQueued) { sliceQueued = true; setImmediate(() => { sliceQueued = false; writeAll(); }); }
    });
    writeSeriesNow = writeAll;
    writeAll();
    seriesTimer = setInterval(writeAll, seriesEveryMs);
    seriesTimer.unref();
  };
  if (writers.length || typeof seriesReload === 'function') startSeriesTimer();

  // A GRID SERIES, POSTED ONCE PER TABLE (kanban #293, the owner 2026-10-12: "Replace the 450 round posts with one post per
  // table. Every round comes from the template; nothing is chosen per round after the beacon"). Taken only as a grid
  // (series.js gridIsValid: lead >= 45 min, at most 30 min of rounds, its own entry window), of a game this seat hosts, under
  // the donation set in force, and funded - the operator names its series id as it names a paying round's id. Its rounds
  // are written by the series writer like any series'; an entry still needs its "ARN" SERIES publication below the beacon
  // (roster.js). Answers { ok, series, rounds, held } or { ok: false, why }.
  const takeGridSeries = (t, { persist = true } = {}) => {
    if (!isGridSeries(t)) return { ok: false, code: 400, why: 'this door takes a grid series (a line naming grid, period=N and count=N)' };
    const lead = seriesLeadIsValid(t);
    if (!lead.ok) return { ok: false, code: 409, why: lead.why };
    const sid = seriesId(t), id = toHex(sid);
    if (writers.some((w) => toHex(w.id) === id)) return { ok: true, series: id, rounds: t.seriesCount, held: true };
    if (refuseSeries(t)) return { ok: false, code: 409, why: `series ${id.slice(0, 16)} is not written here: its game is not hosted, or its donation set or federation is refused` };
    if (persist && !funded({ kind: 'series', contract: { stakeMsat: t.stakeMsat, seriesIdBytes: sid }, node: fundingView }))
      return { ok: false, code: 402, why: `this node stores nothing for a series nobody has funded (series ${id.slice(0, 16)})` };
    let w;
    try { w = seriesWriter(round, t); } catch (e) { return { ok: false, code: 409, why: e.message }; }
    droppedSeries.delete(id);
    series.push(t); writers.push(w); postedSeries.add(id); seriesVersion++;
    if (persist && gridSeriesFile) {
      try { appendFileSync(gridSeriesFile, seriesLineOf(t, encodeRoundContract) + '\n'); }
      catch (e) { console.error(`[series] grid ${id.slice(0, 16)} not kept on disk: ${e.message}`); }
    }
    console.log(`[series] grid ${id.slice(0, 16)}: taken${persist ? ' at POST /series' : ' from the grid file'} - ${t.seriesCount} rounds every ${t.seriesPeriodMs} ms from ${new Date(Number(t.startTimeMs)).toISOString()}`);
    // ITS ROUNDS WRITTEN NOW, not at the writer's next pass (up to seriesEveryMs, 60 s, later - measured in series-grid-door)
    if (seriesTimerStarted && writeSeriesNow) setImmediate(writeSeriesNow); else startSeriesTimer();
    return { ok: true, series: id, rounds: t.seriesCount, held: false };
  };
  // THE GRIDS POSTED BEFORE A RESTART, read back - not one whose last entry closed a day ago
  if (gridSeriesFile && existsSync(gridSeriesFile)) {
    let lines = [];
    try { lines = readSeriesLines(readFileSync(gridSeriesFile, 'utf8')); } catch (e) { console.error(`[series] the grid file did not read: ${e.message}`); }
    for (const t of lines) {
      const lastClose = t.entryCloseMs + BigInt(t.seriesCount - 1) * t.seriesPeriodMs;
      if (BigInt(round.now()) > lastClose + 86400000n) continue;
      const got = takeGridSeries(t, { persist: false });
      if (!got.ok) console.error(`[series] a grid from the grid file refused: ${got.why}`);
    }
  }

  // THE NETWORK STORE ON THIS SEAT (kanban #276, the owner 2026-10-10: networks are updated from the owner page like games; a
  // seat's network settings are its federation invite, the donation sets in force, its series and the chain it reads). A
  // network package is taken from another seat - checked (network-check.js: each of the four against its own authority),
  // tried (every series' first and last round through this seat's own doors), kept on disk in <plugins>/networks/<network
  // id> and ACTIVATED AT ONCE: its signed sets join the sets this seat checks rounds against, its series are written and
  // held, its invite is the one GET /network hands out. One package per network id; an update replaces it.
  const networksDir = pluginsDir ? joinPath(pluginsDir, 'networks') : null;
  const baseSetIds = new Set(donationSets.map((x) => { try { return toHex(donationSetBodyId(x)); } catch { return ''; } }));
  const networksHeld = new Map();          // network id hex -> { pkg, report, seriesIds: Set, setIds: Set }
  const inviteFor = (nid) => (networksHeld.has(nid) ? networksHeld.get(nid).pkg.invite : federationInvite);
  const hostsGameHex = (id) => hosted.has(id);
  const verifyNet = (sig, msg, pub) => { try { return ed25519.verify(sig, msg, pub); } catch { return false; } };
  // THIS SEAT'S NETWORK AS A PACKAGE: its chain's network, the sets and rotations it holds, the series it holds, its invite
  const ownNetwork = (nidHex) => {
    const nid = fromHex(nidHex);
    const mine = (t) => t.networkId instanceof Uint8Array && toHex(t.networkId) === nidHex;
    const held = new Set(writers.map((w) => toHex(w.id)));
    return networkPackageOf({ chain, networkId: nid, invite: inviteFor(nidHex), sets: donationSets, rotations: donationRotations,
      series: series.filter((t) => mine(t) && held.has(toHex(seriesId(t)))) });
  };
  const chainNetworkId = () => { if (!chain) return null; const n = { 'bitcoin-regtest': NETWORK_ID_REGTEST, 'bitcoin-testnet4': NETWORK_ID_TESTNET4 }[chain]; return n ? toHex(n) : null; };
  // THE SEAT'S TRIAL: every series' first and last round derived, and each taken by this seat's own checks - the series
  // derivation, the game, core and config hosted here, and the donation set in force at its census height (with this
  // seat's own sets and the package's together) the one it names
  const networkTrial = (report) => {
    const lines = [];
    const sets = [...donationSets, ...report.sets], rots = [...donationRotations, ...report.rotations];
    const keys = donationKeysForNetworkId(fromHex(report.networkId));
    for (const t of report.series) {
      const sid = toHex(seriesId(t)), tag = sid.slice(0, 12) + '…';
      const count = Number.isInteger(t.seriesCutFrom) ? t.seriesCutFrom : (Number.isInteger(t.seriesCount) ? t.seriesCount : roundsPerSeries(t.seriesPeriodMs ?? undefined));
      let why = null;
      for (const i of [...new Set([0, count - 1])]) {
        let c; try { c = seriesRound(t, i); } catch (e) { why = `round ${i} does not derive: ${e.message}`; break; }
        const sc = seriesRoundCheck(c, [t]);
        if (!sc.ok) { why = `round ${i}: ${sc.why}`; break; }
        const pr = pluginForRound(c, hosted);
        if (!pr.ok) { why = `round ${i}: ${pr.why}`; break; }
        if (c.stakeMsat > 0n && keys) {
          const f = donationSetInForce({ networkId: c.networkId, authority: keys.authority, recovery: keys.recovery, sets, rotations: rots, height: c.censusHeight, verify: verifyNet });
          if (!f.ok || toHex(donationSetId(f.recipients)) !== toHex(c.donationSetId)) { why = `round ${i}: with this seat's own sets, serial ${f.serial} is in force at ${c.censusHeight}, not the set it names`; break; }
        }
      }
      lines.push({ check: `series ${tag} rounds pass this seat's doors`, ok: !why, detail: why || `rounds 0 and ${count - 1}: series, game ${pluginForRound(seriesRound(t, 0), hosted).plugin?.name || ''}, donation set in force` });
    }
    return lines;
  };
  const checkOnSeat = (pkg) => {
    const r = checkNetworkPackage(pkg, { verify: verifyNet, seatChain: chain, hostsGame: hostsGameHex });
    if (!r.ok) return r;
    const lines = networkTrial(r);
    r.checks.push(...lines);
    const bad = lines.find((x) => !x.ok);
    return bad ? { ...r, ok: false, why: `the trial refuses it: ${bad.detail}` } : r;
  };
  // THE FEDERATION THIS SEAT NAMED BEFORE A PACKAGE NAMING A SUCCESSOR: draining from now (§23A.6 step 2), kept beside the
  // package so the next start keeps it draining; the series naming it are no longer written
  const fedOf = (invite) => { try { return invite ? readInvite(invite).federationId : null; } catch { return null; } };
  // THE FEDERATION RECORDS (kanban #321): signed here when this node guards one, gathered from the guardians, mirrored at
  // GET /federations; gathered every ARENA_FEDERATION_RECORD_MS (10 min)
  const inviteOfFed = (fidHex) => {
    const all = [federationInvite, ...[...networksHeld.values()].map((h) => h.pkg.invite)].filter(Boolean);
    return all.find((inv) => String(fedOf(inv) || '').toLowerCase() === fidHex) || null;
  };
  // SUCCESSION (§23A.6 steps 2 and 4, kanban #325): the successor this seat was told of signs into the old federation's
  // record (DRAINING, successor_id), and the record turns CLOSED once no round this seat holds naming it is still open and
  // drain_blocks have passed since it drained - four weeks (the owner 2026-09-21), ARENA_DRAIN_MS on a test clock
  const DRAIN_MS = Number(process.env.ARENA_DRAIN_MS || 28 * 86400000);
  const openRoundNames = (fidHex) => round.openRoundIds().some((id) => { try { return toHex(decodeRoundContract(new Uint8Array(round.get(id).contract)).federationId) === fidHex; } catch { return false; } });
  // THE RESERVE (§23A.3, kanban #324): each federation's on-chain wallet, read from its guardians' wallet_summary - a
  // threshold of them naming one sum - and kept 30 s, so the seats asking at one gathering read the guardians once each
  const reserveKept = new Map();
  const reserveOf = async (fidHex, guardians) => {
    const had = reserveKept.get(fidHex);
    if (had && Date.now() - had.at < 30000) return had.r;
    const endpoints = guardians.map((g) => g.endpoint).filter(Boolean);
    const r = endpoints.length ? await readReserve({ endpoints, threshold: thresholdOfFederation(guardians.length) })
      : { ok: false, why: 'the census names no guardian endpoint for that federation' };
    reserveKept.set(fidHex, { at: Date.now(), r });
    return r;
  };
  fedRecords = federationRecords({ round, roster, inviteFor: inviteOfFed, networkId: chainNetworkId() ? fromHex(chainNetworkId()) : null, reserveOf,
    absences, abandonBlocks: (FEDERATION_CLOCKS[String(chain || '').replace(/^bitcoin-/, '')] || FEDERATION_CLOCKS.mainnet).abandonBlocks,
    departureNotice: (FEDERATION_CLOCKS[String(chain || '').replace(/^bitcoin-/, '')] || FEDERATION_CLOCKS.mainnet).departureNotice,
    leavingAtMs: () => (owner ? owner.leavingAtMs() : null),
    successorOf: (fidHex) => { const d = drainingFeds.get(fidHex); return d && d.successor ? String(d.successor) : null; },
    closedOf: (fidHex) => { const d = drainingFeds.get(fidHex); return !!d && Number(round.now()) - Number(d.sinceMs) >= DRAIN_MS && !openRoundNames(fidHex); } });
  // EVERY NODE SERVES EVERY FEDERATION (kanban #348, RULED the owner 2026-10-13): another federation's port is joined with the
  // invite its signed record carries - the records this seat mirrors for every federation its census names
  if (stakeLocks && 'inviteOf' in stakeLocks) stakeLocks.inviteOf = (fid) => fedRecords.inviteOf(fid);
  // A HALTED FEDERATION'S LIQUIDATION (§23A.5, kanban #323), mirrored at GET /liquidations, on the clocks of this seat's chain
  liquidations = createLiquidations({ records: fedRecords, clocks: FEDERATION_CLOCKS[String(chain || '').replace(/^bitcoin-/, '')] || FEDERATION_CLOCKS.mainnet,
    verify: (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } } });
  // the drain is paid (§23A.6 step 5, kanban #325): a round naming a successor shares its guardian pool with the draining predecessor's
  roster.predecessorGuardians = (fidHex) => fedRecords.predecessorGuardians(fidHex);
  const inviteFedId = (inv) => { const f = fedOf(inv); return f ? fromHex(String(f)) : null; };
  const recordTimer = setInterval(() => { fedRecords.gatherAll(inviteFedId).then((r) => { for (const x of r) if (x.ok === false) console.log(`[federations] ${String(x.federation || '').slice(0, 16)}: ${x.why}`); }, () => {}); },
    Number(process.env.ARENA_FEDERATION_RECORD_MS || 600000));
  if (recordTimer.unref) recordTimer.unref();
  const markDraining = (nid, oldFed, successor, sinceMs = round.now(), keep = true) => {
    if (!oldFed || oldFed === successor || drainingFeds.has(oldFed)) return;
    drainingFeds.set(oldFed, { successor, sinceMs });
    for (let i = writers.length - 1; i >= 0; i--) {
      const t = series.find((x) => toHex(seriesId(x)) === toHex(writers[i].id));
      if (!t || toHex(t.federationId) !== oldFed || !(t.stakeMsat > 0n)) continue;
      const id = toHex(writers[i].id);
      writers.splice(i, 1); droppedSeries.add(id); seriesVersion++;
      console.log(`[networks] series ${id.slice(0, 16)} names draining federation ${oldFed.slice(0, 16)}: no longer written or offered`);
    }
    if (keep && networksDir) {
      const file = joinPath(networksDir, nid, 'draining.json');
      let all = {}; try { all = JSON.parse(readFileSync(file, 'utf8')); } catch { all = {}; }
      all[oldFed] = { successor, sinceMs };
      writeFileSync(file, JSON.stringify(all));
    }
    console.log(`[networks] federation ${oldFed.slice(0, 16)} is draining: its successor is ${successor.slice(0, 16)} - no new round or deposit names it`);
  };
  const activateNetwork = (pkg, r) => {
    const prev = networksHeld.get(r.networkId);
    const before = fedOf(inviteFor(r.networkId));
    const setIds = new Set(prev ? prev.setIds : []);
    const have = new Set(donationSets.map((x) => toHex(donationSetBodyId(x))));
    for (const x of r.sets) { const id = toHex(donationSetBodyId(x)); if (!have.has(id)) { donationSets.push(x); have.add(id); setIds.add(id); } }
    const haveRot = new Set(donationRotations.map((x) => toHex(authorityRotationId(x))));
    for (const x of r.rotations) { const id = toHex(authorityRotationId(x)); if (!haveRot.has(id)) { donationRotations.push(x); haveRot.add(id); } }
    inForceKept.clear();
    const seriesIdsHeld = new Set(prev ? prev.seriesIds : []);
    const held = new Set(writers.map((w) => toHex(w.id)));
    for (const t of r.series) {
      const id = toHex(seriesId(t));
      seriesIdsHeld.add(id);
      if (held.has(id)) continue;
      refusedSeries.delete(id);
      if (refuseSeries(t)) continue;
      const w = seriesWriter(round, t);
      if (!series.some((x) => toHex(seriesId(x)) === id)) series.push(t);
      writers.push(w); held.add(id); storeSeries.add(id); droppedSeries.delete(id); seriesVersion++;
      console.log(`[networks] series ${id.slice(0, 16)} held from network package ${r.id.slice(0, 16)}: written from now, no restart`);
    }
    networksHeld.set(r.networkId, { pkg, report: r, seriesIds: seriesIdsHeld, setIds });
    if (before && before !== r.federationId) markDraining(r.networkId, before, r.federationId);
    if (writers.length) startSeriesTimer();
  };
  const topSerialOf = (nid) => { let top = -1n; for (const x of donationSets) if (toHex(x.networkId) === nid && x.serial > top) top = x.serial; return top; };
  async function takeNetwork({ network, from, update = false }) {
    if (!networksDir) return { ok: false, status: 409, why: 'this seat keeps no installed networks (no plugins directory)' };
    from = String(from || '').replace(/\/+$/, '');
    if (!/^[0-9a-f]{64}$/.test(network) || !/^https?:\/\//.test(from)) return { ok: false, status: 400, why: 'name a network id and the seat to take it from' };
    if (!update && networksHeld.has(network)) return { ok: false, status: 409, why: 'this seat already holds a package of that network: update it' };
    if (update && !networksHeld.has(network)) return { ok: false, status: 409, why: 'this seat holds no package of that network to update' };
    let pkg;
    try { const r = await fetch(`${from}/network?network=${network}`, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`${r.status} ${(await r.text()).trim()}`); pkg = await r.json(); }
    catch (e) { return { ok: false, status: 502, why: `that seat did not hand the network over: ${e.message}` }; }
    const v = checkOnSeat(pkg);
    // the report as JSON: its lines and ids, not the decoded sets and series (BigInts)
    const plain = (x) => ({ ...x, sets: undefined, rotations: undefined, series: undefined });
    if (!v.ok) { console.log(`[networks] refused ${network.slice(0, 16)} from ${from}: ${v.why}`); return { ...plain(v), status: 422 }; }
    if (v.networkId !== network) return { ...plain(v), ok: false, status: 422, why: `that package is network ${v.networkId.slice(0, 16)}, not ${network.slice(0, 16)}` };
    if (drainingFeds.has(v.federationId)) return { ...plain(v), ok: false, status: 422, why: `its federation ${v.federationId.slice(0, 16)} is draining here (its successor is ${drainingFeds.get(v.federationId).successor.slice(0, 16)}): a package naming it is not taken` };
    if (update) {
      const u = checkNetworkUpdate({ networkId: network, chain, topSerial: topSerialOf(network) }, v);
      if (!u.ok) return { ...plain(v), ok: false, status: 422, why: u.why };
    }
    mkdirSync(joinPath(networksDir, network), { recursive: true });
    writeFileSync(joinPath(networksDir, network, 'package.json'), JSON.stringify(pkg));
    activateNetwork(pkg, v);
    console.log(`[networks] ${update ? 'updated' : 'installed'} network ${network.slice(0, 16)} (package ${v.id.slice(0, 16)}) from ${from}: ${v.sets.length} set(s), ${v.series.length} series, federation ${String(v.federationId).slice(0, 16)} - in force now`);
    return { ...plain(v), ok: true, network, from, running: true, update,
      held: { sets: v.sets.length, series: v.series.map((t) => toHex(seriesId(t))), federationId: v.federationId } };
  }
  // A NETWORK PACKAGE OFF THIS SEAT: not while a round that depends on it - one of its series, or naming a set only it
  // brought - is unfinished here; then its series are no longer written or offered, its own sets go, its invite goes
  function removeNetwork(network) {
    const held = networksHeld.get(network);
    if (!held) return { ok: false, status: 409, why: 'only a network installed from the store can be removed here' };
    const ownSets = new Set([...held.setIds].filter((id) => !baseSetIds.has(id)));
    const ownSetRecipientIds = new Set(donationSets.filter((x) => ownSets.has(toHex(donationSetBodyId(x)))).map((x) => toHex(donationSetId(x.recipients))));
    const nowMs = round.now();
    let open = 0;
    for (const r of round.db.prepare('SELECT contract FROM rounds').all()) {
      let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
      const dep = (c.seriesId instanceof Uint8Array && held.seriesIds.has(toHex(c.seriesId))) || ownSetRecipientIds.has(toHex(c.donationSetId));
      if (!dep) continue;
      let end; try { end = Number(roundEndMs(c)); } catch { end = Number(c.entryCloseMs); }
      if (nowMs < end + Number(c.objectionWindowMs)) open++;
    }
    if (open) return { ok: false, status: 409, why: `${open} round(s) that depend on that network package are not finished on this seat: it is removed once they are` };
    for (let i = writers.length - 1; i >= 0; i--) {
      const id = toHex(writers[i].id);
      if (!held.seriesIds.has(id) || !storeSeries.has(id)) continue;
      writers.splice(i, 1); storeSeries.delete(id); droppedSeries.add(id); seriesVersion++;
    }
    for (let i = donationSets.length - 1; i >= 0; i--) if (ownSets.has(toHex(donationSetBodyId(donationSets[i])))) donationSets.splice(i, 1);
    inForceKept.clear();
    networksHeld.delete(network);
    renameSync(joinPath(networksDir, network), joinPath(networksDir, `.removed-${Date.now()}-${network}`));
    console.log(`[networks] removed network ${network.slice(0, 16)}`);
    return { ok: true, network, removed: true };
  }
  // A DRAIN NAMED AT START (kanban #325, the succession regtest): ARENA_DRAINING=<old federation hex>:<successor hex>[,...] -
  // what an installed network package's draining.json says, as a seat setting
  for (const pair of String(process.env.ARENA_DRAINING || '').split(',').filter(Boolean)) {
    const [oldFed, successor] = pair.split(':').map((x) => String(x || '').toLowerCase());
    if (/^[0-9a-f]{64}$/.test(oldFed) && /^[0-9a-f]{64}$/.test(successor)) { markDraining(null, oldFed, successor, round.now(), false); console.log(`[networks] federation ${oldFed.slice(0, 16)} is draining into ${successor.slice(0, 16)} (ARENA_DRAINING)`); }
  }
  // THE INSTALLED NETWORKS AT START: each checked and tried again before it is held (a package that no longer stands is not)
  if (networksDir && existsSync(networksDir)) {
    for (const id of readdirSync(networksDir).filter((x) => /^[0-9a-f]{64}$/.test(x))) {
      let pkg; try { pkg = JSON.parse(readFileSync(joinPath(networksDir, id, 'package.json'), 'utf8')); } catch (e) { console.error(`[networks] ${id.slice(0, 16)}: ${e.message}`); continue; }
      try { for (const [fed, d] of Object.entries(JSON.parse(readFileSync(joinPath(networksDir, id, 'draining.json'), 'utf8')))) markDraining(id, fed, d.successor, d.sinceMs, false); } catch { /* none draining */ }
      const v = checkOnSeat(pkg);
      if (!v.ok || v.networkId !== id) { console.error(`[networks] installed network ${id.slice(0, 16)} refused: ${v.why || 'another network id'}`); continue; }
      activateNetwork(pkg, v);
    }
  }

  // THE ANNOUNCED ROUNDS (ROUNDS-EP-1612 / ROUNDS-HTML-1617): every round held that has not ended, with ISO-8601 UTC
  // start and end and its committees as the census and the beacon draw them - the sortition a client recomputes.
  // A DRAWN COMMITTEE KEPT PER ROUND (kanban #197, the owner 2026-10-06): once the census and the beacon have drawn it, the
  // draw is fixed - it was redone for every row of every listing (2,184 of 12,750 ms of one full GET /rounds, seat 7).
  // A draw that is not made yet (`drawn: false`) is asked again next time.
  const committeeDrawn = new Map();               // round id hex -> its drawn committees
  const committeeOf = (rid) => {
    const kept = committeeDrawn.get(toHex(rid));
    if (kept) return kept;
    const drawn = committeeDraw(rid);
    // with reserve seats the committee is who the certificate seats: kept only once both roles are seated
    if (drawn.drawn && (!seating || (drawn.seated && drawn.seated.game && drawn.seated.settlement))) committeeDrawn.set(toHex(rid), drawn);
    return drawn;
  };
  const committeeDraw = (rid) => {
    const game = roster.committeeFor(rid, 'game');
    const settlement = roster.committeeFor(rid, 'settlement');
    if (!game.ok || !settlement.ok) return { drawn: false, why: (!game.ok ? game : settlement).why };
    const keys = (x) => x.committee.map((e) => toHex(e.pubkey));
    // WHAT IT WAS DRAWN FROM: the census's bond entries and its distinct node keys - a key sits once (sortition.js).
    return { drawn: true, game: keys(game), settlement: keys(settlement), eligibleEntries: game.eligible,
      // RESERVE SEATS (§5A.7): whether each role's committee is a seating certificate's, and the drawn beyond the seats
      ...(seating ? { seated: { game: game.seated, settlement: settlement.seated }, drawnCount: { game: game.drawn.length, settlement: settlement.drawn.length },
        drawn: { game: game.drawn.map((e) => toHex(e.pubkey)), settlement: settlement.drawn.map((e) => toHex(e.pubkey)) },
        equivocated: Object.values(seating.stateOf(rid)).some((x) => x && x.equivocated) } : {}),
      eligibleKeys: new Set((roster.censusFor(rid).entries || []).map((e) => toHex(e.pubkey))).size };
  };
  const listingKept = new Map();                  // GET /rounds query -> { at, json }, a large one kept 30 s
  const listingBuilding = new Map();              // GET /rounds query -> the listing being built (one at a time)
  // THE DOORS' FEDERATION FACTS, KEPT A MINUTE (ORDER-2116, measured on testnet4 2026-10-02 03:5xZ): POST /round asked the
  // lock port for the federation's gateways and fee rule on every call - a client process each, pinging the gateways - and
  // two players opening their sessions against 7 nodes queued them: POST /round 80-110 s, a session open over 7 min, the
  // round closed before the run began. Which gateways answer and what the federation charges are door preconditions that
  // change on the scale of minutes; one read in flight, kept 60 s. Settlements and sends still ask afresh.
  const keptMinute = (fn) => { let at = 0, v = null, p = null;
    return () => { if (v && Date.now() - at < 60000) return Promise.resolve(v); if (p) return p;
      p = Promise.resolve().then(fn).then((r) => { v = r; at = Date.now(); return r; }).finally(() => { p = null; }); return p; }; };
  // PER FEDERATION (kanban #348): a node serves every federation in its census, each through its own port
  const keptPer = (fn) => { const by = new Map(); return (port, key) => { if (!by.has(key)) by.set(key, keptMinute(() => fn(port))); return by.get(key)(); }; };
  const gatewaysOfPort = keptPer((port) => port.gateways());
  const feesOfPort = keptPer((port) => port.fees());
  const doorGateways = (port = stakeLocks, key = 'home') => gatewaysOfPort(port, key);
  const doorFees = (port = stakeLocks, key = 'home') => feesOfPort(port, key);
  // THE LISTING GIVES THE LOOP BACK (the owner 2026-10-04 07:15: "A seat must keep answering while it lists rounds" -
  // measured on seat 7: one uncached GET /rounds, 1709 rounds, held the loop 6368 ms and /identity waited 6383 ms). Every
  // row is signed and its committee drawn; that work now stops every LISTING_SLICE_MS and lets the loop serve what waits.
  const LISTING_SLICE_MS = 15;
  // ROW SIGNATURES SIGNED ON DEMAND, ONE WINDOW AT A TIME (kanban #232, the owner 2026-10-08; it was kanban #197's full set).
  // The page checks every row against the listing's ONE nowMs within its 60 s skew (lobby.js), so the rows of a listing are
  // signed for one time: the window's. A window is SIGN_EVERY_MS long and starts with the first listing after the last one
  // ended; a row is signed the first time a listing in that window names it, and every later listing in the window serves
  // that signature. A row whose signed facts changed since (phase, assigned here, joined, playing) is signed again for the
  // same time. Measured before (live testnet4, 2026-10-08): every ~45 s each seat signed ALL announced rows - 1,857, ~6.5 s
  // of BIP-340 in a new worker each time - about 23 of a seat's 29 % CPU, while the lobby asks for a handful (?next=1)
  // and a signature is good for 60 s. Every row stays listed; the signature format and the page's check are unchanged.
  // THE WINDOW SIGNS, THE CLOCK DECIDES (kanban #350, the owner 2026-10-12 16:47 "no rounds opens for Rps"): a listing was
  // computed at its window's time, so a round that opened after a seat's window began stayed "pending" in it - with the 8 s
  // Rock Paper Scissors grid (a round open ~75 s) seven windows up to 44 s apart left most rows at 2 of the 5 seats needed.
  // A 10 s window fixed that and cost a core per seat (measured 15:50Z: the listing-sign worker at 63 %, 99,100 signatures
  // in 45 min, load 25-28). So the window stays 45 s and is only the signed time; which rounds are listed, and each row's
  // phase, are read at the request (announcedRounds) - a row whose phase turned is signed again alone.
  const SIGN_EVERY_MS = 45000n;
  let signedSet = null;                           // { atMs: bigint, sigs: Map<id hex, {key, sig}>, committees: Map }
  const windowSet = () => {
    const now = BigInt(round.now());
    if (!signedSet || now - signedSet.atMs >= SIGN_EVERY_MS) {
      // a drawn committee of a round no longer held is let go when a window turns (it was, when a full set was signed)
      // AND WHAT THE WINDOW THAT ENDED SIGNED, said once (the number #232 is measured by)
      if (signedSet && signedSet.signed) console.log(`[listing] window of ${Number(now - signedSet.atMs) / 1000} s: ${signedSet.signed} row signature(s), ${listingSigned} since the start`);
      if (signedSet) { const held = new Set(); for (const rid of openHeld()) held.add(toHex(rid));
        for (const id of committeeDrawn.keys()) if (!held.has(id)) committeeDrawn.delete(id); }
      signedSet = { atMs: now, sigs: new Map(), committees: new Map(), signing: new Map(), signed: 0 };
    }
    return signedSet;
  };
  // THE SIGNATURES IN ONE LONG-LIVED WORKER, not on this loop (listing-sign.js)
  const signer = listingSigner(round.identity.secret);
  const rowFacts = (rid, c, nowMs) => {
    const players = round.playersOf(rid);
    return { phase: nowMs < c.committeeTimeMs ? 'pending' : 'open', assignedHere: round.signerNodes(rid).length > 0,
      joined: players.joined, playing: players.playing };
  };
  const factsKey = (f) => `${f.phase}|${f.assignedHere ? 1 : 0}|${f.joined}|${f.playing}`;
  // The window's signature of each row, signing together (one ask of the worker) the rows not yet signed for these facts.
  // Two listings in one window asking the same unsigned row share one signing.
  const windowSigs = async (set, rows) => {
    const ask = [];
    for (const r of rows) {
      const k = factsKey(r.facts), kept = set.sigs.get(r.id);
      if (kept && kept.key === k) continue;
      if (set.signing.has(`${r.id}|${k}`)) continue;
      ask.push({ r, k });
    }
    if (ask.length) {
      const job = signer.sign(ask.map(({ r }) => lobbyListingId({ roundId: r.roundId, nodePubkey: round.pubkey, nowMs: set.atMs,
        phase: r.facts.phase, assignedHere: r.facts.assignedHere, joined: r.facts.joined, playing: r.facts.playing })));
      ask.forEach(({ r, k }, i) => set.signing.set(`${r.id}|${k}`, job.then((sigs) => toHex(sigs[i]))));
      job.then((sigs) => { ask.forEach(({ r, k }, i) => { set.sigs.set(r.id, { key: k, sig: toHex(sigs[i]) }); set.signing.delete(`${r.id}|${k}`); }); },
        () => { for (const { r, k } of ask) set.signing.delete(`${r.id}|${k}`); });
      listingSigned += ask.length; set.signed += ask.length;
    }
    const out = new Map();
    for (const r of rows) {
      const k = factsKey(r.facts), kept = set.sigs.get(r.id);
      out.set(r.id, kept && kept.key === k ? kept.sig : await set.signing.get(`${r.id}|${k}`));
    }
    return out;
  };
  let listingSigned = 0;                          // signatures made since the start (the [listing] line below)
  // WHETHER A HELD ROUND IS ANNOUNCED AT ALL, and the end it is listed to - read again once the series held change
  const listable = (kept) => {
    if (kept.listedUnder !== seriesVersion) {
      // §13A, WINDOW-10-SPEC: not 600 000 ms, never listed. A ROUND OF A SERIES THIS NODE NO LONGER HOLDS IS NOT
      // ANNOUNCED (the 82/90 fork: a series replaced before it ran takes no entry at any door, so it is offered nowhere).
      kept.unlisted = kept.c.objectionWindowMs !== OBJECTION_WINDOW_MS || !!offerRefusal(kept.c);
      kept.listedEnd = kept.endMs !== null ? kept.endMs : kept.c.entryCloseMs;
      kept.listedUnder = seriesVersion;
    }
    return !kept.unlisted;
  };
  const announcedRounds = async (url) => {
    let sliceAt = performance.now();
    const yieldIfLong = async () => {
      if (performance.now() - sliceAt < LISTING_SLICE_MS) return;
      await new Promise((r) => setImmediate(r));
      sliceAt = performance.now();
    };
    // EVERY LISTING, FULL OR `next`, AT ITS WINDOW'S TIME (kanban #232): rows signed once a window, as asked
    const set = windowSet();
    const nowMs = BigInt(round.now());
    const listed = [];
    // EVERY ANNOUNCED ROUND, WITH ITS TIMES AND WHO IS RESPONSIBLE FOR IT (the owner 2026-09-28 16:12, ROUNDS-EP-1612):
    // every round this node holds that has not ended - a series' rounds 72 h ahead included - with its start and
    // end as ISO-8601 UTC and its committees as the census and the beacon draw them (Roster.committeeFor, the
    // same sortition a client recomputes), or `drawn: false` and why. `ahead` (ms, or e.g. `72h`) narrows it to
    // the rounds starting that soon; unnamed, nothing is left out. A lobby filters by its own clock.
    const aheadRaw = url.searchParams.get('ahead');
    const aheadMs = aheadRaw === null ? null : /^\d+h$/.test(aheadRaw) ? BigInt(aheadRaw.slice(0, -1)) * 3600000n : BigInt(aheadRaw);
    const iso = (ms) => new Date(Number(ms)).toISOString();
    // `next` (a count): AT MOST THAT MANY UPCOMING ROUNDS OF EACH SERIES, the soonest (the owner 2026-09-30, measured on testnet4:
    // with series 8172fffd written beside 3cfbe516, GET /rounds listed 1155 rounds, 970 KB, in 63 s - every row signed and
    // its committees asked - and the page's lobby, which waits ~10 s a node, showed no paying row). Rounds of no series are
    // all listed; unnamed, nothing is left out. Only the rows kept are signed and have their committees asked.
    const nextRaw = url.searchParams.get('next');
    const perSeries = nextRaw !== null && /^\d+$/.test(nextRaw) ? Number(nextRaw) : null;
    const candidates = [];
    // ONE DECODED CONTRACT PER ROUND FOR THE SWEEPS AND THIS LISTING ALIKE (NODE-OPT-1648): a decoded contract is ~7 KB
    // of heap, ~20 MB for the ~2,950 rounds a testnet4 seat holds, and this listing kept a second copy of each. The
    // listing's own facts - its end, and whether it is announced at all - are kept on the same entry; the second depends
    // on the series this node holds, so it is read again once a series is added (seriesVersion).
    for (const roundId of openHeld()) {
      await yieldIfLong();
      const held = { roundId };
      const kept = heldOf(roundId);
      if (kept.bad) continue;
      if (!listable(kept)) continue;
      const c = kept.c, endMs = kept.listedEnd;
      if (nowMs >= endMs) continue;   // over: announced no longer
      if (aheadMs !== null && c.startTimeMs > nowMs + aheadMs) continue;
      // ONLY THE GAMES THIS NODE HOSTS (§0A.4, kanban #204): a round stored under a game it no longer hosts is not offered
      if (!gameOfContract(c)) continue;
      candidates.push({ held, c, endMs });
    }
    if (perSeries !== null) {
      candidates.sort((x, y) => (x.c.startTimeMs < y.c.startTimeMs ? -1 : x.c.startTimeMs > y.c.startTimeMs ? 1 : 0));
      const count = new Map();
      const kept = [];
      // A ROUND WHOSE ENTRY HAS CLOSED DOES NOT TAKE AN OPEN ONE'S PLACE (kanban #350, the owner 2026-10-12 16:47: "no rounds
      // opens for Rps"): counted by start, an 8 s grid's `next` rounds were the ones already started - measured at 14:50:42Z,
      // 32 Rock Paper Scissors rounds listed, the latest entry closing 46 s ahead - and after a lobby read over the Funnel
      // (8.5 s even from the seat's own machine) the page had no round of the running grid to offer. So `next` counts the
      // rounds still open for entry, and as many closed but unfinished ones are kept beside them (a client reads the slot
      // that just closed for its result). OPEN WITH ROOM TO JOIN: measured on seat 7 after the first cut, the 8 counted open
      // rounds still closed 6..62 s ahead - the soonest first - so a round counts only while its entry stays open
      // NEXT_ROOM_MS more (a lobby read and a join); one closing sooner is kept in the second tally.
      // AND EVERY OPEN ROUND CLOSING WITHIN NEXT_SPAN_MS: a listing is signed once a window (45 s) and served until the
      // next, so seven seats answer from seven moments up to 44 s apart (measured 15:05Z: nowMs 0..44 s behind). Eight rounds
      // of an 8 s grid are 64 s, and the seven windows shared too few of them - no round had 5 of 7 seats saying it open,
      // none was joinable. Two minutes of a short grid overlap every window; a 90 s series is unchanged (8 rounds are 12 min).
      const closed = new Map();
      const NEXT_ROOM_MS = 30000;
      const NEXT_SPAN_MS = 120000;
      for (const x of candidates) {
        if (!(x.c.seriesId instanceof Uint8Array)) { kept.push(x); continue; }
        const k = toHex(x.c.seriesId);
        const roomy = Number(nowMs) + NEXT_ROOM_MS < Number(x.c.entryCloseMs);
        const tally = roomy ? count : closed;
        const n = tally.get(k) || 0;
        if (n >= perSeries && !(roomy && Number(x.c.entryCloseMs) <= Number(nowMs) + NEXT_SPAN_MS)) continue;
        tally.set(k, n + 1); kept.push(x);
      }
      candidates.length = 0; candidates.push(...kept);
    }
    const rows = [];
    for (const x of candidates) {
      await yieldIfLong();
      rows.push({ ...x, id: toHex(x.held.roundId), roundId: x.held.roundId, facts: rowFacts(x.held.roundId, x.c, nowMs) });
    }
    const sigOf = await windowSigs(set, rows);
    for (const { held, c, endMs, id, facts } of rows) {
      await yieldIfLong();
      const players = { joined: facts.joined, playing: facts.playing };
      const free = c.stakeMsat === 0n;
      let watchers = 0;
      for (const w of watching.values()) if (toHex(w.roundId) === id) watchers++;
      // §5A.5: before committee_time the lobby shows "committee: pending"
      // and offers no entry; the entry door refuses by the same rule.
      const { phase, assignedHere } = facts;
      // THE ROUND'S THRESHOLD, from its contract: 2 of 2 here, 5 of 7 on
      // mainnet. A round is playable only when that many of its signer nodes hold
      // it, so the page counts signer nodes, and this one signs what it says.
      let needed = null;
      try { needed = roundThreshold(c.gameVerifySlots); } catch { needed = null; }
      // the window's signature of this row for these facts (windowSigs)
      const sig = sigOf.get(id);
      // A MARKET is open in its window only (the owner 2026-10-11): from entry_close - period, never from its committee time
      const marketWindow = marketWindowFor(c);
      const opensMs = marketWindow && marketWindow.startMs > c.committeeTimeMs ? marketWindow.startMs : c.committeeTimeMs;
      listed.push({
        id, phase, entryOpen: nowMs >= opensMs && nowMs < c.entryCloseMs,
        ...(marketWindow ? { windowStartMs: String(marketWindow.startMs) } : {}),
        // THE ROUND'S GAME (kanban #204): its id and the name this node hosts it under
        game: gameOfContract(c),
        // AN ATTESTED ROUND'S OUTCOME (§0A.7a, kanban #206): OPEN, ATTESTED with its label, or DISPUTED; null for a replayed game
        outcome: outcomeOf(held.roundId, c),
        startTime: iso(c.startTimeMs), endTime: iso(endMs), committee: set.committees.get(id) || (() => { const k = committeeOf(held.roundId); set.committees.set(id, k); return k; })(),
        committeeTimeMs: String(c.committeeTimeMs), startTimeMs: String(c.startTimeMs),
        // THE RUN LENGTH, ANNOUNCED (the 82/90 fork, the owner 2026-10-01: "It must be part of the round announcement"):
        // the contract's blockTicks - in the signed contract this row names - and what it is in seconds.
        blockTicks: c.blockTicks, runMs: (() => { try { return String(msForTicks(c.blockTicks).ms); } catch { return null; } })(),
        entryCloseMs: String(c.entryCloseMs), stakeMsat: String(c.stakeMsat),
        // WHAT JOINING ASKS OF THE PLAYER: nothing, or a federation stake lock. There is no third
        // answer - "a Lightning payment" was the withdrawn Lightning custody's hold invoice, which does not exist (§23.6).
        free, wallet: free ? 'none' : 'federation-lock',
        assignedHere, joined: players.joined, playing: players.playing, watching: watchers,
        // AND WHAT ITS JOINED PLAYERS CHOSE TO BE CALLED - each record its
        // player's own signature (lobby-name.js), not this signer node's word.
        names: namesHeld(held.roundId),
        // WHAT A PLAYER IS WARNED OF BEFORE ENTRY (§18A.7 / §22A, kanban #316): the engine's and the game's own (its plugin's
        // roundWarnings) - advisory and not signed; a page computes the engine's itself and takes only codes it can name
        warnings: free ? [] : warningsOf(c),
        needed, signerNodes: c.nodes.length,
        // THIS SIGNER NODE'S SIGNED WORD (lobby-listing.js): round, node, time, phase,
        // joined here, and the two counts. `watching` is not signed.
        sig,
      });
    }
    listed.sort((x, y) => (x.phase === y.phase
      ? (BigInt(x.entryCloseMs) < BigInt(y.entryCloseMs) ? -1 : 1)
      : (x.phase === 'open' ? -1 : 1)));
    return { nowMs: set.atMs, listed };
  };

  const http = (tls ? (h) => createHttpsServer({ cert: tls.cert, key: tls.key }, h) : createServer)(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://node');
      // EVERY DOOR IS TIMED, so a stall inside one has a name (the owner 2026-09-17 19:15, the ghost lag: 32 of the 34
      // stalls left on the Daily had no phase name at all). The label is the path, never the query, which carries ids.
      return await timed(`door ${req.method} ${url.pathname}`, () => served(req, res, url), { over: 200 });
    } catch (e) {
      // The message is the reason - "the round is closed", "no such entry" -
      // because a node that answers "400" to everything makes a client guess.
      return text(res, 400, e.message);
    }
  });

  const served = async (req, res, url) => {
    {

      // The preflight a browser sends before a POST it cannot classify as
      // simple. Answered and nothing else: there is no state to change here.
      if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

      // WHETHER THIS NODE IS A GUARDIAN, and the endpoint a phone opens for it (its own public address).
      if (req.method === 'GET' && url.pathname === '/guardian') {
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(guardian ? { guardian: true, endpoint: guardian.endpoint } : { guardian: false }));
      }
      if (req.method === 'GET' && url.pathname === '/identity') {
        return bytes(res, 200, round.pubkey);
      }

      // /Dashboard (the owner 2026-10-01 15:44): what this node earned, spent and did, from its own store - the page, and
      // the figures it draws (kept 30 s: one reading walks every round with entries)
      if (req.method === 'GET' && (url.pathname === '/Dashboard' || url.pathname === '/dashboard')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...CORS });
        return res.end(dashboardHtml());
      }
      // THE OWNER AREA (kanban #276): the page, its crypto, and the owner's doors - each POST a request the owner signed
      if (req.method === 'GET' && (url.pathname === '/Dashboard/owner' || url.pathname === '/dashboard/owner')) {
        if (!owner) return text(res, 404, 'this node runs without an owner area');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(readFileSync(new URL('../pages/owner.html', import.meta.url)));
      }
      if (req.method === 'GET' && url.pathname === '/owner/client.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(readFileSync(new URL('../pages/owner-client.js', import.meta.url)));
      }
      // THE OPERATOR UI'S DOORS (§27A.7.7, kanban #332): a scoped bearer token, paired through the node's blwp-operator: URI
      if (url.pathname.startsWith('/operator/')) {
        if (!operatorTokens) return text(res, 404, 'this node runs without operator tokens');
        const answer = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }); return res.end(JSON.stringify(body)); };
        const scope = url.pathname === '/operator/status' ? 'read' : url.pathname === '/operator/vote' ? 'vote' : url.pathname === '/operator/config' ? 'config' : null;
        if (!scope) return answer(404, { ok: false, why: 'no such operator door (status, vote, config)' });
        const a = operatorTokens.check(req.headers.authorization, scope);
        if (!a.ok) return answer(a.status, a);
        if (scope === 'read') {
          let held = null; try { held = round.db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n; } catch { held = null; }
          return answer(200, { ok: true, node: toHex(round.pubkey), owner: owner ? owner.state() : null, roundsHeld: held,
            federations: fedRecords && fedRecords.list ? fedRecords.list().map((f) => ({ federation: f.federation, status: f.status, load: f.load ?? null })) : [] });
        }
        // THE VOTE ACTION (§27A.7.7 / §27A.7.3, kanban #332 on #329's ballot): this node's bond key signs H(proposal_id || choice)
        // and the door answers the 77-byte OP_RETURN payload ("ARN" 'V', the owner 2026-10-13). It broadcasts nothing: a vote transaction pays a fee, and no
        // operator scope moves money - the operator's own wallet sends the payload. { proposalId: 64 hex, choice: YES|NO|ABSTAIN }
        if (scope === 'vote') {
          if (req.method !== 'POST') return answer(405, { ok: false, why: 'a vote is POSTed: { proposalId, choice }' });
          let body;
          try { body = JSON.parse(Buffer.from(await read(req)).toString('utf8') || '{}'); } catch { return answer(400, { ok: false, why: 'that is not JSON' }); }
          const id = String(body.proposalId || '').toLowerCase();
          const choice = CHOICE[String(body.choice || '').toUpperCase()];
          if (!/^[0-9a-f]{64}$/.test(id)) return answer(400, { ok: false, why: 'a vote names a proposal id of 64 hex characters' });
          if (!choice) return answer(400, { ok: false, why: 'a vote is YES, NO or ABSTAIN' });
          const pid = fromHex(id);
          const signature = schnorr.sign(voteMessage(pid, choice), round.identity.secret);
          const payload = encodeVote({ proposalId: pid, choice, signature });
          console.log(`[operator] vote ${String(body.choice).toUpperCase()} on proposal ${id.slice(0, 16)} signed by this node's bond key; the operator's wallet broadcasts it`);
          return answer(200, { ok: true, node: toHex(round.pubkey), proposalId: id, choice: String(body.choice).toUpperCase(), opReturn: toHex(payload),
            broadcast: 'send it as an OP_RETURN output from your own wallet: this node moves no money (spec 27A.7.7)' });
        }
        // NOT BUILT YET, SAID BY NAME: the declarations (§27A.2) a config token edits
        return answer(501, { ok: false, scope, why: 'the declarations a config token edits (spec 27A.2 medians, delivery addresses) are not built yet' });
      }
      if (url.pathname === '/owner' || url.pathname.startsWith('/owner/')) {
        if (!owner) return text(res, 404, 'this node runs without an owner area');
        const answer = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }); return res.end(JSON.stringify(body)); };
        if (req.method === 'GET' && url.pathname === '/owner') return answer(200, owner.state());
        // THE DEV CLIENT (step 3, owner-donations.js): what this seat verified for the protocol developers' set (the newest
        // serial it holds per network) and for each hosted game's developer set - public, as GET /donations is
        // WHAT A LEAVING SEAT STILL OWES (step 2, owner-leave.js): the rounds it holds on a committee and is not free of yet,
        // and the custody check - its federation's guardians and threshold, through its stake-lock port
        if (req.method === 'GET' && url.pathname === '/owner/leave') {
          const nowMs = round.now();
          const rows = round.db.prepare('SELECT round_id, contract FROM rounds').all();
          const rounds = [];
          for (const r of rows) {
            let c; try { c = decodeRoundContract(new Uint8Array(r.contract)); } catch { continue; }
            const rid = new Uint8Array(r.round_id);
            let endMs; try { endMs = Number(roundEndMs(c)); } catch { endMs = Number(c.entryCloseMs); }
            rounds.push({ id: toHex(rid), endMs, objectionWindowMs: Number(c.objectionWindowMs), assigned: round.signerNodes(rid).length > 0,
              paying: c.stakeMsat > 0n, entries: round.entriesOf(rid).length, settlementAccepted: stateOf(round, rid) === 'ACCEPTED' });
          }
          let custody = null;
          if (guardian && stakeLocks && typeof stakeLocks.guardians === 'function') {
            try { const g = await stakeLocks.guardians(); custody = { guardian: true, keys: g.keys || [], threshold: g.threshold }; }
            catch (e) { custody = { guardian: true, keys: [], threshold: Infinity, why: e.message }; }
          }
          return answer(200, leaveStatus({ rounds, nowMs, leavingAtMs: owner.leavingAtMs(), custody }));
        }
        // THE STORE'S VIEW OF THIS SEAT (step 5): what it hosts and what is installed, waiting for its next start
        if (req.method === 'GET' && url.pathname === '/owner/plugins') {
          const installed = [];
          if (pluginsDir && existsSync(pluginsDir)) for (const id of readdirSync(pluginsDir).filter((x) => /^[0-9a-f]{64}$/.test(x))) {
            try { const p = JSON.parse(readFileSync(joinPath(pluginsDir, id, 'package.json'), 'utf8')); installed.push({ id, name: p.name, title: p.title, running: hosted.has(id) }); } catch { /* not a package */ }
          }
          return answer(200, { hosted: [...hosted.values()].map((g) => ({ id: toHex(g.gameId), name: g.name, title: g.title, version: g.manifest.version,
            devKey: toHex(g.manifest.gameDevPubkey), installed: !!(pluginsDir && existsSync(joinPath(pluginsDir, toHex(g.gameId)))), supersededBy: superseded.get(toHex(g.gameId)) || null,
            type: gameTypeOf(g.manifest), info: g.info || null })),
            installed, settings: owner.storeSettings() });
        }
        // THE NETWORK STORE'S VIEW OF THIS SEAT (kanban #276): the chain it reads, its own network's four settings, and the
        // network packages installed from the store
        if (req.method === 'GET' && url.pathname === '/owner/network') {
          const nid = chainNetworkId();
          const four = (r, invite) => ({ chain: r.chain, networkId: r.networkId, invite, federationId: r.federationId,
            sets: r.sets.map((x) => ({ serial: String(x.serial), validFrom: x.validFrom, id: toHex(donationSetBodyId(x)), recipients: x.recipients.length })),
            series: r.series.map((t) => ({ id: toHex(seriesId(t)), game: toHex(t.gameId), startMs: Number(t.startTimeMs), held: writers.some((w) => toHex(w.id) === toHex(seriesId(t))) })) });
          let own = null;
          if (nid && inviteFor(nid)) { try { const p = ownNetwork(nid); const r = checkNetworkPackage(p, { verify: verifyNet, seatChain: chain }); own = { id: p.id, ...four(r, p.invite) }; } catch (e) { own = { why: e.message }; } }
          return answer(200, { chain, networkId: nid, own,
            draining: [...drainingFeds.entries()].map(([federationId, d]) => ({ federationId, successor: d.successor, sinceMs: d.sinceMs })),
            installed: [...networksHeld.values()].map((h) => ({ network: h.report.networkId, id: h.report.id, ...four(h.report, h.pkg.invite) })) });
        }
        if (req.method === 'GET' && url.pathname === '/owner/donations') {
          const newest = new Map();
          for (const s of donationSets) { const k = toHex(s.networkId); if (!newest.has(k) || Number(s.serial) > Number(newest.get(k).serial)) newest.set(k, s); }
          return answer(200, donationReport({ protocolSets: [...newest.values()],
            games: [...hosted.values()].map((g) => ({ name: g.name, title: g.title, gameId: g.gameId, donationSet: g.donationSet })),
            rowsFor: (key) => round.donationsFor(key, 0) }));
        }
        if (req.method !== 'POST') return text(res, 404, 'no such owner door');
        let body;
        try { body = JSON.parse(Buffer.from(await read(req)).toString('utf8')); } catch { return answer(400, { ok: false, why: 'an owner request is JSON' }); }
        if (url.pathname === '/owner/claim') { const r = owner.claim(body); return answer(r.ok ? 200 : r.status, r); }
        // THE OPERATOR UI'S TOKENS (§27A.7.7, kanban #332): minted, listed and revoked by the owner's signature only
        if (url.pathname === '/owner/operator/mint' || url.pathname === '/owner/operator/revoke' || url.pathname === '/owner/operator/list') {
          if (!operatorTokens) return answer(404, { ok: false, why: 'this node runs without operator tokens' });
          const action = 'operator-' + url.pathname.split('/').pop();
          const a = owner.authorize(body, action);
          if (!a.ok) return answer(a.status, a);
          const args = body.args || {};
          if (action === 'operator-list') return answer(200, { ok: true, tokens: operatorTokens.list() });
          if (action === 'operator-revoke') { const r = operatorTokens.revoke(String(args.id || '')); return answer(r.ok ? 200 : r.status, r); }
          try { const t = operatorTokens.mint(args.scopes); return answer(200, { ok: true, id: t.id, scopes: t.scopes, uri: operatorUri({ endpoint: operatorFiles.endpoint, token: t.token }) }); }
          catch (e) { return answer(400, { ok: false, why: e.message }); }
        }
        // LEAVE AND STAY (kanban #276 step 2): signed by the owner; the status is GET /owner/leave
        if (url.pathname === '/owner/leave') { const r = owner.leave(body); return answer(r.ok ? 200 : r.status, r); }
        // INSTALL, UPDATE, REMOVE (kanban #276 step 5, the owner 2026-10-10: like an App Store, from the browser, no restart): each
        // signed by the owner; a game is fetched from another seat, checked (plugin-check.js + the trial run) and activated at once
        if (url.pathname === '/owner/plugins/install' || url.pathname === '/owner/plugins/update') {
          const action = url.pathname.endsWith('install') ? 'install' : 'update';
          const a = owner.authorize(body, action);
          if (!a.ok) return answer(a.status, a);
          const args = body.args || {};
          const r = await takeGame({ game: String(args.game || '').toLowerCase(), from: String(args.from || ''), replaces: action === 'update' ? String(args.replaces || '').toLowerCase() : null });
          return answer(r.status || (r.ok ? 200 : 422), r);
        }
        if (url.pathname === '/owner/plugins/remove') {
          const a = owner.authorize(body, 'remove');
          if (!a.ok) return answer(a.status, a);
          const r = removeGame(String((body.args && body.args.game) || '').toLowerCase());
          return answer(r.status || (r.ok ? 200 : 409), r);
        }
        // INSTALL, UPDATE, REMOVE A NETWORK PACKAGE (kanban #276): signed by the owner, checked (network-check.js + the seat's
        // trial) and in force at once
        if (url.pathname === '/owner/network/install' || url.pathname === '/owner/network/update') {
          const action = url.pathname.endsWith('install') ? 'network-install' : 'network-update';
          const a = owner.authorize(body, action);
          if (!a.ok) return answer(a.status, a);
          const args = body.args || {};
          const r = await takeNetwork({ network: String(args.network || '').toLowerCase(), from: String(args.from || ''), update: action === 'network-update' });
          return answer(r.status || (r.ok ? 200 : 422), r);
        }
        if (url.pathname === '/owner/network/remove') {
          const a = owner.authorize(body, 'network-remove');
          if (!a.ok) return answer(a.status, a);
          const r = removeNetwork(String((body.args && body.args.network) || '').toLowerCase());
          return answer(r.status || (r.ok ? 200 : 409), r);
        }
        // THE NODE'S HALF OF A COOPERATIVE KEY-PATH SPEND OF ITS BOND (kanban #307, spec 5A.3B key path: MuSig2 of the node
        // key and the arbitration aggregate). The owner's act: signed by the owner, for one session and one message; the
        // node draws its nonce once and signs once with its identity key (musig2.js; the arbitration set's half is the
        // arbiter's POST /musig/*).
        if (url.pathname === '/owner/musig/nonce' || url.pathname === '/owner/musig/partial') {
          const a = owner.authorize(body, 'musig');
          if (!a.ok) return answer(a.status, a);
          const args = body.args || {};
          if (url.pathname.endsWith('/nonce')) {
            if (!/^[0-9a-f]{64}$/.test(String(args.msg)) || !/^[0-9a-f]{64}$/.test(String(args.tweak)) || !args.sessionId) return answer(400, { ok: false, why: 'a session id, a 32-byte tweak and a 32-byte message' });
            if (musigNodeSessions.has(args.sessionId)) return answer(409, { ok: false, why: 'that session is open already' });
            const pk = Uint8Array.from([2, ...round.pubkey]);
            const drawn = musigNonceGen({ pk, sk: round.identity.secret, msg: Buffer.from(args.msg, 'hex') });
            musigNodeSessions.set(args.sessionId, { msg: args.msg, tweak: args.tweak, secnonce: drawn.secnonce, at: Date.now() });
            return answer(200, { ok: true, node: toHex(round.pubkey), pubnonce: toHex(drawn.pubnonce) });
          }
          const s = musigNodeSessions.get(args.sessionId);
          if (!s) return answer(404, { ok: false, why: 'no such session' });
          musigNodeSessions.delete(args.sessionId);              // a nonce signs once, whatever happens next
          try {
            const net = { 'bitcoin-regtest': 'regtest', 'bitcoin-testnet4': 'testnet4' }[chain];
            if (!net) return answer(409, { ok: false, why: 'this node names no chain, so no arbitration set to sign with' });
            const bctx = musigBondContext({ nodeKey: round.pubkey, arbitrationKeys: genesisFor(net).arbitrationKeys, tweak: Buffer.from(s.tweak, 'hex') });
            const psig = musigBondPartial(bctx, { who: 'node', sk: round.identity.secret, secnonce: s.secnonce, aggnonce: Buffer.from(String(args.aggnonce), 'hex'), msg: Buffer.from(s.msg, 'hex') });
            return answer(200, { ok: true, psig: toHex(psig) });
          } catch (e) { return answer(422, { ok: false, why: e.message }); }
        }
        if (url.pathname === '/owner/settings') { const r = owner.settings(body); return answer(r.ok ? 200 : r.status, r); }
        if (url.pathname === '/owner/stay') { const r = owner.stay(body); return answer(r.ok ? 200 : r.status, r); }
        if (url.pathname === '/owner/login') {
          const r = owner.authorize(body, 'login');
          if (!r.ok) return answer(r.status, r);
          return answer(200, { ok: true, node: toHex(round.pubkey), guardian: guardian ? guardian.endpoint || true : null,
            games: [...hosted.values()].map((g) => ({ id: toHex(g.gameId), name: g.name })) });
        }
        return text(res, 404, 'no such owner door');
      }
      if (req.method === 'GET' && url.pathname === '/dashboard.json') {
        const nowMs = Date.now();
        if (!dashboardKept || nowMs - dashboardKept.at > 30000) dashboardKept = { at: nowMs, body: JSON.stringify(dashboardData(round, { nowMs, poolsFor: dashboardPools, hosts: hosts ? hosts.snapshot() : null, games: hosted, matchFor: (rid) => matchOf(round, hosted, rid) })) };
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
        return res.end(dashboardKept.body);
      }

      // THE CHAIN, AS BITCOIN'S OWN BYTES. 80-byte headers back to back, which
      // is what `headersOverHttp` reads and the only shape this protocol has
      // ever spoken to a provider in - no explorer JSON, no height, no tip.
      //
      // A NODE IS NOT A CHAIN PROVIDER AND SAYS SO BY DEFAULT. 25.1 wants
      // headers "from several independent sources", and a node serving the
      // chain that proves its OWN bond is one source wearing two hats - so
      // this door does not exist unless an operator handed this daemon a view
      // to serve, and a daemon that was handed none answers 404 by name rather
      // than an empty body a client would have to interpret. Two daemons are
      // two origins, which is what `agreedChain` counts.
      if (req.method === 'GET' && url.pathname === '/headers') {
        // A FUNCTION IS READ AT THE ASK (attach, 2026-09-29): a launcher that runs no node writes it after the node is up.
        const hb = typeof headerBytes === 'function' ? headerBytes() : headerBytes;
        if (!hb)
          return text(res, 404, 'this node was given no chain to serve; a chain comes from providers');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(hb));
      }

      // AND THE BOND PROOF THE ADVERTISEMENT COMMITS TO: the transaction and
      // the merkle branch that puts it in a block of that chain. The client
      // re-derives the root and checks it against the header it agreed on, so
      // what is served here is evidence and not an answer.
      if (req.method === 'GET' && url.pathname === '/bond') {
        const bp = typeof bondProof === 'function' ? bondProof() : bondProof;
        if (!bp)
          return text(res, 404, 'this node was given no bond proof to serve');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(bp));
      }

      // AND THE BONDS OF A ROUND'S GUARDIANS (M3; the owner 07:33), out of the census this signer node derived
      // for it: each transaction and its merkle branch, for the page to prove into headers it agreed
      // from providers and count against its own federation's keys. Candidates, not a count.
      // THE ROUND'S CENSUS AS EVIDENCE (kanban #296, spec 5A.6): every bond with its merkle branch, update and
      // re-affirmation, for a client that builds the committee itself and checks the set against census_root
      // THE BALLOT'S PROPOSALS (kanban #329, proposals.js): kept when they stand and their deposit is on this seat's chain
      if (proposals && url.pathname === '/proposals' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
        return res.end(JSON.stringify({ proposals: proposals.list() }));
      }
      if (proposals && url.pathname === '/proposal' && req.method === 'POST') {
        let body; try { body = JSON.parse(Buffer.from(await read(req)).toString('utf8') || '{}'); } catch { return text(res, 400, 'that is not JSON'); }
        const got = await proposals.add(body);
        res.writeHead(got.status, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(got));
      }
      if (req.method === 'GET' && url.pathname === '/census') {
        const got = roster.censusEvidenceFor(Buffer.from(url.searchParams.get('round') || '', 'hex'));
        if (!got.ok) return text(res, 404, got.why);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', ...CORS });
        return res.end(JSON.stringify(got));
      }
      if (req.method === 'GET' && url.pathname === '/guardian-bonds') {
        const got = roster.guardianBondsFor(Buffer.from(url.searchParams.get('round') || '', 'hex'));
        if (!got.ok) return text(res, 404, got.why);
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(got));
      }

      if (req.method === 'POST' && url.pathname === '/round') {
        // A PAYING FEDERATION ROUND NAMING NO FEDERATION IS NO CONTRACT (M3 W7): the decode refuses it.
        let contract;
        try { contract = decodeRoundContract(await read(req)); }
        catch (e) { return text(res, 400, `that is not a round this signer node opens: ${e.message}`); }
        // A ROUND THAT NAMES ITS CREATOR COMES WITH THE CREATOR'S SIGNATURE OVER ITS ID (§6, kanban #313), as `?creator=<hex>`:
        // checked before anything else is asked, kept beside the round. A round this seat already holds is not asked again.
        if (contract.creatorPubkey) {
          const rid = roundIdOf(contract);
          const said = String(url.searchParams.get('creator') || '');
          const sig = /^[0-9a-f]{128}$/i.test(said) ? fromHex(said.toLowerCase()) : null;
          const st = creatorSignatureStands(contract, sig, { verify: (s, m, k) => schnorr.verify(s, m, k) });
          if (!st.ok && !(round.get(rid) && round.creatorSignature(rid))) return text(res, 403, st.why);
          if (st.ok) round.putCreatorSignature(rid, sig);
        }
        // A GAME THIS NODE DOES NOT HOST, FIRST AND BY NAME (§0A.4, kanban #204) - and remembered, so an entry into that
        // round is refused by the same game rather than as a round nobody heard of
        { const refused = unhostedRefusal(contract); if (refused) return text(res, 409, refused); }
        // A SEAT WHOSE OWNER SAID LEAVE (kanban #276 step 2) takes no round formed after it - one it already holds it serves
        if (owner && !takesRound(contract, owner.leavingAtMs()) && !round.get(roundIdOf(contract)))
          return text(res, 409, `this seat is leaving (since ${new Date(owner.leavingAtMs()).toISOString()}): it takes no new round, and serves the ones it holds`);
        { const why = offerRefusal(contract); if (why) return text(res, 409, `series round refused: ${why}`); }
        // PICK B (arena-protocol/src/old-series.js): testnet4's id before genesis_series_start opens a round of series 3cfbe516
        // and nothing else.
        if (isOldTestnet4Id(contract.networkId) && !(contract.seriesId && isOldTestnet4Series(contract.seriesId)))
          return text(res, 409, 'that round names testnet4\'s network id before genesis_series_start, and only series 3cfbe516 is taken under it');
        // Asked BEFORE anything is decoded into the database, so a refusal
        // costs a parse and nothing else.
        // A ROUND OF A SERIES THIS NODE HOLDS IS FUNDED BY THAT: the operator gave the node the series (the owner 2026-09-30,
        // measured on testnet4: a page's join posts the round, and every node answered 402 for a series 3cfbe516 round
        // it had written itself, because the funded-rounds list names rounds, not series).
        const ofHeldSeries = contract.seriesId instanceof Uint8Array && writers.some((w) => toHex(w.id) === toHex(contract.seriesId));
        if (!ofHeldSeries && !funded({ kind: 'round', contract, node: fundingView }))
          return text(res, 402, 'this node stores nothing for a round nobody has funded');
        // A ROUND ON A CORE OR CONFIG THIS SIGNER NODE DOES NOT RUN IS NOT OPENED HERE (M3 R1; the owner 08:07: each
        // round names its sim_wasm_hash and config_hash, signer nodes replay what that round names). 27A.7.5: the
        // signer node is not selectable for it - it serves nothing there, and is not slashed. Refused before
        // anything of the round exists on this signer node.
        let roundManifest = null;
        {
          const runs = pluginForRound(contract, hosted);
          if (!runs.ok) return text(res, 409, runs.why);
          roundManifest = runs.plugin.manifest;
          // A MARKET'S OWN CLOCK (kanban #236): a market naming a period closes each round at the end of a period on the UTC grid
          const clock = marketWindowOf(contract, roundManifest.resultType === 2 ? roundManifest : null);
          if (!clock.ok) return text(res, 409, clock.why);
        }
        // AND A ROUND THAT TAKES A STAKE INTO A FEDERATION IS HELD TO THE CUSTODY FIELDS IN FULL
        // (M3 W7, §23): which federation, the lock span - the ruled 144 blocks, or a market's own (lock-expiry.js, kanban
        // #236: its locks last its whole life) - the relays, before anything of it exists on this signer node. A free round
        // is the check below; no other custody parses (§23.6).
        if (contract.stakeMsat > 0n) {
          const custodyOk = custodyFieldsAreValid(contract, { manifest: roundManifest });
          if (!custodyOk.ok) return text(res, 409, custodyOk.why);
        }
        // AND A SIGNER NODE THAT REACHES NO FEDERATION OPENS NO PAYING ROUND (RULED the owner 2026-09-25). Measured before: on a
        // node with no lock port the gateway count and the base-fee guard below never ran, so a named paying round was
        // opened, stored and listed - and every entry into it was refused, the node taking no stake. Refused here, before
        // round.open, with guardiansBonded's own sentence: nothing stored, nothing listed.
        if (contract.stakeMsat > 0n && !stakeLocks) return text(res, 409, REACHES_NO_FEDERATION);
        // AND A SIGNER NODE THAT CANNOT READ THE CHAIN OPENS NO PAYING ROUND (RULED the owner 2026-09-25). Measured before: on a
        // node with a lock port and no chain view a paying round was 201, stored and listed with 0 signer nodes and no claim
        // key ("this node is not assigned to that round") - nobody could stake into it. Refused here with the census's own
        // sentence: it cannot count the federation's guardians, assign the round's signer nodes or name its beacon.
        if (contract.stakeMsat > 0n && !chainFor) return text(res, 409, NO_CHAIN_VIEW_WHY);
        // AND ITS FEDERATION HAS TWO GATEWAYS, OR IT TAKES NO STAKE HERE (§23.6: "deposits and withdrawals
        // through any of at least two gateways ... run by different operators"; RULED the owner 2026-09-23).
        // Counted through this signer node's own lock port, as the guardians are: distinct LIVE Lightning
        // node keys among the names the guardians registered - two names on one node are one gateway, a name
        // that does not answer is none. Under two, refused by name before anything of the round exists here.
        // Inbound is not read and not claimed: the federation's API does not say it, and a deposit that
        // commits through each gateway is where it is shown. A node with no lock port takes no stake in a
        // FEDERATION round at all, and is not the one this asks.
        // THE ROUND'S OWN FEDERATION'S PORT (kanban #348): every node serves every federation in its census
        // A ROUND THAT TAKES ANY FEDERATION (2026.0.3) has none to ask here: each entry's federation is asked at /entry
        const anyFed = takesAnyFederation(contract);
        const fport = contract.stakeMsat > 0n && stakeLocks && !anyFed ? await portOfRound(contract) : null;
        if (contract.stakeMsat > 0n && stakeLocks && !anyFed && !fport) return text(res, 409, portRefusal(contract));
        if (contract.stakeMsat > 0n && fport) {
          if (typeof fport.gateways !== 'function')
            return text(res, 409, 'this signer node\'s lock port cannot list the federation\'s gateways, so it cannot count '
              + 'two of them (§23.6): it opens no paying round');
          let seen;
          try { seen = await doorGateways(fport, toHex(contract.federationId)); }
          catch (e) { return text(res, 409, `this signer node could not list its federation's gateways: ${e.message}`); }
          if (!(seen.federationId instanceof Uint8Array) || toHex(seen.federationId) !== toHex(contract.federationId))
            return text(res, 409, `this signer node reaches federation ${seen.federationId instanceof Uint8Array
              ? toHex(seen.federationId).slice(0, 16) : 'none'} and that round names ${toHex(contract.federationId).slice(0, 16)}, `
              + 'so it cannot count that federation\'s gateways (§23.6)');
          const n = federationGatewayCount(seen.gateways);
          if (n.distinctLive < 2)
            return text(res, 409, `that round's federation has ${n.distinctLive} distinct live gateway(s) `
              + `(${n.registered} registered${n.notLive.length ? `, ${n.notLive.length} not answering` : ''}): a paying round `
              + 'needs at least two, run by different operators (§23.6)');
          // AND ITS FEDERATION CHARGES NO BASE FEE - the same rule `/entry` enforces (FEDERATION.md item 4; §22A; RULED
          // the owner 2026-09-25): a round whose every entry would be refused is not opened, stored or listed. The same
          // refusal sentence; an unknown rule is not a base fee.
          let noBase = { ok: true };
          try { noBase = federationTakesNoBaseFee({ fees: typeof fport.fees === 'function' ? await doorFees(fport, toHex(contract.federationId)) : null }); }
          catch (e) { return text(res, 503, `this node could not read the federation's fee rule: ${e.message}`); }
          if (!noBase.ok) return text(res, 409, noBase.why);
        }

        // AND IT NAMES THE DONATION SET IN FORCE AT ITS CENSUS HEIGHT (27A.4, a soft fork; LNURL-0822) - asked where this node
        // holds its network's sets; a round already written below a newer set's valid_from keeps the one it named.
        { const why = donationInForceRefusal(contract); if (why) return text(res, 409, why); }

        // AND ITS FEDERATION IS BONDED (§23.6, P3; RULED the owner 2026-09-25): asked here, before round.open, with
        // guardiansBonded's own refusal - measured before: under threshold and none bonded were 409 with the round already
        // stored and listed, because this was asked after round.open. A paying round reaching here has a chain view (above).
        if (chainFor && contract.stakeMsat > 0n && !anyFed) {
          const bonded = await guardiansBonded(roundIdOf(contract), contract);
          if (!bonded.ok) return text(res, 409, bonded.why);
        }

        const id = round.open(contract);
        // AND KEEP THE BEACON THIS SIGNER NODE CAN NAME FOR IT NOW (M3.3-34), through
        // the kept reader above: a signer node restarted before it ever replays a run
        // of this round still has the block to replay from.
        if (randomnessFor) { try { randomnessFor({ contract, roundIdBytes: new Uint8Array(id) }); } catch { /* none yet */ } }

        // AND ASSIGN ITS SIGNER NODES FROM THE CHAIN, when this node can see one. The assigned
        // set is the only committee that counts (26), so a contract naming
        // anybody the census did not assign is refused HERE - the round is
        // stored, and it has no signer nodes, so it issues no receipts and counts no
        // results until somebody assigns it honestly.
        //
        // A node with no chain view signer nodes nothing and says nothing: it cannot
        // check the list, so it does not pretend to. What it must not do is
        // fall back to the author's list, and it does not.
        if (chainFor) {
          // (A ROUND THAT TAKES A STAKE INTO A FEDERATION IS ASSIGNED SIGNER NODES ONLY ON A BONDED ONE - §23.6, P3; the owner
          // 2026-09-15 07:33 - and that is asked before round.open now, above: an unbonded one is not stored at all.)
          const assigned = roster.assignSignerNodes(id);
          // A ROUND POSTED AHEAD OF ITS BEACON (the owner 2026-10-01, the free grid gapless across a restart: "publish each round
          // as soon as it is drafted; the block clock names the beacon later"): stored, and its signer nodes assigned by the
          // sweep below once the block past its committee time is on this node's chain. 202, the round's id.
          if (!assigned.ok && BigInt(contract.committeeTimeMs) + 600000n > BigInt(round.now()) && BEACON_NOT_YET.test(assigned.why || '')) {
            awaitingBeacon.add(toHex(new Uint8Array(id)));
            return bytes(res, 202, id);
          }
          if (!assigned.ok) return text(res, 409, assigned.why);
          // AND ITS SIGNER NODES MAKE ITS CLAIM KEY, in the background (see makeClaimKey).
          makeClaimKey(id);
        }
        return bytes(res, 201, id);
      }

      // A FIRST MARK HANDED ON BY ANOTHER SIGNER NODE. The same checks a player's
      // own send meets - a joined entry, a stake this signer node has seen, the mark's
      // own signature and chain - and the same rule: taken and receipted in
      // time, refused and recorded FORFEIT (a late start) after join_tick + the deadline.
      // The forwarder's receipt is kept beside this signer node's own.
      if (req.method === 'POST' && url.pathname === '/first-mark') {
        const answer = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', ...CORS }); return res.end(JSON.stringify(body)); };
        let got;
        try { got = JSON.parse(Buffer.from(await read(req)).toString('utf8')); }
        catch { return answer(400, { why: 'a first mark is handed on as JSON' }); }
        let bytes;
        let c;
        try { bytes = fromHex(String(got.mark)); c = decodeCheckpoint(splitSigned(bytes).body); }
        catch (e) { return answer(400, { why: `that is not a signed mark: ${e.message}` }); }
        if (!c.previousHash.every((x) => x === 0)) return answer(400, { why: 'only a first mark is handed on' });
        if (!round.entry(c.entryId)) return answer(404, { why: 'this signer node holds no such entry' });
        let seen;
        try { seen = await stakeSeen(c.entryId); } catch (e) { seen = { ok: false, why: e.message }; }
        // A SIGNER NODE THAT IS UP AND REFUSES keeps what it refused (M3.3-34): the
        // player's own on-time first mark, so it can reach §13C's VOID from its
        // own store as the signer node that took it does (round.putRefusedFirstMark
        // keeps nothing forged, late, or conflicting with a mark held here).
        if (!seen.ok) {
          round.putRefusedFirstMark({ bytes, why: STAKE_NOT_SEEN + seen.why });
          return answer(409, { why: STAKE_NOT_SEEN + seen.why });
        }
        // §16: A FIRST MARK THIS SIGNER NODE DOES NOT HOLD, handed on after the start
        // deadline passed - shown by the player's own signed mark past the line,
        // or by this signer node's round being closed - is refused and recorded
        // ENTRY_VOID here. A claim of it this signer node cannot check is refused.
        if (!round.holdsMark(checkpointId(c)) && secondFirstMark(c, bytes)) {
          gatherOnProof(c.roundId, c.entryId);
          return answer(409, { why: TWO_FIRST_MARKS });
        }
        if (!round.holdsMark(checkpointId(c))) {
          const late = lateEvidenceHere(c, got.entryVoid, got.receipt ? fromHex(String(got.receipt)) : null);
          if (late) {
            const v = voidHere(c, bytes, late, receiptsGiven(got), got.ask === 'forfeit' ? 'forfeit-ask' : 'forward');
            if (v) return answer(409, { entryVoid: true, why: v.why });
          } else if (got.entryVoid) return answer(409, { why: 'that ENTRY_VOID claim does not verify at this signer node' });
        }
        for (const b of Array.isArray(got.batches) ? got.batches : []) {
          try { round.batch(fromHex(String(b))); } catch { /* held already, or refused: the mark says which */ }
        }
        let receipt;
        try { receipt = round.checkpoint(bytes); }
        catch (e) {
          if (!/^FORFEIT/.test(e.message) && !/the round is closed/.test(e.message)) round.putRefusedFirstMark({ bytes, why: e.message });
          gatherOnProof(c.roundId, c.entryId);                 // the refusal may have made the pair here
          return answer(409, /^FORFEIT/.test(e.message) ? { forfeit: true, why: e.message } : { why: e.message });
        }
        if (got.receipt) { try { round.takeReceipt(fromHex(String(got.receipt))); } catch { /* not this mark's */ } }
        return answer(200, { receipt: toHex(receipt) });
      }

      // ENTRY_VOID (§16), AS THIS SIGNER NODE HOLDS IT: why, the first mark, the evidence
      // the start deadline passed, and this signer node's receipt of the first mark if
      // it took it in time - what a returning signer node checks before it records the
      // same Void. 404: this signer node holds none.
      if (req.method === 'GET' && url.pathname === '/entry-void') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'an entry is asked for by its id');
        const v = round.entryVoid(new Uint8Array(eid));
        if (!v) return text(res, 404, 'this signer node holds no ENTRY_VOID for that entry');
        let own = null;
        try { own = round.ownReceipt(checkpointId(decodeCheckpoint(splitSigned(v.firstMark).body))); } catch { own = null; }
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ outcome: 'ENTRY_VOID', why: v.why, firstMark: toHex(v.firstMark),
          evidenceKind: v.evidenceKind, evidence: v.evidence ? toHex(v.evidence) : null, receipt: own ? toHex(own) : null,
          receipts: (() => { try { return round.receiptsOfMark(checkpointId(decodeCheckpoint(splitSigned(v.firstMark).body))).map((r) => toHex(r)); } catch { return []; } })(),
          offers: round.firstMarkOffers(new Uint8Array(eid)) }));
      }

      // A JOINED PLAYER'S NAME FOR A ROUND (M3.3-34): the record the player signed
      // with the round key it is joined under (lobby-name.js). Kept only from a
      // player who joined at THIS signer node in that round, the newest winning, and served
      // beside the listing and at /names so the other players are shown it. The
      // page checks every record again: a signer node can leave a name out, never write one.
      if (req.method === 'POST' && url.pathname === '/name') {
        const answer = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', ...CORS }); return res.end(JSON.stringify(body)); };
        let bytes;
        let sig;
        let rec;
        try {
          const got = JSON.parse(Buffer.from(await read(req)).toString('utf8'));
          bytes = fromHex(String(got.record));
          sig = fromHex(String(got.sig));
          rec = decodeLobbyName(bytes);
        } catch (e) { return answer(400, { why: `that is not a signed name record: ${e.message}` }); }
        let signed = false;
        try { signed = sig.length === 64 && schnorr.verify(sig, lobbyNameId(rec), rec.playerPubkey); } catch { signed = false; }
        if (!signed) return answer(400, { why: 'the signature does not verify under the player key the record names' });
        if (!round.get(rec.roundId)) return answer(404, { why: 'this signer node holds no such round' });
        if (!round.entriesOf(rec.roundId).some((e) => toHex(e.entry.playerPubkey) === toHex(rec.playerPubkey)))
          return answer(409, { why: 'this signer node holds no player with that key in that round' });
        const kept = round.putLobbyName({ roundId: rec.roundId, playerPubkey: rec.playerPubkey, record: bytes, signature: sig, atMs: rec.atMs });
        // A NEW NAME IS LISTED AT ONCE: the small listings kept 5 s (GET /rounds) are dropped, so a player's rename shows on
        // the next poll - measured: lobby-names served the old name for up to 5 s after the new one was taken (red since
        // 669b39be). The large series listing is not touched; it names no players.
        if (kept) for (const [k, v] of listingKept) if (!v.large) listingKept.delete(k);
        return kept ? answer(201, { kept: true }) : answer(200, { kept: false, why: 'this signer node keeps a newer name of that player' });
      }
      if (req.method === 'GET' && url.pathname === '/names') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'names are asked for by a round id');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ round: toHex(rid), names: namesHeld(new Uint8Array(rid)) }));
      }

      // WHAT THIS SIGNER NODE HOLDS ABOUT AN ENTRY'S START: FORFEIT for a late start, with the
      // first mark's tick and the line it missed, or 404 - no mark is no record.
      // A FIRST MARK THIS SIGNER NODE, UP, REFUSED (M3.3-34): the player's own signed
      // on-time first mark and why, for a signer node closing the round - which checks
      // it again, and so never reads the player as never started. 404: none.
      if (req.method === 'GET' && url.pathname === '/refused-first-mark') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'an entry is asked for by its id');
        const r = round.refusedFirstMark(new Uint8Array(eid));
        if (!r) return text(res, 404, 'this signer node refused no first mark of that entry');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ mark: toHex(r.mark), why: r.why }));
      }

      // §13C'S EVIDENCE AND ITS BLOCKS (RULED the owner 2026-09-24): every record this node holds of an entry's marks as
      // evidence, each with the block it names - this node's tip when it recorded it, or the block a peer named. A holder
      // deciding places each mark at the earliest block among the records it then holds.
      if (req.method === 'GET' && url.pathname === '/evidence-blocks') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'an entry is asked for by its id');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ marks: round.evidenceBlocks(new Uint8Array(eid)).map((x) => ({ mark: toHex(x.markId), block: toHex(x.block), seenMs: x.seenMs })) }));
      }

      if (req.method === 'GET' && url.pathname === '/start-forfeit') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'an entry is asked for by its id');
        const v = round.startForfeit(new Uint8Array(eid));
        if (!v) return text(res, 404, 'this signer node holds no FORFEIT for a late first mark of that entry');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ outcome: 'FORFEIT', markTick: v.markTick, lastTick: v.lastTick, why: v.why,
          mark: toHex(v.mark), forwarded: firstMarkForwards.get(toHex(eid)) || null }));
      }

      // THE LOBBY (M3.3-34, §25): the rounds THIS node holds that a player can
      // still come to - open, entry not yet closed - with what joining asks of
      // them and how many players joined at this node and it has taken ticks from.
      // "A lobby carries nothing": every id here is a name, and the page fetches
      // each contract and hashes it before it shows a row. `free` and `wallet`
      // are read off the contract this node stores; the counts are its own.
      // THE ROUNDS PAGE (ROUNDS-HTML-1617): a browser asking for /rounds gets the page; everything else - a lobby's
      // fetch, a script - gets the list as before. The page reads /api/rounds and /api/round-result beside it.
      // A HOSTED GAME'S ICON (kanban #228): its square mark, from the file its registration names, beside its rounds
      if (req.method === 'GET' && url.pathname === '/game-icon') {
        const game = hosted.get(String(url.searchParams.get('game') || '').toLowerCase());
        if (!game || !game.icon || !existsSync(game.icon)) return text(res, 404, 'this node hosts no such game, or it has no icon');
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600', ...CORS });
        return res.end(readFileSync(game.icon));
      }
      // THE GAMES THIS NODE HOSTS (kanban #208): each with its signed manifest, so a lobby lists the games first and a page
      // loads a game's client only from files whose hashes that manifest names (clients[]). A page takes a manifest only if
      // it hashes to the game id beside it; nothing here is trusted for itself.
      // A HOSTED GAME AS A PACKAGE (kanban #276 step 5, plugin-package.js): what another seat's plugin store installs - its
      // signed manifest, donation set, decide adapters' sources and clients; the installing seat checks every byte
      // THIS SEAT'S NETWORK AS A PACKAGE (kanban #276, network-check.js): what another seat's network store installs - its
      // chain, the signed donation sets and rotations it holds, the series it holds and its federation invite
      if (req.method === 'GET' && url.pathname === '/network') {
        const nid = String(url.searchParams.get('network') || chainNetworkId() || '').toLowerCase();
        if (!chain || !/^[0-9a-f]{64}$/.test(nid) || nid !== chainNetworkId()) return text(res, 404, 'this seat holds no such network');
        if (!inviteFor(nid)) return text(res, 409, 'this seat names no federation invite for its network');
        let pkg; try { pkg = ownNetwork(nid); } catch (e) { return text(res, 500, `this seat's network could not be packaged: ${e.message}`); }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
        return res.end(JSON.stringify(pkg));
      }
      if (req.method === 'GET' && url.pathname === '/plugin') {
        const g = hosted.get(String(url.searchParams.get('game') || '').toLowerCase());
        if (!g) return text(res, 404, 'this seat hosts no such game');
        let pkg; try { pkg = packageOf(g, { ancestors: chainOf(g) }); } catch (e) { return text(res, 500, `that game's files could not be read: ${e.message}`); }
        if (!pkg) return text(res, 409, 'this seat cannot package that game: its cores are not files it can hand out (a replayed game\'s engine)');
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', ...CORS });
        return res.end(JSON.stringify(pkg));
      }
      // THE GAMES AND MARKETS THIS SEAT FOUND ON THE NETWORK (kanban #276): public, as /games is; ?fresh=1 reads them again now
      if (req.method === 'GET' && url.pathname === '/network-games') {
        const ng = await networkGamesNow({ fresh: url.searchParams.get('fresh') === '1' });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
        // hosted here or not as of this ask: a game installed since the last read is not offered again
        const games = ng.games.map((g) => ({ ...g, hostedHere: hosted.has(g.id), updateOf: hosted.has(g.parent) && !hosted.has(g.id) ? g.parent : null }));
        return res.end(JSON.stringify({ node: toHex(round.pubkey), atMs: ng.atMs, seats: ng.seats, games }));
      }
      if (req.method === 'GET' && url.pathname === '/games') {
        const games = [...hosted.values()].map((p) => ({ id: toHex(p.gameId), name: p.name, title: p.title || p.name,
          icon: p.icon ? `game-icon?game=${toHex(p.gameId)}` : null, attested: p.manifest.resultType === RESULT_TYPE.ATTESTED,
          // ITS KIND, VERSION AND SIGNED INFO (kanban #276): what the network store lists; the info's signature travels with it,
          // so a reader checks it against the manifest's developer key rather than taking it from this seat
          type: gameTypeOf(p.manifest), version: p.manifest.version, info: p.info || null,
          // WHO PLAYS IT HERE NOW (kanban #338): its live rounds and the players in them, from this seat's own store
          live: liveNow()[toHex(p.gameId)] || { rounds: 0, players: 0 },
          manifest: toHex(encodeManifest(p.manifest)) }));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=10', ...CORS });
        return res.end(JSON.stringify({ node: toHex(round.pubkey), games }));
      }
      if (req.method === 'GET' && url.pathname === '/rounds' && /text\/html/.test(String(req.headers.accept || ''))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...CORS });
        return res.end(readFileSync(new URL('../pages/rounds.html', import.meta.url)));
      }
      if (req.method === 'GET' && url.pathname === '/rounds') {
        // THE LISTING KEPT FOR 2 s PER QUERY (the owner 2026-09-30, measured on testnet4 with series 3cfbe516): ~440 rounds,
        // each signed and its committees asked, held the loop 3-5 s per listing, and the page repaints its lobby every
        // few seconds from every tab - a join's own requests waited behind it (6.7 min from PLAY to the deposit). Each
        // row is signed with the listing's time, and a page takes a listing up to LOBBY_SKEW_MS (60 s) old.
        const q = url.search;
        const nowReal = Date.now();
        let body = listingKept.get(q);
        // ONLY A LARGE LISTING IS KEPT (a series' - over 100 rounds): a small one is made fresh on every ask, as before.
        // A LARGE ONE KEPT 30 s (measured 15:12Z: pages whose bundle predates `next` asked the whole listing - 1155 rounds with
        // two series - every few seconds, each 8-11 s on the node's loop; a page takes a listing up to 60 s old).
        // AND A SMALL ONE 5 s - 2 s missed most of a lobby's polls, every few seconds each (NODE-OPT-1648; JOIN-TIME-1359, the owner 2026-10-02: "Keep cutting the load of empty and open rounds"): the lobby's
        // `?next=8` was made afresh on every ask from every open lobby every few seconds - 1038 of them over 200 ms in seat 1's
        // recent log, up to 14.8 s held - and its joined/playing counts may lag 5 s where a page takes 60.
        // AND NONE KEPT PAST A CHANGE OF THE SERIES HELD (kanban #22): a dropped series' rounds left the listing only 30 s later
        if (!body || nowReal - body.at > (body.large ? 30000 : 5000) || body.version !== seriesVersion) {
          // ONE BUILD PER QUERY AT A TIME: every asker that comes while it yields waits for the same listing
          let building = listingBuilding.get(q);
          if (!building) {
            building = (async () => {
              const version = seriesVersion;
              const { nowMs, listed } = await announcedRounds(url);
              const made = { at: nowReal, version, large: listed.length > 100,
                json: JSON.stringify({ node: toHex(round.pubkey), nowMs: String(nowMs), rounds: listed, games: groupedByGame(listed) }) };
              listingKept.set(q, made);
              if (listingKept.size > 16) listingKept.delete(listingKept.keys().next().value);
              return made;
            })().finally(() => listingBuilding.delete(q));
            listingBuilding.set(q, building);
          }
          body = await building;
        }
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(body.json);
      }

      // THE PAGE'S DATA: the announced rounds (upcoming) and the finished ones, each with its times and committees.
      if (req.method === 'GET' && url.pathname === '/api/rounds') {
        const { nowMs, listed } = await announcedRounds(url);
        const finished = [];
        const seen = new Set(listed.map((r) => r.id));
        const rowOf = (rid, c, closedMs) => {
          let endMs; try { endMs = roundEndMs(c); } catch { endMs = c.entryCloseMs; }
          const players = round.playersOf(rid);
          return { id: toHex(rid), startTime: new Date(Number(c.startTimeMs)).toISOString(), endTime: new Date(Number(endMs)).toISOString(),
            closedTime: closedMs ? new Date(Number(closedMs)).toISOString() : null, free: c.stakeMsat === 0n, stakeMsat: String(c.stakeMsat),
            joined: players.joined, committee: committeeOf(rid), game: gameOfContract(c), outcome: outcomeOf(rid, c) };
        };
        // an open round whose end has passed is finished too, waiting for its close
        for (const roundId of openHeld()) {
          const id = toHex(roundId);
          if (seen.has(id)) continue;
          const h = heldOf(roundId);
          if (h.bad) continue;
          finished.push(rowOf(roundId, h.c, null));
        }
        for (const held of round.finishedRounds(200)) {
          let c; try { c = decodeRoundContract(held.contract); } catch { continue; }
          finished.push(rowOf(held.roundId, c, held.closedMs));
        }
        finished.sort((a, b) => (a.endTime < b.endTime ? 1 : -1));
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        // only hosted games' rounds, each tagged with its game, and grouped by game (kanban #204)
        const finishedHosted = finished.filter((r) => r.game);
        return res.end(JSON.stringify({ node: toHex(round.pubkey), nowMs: String(nowMs), upcoming: listed, finished: finishedHosted,
          games: groupedByGame([...listed, ...finishedHosted]) }));
      }

      // WHO WAS IN A FINISHED ROUND AND WHO WON HOW MUCH (ROUNDS-HTML-1617): each entry, its player's signed name,
      // the outcome and score the signer nodes signed, and what this node holds as owed or paid to it.
      if (req.method === 'GET' && url.pathname === '/api/round-result') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'a round result is asked for by a round id');
        const held = round.get(rid);
        if (!held) return text(res, 404, 'this node holds no such round');
        const c = decodeRoundContract(new Uint8Array(held.contract));
        const names = new Map();
        for (const n of round.lobbyNames(rid)) {
          // THE NAME THE LOBBY SHOWED (kanban #125): the player's own, else the one generated from the record's identity key -
          // a record's name is empty when the player kept the generated one, and the Player column read 8 hex of the key.
          try { const r = decodeLobbyName(n.record); names.set(toHex(r.playerPubkey), r.name || displayNameFromKey(r.identityPubkey)); } catch { /* not a record */ }
        }
        // WHAT EACH PLAYER WON OR LOST, as this node's settlement says (the owner 2026-10-03 22:25, the dashboard's rounds): a
        // qualifier gets its stake back and its payout, less the node fee and its donation; a loser or a walk-away loses
        // the stake; when the settlement paid nobody, every stake but a walk-away's comes back (forfeit.js nobodyWonReturn),
        // so only the fee and the donation are gone. Until this node's settlement is ACCEPTED it is pending.
        const settled = stateOf(round, rid) ? { state: stateOf(round, rid) } : null;
        const shares = settled && settled.state === 'ACCEPTED' && round.lockSettlementShares ? round.lockSettlementShares(rid) : null;
        const nobodyWon = !!(shares && !shares.length);
        const players = round.entriesOf(rid).map(({ entryId, entry }) => {
          const signed = round.results(rid, entryId);
          const tally = new Map();
          for (const r of signed) {
            try {
              const x = decodePlayerResult(splitSignedResult(r.bytes).body);
              const k = `${x.outcome}:${x.score}`;
              tally.set(k, { outcome: x.outcome, score: x.score, signers: ((tally.get(k) || {}).signers || 0) + 1 });
            } catch { /* not a result */ }
          }
          const best = [...tally.values()].sort((a, b) => b.signers - a.signers)[0] || null;
          const won = round.winnings(entryId);
          const player = toHex(entry.playerPubkey);
          return { entry: toHex(entryId), player, name: names.get(player) || `${displayNameFromKey(entry.playerPubkey)} (no lobby name)`, stakeMsat: String(entry.stakeMsat),
            outcome: best ? best.outcome : null, score: best ? best.score : null, signedBy: best ? best.signers : 0,
            wonMsat: won ? String(won.owedMsat) : '0', winningsState: won ? won.state : (entry.stakeMsat === 0n ? 'FREE' : 'NONE'),
            ...playerBalance({ entry, best, won, settled, nobodyWon, minScore: c.minScore }) };
        });
        // THE SCORE ACROSS ROUNDS (kanban #280): a head-to-head round of two named identities - its match record, signed here
        let match = null;
        try { match = matchOf(round, hosted, new Uint8Array(rid)); } catch { match = null; }
        if (match) {
          // A MATCH'S NAMES ARE ITS IDENTITIES' (kanban #280): the lobby record's name where the player posted one, else the name
          // generated from the identity key - the same in every round, as the player's own tab shows it (never a round key's)
          const nameOf = (idHex) => { const p = players.find((x) => { const who = round.identityOf(fromHex(x.entry)); return who && toHex(who.identity) === idHex; });
            return p && names.has(p.player) ? names.get(p.player) : displayNameFromKey(fromHex(idHex)); };
          match = { ...match, names: match.identities.map(nameOf),
            players: Object.fromEntries(players.map((p) => { const who = round.identityOf(fromHex(p.entry)); return [p.entry, who ? toHex(who.identity) : null]; })) };
        }
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ id: rid.toString('hex'), state: held.state, free: c.stakeMsat === 0n, players, match }));
      }

      // THE SERIES THIS NODE WRITES, and how far ahead it has written them (NODE72-1131).
      if (req.method === 'POST' && url.pathname === '/series') {
        let t;
        try { t = parseSeriesLine(Buffer.from(await read(req)).toString('utf8')); }
        catch (e) { return text(res, 400, `that is not a series line: ${e.message}`); }
        const got = takeGridSeries(t);
        if (!got.ok) return text(res, got.code, got.why);
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(got));
      }
      if (req.method === 'GET' && url.pathname === '/series') {
        const nowMs = round.now();
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ node: toHex(round.pubkey), nowMs: String(nowMs), series: writers.map((w) => w.summary(nowMs)) }));
      }

      if (req.method === 'GET' && url.pathname === '/round') {
        const row = round.get(Buffer.from(url.searchParams.get('id') || '', 'hex'));
        if (!row) return text(res, 404, 'no such round');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-state': String(row.state), ...CORS });
        return res.end(Buffer.from(row.contract));
      }

      // THE SHARES A PLAYER SPLIT THEIR STAKE PREIMAGE INTO, checked here and
      // kept only if THIS NODE'S OWN share lies on the published polynomial.
      //
      // This is the door letter 29 exists for, and 23.1's secrecy half changed
      // what a node can see through it: the shares are sealed one per signer node
      // now, so a node opens its own and checks that one. A dealer who split
      // with two polynomials is refused by WHOEVER HE CHEATED - which is still
      // before any entry naming these shares is accepted, and still with
      // something to do about it.
      //
      // A NODE THAT WAS DEALT NOTHING KEEPS NOTHING. Storing an envelope
      // addressed to somebody else and calling it custody would be the same
      // mistake as holding a stake this node cannot settle.
      //
      // AND THE OPENED SHARE IS NEVER WRITTEN DOWN. Only the sealed handout
      // goes to disk; the share is re-opened from it whenever it is needed, so
      // a stolen database is a pile of envelopes.
      if (req.method === 'POST' && url.pathname === '/handout') {
        let handout;
        try { handout = decodeHandout(await read(req)); }
        catch (e) { return text(res, 400, 'that is not a handout: ' + e.message); }

        // THE ROUND'S THRESHOLD, NOT THE PLAYER'S (M3.3-26). `acceptHandout`
        // checks a handout only against itself, and measured: a crafted 1-of-2
        // (one signer node opens it alone) and a 7-of-7 on seven signer nodes (every signer node must
        // open it) were both taken 201. A loser who could deal his own
        // threshold could deal an unopenable stake and be refunded on the
        // timelock every time. So a stake is dealt at the round's number or not
        // at all - the same number the settle opens at and the page deals.
        const forRound = round.get(handout.roundId);
        if (!forRound) return text(res, 404, 'this node holds no such round, so it cannot say what its stakes open at');
        const roundContract = decodeRoundContract(new Uint8Array(forRound.contract));
        // NO STAKE IS DEALT FOR A ROUND THIS NODE REFUSES (kanban #191): nothing may be locked for it
        { const why = offerRefusal(roundContract); if (why) return text(res, 409, `handout refused: ${why}`); }
        let threshold;
        try { threshold = roundThreshold(roundContract.settlementSlots); }
        catch (e) { return text(res, 409, e.message); }
        if (handout.needed !== threshold)
          return text(res, 409, `that handout is dealt ${handout.needed} of ${handout.shares.length}, and `
            + `this round's stakes open at ${threshold} of ${roundContract.settlementSlots}`);

        const seen = acceptHandout(handout);
        if (!seen.ok) return text(res, 409, seen.why);

        const mine = await openMyShare(handout, {
          pubkey: round.pubkey, secret: round.identity.secret, curve: feldmanGroup,
        });
        if (!mine.ok) return text(res, 409, mine.why);

        const id = handoutId(handout);
        round.rememberHandout({ id, roundId: handout.roundId, bytes: encodeHandout(handout) });
        res.writeHead(201, { 'content-type': 'application/octet-stream', 'x-signer-node': String(mine.signerNode), ...CORS });
        return res.end(Buffer.from(id));
      }

      if (req.method === 'GET' && url.pathname === '/handout') {
        const held = round.handout(Buffer.from(url.searchParams.get('id') || '', 'hex'));
        if (!held) return text(res, 404, 'this node has accepted no such handout');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(held.bytes));
      }

      if (req.method === 'POST' && url.pathname === '/entry') {
        const contract = decodeEntryContract(await read(req));
        // AN ENTRY INTO A ROUND OF A GAME THIS NODE DOES NOT HOST (kanban #204): that round was never stored, and the node
        // says which game, from what it refused at /round or in a series of that game
        { const game = refusedGameOf.get(toHex(contract.roundId));
          if (game) return text(res, 409, `entry refused: this node does not host game ${game.slice(0, 16)} (§0A.4), the game that round plays`); }
        { const why = offerRefusalOfRound(contract.roundId); if (why) return text(res, 409, `entry refused: ${why}`); }
        // RESERVE SEATS (§5A.7, kanban #301): a round takes entries only once both roles are seated by a certificate this
        // node holds - and never after two seatings (equivocation: the round is void)
        if (seating) {
          const st = seating.stateOf(contract.roundId);
          if (Object.values(st).some((x) => x && x.equivocated)) return text(res, 409, 'entry refused: that round has two seatings - equivocation, the round is void (§5A.7)');
          if (!st.game || !st.settlement) return text(res, 409, 'entry refused: that round is not seated yet - no seating certificate for its game and settlement roles (§5A.7)');
        }
        if (!funded({ kind: 'entry', contract, node: fundingView }))
          return text(res, 402, 'this node stores nothing for an entry nobody has funded');
        // THE FEE-LOCK DOOR (the owner 2026-09-14, pick a). Where the round's gate mints fee locks,
        // an entry that brings none is not taken: its stake would not be counted, and in the
        // round's one settlement it would refuse everybody's claim (measured: "an entry's fee
        // lock was never verified, so the fee cannot be claimed"). A round that mints nothing -
        // the Daily's free rounds, a 100 sat round under the federation's 1000 msat rule - is
        // not touched.
        const lockRow = round.get(contract.roundId);
        if (lockRow && contract.stakeMsat > 0n) {
          const rc = decodeRoundContract(new Uint8Array(lockRow.contract));
          // Every paying round is a FEDERATION round naming its federation: the custody field has one value
          // and a paying round with a zero federation id does not encode (§23.6). No custody test is left here.
          {
            let gate;
            // THE ENTRY'S FEDERATION (2026.0.3, kanban #348): on a round that takes any, the one the entry names - asked here
            // what /round asks of a round's own: reachable, not draining, two live gateways, no base fee, guardians bonded
            const efed = entryFederation(rc, contract);
            if (!efed.ok) return text(res, 409, efed.why);
            const fport = await portOfFederation(efed.federationId);
            if (!fport) return text(res, 409, portRefusal({ federationId: efed.federationId }));
            if (takesAnyFederation(rc)) {
              const dr = drainingRefusal({ ...rc, federationId: efed.federationId });
              if (dr) return text(res, 409, `this node takes no entry with a lock in that federation: ${dr}`);
              if (typeof fport.gateways === 'function') {
                let seen;
                try { seen = await doorGateways(fport, toHex(efed.federationId)); }
                catch (e) { return text(res, 409, `this signer node could not list that federation's gateways: ${e.message}`); }
                const n = federationGatewayCount(seen.gateways);
                if (n.distinctLive < 2) return text(res, 409, `that entry's federation has ${n.distinctLive} distinct live gateway(s): a paying entry needs at least two (§23.6)`);
              }
              if (chainFor) {
                const bonded = await guardiansBonded(contract.roundId, rc, efed.federationId);
                if (!bonded.ok) return text(res, 409, bonded.why);
              }
            }
            try { const g = pluginForRound(rc, hosted); gate = await roundMintsFees({ contract: rc, port: fport, feeBps: g.ok ? entryFeeBpsOf(g.plugin.manifest) : undefined }); }
            catch (e) { return text(res, 503, `this node could not read the federation's fee rule, so it takes no entry in a round that may mint fee locks: ${e.message}`); }
            // AND THE FEDERATION MUST CHARGE NO BASE FEE (FEDERATION.md item 4; §22A: "Fedimint's own base
            // fees are 0: the federation runs with disable_base_fees"). A base fee comes out of every input
            // and output of the round's locks - the players' own pool - so it is money taken from a stake
            // somebody committed, for nothing the round asked for. `page-lock.js` refuses to lock against
            // such a federation; this is the same refusal on the node, so no entry is taken either.
            // An unknown rule is not a base fee, and is not refused here.
            let noBase = { ok: true };
            try { noBase = federationTakesNoBaseFee({ fees: typeof fport.fees === 'function' ? await doorFees(fport, toHex(efed.federationId)) : null }); }
            catch (e) { return text(res, 503, `this node could not read the federation's fee rule: ${e.message}`); }
            if (!noBase.ok) return text(res, 409, `this node takes no entry in that round: ${noBase.why}`);
            const namesNone = contract.feeLockOutpoint.txid.every((x) => x === 0) || contract.feePreimage.every((x) => x === 0);
            if (gate.mints && namesNone)
              return text(res, 409, `this round mints fee locks (${gate.why}): an entry that brings no fee lock is not taken - `
                + 'its stake would not be counted, and it would block the round\'s settlement');
          }
          // THE DONATION OUTPUTS THE ENTRY NAMES ARE ITS SET'S (the owner 2026-10-03, FEDERATION.md): as many as its donation owes
          // a set of keys, none for an LNURL set or no donation. The federation is asked when the lock is handed over (/lock).
          const ds = donationTargetFor(rc);
          if (ds.ok || (contract.donationOutpoints || []).length) {
            const want = ds.ok ? donationOutputsExpected(contract, ds.target) : { ok: false, why: ds.why };
            if (!want.ok) return text(res, 409, `entry refused: donation: ${want.why}`);
          }
        }
        const joined = round.enter(contract);
        // NO HOLD IS ISSUED HERE ANY MORE. This door used to ask the signer node's Lightning for a hold
        // invoice on the entry's payment hash, and said how that went in `x-hold`. That was the withdrawn Lightning custody's
        // stake-in, which does not exist (§23.6, RULED 2026-09-22 22:59); a lock round's stake is locked by
        // the player in the federation and handed to `/stake-lock`, where the signer node verifies it.
        res.writeHead(201, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(joined));
      }

      /**
       * WHAT A JOINED PLAYER PAYS. 23.1's endpoint, and the last thing that
       * happens before their money is in flight.
       *
       * IT IS AN INPUT DEVICE AND NOTHING ELSE. The answer is a payment
       * request and the amount this node holds for that entry - no outcome, no
       * arrival, nothing a browser could report about a run. The player's
       * wallet checks the invoice against their own contract before paying: the
       * hash and the net stake the entry signed.
       *
       * ASKED TWICE, ANSWERED THE SAME. The request is kept beside the hold,
       * so a reloaded page gets the invoice that exists rather than a second
       * claim on one stake.
       *
       * A STRANGER'S ENTRY IS REFUSED - which here means an entry this node
       * does not hold. It cannot mean "not the player's own": a hold invoice
       * is a bearer instruction to PAY, so somebody else holding it can only
       * fund that player's stake, never take it. What would be wrong is this
       * node inventing an invoice for an entry it never took.
       */
      /**
       * HAS THIS NODE SEEN THE STAKE HELD? 23.1 step 5, asked by the player.
       *
       * A hold invoice is paid long before the wallet says so: `pay_invoice`
       * answers when the payment completes, and a held one completes only when
       * the round settles or cancels it. So the page asks the node, which asks
       * its own Lightning once and remembers. A stranger's entry asks nobody.
       */
      /**
       * NO WINNINGS DOOR (§23.6, RULED 2026-09-22 22:59). `GET`/`POST /winnings` said what "the pool" owed
       * an entry and paid it - and their own note named the pool as "the committee's own Lightning
       * balance", which is the withdrawn Lightning custody's custody by one operator. They went with it. A lock round pays its
       * qualifiers' payout contracts inside the federation, in the one settlement (`settlements.settle`).
       */
      if (req.method === 'GET' && url.pathname === '/stake') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'a stake is asked for by entry id');
        if (!round.entry(eid)) return text(res, 404, 'this node holds no such entry');
        let seen;
        try { seen = await stakeSeen(new Uint8Array(eid)); }
        catch (e) { seen = { ok: false, why: e.message }; }
        if (!seen.ok) return text(res, 409, STAKE_NOT_SEEN + seen.why);
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({
          entry: eid.toString('hex'), state: seen.state, paidMsat: String(seen.paidMsat ?? 0n),
        }) + '\n');
      }

      /**
       * WHERE THIS STAKE STANDS, for the player waiting on it (MF item 14).
       *
       * "The player is waiting on other people's machines and must be told so, with the refund path
       * visible the whole time." What this door can still say truthfully is two things: whether this
       * signer node has SEEN the stake - free, or its federation lock verified here (§23.1 step 5) - and
       * where the run's result stands (13A), with the window's close on this node's clock.
       *
       * IT USED TO SAY FAR MORE, AND ALL OF IT WAS the withdrawn Lightning custody's (§23.6, RULED 2026-09-22 22:59): the
       * hold's state and amount off the Lightning hold row, the pool and the owed row off the hold
       * settle, the refund height off the HTLC's expiry. None of those exist for a lock, so none is
       * reported - an answer of `null` for a thing that no longer exists would itself be a claim.
       */
      if (req.method === 'GET' && url.pathname === '/settlement') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'a settlement is asked for by entry id');
        const stored = round.entry(eid);
        if (!stored) return text(res, 404, 'this node holds no such entry');
        const entry = decodeEntryContract(stored);
        const standing = resultFinality(round, entry.roundId, new Uint8Array(eid));
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({
          entry: eid.toString('hex'),
          stake: entry.stakeMsat === 0n ? 'FREE' : (round.stakeSeen(eid) ? 'SEEN' : 'UNSEEN'),
          finality: standing.state,
          finalityWhy: standing.why || null,
          windowClosesAtMs: standing.closesAtMs === undefined ? null : String(standing.closesAtMs),
        }) + '\n');
      }

      /**
       * A FEDERATION ROUND'S STAKE INVOICE, BEFORE THE ENTRY EXISTS.
       *
       * Invoice first (the owner 2026-09-11, decision 1): an LNv2 invoice's
       * secret belongs to its receiver - the federation, which holds it
       * threshold-wise - so the player cannot choose it; the player's entry
       * commits to THIS invoice's hash instead. Asked for exactly the entry's
       * net stake - the stake less the fee and the donation the player names
       * (`&donation=`, msat, none is 0) - because `/entry` then takes the
       * gateway's invoice up (lndPort, node-start.js) and any other amount is not the
       * entry's net stake. Measured before (M3.2 6e): the donation was
       * left out, so a 2% donor was joined on a 980000 msat invoice and its
       * quote refused it (the entry holds 960000). The hash and the amount
       * are read off the invoice, not taken from the federation's word.
       */
      if (req.method === 'GET' && url.pathname === '/federation-invoice') {
        if (!federation || typeof federation.receive !== 'function')
          return text(res, 409, 'this node makes no federation invoices');
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const held = rid.length === 32 ? round.get(rid) : null;
        if (!held) return text(res, 404, 'this node holds no such round');
        const contract = decodeRoundContract(new Uint8Array(held.contract));
        if (!(contract.stakeMsat > 0n)) return text(res, 409, 'that round asks no stake, so there is nothing to invoice');
        // AND NO STAKE INVOICE FOR A ROUND NONE OF WHOSE RESULTS CAN BE FINAL
        // (§13A, P2): the player would pay into a round that could never settle.
        const relays = publicationRelaysAreValid(contract);
        if (!relays.ok) return text(res, 409, `no stake invoice is made for that round: ${relays.why}`);
        if (typeof lightning.decode !== 'function')
          return text(res, 503, 'this node cannot read a Lightning invoice, so it cannot say what one commits to');
        const named = url.searchParams.get('donation');
        if (named !== null && !/^[0-9]{1,20}$/.test(named))
          return text(res, 400, 'a donation is named in whole millisatoshi, 0 or more');
        let amountMsat;
        try {
          const ofGame = pluginForRound(contract, hosted);
          amountMsat = netStakeMsat({ stakeMsat: contract.stakeMsat, feeMsat: entryFeeMsat(contract.stakeMsat, ofGame.ok ? entryFeeBpsOf(ofGame.plugin.manifest) : undefined),
            donationMsat: named === null ? 0n : BigInt(named) });
        } catch (e) { return text(res, 400, e.message); }
        let made;
        let read;
        try {
          made = await federation.receive({ amountMsat, roundId: new Uint8Array(rid) });
          read = await lightning.decode({ request: made.request });
        } catch (e) { return text(res, 503, `the federation made no invoice: ${e.message}`); }
        if (read.amountMsat !== amountMsat)
          return text(res, 502, `the federation's invoice is for ${read.amountMsat} msat, not the ${amountMsat} msat net stake`);
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({
          round: rid.toString('hex'), paymentHash: toHex(read.paymentHash),
          amountMsat: String(amountMsat), request: made.request,
        }) + '\n');
      }

      // NO `/invoice` DOOR (§23.6, RULED 2026-09-22 22:59). It quoted a joined player the hold invoice
      // their entry named, and the §23.5 fee's own hold beside it - both the withdrawn Lightning custody's stake-in, gone with
      // it. A lock round's player locks the stake in the federation (`/federation-invoice` for the LNv2
      // invoice that funds it) and hands the lock to `/stake-lock` and `/fee-lock`.

      // THE ENTRY CONTRACT, so 13B's proof is portable to somebody who was not
      // here. The two signed marks mean nothing without the session key they
      // must verify under, and that key is a field of the entry the player
      // signed. Without this door a stranger holding the proof can read it and
      // cannot check it, which is most of what "portable" was supposed to buy.
      if (req.method === 'GET' && url.pathname === '/entry') {
        const eid = Buffer.from(url.searchParams.get('id') || '', 'hex');
        const entry = round.entry(eid);
        if (!entry) return text(res, 404, 'no such entry');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(entry));
      }

      // WHAT THIS NODE HAS SEEN RECEIPTED THAT IT HAS NOT GOT. 13B's gossip
      // signal, and the only thing that surfaces a split committee before
      // settlement: a member has receipted a mark this node never held. It is
      // not a proof and it is not a vote - it says where to go looking, and
      // evidence nobody can ask for does nothing at all.
      if (req.method === 'GET' && url.pathname === '/foreign-receipts') {
        const held = round.foreignReceipts();
        if (!held.length) return text(res, 204, 'this node holds no receipt for a mark it has not got');
        const body = Buffer.concat(held.map((f) => Buffer.from(f.bytes)));
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-foreign-receipts': String(held.length),
          ...CORS,
        });
        return res.end(body);
      }

      // 13B'S PROOF, which a node MUST publish when it holds one. The answer
      // is the two signed marks back to back, per tick, and 204 when this node
      // has never seen the player sign two worlds at once.
      if (req.method === 'GET' && url.pathname === '/equivocation') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const found = round.equivocation(rid, eid);
        if (!found.length) return text(res, 204, 'no equivocation held for that entry');
        const body = Buffer.concat(found.flatMap(
          (f) => [Buffer.from(f.stored), Buffer.from(f.offered)]));
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-equivocations': String(found.length),
          'x-ticks-at': found.map((f) => f.tick).join(','),
          ...CORS,
        });
        return res.end(body);
      }

      // THE PLAYER'S LATE FIRST MARK, AS THIS SIGNER NODE KEEPS IT (M3.3-34, path 2):
      // the other half of a two-first-marks proof, for a signer node that missed its
      // forward to pull at its close. Measured before on a fresh federation: the
      // forward to the Void signer node lost, neither signer node decided anything in 92 s -
      // ENTRY_VOID at one, a late start at the other - and the Void signer node's door
      // tried to gather the refund. 204: this signer node keeps none.
      // PULL AND CHECK THE PROOF OF TWO FIRST MARKS NOW (M3.3-34): a signer node that
      // refused a second first mark asks this signer node to pull the pair itself -
      // checked here, never taken on the asker's word - while every signer node is
      // still reachable. Nothing is spread further from here.
      if (req.method === 'POST' && url.pathname === '/proof-pull') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (rid.length !== 32 || eid.length !== 32) return text(res, 400, 'a proof is pulled for a round and an entry');
        if (!round.entry(new Uint8Array(eid))) return text(res, 404, 'this signer node holds no such entry');
        const proven = await verifier.pullFirstMarkProof(new Uint8Array(rid), new Uint8Array(eid));
        return text(res, 200, proven ? 'proven' : 'no proof');
      }

      if (req.method === 'GET' && url.pathname === '/late-first-mark') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'an entry is asked for by its id');
        const late = round.startForfeit(new Uint8Array(eid));
        if (!late) return text(res, 204, 'this signer node keeps no late first mark for that entry');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(late.mark));
      }

      // THE CANONICAL TRANSCRIPT (13C), which is not the same object as the
      // transcript above: that one is everything this node was given, and this
      // one is only what the committee has carried. A node serving the first
      // where the second was asked for would be handing over marks four
      // members never saw.
      if (req.method === 'GET' && url.pathname === '/canonical') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        let c;
        try { c = round.canonicalTranscript(rid, eid); }
        catch (e) { return text(res, 409, e.message); }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-transcript-hash': toHex(c.hash),
          'x-ticks': String(c.ticks),
          'x-marks': String(c.marks),
          'x-dropped': String(c.dropped),
          'x-through-tick': String(c.throughTick),
          ...CORS,
        });
        return res.end(Buffer.from(c.bytes));
      }

      // A GAME REPLAY (the owner 2026-09-25 18:39): a page, not the Unity build, that fetches the transcript, the entry and
      // the round from this node - or from the round's other committee endpoints when this one has no transcript - and
      // steps the core the round names. The path is the same on every node, so the link plays on any that holds the run.
      // THE PAGE IS THE ROUND'S GAME'S (kanban #202): its registration's replayPage - nextblock's draws the truck. The engine
      // draws no game: a round it does not hold, or of a game with no replay page, has none here.
      if (req.method === 'GET' && url.pathname === '/replay') {
        const id = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (id.length !== 32) return text(res, 400, 'the link names no round (?round=<hex>&entry=<hex>)');
        const row = round.get(id);
        if (!row) return text(res, 404, 'this node holds no such round');
        const game = hosted.get(toHex(decodeRoundContract(new Uint8Array(row.contract)).gameId));
        if (!game) return text(res, 404, 'this node does not host that round\'s game');
        if (!game.replayPage || !existsSync(game.replayPage)) return text(res, 404, `${game.name} serves no replay page`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...CORS });
        return res.end(readFileSync(game.replayPage));
      }
      // THE CORE THE ROUND NAMES, and no other: served only when that round's sim hash is a core this node installed for
      // the round's game - the core it replays it with (the registration's replayFile; nextblock's is
      // packages/nextblock/dist/blwp-replay-core.js, the bundle of core/src's adapter).
      if (req.method === 'GET' && url.pathname === '/replay/core.js') {
        const id = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (id.length !== 32) return text(res, 400, 'that is not a round id');
        const row = round.get(id);
        if (!row) return text(res, 404, 'this node holds no such round');
        const contract = decodeRoundContract(new Uint8Array(row.contract));
        const runs = pluginForRound(contract, hosted);
        if (runs.ok && runs.attested) return text(res, 404, `${runs.plugin.name} is attested: its rounds have no core and no replay (§0A.7a)`);
        if (!runs.ok) {
          // A CORE THIS NODE NO LONGER RUNS IS STILL SERVED FOR THE REPLAY of a round it stored: refusing it deleted the
          // replay (the morning's links 409'd on d12e7abc once the tree moved).
          const kept = replayCoreFile(toHex(contract.simCoreHash));
          if (!kept || !existsSync(kept)) return text(res, 409, runs.why);
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...CORS });
          return res.end(readFileSync(kept));
        }
        // the bundle of the core that round names, as its game installed it (kanban #202: each round's replay page is its
        // own plugin's); a game whose core carries no replay bundle has no replay page
        if (!runs.core.replayFile || !existsSync(runs.core.replayFile)) return text(res, 404, `${runs.plugin.name} serves no replay page for core ${runs.core.hash.slice(0, 16)}`);
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...CORS });
        return res.end(readFileSync(runs.core.replayFile));
      }
      // THE PROTOCOL'S DECODERS AND SEED for the page: the client bundle, as the game page carries it.
      if (req.method === 'GET' && url.pathname === '/replay/client.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...CORS });
        return res.end(readFileSync(new URL('../../arena-client/dist/arena-client.js', import.meta.url)));
      }
      // THE RUN AS THIS NODE REPLAYS IT: the same object replay.js steps (ticks and their five words, liquidations,
      // loads, samples, tapes), as JSON. 404 when this node holds no ticks of it - the page then asks the others.
      if (req.method === 'GET' && url.pathname === '/replay/transcript') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (rid.length !== 32 || eid.length !== 32) return text(res, 400, 'a replay names a round and an entry');
        const t = readTranscript(round.db, rid, eid);
        if (!t.ticks.length) return text(res, 404, 'this node holds no transcript of that run');
        // WHEN THE RUN WAS PLAYED (the owner 2026-09-26 14:25: Start and End are absolute timestamps): the first and the last
        // checkpoint this node received of it - its tick and when it arrived. Beside the transcript, not in it: the
        // transcript is what a seat replays and hashes; this is only when the node saw it.
        const cp = (order) => round.db.prepare(`SELECT tick, received_ms FROM checkpoints WHERE round_id = ? AND entry_id = ? ORDER BY tick ${order} LIMIT 1`).get(rid, eid);
        const first = cp('ASC'), last = cp('DESC');
        const clock = first && last ? { firstTick: first.tick, firstMs: Number(first.received_ms), lastTick: last.tick, lastMs: Number(last.received_ms) } : null;
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ ...t, clock }));
      }
      // THE ROUND'S COMMITTEE ENDPOINTS, from the advertisements its census carries: where else the run is held. ws
      // becomes https (the link a player copies names one of these at random).
      if (req.method === 'GET' && url.pathname === '/replay/nodes') {
        const id = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (id.length !== 32) return text(res, 400, 'that is not a round id');
        const found = new Set();
        for (const role of ['game', 'settlement']) {
          const c = roster.committeeFor(id, role);
          if (!c.ok) continue;
          for (const e of c.committee) if (e && e.advert && e.advert.endpoint)
            found.add(String(e.advert.endpoint).replace(/^wss?:/, 'https:').replace(/\/+$/, ''));
        }
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ stable: replayPublic, endpoints: [...found] }));
      }

      if (req.method === 'GET' && url.pathname === '/transcript') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const t = round.handOver(rid, eid);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-transcript-hash': toHex(t.hash),
          'x-ticks': String(t.ticks),
          ...CORS,
        });
        return res.end(Buffer.from(t.bytes));
      }

      // The checkpoints as they arrived. Fixed-size records back to back, so
      // a reader cuts them apart without a framing rule to agree on first.
      // WHAT THIS NODE REPLAYED AND SIGNED, so another node can have it
      // without replaying. Section 13's own record, body then signature, as
      // many as this node holds for that run.
      /**
       * ONE SIGNER NODE'S SHARE OF ONE STAKE, FOR ANOTHER SIGNER NODE. 23.4's five.
       *
       * Refused unless the asker is a signer node of this round AND the run is final
       * with an outcome whose lock 23.2 claims (lock-action.js) - a DELIVERED run's
       * preimage must never leave, because releasing it lets anyone claim a lock
       * that has to go back to its player.
       *
       * The answer is SEALED TO THE ASKER. Those two together are what make
       * this sound with no signature on the request: claiming a signer node's key
       * gets an envelope only that signer node can open, and not claiming one gets a
       * refusal.
       */
      if (req.method === 'GET' && url.pathname === '/share') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const asker = Buffer.from(url.searchParams.get('signer node') || '', 'hex');
        if (rid.length !== 32 || eid.length !== 32)
          return text(res, 400, 'a share is asked for by round and entry');
        const ask = { roundId: new Uint8Array(rid), entryId: new Uint8Array(eid), asker: new Uint8Array(asker) };
        let said = await stakeSecrets.answer(ask);
        // A PROOF OF TWO FIRST MARKS THIS SIGNER NODE HAS NOT PULLED YET (M3.3-34): the
        // asker's signer nodes may hold it - pulled, checked here and kept, never taken
        // on the asker's word; then asked of this signer node's own record again.
        // `proof=1`: the asker holds a proof of two first marks - pulled even over a
        // result this signer node signed (measured: a signer node that had signed FAILED refused).
        if (!said.ok && (url.searchParams.get('proof') === '1' || !round.results(ask.roundId, ask.entryId).length)
          && await verifier.pullFirstMarkProof(ask.roundId, ask.entryId)) said = await stakeSecrets.answer(ask);
        // A SIGNER NODE HOLDING THE PROOF GATHERS TOO, while the signer nodes are up (M3.3-34):
        // measured before on 5 of 7 - signer nodes that learned the proof here, when
        // asked, never gathered; with the two signer nodes that had gathered down, the
        // four up reached 4 of 5 shares and the hold went back to the player
        // (98000 msat). In the background: the asker is answered now.
        if (round.provenEquivocation(ask.roundId, ask.entryId)) gatherOnProof(ask.roundId, ask.entryId);
        if (!said.ok) return text(res, 409, said.why);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-signer-node': String(said.answer.signerNode), ...CORS,
        });
        return res.end(Buffer.from(encodeShareAnswer(said.answer)));
      }

      // NO POOL PAYOUT DOORS (§23.6; RULED 2026-09-25): /payout (the signed payout table of a pool spend), /pool/commit
      // and /pool/share (a signer node's nonce and signature share of one) were the withdrawn custody's on-chain payout.

      // WHERE THIS SIGNER NODE'S CLOSE OF EACH RUN STANDS (M3.3-34): only runs it could
      // not sign at its close - HOLDING while a peer is down or unreachable and
      // the close is tried again, SIGNED once it is. Never a refund or a VOID.
      if (req.method === 'GET' && url.pathname === '/closing') {
        const rid = (url.searchParams.get('round') || '').toLowerCase();
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify([...closing.values()].filter((s) => !rid || s.round === rid)));
      }

      if (req.method === 'GET' && url.pathname === '/results') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const held = round.results(rid, eid);
        const out = new Uint8Array(held.length * SIGNED_RESULT_BYTES);
        held.forEach((r, i) => out.set(r.bytes, i * SIGNED_RESULT_BYTES));
        // AND §13C'S NO-QUORUM OUTCOME, when this signer node decided one (M3.3-34):
        // VOID has no signed result to serve, so it is said here.
        const nq = eid.length === 32 ? round.noQuorum(new Uint8Array(eid)) : null;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-results': String(held.length), ...(nq ? { 'x-no-quorum': nq.outcome } : {}), ...CORS,
        });
        return res.end(Buffer.from(out));
      }

      // EVERY SIGNER NODE'S WORD THAT IT POSTED A RUN'S TRANSCRIPT (P2), fixed-size
      // records back to back, as `/results` serves results.
      if (req.method === 'GET' && url.pathname === '/postings') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const held = round.postings(rid, eid);
        const out = new Uint8Array(held.length * SIGNED_POSTING_BYTES);
        held.forEach((p, i) => out.set(p.bytes, i * SIGNED_POSTING_BYTES));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-postings': String(held.length), ...CORS });
        return res.end(Buffer.from(out));
      }

      // AN ATTESTED ROUND'S OUTCOME IN (§0A.7a, kanban #206): the attestation's bytes. Held only if it stands for that round -
      // its round, an outcome its game names, the game's threshold of distinct attestor keys its manifest names, each
      // signature good - and refused by name otherwise. A second standing attestation of ANOTHER outcome is held too: it is
      // the proof, and the round is DISPUTED.
      // POST /outcome?round=<id>: the round the attestation is handed for is named apart from it, so one made for another
      // round is refused as that, not filed under the round it names.
      if (req.method === 'POST' && url.pathname === '/outcome') {
        const target = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (target.length !== 32) return text(res, 400, 'POST /outcome?round=<the round\'s id>');
        let a, raw;
        try { raw = new Uint8Array(await read(req)); a = decodeAttestation(raw); } catch (e) { return text(res, 400, `that is not an outcome attestation: ${e.message}`); }
        const row = round.get(target);
        if (!row) return text(res, 404, 'this node holds no such round');
        const c = decodeRoundContract(new Uint8Array(row.contract));
        const plugin = attestedOf(c);
        if (!plugin) return text(res, 409, 'that round\'s game is not an attested game this node hosts: its result is a replayed run, not an attestation');
        const stands = attestationStands(a, { manifest: plugin.manifest, roundIdBytes: new Uint8Array(roundIdOf(c)), verify: verifyEd25519 });
        if (!stands.ok) return text(res, 409, stands.why);
        // AND NOT BEFORE THE LAST PICK (§0A.7a slice 2): the round's entries closed on this seat's clock, and the outcome seen after
        // AND NOT BEFORE THE MARKET'S RESOLUTION TIME, when its manifest names one (kanban #235)
        const timely = attestationTimely(a, { entryCloseMs: c.entryCloseMs, nowMs: round.now(), terms: plugin.manifest.marketTerms || null });
        if (!timely.ok) return text(res, 409, timely.why);
        const fresh = round.putOutcomeAttestation({ bodyId: attestationBodyId(a), roundId: a.roundId, outcome: a.outcome, observedAtMs: a.observedAtMs,
          bytes: raw, receivedMs: round.now() });
        if (fresh) settleAttestedSoon();
        const now = outcomeOf(a.roundId, c);
        console.log(`[outcome] ${toHex(a.roundId).slice(0, 16)}: ${stands.why}${fresh ? '' : ' (held already)'} - the round is ${now.state}`);
        res.writeHead(fresh ? 201 : 200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ held: true, fresh, why: stands.why, ...now }));
      }
      if (req.method === 'GET' && url.pathname === '/outcome') {
        const id = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (id.length !== 32) return text(res, 400, 'that is not a round id');
        const row = round.get(id);
        if (!row) return text(res, 404, 'this node holds no such round');
        const c = decodeRoundContract(new Uint8Array(row.contract));
        const out = outcomeOf(new Uint8Array(id), c, { table: true });
        if (!out) return text(res, 409, 'that round\'s game is not an attested game this node hosts: it has no outcome');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ round: toHex(id), ...out }));
      }

      // WHO IS AT A HEAD-TO-HEAD ROUND'S TABLE (kanban #280, the owner 2026-10-09 playtest: two tabs at one table both read "You
      // are alone in this round" - the table counted moves, not players): POST /here?round=<id> with { key, sig } - the tab's
      // identity key and its signature over (round, key) (match.js presenceId) - says this tab sits at that round's table; GET
      // reads who does. Each answers the identities said within PRESENCE_MS, with the name made from each key. Kept in memory
      // only: presence decides nothing.
      // A TABLE WAITS (kanban #293, the owner 2026-10-11, path B): POST /h2h-want?game=<id> - a page that chose a head-to-head
      // game this seat hosts and found no round of it open says so; GET /h2h-want answers, per game, when that was last
      // said. The operator's grid keeper reads it and publishes the next 30 min of rounds in one transaction. In memory
      // only, one time per game: it decides nothing but whether a grid is published.
      if (url.pathname === '/h2h-want' && (req.method === 'POST' || req.method === 'GET')) {
        const wants = round.__h2hWants || (round.__h2hWants = new Map());
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
          return res.end(JSON.stringify({ nowMs: Number(round.now()), wants: Object.fromEntries(wants) }));
        }
        const g = String(url.searchParams.get('game') || '').toLowerCase();
        const p = /^[0-9a-f]{64}$/.test(g) ? hosted.get(g) : null;
        if (!p || !isHeadToHead(p.manifest)) return text(res, 404, 'that is not a head-to-head game this node hosts');
        wants.set(g, Number(round.now()));
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ ok: true, game: g, atMs: wants.get(g) }));
      }
      if (url.pathname === '/here' && (req.method === 'POST' || req.method === 'GET')) {
        const id = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (id.length !== 32) return text(res, 400, 'that is not a round id');
        const row = round.get(id);
        if (!row) return text(res, 404, 'this node holds no such round');
        const found = pluginForRound(decodeRoundContract(new Uint8Array(row.contract)), hosted);
        if (!found.ok || !found.headToHead) return text(res, 409, 'that round is not a head-to-head game this node hosts: it has no table');
        const now = Number(round.now());
        const tables = presenceTables(round);
        for (const [rid, t] of tables) { for (const [k, at] of t) if (now - at > PRESENCE_MS) t.delete(k); if (!t.size) tables.delete(rid); }
        const ridHex = toHex(id);
        if (req.method === 'POST') {
          let body;
          try { body = JSON.parse(Buffer.from(await read(req)).toString('utf8')); } catch { return text(res, 400, 'a presence is JSON: { "key": "<64 hex>", "sig": "<128 hex>" }'); }
          const key = /^[0-9a-f]{64}$/.test(String(body && body.key)) ? fromHex(body.key) : null;
          const sig = /^[0-9a-f]{128}$/.test(String(body && body.sig)) ? fromHex(body.sig) : null;
          let good = false;
          try { good = !!(key && sig) && schnorr.verify(sig, presenceId({ roundId: new Uint8Array(id), identityKey: key }), key); } catch { good = false; }
          if (!good) return text(res, 403, 'that presence is not signed by its key over this round');
          if (!tables.has(ridHex) && tables.size >= 256) return text(res, 503, 'this node keeps no more tables just now');
          const t = tables.get(ridHex) || new Map();
          if (!t.has(body.key) && t.size >= 32) return text(res, 503, 'that table is full');
          t.set(body.key, now);
          tables.set(ridHex, t);
        }
        const t = tables.get(ridHex) || new Map();
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ round: ridHex, here: [...t].map(([key, at]) => ({ key, name: displayNameFromKey(fromHex(key)), agoMs: now - at })) }));
      }

      // A HEAD-TO-HEAD PLAYER'S REVEAL (kanban #233): POST /reveal?entry=<entry id> with { move, salt } (JSON, salt in hex),
      // after the round's entry close and before its end (its reveal deadline). Taken only if it hashes to the commitment
      // that entry named (head-to-head.js revealStands); kept once. The round's results are decided from the reveals at its
      // close, so a reveal is the whole of a player's part after entry - there is no run.
      if (req.method === 'POST' && url.pathname === '/reveal') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'POST /reveal?entry=<the entry\'s id> with { move, salt }');
        const raw = round.entry(eid);
        if (!raw) return text(res, 404, 'this node holds no such entry');
        const entry = decodeEntryContract(raw);
        const row = round.get(entry.roundId);
        if (!row) return text(res, 404, 'this node holds no round for that entry');
        const c = decodeRoundContract(new Uint8Array(row.contract));
        const found = pluginForRound(c, hosted);
        if (!found.ok || !found.headToHead) return text(res, 409, 'that entry\'s round is not a head-to-head game this node hosts: it has nothing to reveal');
        let body;
        try { body = JSON.parse(Buffer.from(await read(req)).toString('utf8')); } catch { return text(res, 400, 'a reveal is JSON: { "move": <integer>, "salt": "<64 hex>" }'); }
        const salt = /^[0-9a-f]{64}$/i.test(String(body && body.salt)) ? new Uint8Array(Buffer.from(body.salt, 'hex')) : null;
        if (!salt || !Number.isInteger(body.move)) return text(res, 400, 'a reveal is JSON: { "move": <integer>, "salt": "<64 hex>" }');
        const stands = revealStands({ roundId: entry.roundId, entryKey: entry.sessionPubkey, commit: entry.commit, move: body.move, salt,
          moveCount: found.plugin.manifest.moveCount, atMs: BigInt(round.now()), entryCloseMs: c.entryCloseMs,
          revealWindowMs: BigInt(roundEndMs(c)) - c.entryCloseMs });
        if (!stands.ok) return text(res, 409, stands.why);
        // AND ITS IDENTITY, if the player names one (kanban #280): its identity key's signature over (round, entry, key) -
        // what a score across rounds links its rounds by; a proof that does not verify is refused, none is fine
        if (body.identity) {
          const key = /^[0-9a-f]{64}$/.test(String(body.identity.key)) ? fromHex(body.identity.key) : null;
          const sig = /^[0-9a-f]{128}$/.test(String(body.identity.sig)) ? fromHex(body.identity.sig) : null;
          let good = false;
          try { good = !!(key && sig) && schnorr.verify(sig, matchProofId({ roundId: entry.roundId, entryId: new Uint8Array(eid), identityKey: key }), key); } catch { good = false; }
          if (!good) return text(res, 403, 'that identity is not signed by its key over this round and entry');
          round.putIdentity({ roundId: entry.roundId, entryId: new Uint8Array(eid), identity: key, sig });
        }
        const fresh = round.putReveal({ roundId: entry.roundId, entryId: eid, move: body.move, salt, receivedMs: round.now() });
        console.log(`[reveal] ${toHex(entry.roundId).slice(0, 16)} ${toHex(eid).slice(0, 16)}: move ${body.move}${fresh ? '' : ' (held already)'}`);
        res.writeHead(fresh ? 201 : 200, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify({ held: true, fresh }));
        // EVERY MOVE IN: DECIDED NOW (the owner 2026-10-09 playtest: "after the reveal it still takes 10-15 s until the result
        // stands - it has to be more instant"). A seat that closes its rounds itself (closeAtEnd) and holds a reveal for each of
        // a round's entries - its game's players, all in - has nothing its reveal deadline could still add: it closes the round
        // now, not at that deadline. A round short of a reveal still waits for its end (that entry's FORFEIT).
        if (closeAtEnd && fresh) {
          const all = round.entriesOf(entry.roundId);
          const revealed = new Set(round.revealsOf(entry.roundId).map((r) => toHex(r.entryId)));
          if (all.length >= found.plugin.manifest.players && all.every(({ entryId }) => revealed.has(toHex(entryId))) && round.close(entry.roundId)) {
            console.log(`[close] ${toHex(entry.roundId).slice(0, 16)}: every move revealed - closed by this signer node before its end`);
            afterClose(entry.roundId);
          }
        }
        return;
      }
      // THE MARKET ORDER BOOK (kanban #278, step 4 + comment 1127; order-batch.js). An order is an entry with a limit price,
      // tradable once this seat verified its two locks. Between seats: a seat's proposal for batch k (GET /batch-proposal),
      // the leader's set (POST /batch: held and signed, or refused by name), its certificate (POST /batch-certificate), the
      // void of a batch that can no longer be certified (POST /batch-void-ask, POST /batch-void), and every certified batch
      // for a seat that missed one (GET /book-certificates). For anyone: the book as this seat clears it (GET /book), and a
      // player's sell of shares its entry holds (POST /sell, its session key; matched in a batch, paid at settlement).
      // THE COMMITTEE'S PRICE SAMPLES (§11, kanban #311): sign one this seat read too, keep one that stands, list what it holds
      if (req.method === 'GET' && url.pathname === '/price-samples') {
        const rh = String(url.searchParams.get('round') || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(rh)) return text(res, 400, 'GET /price-samples?round=<id>&since=<tick>');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        // `feed`: this seat runs the committee's feed for that round - a page then plays only attested prices (slice 3)
        const row = round.get(Buffer.from(rh, 'hex'));
        return res.end(JSON.stringify({ ...prices.list(rh, Number(url.searchParams.get('since') || 0) || 0), feed: !!(row && feedFor(row.contract)) }));
      }
      if (req.method === 'POST' && (url.pathname === '/price-sign' || url.pathname === '/price-attested')) {
        let body; try { body = JSON.parse(Buffer.from(await read(req)).toString('utf8')); } catch { return text(res, 400, 'that body is not JSON'); }
        const got = url.pathname === '/price-sign' ? prices.sign(body) : prices.hold(body);
        if (!got.ok) return text(res, got.status || 409, got.why);
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(got));
      }
      if (req.method === 'GET' && (url.pathname === '/batch-proposal' || url.pathname === '/book' || url.pathname === '/book-certificates')) {
        const id = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (id.length !== 32) return text(res, 400, 'that is not a round id');
        const rid = new Uint8Array(id);
        let got;
        if (url.pathname === '/batch-proposal') {
          const k = url.searchParams.get('k') || '';
          if (!/^[0-9]{1,15}$/.test(k)) return text(res, 400, 'GET /batch-proposal?round=<id>&k=<batch>');
          got = orderBook.proposal(rid, Number(k));
        } else if (url.pathname === '/book-certificates') got = { certificates: orderBook.certificates(rid) };
        else { got = orderBook.cleared(rid); if (!got.ok) return text(res, got.status || 409, got.why); }
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(got, (key, v) => (typeof v === 'bigint' ? String(v) : v)));
      }
      if (req.method === 'POST' && ['/batch', '/batch-certificate', '/batch-void-ask', '/batch-void', '/sell'].includes(url.pathname)) {
        const id = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (id.length !== 32) return text(res, 400, `POST ${url.pathname}?round=<id>`);
        const rid = new Uint8Array(id);
        let body = {};
        try { const raw = Buffer.from(await read(req)).toString('utf8'); body = raw ? JSON.parse(raw) : {}; } catch { return text(res, 400, 'that body is not JSON'); }
        let got;
        if (url.pathname === '/batch') got = orderBook.accept(rid, body);
        else if (url.pathname === '/batch-certificate') got = orderBook.certify(rid, body);
        else if (url.pathname === '/batch-void') got = orderBook.applyVoid(rid, body);
        else if (url.pathname === '/sell') got = orderBook.ask(rid, 'sell', body);
        else {
          const k = url.searchParams.get('k') || '';
          if (!/^[0-9]{1,15}$/.test(k)) return text(res, 400, 'POST /batch-void-ask?round=<id>&k=<batch>');
          got = orderBook.voidAsk(rid, Number(k));
        }
        if (!got.ok) return text(res, got.status || 409, got.why);
        res.writeHead(got.fresh === false ? 200 : 201, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(got, (key, v) => (typeof v === 'bigint' ? String(v) : v)));
      }
      // A MARKET ENTRY CANCELLED BY ITS PLAYER (kanban #278, the owner 2026-10-09: "until then the orders can be cancelled at no
      // cost"): POST /cancel?entry=<id> with the 64-byte Ed25519 signature of the entry's session key over cancelId - taken
      // only for a market (an attested round this node hosts) and only before its entry close, when nothing has filled yet.
      // From then on the entry is out of the round's table, and its stake and fee locks come back at once by the return door
      // (GET /forfeit, and GET /forfeit?lock=fee). Any seat may relay it: the signature is the player's.
      if (req.method === 'POST' && url.pathname === '/cancel') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'POST /cancel?entry=<the entry\'s id> with its session key\'s 64-byte signature');
        const raw = round.entry(eid);
        if (!raw) return text(res, 404, 'this node holds no such entry');
        const entry = decodeEntryContract(raw);
        const row = round.get(entry.roundId);
        if (!row) return text(res, 404, 'this node holds no round for that entry');
        const c = decodeRoundContract(new Uint8Array(row.contract));
        const found = pluginForRound(c, hosted);
        if (!found.ok || !found.attested) return text(res, 409, 'that entry\'s round is not a market this node hosts: only a market order is cancelled');
        const signature = new Uint8Array(await read(req));
        if (signature.length !== 64) return text(res, 400, 'a cancel is the 64-byte signature of the entry\'s session key');
        // AN ORDER OF AN ORDER BOOK (comment 1127): its cancel takes effect in a batch - the book's, not at once
        if (entry.limitPrice !== undefined && entry.limitPrice !== null) {
          const got = orderBook.ask(entry.roundId, 'cancel', { entry: toHex(eid), signature: toHex(signature) });
          if (!got.ok) return text(res, got.status || 409, got.why);
          res.writeHead(got.fresh ? 202 : 200, { 'content-type': 'application/json', ...CORS });
          return res.end(JSON.stringify({ cancelled: false, inNextBatch: true, id: got.id }));
        }
        let good = false;
        try { good = ed25519.verify(signature, cancelId({ roundId: entry.roundId, entryId: new Uint8Array(eid) }), entry.sessionPubkey); } catch { good = false; }
        if (!good) return text(res, 403, 'that cancel is not signed by the entry\'s session key');
        if (round.cancelled(eid)) { res.writeHead(200, { 'content-type': 'application/json', ...CORS }); return res.end(JSON.stringify({ cancelled: true, fresh: false })); }
        if (BigInt(round.now()) >= c.entryCloseMs)
          return text(res, 409, `entries closed at ${new Date(Number(c.entryCloseMs)).toISOString()}: that order is in the round now, and its fee is due`);
        round.putCancel({ roundId: entry.roundId, entryId: new Uint8Array(eid), signature, receivedMs: round.now() });
        console.log(`[cancel] ${toHex(entry.roundId).slice(0, 16)} ${toHex(eid).slice(0, 16)}: cancelled by its player`);
        res.writeHead(201, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ cancelled: true, fresh: true }));
      }
      // EVERY CANCEL THIS SEAT HOLDS FOR A ROUND (kanban #278), for the other seats, which pull them before they settle
      if (req.method === 'GET' && url.pathname === '/cancels') {
        const id = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (id.length !== 32) return text(res, 400, 'that is not a round id');
        if (!round.get(id)) return text(res, 404, 'this node holds no such round');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ round: toHex(id), cancels: round.cancelsOf(new Uint8Array(id))
          .map((r) => ({ entry: toHex(r.entryId), signature: toHex(r.signature) })) }));
      }
      // EVERY REVEAL THIS SEAT HOLDS FOR A ROUND (kanban #233), for the players and for the other seats, which pull them at the
      // round's close so every seat decides from the same moves. Public: a move is revealed only after entry close.
      if (req.method === 'GET' && url.pathname === '/reveals') {
        const id = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (id.length !== 32) return text(res, 400, 'that is not a round id');
        if (!round.get(id)) return text(res, 404, 'this node holds no such round');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ round: toHex(id), reveals: round.revealsOf(new Uint8Array(id))
          .map((r) => { const who = round.identityOf(r.entryId); return { entry: toHex(r.entryId), move: r.move, salt: toHex(r.salt),
            ...(who ? { identity: { key: toHex(who.identity), sig: toHex(who.sig) } } : {}) }; }) }));
      }

      // WHAT A RECIPIENT KEY WAS DONATED (the owner 2026-10-03, FEDERATION.md "Donations in the federation"): every donation
      // output this signer node verified for that key, in every round and federation, oldest first, from `since` (ms). Public,
      // as the entries are; a dev's client confirms each outpoint with its federation before it redeems.
      if (req.method === 'GET' && url.pathname === '/donations') {
        const key = String(url.searchParams.get('key') || '').toLowerCase();
        if (!/^0[23][0-9a-f]{64}$/.test(key)) return text(res, 400, 'a recipient key is 66 hex characters, a compressed secp256k1 point');
        const rows = round.donationsFor(key, Number(url.searchParams.get('since') || 0));
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ key, donations: rows }));
      }

      // THE DEV HAS READ THEM (kanban #156, the owner 2026-10-05 08:15-08:17): a read receipt signed with the recipient key -
      // { key, atMs, outpoints, signature } over donationsReadMessage - and this seat deletes those rows of that key entirely.
      // A wrong key, a forged or stale receipt, or another recipient's outpoint deletes nothing.
      if (req.method === 'POST' && url.pathname === '/donations/read') {
        let body;
        try { body = JSON.parse(Buffer.from(await read(req)).toString('utf8')); } catch { return text(res, 400, 'a read receipt is JSON'); }
        const key = String((body && body.key) || '').toLowerCase();
        if (!/^0[23][0-9a-f]{64}$/.test(key)) return text(res, 400, 'a recipient key is 66 hex characters, a compressed secp256k1 point');
        const outpoints = Array.isArray(body.outpoints) ? body.outpoints.map(String).filter((o) => /^[0-9a-f]{64}:\d+$/.test(o)) : [];
        if (!outpoints.length || outpoints.length !== body.outpoints.length || outpoints.length > 5000)
          return text(res, 400, 'a read receipt names the outpoints it read, each txid:index');
        const atMs = Number(body.atMs);
        if (!Number.isSafeInteger(atMs)) return text(res, 400, 'a read receipt names when it was signed, in ms');
        let good = false;
        try {
          const pub = createPublicKey({ key: Buffer.from(SECP256K1_SPKI_PREFIX + key, 'hex'), format: 'der', type: 'spki' });
          good = ecdsaVerify('sha256', donationsReadMessage({ key, atMs, outpoints }), { key: pub, dsaEncoding: 'der' }, Buffer.from(String(body.signature || ''), 'hex'));
        } catch { good = false; }
        if (!good) return text(res, 403, 'that read receipt is not signed by that recipient key');
        if (Math.abs(Date.now() - atMs) > DONATIONS_READ_WINDOW_MS) return text(res, 409, 'that read receipt is too old or from the future: sign it again');
        const deleted = round.deleteDonationsRead(key, outpoints);
        if (deleted) console.log(`[donations] ${key.slice(0, 16)}: ${deleted} donation row(s) read by the dev and deleted`);
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ deleted }));
      }

      // THE PLAYER'S STAKE LOCK, handed to a signer node to verify (23.1 step 5): the
      // contract it locked, as JSON. The signer node asks the federation what it holds
      // at the entry's outpoint, hashes the contract, checks every field against
      // the entry, and only then counts the stake as seen.
      if (req.method === 'POST' && url.pathname === '/lock') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'a lock is handed over for an entry id');
        let fields;
        try { fields = lockFieldsFromJson(JSON.parse(Buffer.from(await read(req)).toString('utf8'))); }
        catch (e) { return text(res, 400, `that is not a stake lock: ${e.message}`); }
        const stored = round.entry(eid);
        if (!stored) return text(res, 404, 'this node holds no such entry');
        { const why = offerRefusalOfRound(decodeEntryContract(stored).roundId); if (why) return text(res, 409, `lock refused: ${why}`); }
        const claimPk = claimKeyOf(decodeEntryContract(stored).roundId);
        // THE ROUND'S DONATION SET, so the donation outputs in the same transaction are checked with the stake (the owner 2026-10-03)
        let donationRecipients = null;
        { const rr = round.get(decodeEntryContract(stored).roundId);
          const ds = rr ? donationTargetFor(decodeRoundContract(new Uint8Array(rr.contract))) : { ok: false };
          if (ds.ok) donationRecipients = ds.target; }
        let got;
        try { got = await verifyStakeLock({ round, port: (await portOfEntryBytes(stored)) || stakeLocks, entryIdBytes: new Uint8Array(eid), fields, claimPk, donationRecipients }); }
        catch (e) { got = { ok: false, why: `the federation could not be asked: ${e.message}` }; }
        if (!got.ok) return text(res, 409, got.why);
        // AN ORDER (comment 1127): tradable here once both its locks are verified
        if (decodeEntryContract(stored).limitPrice !== undefined) orderBook.noteTradable(decodeEntryContract(stored).roundId);
        return text(res, 201, `stake lock verified: contract ${got.contractId} holds ${got.paidMsat} msat`
          + (got.waitsForFeeLock ? ' - counted once its fee lock is verified (this round mints fee locks)' : ''));
      }

      // AND THE PLAYER'S FEE LOCK (Pick A, F5): the entry's 2% locked to H(F),
      // checked field by field as the stake lock is, and claimed for the round's
      // sitting signer nodes in its one settlement.
      if (req.method === 'POST' && url.pathname === '/fee-lock') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'a fee lock is handed over for an entry id');
        let fields;
        try { fields = lockFieldsFromJson(JSON.parse(Buffer.from(await read(req)).toString('utf8'))); }
        catch (e) { return text(res, 400, `that is not a fee lock: ${e.message}`); }
        const stored = round.entry(eid);
        if (!stored) return text(res, 404, 'this node holds no such entry');
        { const why = offerRefusalOfRound(decodeEntryContract(stored).roundId); if (why) return text(res, 409, `lock refused: ${why}`); }
        const claimPk = claimKeyOf(decodeEntryContract(stored).roundId);
        let got;
        try { got = await verifyFeeLock({ round, port: (await portOfEntryBytes(stored)) || stakeLocks, entryIdBytes: new Uint8Array(eid), fields, claimPk }); }
        catch (e) { got = { ok: false, why: `the federation could not be asked: ${e.message}` }; }
        if (!got.ok) return text(res, 409, got.why);
        if (decodeEntryContract(stored).limitPrice !== undefined) orderBook.noteTradable(decodeEntryContract(stored).roundId);
        return text(res, 201, `fee lock verified: contract ${got.contractId} holds ${got.feeMsat} msat`);
      }

      // WHERE A PLAYER'S STAKE LOCK IS, BY ITS REFUND KEY (W5a). A player who
      // comes back with only their seed can derive the round's refund key, and
      // nothing else - the outpoint and the stake point were random. Every lock
      // is public in the federation; this signer node answers with the ones it verified.
      // A STAKE LOCKED FOR A ROUND THIS NODE REFUSES, AND NEVER ENTERED, KEPT FOR ITS RETURN (§23.2 REFUSED; kanban #191,
      // the owner 2026-10-06 08:57: "A round the seats refuse gets an immediate refund"). Measured live 05:31Z: round 49a50535
      // refused, a page's 100 sat locked, no entry at any seat - back only after its expiry. Every check on this node's own
      // record: it refuses the round; the lock stakes no entry here; the lock's image is A0 of a handout this node accepted
      // for the round and its refund key that handout player's, who entered nothing here; the federation holds it under this
      // round's claim key. The forfeit (GET /forfeit?round&entry=<handout id>) then returns it to the player at once.
      if (req.method === 'POST' && url.pathname === '/refused-lock') {
        const rid = new Uint8Array(Buffer.from(url.searchParams.get('round') || '', 'hex'));
        if (rid.length !== 32) return text(res, 400, 'a refused-round lock is handed over for a round id');
        const row = round.get(rid);
        if (!row) return text(res, 404, 'this node holds no such round');
        const rc = decodeRoundContract(new Uint8Array(row.contract));
        const refusedWhy = offerRefusal(rc);
        if (!refusedWhy) return text(res, 409, 'this signer node offers that round: a stake in it is entered and settled with the round, never returned as refused');
        if (rc.stakeMsat === 0n || (rc.federationId.every((b) => b === 0) && !takesAnyFederation(rc))) return text(res, 409, 'that round takes no stake lock');
        if (!stakeLocks) return text(res, 409, 'this signer node reaches no federation, so it cannot read the lock');
        let fields, outpoint, lockFed = null;
        try {
          const body = JSON.parse(Buffer.from(await read(req)).toString('utf8'));
          fields = lockFieldsFromJson(body.fields);
          const [txid, outIdx] = String(body.outpoint || '').split(':');
          if (!/^[0-9a-f]{64}$/.test(txid || '') || !/^\d+$/.test(outIdx || '')) throw new Error('an outpoint is txid:index');
          outpoint = { txid: new Uint8Array(Buffer.from(txid, 'hex')), outIdx: BigInt(outIdx) };
          // ON A ROUND THAT TAKES ANY FEDERATION the body names the federation the lock is in (2026.0.3)
          if (takesAnyFederation(rc)) {
            if (!/^[0-9a-f]{64}$/.test(String(body.federation || ''))) throw new Error('that round takes any federation: name the one the lock is in (federation, 64 hex)');
            lockFed = new Uint8Array(Buffer.from(body.federation, 'hex'));
          }
        } catch (e) { return text(res, 400, `that is not a lock: ${e.message}`); }
        if (round.stakeLockAt(outpoint) || (round.feeLockAt && round.feeLockAt(outpoint)))
          return text(res, 409, 'that lock stakes an entry at this signer node: it is settled with its round, never returned as refused');
        const claimPk = claimKeyOf(rid);
        if (!(claimPk instanceof Uint8Array) || toHex(claimPk) !== toHex(fields.claimPk))
          return text(res, 409, 'that lock names another claim key than this round\'s');
        const image = fields.paymentImage || {};
        const hex = image.bytes instanceof Uint8Array ? toHex(image.bytes) : '';
        // THE STAKE: its image is A0 of the handout. ITS NODE-FEE LOCK (image H(F), the same transaction, the same refund key -
        // measured live 07:26Z: 49a50535's stake came back and its 2000 msat fee lock stayed for its expiry): the handout
        // whose player's refund key it names. Kept under an id of its own, H(handout id || "fee").
        let held = null;
        for (const h of round.handoutsOf(rid)) {
          let d; try { d = decodeHandout(h.bytes); } catch { continue; }
          if (image.kind === 'point' && d.commitments[0] && toHex(d.commitments[0]) === hex) { held = { id: h.id, handout: d }; break; }
          if (image.kind === 'hash' && toHex(refundKeyOf(d.playerPubkey)) === toHex(fields.refundPk)) {
            held = { id: sha256(new Uint8Array([...h.id, ...new TextEncoder().encode('fee')])), handout: d }; break; }
        }
        if (!held) return text(res, 409, image.kind === 'hash'
          ? 'this signer node holds no handout for that round whose player that fee lock refunds to: no fee of that round'
          : 'this signer node holds no handout for that round whose A0 is the lock\'s image: no stake of that round');
        if (toHex(refundKeyOf(held.handout.playerPubkey)) !== toHex(fields.refundPk))
          return text(res, 409, 'that lock\'s refund key is not the handout player\'s: it returns to nobody this round dealt');
        const player = toHex(held.handout.playerPubkey);
        if (round.entriesOf(rid).some(({ entry }) => toHex(entry.playerPubkey) === player))
          return text(res, 409, 'that player entered the round at this signer node: the stake is settled with the round');
        const lport = (lockFed ? await portOfFederation(lockFed) : await portOfRid(rid)) || stakeLocks;
        const [st, id] = await Promise.all([lport.status(outpoint), lport.contractId(fields)]);
        if (!st || !st.stored) return text(res, 409, 'the federation holds no lock at that outpoint: spent, or never made');
        if (String(id) !== String(st.stored.contractId)) return text(res, 409, 'the lock at that outpoint is not the contract handed over: its id is another');
        if (fields.expiration !== st.blockCount + st.stored.blocksLeft) return text(res, 409, 'that contract\'s expiration is not the one the federation holds');
        round.putRefusedLock({ handoutId: held.id, roundId: rid, outpoint, fields: lockFieldsToJson(fields), contractId: String(id) });
        console.log(`[refused-lock] ${toHex(rid).slice(0, 16)}: ${String(fields.amountMsat)} msat kept for its return (${String(refusedWhy).slice(0, 80)})`);
        return text(res, 201, `kept for its return: forfeit it at /forfeit?round=${toHex(rid)}&entry=${toHex(held.id)}`);
      }

      if (req.method === 'GET' && url.pathname === '/stake-lock') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const refund = (url.searchParams.get('refund') || '').toLowerCase();
        if (rid.length !== 32 || !/^0[23][0-9a-f]{64}$/.test(refund))
          return text(res, 400, 'a stake lock is asked for by a round id and a 33-byte refund key');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        // AND THE LOCKS KEPT FOR A REFUSED ROUND (§23.2 REFUSED, kanban #191), under their handout's id
        return res.end(JSON.stringify([...round.stakeLocksFor(new Uint8Array(rid), refund), ...round.refusedLocksFor(new Uint8Array(rid), refund)]));
      }

      // THE COMMITTEE'S FORFEIT OF A QUALIFIER'S STAKE LOCK (§23.2 row 1, W5b).
      // Between signer nodes: round one (a nonce commitment), round two (a signature
      // share over one commitment list), and the combined signature handed
      // over. Each signer node answers only for a forfeit it rebuilt from its own
      // verified lock, final and qualifying by its own record (forfeit.js).
      if (req.method === 'POST' && ['/forfeit-commit', '/forfeit-share', '/forfeit-signature'].includes(url.pathname)) {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (rid.length !== 32 || eid.length !== 32) return text(res, 400, 'a forfeit is asked for by a round id and an entry id');
        const r8 = new Uint8Array(rid);
        const e8 = new Uint8Array(eid);
        // `lock=fee`: a cancelled order's or a refunded market's fee lock (kanban #278), else the stake lock as always
        const kind = url.searchParams.get('lock') === 'fee' ? 'fee' : 'stake';
        if (url.pathname === '/forfeit-commit') {
          const got = await forfeits.commit(r8, e8, kind);
          if (!got.ok) return text(res, got.status || 409, got.why);
          res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
          return res.end(Buffer.from(encodeCommitments([got.commitment])));
        }
        if (url.pathname === '/forfeit-share') {
          let list;
          try { list = decodeCommitments(new Uint8Array(await read(req))); } catch (e) { return text(res, 400, e.message); }
          const got = await forfeits.share(r8, e8, list, kind);
          if (!got.ok) return text(res, got.status || 409, got.why);
          res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
          return res.end(Buffer.from(encodeShare(got.share)));
        }
        const signature = new Uint8Array(await read(req));
        if (signature.length !== 64) return text(res, 400, 'a forfeit is a 64-byte signature');
        const got = await forfeits.take(r8, e8, signature, kind);
        return got.ok ? text(res, 201, 'forfeit kept') : text(res, got.status || 409, got.why);
      }

      // THE ROUND'S ONE SETTLEMENT OF ITS LOSERS' LOCKS (W4), between signer nodes: a
      // nonce commitment, a share over one commitment list, the combined
      // signature. Each signer node answers only for the txid it rebuilt itself from its
      // own record (settlement.js).
      if (req.method === 'POST' && ['/settle-commit', '/settle-share', '/settle-signature'].includes(url.pathname)) {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'a settlement is asked for by a round id');
        const r8 = new Uint8Array(rid);
        { const why = seriesRefusalOfRound(r8); if (why) return text(res, 409, `settlement refused: ${why}`); }
        // A LATE LOSER'S SECOND SETTLEMENT (C3b-1) is asked for by its entry as well: one per (round, entry).
        const lateHex = url.searchParams.get('entry');
        const entry = lateHex ? new Uint8Array(Buffer.from(lateHex, 'hex')) : null;
        if (entry && entry.length !== 32) return text(res, 400, 'a late settlement is asked for by a 32-byte entry id');
        // ONE FEDERATION'S SETTLEMENT of a round that takes any federation (2026.0.3) is asked for by that federation's id
        const federation = url.searchParams.get('federation');
        if (federation !== null && !/^[0-9a-f]{64}$/.test(federation)) return text(res, 400, 'a federation\'s settlement is asked for by its 64-hex id');
        if (url.pathname === '/settle-commit') {
          const got = await settlements.commit(r8, { txid: url.searchParams.get('txid'), entry, federation });
          if (!got.ok) return text(res, got.status || 409, got.why);
          res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
          return res.end(Buffer.from(encodeCommitments([got.commitment])));
        }
        if (url.pathname === '/settle-share') {
          let list;
          try { list = decodeCommitments(new Uint8Array(await read(req))); } catch (e) { return text(res, 400, e.message); }
          const got = await settlements.share(r8, list, { entry, federation });
          if (!got.ok) return text(res, got.status || 409, got.why);
          res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
          return res.end(Buffer.from(encodeShare(got.share)));
        }
        const signature = new Uint8Array(await read(req));
        if (signature.length !== 64) return text(res, 400, 'a settlement signature is 64 bytes');
        const got = await settlements.take(r8, signature, { entry, federation });
        return got.ok ? text(res, 201, 'settlement signature kept') : text(res, got.status || 409, got.why);
      }

      // WHERE A WINNING GOES, NAMED ONCE (the owner 2026-09-21: "winnings are always sent. There is no Collect").
      // The body is the Lightning address and a 64-byte signature over it by the entry's session key: a standing
      // instruction kept before anything is owed, so the settlement can send with no page open.
      if (req.method === 'POST' && url.pathname === '/payout-address') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'an address is named for an entry id');
        const stored = round.entry(eid);
        if (!stored) return text(res, 404, 'this node holds no such entry');
        const entry = decodeEntryContract(stored);
        const all = new Uint8Array(await read(req));
        if (all.length <= 64) return text(res, 400, 'that is too short to be an address and a signature');
        const signed = all.subarray(0, all.length - 64);
        if (!ed25519.verify(all.subarray(all.length - 64), signed, entry.sessionPubkey))
          return text(res, 403, 'that address is not signed by the session key this entry was played with');
        const address = Buffer.from(signed).toString('utf8').trim();
        const where = lightningAddressEndpoint(address);
        if (!where.ok) return text(res, 400, where.why);
        // THE FIRST ADDRESS STANDS (ruled 2026-09-23): the same address again is taken and changes nothing - the page
        // posts it again to a node that did not answer - and another one for this entry is refused, so no second
        // address can make the signer nodes hold different ones.
        const held = round.payoutAddress(new Uint8Array(eid));
        if (held && held.address !== address)
          return text(res, 409, 'this entry already named its Lightning address, and the first one stands');
        if (!held) round.putPayoutAddress({ entryId: new Uint8Array(eid), roundId: entry.roundId, address });
        res.writeHead(201, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ entry: eid.toString('hex'), address, state: 'NAMED',
          why: 'the winning is sent here when the round settles; nothing more is asked of the player' }) + '\n');
      }

      // THE FIRST PLAN THIS SIGNER NODE KEEPS, for an asker that takes the round over: it adopts a kept plan that stands
      // rather than fetching a second invoice.
      if (req.method === 'GET' && url.pathname === '/settle-sends') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'send plans are for a round id');
        { const why = seriesRefusalOfRound(new Uint8Array(rid)); if (why) return text(res, 409, `settlement refused: ${why}`); }
        if (!winnings) return text(res, 409, 'this signer node sends no winnings');
        // A LATE SETTLEMENT'S PLANS (C3b-2a), asked for by its late entry as well.
        const lateHex = url.searchParams.get('late');
        const sender = lateHex ? settlements.lateWinningsFor(new Uint8Array(rid), new Uint8Array(Buffer.from(lateHex, 'hex'))) : winnings;
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(sender.keptPlan(new Uint8Array(rid))));
      }

      // THE COORDINATOR'S SEND PLANS, between signer nodes: kept only if each stands here (winnings-send.js).
      if (req.method === 'POST' && url.pathname === '/settle-sends') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'send plans are for a round id');
        { const why = seriesRefusalOfRound(new Uint8Array(rid)); if (why) return text(res, 409, `settlement refused: ${why}`); }
        let proposed;
        try { proposed = JSON.parse(Buffer.from(await read(req)).toString('utf8')); } catch (e) { return text(res, 400, `not JSON: ${e.message}`); }
        if (!Array.isArray(proposed)) return text(res, 400, 'send plans are a list');
        const lateHex = url.searchParams.get('late');
        if (lateHex && !/^[0-9a-f]{64}$/.test(lateHex)) return text(res, 400, 'a late settlement is named by a 32-byte entry id');
        const got = lateHex
          ? await settlements.takeLateSends(new Uint8Array(rid), new Uint8Array(Buffer.from(lateHex, 'hex')), proposed)
          : await settlements.takeSends(new Uint8Array(rid), proposed);
        // THE ANSWER IS THIS SEAT'S SIGNATURE over the plan's id (plan-taken.js), not a status the asker counts.
        if (!got.ok) return text(res, got.status || 409, got.why);
        res.writeHead(201, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(got.taken));
      }

      // THE SEATS' SIGNED AGREEMENT A SETTLEMENT'S SEND PLAN WAS TAKEN BY: the plan id and the signed acceptances that
      // counted, concatenated (128 bytes each), for anyone who checks the threshold for themselves.
      // AND HANDED IN by the asker: kept only if it stands against the plan this seat kept (settlement.js takeCertificate).
      if (req.method === 'POST' && url.pathname === '/settle-taken') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'a signed agreement is for a round id');
        const lateHex = url.searchParams.get('late');
        if (lateHex && !/^[0-9a-f]{64}$/.test(lateHex)) return text(res, 400, 'a late settlement is named by a 32-byte entry id');
        const got = settlements.takeCertificate(new Uint8Array(rid), lateHex ? new Uint8Array(Buffer.from(lateHex, 'hex')) : null,
          new Uint8Array(await read(req)));
        return got.ok ? text(res, 201, `${got.agreed} of ${got.needed} seats' signed agreement kept`) : text(res, got.status || 409, got.why);
      }

      if (req.method === 'GET' && url.pathname === '/settle-taken') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'a signed agreement is for a round id');
        const lateHex = url.searchParams.get('late');
        if (lateHex && !/^[0-9a-f]{64}$/.test(lateHex)) return text(res, 400, 'a late settlement is named by a 32-byte entry id');
        const kept = settlements.planCertificate(new Uint8Array(rid), lateHex ? new Uint8Array(Buffer.from(lateHex, 'hex')) : null);
        if (!kept) return text(res, 404, 'this seat holds no signed agreement for that settlement');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ planId: toHex(kept.planId), certificate: toHex(kept.certificate) }));
      }

      // THE AUTH OF A SEND, between signer nodes: a commitment and a share over the invoice's consensus hash, each
      // signer node answering only for the message it rebuilt; and the preimage, kept only if it is the invoice's.
      if (req.method === 'POST' && ['/send-commit', '/send-share', '/winnings-paid'].includes(url.pathname)) {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eHex = String(url.searchParams.get('entry') || '');
        if (rid.length !== 32 || !/^[0-9a-f]{64}$/.test(eHex)) return text(res, 400, 'a send is asked for by a round id and an entry id');
        if (!winnings) return text(res, 409, 'this signer node sends no winnings');
        const r8 = new Uint8Array(rid);
        // A LATE SETTLEMENT'S SEND (C3b-2a): `late` names it; its rows, its sender and its rebuilt transaction answer.
        const lateHex = url.searchParams.get('late');
        if (lateHex && !/^[0-9a-f]{64}$/.test(lateHex)) return text(res, 400, 'a late settlement is named by a 32-byte entry id');
        const late8 = lateHex ? new Uint8Array(Buffer.from(lateHex, 'hex')) : null;
        if (late8 && !round.lateLockSettlement(r8, late8)) return text(res, 409, 'no late settlement for that entry');
        const sender = late8 ? settlements.lateWinningsFor(r8, late8) : winnings;
        if (url.pathname === '/winnings-paid') {
          const pre = new Uint8Array(await read(req));
          if (pre.length !== 32) return text(res, 400, 'a preimage is 32 bytes');
          const got = sender.paid(r8, eHex, pre);
          return got.ok ? text(res, 201, 'the winning is kept as paid') : text(res, got.status || 409, got.why);
        }
        const built = late8 ? await settlements.lateMessage(r8, late8) : await settlements.message(r8);
        if (!built.ok) return text(res, built.status || 409, built.why);
        const kind = url.searchParams.get('kind') === 'resend' ? 'resend' : 'auth';
        const attempt = url.searchParams.has('attempt') ? Number(url.searchParams.get('attempt')) : null;
        if (url.pathname === '/send-commit') {
          const got = await sender.commit(r8, eHex, built, kind, attempt, { hash: url.searchParams.get('hash') });
          if (!got.ok) return text(res, got.status || 409, got.why);
          res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
          return res.end(Buffer.from(encodeCommitments([got.commitment])));
        }
        let list;
        try { list = decodeCommitments(new Uint8Array(await read(req))); } catch (e) { return text(res, 400, e.message); }
        const got = await sender.share(r8, eHex, built, list, kind, attempt);
        if (!got.ok) return text(res, got.status || 409, got.why);
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(encodeShare(got.share)));
      }

      // A RE-SEND OF AN EXPIRED WINNING, between signer nodes: kept only if the previous attempt expired here, the gateway
      // is the next live key here, and the invoice stands here (winnings-send.js `checkResend`).
      if (req.method === 'POST' && url.pathname === '/resend-sends') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'a re-send is for a round id');
        if (!winnings) return text(res, 409, 'this signer node sends no winnings');
        let proposed;
        try { proposed = JSON.parse(Buffer.from(await read(req)).toString('utf8')); } catch (e) { return text(res, 400, `not JSON: ${e.message}`); }
        // A LATE SETTLEMENT'S RE-SEND (slice C3b-2b): `late` names it; its rows and its rebuilt transaction answer, and a
        // `late` that names no late settlement of this round - a first-round entry, say - is refused by name.
        const lateHex = url.searchParams.get('late');
        if (lateHex && !/^[0-9a-f]{64}$/.test(lateHex)) return text(res, 400, 'a late settlement is named by a 32-byte entry id');
        const late8 = lateHex ? new Uint8Array(Buffer.from(lateHex, 'hex')) : null;
        if (late8 && !round.lateLockSettlement(new Uint8Array(rid), late8)) return text(res, 409, 'no late settlement for that entry');
        const built = late8 ? await settlements.lateMessage(new Uint8Array(rid), late8) : await settlements.message(new Uint8Array(rid));
        if (!built.ok) return text(res, built.status || 409, built.why);
        const sender = late8 ? settlements.lateWinningsFor(new Uint8Array(rid), late8) : winnings;
        const got = await sender.checkResend(new Uint8Array(rid), built, proposed);
        return got.ok ? text(res, 201, 're-send checked and kept') : text(res, got.status || 409, got.why);
      }

      // AND IN PUBLIC: THE PENDING LINE'S FIGURE (WINDOW-10-SPEC, §24): this entry's state, its row of the payout table over
      // the results signed so far, and the window's open and close (the round's end, and 600 s after). Read-only.
      if (req.method === 'GET' && url.pathname === '/standing') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'a standing is asked for by entry id');
        const stored = round.entry(eid);
        if (!stored) return text(res, 404, 'this node holds no such entry');
        const rid = decodeEntryContract(stored).roundId;
        const row = round.get(rid);
        if (!row) return text(res, 404, 'this node holds no such round');
        const s = standingOf(round, rid, new Uint8Array(eid), decodeRoundContract(new Uint8Array(row.contract)));
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ entry: eid.toString('hex'), round: toHex(rid), nowMs: String(Date.now()), ...s }) + '\n');
      }

      // AND IN PUBLIC: where an entry's winning stands - its plan, its contract, and the preimage once paid.
      if (req.method === 'GET' && url.pathname === '/winnings') {
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (eid.length !== 32) return text(res, 400, 'a winning is asked for by entry id');
        const stored = round.entry(eid);
        if (!stored) return text(res, 404, 'this node holds no such entry');
        const rid = decodeEntryContract(stored).roundId;
        const send = round.sendPlansOf(rid).find((r) => toHex(r.entryId) === eid.toString('hex'));
        const paid = round.winnings(new Uint8Array(eid));
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ entry: eid.toString('hex'),
          send: send ? { ...sendPlanToJson(send), state: send.state, why: send.why, txid: send.txid, outIdx: send.outIdx, preimage: send.preimage } : null,
          winnings: paid ? { state: paid.state, owedMsat: String(paid.owedMsat), request: paid.request, paidMs: paid.paidMs } : null }) + '\n');
      }

      // AND IN PUBLIC: where the round's settlement of its losers' locks stands.
      // A ROUND'S CREATOR SIGNATURE (§6, kanban #313): what rides beside a contract that names its creator, hex - 404 with none
      if (req.method === 'GET' && url.pathname === '/round-creator') {
        const rid = Buffer.from(url.searchParams.get('id') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'a creator signature is asked for by a round id');
        const sig = round.creatorSignature(new Uint8Array(rid));
        if (!sig) return text(res, 404, 'this signer node holds no creator signature for that round');
        return text(res, 200, toHex(sig));
      }

      if (req.method === 'GET' && url.pathname === '/lock-settlement') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'a settlement is asked for by a round id');
        // A ROUND THAT TAKES ANY FEDERATION (2026.0.3): one settlement per federation, each its own row
        const feds = settlements.fedSummary ? await settlements.fedSummary(new Uint8Array(rid), { moved: true }) : [];
        if (feds.length) {
          const all = feds.every((f) => f.state === 'ACCEPTED');
          res.writeHead(200, { 'content-type': 'application/json', ...CORS });
          return res.end(JSON.stringify({ state: all ? 'ACCEPTED' : feds.some((f) => f.state === 'REFUSED') ? 'REFUSED' : 'SUBMITTING', federations: feds }));
        }
        const kept = round.lockSettlement(new Uint8Array(rid));
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(kept
          ? { state: kept.state, txid: kept.txid, why: kept.why, signature: toHex(kept.signature), message: toHex(kept.message),
            madeMs: kept.madeMs, moved: await settlements.summaryOf(new Uint8Array(rid)) }
          : { state: 'NONE' }));
      }

      // AND IN PUBLIC: THE ROUNDS SETTLED SINCE A TIME (spec §24, the owner 2026-09-14). A player on
      // another device - alice on her iPhone two hours after the desktop - holds only the seed:
      // it derives its key for each round listed here and matches it against the keys the round's
      // settlement pays and the refund keys of its verified locks - both public already (the
      // settlement at /lock-settlement, a refund key from the entry's player key). The device asks
      // nothing per round, so no signer node learns which rounds it looks for; the contract of a round it
      // matched it takes from /round. At most 7 days back, at most 500 rounds.
      if (req.method === 'GET' && url.pathname === '/settled') {
        const nowMs = Number(round.now());
        const asked = Number(url.searchParams.get('since') || '');
        if (!Number.isFinite(asked) || asked < 0) return text(res, 400, 'rounds settled since a time are asked for with since=<ms>');
        const since = Math.max(asked, nowMs - 7 * 24 * 3600 * 1000);
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        // WHAT EACH SETTLEMENT MOVED, after a restart too (#133): asked one round at a time, kept once found
        const listedRounds = [];
        for (const r of round.settledSince(since)) listedRounds.push({ r, moved: await settlements.summaryOf(r.roundId) });
        return res.end(JSON.stringify({ node: toHex(round.pubkey), nowMs: String(nowMs), since: String(since),
          rounds: listedRounds.map(({ r, moved }) => {
            return { id: toHex(r.roundId), state: r.state, madeMs: String(r.madeMs),
              payouts: moved && Array.isArray(moved.payouts) ? moved.payouts.filter((p) => p.kind === 'qualifier').map((p) => String(p.pk).toLowerCase()) : [],
              refunds: r.refunds };
          }) }));
      }

      // AND IN PUBLIC: the forfeit of a qualifier's lock - kept, or made now with
      // the other signer nodes if it is due. A loser's, or one inside its window, is 409.
      if (req.method === 'GET' && url.pathname === '/forfeit') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (rid.length !== 32 || eid.length !== 32) return text(res, 400, 'a forfeit is asked for by a round id and an entry id');
        const got = await forfeits.forfeit(new Uint8Array(rid), new Uint8Array(eid), url.searchParams.get('lock') === 'fee' ? 'fee' : 'stake');
        if (!got.ok) return text(res, got.status || 409, got.why);
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ signature: toHex(got.signature), contractId: toHex(got.message),
          claimPk: toHex(got.claimPk), kept: !!got.kept }));
      }

      // THIS SIGNER NODE'S SIGNED CLAIM KEY (v4.6.2 §23.1 step 0, F3): "each signer node signs
      // (round_id, claim_pk). The key is valid only with signatures from >=5
      // signer nodes; a client MUST refuse to lock to a key without them." The
      // attestation's bytes and, beside them, this node's BIP-340 signature over
      // their id - the signer node key is in the signed bytes, so a signature cannot be
      // moved to another signer node's record. Only a Assigned node attests.
      // THE DONATION SET THIS ROUND NAMES (M3.2 6e, §22A): its signed bytes then
      // the 64-byte Ed25519 signature, or 404 - a signer node serves no set it cannot
      // stand behind. Before: no signer node served one (404 for every round).
      // AND THE AUTHORITY ROTATIONS THIS SIGNER NODE HOLDS FOR THE ROUND'S NETWORK
      // (§27A.4), so a page applies them too: a set the old authority signed
      // after a rotation is in force is no set. Served as held; the page checks
      // each against the network's recovery key itself.
      if (req.method === 'GET' && url.pathname === '/donation-rotations') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'that is not a round id');
        const row = round.get(rid);
        if (!row) return text(res, 404, 'this node holds no such round');
        const network = toHex(decodeRoundContract(new Uint8Array(row.contract)).networkId);
        const held = donationRotations.filter((r) => r && r.networkId instanceof Uint8Array && toHex(r.networkId) === network);
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ rotations: held.map((r) => ({ body: toHex(encodeAuthorityRotation(r)), signature: toHex(r.signature) })) }));
      }

      // THE ROUND'S GAME DEV'S DONATION SET (§0A.8, kanban #205): the recipients the game's manifest names by id, as this
      // node hosts the game - its encoding (donation.js encodeDonationSet). A client takes it only if it hashes to the
      // game_donation_set its own known-games list carries for the round's game.
      if (req.method === 'GET' && url.pathname === '/game-donation-set') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'that is not a round id');
        const row = round.get(rid);
        if (!row) return text(res, 404, 'this node holds no such round');
        const c = decodeRoundContract(new Uint8Array(row.contract));
        const game = c.gameId instanceof Uint8Array ? hosted.get(toHex(c.gameId)) : null;
        if (!game || !Array.isArray(game.donationSet)) return text(res, 404, 'this node holds no donation set of that round\'s game');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(encodeDonationSet(game.donationSet)));
      }
      // THE ROUND'S GAME MANIFEST (§0A.3, kanban #206 slice 2): its signed bytes, as this node hosts the game. A page takes it
      // only if it hashes to the round's game_id - for a game it does not pin (a market), shown with its developer key and
      // manifest id and staked on only after the second confirmation (§0A.6).
      if (req.method === 'GET' && url.pathname === '/game-manifest') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'that is not a round id');
        const row = round.get(rid);
        if (!row) return text(res, 404, 'this node holds no such round');
        const c = decodeRoundContract(new Uint8Array(row.contract));
        const game = c.gameId instanceof Uint8Array ? hosted.get(toHex(c.gameId)) : null;
        if (!game) return text(res, 404, 'this node does not host that round\'s game');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(encodeManifest(game.manifest)));
      }
      if (req.method === 'GET' && url.pathname === '/donation-set') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'that is not a round id');
        const row = round.get(rid);
        if (!row) return text(res, 404, 'this node holds no such round');
        const served = donationSetFor(decodeRoundContract(new Uint8Array(row.contract)));
        if (!served.ok) return text(res, 404, served.why);
        const body = encodeDonationSetBody(served.set);
        const out = new Uint8Array(body.length + served.set.signature.length);
        out.set(body, 0);
        out.set(served.set.signature, body.length);
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(out));
      }

      if (req.method === 'GET' && url.pathname === '/claim-key') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'that is not a round id');
        if (!round.get(rid)) return text(res, 404, 'this node holds no such round');
        if (!round.signerNodes(rid).some((k) => toHex(k) === toHex(round.pubkey)))
          return text(res, 409, 'this node is not assigned to that round, so it attests no claim key for it');
        const claimPk = claimKeyOf(new Uint8Array(rid));
        if (!(claimPk instanceof Uint8Array) || claimPk.length !== 33)
          return text(res, 409, 'this signer node holds no claim key for that round yet');
        const a = { roundId: new Uint8Array(rid), claimPk, signerNodePubkey: round.pubkey };
        const body = encodeClaimKeyAttestation(a);
        const sig = schnorr.sign(claimKeyAttestationId(a), round.identity.secret);
        const out = new Uint8Array(body.length + sig.length);
        out.set(body, 0);
        out.set(sig, body.length);
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(out));
      }

      // EVERY SIGNER NODE'S RE-RUN OF A SUSPENDED RESULT (13A), fixed-size records.
      if (req.method === 'GET' && url.pathname === '/reruns') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        // THIS SEAT'S OWN RE-RUN, SIGNED AGAIN NOW (§13A, WINDOW-10-SPEC): a holder counts a re-run only within 5 s of its
        // own clock at arrival, so the one this seat signed is handed out with this moment's time - the same result.
        const held = round.reruns(rid, eid).map((r) => {
          if (toHex(r.signerNodePubkey) !== toHex(round.pubkey)) return r;
          try {
            const x = { ...decodeRerunResult(splitSignedRerun(r.bytes).body), signedAtMs: BigInt(round.now()) };
            return { ...r, bytes: joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), round.identity.secret)) };
          } catch { return r; }
        });
        const out = new Uint8Array(held.length * SIGNED_RERUN_BYTES);
        held.forEach((r, i) => out.set(r.bytes, i * SIGNED_RERUN_BYTES));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-reruns': String(held.length), ...CORS });
        return res.end(Buffer.from(out));
      }

      // EVERY SLASH PROOF THIS NODE FILED FOR A RUN (5A.3B step 1), each with
      // the signed result it accuses, fixed-size records back to back.
      // WHAT A FILED SLASH OWES, at a height the ARBITRATION SET NAMES (§5A.3, ruled 2026-09-22).
      //
      // The height is the caller's, not this node's: §5A.3 pays "the active census nodes at the
      // slashing height", and that height is one the arbitration set names - at or below the tip when
      // they sign, at or above the round's own census height. So the door takes it and refuses it out
      // of range rather than choosing one, and `slashOwing` refuses it BEFORE any census is read at it.
      //
      // IT RECORDS NOTHING AND SPENDS NOTHING. Steps 3 and 5 of §5A.3B - the escrow output and MuSig2
      // over the arbitration keys - are not in this tree and this door does not pretend they are. What
      // it is for: every observer must be able to recompute the same recipient list from chain data
      // before any money is built on it, and the first time those numbers are worked out should not be
      // the first time money moves.
      if (req.method === 'GET' && url.pathname === '/slash-owing') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        if (rid.length !== 32 || eid.length !== 32) return text(res, 400, 'a round id and an entry id are 32 bytes');
        if (!url.searchParams.has('height')) return text(res, 400, 'a slash is owed at a height, and this node does not pick one');
        const height = Number(url.searchParams.get('height'));
        const row = round.get(rid);
        if (!row) return text(res, 404, 'this node holds no such round');
        const contract = decodeRoundContract(new Uint8Array(row.contract));
        const held = round.slashProofs(rid, eid);
        if (!held.length) return text(res, 404, 'this node filed no slash proof for that run');

        // AND THE HEIGHT IS BOUNDED BEFORE ANY CENSUS IS DERIVED AT IT.
        //
        // `slashOwing` refuses an out-of-range height in its first step, and `slash-owing.test.js` pins
        // that ORDER - "a height nobody can read yet must not send a node reading a census at it". The
        // door was calling it second, after deriving, so a height below the round's own census height
        // made the node scan and root a whole census before saying the height was never valid. The tip
        // is not known without a view, so the bound that can be checked here is checked here and the
        // other stays where it is.
        if (height < contract.censusHeight)
          return text(res, 409, `${height} is below the round's census height ${contract.censusHeight}`);

        // THE CENSUS AT THAT HEIGHT, read once for every proof: the recipients and, in the same rows,
        // the bond values. A proof names `bondTxid`/`bondVout` and NEVER an amount, and the ruling puts
        // the slashing height at or below the tip when the set signs, so the accused bond is still
        // unspent there and the census entry still carries what the chain says it is worth.
        const at = roster.censusAtHeight(rid, height);
        if (!at.ok) return text(res, 409, at.why);
        const censusKeys = at.entries.map((e) => e.pubkey);
        const bondOf = (nodePubkey) => {
          const e = at.entries.find((x) => toHex(x.pubkey) === toHex(nodePubkey));
          return e && typeof e.bondSats === 'bigint' ? e.bondSats : 0n;
        };
        const entries = entriesForSlash(round, new Uint8Array(rid));

        const owing = [];
        for (const p of held) {
          let proof;
          try { proof = splitSlashEvidence(p.bytes).proof; }
          catch (e) { owing.push({ node: toHex(p.nodePubkey), why: `unreadable proof: ${e.message}` }); continue; }

          // THE OFFENCE IS NOT IN THE PROOF'S BYTES, and this node does not guess one. `encodeSlashProof`
          // carries a transcript hash and a signed result id and no offence field, because the offence is
          // what VERIFYING those two objects concludes. Every proof in this table was filed by
          // `fileSlashProofs`, which files exactly one kind - a replay that contradicts a signed result -
          // so that is the offence named here. A proof arriving by any other road would need its own
          // verdict carried with it, and until one does, none is invented.
          const said = await slashOwing({
            proof, offence: REPLAY_CONTRADICTS, contract, roundIdBytes: new Uint8Array(rid), entries,
            slashHeight: height, tipHeight: at.tipHeight,
            censusAt: async () => censusKeys,
            bondSatsOf: async () => bondOf(proof.nodePubkey),
          });
          if (!said.ok) { owing.push({ node: toHex(proof.nodePubkey), why: said.why }); continue; }
          const o = said.owing;
          owing.push({
            node: o.node, bond: o.bond, offence: o.offence, bondSats: String(o.bondSats),
            toPlayers: String(o.toPlayers), toNodes: String(o.toNodes), toDevelopers: String(o.toDevelopers),
            players: [...o.players].map(([k, v]) => ({ player: k, sats: String(v) })),
            nodes: [...o.nodes].filter(([, v]) => v > 0n).map(([k, v]) => ({ node: k, sats: String(v) })),
            censusSeen: o.censusSeen, seatsOut: o.seatsOut,
          });
        }
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ slashHeight: height, tipHeight: at.tipHeight, owing }));
      }

      // THE ARBITRATION SET'S INTAKE (kanban #307, spec 5A.3B step 1): every slash proof this node filed - round, entry,
      // accused node, proof id - for the arbiter to fetch with its evidence (GET /slash-proofs) and judge itself
      if (req.method === 'GET' && url.pathname === '/slashes') {
        const rows = round.allSlashProofs().map((r) => ({ round: toHex(r.roundId), entry: toHex(r.entryId), node: toHex(r.nodePubkey),
          proof: toHex(r.proofId), seenMs: r.seenMs, objection: !!round.objectionBundle(r.roundId, r.entryId) }));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
        return res.end(JSON.stringify({ node: toHex(round.pubkey), slashes: rows }));
      }
      // AND THE OBJECTION THAT HELD AGAINST A RUN, as it was checked at this door (§13A): what the arbiter replays again
      if (req.method === 'GET' && url.pathname === '/objection-bundle') {
        const b = round.objectionBundle(Buffer.from(url.searchParams.get('round') || '', 'hex'), Buffer.from(url.searchParams.get('entry') || '', 'hex'));
        if (!b) return text(res, 404, 'this node holds no objection for that run');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(b));
      }
      // THIS GUARDIAN'S SIGNATURE OVER ITS FEDERATION'S RECORD (§23A.4, kanban #321), with `gone` named: the same body
      // with those guardians gone - and its own word on whether it is leaving, signed
      if (req.method === 'GET' && url.pathname === '/federation-record') {
        const fid = String(url.searchParams.get('federation') || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(fid)) return text(res, 400, 'a federation id, 32 bytes hex');
        const goneHex = String(url.searchParams.get('gone') || '').split(',').filter(Boolean).map((x) => x.toLowerCase());
        // `height` (kanban #321): the census height the gathering seat built its body at - this seat signs that body or none
        const h = url.searchParams.get('height');
        if (h !== null && !/^[0-9]{1,10}$/.test(h)) return text(res, 400, 'a census height, a whole number');
        const atHeight = h === null ? null : Number(h);
        // `reserve` (kanban #324): the reserve the gathering seat read; this seat signs it only on its own same reading
        const rv = url.searchParams.get('reserve');
        if (rv !== null && !/^[0-9]{1,16}$/.test(rv)) return text(res, 400, 'a reserve, whole satoshi');
        // `absent` (kanban #322): the absence attestations that prove a named peer ABANDONED, each encoding + signature in hex
        const absentHex = String(url.searchParams.get('absent') || '').split(',').filter(Boolean);
        const departedHex = String(url.searchParams.get('departed') || '').split(',').filter(Boolean);
        const r = goneHex.length ? await fedRecords.mySignatureWithGone(fid, goneHex, atHeight, rv, absentHex, departedHex) : await fedRecords.mySignature(fid, atHeight, rv);
        res.writeHead(r.ok ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
        return res.end(JSON.stringify(r));
      }
      // EVERY FEDERATION RECORD THIS SEAT HOLDS, signed by the threshold of its bonded guardians (§23A.4: "every seat
      // mirrors the newest record of every federation its census knows"); ?fresh=1 gathers again now
      // RESERVE SEATS (§5A.7, kanban #301): PRESENT in and out, this node's seating signature, the certificate, a proof of
      // equivocation
      const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS }); return res.end(JSON.stringify(body)); };
      if (req.method === 'POST' && url.pathname === '/absence') {
        let a; try { a = readAbsenceHex(Buffer.from(await read(req)).toString('utf8').trim()); } catch (e) { return text(res, 400, `an absence attestation, its encoding and signature in hex: ${e.message}`); }
        const r = absences.offer(a);
        return r.ok ? json(res, r.kept ? 201 : 200, r) : text(res, 422, r.why);
      }
      if (req.method === 'GET' && url.pathname === '/absences') {
        const fid = String(url.searchParams.get('federation') || '').toLowerCase();
        return json(res, 200, { node: toHex(round.pubkey), absences: absences.list(/^[0-9a-f]{64}$/.test(fid) ? fid : null), departures: absences.listDepartures(/^[0-9a-f]{64}$/.test(fid) ? fid : null) });
      }
      if (req.method === 'POST' && url.pathname === '/departure') {
        let d; try { d = readDepartureHex(Buffer.from(await read(req)).toString('utf8').trim()); } catch (e) { return text(res, 400, `a departure notice, its encoding and signature in hex: ${e.message}`); }
        const r = absences.offerDeparture(d);
        return r.ok ? json(res, r.kept ? 201 : 200, r) : text(res, 422, r.why);
      }
      // A CERTIFICATE HANDED OVER (§5A.7: "a node that sees two certificates for one round publishes both"): kept if it
      // stands against this node's draw; one that differs from the one held is the proof of equivocation
      if (seating && req.method === 'POST' && url.pathname === '/seating') {
        let rid, role, k;
        try { const c = decodeSeatingCertificate(await read(req)); rid = c.roundId; role = c.role; k = seating.keepCert(rid, role, encodeSeatingCertificate(c)); }
        catch (e) { return text(res, 400, `not a seating certificate: ${e.message}`); }
        if (!k.ok) return text(res, 409, k.why);
        return json(res, k.equivocation ? 200 : 201, k);
      }
      if (seating && req.method === 'POST' && url.pathname === '/present') {
        const r = seating.takePresent(await read(req));
        return r.ok ? text(res, 201, 'present kept') : text(res, 409, r.why);
      }
      // THE BATCH DOORS (kanban #345): many PRESENTs in one body, and one read of many rounds' seating state - the same
      // signed messages the per-round doors carry, one exchange per node per tick at grid density
      if (seating && req.method === 'POST' && url.pathname === '/presents') {
        const r = seating.takePresents(new Uint8Array(await read(req)));
        return r.ok ? json(res, 201, r) : text(res, 400, r.why);
      }
      if (seating && req.method === 'GET' && url.pathname === '/seating-batch') {
        const ids = String(url.searchParams.get('rounds') || '').toLowerCase().split(',').filter(Boolean);
        if (!ids.length || ids.length > 64 || !ids.every((h) => /^[0-9a-f]{64}$/.test(h))) return text(res, 400, 'rounds: 1 to 64 round ids, 32 bytes hex, comma-separated');
        return json(res, 200, seating.batchOf(ids));
      }
      if (seating && req.method === 'GET' && ['/present', '/seating', '/seating-sig', '/seating-equivocation'].includes(url.pathname)) {
        let rid; try { rid = fromHex(url.searchParams.get('round') || ''); } catch { rid = null; }
        if (!rid || rid.length !== 32) return text(res, 400, 'name a round: ?round=<64 hex>');
        const role = url.searchParams.get('role');
        if (url.pathname === '/present') return json(res, 200, { presents: seating.presentsOf(rid) });
        if (url.pathname === '/seating-equivocation') return json(res, 200, { equivocations: seating.equivocationOf(rid) });
        if (role !== 'game' && role !== 'settlement') return text(res, 400, 'name a role: game or settlement');
        if (url.pathname === '/seating-sig') { const m = seating.mySignature(rid, role); return m ? json(res, 200, m) : text(res, 404, 'this node signed no seating for that round and role'); }
        const cert = seating.certOf(rid, role);
        return cert ? json(res, 200, { cert }) : text(res, 404, 'no seating certificate for that round and role here');
      }
      if (req.method === 'GET' && url.pathname === '/federations') {
        if (url.searchParams.get('fresh') === '1') { try { await fedRecords.gatherAll((inv) => { const f = fedOf(inv); return f ? fromHex(String(f)) : null; }); } catch { /* the kept ones */ } }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
        // AND WHO THE DRAIN PAYS (§23A.6 step 5, kanban #325): per successor a kept record names, the predecessor's seated
        // guardians its guardian pool takes (roster.guardiansFor), by node key - none once the predecessor is CLOSED
        const listed = fedRecords.list();
        const drainPools = Object.fromEntries([...new Set(listed.map((f) => f.successor).filter(Boolean))]
          .map((succ) => [succ, fedRecords.predecessorGuardians(succ).map((k) => toHex(k))]));
        return res.end(JSON.stringify({ node: toHex(round.pubkey), federations: listed, drainPools }));
      }
      if (req.method === 'GET' && url.pathname === '/liquidations') {
        if (!liquidations) return json(res, 200, { node: toHex(round.pubkey), liquidations: [] });
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS });
        return res.end(JSON.stringify({ node: toHex(round.pubkey), liquidations: liquidations.list() }));
      }
      if (req.method === 'POST' && url.pathname === '/liquidations/spent-set') {
        if (!liquidations) return text(res, 503, 'this seat holds no federation records yet');
        let said; try { said = JSON.parse(Buffer.from(await read(req)).toString('utf8')); } catch { return text(res, 400, 'a spent set is JSON: { spentSet, signature } in hex'); }
        const r = liquidations.offer(said || {});
        return r.ok ? json(res, r.kept ? 201 : 200, r) : text(res, 422, r.why);
      }
      if (req.method === 'GET' && url.pathname === '/slash-proofs') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const held = round.slashProofs(rid, eid);
        const out = new Uint8Array(held.length * SLASH_EVIDENCE_BYTES);
        held.forEach((p, i) => out.set(p.bytes, i * SLASH_EVIDENCE_BYTES));
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-slash-proofs': String(held.length), ...CORS });
        return res.end(Buffer.from(out));
      }

      // A RELAY KEEPS A SLASH PROOF TOO, under the proof's own id and only with
      // the signed result it names beside it - so it serves no proof under
      // another's name and no proof without its evidence.
      const slashed = /^\/slash\/([0-9a-f]{64})$/.exec(url.pathname);
      if (slashed && req.method === 'PUT') {
        const bytes = await read(req);
        // A PROOF AGAINST A RE-RUN SIGNER (slice C2c) travels with the signed re-run it names, at its own size.
        if (bytes.length === RERUN_SLASH_EVIDENCE_BYTES) {
          let rr;
          try { rr = splitRerunSlashEvidence(new Uint8Array(bytes)); } catch (e) { return text(res, 400, e.message); }
          if (toHex(slashProofId(rr.proof)) !== slashed[1]) return text(res, 409, 'that is not the proof that id names');
          let rerunNamed;
          try { rerunNamed = toHex(rerunResultId(decodeRerunResult(splitSignedRerun(rr.signedRerun).body))); }
          catch (e) { return text(res, 409, `the evidence is not a signed re-run result: ${e.message}`); }
          if (rerunNamed !== toHex(rr.proof.signedResultId)) return text(res, 409, 'the evidence is not the re-run the proof names');
          round.relayPut(Buffer.from(slashed[1], 'hex'), bytes);
          return text(res, 201, 'kept');
        }
        let got;
        try { got = splitSlashEvidence(new Uint8Array(bytes)); } catch (e) { return text(res, 400, e.message); }
        if (toHex(slashProofId(got.proof)) !== slashed[1]) return text(res, 409, 'that is not the proof that id names');
        let named;
        try { named = toHex(resultId(decodePlayerResult(splitSignedResult(got.signedResult).body))); }
        catch (e) { return text(res, 409, `the evidence is not a signed result: ${e.message}`); }
        if (named !== toHex(got.proof.signedResultId)) return text(res, 409, 'the evidence is not the result the proof names');
        round.relayPut(Buffer.from(slashed[1], 'hex'), bytes);
        return text(res, 201, 'kept');
      }
      if (slashed && req.method === 'GET') {
        const kept = round.relayGet(Buffer.from(slashed[1], 'hex'));
        if (!kept) return text(res, 404, 'this relay holds no slash proof under that id');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(kept));
      }

      // A PUBLICATION RELAY (v4.6.2 §13A): any node can be one of a contract's
      // `publication_relays[]`. It keeps a transcript only under the hash its
      // own bytes have, so it can never serve one run's transcript as another's.
      const relayed = /^\/transcript\/([0-9a-f]{64})$/.exec(url.pathname);
      if (relayed && req.method === 'PUT') {
        const bytes = await read(req);
        if (toHex(transcriptBytesHash(new Uint8Array(bytes))) !== relayed[1])
          return text(res, 409, 'those bytes are not the transcript that hash names');
        round.relayPut(Buffer.from(relayed[1], 'hex'), bytes);
        return text(res, 201, 'kept');
      }
      if (relayed && req.method === 'GET') {
        const kept = round.relayGet(Buffer.from(relayed[1], 'hex'));
        if (!kept) return text(res, 404, 'this relay holds no transcript under that hash');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(kept));
      }

      // THIS SEAT'S FINAL SIGNATURE ON A RUN, SIGNED NOW (§13A, WINDOW-10-SPEC): 200 and the signed record once this seat
      // would sign - its window's close + 5 s passed on its own clock, the transcript posted, no valid objection received
      // in time - or the run is FINAL here; 409 and why otherwise.
      if (req.method === 'GET' && url.pathname === '/final-sig') {
        const rid = new Uint8Array(Buffer.from(url.searchParams.get('round') || '', 'hex'));
        const eid = new Uint8Array(Buffer.from(url.searchParams.get('entry') || '', 'hex'));
        let signed = null;
        let why = 'no such round';
        try {
          signed = round.get(rid) ? finalSignatureNow(round, rid, eid, signHere) : null;
          if (!signed && round.get(rid)) why = resultFinality(round, rid, eid).why || 'not signable';
        } catch (e) { why = e.message; }
        if (!signed) { res.writeHead(409, { 'content-type': 'text/plain', ...CORS }); return res.end(String(why)); }
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(signed));
      }
      // AND ONE PUSHED HERE: checked on arrival, against this seat's clock.
      if (req.method === 'POST' && url.pathname === '/final-sig') {
        const rid = new Uint8Array(Buffer.from(url.searchParams.get('round') || '', 'hex'));
        const eid = new Uint8Array(Buffer.from(url.searchParams.get('entry') || '', 'hex'));
        const body = new Uint8Array(await read(req));
        if (!round.get(rid) || body.length !== SIGNED_FINAL_SIG_BYTES) { res.writeHead(400, CORS); return res.end('not a FINAL signature for a round held here'); }
        const t = takeFinalSig(rid, eid, body);
        res.writeHead(t.kept === 'kept' ? 201 : 409, { 'content-type': 'text/plain', ...CORS });
        return res.end(t.kept === 'kept' ? 'kept' : String(t.why));
      }

      // AN OBJECTION AGAINST A RUN (13A intake). What an objection costs and
      // who may file one is the objection protocol and is not decided here;
      // that the node KNOWS of one is what lets the replay queue put it first.
      if (req.method === 'POST' && url.pathname === '/objection') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const blockHex = url.searchParams.get('block') || '';
        // AN OBJECTION CARRIES ITS TRANSCRIPT AND RECEIPTS (§13A, kanban #24, RULED the owner 2026-10-04): an empty body is
        // refused and nothing is stored; a bundle is checked here, on its own evidence, before it is taken in - one that
        // fails the check is refused with its reason, and nothing is stored either.
        // IT COUNTS BY WHEN IT REACHED THIS SEAT (§13A, WINDOW-10-SPEC): the arrival, taken before the check's replay runs.
        const bundle = new Uint8Array(await read(req));
        const arrivedMs = round.now();
        if (!bundle.length) return text(res, 400, 'an objection carries its transcript and receipts (13A)');
        if (!round.get(rid)) return text(res, 404, 'no such round');
        const entryRow = round.entriesOf(rid).find((e) => toHex(e.entryId) === toHex(eid));
        if (!entryRow) return text(res, 404, 'no such entry in that round');
        // AN ENTRY THE PLAYER EQUIVOCATED IN FORFEITS WHATEVER A REPLAY SAYS (§13B at any tick; kanban #25 audit): its FORFEIT
        // is signed over the canonical transcript, which a replay of the player's own inputs would "contradict" - so a seat
        // holding the proof of two chains takes no objection against that entry; the proof, not a replay, decided it.
        const forkHere = round.provenFork(rid, eid);
        if (forkHere) return text(res, 422, `that entry forfeited by §13B: this seat holds the proof that the player signed two chains (at tick ${forkHere.tick}), which no replay contradicts`);
        // THE RUN IT IS FILED AGAINST: the agreed re-run's while that one stands, else the run the committee signed.
        let standing = null;
        try { standing = resultFinality(round, rid, eid); } catch { standing = null; }
        // AN ENTRY THAT ALREADY HOLDS ITS OBJECTION costs no replay (#24 audit, the door's bound): the first is on record
        // and no second is taken until a re-run is agreed - the intake's own answer, before any work.
        const rerunAgreed = !!(standing && standing.rerun && standing.rerun.runId);
        if ((round.objected(rid, eid) && !rerunAgreed) || round.rerunObjectedAt(rid, eid) !== null)
          return text(res, 200, 'already objected');
        const against = standing && standing.rerun && standing.rerun.runId ? standing.rerun.runId : standing && standing.runId;
        const checked = await verifier.checkObjection(new Uint8Array(rid), new Uint8Array(eid), bundle,
          typeof against === 'string' ? new Uint8Array(Buffer.from(against, 'hex')) : against instanceof Uint8Array ? against : null);
        console.log(`[objection] ${toHex(eid).slice(0, 16)} ${checked.holds ? 'holds' : `refused at ${checked.step}`}: ${checked.why}`
          + (checked.replayedRunId ? ` (replayed run ${checked.replayedRunId.slice(0, 16)} ${checked.replayed.outcome} ${checked.replayed.score}, `
            + `claimed ${checked.claimedRunId.slice(0, 16)}, signed run ${checked.signedRunId.slice(0, 16)})` : '')
          + `; objection replays here so far ${verifier.objectionReplayCount}`);
        if (!checked.holds) return text(res, 422, checked.why);
        const taken = objectionIntake(round, rid, eid, /^[0-9a-f]{64}$/.test(blockHex) ? new Uint8Array(Buffer.from(blockHex, 'hex')) : null, bundle, arrivedMs);
        // AND TO THE ROUND'S PUBLICATION RELAYS (§25.2, kanban #327: "It is sent to the seats and to the round's
        // publication_relays[] at once"): an objection this seat took for the first time goes on, unawaited; each relay checks
        // it on its own evidence, and one holding it already answers "already objected" - so relaying relays do not loop
        if (taken.status === 201) {
          let relays = [];
          try { relays = decodeRoundContract(new Uint8Array(round.get(rid).contract)).publicationRelays || []; } catch { relays = []; }
          relayPost(relays, `/objection?round=${toHex(rid)}&entry=${toHex(eid)}${/^[0-9a-f]{64}$/.test(blockHex) ? `&block=${blockHex}` : ''}`, bundle)
            .then((r) => console.log(`[objection] ${toHex(eid).slice(0, 16)} relayed to ${r.sent} of ${relays.length} publication relay(s)${r.failed.length ? `; ${r.failed[0]}` : ''}`), () => {});
        }
        // AN OBJECTION THAT HOLDS SUSPENDS THE RESULT, AND THE COMMITTEE
        // RE-RUNS IT (13A): this signer node starts its own re-run at once.
        const after = taken.status === 201 ? resultFinality(round, rid, eid) : null;
        if (after && after.state === SUSPENDED) watchRerun(new Uint8Array(rid), new Uint8Array(eid));
        // A LATE ONE (§13A, WINDOW-10-SPEC): it suspends nothing, and it is filed for slashing against the signers.
        if (after && after.state === FINAL && after.lateObjection) {
          const g = await verifier.fileFirstResultSlashProofs(new Uint8Array(rid), new Uint8Array(eid));
          for (const who of g.filed) console.log(`[slash] ${toHex(eid).slice(0, 16)} late objection: filed REPLAY_CONTRADICTS against ${who.slice(0, 16)}`);
        }
        // AND A SECOND ONE THAT VOIDS THE ENTRY SLASHES THE RE-RUN'S SIGNERS AS WELL (13A, slice C2c): this node files
        // its proofs before it answers, so what it took and what it filed are one step.
        if (after && after.state === 'VOID' && after.secondObjection) {
          const f = await verifier.fileRerunSlashProofs(new Uint8Array(rid), new Uint8Array(eid));
          for (const who of f.filed) console.log(`[slash] ${toHex(eid).slice(0, 16)} filed REPLAY_CONTRADICTS against re-run signer ${who.slice(0, 16)}`);
          for (const why of f.refused) console.log(`[slash] ${toHex(eid).slice(0, 16)} ${why}`);
          // AND THE FIRST RESULT'S SIGNERS, AS WELL (ruling C step 2): the objection that proved them wrong already exists.
          const g = await verifier.fileFirstResultSlashProofs(new Uint8Array(rid), new Uint8Array(eid));
          for (const who of g.filed) console.log(`[slash] ${toHex(eid).slice(0, 16)} filed REPLAY_CONTRADICTS against first-result signer ${who.slice(0, 16)}`);
        }
        return text(res, taken.status, taken.text);
      }

      if (req.method === 'GET' && url.pathname === '/checkpoints') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const c = round.checkpoints(rid, eid);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-checkpoints': String(c.count),
          ...CORS,
        });
        return res.end(Buffer.from(c.bytes));
      }

      // THE RECEIPTS, beside the marks and in the same shape.
      //
      // A client can recompute every mark it ever sent - it made them - but it
      // cannot rebuild a signature over one. So the receipts are the only part
      // of its own round it must be able to ASK for, and without this door a
      // client that reconnected had lost them.
      if (req.method === 'GET' && url.pathname === '/receipts') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const r = round.receipts(rid, eid);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-receipts': String(r.count),
          ...CORS,
        });
        return res.end(Buffer.from(r.bytes));
      }

      // WHO IS ON THE COMMITTEE FOR THIS ROUND, answered off the chain: the
      // census at `census_height`, then the round's own lottery over it. A
      // round whose census is too small to hold one is refused BY NAME here,
      // not quietly served with a shorter committee.
      // THE ROUND'S RANDOMNESS, SO A PLAYER CAN DRIVE THE WORLD THEY WILL BE
      // REPLAYED IN.
      //
      // 5A's beacon is a published Bitcoin block hash: it is not a secret and
      // there is nothing to withhold. What made it worth a door is that the
      // player's own seed is H(randomness || pubkey || world secret || join
      // tick), and without the first of those the page cannot compute it - so
      // the page seeded its core with a CONSTANT while the committee replayed
      // every entry with the real thing. Measured on a real 2-of-2 round: the
      // page's truck stood at z 10.20 m and the committee's copy of the same
      // truck stood at 57.80 m and 44.20 m, before either of them moved.
      //
      // A NODE COULD LIE HERE, and the page holds it to account the way it
      // holds a chain provider: it asks both daemons it was given and refuses
      // a round where they disagree. That is not proof the hash is the right
      // block - deriving the height is letter 32's work and the page does not
      // do it - and it is named rather than implied.
      if (req.method === 'GET' && url.pathname === '/randomness') {
        const id = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (id.length !== 32) return text(res, 400, 'that is not a round id');
        const row = round.get(id);
        if (!row) return text(res, 404, 'this node holds no such round');
        if (!randomnessFor)
          return text(res, 409, 'this node reads no beacon, so it names no randomness');
        const contract = decodeRoundContract(new Uint8Array(row.contract));
        let given;
        try { given = randomnessFor({ contract, roundIdBytes: new Uint8Array(id) }); }
        catch (e) { return text(res, 409, `this node cannot name the randomness: ${e.message}`); }
        const hash = given instanceof Uint8Array ? given : (given && given.hash);
        if (!(hash instanceof Uint8Array) || hash.length !== 32)
          return text(res, 409, 'that round has no randomness yet, so there is no world to drive');
        const height = given && Number.isInteger(given.height) ? given.height : 0;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-height': String(height),
          ...CORS,
        });
        return res.end(Buffer.from(hash));
      }

      /**
       * ONE SIGNER NODE'S CONTRIBUTION TO THE COMMITTEE'S KEY (M3.3 item 14).
       *
       * POST hands one over; GET serves this node's own, so a signer node that was
       * down when the others dealt can fetch what it missed rather than
       * asking anybody to deal again.
       *
       * NOTHING SECRET CROSSES EITHER WAY. A contribution is a polynomial's
       * commitments and one SEALED envelope per signer node, and only the signer node a
       * given envelope is addressed to can open it - so this door carries the
       * same object to everybody and tells nobody anything.
       */
      if (req.method === 'POST' && url.pathname === '/dkg') {
        const took = await dkg.accept(await read(req));
        if (!took.ok) return text(res, 409, took.why);
        res.writeHead(took.fresh ? 201 : 200, { 'content-type': 'text/plain', ...CORS });
        return res.end(took.fresh ? 'taken' : 'already');
      }

      if (req.method === 'GET' && url.pathname === '/dkg') {
        const id = Buffer.from(url.searchParams.get('epoch') || '', 'hex');
        if (id.length !== 32) return text(res, 400, 'that is not an epoch id');
        const held = round.epoch(new Uint8Array(id));
        if (!held || !held.mine)
          return text(res, 404, 'this node has dealt nothing for that committee');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(held.mine));
      }

      // WHICH CONTRIBUTIONS THIS SIGNER NODE COMBINED, SIGNED. Every signer node asks every other
      // before it keeps a share, and keeps it only if all of them said the same set.
      if (req.method === 'GET' && url.pathname === '/dkg-agreement') {
        const id = Buffer.from(url.searchParams.get('epoch') || '', 'hex');
        if (id.length !== 32) return text(res, 400, 'that is not an epoch id');
        const said = dkg.agreementBytes(new Uint8Array(id));
        if (!said.ok) return text(res, 409, said.why);
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(said.bytes));
      }

      if (req.method === 'GET' && url.pathname === '/committee') {
        const id = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const role = url.searchParams.get('role') || 'game';
        if (id.length !== 32) return text(res, 400, 'that is not a round id');
        const signerNodes = roster.committeeFor(id, role);
        if (!signerNodes.ok) return text(res, 409, signerNodes.why);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-eligible': String(signerNodes.eligible),
          'x-signer-nodes': String(signerNodes.committee.length),
          'x-census-root': toHex(signerNodes.root),
          ...CORS,
        });
        const out = new Uint8Array(signerNodes.committee.length * 32);
        signerNodes.committee.forEach((e, i) => out.set(e.pubkey, i * 32));
        return res.end(Buffer.from(out));
      }

      return text(res, 404, 'no such door');
    }
  };

  // Batches in, and one word back: how many ticks were new. A repeat answers
  // `0` rather than an error, because re-sending is the right thing for a
  // client that never learned whether the first one landed.
  // AND THE LOOP WATCHES ITSELF (the owner 2026-09-17 19:15, the ghost lag): a stall over 250 ms prints the timed phases
  // that ran inside it, the garbage collection in it, or - when there was neither - that nothing named held it.
  watchLoop({ say: (line) => console.log(line) });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  // TWO SOCKETS ON ONE ADDRESS: /play is the game's, /guardian is this node's guardian, carried byte for byte to its
  // local API (the guardian's endpoint is the node's own public address, §23A.2). Anything else is refused as before.
  const guardianPipes = new Set();
  http.on('upgrade', (req, socket, head) => {
    const at = new URL(req.url, 'http://node').pathname;
    if (at === '/play') { wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)); return; }
    if (at === '/guardian' && guardian && guardian.apiPort) {
      const up = netConnect({ host: '127.0.0.1', port: guardian.apiPort }, () => {
        const lines = [`${req.method} / HTTP/${req.httpVersion}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(lines.join('\r\n') + '\r\n\r\n');
        if (head && head.length) up.write(head);
        socket.pipe(up); up.pipe(socket);
      });
      guardianPipes.add(socket);
      const done = () => { guardianPipes.delete(socket); up.destroy(); socket.destroy(); };
      up.on('error', done); socket.on('error', done); up.on('close', done); socket.on('close', done);
      return;
    }
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  // WHO IS ON THE OTHER END OF A CONNECTION, and nothing is pushed to one that
  // has not said. A socket used to be anonymous - it took input batches and
  // answered a number - so the node had no way to address anybody, which is
  // why no picture could be delivered however well it could be produced.
  const watching = new Map();
  let shed = 0;

  /**
   * What one subscriber has not been shown yet, marked as shown.
   *
   * ALREADY SEEN AT THAT TICK IS NOT NEWS: a subscriber gets a picture when
   * there is a new one, not once per batch anybody publishes.
   */
  const freshFor = (who, { mark = true } = {}) => {
    const out = [];
    for (const frame of ghosts.setFor(who.roundId, who.entryId)) {
      const at = `${hexOf(frame.entryId)}:${frame.tick}`;
      if (who.shown.get(hexOf(frame.entryId)) === at) continue;
      // MARKING IS THE SENDER'S JOB, not the asking's. A subscriber too far
      // behind to be sent anything must not have its pictures marked
      // delivered - that is how a truck that then stops driving becomes
      // invisible to it - so the drop counts them without claiming them.
      if (mark) who.shown.set(hexOf(frame.entryId), at);
      out.push(frame);
    }
    return out;
  };

  /**
   * Push one round's interest set to every subscriber but the entry itself.
   *
   * A SUBSCRIBER THAT IS NOT KEEPING UP IS SHOWN NOTHING, and that is the
   * right answer for a picture rather than a compromise. Piece 2 of this
   * letter already ruled it for the queue on the way in - "a full queue sheds
   * pictures oldest first and never evidence" - and the same holds pushing
   * out: a 5 Hz frame of a truck that has moved on is worth nothing by the
   * time a stalled socket drains to it, while the node buffering it is
   * unbounded memory held for one slow player. Nothing that DECIDES anything
   * is ever shed here; a ghost decides nothing.
   */
  const showRound = (roundIdBytes) => {
    let sent = 0;
    for (const [sock, who] of watching) {
      if (hexOf(who.roundId) !== hexOf(roundIdBytes)) continue;
      if (sock.readyState !== sock.OPEN) continue;
      if (sock.bufferedAmount > GHOST_BACKLOG_BYTES) {
        // COUNTED, AND NOT MARKED AS SHOWN. Nothing is queued here to go
        // stale: `setFor` recomputes the latest picture of each truck every
        // time, so a frame skipped now is simply sent when the socket has
        // drained - and what goes out then is the newest picture that exists,
        // not this one. Marking them shown instead LOST a truck: measured, a
        // player who fell behind while somebody else was driving, and that
        // somebody then stopped, never saw them at all until they moved
        // again.
        shed += freshFor(who, { mark: false }).length;
        continue;
      }
      for (const frame of freshFor(who)) { sock.send(frame.bytes); sent++; }
    }
    return sent;
  };

  /**
   * THE PICTURES ARE MADE AFTER THE PUBLISHER HAS BEEN ANSWERED, ONCE PER ROUND PER TURN OF THE LOOP.
   *
   * The store and its answer stay in the frame: the number a publisher gets back is its chain rule. What used to sit
   * behind it - stepping that run's ghost forward and rebuilding every watcher's picture set - is queued here instead.
   * Measured (the owner 2026-09-17 19:15, the ghost lag): of 35.0 s this thread spent in socket frames over a 390 s
   * profile, the store was 22.5 s and the warm step and the picture set the rest, and stalls of 325-356 ms were the
   * publish path's own work back to back.
   *
   * COALESCED, AND NOT DELAYED: `setImmediate` runs at the end of this turn, after the frames already waiting, so
   * three batches that land together step once to the newest tick and push once. A run still steps on its OWN batches,
   * so nothing is replayed from a run's start and no truck is left cold - the second-round rule stands.
   */
  const ghostDue = new Map();
  const showSoon = (roundIdBytes, entryIdBytes) => {
    const key = hexOf(roundIdBytes);
    let due = ghostDue.get(key);
    if (!due) { due = { roundId: roundIdBytes, entries: new Map(), queued: false }; ghostDue.set(key, due); }
    due.entries.set(hexOf(entryIdBytes), entryIdBytes);
    if (due.queued) return;
    due.queued = true;
    setImmediate(() => {
      ghostDue.delete(key);
      if (shuttingDown) return;
      // NOBODY WATCHING THIS ROUND HERE, NO PICTURE MADE (NODE-OPT-1648): a player asks for pictures on its main socket,
      // at one seat; at the other six its sockets carry checkpoints only. Yet every stored batch stepped a warm copy of
      // its run at every seat - each seat re-simulating every player, for nobody (profiled on testnet4 seat 3 during a
      // two-player round: the warm step 4.1 % of its loop, no watcher there). A watcher arriving later is drawn as a cold
      // run is: from the tick reached, catching up over the next pushes (STEP_BUDGET).
      let watched = false;
      for (const [sock, who] of watching) if (sock.readyState === sock.OPEN && hexOf(who.roundId) === key) { watched = true; break; }
      if (!watched) return;
      try {
        // TO THE NEWEST TICK, not one budgeted slice of it: a turn that coalesced twenty batches has more ticks to
        // walk than one call takes (STEP_BUDGET), and a truck left mid-way is the very fault this warm step exists to
        // prevent. Bounded, so a cold run still cannot hold the loop: what is left over is walked on the next batch.
        for (const eid of due.entries.values()) {
          timed('ghost warm step', () => {
            const published = ghosts.playedThrough(due.roundId, eid);
            for (let slice = 0; slice < 8; slice++) {
              const made = ghosts.latest(due.roundId, eid);
              if (!made.ok || published === null || made.ghost.tick >= published) break;
            }
          });
        }
        timed('ghost push', () => showRound(due.roundId));
      } catch (e) { console.error(`[ghosts] ${e.message}`); }
    });
  };

  wss.on('connection', (sock) => {
    sock.on('close', () => watching.delete(sock));
    // A FRAME OVER THE CAP IS AN ERROR EVENT, not a message, and an
    // unhandled one takes the process down - measured: sending
    // MAX_FRAME_BYTES + 1 threw `RangeError: Max payload size exceeded` out
    // of the receiver with nothing listening. `ws` has already closed the
    // connection with 1009 by then; what this adds is that the daemon
    // survives it and says which connection it was.
    sock.on('error', (e) => {
      console.error(`[play] connection dropped: ${e.message}`);
      if (sock.readyState === sock.OPEN) sock.close(1009, 'frame too large');
    });

    const handle = (data, isBinary) => timed(`play frame ${isBinary ? 'bytes' : 'text'}`, () => handled(data, isBinary), { over: 20 });

    const handled = (data, isBinary) => {
      try {
        if (!isBinary) {
          const t = data.toString();
          // SPAWN AND SUBSCRIBE, one word: this connection says which round
          // and which entry it is, and from then on it is shown the others.
          // A text control message like `close`, not a new wire type - the
          // frames that go out are the protocol's TYPE_GHOST and the control
          // channel stays the node's own.
          if (t === 'watch' || t.startsWith('watch ')) {
            const [, rid, eid] = t.trim().split(/\s+/);
            const roundId = Buffer.from(rid || '', 'hex');
            const entryId = Buffer.from(eid || '', 'hex');
            if (roundId.length !== 32 || entryId.length !== 32)
              return sock.send('error a watch names a round and an entry');
            if (!round.get(roundId)) return sock.send('error no such round');
            const held = round.entry(entryId);
            if (!held) return sock.send('error no such entry');
            if (hexOf(decodeEntryContract(held).roundId) !== hexOf(roundId))
              return sock.send('error that entry is in another round');
            const already = watching.get(sock);
            if (already && hexOf(already.entryId) !== hexOf(entryId))
              return sock.send('error this connection is already watching as another entry');

            const who = {
              roundId: new Uint8Array(roundId),
              entryId: new Uint8Array(entryId),
              shown: (already && already.shown) || new Map(),
            };
            watching.set(sock, who);

            // THE OTHERS BROUGHT TO THEIR NEWEST TICK FIRST (the owner 2026-09-17: "the ghost must be realtime"): since nobody-
            // watching rounds make no pictures (NODE-OPT-1648, 41a58db5), a watcher arriving after a truck drove was shown
            // it from the start - measured, ghost-realtime: tick 149 of a truck that had published 1199. The same bounded
            // walk the warm step takes, once, for this watcher; a run longer than it catches up over the next pushes.
            try {
              timed('ghost watcher warm', () => {
                for (const e of round.entriesOf(who.roundId)) {
                  const eid = e.entryId;
                  if (hexOf(eid) === hexOf(who.entryId)) continue;
                  const published = ghosts.playedThrough(who.roundId, eid);
                  for (let slice = 0; slice < 8; slice++) {
                    const made = ghosts.latest(who.roundId, eid);
                    if (!made.ok || published === null || made.ghost.tick >= published) break;
                  }
                }
              });
            } catch (e) { console.error(`[ghosts] warming for a new watcher: ${e.message}`); }

            // AND THE FIELD AS IT STANDS, so a player joining late sees the
            // trucks already driving instead of waiting for the next batch.
            // THE COUNT GOES FIRST and the frames follow it: a client that
            // reads "watching 3" knows three pictures are coming, and a push
            // that overtook its own answer would arrive before the client had
            // been told it was subscribed at all.
            const fresh = freshFor(who);
            sock.send(`watching ${fresh.length}`);
            for (const frame of fresh) sock.send(frame.bytes);
            return undefined;
          }
          if (t.startsWith('close ')) {
            const id = Buffer.from(t.slice(6).trim(), 'hex');
            const shut = round.close(id);
            // A CLOSED ROUND IS REPLAYED, and by the daemon rather than by
            // whoever asked. The promises are deliberately not awaited here:
            // the socket is told the round is shut, and the replays run on
            // their own threads through the pool.
            // Replay every entry, and then ASK THE OTHER SIGNER NODES. Serving a
            // result nobody fetches is a committee of one: the count section
            // 13 asks for only exists on a node holding more than its own
            // signature.
            // ...and THEN what that means for the money. Two different words
            // on purpose: `Verifier.settleRound` replays and gathers and moves
            // nothing, and `Custody.settleHeldInvoices` is the only thing in
            // this daemon that can settle a stake.
            if (shut) afterClose(id);
            return sock.send(shut ? 'closed' : 'already closed');
          }
          return sock.send('error unknown text message');
        }
        // ONE SOCKET, TWO KINDS. The first byte is the protocol's type, so
        // the message says what it is and the client needs no second
        // connection and no envelope around it.
        const bytes = new Uint8Array(data);
        if (bytes[0] === TYPE_CHECKPOINT) {
          const answer = round.checkpoint(bytes);
          // A MARK TAKEN AFTER THE CLOSE - only the held-back final mark gets through that door (ruled 2026-09-23/24) - has
          // its receipt offered to every peer at once (§10's receipt exchange): they signed before it existed and pull no
          // more. Measured on 5 of 7: the page counted 7 of 7, and the six other signer nodes held 6.
          try {
            const c = decodeCheckpoint(splitSigned(bytes).body);
            const row = round.get(c.roundId);
            if (row && row.state === CLOSED && answer instanceof Uint8Array) offerReceipt(c.roundId, answer);
          } catch { /* the answer stands whatever the offer does */ }
          return sock.send(answer);
        }
        // A RECEIPT COMING IN is a peer offering one it issued - section 10's
        // gossip. The first byte says so, the same way it says a mark is a
        // mark, so gossip needs no second port and no envelope.
        if (bytes[0] === TYPE_CHECKPOINT_RECEIPT) {
          const answer = round.takeReceipt(bytes);
          // A RECEIPT CAN COMPLETE WHAT A REPLAY COULD NOT SIGN. 13C's
          // canonical prefix grows as receipts arrive, so a run replayed
          // before its transcript was carried signs now, with nothing else
          // changed. Without this the node would have found the answer and
          // thrown it away.
          try {
            const run = round.runOf(decodeCheckpointReceipt(splitSignedReceipt(bytes).body).checkpointId);
            const held = run && round.get(run.roundId);
            if (run && held && held.state === CLOSED) {
              const again = verifier.retry(run.roundId, run.entryId);
              if (again) again.then((d) => (d && d.stored
                ? verifier.gather(run.roundId, run.entryId) : null))
                .catch((e) => console.error(`[verify] ${e.message}`));
            }
          } catch (e) { console.error(`[verify] ${e.message}`); }
          return sock.send(answer);
        }

        // AND EVERYTHING ELSE IS NOT AUTOMATICALLY AN INPUT. This used to fall
        // straight into `round.batch`, so the door's rule was "anything that
        // is not a mark or a receipt is a tick". A ghost was refused there, but
        // by `decodeInputBatch` noticing its own type byte - an accident of the
        // decoder, answering "not an input batch", which says what the frame is
        // not. 0.10 needs the other sentence: a picture carries no authority,
        // and it is told that here, before a handler sees it.
        // EACH PART OF THE PUBLISH FRAME, TIMED (the owner 2026-09-18 02:40: name the leftover, do not cut the store on a
        // guess). The frame is what a player's batch costs this thread: the authority check on the bytes, the store,
        // and the answer the publisher waits for. Each says its own milliseconds over 20 ms, so a stall names a part
        // rather than a shape.
        const stands = timed('frame authority', () => bearsAuthority(bytes, 'an input'), { over: 20 });
        if (!stands.ok) return sock.send('error ' + stands.why);

        const took = timed('batch stored', () => round.batch(bytes), { over: 20 });
        timed('frame answered', () => sock.send(String(took)), { over: 20 });

        // A NEW TICK IS A NEW PICTURE. The batch that just landed moved
        // somebody's truck, so everybody watching that round is shown the
        // interest set again - and the entry that published it is not shown
        // itself, because `interestSet` drops the viewer by id.
        if (took > 0) {
          try {
            const landed = decodeInputBatch(bytes);
            showSoon(landed.roundId, landed.entryId);
          } catch (e) { console.error(`[ghosts] ${e.message}`); }
        }
      } catch (e) {
        sock.send('error ' + e.message);
      }
    };

    // NO PLAY ON A STAKE THIS NODE HAS NOT SEEN HELD. 23.1 step 5 and 9 step 7:
    // play begins once the held HTLC has been seen, and a node that has not
    // seen it signs nothing for that entry. Measured before: a joined entry's
    // input batch was taken with nothing paid, on a node with Lightning and on
    // one with none. A free round (stake 0) passes without asking anybody.
    //
    // THE ASK IS ASYNC AND THE FRAMES ARE ORDERED, so every frame on a socket
    // waits for the one before it: a batch must never overtake the batch it
    // chains to because Lightning answered one of them faster.
    const playOf = (data, isBinary) => {
      if (!isBinary) return null;
      const bytes = new Uint8Array(data);
      try {
        if (bytes[0] === TYPE_CHECKPOINT) return decodeCheckpoint(splitSigned(bytes).body).entryId;
        if (bytes[0] === TYPE_INPUT_BATCH) return decodeInputBatch(bytes).entryId;
      } catch { /* the handler names what is wrong with it */ }
      return null;
    };
    let queue = Promise.resolve();
    sock.on('message', (data, isBinary) => {
      queue = queue.then(async () => {
        const eid = playOf(data, isBinary);
        if (eid && round.entry(eid)) {
          let seen;
          try { seen = await stakeSeen(eid); } catch (e) { seen = { ok: false, why: e.message }; }
          // A WAIT, SAID AS ONE: the client holds the ticks and asks again.
          if (!seen.ok) {
            // A FIRST MARK REFUSED HERE IS KEPT (M3.3-34): the player's own
            // on-time first mark, refused by a signer node that was up, is served at
            // /refused-first-mark - so no signer node reads the player as never started
            // (measured before: FORFEIT 0 at both signer nodes, final 2 of 2).
            const fm = firstMarkOf(data, isBinary);
            if (fm) round.putRefusedFirstMark({ bytes: fm.bytes, why: STAKE_NOT_SEEN + seen.why });
            return sock.send('error ' + STAKE_NOT_SEEN + seen.why);
          }
        }
        const firstMark = firstMarkOf(data, isBinary);
        // §16: A FIRST MARK THIS SIGNER NODE HAS NEVER HELD, reaching it after the start
        // deadline passed - this signer node's own evidence first, then the other
        // signer nodes' - is ENTRY_VOID here, not a run taken late. A player cannot
        // keep a run by catching a down signer node up after seeing it (§13C).
        if (firstMark && !round.holdsMark(checkpointId(firstMark.c)) && secondFirstMark(firstMark.c, firstMark.bytes)) {
          gatherOnProof(firstMark.c.roundId, firstMark.c.entryId);
          return sock.send('error FORFEIT: ' + TWO_FIRST_MARKS);
        }
        if (firstMark && !round.holdsMark(checkpointId(firstMark.c))) {
          const own = lateEvidenceHere(firstMark.c, null);
          const found = own ? { late: own, receipts: [] } : await lateByPeers(firstMark.c, firstMark.bytes);
          if (found && found.twoFirst) {
            gatherOnProof(firstMark.c.roundId, firstMark.c.entryId);
            return sock.send('error FORFEIT: ' + TWO_FIRST_MARKS);
          }
          if (found) {
            const v = voidHere(firstMark.c, firstMark.bytes, found.late, found.receipts, 'player');
            if (v) return sock.send('error ENTRY_VOID: ' + v.why);
          }
        }
        const handled = handle(data, isBinary);
        if (firstMark) Promise.resolve(handled).finally(() => gatherOnProof(firstMark.c.roundId, firstMark.c.entryId));
        // A FIRST MARK THIS SIGNER NODE TOOK OR REFUSED GOES ON TO THE OTHER SIGNER NODES, after
        // the player has its answer: the player is never kept waiting on a peer,
        // and a peer that is down is named in the forward's record. A LATER mark
        // re-offers the first to a signer node that has not taken it, or - past the
        // start line - decides §16's outage (afterMarkTaken).
        if (firstMark) forwardFirstMark(firstMark).catch((e) => console.error(`[first-mark] ${e.message}`));
        else if (isBinary && new Uint8Array(data)[0] === TYPE_CHECKPOINT)
          afterMarkTaken(new Uint8Array(data)).catch((e) => console.error(`[first-mark] ${e.message}`));
        return handled;
      }).catch((e) => console.error(`[play] ${e.message}`));
    });
  });

  return new Promise((resolve) => {
    http.listen(port, host, () => resolve({
      http, wss, round, host, verifier, ghosts, roster, stakeSecrets,
      dkg, settlements, winnings, orderBook,
      // What the last close did with the money, and the same door an operator
      // uses to run a settlement again by hand.
      stakes: () => stakes,
      settleTheStakes,
      watching: () => watching.size,
      shed: () => shed,
      // how many listing rows this node has signed since it started (kanban #232: what a window signs is what was asked)
      listingSignatures: () => listingSigned,
      port: http.address().port,
      // Closed so it actually closes. `http.close` waits for open connections
      // to end, and a play socket does not end on its own - a harness that
      // took the node away hung instead, and the page kept publishing to a
      // server that was supposed to be gone.
      close: () => new Promise((r) => {
        // NO RE-GATHER OUTLIVES THE DAEMON.
        shuttingDown = true;
        clearInterval(settleRecoverTimer); clearInterval(donationBackfillClock); clearTimeout(donationBackfillTimer); clearInterval(donationBackfillClock); clearTimeout(donationBackfillTimer);
        if (attestedSweep) { clearInterval(attestedSweep); attestedSweep = null; }
        if (orderBatchTimeout) { clearTimeout(orderBatchTimeout); orderBatchTimeout = null; }
        if (priceTimeout) { clearTimeout(priceTimeout); priceTimeout = null; }
        clearTimeout(attestedBoot);
        signer.close().catch(() => {});
        clearInterval(autoUpdateTimer);
        clearInterval(recordTimer);
        clearInterval(networkGamesTimer);
        clearInterval(winningsTimer);
        clearInterval(lateTimer);
        settlements.stop();
        if (endTimer) clearInterval(endTimer);
        if (doorTimer) clearInterval(doorTimer);
        if (seriesTimer) clearInterval(seriesTimer);
        for (const t of finalityTimers) clearTimeout(t);
        finalityTimers.clear();
        for (const t of rerunTimers) clearTimeout(t);
        rerunTimers.clear();
        for (const sock of wss.clients) sock.terminate();
        for (const sock of guardianPipes) sock.destroy();
        wss.close();
        http.closeAllConnections();
        http.close(r);
      }),
    }));
  });
}
