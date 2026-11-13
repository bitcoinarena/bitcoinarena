// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SIGNER NODES' FORFEIT OF A QUALIFIER'S STAKE LOCK (v4.6.2 §23.2 row 1, W5b).
//
// "DELIVERED (qualifying): forfeit the stake lock -> it returns to the
// player's key. Requires: threshold settlement signature over the lock,
// published; the player's own client redeems it, and only the player can."
// A forfeit is a BIP-340 signature by the round's claim_pk over the lock's
// contract id (fedimint lnv2: `forfeit_message` is the id); the guardians then
// let the lock be spent with `Cancel(sig)`, and the transaction must be signed
// by the lock's refund_pk - the player. So a forfeit can only return money to
// its owner; what it must never be is a signature a loser can use.
//
// POOLSIGNING'S RULE, FOR A DIFFERENT MESSAGE: a signer node signs only a forfeit it
// rebuilt itself. Nobody hands it a contract id. The asker names the round and
// the entry; the signer node rebuilds the contract from the lock IT verified, and
// signs only if ITS OWN finality says the run is FINAL - window closed - and
// ITS OWN result says the run qualifies (§18: DELIVERED and score >=
// min_score). A loser's, a run inside its window, a Delivered run below the
// score: refused, by name.
//
// THE NONCES LIVE IN MEMORY, ONE PAIR PER ASK (kanban #1521), and a pair signs ONE
// commitment list: the same nonce over two lists is two signatures over two
// messages, which publishes the share. A second asker with the same list gets
// the same share back; with another list, nothing. A PAIR THAT SIGNED A LIST IS
// SPENT, and the next commit draws a new one (kanban #1074, as the settlement's
// #1070): a list one seat on it never completed binds nobody.
import { marketStateOf } from './game-market.js';
import { isScalar } from '../../arena-protocol/src/manifest.js';
import { scalarOneSided } from '../../arena-protocol/src/scalar.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { isQualifier, FORFEIT as FORFEIT_OUTCOME } from '../../arena-protocol/src/payout.js';
import { signShare340, aggregate340, nonceGenerate340, verifyShare340 } from '../../arena-protocol/src/frost-bip340.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { lockFieldsFromJson } from '../../arena-protocol/src/stake-lock.js';
import { FINAL, SUSPENDED, PROVISIONALLY_FINAL } from '../../arena-protocol/src/objection.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { resultFinality, settledResult, agreedRerunOf } from './finality.js';
import { stateOf } from './settlement-state.js';
import { pluginForRound } from './plugins.js';
import { giftsInFeeLock } from '../../arena-protocol/src/reserves.js';
import { encodeCommitments, decodeCommitments, encodeShare, decodeShare, commitmentListRefusal, decodePeerCommitment, peerCommitmentRefusal, leftOffLast, committedIds, COMMITMENT_BYTES, SHARE_BYTES } from './pool-wire.js';
import { askPeers, PEER_ASK_MS, PEER_GRACE_MS } from './peer-ask.js';
import { peerBytesUpTo, peerWhyUpTo } from './peer-body.js';
import { NoncePool, SignerLists, sharesRefused, BOUND_ELSEWHERE, PAIRS_PER_KEY, PAIRS_ALL as POOL_ALL, LIST_TRIALS } from './nonce-pool.js';
import { namedClaims, namedClaimKeys, arenaLockContractId } from '../../arena-protocol/src/arena-lock.js';
import { forfeitLostOn } from './test-named-offence.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { nonceGen, nonceAgg, sign as musigSign } from './musig2.js';
import { evenYKey, signingSecret, namedContext, namedKey, checkSigners, aggregateNamed } from './named-claim.js';

// A PROTOCOL-27 FORFEIT (kanban #1044 B1, ruling #1131 3: "Cancel { signers, signature }"; #1135 3): the lock is an Arena lock, and its forfeit is
// the MuSig2 signature of exactly t named seats over LNv2's forfeit message - the contract id - under KeyAgg(claim_keys[S]), never the FROST key.
// S is the t lowest seat indices that committed to that forfeit, as the asker holds them (#1137: a member checks the list's form and its own nonce,
// not that the list is the lowest). The doors keep their bytes: a commitment travels as { id: seat + 1, hiding: R1, binding: R2 } (its BIP-327
// public nonce R1 || R2), a partial as a 32-byte share, and the combined forfeit as its 64 bytes followed by u8 t and the t signer indices.
const pubnonceOf = (c) => Uint8Array.from([...c.hiding, ...c.binding]);
const partialBytes = (share) => Uint8Array.from(Buffer.from(BigInt(share).toString(16).padStart(64, '0'), 'hex'));
const partialScalar = (bytes) => BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
/** The forfeit as the signature door and the store carry it: 64 bytes, then (named) u8 t and the t ascending seat indices. */
/**
 * A FORFEIT THE PROTOCOL ALLOWS OF AN ENTRY SIGNED LOST (kanban #1044 B1, offence row (b)): the forfeit paths above that hand a non-qualifying entry's stake
 * back to its own player, read off this seat's own record - so the filer files none of them and the judge holds none of them. In a game round they are:
 *  - ENTRY_VOID (§16, §23.2): the outage refund, whatever a seat signed before the void;
 *  - NOBODY WON (nobodyWonReturn, 2026-10-03): no entry of the round qualifies, so no loser's lock is anyone else's - every one but a walk-away's
 *    (FORFEIT, never a refund) comes back at settlement. Read off the entries' FINAL results, not the settlement. Measured 2026-11-05 on s28a, round b94a4863: the one entry FAILED, five seats forfeited its stake
 *    back as ruled, and six seats filed it as offence (b) - five honest bonds started.
 * The other forfeit doors name no entry signed lost: a refused round's lock (no entry, no result), and a market's order and refund doors (no run, no result).
 * Answers { allowed: true, why }, { allowed: false }, or { allowed: null, why } where this seat cannot read it yet (an entry not final here): the filer then waits, and the judge cannot say. `finalityOf` / `settledOf`: finality.js's, injected by tests.
 */
export function lostForfeitAllowed(round, roundIdBytes, entryIdBytes, { finalityOf = resultFinality, settledOf = settledResult, rerunOf = agreedRerunOf } = {}) {
  if (round.entryVoid && round.entryVoid(entryIdBytes)) return { allowed: true, why: 'the entry is ENTRY_VOID here: its stake comes back as the outage refund' };
  if (!round.get(roundIdBytes)) return { allowed: null, why: 'this seat does not hold that round, so it cannot read whether anybody won' };
  let contract;
  try { contract = decodeRoundContract(new Uint8Array(round.get(roundIdBytes).contract)); } catch { return { allowed: null, why: 'the round\'s contract does not decode here' }; }
  // AN AGREED RE-RUN THAT MAKES THE ENTRY A QUALIFIER ALLOWS ITS STAKE BACK (kanban #1173, row (b)): a seat that saw the objection late holds FINAL on the
  // lost first run, while the seats that saw it in time went FINAL on the committee's re-run and forfeit the qualifier's stake back, as ruled - by the
  // re-run, not by this seat's own window, that forfeit is no offence. Measured in reading: lostForfeitAllowed read only this seat's finality
  const rr = rerunOf(round, roundIdBytes, entryIdBytes);
  if (rr && rr.ok && rr.result && isQualifier(rr.result, contract.minScore))
    return { allowed: true, why: `the committee agreed a re-run (${String(rr.runId).slice(0, 16)}) by which the entry qualifies: its stake comes back by its own forfeit` };
  // WHO WON, BY THE RESULTS THIS SEAT HOLDS FINAL - not by its settlement: a forfeit of a loser's lock leaves the settlement unbuildable (the lock is gone
  // from the guardians, measured 2026-11-06 on s29a round b0bfe1be), so a reading that waited for ACCEPTED would never file the offence it is about
  const settled = new Map();
  for (const e of round.entriesOf(roundIdBytes)) {
    let st, result = null;
    try { st = finalityOf(round, roundIdBytes, e.entryId); result = st.state === FINAL ? settledOf(round, roundIdBytes, e.entryId, st) : null; } catch { return { allowed: null, why: 'an entry\'s result cannot be read here' }; }
    if (st.state === 'VOID') continue;
    if (!result) return { allowed: null, why: `entry ${toHex(e.entryId).slice(0, 16)} is not final here yet (${st.state})` };
    settled.set(toHex(e.entryId), result);
  }
  const own = settled.get(toHex(entryIdBytes));
  if (own && own.outcome === FORFEIT_OUTCOME) return { allowed: false };
  if ([...settled.values()].some((r) => isQualifier(r, contract.minScore))) return { allowed: false };
  return { allowed: true, why: 'nobody won: no entry of the round qualifies, so a lost entry\'s stake is nobody else\'s and comes back (nobodyWonReturn)' };
}

