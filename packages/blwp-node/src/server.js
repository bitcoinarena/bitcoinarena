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
import { federationGatewayCount } from '../../protocol/src/gateways.js';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { decodeRoundContract, decodeEntryContract, publicationRelaysAreValid, custodyFieldsAreValid } from '../../protocol/src/contracts.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { lobbyListingId } from '../../protocol/src/lobby-listing.js';
import { decodeLobbyName, lobbyNameId } from '../../protocol/src/lobby-name.js';
import { roundEndMs } from '../../protocol/src/first-mark.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { lightningAddressEndpoint } from '../../protocol/src/lnurl-pay.js';
import { WinningsSend, sendPlanToJson } from './winnings-send.js';
import { TYPE_CHECKPOINT, TYPE_INPUT_BATCH, STAKE_NOT_SEEN } from '../../protocol/src/constants.js';
import { splitSigned, decodeCheckpoint, checkpointId } from '../../protocol/src/checkpoint.js';
import { MAX_INPUT_BATCH_BYTES, decodeInputBatch } from '../../protocol/src/batch.js';
import { SIGNED_CHECKPOINT_BYTES } from '../../protocol/src/checkpoint.js';
import { TYPE_CHECKPOINT_RECEIPT } from '../../protocol/src/constants.js';
import { bearsAuthority } from '../../protocol/src/frames.js';
import {
  decodeHandout, encodeHandout, handoutId, acceptHandout, openMyShare,
} from '../../protocol/src/handout.js';
// THE GROUP THE HANDOUT CHECK NEEDS. The protocol package carries no curve on
// purpose, so the daemon brings one - the same secp256k1 it already brings to
// the census, and the same one the bonds and BIP-340 use.
import { feldmanGroup, tweakPoint } from './curve.js';
import {
  SIGNED_RECEIPT_BYTES, decodeCheckpointReceipt, splitSignedReceipt,
} from '../../protocol/src/receipt.js';
import { SIGNED_RESULT_BYTES, resultId, decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';

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
import { Roster, endpointsOf } from './roster.js';
import { receiptsNeeded as roundThreshold, donationKeysForNetworkId } from '../../protocol/src/genesis.js';
import { authorityAt, donationSetSignedBy, encodeDonationSetBody, encodeAuthorityRotation } from '../../protocol/src/authority.js';
import { donationSetId } from '../../protocol/src/donation.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { timed, watchLoop } from './slow.js';
import { resultFinality } from './finality.js';
import { outageOutcome } from '../../protocol/src/entry-void.js';
import { ENTRY_VOID, netStakeMsat } from '../../protocol/src/payout.js';
import { FINAL, PROVISIONALLY_FINAL, SUSPENDED } from '../../protocol/src/objection.js';
import { transcriptBytesHash, SIGNED_POSTING_BYTES } from '../../protocol/src/posting.js';
import { federationIsBonded } from '../../protocol/src/federation.js';
import { installedCores, coreForRound } from './cores.js';
import { SIGNED_RERUN_BYTES, rerunResultId, decodeRerunResult, splitSignedRerun } from '../../protocol/src/rerun.js';
import { verifyStakeLock, verifyFeeLock, lockFieldsFromJson, roundMintsFees, federationTakesNoBaseFee } from './stake-lock-signer-node.js';
import { encodeClaimKeyAttestation, claimKeyAttestationId } from '../../protocol/src/claim-key.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { splitSlashEvidence, slashProofId, SLASH_EVIDENCE_BYTES, REPLAY_CONTRADICTS, splitRerunSlashEvidence, RERUN_SLASH_EVIDENCE_BYTES } from '../../protocol/src/slash.js';
import { slashOwing, entriesForSlash } from './slash-owing.js';
import { Preimages, encodeShareAnswer, SEALED_ANSWER_BYTES } from './preimage.js';
import { Payouts, PAYOUT_QUEUED, PAID, PAID_IN_PART, NOTHING_OWED } from './payout.js';
import { PoolSigning } from './pool-signing.js';
import { PoolWatch } from './pool-watch.js';
import { Dkg } from './dkg.js';
import { Forfeit } from './forfeit.js';
import { LockSettlement, locksStake, SUBMITTING } from './settlement.js';
import { decodeUtxo, decodeCommitments, encodeCommitments, encodeShare, UTXO_BYTES } from './pool-wire.js';
import { SIGNED_TABLE_BYTES } from './payout-table.js';

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
  'access-control-allow-headers': 'content-type',
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

export function objectionIntake(round, rid, eid) {
  try {
    if (round.object(rid, eid)) return { status: 201, text: 'objected' };
    if (round.rerunObjectedAt(rid, eid) !== null) return { status: 200, text: 'already objected' };
    const f = resultFinality(round, rid, eid);
    const agreedRerun = !!(f.rerun && f.rerun.runId);
    if (f.state === PROVISIONALLY_FINAL && agreedRerun)
      return round.objectRerun(rid, eid) ? { status: 201, text: 'objected' } : { status: 200, text: 'already objected' };
    if (agreedRerun) return { status: 409, text: 'the re-run\'s objection window has closed' };
    return { status: 200, text: 'already objected' };
  } catch (err) { return { status: 404, text: err.message }; }
}

export function serve(db, { port = 0, host = '127.0.0.1', funded = NOTHING_IS_FUNDED,
  randomnessFor, chainFor, peers = [], headerBytes, bondProof,
  // A LIGHTNING INVOICE READER, AND NOTHING MORE (§23.6, RULED 2026-09-22 22:59). `/federation-invoice`
  // uses its `decode` to read what the federation's LNv2 invoice commits to. It no longer issues, looks up,
  // settles or cancels holds, and it pays nothing: that was THRESHOLD_LN's custody by one operator.
  // (`preimageFor`, `preflight` and `secondsPerBlock` served only that hold, and are gone with it.)
  lightning = null,
  // THE FEDERATION'S RECEIVING SIDE (V1's pool is a FEDERATION, the owner 2026-09-11): `receive({
  // amountMsat })` answers `{ request }`, an LNv2 invoice the federation's gateway holds.
  federation = null,
  // The pool's key material and something that can broadcast. A daemon given
  // neither still agrees on what the round owes; it just does not spend.
  // The default curve carries the taproot tweak: without it a daemon started
  // with no curve of its own could not even name the pool's output.
  poolKey = null, chainSpend = null, poolCurve = { ...feldmanGroup, tweakPoint },
  // THIS NODE'S OWN SHARE OF THE POOL, and nobody else's. `{ id, share }`,
  // dealt today because a dealerless DKG is its own letter. Absent, the
  // daemon runs exactly as it did and answers the two signing doors with a
  // refusal rather than a signature.
  poolSignerNode = null,
  // EVERY SIGNER NODE'S PUBLIC SHARE (Map signer node id -> point) for a DEALT pool, so a bad
  // signature share can be named. A DKG committee's come from its commitments.
  poolPublicShares = null,
  // AND SOMETHING THAT CAN ASK THE CHAIN WHICH OUTPUT HOLDS THE POOL.
  // `bitcoindRpc`'s `call`, injected the way everything else that reaches the
  // network is. Without it a close still queues the payout and stops - which
  // is exactly where item 18 found it - and says so rather than guessing at an
  // outpoint.
  poolCall = null,
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
  // THE ROUND'S CLAIM KEY, by round (33 bytes). Defaults to this signer node's own
  // DKG committee key - the key the settlement signer nodes hold for that round.
  claimKeyFor = null,
  // THE SIGNED DONATION SETS ITS OPERATOR HANDED THIS SIGNER NODE (M3.2 6e, §22A,
  // §27A.4), and any authority rotations: each checked here before it is ever
  // served. None by default: a signer node with none serves no set.
  donationSets = [], donationRotations = [],
  // THE CORES THIS SIGNER NODE RUNS BESIDE THE TRUCK (M3 R1; the owner 08:07: several games and rule sets at
  // once): each { name, hash, url, adapter, configs } as cores.js builds the truck. The truck is
  // always installed; a round naming a core or config this signer node does not hold is refused at the door.
  cores = [],
  // WHERE THIS NODE'S OWN CHAIN IS (M3.3-30): a height, asked of its own
  // bitcoind. Given none, the pool's chain call answers it when there is one.
  chainTip = null,
  expiry = {} } = {}) {
  // THE CORES THIS SIGNER NODE RUNS (M3 R1), made once: the round store opens only rounds on them, and the door,
  // the replay and the ghosts resolve each round's core through the same registry.
  const installed = installedCores(cores);
  const round = new Round(db, undefined, { cores: installed });

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
    for (const s of named) {
      if (toHex(s.networkId) !== toHex(contract.networkId) || !(s.validFrom <= contract.censusHeight)) continue;
      if (donationSetSignedBy(s, { authority: at.authority, verify: verifyDonation }).ok) return { ok: true, set: s };
    }
    return { ok: false, why: 'the set this round names is not signed by its network\'s donation authority at the round\'s height' };
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
  const preimages = new Preimages(round, {
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
  // and the committee share-gathering that fed its settle, were THRESHOLD_LN's and are gone with it.
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
  // envelopes (preimages.open) - so a signer node that goes down later and stays down
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
      if (pull && !round.provenTwoFirstMarks(rid, eid)) await verifier.pullFirstMarkProof(rid, eid);
      if (!round.provenTwoFirstMarks(rid, eid)) return;
      await spreadProof(rid, eid);
    })().catch((e) => console.error(`[shares] ${e.message}`)).finally(() => gathering.delete(key));
  }

  // WHAT `funded` MAY KNOW OF THIS NODE (M3.3-31): whether it holds a round, and whether it reaches
  // the federation that round's stake is locked in - the launcher's rule funds an entry only into a
  // paying round this node holds and can verify the lock of. (Whether it reached Lightning was the
  // hold-invoice question, THRESHOLD_LN's, and is not asked any more.)
  const fundingView = {
    holds: (roundIdBytes) => round.get(roundIdBytes),
    // AND WHETHER IT REACHES A FEDERATION, which is how a lock round's stake is held (§23.1 step 5).
    get reachesFederation() { return !!stakeLocks; },
  };


  /**
   * WHAT THE ROUND OWES, AND WHETHER IT HAS BEEN PAID.
   *
   * 20's threshold and 9.4's qualifying tail. `chain` and `pool` are injected
   * the way the Lightning port is: a daemon given neither still signs the
   * table and serves its signature, because agreeing on what is owed is
   * something every signer node does whether or not it is the one that broadcasts.
   */
  const payouts = new Payouts(round, {
    curve: poolCurve, chain: chainSpend, pool: poolKey,
    random: (n) => new Uint8Array(randomBytes(n)),
    peers, fetcher: (u, o) => fetch(u, o),
    // THE ROUND'S BEACON, and it is the same door the roster and the verifier
    // read. Item 19's takeover waits a number of BLOCKS past this height, so a
    // node that seeds on one beacon cannot wait on another.
    ...(randomnessFor ? { randomnessFor } : {}),
    // AND THE OTHER SETTLEMENT SIGNER NODES AT A LIVE CLOSE: the table's signatures are
    // theirs. Measured before: "1 of 2 signer nodes signed this table" on both daemons,
    // because the census peers were read only at start, for rounds already owing.
    peersFor: (roundIdBytes) => settlementPeers(roundIdBytes),
  });

  // AND THIS NODE'S HALF OF A SIGNING ROUND. `Payouts` decides which
  // transaction is right; this decides whether THIS signer node will put its own
  // share behind it, and it rebuilds the transaction itself before it does.
  const signing = new PoolSigning(round, {
    curve: poolCurve, signerNode: poolSignerNode, pool: poolKey, publicShares: poolPublicShares,
  });

  // AND THIS NODE'S HALF OF MAKING THE COMMITTEE'S KEY.
  //
  // `poolSignerNode` above is a share this daemon was HANDED, which means somebody
  // dealt it and therefore held every one. A committee that runs this makes
  // its own: one contribution each, one share kept, and a group key every signer node
  // computes from public data. The share it ends with has the same shape
  // `PoolSigning` already takes, so nothing about the signing changes.
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
  // AN ENTRY_VOID THAT STANDS: no second first mark here, and the result window
  // has passed without one pulled from a peer. Until then the close keeps
  // asking (a peer may hold the pair); one that does not stand is decided by
  // the close's no-quorum rule (FORFEIT), so the close keeps it.
  const voidStands = (rid, eid) => {
    if (!round.entryVoid(eid) || round.twoFirstMarks(rid, eid)) return false;
    const row = round.get(rid);
    if (!row || row.closed_ms === null || row.closed_ms === undefined) return true;
    return round.now() >= Number(row.closed_ms) + Number(decodeRoundContract(new Uint8Array(row.contract)).objectionWindowMs);
  };
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
    dkg, port: stakeLocks, curve: poolCurve, random: (n) => new Uint8Array(randomBytes(n)),
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
  const settlements = new LockSettlement(round, {
    dkg, port: stakeLocks, curve: poolCurve, random: (n) => new Uint8Array(randomBytes(n)), preimages, winnings, finalityOf,
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
      return { gameVerify: game.ok ? game.committee.map((e) => e.pubkey) : contract.nodes,
        settlement: settle.ok ? settle.committee.map((e) => e.pubkey) : contract.nodes };
    },
  });

  // AND WHICH OUTPUT THE POOL IS IN, asked of the chain rather than
  // remembered. This is what a close was missing: `payWithCommittee` names an
  // output, and until this the daemon had no way to produce one, so every
  // closed round stopped at PAYOUT_QUEUED with the winner unpaid.
  const poolWatch = new PoolWatch({ call: poolCall, pool: poolKey, curve: poolCurve });

  // THE SIGNER NODE AND THE POOL KEY, READ BACK FROM THIS NODE'S OWN STORE.
  //
  // Measured 2026-09-10 on an isolated regtest: a signer node SIGKILLed mid-settlement
  // and started again as `src/main.js` starts a daemon recovered nothing at any
  // of four kill points - the share it made in the key ceremony was on disk,
  // and nothing read it back, so `canSpend` was false and neither the
  // reconcile nor the sweep ran. The committee of a round this node still owes
  // a payout on comes first; otherwise the newest committee it holds a share
  // of. A signer node and key the caller passed in are never replaced.
  if (!poolSignerNode || !poolKey) {
    const held = (() => {
      for (const row of round.payoutsInState(PAYOUT_QUEUED)) {
        const r = round.get(row.roundId);
        if (!r) continue;
        const got = dkg.signerNodeFor(decodeRoundContract(new Uint8Array(r.contract)).nodes);
        if (got.ok) return { ...got, signerNodes: decodeRoundContract(new Uint8Array(r.contract)).nodes };
      }
      const signerNodes = round.latestSharedEpochSignerNodes();
      return signerNodes ? { ...dkg.signerNodeFor(signerNodes), signerNodes } : null;
    })();
    if (held && held.ok) {
      if (!signing.signerNode) signing.signerNode = held.signerNode;
      if (!signing.pool) signing.pool = held.pool;
      if (!signing.publicShares && held.signerNodes) {
        const pub = dkg.publicSharesFor(held.signerNodes);
        if (pub.ok) signing.publicShares = pub.shares;
      }
      if (!payouts.pool) payouts.pool = held.pool;
      if (!poolWatch.pool) poolWatch.pool = held.pool;
    }
  }

  // WHO MAY HOLD A ROUND, from the chain. The census stopped being library
  // code here: this is the daemon's only caller of it, and `chainFor` is the
  // blocks - asked for, never invented, the same way the randomness is.
  const roster = new Roster(round, {
    ...(chainFor ? { chainFor } : {}),
    // The same beacon the verifier reads: one source, so a node cannot assign
    // one committee and sign results against another.
    ...(randomnessFor ? { randomnessFor } : {}),
  });

  // WHAT HEARS A ROUND CLOSING. Section 13 replays once the run is over, so
  // the close is the event and this is what listens for it. The world secret
  // is on the entry now, so the seed derives itself; what is still outside is
  // the round's randomness beacon - a future Bitcoin block hash this daemon
  // does not read yet - and a node given none runs the whole path and stops
  // there, with the refusal recorded rather than a world invented.
  // WHAT SHOWS OTHER PLAYERS' TRUCKS. Pictures only: 0.10 says a ghost is
  // never an input to anybody's simulation, and the frames it hands out came
  // out of `replay.js` like everything else that touches the core.
  const ghosts = new Ghosts(round, { cores: installed, ...(randomnessFor ? { randomnessFor } : {}) });

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
    cores: installed,
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
  // it (M3.2 6e): `holdSettlement`'s own figure, served on /settlement so a
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
    const now = resultFinality(round, rid, eid);
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
  async function guardiansBonded(rid, contract) {
    if (!stakeLocks || typeof stakeLocks.guardians !== 'function')
      return { ok: false, why: 'this signer node reaches no federation to read the guardians of, so it signer nodes no round that takes a stake into one (§23.6)' };
    const census = roster.censusFor(rid);
    if (!census.ok) return census;
    let g;
    try { g = await stakeLocks.guardians(); }
    catch (e) { return { ok: false, why: `this signer node could not read its federation's guardians: ${e.message}` }; }
    if (!g || toHex(g.federationId) !== toHex(contract.federationId))
      return { ok: false, why: `this signer node reaches federation ${g ? toHex(g.federationId).slice(0, 16) : 'none'} and that round names `
        + `${toHex(contract.federationId).slice(0, 16)}, so it cannot count that federation's guardians` };
    const bonded = federationIsBonded({ federationId: contract.federationId, guardianKeys: g.keys, threshold: g.threshold,
      census: census.entries, bondMinSats: contract.bondMinSats });
    return bonded.ok ? bonded : { ok: false, why: `this signer node assigns no round on an unbonded federation (§23.6): ${bonded.why}` };
  }

  const CLAIM_KEY_EVERY_MS = 1000;
  const CLAIM_KEY_MIN_TRIES = 30;
  const claimKeyRuns = new Set();
  function makeClaimKey(rid) {
    if (claimKeyFor || !dkg.canDeal) return;
    const key = toHex(rid);
    const row = round.get(rid);
    if (!row || claimKeyRuns.has(key)) return;
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const signerNodes = contract.nodes;
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
  function watchRerun(rid, eid) {
    const row = round.get(rid);
    if (!row) return;
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    const everyMs = finality.everyMs ?? 2000;
    // THE WATCH RUNS TO FILED + 2W AND ONE TICK (RULED the owner 2026-09-24): §13C decides at filed + W, and an agreed
    // re-run is FINAL at the latest before filed + 2W (its own window, slice C2a). It used to stop at the objection plus
    // one window - before both, so without the `rerunMs` test aid neither the §13C slash nor the FINAL one was filed.
    const filedMs = round.objectedAt(rid, eid) ?? Date.now();
    const until = finality.rerunMs !== undefined ? Date.now() + finality.rerunMs
      : filedMs + 2 * Number(contract.objectionWindowMs) + everyMs;
    const tick = async () => {
      if (shuttingDown) return;
      let done = false;
      try { done = await rerunAndFile(rid, eid); } catch (e) { console.error(`[rerun] ${e.message}`); }
      if (done || shuttingDown || Date.now() >= until) return;
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
    const windowDue = () => waitingOn().some((w) => w.closesAtMs !== null && round.now() >= w.closesAtMs);
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
      if (shuttingDown) return;
      if (turned || windowDue() || unposted() || suspendedShort() || pendingShort()
        || (pastWindow && notFinalYet())) {
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
        const held = (round.hold(e.entryId) || {}).state || '-';
        return `${k.slice(0, 8)} ${e.outcome} agreed=${agreed.has(k) ? 'y' : 'n'} live=${live || '-'} `
          + `settle=${isFinal(e.entryId) ? 'final' : 'not-final'} hold=${held}`;
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
    // follow here, and the on-chain pool payout that only ever ran after it, were THRESHOLD_LN's and
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

  /**
   * ASK LIGHTNING ABOUT ANYTHING THIS NODE DIED IN THE MIDDLE OF.
   *
   * A daemon that starts is usually a daemon that stopped, and the one window
   * where its store and Lightning can disagree is between telling and writing
   * down. `reconcile` closes it - and it has to run HERE, on start, because a
   * tool an operator remembers to run is not a guarantee. It is kept as a
   * promise for the same reason the verifier's is: a caller that cannot await
   * it cannot tell "not asked yet" from "not asked".
   */
  // THE OTHER SIGNER NODES' ADDRESSES, READ OFF THE CHAIN.
  //
  // Measured 2026-09-10 on an isolated regtest: a signer node restarted as
  // `src/main.js` with only its two chain settings reached the committee step
  // of a payout that still needed signatures and stopped - "1 of 5 signer nodes
  // committed to this spend" - because it knew no other signer node's address. The
  // spec's record of where a node lives is the signed advertisement in its
  // bond, and signer node selection already reads those out of the same blocks. So a
  // node handed no peers takes the settlement committee's endpoints from the
  // census of every round it still owes a payout on, the same way it assigned
  // them. A peers list the caller passed in is never replaced.
  if (chainFor && (!payouts.peers || !payouts.peers.length)) {
    const found = new Set();
    for (const row of round.payoutsInState(PAYOUT_QUEUED)) {
      const picked = roster.committeeFor(row.roundId, 'settlement');
      if (!picked.ok) {
        console.error(`[payout] ${toHex(row.roundId).slice(0, 16)} reads no signer node addresses: ${picked.why}`);
        continue;
      }
      for (const u of endpointsOf(picked.committee, round.pubkey)) found.add(u);
    }
    if (found.size) payouts.peers = [...found];
  }

  /**
   * AND ANY PAYOUT THIS NODE DIED IN THE MIDDLE OF SENDING. Same reason as the
   * hold's: the only party that knows whether a transaction went out is the
   * network, and a node that assumed it did not would build a second spend of
   * one pool output.
   */
  const reconcilingPayouts = payouts.canSpend
    ? payouts.reconcile()
      .then((asked) => {
        // A table that leaves rows owed under the floor reconciles to
        // PAID_IN_PART, and that is a payout this node recovered too.
        const list = ((asked && asked.asked) || [])
          .filter((a) => a.state === PAID || a.state === PAID_IN_PART);
        const had = list.filter((a) => !a.sent).length;
        const sent = list.filter((a) => a.sent).length;
        if (had) console.log(`[payout] the chain already had ${had} payout(s) this node died sending`);
        if (sent) console.log(`[payout] sent ${sent} payout(s) this node had signed and written but not sent`);
        return asked;
      })
      // AND THE ROUNDS THAT NEVER GOT A TRANSACTION BUILT AT ALL.
      //
      // `reconcile` answers "did a spend this node had already built go out",
      // which leaves a round that never got that far exactly where it was. A
      // node down when its round closed - or one whose pool had no confirmed
      // output yet - would sit at PAYOUT_QUEUED for ever with nobody to
      // notice. Run AFTER the reconcile, so a round the chain already paid is
      // PAID before this looks at it and is not asked for a second spend.
      .then(async (asked) => {
        const swept = await payouts.settleAllQueued({
          contractFor: (rid) => {
            const row = round.get(rid);
            return row ? decodeRoundContract(new Uint8Array(row.contract)) : null;
          },
          signing, watch: poolWatch,
        }).catch((e) => ({ ok: false, why: e.message, settled: [] }));
        for (const one of swept.settled || [])
          console.log(`[payout] ${toHex(one.roundId).slice(0, 16)} `
            + `${one.ok ? one.state : one.why}`);
        return { ...asked, swept };
      })
      .catch((e) => { console.error(`[payout] ${e.message}`); return { ok: false, why: e.message }; })
    : Promise.resolve({ ok: false, why: 'this node reaches no chain, so it asks it nothing' });

  // NOTHING TO ASK LIGHTNING ON START, AND NO HELD STAKE TO RESUME (§23.6, RULED 2026-09-22 22:59).
  // Two steps used to run here first: `reconcile`, asking Lightning about any hold act this node died in
  // the middle of, and a resume of every closed round with a stake still HELD in a hold invoice. Both
  // were THRESHOLD_LN's and are gone with it. A lock round's restart is the two steps below: the closes
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
  const settleRecoverTimer = setInterval(() => {
    if (!shuttingDown && round.lockSettlementsIn(SUBMITTING).length) recoverSettlements();
  }, finality.maxEveryMs ?? 60000);
  // A BACKGROUND CHECK DOES NOT HOLD THE PROCESS UP: a running daemon's server does. Measured:
  // without this, a test that left a signer node open never let node --test exit.
  settleRecoverTimer.unref();

  // WINNINGS ARE ALWAYS SENT, WITH NO PAGE OPEN: every round holding a winning that is not PAID is visited on the same
  // clock - a send retried, an expired one re-sent through the next live gateway (winnings-send.js). Only the round's
  // proposer acts; the others answer it.
  let sweepingWinnings = false;
  const winningsTimer = setInterval(async () => {
    if (shuttingDown || sweepingWinnings || !winnings) return;
    sweepingWinnings = true;
    try {
      for (const rid of round.roundsWithUnpaidSends()) {
        const got = await settlements.sendWinnings(rid).catch((e) => [{ ok: false, why: e.message }]);
        for (const g of got) if (!g.already) console.log(`[winnings] ${toHex(rid).slice(0, 16)} ${JSON.stringify(g).slice(0, 200)}`);
      }
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
  let endTimer = null;
  if (closeAtEnd) {
    const sweep = () => timed('close sweep', () => {
      if (shuttingDown) return;
      const nowMs = BigInt(round.now());
      for (const held of round.openRounds()) {
        let c;
        try { c = decodeRoundContract(held.contract); } catch { continue; }
        let end;
        try { end = roundEndMs(c); } catch { continue; }
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

  const http = createServer(async (req, res) => {
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

      if (req.method === 'GET' && url.pathname === '/identity') {
        return bytes(res, 200, round.pubkey);
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
        if (!headerBytes)
          return text(res, 404, 'this node was given no chain to serve; a chain comes from providers');
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(headerBytes));
      }

      // AND THE BOND PROOF THE ADVERTISEMENT COMMITS TO: the transaction and
      // the merkle branch that puts it in a block of that chain. The client
      // re-derives the root and checks it against the header it agreed on, so
      // what is served here is evidence and not an answer.
      if (req.method === 'GET' && url.pathname === '/bond') {
        if (!bondProof)
          return text(res, 404, 'this node was given no bond proof to serve');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(bondProof));
      }

      // AND THE BONDS OF A ROUND'S GUARDIANS (M3; the owner 07:33), out of the census this signer node derived
      // for it: each transaction and its merkle branch, for the page to prove into headers it agreed
      // from providers and count against its own federation's keys. Candidates, not a count.
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
        // Asked BEFORE anything is decoded into the database, so a refusal
        // costs a parse and nothing else.
        if (!funded({ kind: 'round', contract, node: fundingView }))
          return text(res, 402, 'this node stores nothing for a round nobody has funded');
        // A ROUND ON A CORE OR CONFIG THIS SIGNER NODE DOES NOT RUN IS NOT OPENED HERE (M3 R1; the owner 08:07: each
        // round names its sim_wasm_hash and config_hash, signer nodes replay what that round names). 27A.7.5: the
        // signer node is not selectable for it - it serves nothing there, and is not slashed. Refused before
        // anything of the round exists on this signer node.
        {
          const runs = coreForRound(contract, installed);
          if (!runs.ok) return text(res, 409, runs.why);
        }
        // AND A ROUND THAT TAKES A STAKE INTO A FEDERATION IS HELD TO THE CUSTODY FIELDS IN FULL
        // (M3 W7, §23): which federation, the 144-block expiry, the relays - before anything of it
        // exists on this signer node. A free round is the check below; no other custody parses (§23.6).
        if (contract.stakeMsat > 0n) {
          const custodyOk = custodyFieldsAreValid(contract);
          if (!custodyOk.ok) return text(res, 409, custodyOk.why);
        }
        // AND ITS FEDERATION HAS TWO GATEWAYS, OR IT TAKES NO STAKE HERE (§23.6: "deposits and withdrawals
        // through any of at least two gateways ... run by different operators"; RULED the owner 2026-09-23).
        // Counted through this signer node's own lock port, as the guardians are: distinct LIVE Lightning
        // node keys among the names the guardians registered - two names on one node are one gateway, a name
        // that does not answer is none. Under two, refused by name before anything of the round exists here.
        // Inbound is not read and not claimed: the federation's API does not say it, and a deposit that
        // commits through each gateway is where it is shown. A node with no lock port takes no stake in a
        // FEDERATION round at all, and is not the one this asks.
        if (contract.stakeMsat > 0n && stakeLocks) {
          if (typeof stakeLocks.gateways !== 'function')
            return text(res, 409, 'this signer node\'s lock port cannot list the federation\'s gateways, so it cannot count '
              + 'two of them (§23.6): it opens no paying round');
          let seen;
          try { seen = await stakeLocks.gateways(); }
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
          // AND A ROUND THAT TAKES A STAKE INTO A FEDERATION IS ASSIGNED SIGNER NODES ONLY ON A BONDED ONE (§23.6, P3;
          // the owner 2026-09-15 07:33): refused here like a committee the chain did not assign - stored,
          // no signer nodes, so no claim key and no lock can name it.
          if (contract.stakeMsat > 0n) {
            const bonded = await guardiansBonded(id, contract);
            if (!bonded.ok) return text(res, 409, bonded.why);
          }
          const assigned = roster.assignSignerNodes(id);
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
      if (req.method === 'GET' && url.pathname === '/rounds') {
        const nowMs = BigInt(round.now());
        const listed = [];
        for (const held of round.openRounds()) {
          let c;
          try { c = decodeRoundContract(held.contract); } catch { continue; }
          if (nowMs >= c.entryCloseMs) continue;          // entry is over: nobody can join it
          const id = toHex(held.roundId);
          const players = round.playersOf(held.roundId);
          const free = c.stakeMsat === 0n;
          let watchers = 0;
          for (const w of watching.values()) if (toHex(w.roundId) === id) watchers++;
          // §5A.5: before committee_time the lobby shows "committee: pending"
          // and offers no entry; the entry door refuses by the same rule.
          const phase = nowMs < c.committeeTimeMs ? 'pending' : 'open';
          const assignedHere = round.signerNodes(held.roundId).length > 0;
          // THE ROUND'S THRESHOLD, from its contract: 2 of 2 here, 5 of 7 on
          // mainnet. A round is playable only when that many of its signer nodes hold
          // it, so the page counts signer nodes, and this one signs what it says.
          let needed = null;
          try { needed = roundThreshold(c.gameVerifySlots); } catch { needed = null; }
          const sig = schnorr.sign(lobbyListingId({ roundId: held.roundId, nodePubkey: round.pubkey, nowMs, phase,
            assignedHere, joined: players.joined, playing: players.playing }), round.identity.secret);
          listed.push({
            id, phase,
            committeeTimeMs: String(c.committeeTimeMs), startTimeMs: String(c.startTimeMs),
            entryCloseMs: String(c.entryCloseMs), stakeMsat: String(c.stakeMsat),
            // WHAT JOINING ASKS OF THE PLAYER: nothing, or a federation stake lock. There is no third
            // answer - "a Lightning payment" was THRESHOLD_LN's hold invoice, which does not exist (§23.6).
            free, wallet: free ? 'none' : 'federation-lock',
            assignedHere, joined: players.joined, playing: players.playing, watching: watchers,
            // AND WHAT ITS JOINED PLAYERS CHOSE TO BE CALLED - each record its
            // player's own signature (lobby-name.js), not this signer node's word.
            names: namesHeld(held.roundId),
            needed, signerNodes: c.nodes.length,
            // THIS SIGNER NODE'S SIGNED WORD (lobby-listing.js): round, node, time, phase,
            // joined here, and the two counts. `watching` is not signed.
            sig: toHex(sig),
          });
        }
        listed.sort((x, y) => (x.phase === y.phase
          ? (BigInt(x.entryCloseMs) < BigInt(y.entryCloseMs) ? -1 : 1)
          : (x.phase === 'open' ? -1 : 1)));
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify({ node: toHex(round.pubkey), nowMs: String(nowMs), rounds: listed }));
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
            try { gate = await roundMintsFees({ contract: rc, port: stakeLocks }); }
            catch (e) { return text(res, 503, `this node could not read the federation's fee rule, so it takes no entry in a round that may mint fee locks: ${e.message}`); }
            // AND THE FEDERATION MUST CHARGE NO BASE FEE (FEDERATION.md item 4; §22A: "Fedimint's own base
            // fees are 0: the federation runs with disable_base_fees"). A base fee comes out of every input
            // and output of the round's locks - the players' own pool - so it is money taken from a stake
            // somebody committed, for nothing the round asked for. `page-lock.js` refuses to lock against
            // such a federation; this is the same refusal on the node, so no entry is taken either.
            // An unknown rule is not a base fee, and is not refused here.
            let noBase = { ok: true };
            try { noBase = federationTakesNoBaseFee({ fees: stakeLocks && typeof stakeLocks.fees === 'function' ? await stakeLocks.fees() : null }); }
            catch (e) { return text(res, 503, `this node could not read the federation's fee rule: ${e.message}`); }
            if (!noBase.ok) return text(res, 409, `this node takes no entry in that round: ${noBase.why}`);
            const namesNone = contract.feeLockOutpoint.txid.every((x) => x === 0) || contract.feePreimage.every((x) => x === 0);
            if (gate.mints && namesNone)
              return text(res, 409, `this round mints fee locks (${gate.why}): an entry that brings no fee lock is not taken - `
                + 'its stake would not be counted, and it would block the round\'s settlement');
          }
        }
        const joined = round.enter(contract);
        // NO HOLD IS ISSUED HERE ANY MORE. This door used to ask the signer node's Lightning for a hold
        // invoice on the entry's payment hash, and said how that went in `x-hold`. That was THRESHOLD_LN's
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
       * wallet checks the invoice against their own contract before paying;
       * `invoiceMatchesEntry` is that rule and it lives on their side too.
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
       * balance", which is THRESHOLD_LN's custody by one operator. They went with it. A lock round pays its
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
       * IT USED TO SAY FAR MORE, AND ALL OF IT WAS THRESHOLD_LN's (§23.6, RULED 2026-09-22 22:59): the
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
       * gateway's hold invoice up (lnd-port.js) and `invoiceMatchesEntry`
       * refuses any other amount. Measured before (M3.2 6e): the donation was
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
          amountMsat = netStakeMsat({ stakeMsat: contract.stakeMsat, feeMsat: entryFeeMsat(contract.stakeMsat),
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
      // their entry named, and the §23.5 fee's own hold beside it - both THRESHOLD_LN's stake-in, gone with
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
       * with an outcome 23.2 settles - a DELIVERED run's preimage must never
       * leave, because releasing it lets anyone settle an invoice that has to
       * go back to its player.
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
        let said = await preimages.answer(ask);
        // A PROOF OF TWO FIRST MARKS THIS SIGNER NODE HAS NOT PULLED YET (M3.3-34): the
        // asker's signer nodes may hold it - pulled, checked here and kept, never taken
        // on the asker's word; then asked of this signer node's own record again.
        // `proof=1`: the asker holds a proof of two first marks - pulled even over a
        // result this signer node signed (measured: a signer node that had signed FAILED refused).
        if (!said.ok && (url.searchParams.get('proof') === '1' || !round.results(ask.roundId, ask.entryId).length)
          && await verifier.pullFirstMarkProof(ask.roundId, ask.entryId)) said = await preimages.answer(ask);
        // A SIGNER NODE HOLDING THE PROOF GATHERS TOO, while the signer nodes are up (M3.3-34):
        // measured before on 5 of 7 - signer nodes that learned the proof here, when
        // asked, never gathered; with the two signer nodes that had gathered down, the
        // four up reached 4 of 5 shares and the hold went back to the player
        // (98000 msat). In the background: the asker is answered now.
        if (round.provenTwoFirstMarks(ask.roundId, ask.entryId)) gatherOnProof(ask.roundId, ask.entryId);
        if (!said.ok) return text(res, 409, said.why);
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-signer-node': String(said.answer.signerNode), ...CORS,
        });
        return res.end(Buffer.from(encodeShareAnswer(said.answer)));
      }

      /**
       * WHAT THIS NODE SIGNED ABOUT A ROUND'S PAYOUT. §20's five of seven are
       * only countable on a node holding more than its own signature, so this
       * is the door `gather` reads - the same shape as `/results`, and public
       * for the same reason: a signature over a table id proves nothing about
       * anything except that table.
       */
      if (req.method === 'GET' && url.pathname === '/payout') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'that is not a round id');
        const held = payouts.records(new Uint8Array(rid));
        const out = new Uint8Array(held.length * SIGNED_TABLE_BYTES);
        held.forEach((b, i) => out.set(b, i * SIGNED_TABLE_BYTES));
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'x-payout-signatures': String(held.length),
          'x-payout-state': (payouts.stateOf(new Uint8Array(rid)) || {}).state || 'none',
          ...CORS,
        });
        return res.end(Buffer.from(out));
      }

      // ROUND ONE OF A SIGNING ROUND: this signer node's nonce commitment.
      //
      // The body is the OUTPUT the asker wants spent and nothing else. There is
      // no sighash on this door and there must not be: a signer node that signed what
      // it was handed would make five of seven decorative, because five
      // signatures over an attacker's bytes spend the pool just as well.
      if (req.method === 'POST' && url.pathname === '/pool/commit') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const held = round.get(rid);
        if (!held) return text(res, 404, 'this node holds no such round');
        let utxo;
        try { utxo = decodeUtxo(await read(req)); }
        catch (e) { return text(res, 400, 'that is not an output: ' + e.message); }

        const got = signing.commit({
          roundId: new Uint8Array(rid), utxo,
          contract: decodeRoundContract(new Uint8Array(held.contract)),
          random: (n) => new Uint8Array(randomBytes(n)),
          attempt: Number(url.searchParams.get('attempt') || 0),
        });
        if (!got.ok) return text(res, 409, got.why);
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(encodeCommitments([got.commitment])));
      }

      // ROUND TWO: this signer node's signature share, over the spend it built itself.
      //
      // The commitment list is what changes between the rounds, and it is part
      // of the message - it is hashed into the binding factors. A signer node that
      // already signed under one list hands the same bytes back and refuses a
      // second, because two challenges under one nonce pair publish the share.
      if (req.method === 'POST' && url.pathname === '/pool/share') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const held = round.get(rid);
        if (!held) return text(res, 404, 'this node holds no such round');
        const body = await read(req);
        let utxo, commitments;
        try {
          utxo = decodeUtxo(body.subarray(0, UTXO_BYTES));
          commitments = decodeCommitments(body.subarray(UTXO_BYTES));
        } catch (e) { return text(res, 400, 'that is not an output and a commitment list: ' + e.message); }

        const got = signing.signatureShare({
          roundId: new Uint8Array(rid), utxo, commitments,
          contract: decodeRoundContract(new Uint8Array(held.contract)),
          attempt: Number(url.searchParams.get('attempt') || 0),
        });
        if (!got.ok) return text(res, 409, got.why);
        res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
        return res.end(Buffer.from(encodeShare(got.share)));
      }

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
        const claimPk = claimKeyOf(decodeEntryContract(stored).roundId);
        let got;
        try { got = await verifyStakeLock({ round, port: stakeLocks, entryIdBytes: new Uint8Array(eid), fields, claimPk }); }
        catch (e) { got = { ok: false, why: `the federation could not be asked: ${e.message}` }; }
        if (!got.ok) return text(res, 409, got.why);
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
        const claimPk = claimKeyOf(decodeEntryContract(stored).roundId);
        let got;
        try { got = await verifyFeeLock({ round, port: stakeLocks, entryIdBytes: new Uint8Array(eid), fields, claimPk }); }
        catch (e) { got = { ok: false, why: `the federation could not be asked: ${e.message}` }; }
        if (!got.ok) return text(res, 409, got.why);
        return text(res, 201, `fee lock verified: contract ${got.contractId} holds ${got.feeMsat} msat`);
      }

      // WHERE A PLAYER'S STAKE LOCK IS, BY ITS REFUND KEY (W5a). A player who
      // comes back with only their seed can derive the round's refund key, and
      // nothing else - the outpoint and the stake point were random. Every lock
      // is public in the federation; this signer node answers with the ones it verified.
      if (req.method === 'GET' && url.pathname === '/stake-lock') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const refund = (url.searchParams.get('refund') || '').toLowerCase();
        if (rid.length !== 32 || !/^0[23][0-9a-f]{64}$/.test(refund))
          return text(res, 400, 'a stake lock is asked for by a round id and a 33-byte refund key');
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(round.stakeLocksFor(new Uint8Array(rid), refund)));
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
        if (url.pathname === '/forfeit-commit') {
          const got = await forfeits.commit(r8, e8);
          if (!got.ok) return text(res, got.status || 409, got.why);
          res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
          return res.end(Buffer.from(encodeCommitments([got.commitment])));
        }
        if (url.pathname === '/forfeit-share') {
          let list;
          try { list = decodeCommitments(new Uint8Array(await read(req))); } catch (e) { return text(res, 400, e.message); }
          const got = await forfeits.share(r8, e8, list);
          if (!got.ok) return text(res, got.status || 409, got.why);
          res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
          return res.end(Buffer.from(encodeShare(got.share)));
        }
        const signature = new Uint8Array(await read(req));
        if (signature.length !== 64) return text(res, 400, 'a forfeit is a 64-byte signature');
        const got = await forfeits.take(r8, e8, signature);
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
        // A LATE LOSER'S SECOND SETTLEMENT (C3b-1) is asked for by its entry as well: one per (round, entry).
        const lateHex = url.searchParams.get('entry');
        const entry = lateHex ? new Uint8Array(Buffer.from(lateHex, 'hex')) : null;
        if (entry && entry.length !== 32) return text(res, 400, 'a late settlement is asked for by a 32-byte entry id');
        if (url.pathname === '/settle-commit') {
          const got = await settlements.commit(r8, { txid: url.searchParams.get('txid'), entry });
          if (!got.ok) return text(res, got.status || 409, got.why);
          res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
          return res.end(Buffer.from(encodeCommitments([got.commitment])));
        }
        if (url.pathname === '/settle-share') {
          let list;
          try { list = decodeCommitments(new Uint8Array(await read(req))); } catch (e) { return text(res, 400, e.message); }
          const got = await settlements.share(r8, list, { entry });
          if (!got.ok) return text(res, got.status || 409, got.why);
          res.writeHead(200, { 'content-type': 'application/octet-stream', ...CORS });
          return res.end(Buffer.from(encodeShare(got.share)));
        }
        const signature = new Uint8Array(await read(req));
        if (signature.length !== 64) return text(res, 400, 'a settlement signature is 64 bytes');
        const got = await settlements.take(r8, signature, { entry });
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
        let proposed;
        try { proposed = JSON.parse(Buffer.from(await read(req)).toString('utf8')); } catch (e) { return text(res, 400, `not JSON: ${e.message}`); }
        if (!Array.isArray(proposed)) return text(res, 400, 'send plans are a list');
        const lateHex = url.searchParams.get('late');
        if (lateHex && !/^[0-9a-f]{64}$/.test(lateHex)) return text(res, 400, 'a late settlement is named by a 32-byte entry id');
        const got = lateHex
          ? await settlements.takeLateSends(new Uint8Array(rid), new Uint8Array(Buffer.from(lateHex, 'hex')), proposed)
          : await settlements.takeSends(new Uint8Array(rid), proposed);
        return got.ok ? text(res, 201, `${got.rows.length} send plan(s) checked and kept`) : text(res, got.status || 409, got.why);
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
        const built = await settlements.message(new Uint8Array(rid));
        if (!built.ok) return text(res, built.status || 409, built.why);
        const got = await winnings.checkResend(new Uint8Array(rid), built, proposed);
        return got.ok ? text(res, 201, 're-send checked and kept') : text(res, got.status || 409, got.why);
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
      if (req.method === 'GET' && url.pathname === '/lock-settlement') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        if (rid.length !== 32) return text(res, 400, 'a settlement is asked for by a round id');
        const kept = round.lockSettlement(new Uint8Array(rid));
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        return res.end(JSON.stringify(kept
          ? { state: kept.state, txid: kept.txid, why: kept.why, signature: toHex(kept.signature), message: toHex(kept.message),
            madeMs: kept.madeMs, moved: settlements.summary(new Uint8Array(rid)) }
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
        return res.end(JSON.stringify({ node: toHex(round.pubkey), nowMs: String(nowMs), since: String(since),
          rounds: round.settledSince(since).map((r) => {
            const moved = settlements.summary(r.roundId);
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
        const got = await forfeits.forfeit(new Uint8Array(rid), new Uint8Array(eid));
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
        const held = round.reruns(rid, eid);
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

      // AN OBJECTION AGAINST A RUN (13A intake). What an objection costs and
      // who may file one is the objection protocol and is not decided here;
      // that the node KNOWS of one is what lets the replay queue put it first.
      if (req.method === 'POST' && url.pathname === '/objection') {
        const rid = Buffer.from(url.searchParams.get('round') || '', 'hex');
        const eid = Buffer.from(url.searchParams.get('entry') || '', 'hex');
        const taken = objectionIntake(round, rid, eid);
        // AN OBJECTION THAT HOLDS SUSPENDS THE RESULT, AND THE COMMITTEE
        // RE-RUNS IT (13A): this signer node starts its own re-run at once.
        const after = taken.status === 201 ? resultFinality(round, rid, eid) : null;
        if (after && after.state === SUSPENDED) watchRerun(new Uint8Array(rid), new Uint8Array(eid));
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

  const wss = new WebSocketServer({
    server: http,
    path: '/play',
    maxPayload: MAX_FRAME_BYTES,
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
      http, wss, round, host, verifier, ghosts, roster, preimages,
      payouts, reconcilingPayouts, signing, poolWatch, dkg, settlements, winnings,
      // What the last close did with the money, and the same door an operator
      // uses to run a settlement again by hand.
      stakes: () => stakes,
      settleTheStakes,
      watching: () => watching.size,
      shed: () => shed,
      port: http.address().port,
      // Closed so it actually closes. `http.close` waits for open connections
      // to end, and a play socket does not end on its own - a harness that
      // took the node away hung instead, and the page kept publishing to a
      // server that was supposed to be gone.
      close: () => new Promise((r) => {
        // NO RE-GATHER OUTLIVES THE DAEMON.
        shuttingDown = true;
        clearInterval(settleRecoverTimer);
        clearInterval(winningsTimer);
        clearInterval(lateTimer);
        settlements.stop();
        if (endTimer) clearInterval(endTimer);
        for (const t of finalityTimers) clearTimeout(t);
        finalityTimers.clear();
        for (const t of rerunTimers) clearTimeout(t);
        rerunTimers.clear();
        for (const sock of wss.clients) sock.terminate();
        wss.close();
        http.closeAllConnections();
        http.close(r);
      }),
    }));
  });
}
