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
// THE NONCES LIVE IN MEMORY, ONE PAIR PER MESSAGE, and a pair signs ONE
// commitment list: the same nonce over two lists is two signatures over two
// messages, which publishes the share. A second asker with the same list gets
// the same share back; with another list, nothing.
import { outcomeFinality } from '../../arena-protocol/src/attested.js';
import { heldOutcomes, marketVoidOf } from './game-market.js';
import { isScalar } from '../../arena-protocol/src/manifest.js';
import { scalarOneSided } from '../../arena-protocol/src/scalar.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { decodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { isQualifier, FORFEIT as FORFEIT_OUTCOME } from '../../arena-protocol/src/payout.js';
import { signShare340, aggregate340, nonceGenerate340 } from '../../arena-protocol/src/frost-bip340.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { lockFieldsFromJson } from '../../arena-protocol/src/stake-lock.js';
import { FINAL, SUSPENDED, PROVISIONALLY_FINAL } from '../../arena-protocol/src/objection.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { resultFinality } from './finality.js';
import { stateOf } from './settlement-state.js';
import { pluginForRound } from './plugins.js';
import { encodeCommitments, decodeCommitments, encodeShare, decodeShare } from './pool-wire.js';

// A FEE LOCK'S RETURN (2026-10-09: "orders can be cancelled at no cost"): kept under its own key beside
// the stake lock's, so an entry's two returns never stand in each other's place
const FEE_RETURN_TAG = new TextEncoder().encode('arena fee lock return v1');
export const feeReturnKey = (entryIdBytes) => { const m = new Uint8Array(FEE_RETURN_TAG.length + 32); m.set(FEE_RETURN_TAG); m.set(entryIdBytes, FEE_RETURN_TAG.length); return sha256(m); };
const keptUnder = (entryIdBytes, kind) => (kind === 'fee' ? feeReturnKey(entryIdBytes) : entryIdBytes);

const listKey = (commitments) => commitments.map((c) => `${c.id}:${toHex(c.hiding)}:${toHex(c.binding)}`).sort().join('|');
const refuse = (why, status = 409) => ({ ok: false, status, why });

export class Forfeit {
  /**
   * `dkg` holds this signer node's share of the round's claim key; `port` is the
   * federation (it hashes a contract the way the guardians do); `peersFor(rid)`
   * names the other settlement signer nodes' bases.
   */
  constructor(round, { dkg, port, curve, random, peersFor = () => [], fetcher = (u, o) => fetch(u, o), onVoid = null, pullProof = null, refusedNow = null, bookStanding = null } = {}) {
    this.round = round;
    // AN ORDER OF AN ORDER BOOK (comment 1127): the book's word on it - filled, cancelled, in a batch not decided
    this.bookStanding = bookStanding;
    // §23.2 REFUSED: rid -> why this node refuses the round, or null while it offers it
    this.refusedNow = refusedNow;
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
    this.pairs = new Map();          // contract id hex -> { hiding, binding, commitment, list, share }
  }