export const encodeNamedForfeit = (signature, signers) => Uint8Array.from([...signature, signers.length, ...signers]);
export function decodeForfeitBody(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 64) return null;
  if (bytes.length === 64) return { signature: bytes.slice(0, 64), signers: null };
  const t = bytes[64];
  if (bytes.length !== 65 + t || t < 1) return null;
  return { signature: bytes.slice(0, 64), signers: [...bytes.slice(65)] };
}

/**
 * WHAT A PROTOCOL-27 SEAT SIGNS AS A FORFEIT, from the lock it verified: an Arena lock naming this round, the round's settlement seats in seat order
 * and its threshold, its contract id rebuilt here (arena-lock.js arenaLockContractId, the guardians' forfeit message), this seat one of the keys.
 */
export function namedForfeitMessage({ contract, lock, roundId, pubkey }) {
  const fields = lockFieldsFromJson(lock.fields);
  if (!fields.arena) return refuse('this round locks to an Arena lock (protocol 27), and that lock is a stock contract to one claim key');
  const { seatKeys, threshold } = namedClaimKeys(contract);
  if (fields.threshold !== threshold || fields.claimKeys.length !== seatKeys.length || fields.claimKeys.some((k, i) => toHex(k) !== toHex(seatKeys[i])))
    return refuse('that lock\'s claim keys are not this round\'s settlement seats in seat order with its threshold');
  if (toHex(fields.roundId) !== toHex(roundId)) return refuse('that lock names another round than this one');
  const id = toHex(arenaLockContractId(fields));
  if (id !== String(lock.contractId).toLowerCase()) return refuse('the contract rebuilt from this signer node\'s record is not the one it verified');
  const me = seatKeys.findIndex((k) => toHex(k) === toHex(pubkey));
  if (me < 0) return refuse('this node is not one of the round\'s settlement seats, so it signs no forfeit of its locks');
  return { ok: true, named: true, message: fromHex(id), claimKeys: seatKeys, threshold, me, needed: threshold, nodes: contract.nodes };
}
import { PLAN_ASK, sendPlanAskHeaders, checkSendPlanAsk, forfeitCommitAskBody } from './send-plan-ask.js';
import { AskerPairs, commitAsker, shareAsker, spendRefusal, OWN } from './asker-pairs.js';

// A FEE LOCK'S RETURN (2026-10-09: "orders can be cancelled at no cost"): kept under its own key beside
// the stake lock's, so an entry's two returns never stand in each other's place
const FEE_RETURN_TAG = new TextEncoder().encode('arena fee lock return v1');
export const feeReturnKey = (entryIdBytes) => { const m = new Uint8Array(FEE_RETURN_TAG.length + 32); m.set(FEE_RETURN_TAG); m.set(entryIdBytes, FEE_RETURN_TAG.length); return sha256(m); };
const keptUnder = (entryIdBytes, kind) => (kind === 'fee' ? feeReturnKey(entryIdBytes) : entryIdBytes);

const verifies = (sig, msg, x) => { try { return schnorr.verify(sig, msg, x); } catch { return false; } };
const listKey = (commitments) => commitments.map((c) => `${c.id}:${toHex(c.hiding)}:${toHex(c.binding)}`).sort().join('|');
const refuse = (why, status = 409) => ({ ok: false, status, why });
// THE PAIRS (kanban #1521, #1699, #1764, #1996, #2011, #2044): one pair per ask, kept by its commitment, in nonce-pool.js - the same rule
// as the settlement's and the winnings send's. A full pool no longer refuses a commit (a stranger who kept it full stopped every forfeit
// with 503s): spent and old pairs make room first, then one young unspent pair at random, never of the oldest quarter, never the seat's own.
export const PAIRS_PER_FORFEIT = PAIRS_PER_KEY;
export const PAIRS_ALL = POOL_ALL;
export const FORFEIT_LIST_TRIALS = LIST_TRIALS;
// HOW LONG A PAIR HANDED OUT IS KEPT AT LEAST (kanban #1611): the asker's two rounds, and never less than this - a seat busy with a flood answers late
const PAIR_HOLD_MIN_MS = 60000;

// misnamedSigners and spoiltShares live in signer-guard.js (kanban #2369, #2372): the winnings send and the reserve payout run them too
export { misnamedSigners, spoiltShares } from './signer-guard.js';
import { misnamedSigners, spoiltShares } from './signer-guard.js';

/**
 * WHAT THIS SEAT COMMITTED A LOCK TO, ONE ENUM AND ONE TRANSITION FUNCTION (kanban #1184, the 2026-11-06 state-machine audit). A lock has two ways
 * out a seat can sign: the settlement's Claim (into the winners' payouts) and the forfeit's Cancel (back to its player). A seat that acked, shared,
 * was handed or kept a settlement claiming a lock and later learned ENTRY_VOID (or a qualifier rule) signed a forfeit of the same lock too: two
 * valid spends, the faster wins. Now: none -> CLAIMING (ack, share, take or keep of a settlement that claims it) | RETURNING (share, take or keep
 * of a forfeit of it); either is final, and the other is refused. Persisted (round.js putLockFate, compare-and-set) before the ack, share or
 * forfeit leaves this seat. A lock left unspent by a refusal still returns to its player at its expiry.
 */
export const LOCK_FATE = Object.freeze({ CLAIMING: 'CLAIMING', RETURNING: 'RETURNING' });
export function lockFateStep(held, next) {
  if (!Object.values(LOCK_FATE).includes(next)) return { ok: false, why: `${next} is not a fate of a lock` };
  if (!held || held === next) return { ok: true };
  return { ok: false, why: held === LOCK_FATE.CLAIMING
    ? 'this seat committed to a settlement that claims that lock: it signs no forfeit of it - the lock returns to its player at its expiry if that settlement never lands'
    : 'this seat signed a forfeit of that lock back to its player: it signs no claim of it' };
}

/**
 * WHAT THIS SEAT HOLDS A LOCK AT (kanban #1184): its persisted fate, and - for a store whose history predates lock_fates - CLAIMING when any
 * settlement of the round this seat signed, was handed or kept the moves of claims the outpoint. null with neither.
 */
export function lockFateOf(round, roundIdBytes, outpoint) {
  const kept = typeof round.lockFate === 'function' ? round.lockFate(String(outpoint)) : null;
  if (kept) return kept.state;
  if (typeof round.claimedOutpointsOf === 'function' && round.claimedOutpointsOf(roundIdBytes).has(String(outpoint))) return LOCK_FATE.CLAIMING;
  return null;
}

/** Move a lock to `next` (kanban #1184): checked by lockFateStep and written as a compare-and-set. { ok } or { ok: false, why }. */
export function markLockFate(round, { roundId, outpoint, state, txid = null, why }) {
  const st = lockFateStep(lockFateOf(round, roundId, outpoint), state);
  if (!st.ok) return st;
  if (typeof round.putLockFate !== 'function') return { ok: true };
  return round.putLockFate({ outpoint: String(outpoint), roundId, state, txid, why })
    ? { ok: true } : { ok: false, why: lockFateStep(lockFateOf(round, roundId, outpoint), state).why || 'another fate was written for that lock meanwhile' };
}

export class Forfeit {
  /**
   * `dkg` holds this signer node's share of the round's claim key; `port` is the
   * federation (it hashes a contract the way the guardians do); `peersFor(rid)`
   * names the other settlement signer nodes' bases.
   */
  constructor(round, { dkg, port, curve, random, peersFor = () => [], fetcher = (u, o) => fetch(u, o), onVoid = null, pullProof = null, refusedNow = null, bookStanding = null, isBook = null, lockSetOut = null, kindPending = null,
    peerAskMs = PEER_ASK_MS, peerGraceMs = PEER_GRACE_MS } = {}) {
    this.round = round;
    // HOW LONG A SEAT IS WAITED FOR (peer-ask.js, kanban #1074 as #1061)
    this.peerAskMs = peerAskMs;
    this.peerGraceMs = peerGraceMs;
    // AN ORDER OF AN ORDER BOOK (comment 1127): the book's word on it - filled, cancelled, in a batch not decided
    this.bookStanding = bookStanding;
    // rid -> whether the round is an order book (order-batch.js isBook: a certified batch holds an order) - its orders are its entries, else its plain picks
    this.isBook = isBook;
    // rid -> the batches holding an order still undecided here (order-batch.js kindPending, kanban #1666): the round's kind is not decided yet
    this.kindPending = kindPending;
    // §23.2 REFUSED: rid -> why this node refuses the round, or null while it offers it
    this.refusedNow = refusedNow;
    // THE CERTIFIED LOCK SET (protocol 28, kanban #2561, §17A): rid, eid -> why this entry's lock is not in its round (a lock outside the
    // certificate, or every lock of a round VOID for want of one), or null - such a lock goes back by forfeit at once
    this.lockSetOut = lockSetOut;
    // THE OTHER SIGNER NODES' PROOF OF TWO FIRST MARKS, pulled and checked here before a
    // Void lock is refunded (M3.3-34): `pullProof(rid, eid)` keeps a pair that
    // verifies in this signer node's own store.
    this.pullProof = pullProof;
    this.dkg = dkg;
    this.port = port;
    this.curve = curve;
    this.random = random;
    this.peersFor = peersFor;
    this.fetcher = fetcher;
    // ENTRY_VOID's evidence, handed to the other signer nodes before a Void lock is
    // forfeited: a signer node that was down records the Void only when shown it.
    this.onVoid = onVoid;
    // contract id hex -> the pairs handed out for that forfeit, each { commitment, hiding, binding | named, secnonce, at, own, asker, list, share } (nonce-pool.js,
    // kanban #1521, #2011), in a pool per asker (kanban #2386, asker-pairs.js). HOW LONG AN UNSPENT PAIR IS SURELY KEPT FOR ITS ASKER (kanban #1611, #1699):
    // its two rounds, twice over, at least PAIR_HOLD_MIN_MS
    this.pairs = new NoncePool({ holdMs: () => Math.max(2 * (this.peerAskMs + this.peerGraceMs), PAIR_HOLD_MIN_MS) });
    this.lists = new SignerLists();  // a forfeit's query -> the peers left off its next list, and its poisoned lists (kanban #1074, #1699, #1764)
  }