  /** WHAT THIS SIGNER NODE WILL SIGN, rebuilt from its own store - or the refusal. */
  // `kind`: 'stake' (the stake lock, as always) or 'fee' - a market order's fee lock, returned at once only when the order was
  // cancelled before its round's entry close or the market is refunded (VOID, nobody right); otherwise it is claimed at
  // resolution or expires back to its player
  async message(roundIdBytes, entryIdBytes, kind = 'stake') {
    const row = this.round.get(roundIdBytes);
    if (!row) return refuse('this node holds no such round', 404);
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    // AN ORDER OF AN ORDER BOOK: its own rules (comment 1127)
    { const book = this.bookStanding ? this.bookStanding(roundIdBytes, entryIdBytes) : null;
      if (book && book.book) return this.#bookReturn(roundIdBytes, entryIdBytes, contract, kind, book); }
    // A CANCELLED MARKET ORDER: signed by its player before entry close, out of the round's table at this seat
    const cancelled = !!(this.round.cancelled && this.round.cancelled(entryIdBytes));
    if (kind === 'fee') {
      const fl = this.round.feeLock ? this.round.feeLock(entryIdBytes) : null;
      if (!fl) return refuse('this signer node verified no fee lock for that entry, so it returns none');
      if (!cancelled && !this.#marketRefund(roundIdBytes, contract).ok)
        return refuse('a fee lock comes back at once only for a cancelled order or a refunded market: this one is claimed at resolution, or expires back to its player');
      return this.#signable(contract, fl);
    }
    let lock = this.round.stakeLock(entryIdBytes);
    // §23.2 REFUSED (2026-10-06 08:57: "A round the seats refuse gets an immediate refund"): no entry,
    // but a lock this node kept for a round it refuses, under its handout's id (POST /refused-lock) - returned at once, on
    // this node's own record that it still refuses the round and that the lock stakes no entry here. No result, no window.
    let refused = null;
    if (!lock && this.round.refusedLock) {
      const kept = this.round.refusedLock(entryIdBytes);
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
      if (standing.state === 'VOID')
        return refuse('that entry is VOID (§13C): nothing is forfeited - nobody acts, and the lock returns to the player at its expiry');
      if (standing.state !== FINAL)
        return refuse(`no forfeit before the result is final with its objection window closed: ${standing.why || standing.state}`);
      const mine = this.round.results(roundIdBytes, entryIdBytes).find((r) => toHex(r.nodePubkey) === toHex(this.round.pubkey));
      if (!mine) return refuse('this signer node signed no result for that run, so it forfeits nothing');
      const result = decodePlayerResult(splitSignedResult(mine.bytes).body);
      if (!isQualifier(result, contract.minScore)) {
        const back = this.nobodyWonReturn(roundIdBytes, entryIdBytes, lock, result);
        if (!back.ok)
          return refuse(`that run is ${result.outcome} with score ${result.score} and this round's minimum is `
            + `${contract.minScore}: not a qualifier, so its stake lock is not forfeited (${back.why})`);
      }
    }
    return this.#signable(contract, lock);
  }

  /** Where the round's settlement stands at this signer node - in one federation or, for a round that takes any, in all (round.js). */
  #settled(roundIdBytes) { return stateOf(this.round, roundIdBytes); }

  /** The lock's contract id, rebuilt from this signer node's own record, under the round's claim key - what it signs. */
  async #signable(contract, lock) {
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
    return { ok: true, message: fromHex(id), claimPk, signerNode: held.signerNode, needed: receiptsNeeded(contract.gameVerifySlots) };
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
    if (this.#marketRefund(roundIdBytes, contract).ok) return this.#signable(contract, lock);
    if (book.inPending) return refuse('that order is in a batch not decided yet: its locks wait for it');
    if (book.filled) return refuse('that order filled: its locks are claimed at resolution and its unfilled rest paid back there');
    if (book.cancelled) return this.#signable(contract, lock);
    const held = heldOutcomes(this.round, roundIdBytes);
    const fin = outcomeFinality(held, { windowMs: contract.objectionWindowMs, nowMs: this.round.now ? this.round.now() : Date.now() });
    if (fin.final) return this.#signable(contract, lock);
    return refuse('that order stands unfilled: cancel it (at no cost) or wait for the market to resolve');
  }

  /** Whether a market round is refunded on this signer node's record: VOID (deadline, contradiction), or nobody picked right. */
  #marketRefund(roundIdBytes, contract) {
    const f = pluginForRound(contract, this.round.plugins);
    if (!f.ok || !f.attested) return { ok: false };
    // every standing outcome: the attestations and a market on a game's held source result (feature 6)
    const held = heldOutcomes(this.round, roundIdBytes);
    const nowMs = this.round.now ? this.round.now() : Date.now();
    // a template's round is VOID by its own resolution time's deadline (feature 5: roundTermsOf); a market on a game
    // AT ONCE when its source result refunds it or its source can never fit it (feature 6: game-market.js marketVoidOf)
    const voided = marketVoidOf(this.round, roundIdBytes, { contract, manifest: f.plugin.manifest, held, nowMs });
    if (voided.voided) return { ok: true, why: voided.why };
    const fin = outcomeFinality(held, { windowMs: contract.objectionWindowMs, nowMs });
    // A SCALAR MARKET (feature 8) HAS NO PICK THAT MISSES: every side is paid by where the value lies. It is refunded
    // only when one side had nobody (scalar.js scalarOneSided - the table's own rule, so it claims nothing either)
    if (isScalar(f.plugin.manifest)) {
      if (!fin.final) return { ok: false };
      let one;
      try { one = scalarOneSided(this.round.entriesOf(roundIdBytes).map(({ entryId, entry }) => ({ entryId, stakeMsat: entry.stakeMsat, feeMsat: entry.feeMsat, donationMsat: entry.donationMsat, pick: entry.pick }))); }
      catch { return { ok: false }; }
      return one.refunded ? { ok: true, why: one.why } : { ok: false };
    }
    if (fin.final && !this.round.entriesOf(roundIdBytes).some(({ entry }) => entry.pick === fin.outcome))
      return { ok: true, why: `nobody picked the outcome ${fin.outcome}: every stake comes back` };
    return { ok: false };
  }

  /** ROUND ONE: this signer node's nonce commitment for the forfeit it would sign. */
  async commit(roundIdBytes, entryIdBytes, kind = 'stake') {
    const m = await this.message(roundIdBytes, entryIdBytes, kind);
    if (!m.ok) return m;
    const key = toHex(m.message);
    let pair = this.pairs.get(key);
    if (!pair) {
      const hiding = nonceGenerate340(this.random(32), m.signerNode.share);
      const binding = nonceGenerate340(this.random(32), m.signerNode.share);
      pair = { hiding, binding, list: null, share: null,
        commitment: { id: m.signerNode.id, hiding: this.curve.pointFromScalar(hiding), binding: this.curve.pointFromScalar(binding) } };
      this.pairs.set(key, pair);
    }
    return { ok: true, commitment: pair.commitment };
  }

  /** ROUND TWO: this signer node's signature share, over the forfeit it rebuilt, for ONE commitment list. */
  async share(roundIdBytes, entryIdBytes, commitments, kind = 'stake') {
    const m = await this.message(roundIdBytes, entryIdBytes, kind);
    if (!m.ok) return m;
    const pair = this.pairs.get(toHex(m.message));
    if (!pair) return refuse('this signer node committed to no forfeit of that lock');
    const own = commitments.find((c) => String(c.id) === String(pair.commitment.id));
    if (!own || toHex(own.hiding) !== toHex(pair.commitment.hiding) || toHex(own.binding) !== toHex(pair.commitment.binding))
      return refuse('that list does not carry this signer node\'s own commitment');
    if (commitments.length < m.needed) return refuse(`${commitments.length} commitments, and this round's key signs at ${m.needed}`);
    const key = listKey(commitments);
    if (pair.list && pair.list !== key) return refuse('this signer node signed that forfeit over another list, and keeps no second pair');
    if (pair.share === null) {
      pair.share = signShare340({ id: pair.commitment.id, share: m.signerNode.share, groupPublicKey: m.claimPk,
        nonces: { hiding: pair.hiding, binding: pair.binding }, message: m.message, commitments, curve: this.curve });
      pair.list = key;
    }
    return { ok: true, share: pair.share };
  }

  /** A combined forfeit handed over by a peer: kept only if it verifies over what THIS signer node rebuilt. */
  async take(roundIdBytes, entryIdBytes, signature, kind = 'stake') {
    const m = await this.message(roundIdBytes, entryIdBytes, kind);
    if (!m.ok) return m;
    if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1))) return refuse('that forfeit does not verify under the round\'s claim key');
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
    const own = await this.commit(roundIdBytes, entryIdBytes, kind);
    if (!own.ok) return own;
    const signers = [{ base: null, commitment: own.commitment }];
    const refused = [];
    for (const base of this.peersFor(roundIdBytes)) {
      try {
        const r = await this.fetcher(`${base}/forfeit-commit?${q}`, { method: 'POST' });
        if (!r.ok) { refused.push(`${base}: ${(await r.text()).trim()}`); continue; }
        signers.push({ base, commitment: decodeCommitments(new Uint8Array(await r.arrayBuffer()))[0] });
      } catch (e) { refused.push(`${base}: ${e.message}`); }
    }
    if (signers.length < m.needed)
      return refuse(`${signers.length} of the ${m.needed} signer nodes the forfeit needs committed to it: ${refused.join('; ')}`);
    const commitments = signers.map((s) => s.commitment).sort((a, b) => a.id - b.id);
    const shares = [];
    for (const s of signers) {
      if (s.base === null) {
        const mine = await this.share(roundIdBytes, entryIdBytes, commitments, kind);
        if (!mine.ok) return mine;
        shares.push(mine.share);
        continue;
      }
      const r = await this.fetcher(`${s.base}/forfeit-share?${q}`, { method: 'POST', body: encodeCommitments(commitments) });
      if (!r.ok) return refuse(`${s.base} gave no share: ${(await r.text()).trim()}`);
      shares.push(decodeShare(new Uint8Array(await r.arrayBuffer())));
    }
    const { signature } = aggregate340({ commitments, message: m.message, groupPublicKey: m.claimPk, shares, curve: this.curve });
    if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1)))
      return refuse('the combined forfeit does not verify under the round\'s claim key', 500);
    this.round.putForfeit({ entryId: keptUnder(entryIdBytes, kind), roundId: roundIdBytes, message: m.message, signature, claimPk: m.claimPk });
    for (const s of signers) {
      if (s.base === null) continue;
      try { await this.fetcher(`${s.base}/forfeit-signature?${q}`, { method: 'POST', body: signature }); } catch { /* it asks again */ }
    }
    return { ok: true, message: m.message, signature, claimPk: m.claimPk };
  }
}

export { encodeCommitments, encodeShare };