  /** WHAT THIS SIGNER NODE WILL SIGN, rebuilt from its own store - or the refusal. */
  // `kind`: 'stake' (the stake lock, as always) or 'fee' - a market order's fee lock, returned at once only when the order was
  // cancelled before its round's entry close or the market is refunded (VOID, nobody right); otherwise it is claimed at
  // resolution or expires back to its player
  async message(roundIdBytes, entryIdBytes, kind = 'stake') {
    const row = this.round.get(roundIdBytes);
    if (!row) return refuse('this node holds no such round', 404);
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    // A LOCK GOES BACK ONLY THROUGH THE ROUND IT STAKES (feedback #018, kanban #2511, critical; before the order book's rules too - feedback #023, Hexbox:
    // naming a VOID market round signed another round's filled order stake and fee lock back through #bookReturn): every rule below reads the lock by its entry and the
    // round from the asker - a certified loser of one protocol-28 round named another round of the same seats (VOID, or one it is not in) and had
    // its stake and fee lock signed back after seeing the reveals. The entry, its stake lock and its fee lock must all name the asked round.
    if (this.round.roundsOfEntry) {
      const asked = toHex(roundIdBytes), of = this.round.roundsOfEntry(entryIdBytes);
      const other = [of.entry, of.stake, of.fee].find((r) => r && r !== asked);
      if (other) return refuse(`that entry and its locks belong to round ${other.slice(0, 16)}, not to the round asked: a lock goes back only through its own round`, 409);
    }
    // AN ORDER OF AN ORDER BOOK: its own rules (comment 1127)
    { const book = this.bookStanding ? this.bookStanding(roundIdBytes, entryIdBytes) : null;
      if (book && book.book) return this.#bookReturn(roundIdBytes, entryIdBytes, contract, kind, book); }
    // A CANCELLED MARKET ORDER: signed by its player before entry close, out of the round's table at this seat
    const cancelled = !!(this.round.cancelled && this.round.cancelled(entryIdBytes));
    if (kind === 'fee') {
      const fl = this.round.feeLock ? this.round.feeLock(entryIdBytes) : null;
      if (!fl) return refuse('this signer node verified no fee lock for that entry, so it returns none');
      // A PLAIN PICK IN A ROUND THAT BECAME AN ORDER BOOK (kanban #2207, §0A.7b as ruled in #1417): no entry of that round, returned as §23.2
      // REFUSED - the stake AND its fee lock. The book's settlement claims fee locks only for the orders of its table, so this door is the only
      // one that moves it; the lock-fate guard in #signable still holds.
      const b = this.bookStanding ? this.bookStanding(roundIdBytes, entryIdBytes) : null;
      if (b && !b.book && b.wrongType) return this.#signable(contract, fl, roundIdBytes);
      if (!cancelled && !this.#marketRefund(roundIdBytes, contract).ok) {
        let back = await this.#feeBackWithStake(roundIdBytes, entryIdBytes, contract);
        // AN ENTRY LEFT OUTSIDE THE SEATS GETS ITS FEE LOCK BACK WITH ITS STAKE (kanban #2430): a paying head-to-head entry that got no
        // seat is signed VOID, its fee lock never claimed (lock-settlement.js), and its stake comes back at settlement (#1582) - so does
        // its fee lock, on the same conditions read for this fee lock: no seat here, the settlement ACCEPTED here, the lock not among its claims
        if (!back.ok && this.round.stakeLock(entryIdBytes)) {
          const out = this.#outsideTheSeats(roundIdBytes, entryIdBytes, contract, fl);
          if (out.ok) back = out;
        }
        if (!back.ok)
          return refuse('a fee lock comes back at once only for a cancelled order or a refunded market (or with a protocol-27 entry\'s voided stake): '
            + `this one is claimed at resolution, or expires back to its player${back.why ? ` (${back.why})` : ''}`);
      }
      return this.#signable(contract, fl, roundIdBytes);
    }
    let lock = this.round.stakeLock(entryIdBytes);
    // §23.2 REFUSED (2026-10-06 08:57: "A round the seats refuse gets an immediate refund"): no entry,
    // but a lock this node kept for a round it refuses, under its handout's id (POST /refused-lock) - returned at once, on
    // this node's own record that it still refuses the round and that the lock stakes no entry here. No result, no window.
    let refused = null;
    if (!lock && this.round.refusedLock) {
      const kept = this.round.refusedLock(entryIdBytes, roundIdBytes);   // kanban #2029: the round's rows from before #1881 by their own id too
      if (kept && toHex(kept.roundId) === toHex(roundIdBytes)) {
        const why = this.refusedNow ? this.refusedNow(roundIdBytes) : null;
        if (!why) return refuse('this signer node offers that round: a lock kept for it as refused is not returned');
        const [txid, idx] = String(kept.outpoint).split(':');
        const at = { txid: fromHex(txid), outIdx: BigInt(idx) };
        if ((this.round.stakeLockAt && this.round.stakeLockAt(at)) || (this.round.feeLockAt && this.round.feeLockAt(at)))
          return refuse('that lock stakes an entry at this signer node: it is settled with its round, never returned as refused');
        lock = kept; refused = why;
      }
    }
    if (!lock) return refuse('this signer node verified no stake lock for that entry, so it forfeits nothing');
    // OUTSIDE THE CERTIFIED LOCK SET (kanban #2561, ruling on #2116: "a lock that arrives after the certificate is not in the round and goes back
    // by forfeit at once"), or the round VOID with no certificate by close + the window: returned at once, as a refused round's lock (§23.2),
    // on this signer node's own certificate (or its want of one) - never claimed, so no result and no settlement to wait for
    if (!refused && this.lockSetOut) { let out = null; try { out = await this.lockSetOut(roundIdBytes, entryIdBytes); } catch { out = null; } if (out) refused = out; }
    // A PLAIN PICK IN A ROUND THAT BECAME AN ORDER BOOK (§0A.7b RULED 2026-11-10, kanban #1411/#1417): not an entry of that round - its lock is
    // returned at once, as a refused round's stake is (§23.2), with no result and no window to wait for
    if (!refused && kind === 'stake') { const b = this.bookStanding ? this.bookStanding(roundIdBytes, entryIdBytes) : null; if (b && !b.book && b.wrongType) refused = b.wrongType; }
    // THE REGTEST FAULT (test-named-offence.js, off by default): offence (b) - the forfeit of an entry this seat itself signed non-qualifying
    if (!refused && namedClaims(contract) && forfeitLostOn(entryIdBytes)) {
      const mine = (this.round.results ? this.round.results(roundIdBytes, entryIdBytes) : []).some((r) => {
        if (toHex(r.nodePubkey) !== toHex(this.round.pubkey)) return false;
        try { const b = decodePlayerResult(splitSignedResult(r.bytes).body); return !isQualifier(b, contract.minScore); } catch { return false; }
      });
      if (!mine) return refuse('test fault armed for that entry, and this seat has signed no non-qualifying result for it yet');
      console.log(`[forfeit] ${toHex(roundIdBytes).slice(0, 16)} TEST FAULT: forfeits entry ${toHex(entryIdBytes).slice(0, 16)}, which it signed lost (ARENA_TEST_NAMED_OFFENCE_FILE)`);
      return this.#signable(contract, lock, roundIdBytes, { fault: true });
    }
    // ENTRY_VOID (§16, §23.2 "forfeit at once; if nobody acts, the lock expires"):
    // an outage refund, on THIS signer node's own record of it - never on an asker's
    // word, and never for a late start (that is FORFEIT, first-mark.js) or a
    // run with no first mark. The lock goes back to the player's refund key
    // now, instead of at expiry. Everything else below still holds: the lock
    // this signer node verified, the round's claim key, the contract rebuilt here.
    const voided = !refused && this.round.entryVoid ? this.round.entryVoid(entryIdBytes) : null;
    // TWO FIRST MARKS AFTER THE VOID (§13B, §13C; ruled 2026-09-12): once this
    // signer node holds the player's second first mark - or its no-quorum rule decided
    // FORFEIT - the Void stays as history and it signs no refund. Measured before
    // on a fresh federation: both signer nodes signed it and the player redeemed the
    // lock before its expiry.
    // A VOID SIGNER NODE ASKS THE OTHERS FIRST (M3.3-34, a lock with receipts lost
    // between signer nodes that are up): a refund signed on this signer node's own Void record
    // alone forms while another signer node holds the proof. Measured before: five signer nodes
    // that each kept only their own receipt recorded the Void, signed at once -
    // five signatures - and the player could redeem 98000 msat before the lock's
    // expiry; signer node 5 held the proof. The pair pulled here is checked and kept.
    let pulled = null;
    if (voided && this.pullProof && !(this.round.twoFirstMarks && this.round.twoFirstMarks(roundIdBytes, entryIdBytes))) {
      try { pulled = await this.pullProof(roundIdBytes, entryIdBytes); } catch { /* a signer node that cannot answer proves nothing */ }
    }
    const nq = voided && this.round.noQuorum ? this.round.noQuorum(entryIdBytes) : null;
    if (voided && ((this.round.twoFirstMarks && this.round.twoFirstMarks(roundIdBytes, entryIdBytes)) || (nq && nq.outcome === 'FORFEIT')))
      return refuse('the player signed two first marks for this entry (§13B): FORFEIT, never the outage refund - '
        + 'this signer node\'s ENTRY_VOID stays as history, and it signs no forfeit of the lock to the player');
    // A VOID THIS SIGNER NODE LEARNED ONLY FROM A FORFEIT ASK SIGNS A LOCK REFUND ONLY IF
    // ITS PROOF PULL REACHED EVERY OTHER SIGNER NODE (M3.3-34, ruled 2026-09-13 - "a signer node
    // down stops the rule", as no-quorum): with one unreachable, that signer node may hold
    // the proof of two first marks, so no refund - the lock returns to the player
    // at its expiry. Measured before on 5 of 7 (path 2, signer node 4 down from its
    // refusal - the ruled limit, no lock refund): the ask handed signer nodes 5 and 6 the
    // full receipts, they recorded the Void and signed, and a committee refund
    // formed at once with six signatures while the only proof sat on the signer node that
    // was down. Never signing at all took 2 of 2's outage refund away: there the
    // forfeit ask is how the signer node that was down learns the Void at all.
    if (voided && voided.learned === 'forfeit-ask' && !(pulled && pulled.reached === pulled.peers))
      return refuse('this signer node learned the ENTRY_VOID only from a forfeit ask, and its proof pull reached '
        + `${pulled ? `${pulled.reached} of ${pulled.peers}` : 'none'} of the other signer nodes: it signs no refund of the lock - `
        + 'a signer node it cannot reach may hold the proof of two first marks; the lock returns to the player at its expiry');
    // AN ATTESTED ROUND (§0A.7a): no run and no result. A stake comes back by this forfeit once THIS
    // signer node's settlement of the round is ACCEPTED and did not claim the lock - a winning pick's, or every pick's when
    // nobody picked the outcome. Before that it waits; a claimed lock was a losing pick's, and is not the player's.
    const attested = !voided && !refused && !cancelled && this.round.plugins
      ? (() => { const f = pluginForRound(contract, this.round.plugins); return f.ok && f.attested; })() : false;
    // A MARKET ROUND REFUNDED (2026-10-09: "refund at the deadline", "refund the fees too"): VOID at its
    // deadline or on a contradiction, or final with nobody holding the right pick - nothing is claimed in it, so every stake
    // comes back now, on this signer node's own record, with no settlement to wait for
    const refund = attested ? this.#marketRefund(roundIdBytes, contract) : { ok: false };
    if (attested && !refund.ok) {
      if (this.#settled(roundIdBytes) !== 'ACCEPTED')
        return refuse('an attested round\'s stake comes back only after its settlement is ACCEPTED at this signer node: no outcome final and settled yet, so the lock waits (or expires back)');
      const moves = this.round.lockSettlementMoves ? this.round.lockSettlementMoves(roundIdBytes) : null;
      if (!moves) return refuse('this signer node keeps no record of what its settlement moved');
      if ((moves.claims || []).includes(String(lock.outpoint))) return refuse('that pick lost: its lock was claimed into the winners\' payouts');
    }
    if (!voided && !refused && !attested && !cancelled) {
      const standing = resultFinality(this.round, roundIdBytes, entryIdBytes);
      // VOID (§13C, §23.2 "do nothing"): nothing is forfeited - nobody acts, and
      // the lock returns to the player at its expiry. Not ENTRY_VOID's forfeit.
      // A LOCK OUTSIDE THE SEATS COMES BACK AT SETTLEMENT (kanban #1582 with #1588): /lock keeps every valid lock of a paying head-to-head
      // round, and the seats are the game's players with the lowest entry ids (round.js seatedEntriesOf, #2538) - a player whose lock is
      // held but who got no seat is signed VOID and never claimed. Before, that stake waited for the lock's expiry (144 blocks live);
      // now it comes back as soon as THIS signer node's settlement of the round is ACCEPTED without claiming it, as nobodyWonReturn does
      const out = this.#outsideTheSeats(roundIdBytes, entryIdBytes, contract, lock);
      const outside = out.ok;
      if (!outside && standing.state === 'VOID')
        return refuse(`that entry is VOID (§13C): nothing is forfeited - nobody acts, and the lock returns to the player at its expiry${out.why ? ` (${out.why})` : ''}`);
      if (!outside && standing.state !== FINAL)
        return refuse(`no forfeit before the result is final with its objection window closed: ${standing.why || standing.state}`);
      const result = outside ? null : settledResult(this.round, roundIdBytes, entryIdBytes, standing);
      if (!outside && !result) return refuse('this signer node signed no result for that run, so it forfeits nothing');
      if (!outside && !isQualifier(result, contract.minScore)) {
        const back = this.nobodyWonReturn(roundIdBytes, entryIdBytes, lock, result);
        if (!back.ok)
          return refuse(`that run is ${result.outcome} with score ${result.score} and this round's minimum is `
            + `${contract.minScore}: not a qualifier, so its stake lock is not forfeited (${back.why})`);
      }
    }
    return this.#signable(contract, lock, roundIdBytes);
  }

  /**
   * A PROTOCOL-27 GAME ENTRY'S FEE LOCK BACK WITH ITS STAKE (kanban #1486, ruled 2026-11-11: no developer or reserve money for an entry
   * that is not accepted). Its fee lock holds the nodes', the developers' and the reserves' parts, and an ENTRY_VOID entry is not counted:
   * the settlement never claims its fee lock (feeSettlement counts no refund). So it is returned at once beside the stake - only when THIS
   * signer node would return the stake for that ENTRY_VOID now, on the stake's own conditions (no two first marks, the proof pull), never on
   * a qualifier's or a loser's record. Below 27 a game's fee lock expires back as before; a market's has its own door above.
   */
  async #feeBackWithStake(roundIdBytes, entryIdBytes, contract) {
    if (!giftsInFeeLock(contract)) return { ok: false };
    if (this.round.plugins) { const f = pluginForRound(contract, this.round.plugins); if (f.ok && f.attested) return { ok: false }; }
    let out = null;   // or its stake outside the certified lock set (kanban #2561): back at once, its fee lock with it
    if (this.lockSetOut) { try { out = await this.lockSetOut(roundIdBytes, entryIdBytes); } catch { out = null; } }
    if (!out && !(this.round.entryVoid && this.round.entryVoid(entryIdBytes))) return { ok: false, why: 'that entry is not ENTRY_VOID at this signer node (nor outside a certified lock set)' };
    const stake = await this.message(roundIdBytes, entryIdBytes, 'stake');
    return stake.ok ? { ok: true } : { ok: false, why: `its stake is not returned either: ${stake.why}` };
  }

  /** Where the round's settlement stands at this signer node - in one federation or, for a round that takes any, in all (round.js). */
  #settled(roundIdBytes) { return stateOf(this.round, roundIdBytes); }

  /** The lock's contract id, rebuilt from this signer node's own record, under the round's claim key - what it signs. */
  // A LOCK THIS SEAT COMMITTED TO CLAIMING IS NEVER FORFEITED HERE (kanban #1184): whichever path asks - ENTRY_VOID, a qualifier, nobody won, a
  // refused round, a market's return door - the lock's fate here is read first; the regtest fault (`fault`, offence (b)) alone skips it
  async #signable(contract, lock, roundIdBytes, { fault = false } = {}) {
    const outpoint = String(lock.outpoint);
    if (!fault) {
      const st = lockFateStep(lockFateOf(this.round, roundIdBytes, outpoint), LOCK_FATE.RETURNING);
      if (!st.ok) return refuse(st.why);
    }
    const m = await this.#signableMessage(contract, lock, roundIdBytes);
    return m.ok ? { ...m, outpoint, fault } : m;
  }

  /** RETURNING ON DISK BEFORE A SHARE, A TAKE OR A KEEP OF THE FORFEIT (kanban #1184): false-y `ok` when the lock is CLAIMING here. */
  #returning(roundIdBytes, m, step) {
    if (m.fault) return { ok: true };
    return markLockFate(this.round, { roundId: roundIdBytes, outpoint: m.outpoint, state: LOCK_FATE.RETURNING, why: step });
  }

  async #signableMessage(contract, lock, roundIdBytes) {
    if (namedClaims(contract)) return namedForfeitMessage({ contract, lock, roundId: roundIdBytes, pubkey: this.round.pubkey });
    const held = this.dkg.signerNodeFor(contract.nodes);
    if (!held.ok) return refuse(`this signer node holds no share of the round's claim key: ${held.why}`);
    const claimPk = held.pool.groupPublicKey;
    const fields = lockFieldsFromJson(lock.fields);
    if (toHex(fields.claimPk) !== toHex(claimPk)) return refuse('that lock names another claim key than this round\'s');
    if (!this.port) return refuse('this signer node reaches no federation, so it cannot rebuild the lock');
    // THE ROUND'S OWN FEDERATION'S PORT: every node serves every federation in its census
    const port = this.port && typeof this.port.forFederation === 'function' ? ((await this.port.forFederation(toHex(contract.federationId))) || this.port) : this.port;
    const id = String(await port.contractId(fields));
    if (id !== String(lock.contractId)) return refuse('the contract rebuilt from this signer node\'s record is not the one it verified');
    return { ok: true, message: fromHex(id), claimPk, signerNode: held.signerNode, needed: receiptsNeeded(contract.gameVerifySlots), nodes: contract.nodes };
  }

  /** A held stake lock of a paying head-to-head round's entry that got no seat here, its settlement ACCEPTED without claiming it (kanban #1582, #1588). */
  #outsideTheSeats(roundIdBytes, entryIdBytes, contract, lock) {
    if (contract.stakeMsat === 0n || typeof this.round.seatedEntriesOf !== 'function' || !this.round.plugins) return { ok: false };
    const g = pluginForRound(contract, this.round.plugins);
    if (!g.ok || !g.headToHead) return { ok: false };
    if (this.round.seatedEntriesOf(roundIdBytes, contract.stakeMsat).some((e) => toHex(e.entryId) === toHex(entryIdBytes))) return { ok: false };
    if (this.#settled(roundIdBytes) !== 'ACCEPTED') return { ok: false, why: 'it got no seat; it comes back once the round\'s settlement is ACCEPTED here' };
    const moves = this.round.lockSettlementMoves ? this.round.lockSettlementMoves(roundIdBytes) : null;
    if (!moves) return { ok: false, why: 'this signer node keeps no record of what its settlement moved' };
    if ((moves.claims || []).includes(String(lock.outpoint))) return { ok: false, why: 'its lock was claimed in the settlement' };
    return { ok: true };
  }

  /**
   * NOBODY WON: THE STAKE BACK AT SETTLEMENT, NOT AT EXPIRY (2026-10-03: "1 is fine" - the money back within a
   * block, stake_expiry_blocks stays 144 as the backstop). A round whose settlement paid no winner claims no loser's
   * lock but a walk-away's (lock-settlement.js `nobody`), and every other lock "expires back to its player" - after 144
   * blocks. On THIS signer node's own record - its settlement ACCEPTED, no winner's share in it, this lock not among
   * its claims, and no entry of the round still inside a window that could change who won - the lock is forfeited back
   * to its refund key now. A forfeit can only return money to its owner; a walk-away (FORFEIT) is never a refund.
   */
  nobodyWonReturn(roundIdBytes, entryIdBytes, lock, result) {
    if (result.outcome === FORFEIT_OUTCOME) return { ok: false, why: 'a walk-away is never a refund' };
    if (this.#settled(roundIdBytes) !== 'ACCEPTED') return { ok: false, why: 'the round\'s settlement is not ACCEPTED at this signer node' };
    const moves = this.round.lockSettlementMoves ? this.round.lockSettlementMoves(roundIdBytes) : null;
    if (!moves) return { ok: false, why: 'this signer node keeps no record of what its settlement moved' };
    if ((moves.claims || []).includes(String(lock.outpoint))) return { ok: false, why: 'its lock was claimed in the settlement' };
    const shares = this.round.lockSettlementShares ? this.round.lockSettlementShares(roundIdBytes) : null;
    if (!shares || shares.length) return { ok: false, why: 'the settlement paid a winner' };
    for (const e of this.round.entriesOf(roundIdBytes)) {
      const st = resultFinality(this.round, roundIdBytes, e.entryId).state;
      if (st === SUSPENDED || st === PROVISIONALLY_FINAL) return { ok: false, why: 'an entry of the round is still inside its window' };
    }
    return { ok: true };
  }

  /**
   * AN ORDER'S LOCKS AT THE RETURN DOOR (comment 1127; 2026-10-09 "(a)"). A lock moves whole, so:
   *  - FILLED: closed - a whole return would hand back filled money; its lock is claimed at resolution and its unfilled rest
   *    paid back there (also when it was cancelled after a fill, and a seller's proceeds);
   *  - in a batch NOT DECIDED yet: it waits for that batch;
   *  - UNFILLED and CANCELLED by a certified batch: both locks back at once, whole;
   *  - UNFILLED and standing: back once the market's outcome is final (nothing can fill it then), or when it is refunded.
   */
  #bookReturn(roundIdBytes, entryIdBytes, contract, kind, book) {
    const lock = kind === 'fee' ? (this.round.feeLock ? this.round.feeLock(entryIdBytes) : null) : this.round.stakeLock(entryIdBytes);
    if (!lock) return refuse(`this signer node verified no ${kind} lock for that order, so it returns none`);
    if (this.#marketRefund(roundIdBytes, contract).ok) return this.#signable(contract, lock, roundIdBytes);
    if (book.inPending) return refuse('that order is in a batch not decided yet: its locks wait for it');
    if (book.filled) return refuse('that order filled: its locks are claimed at resolution and its unfilled rest paid back there');
    if (book.cancelled) return this.#signable(contract, lock, roundIdBytes);
    // FINAL ON THE ROUND'S PERSISTED STATE (kanban #1151): nothing can fill it then
    const f = pluginForRound(contract, this.round.plugins);
    const fin = f.ok && f.attested ? marketStateOf(this.round, roundIdBytes, { contract, manifest: f.plugin.manifest, nowMs: this.round.now ? this.round.now() : Date.now() }) : { final: false };
    if (fin.final) return this.#signable(contract, lock, roundIdBytes);
    return refuse('that order stands unfilled: cancel it (at no cost) or wait for the market to resolve');
  }

  /** Whether a market round is refunded on this signer node's record: VOID (deadline, contradiction), or nobody picked right. */
  #marketRefund(roundIdBytes, contract) {
    const f = pluginForRound(contract, this.round.plugins);
    if (!f.ok || !f.attested) return { ok: false };
    const nowMs = this.round.now ? this.round.now() : Date.now();
    // THE RETURN DOOR OPENS ONLY ON THE ROUND'S PERSISTED STATE (kanban #1151, game-market.js marketStateOf): VOID - by its
    // deadline (a template's round by its own resolution time's, feature 5), a contradiction inside its objection window, or a market
    // on a game's held VOID at once (feature 6) - is stored before a stake is handed back, and never changes after: an attestation
    // handed in late cannot turn the round into one that claims the locks returned here. FINAL never turns VOID either.
    const fin = marketStateOf(this.round, roundIdBytes, { contract, manifest: f.plugin.manifest, nowMs });
    if (fin.voided) return { ok: true, why: fin.why };
    // NO "NOBODY PICKED IT" REFUND WHILE THE ROUND'S KIND IS UNDECIDED (kanban #1666): which entries count (plain picks or orders) waits for the
    // pending batch holding orders - an order handed back as a pool's now could be filled by that batch once it is certified
    if (typeof this.kindPending === 'function' && this.kindPending(roundIdBytes).length) return { ok: false };
    // ONLY THE ENTRIES THE SETTLEMENT COUNTS (kanban #1436, audit 8 R2; settlement.js #attestedPlan, stake-secret.js): those whose stake this seat
    // saw, and of the round's kind - a pool's plain picks, an order book's orders (§0A.7b, #1411). One lockless entry naming the outcome (or an
    // order, in a round that ended a pool) kept every real stake from coming back at once while the settlement - counting none of them - claimed
    // nothing and never turned ACCEPTED: every stake and fee waited for its lock's expiry
    const book = typeof this.isBook === 'function' && !!this.isBook(roundIdBytes);
    const counted = this.round.entriesOf(roundIdBytes)
      .filter(({ entryId }) => contract.stakeMsat === 0n || typeof this.round.stakeSeen !== 'function' || !!this.round.stakeSeen(entryId))
      .filter(({ entry }) => (entry.limitPrice !== undefined && entry.limitPrice !== null) === book);
    // A SCALAR MARKET (feature 8) HAS NO PICK THAT MISSES: every side is paid by where the value lies. It is refunded
    // only when one side had nobody (scalar.js scalarOneSided - the table's own rule, so it claims nothing either)
    if (isScalar(f.plugin.manifest)) {
      if (!fin.final) return { ok: false };
      let one;
      try { one = scalarOneSided(counted.map(({ entryId, entry }) => ({ entryId, stakeMsat: entry.stakeMsat, feeMsat: entry.feeMsat, donationMsat: entry.donationMsat, pick: entry.pick }))); }
      catch { return { ok: false }; }
      return one.refunded ? { ok: true, why: one.why } : { ok: false };
    }
    if (fin.final && !counted.some(({ entry }) => entry.pick === fin.outcome))
      return { ok: true, why: `nobody picked the outcome ${fin.outcome}: every stake comes back` };
    return { ok: false };
  }

  /**
   * ROUND ONE: this signer node's nonce commitment for the forfeit it would sign. A FRESH PAIR FOR EVERY ASK (kanban #1521): the doors answer
   * anyone, and one pair handed to every asker let a stranger ask for it and at once spend it on a list of made-up commitments, so the honest
   * asker's list was refused ("keeps no second pair") at every seat he reached first and the forfeit never formed. Now each ask draws its own pair,
   * kept by its commitment, and a share request spends only the pair its own list carries: a stranger spends the pair he was given and no other.
   * At most PAIRS_PER_FORFEIT are kept per forfeit.
   * A PAIR HANDED OUT RECENTLY IS NEVER DROPPED FOR A NEWER ONE (kanban #1611): the oldest went first past the cap, so a stranger at the open door who
   * sent 256 commits between an asker's commit and its share request dropped the asker's pair - its share and every peer's was refused ("that list does
   * not carry this signer node's own commitment") and the forfeit (a qualifier's stake, an ENTRY_VOID refund, a cancelled order's locks) never formed
   * while he went on. Now only a pair older than the asker's two rounds (commit and share, each within its bound; at least PAIR_HOLD_MIN_MS) is dropped; with the cap full of
   * younger ones a door commit is refused, and the pairs already handed out still sign. This seat's own pass (`own`, never from the door) is not refused.
   * A FULL POOL REFUSES NO COMMIT (kanban #1996, #2011, #2044): a stranger who kept the cap full of young pairs had every honest commit refused (503) and no
   * forfeit formed. nonce-pool.js makes room - spent and old pairs first, then one young unspent pair at random, never of the oldest quarter of its pool
   * (an asker's pair handed out before a flood) and never the seat's own (`own`, its own forfeit()).
   */
  // ...AND THE CAP IS EACH ASKER'S OWN, AND A PAIR IS SPENT ONLY BY ITS ASKER (kanban #2386, #2389; WinningsSend's #2308, #2322): one shared cap let a
  // stranger refill the door every holdMs and every peer's commit was refused (503); and a committee seat handed the asker's list re-posted it with
  // its own commitment swapped, the honest seats spent their pairs on it and refused the asker's. Now this seat's own pass, each seat of the round
  // that signs its ask (PLAN_ASK.FORFEIT_COMMIT) and the unsigned asks each have a bucket of PAIRS_PER_FORFEIT (asker-pairs.js), and a list spends
  // a pair only when the asker that drew it signs that list (PLAN_ASK.FORFEIT_SHARE); an unsigned-drawn pair only on an unsigned list, as before.
  async commit(roundIdBytes, entryIdBytes, kind = 'stake', { own = false, header = null, ask = null, at: askedAt = null } = {}) {
    const m = await this.message(roundIdBytes, entryIdBytes, kind);
    if (!m.ok) return m;
    const now = this.round.now ? this.round.now() : Date.now();
    const holdMs = Math.max(2 * (this.peerAskMs + this.peerGraceMs), PAIR_HOLD_MIN_MS);
    const who = commitAsker({ own, header, ask, at: askedAt, now, keptMs: holdMs,
      check: () => this.#askedBy(header, PLAN_ASK.FORFEIT_COMMIT, roundIdBytes, entryIdBytes, m, forfeitCommitAskBody({ kind, ask, at: askedAt })) });
    if (!who.ok) return who;
    const key = toHex(m.message);
    // a replayed signed ask gets the pair it drew (kanban #2386)
    const again = this.pairs.replayed(who.askKey);
    if (again) return { ok: true, commitment: again.commitment };
    // A FRESH PAIR FOR EVERY ASK (kanban #1521), a FROST pair or (protocol 27) a MuSig2 one alike, kept by its commitment
    let pair;
    if (m.named) {   // protocol 27 (2.0): a MuSig2 nonce of this seat's claim key
      const sk = signingSecret(this.round.identity.secret);
      const n = nonceGen({ sk, pk: evenYKey(m.claimKeys[m.me]), rand: this.random(32) });
      pair = { named: true, secnonce: n.secnonce, commitment: { id: m.me + 1, hiding: n.pubnonce.slice(0, 33), binding: n.pubnonce.slice(33) } };
    } else {
      const hiding = nonceGenerate340(this.random(32), m.signerNode.share);
      const binding = nonceGenerate340(this.random(32), m.signerNode.share);
      pair = { hiding, binding, commitment: { id: m.signerNode.id, hiding: this.curve.pointFromScalar(hiding), binding: this.curve.pointFromScalar(binding) } };
    }
    // each asker's own pool (kanban #2386, #2389), under the one pool rule (kanban #2011): no commit is refused for room
    const kept = this.pairs.add(key, pair, { own: who.asker === OWN, asker: who.asker, askKey: who.askKey });
    if (!kept.ok) return refuse(kept.why, kept.status);
    return { ok: true, commitment: pair.commitment };
  }

  /** This seat's own node key, hex, or null when it holds none (a test's stub store). */
  #ownKey() {
    const pk = this.round && this.round.pubkey;
    return this.round && this.round.identity && this.round.identity.secret && pk ? toHex(pk).toLowerCase() : null;
  }

  /** A SIGNED COMMIT OR SHARE ASK (kanban #2386, #2389): { ok, who } when a seat of the round (the forfeit's `m.nodes`) signed these bytes for this entry. */
  #askedBy(header, askKind, roundIdBytes, entryIdBytes, m, body) {
    let seats = Array.isArray(m.nodes) ? m.nodes : null;
    if (!seats) {
      const row = this.round.get(roundIdBytes);
      try { seats = row ? decodeRoundContract(new Uint8Array(row.contract)).nodes : []; } catch (e) { return { ok: false, why: `the round's contract does not decode: ${e.message}` }; }
    }
    return checkSendPlanAsk(header, { kind: askKind, roundId: roundIdBytes, lateEntryId: entryIdBytes, body, seats });
  }

  /** ROUND TWO: this signer node's signature share, over the forfeit it rebuilt, for ONE commitment list - by the pair that list carries (kanban #1521). */
  async share(roundIdBytes, entryIdBytes, commitments, kind = 'stake', { header = null, own: local = false } = {}) {
    const m = await this.message(roundIdBytes, entryIdBytes, kind);
    if (!m.ok) return m;
    if (!this.pairs.holds(toHex(m.message))) return refuse('this signer node committed to no forfeit of that lock');
    // NO LIST LONGER THAN A COMMITTEE (kanban #1672, as at /settle-share): refused before any curve work
    { const why = commitmentListRefusal(commitments, { needed: m.needed, nodes: m.nodes }); if (why) return refuse(why); }
    // THE PAIR THE LIST CARRIES (kanban #1521): of those this seat handed out, the one whose commitment is this seat's on the list
    const myId = m.named ? m.me + 1 : m.signerNode.id;
    const own = commitments.find((c) => String(c.id) === String(myId));
    const pair = own ? this.pairs.get(toHex(m.message), own) : null;
    if (!pair || !!pair.named !== !!m.named) return refuse('that list does not carry this signer node\'s own commitment');
    // ONLY THE ASKER THAT DREW THE PAIR SPENDS IT (kanban #2386, #2389): a list another asker - a peer seat included - posts spends nothing
    { const by = shareAsker({ own: local, header, check: () => this.#askedBy(header, PLAN_ASK.FORFEIT_SHARE, roundIdBytes, entryIdBytes, m, encodeCommitments(commitments)) });
      if (!by.ok) return by;
      const no = spendRefusal(pair, by.by); if (no) return no; }
    { const r = this.#returning(roundIdBytes, m, 'a forfeit share given'); if (!r.ok) return refuse(r.why); }
    if (m.named) return this.#shareNamed(m, pair, commitments);
    if (commitments.length < m.needed) return refuse(`${commitments.length} commitments, and this round's key signs at ${m.needed}`);
    const key = listKey(commitments);
    // a pair spent on another list answers its own status (kanban #1699, #1764): the asker tells a poisoned pair from a withheld share
    if (pair.list && pair.list !== key) return refuse('this signer node signed that forfeit over another list, and keeps no second pair', BOUND_ELSEWHERE);
    if (pair.share === null) {
      // A SPENT PAIR KEEPS ITS LIST AND ITS SHARE, NEVER ITS NONCES (kanban #1699)
      NoncePool.spend(pair, key, signShare340({ id: pair.commitment.id, share: m.signerNode.share, groupPublicKey: m.claimPk,
        nonces: { hiding: pair.hiding, binding: pair.binding }, message: m.message, commitments, curve: this.curve }));
    }
    return { ok: true, share: pair.share };
  }

  /**
   * ROUND TWO OF A NAMED FORFEIT (#1137): the list is exactly t seats, ascending and distinct, every one a seat of the round, this seat among them
   * with its own nonce; one partial per nonce, for one list - the secret nonce is gone once it signed, and another list gets nothing.
   */
  #shareNamed(m, pair, commitments) {
    if (!pair.named) return refuse('this signer node committed to no named forfeit of that lock');
    const signers = commitments.map((c) => Number(c.id) - 1);
    const form = checkSigners(m.claimKeys, m.threshold, signers);
    if (!form.ok) return refuse(`a forfeit's signer list: ${form.why}`);
    const key = listKey(commitments);
    if (pair.list && pair.list !== key) return refuse('this signer node signed that forfeit over another list, and keeps no second pair', BOUND_ELSEWHERE);
    if (pair.share === null) {
      let partial;
      try {
        partial = musigSign(pair.secnonce, signingSecret(this.round.identity.secret), namedContext(m.claimKeys, m.threshold, signers),
          nonceAgg(commitments.map(pubnonceOf)), m.message);
      } catch (e) { return refuse(`no partial signature: ${e.message}`); }
      pair.secnonce = null;
      pair.share = partialScalar(partial);
      pair.list = key;
    }
    return { ok: true, share: pair.share };
  }

  /** A combined forfeit handed over by a peer: kept only if it verifies over what THIS signer node rebuilt. */
  async take(roundIdBytes, entryIdBytes, body, kind = 'stake') {
    const m = await this.message(roundIdBytes, entryIdBytes, kind);
    if (!m.ok) return m;
    const got = decodeForfeitBody(body);
    if (!got) return refuse('a forfeit is a 64-byte signature, and a named one its signer indices after it', 400);
    if (m.named) {
      if (!got.signers) return refuse('an Arena lock\'s forfeit names its signers, and this one does not');
      const form = checkSigners(m.claimKeys, m.threshold, got.signers);
      if (!form.ok) return refuse(`that forfeit's signers: ${form.why}`);
      const agg = namedKey(m.claimKeys, m.threshold, got.signers);
      if (!verifies(got.signature, m.message, agg)) return refuse('that forfeit does not verify under the KeyAgg of the seats it names');
      { const r = this.#returning(roundIdBytes, m, 'a forfeit handed and kept'); if (!r.ok) return refuse(r.why); }
      this.round.putForfeit({ entryId: keptUnder(entryIdBytes, kind), roundId: roundIdBytes, message: m.message, signature: got.signature, claimPk: evenYKey(agg), signers: got.signers });
      return { ok: true };
    }
    if (got.signers) return refuse('a stock lock\'s forfeit is the round\'s FROST signature alone', 400);
    const signature = got.signature;
    if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1))) return refuse('that forfeit does not verify under the round\'s claim key');
    { const r = this.#returning(roundIdBytes, m, 'a forfeit handed and kept'); if (!r.ok) return refuse(r.why); }
    this.round.putForfeit({ entryId: keptUnder(entryIdBytes, kind), roundId: roundIdBytes, message: m.message, signature, claimPk: m.claimPk });
    return { ok: true };
  }

  /**
   * THE FORFEIT, asked by anyone: the one this signer node keeps, or - if it is due -
   * made now with its peers, checked under the claim key, kept, and handed to
   * them.
   */
  async forfeit(roundIdBytes, entryIdBytes, kind = 'stake') {
    const kept = this.round.forfeit(keptUnder(entryIdBytes, kind));
    if (kept) return { ok: true, ...kept, kept: true };
    const m = await this.message(roundIdBytes, entryIdBytes, kind);
    if (!m.ok) return m;
    // AN ENTRY_VOID LOCK: the evidence goes to the other signer nodes before they are
    // asked to sign, so a signer node that was down records the same Void on its own.
    if (this.onVoid && this.round.entryVoid && this.round.entryVoid(entryIdBytes)) {
      try { await this.onVoid(roundIdBytes, entryIdBytes); } catch { /* each signer node still signs only on its own record */ }
    }
    const q = `round=${toHex(roundIdBytes)}&entry=${toHex(entryIdBytes)}${kind === 'fee' ? '&lock=fee' : ''}`;
    let signature, named = null;
    // THE LISTS TRIED WHEN A LISTED SEAT SPENDS ITS PEERS' PAIRS (kanban #1699, #1764): every listed seat reads the whole list, and one of them
    // posted each other listed seat a list of junk around its real commitment before the asker's list landed - each honest pair was spent, the
    // asker's list refused at every seat, and so on every retry: one seat of seven held a 5-of-7 forfeit. A seat outside the list sees no
    // commitment but its own, so the asker leaves out first the seats that gave a share while the others' pairs were spent (who else read the
    // list?), and when that does not leave enough - or the culprit refused as well - tries the lists that leave out one seat, then two, ...
    this.lists.begin(q);
    for (;;) {
      const own = await this.commit(roundIdBytes, entryIdBytes, kind, { own: true });   // this seat's own pass is never refused at the cap (kanban #1611)
      if (!own.ok) return own;
      // THIS PASS'S ASK, SIGNED BY THIS SEAT'S NODE KEY (kanban #2386, #2389): each peer keeps the pair it draws for this seat in this seat's own bucket
      // (a seat with no node key - a test's stub store - asks unsigned, the same bytes as before)
      let headers = {};
      let cq = q;
      if (this.#ownKey()) {
        const ask = toHex(this.random(32)).slice(0, 32);
        const askedAt = Number(this.round.now ? this.round.now() : Date.now());
        headers = sendPlanAskHeaders(this.round, { kind: PLAN_ASK.FORFEIT_COMMIT, roundId: roundIdBytes, lateEntryId: entryIdBytes, body: forfeitCommitAskBody({ kind, ask, at: askedAt }) });
        cq = `${q}&ask=${ask}&at=${askedAt}`;
      }
      // EVERY PEER AT ONCE, WITHIN A BOUND (kanban #1074 as #1061): the list needs the threshold, so a hung seat costs the grace, not the forfeit
      const asked = await askPeers(this.peersFor(roundIdBytes), async (base, signal) => {
        const r = await this.fetcher(`${base}/forfeit-commit?${cq}`, { method: 'POST', headers, signal });
        // kanban #2084: read up to a commitment's size (and a refusal up to 4 KiB), never whatever the peer sends inside the bound
        if (!r.ok) return { why: (await peerWhyUpTo(r)).trim() };
        return { commitment: decodePeerCommitment(await peerBytesUpTo(r, COMMITMENT_BYTES)) };   // its nonces are points, or it is refused (kanban #2331, #2345)
      }, { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: m.needed - 1, counts: (x) => !!x.commitment });
      const signers = [{ base: null, commitment: own.commitment }];
      const refused = [];
      // A COMMITMENT UNDER ANOTHER SIGNER'S ID IS A REFUSAL (kanban #2402, #2471, as settlement.js #peerCommitments); one under an id a peer already
      // holds is listed beside it (`contest`): #gatherShares keeps one, and the share check - not the order of the answers - tells which one stands
      for (const { peer: base, value, error } of leftOffLast(asked, this.lists.withheld.get(q))) {
        const bad = value && value.commitment ? peerCommitmentRefusal(value.commitment, signers, { contest: true }) : null;
        if (value && value.commitment && !bad) signers.push({ base, commitment: value.commitment });
        else refused.push(`${base}: ${bad || (value ? value.why : error.message)}`);
      }
      if (committedIds(signers) < m.needed)
        return refuse(`${committedIds(signers)} of the ${m.needed} signer nodes the forfeit needs committed to it: ${refused.join('; ')}`);
      const listed = this.lists.listed(q, signers, m.needed);
      // A NAMED FORFEIT: S is the t lowest seats that committed and are not left out (#1135 3), the asker itself or not
      const set = m.named ? listed.slice().sort((a, b) => a.commitment.id - b.commitment.id).slice(0, m.needed) : listed;
      const combined = await this.#gatherShares(roundIdBytes, entryIdBytes, kind, m, q, set);
      if (combined.ok) { ({ signature } = combined); named = combined.signers || null; this.lists.done(q); break; }
      // A SEAT THAT GAVE NO SHARE, OR ONE THAT DOES NOT STAND, is left off the next list while the threshold remains; a poisoned list
      // tries the lists that leave out who read it (nonce-pool.js SignerLists, kanban #1699, #1764): asked again at once
      if (!this.lists.again(q, combined, listed, m.needed, this.peersFor(roundIdBytes))) return combined;
    }
    const claimPk = named ? evenYKey(namedKey(m.claimKeys, m.threshold, named)) : m.claimPk;
    { const r = this.#returning(roundIdBytes, m, 'a forfeit combined and kept'); if (!r.ok) return refuse(r.why); }
    this.round.putForfeit({ entryId: keptUnder(entryIdBytes, kind), roundId: roundIdBytes, message: m.message, signature, claimPk, ...(named ? { signers: named } : {}) });
    // HANDED TO EVERY PEER, a slow one left off the list too: it keeps it only if it verifies over what it rebuilt. One that misses it asks again.
    const handed = named ? encodeNamedForfeit(signature, named) : signature;
    await askPeers(this.peersFor(roundIdBytes), (base, signal) => this.fetcher(`${base}/forfeit-signature?${q}`, { method: 'POST', body: handed, signal }),
      { boundMs: this.peerAskMs, graceMs: this.peerGraceMs, enough: m.needed - 1 });
    return { ok: true, message: m.message, signature, claimPk, ...(named ? { signers: named } : {}) };
  }

  /**
   * ROUND TWO, AND THE COMBINED FORFEIT: every seat on the list gives its share over it, all asked at once within the bound. Answers { ok, signature }, or a
   * refusal with `withheld` the seats at fault: those that gave none, or by their public shares those whose share does not stand.
   */
  async #gatherShares(roundIdBytes, entryIdBytes, kind, m, q, signers) {
    // EACH PEER UNDER ITS OWN ID (kanban #1807), checked before any share is asked; and a list that still throws is a refusal, never an abort
    const misnamed = misnamedSigners(signers, m.nodes);
    if (misnamed.out.length) return { ...refuse(`${misnamed.out[0]} committed under an id that is not its own on this list`), withheld: misnamed.out };
    // ONE DOOR PER ID ON THIS LIST (kanban #2247, #2260): the others naming it are set aside for this pass; a kept one whose share does not stand is left out
    const list = misnamed.aside.length ? signers.filter((s) => !misnamed.aside.includes(s.base)) : signers;
    let got;
    try { got = await this.#gatherChecked(roundIdBytes, entryIdBytes, kind, m, q, list); }
    catch (e) { got = { ...refuse(`the forfeit list could not be signed: ${e.message}`, 500), withheld: [] }; }
    // NO PUBLIC SHARE TOLD THEM APART: the kept claimant goes off the next list, so the one set aside is tried alone
    if (!got.ok && misnamed.kept.length && !(got.withheld && got.withheld.length)) got = { ...got, withheld: misnamed.kept };
    return got;
  }

  async #gatherChecked(roundIdBytes, entryIdBytes, kind, m, q, signers) {
    const commitments = signers.map((s) => s.commitment).sort((a, b) => a.id - b.id);
    const inList = signers.some((s) => s.base === null);
    const mine = inList ? await this.share(roundIdBytes, entryIdBytes, commitments, kind, { own: true }) : null;
    if (mine && !mine.ok) return mine;
    const body = encodeCommitments(commitments);
    // SIGNED BY THIS SEAT (kanban #2386, #2389): the list spends only the pairs this seat's own commit asks drew
    const headers = sendPlanAskHeaders(this.round, { kind: PLAN_ASK.FORFEIT_SHARE, roundId: roundIdBytes, lateEntryId: entryIdBytes, body });
    const peers = signers.filter((s) => s.base !== null);
    const asked = await askPeers(peers.map((s) => s.base), async (base, signal) => {
      const r = await this.fetcher(`${base}/forfeit-share?${q}`, { method: 'POST', body, headers, signal });
      if (!r.ok) return { status: r.status, why: (await peerWhyUpTo(r)).trim() };   // kanban #2084: capped as the commit's
      return { share: decodeShare(await peerBytesUpTo(r, SHARE_BYTES)) };
    }, { boundMs: this.peerAskMs });
    // A PAIR SPENT ON ANOTHER LIST (kanban #1699, #1764): a pair drawn for this ask, so one who read this list spent it - the seat refusing is not at fault
    const failed = sharesRefused(asked);
    if (failed) return failed;
    if (m.named) {
      // each partial in the list's order, checked against its seat's public nonce: a bad one names its seat (named-claim.js aggregateNamed)
      const bySeat = new Map(asked.map((x, i) => [peers[i].commitment.id, x.value.share]));
      const own = signers.find((s) => s.base === null);
      if (own) bySeat.set(own.commitment.id, mine.share);
      const named = commitments.map((c) => Number(c.id) - 1);
      const agg = aggregateNamed({ claimKeys: m.claimKeys, threshold: m.threshold, signers: named, message: m.message,
        pubnonces: commitments.map(pubnonceOf), partials: commitments.map((c) => partialBytes(bySeat.get(c.id))) });
      if (agg.ok) return { ok: true, signature: agg.signature, signers: named };
      const badIds = new Set(agg.bad.map((i) => commitments[i].id));
      return { ...refuse(`the combined forfeit does not verify: ${agg.why}`, 500), withheld: peers.filter((s) => badIds.has(s.commitment.id)).map((s) => s.base) };
    }
    const shares = [mine.share, ...asked.map((x) => x.value.share)];
    const { signature } = aggregate340({ commitments, message: m.message, groupPublicKey: m.claimPk, shares, curve: this.curve });
    if (schnorr.verify(signature, m.message, m.claimPk.subarray(1))) return { ok: true, signature };
    const held = this.dkg && this.dkg.publicSharesFor ? this.dkg.publicSharesFor(m.nodes) : null;
    const spoilt = spoiltShares({ signers: peers, shares: asked.map((x) => x.value.share), held, m, commitments, curve: this.curve });
    return { ...refuse('the combined forfeit does not verify under the round\'s claim key', 500), withheld: spoilt.map((s) => s.base) };
  }
}

export { encodeCommitments, encodeShare };
