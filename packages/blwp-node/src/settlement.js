// THE SEATS' ONE SETTLEMENT OF A LOCK ROUND (W4; FEDERATION.md money flow step
// 5). the owner 2026-09-14 07:22: "a loser loses the stake. The lock is claimed into
// the pool. Winners are paid from that."
//
// "Each seat then rebuilds one settlement transaction from the public payout
// table. Inputs: every loser's stake lock (`Claim(P)`) ... Outputs: one payout
// contract per qualifier (a pre-expired lock, `refund_pk` = the qualifier's
// key). A seat signs only the txid it rebuilt itself; one FROST signing covers
// every input."
//
// FROM THIS SEAT'S OWN RECORD, as the forfeit is: its own signed result for every
// entry, its own no-quorum and ENTRY_VOID records, its own finality - nothing
// waiting inside its window, nothing suspended - and the locks IT verified. The
// decision is protocol's `lockSettlement` (the hold path's own verdict over one
// payout table). Each loser's P is opened by the seats' share conversation and
// must be the scalar of the point that loser's lock names. The transaction is
// rebuilt by the stock client (blwp-stake-lock --mode settle, dry), and the seat
// signs only the 32 bytes it got back.
//
// FEES ARE NOT IN IT. The fee locks' claim hash and §22A's node slots are not
// decided (FEDERATION.md F5); the fee lock expires back to its player as before.
import { schnorr } from '@noble/curves/secp256k1.js';

import { decodeRoundContract } from '../../protocol/src/contracts.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { lockSettlement } from '../../protocol/src/lock-settlement.js';
import { FORFEIT, VOID, ENTRY_VOID } from '../../protocol/src/payout.js';
import { signShare340, aggregate340, nonceGenerate340 } from '../../protocol/src/frost-bip340.js';
import { receiptsNeeded } from '../../protocol/src/threshold.js';
import { lockFieldsFromJson } from '../../protocol/src/stake-lock.js';
import { scalarFrom32, FIELD } from '../../protocol/src/shares.js';
import { FINAL } from '../../protocol/src/objection.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';
import { resultFinality } from './finality.js';
import { encodeCommitments, decodeCommitments, encodeShare, decodeShare } from './pool-wire.js';

const listKey = (commitments) => commitments.map((c) => `${c.id}:${toHex(c.hiding)}:${toHex(c.binding)}`).sort().join('|');
const refuse = (why, status = 409) => ({ ok: false, status, why });
const outpointOf = (s) => { const [txid, idx] = String(s).split(':'); return { txid: fromHex(txid), outIdx: BigInt(idx) }; };

export const SUBMITTING = 'SUBMITTING';
export const ACCEPTED = 'ACCEPTED';
export const REFUSED = 'REFUSED';

/** Whether a round's stake is a federation stake lock (and so settled here). */
export const locksStake = (contract) => contract.custody === 'FEDERATION'
  && contract.federationId instanceof Uint8Array && contract.federationId.some((b) => b !== 0) && contract.stakeMsat > 0n;

export class LockSettlement {
  /**
   * `dkg` holds this seat's share of the round's claim key; `port` is the
   * federation (blwp-stake-lock); `preimages` opens a loser's P with the other
   * seats; `peersFor(rid)` names the other settlement seats' bases.
   */
  constructor(round, { dkg, port, curve, random, preimages, peersFor = () => [], fetcher = (u, o) => fetch(u, o),
    seatsFor = (rid, contract) => ({ gameVerify: contract.nodes, settlement: contract.nodes }) } = {}) {
    this.round = round;
    // THE ROUND'S SITTING SEATS BY POOL (Pick A): who the fee locks pay, §22A's weights.
    this.seatsFor = seatsFor;
    this.dkg = dkg;
    this.port = port;
    this.curve = curve;
    this.random = random;
    this.preimages = preimages;
    this.peersFor = peersFor;
    this.fetcher = fetcher;
    this.built = new Map();          // round id hex -> the settlement this seat rebuilt
    this.pairs = new Map();          // round id hex -> { hiding, binding, commitment, list, share }
    this.fees = new Map();           // round id hex -> the guardians' fee rule, read once
  }

  /** EVERY ENTRY OF THE ROUND, AS THIS SEAT HOLDS IT - or why the round still waits. */
  entriesOnRecord(roundIdBytes, contract) {
    const entries = [];
    for (const { entryId, entry } of this.round.entriesOf(roundIdBytes)) {
      // A STAKE THIS SEAT NEVER SAW COMMITTED IS NOT IN THE ROUND (§23.1 step 5: play begins
      // only after it). With pick (a), a round whose gate mints counts a stake only with its
      // fee lock, so an entry that brought none never reaches this set.
      if (this.round.stakeSeen && !this.round.stakeSeen(entryId)) continue;
      const base = { entryId, pubkey: entry.playerPubkey, stakeMsat: entry.stakeMsat, feeMsat: entry.feeMsat, donationMsat: entry.donationMsat,
        feePreimage: entry.feePreimage };
      if (this.round.entryVoid && this.round.entryVoid(entryId)) { entries.push({ ...base, outcome: ENTRY_VOID, score: 0 }); continue; }
      const nq = this.round.noQuorum ? this.round.noQuorum(entryId) : null;
      if (nq && nq.outcome === FORFEIT) { entries.push({ ...base, outcome: FORFEIT, score: 0 }); continue; }
      if (nq && nq.outcome === VOID) { entries.push({ ...base, outcome: VOID, score: 0 }); continue; }
      const standing = resultFinality(this.round, roundIdBytes, entryId);
      if (standing.state === VOID) { entries.push({ ...base, outcome: VOID, score: 0 }); continue; }
      if (standing.state !== FINAL)
        return refuse(`nothing is claimed while a run is not final with its window closed: ${toHex(entryId).slice(0, 16)} is `
          + `${standing.state || 'without a result'}${standing.why ? ` (${standing.why})` : ''}`);
      const mine = this.round.results(roundIdBytes, entryId).find((r) => toHex(r.nodePubkey) === toHex(this.round.pubkey));
      if (!mine) return refuse(`this seat signed no result for ${toHex(entryId).slice(0, 16)}, so it settles nothing`);
      const r = decodePlayerResult(splitSignedResult(mine.bytes).body);
      entries.push({ ...base, outcome: r.outcome, score: r.score });
    }
    void contract;
    return { ok: true, entries };
  }

  /** WHAT THIS SEAT WILL SIGN, rebuilt from its own store and the stock client - or the refusal. */
  async message(roundIdBytes) {
    const key = toHex(roundIdBytes);
    const kept = this.built.get(key);
    if (kept) return kept;
    const row = this.round.get(roundIdBytes);
    if (!row) return refuse('this node holds no such round', 404);
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    if (!locksStake(contract)) return refuse('that round\'s stake is not a federation lock, so there is no lock to claim');
    if (!this.port || typeof this.port.settle !== 'function') return refuse('this seat reaches no federation, so it settles nothing');
    const held = this.dkg.seatFor(contract.nodes);
    if (!held.ok) return refuse(`this seat holds no share of the round's claim key: ${held.why}`);
    const claimPk = held.pool.groupPublicKey;

    const on = this.entriesOnRecord(roundIdBytes, contract);
    if (!on.ok) return on;
    const locks = new Map();
    const lockEntry = new Map();
    for (const e of on.entries) {
      const lock = this.round.stakeLock(e.entryId);
      if (!lock) continue;
      const fields = lockFieldsFromJson(lock.fields);
      if (toHex(fields.claimPk) !== toHex(claimPk)) return refuse('a lock of this round names another claim key than the round\'s');
      locks.set(toHex(e.pubkey), { outpoint: outpointOf(lock.outpoint), amountMsat: fields.amountMsat, refundPk: fields.refundPk, fields });
      lockEntry.set(toHex(e.pubkey), e.entryId);
    }
    // AND EVERY FEE LOCK THIS SEAT VERIFIED (Pick A), with the F its entry hands over.
    const feeLocks = new Map();
    for (const e of on.entries) {
      const fl = this.round.feeLock ? this.round.feeLock(e.entryId) : null;
      if (!fl) continue;
      const fields = lockFieldsFromJson(fl.fields);
      if (toHex(fields.claimPk) !== toHex(claimPk)) return refuse('a fee lock of this round names another claim key than the round\'s');
      feeLocks.set(toHex(e.pubkey), { outpoint: outpointOf(fl.outpoint), amountMsat: fields.amountMsat, preimage: e.feePreimage });
    }
    let fees = this.fees.get(key);
    if (!fees) { fees = await this.port.fees(); this.fees.set(key, fees); }
    const plan = lockSettlement({ roundId: roundIdBytes, entries: on.entries, minScore: contract.minScore, locks, fees,
      feeLocks, seats: feeLocks.size ? this.seatsFor(roundIdBytes, contract) : null, contract });
    if (!plan.ok) return refuse(`no lock is claimed: ${plan.why}`);
    if (plan.nothing) return refuse(`no lock is claimed: ${plan.why}`);

    // EACH LOSER'S P, OPENED WITH THE OTHER SEATS, AND IT HAS TO OPEN THAT LOCK:
    // a stake lock's image is the stake point, so P is its scalar. A fee claim
    // carries its F already - the entry handed it over openly (F5).
    const claims = [];
    for (const c of plan.claims) {
      if (c.kind === 'fee') { claims.push(c); continue; }
      const entryId = lockEntry.get(toHex(c.pubkey));
      const got = await this.preimages.open({ roundId: roundIdBytes, entryId, needed: receiptsNeeded(contract.nodes.length) });
      if (!got.ok) return refuse(`a loser's P could not be opened: ${got.why}`);
      const lock = locks.get(toHex(c.pubkey));
      if (lock.fields.paymentImage.kind === 'point') {
        const point = this.curve.pointFromScalar(scalarFrom32(got.preimage) % FIELD);
        if (toHex(point) !== toHex(lock.fields.paymentImage.bytes))
          return refuse('the P the seats opened is not the scalar of the point that loser\'s lock names');
      }
      claims.push({ ...c, preimage: got.preimage });
    }
    const tx = await this.port.settle({ claimPk, claims, payouts: plan.payouts, nonce: plan.nonce });
    const built = { ok: true, message: fromHex(tx.message), txid: tx.txid, plan, claims, claimPk,
      seat: held.seat, needed: receiptsNeeded(contract.nodes.length) };
    this.built.set(key, built);
    return built;
  }

  /**
   * WHAT THE SEATS' SETTLEMENT MOVES, AS THIS SEAT BUILT IT - for a reader (GET
   * /lock-settlement): every input with its kind and msat, every payout with its
   * kind, key, msat and the federation's fee on it, the input fees, the txid. Null
   * until this seat has built it.
   */
  summary(roundIdBytes) {
    const m = this.built.get(toHex(roundIdBytes));
    if (!m || !m.ok) return null;
    const p = m.plan;
    return {
      txid: m.txid,
      claims: p.claims.map((c) => ({ kind: c.kind || 'stake', msat: String(c.amountMsat) })),
      payouts: p.payouts.map((x) => ({ kind: x.kind || 'qualifier', pk: toHex(x.payoutPk), msat: String(x.msat), feeMsat: String(x.feeMsat) })),
      poolMsat: String(p.poolMsat), inputFeesMsat: String(p.inputFeesMsat), paidMsat: String(p.paidMsat),
      feePoolMsat: String(p.feePoolMsat || 0n), feeInputFeesMsat: String(p.feeInputFeesMsat || 0n), feePaidMsat: String(p.feePaidMsat || 0n),
      feeHole: p.feeHole ? p.feeHole.why : null,
    };
  }

  /** ROUND ONE: this seat's nonce commitment for the settlement it would sign. */
  async commit(roundIdBytes) {
    const m = await this.message(roundIdBytes);
    if (!m.ok) return m;
    const key = toHex(roundIdBytes);
    let pair = this.pairs.get(key);
    if (!pair || toHex(pair.message) !== toHex(m.message)) {
      const hiding = nonceGenerate340(this.random(32), m.seat.share);
      const binding = nonceGenerate340(this.random(32), m.seat.share);
      pair = { message: m.message, hiding, binding, list: null, share: null,
        commitment: { id: m.seat.id, hiding: this.curve.pointFromScalar(hiding), binding: this.curve.pointFromScalar(binding) } };
      this.pairs.set(key, pair);
    }
    return { ok: true, commitment: pair.commitment };
  }

  /** ROUND TWO: this seat's signature share over the txid it rebuilt, for ONE commitment list. */
  async share(roundIdBytes, commitments) {
    const m = await this.message(roundIdBytes);
    if (!m.ok) return m;
    const pair = this.pairs.get(toHex(roundIdBytes));
    if (!pair || toHex(pair.message) !== toHex(m.message)) return refuse('this seat committed to no settlement of that round');
    const own = commitments.find((c) => String(c.id) === String(pair.commitment.id));
    if (!own || toHex(own.hiding) !== toHex(pair.commitment.hiding) || toHex(own.binding) !== toHex(pair.commitment.binding))
      return refuse('that list does not carry this seat\'s own commitment');
    if (commitments.length < m.needed) return refuse(`${commitments.length} commitments, and this round's key signs at ${m.needed}`);
    const key = listKey(commitments);
    if (pair.list && pair.list !== key) return refuse('this seat signed that settlement over another list, and keeps no second pair');
    if (pair.share === null) {
      pair.share = signShare340({ id: pair.commitment.id, share: m.seat.share, groupPublicKey: m.claimPk,
        nonces: { hiding: pair.hiding, binding: pair.binding }, message: m.message, commitments, curve: this.curve });
      pair.list = key;
    }
    return { ok: true, share: pair.share };
  }

  /** A combined signature handed over by a peer: kept only if it verifies over what THIS seat rebuilt. */
  async take(roundIdBytes, signature) {
    const m = await this.message(roundIdBytes);
    if (!m.ok) return m;
    if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1))) return refuse('that settlement signature does not verify under the round\'s claim key');
    if (!this.round.lockSettlement(roundIdBytes))
      this.round.putLockSettlement({ roundId: roundIdBytes, txid: m.txid, message: m.message, signature, state: SUBMITTING,
        why: 'signed by the seats; submitted by the seat that combined it' });
    return { ok: true };
  }

  /**
   * THE SETTLEMENT, made now with the other seats if this seat holds none: the
   * combined signature checked under the claim key, the intent written, the
   * transaction submitted, and the guardians' answer kept.
   */
  async settle(roundIdBytes) {
    const kept = this.round.lockSettlement(roundIdBytes);
    if (kept && kept.state === ACCEPTED) return { ok: true, kept: true, ...kept };
    const m = await this.message(roundIdBytes);
    if (!m.ok) return m;
    let signature = kept && kept.signature;
    if (!signature) {
      const q = `round=${toHex(roundIdBytes)}`;
      const own = await this.commit(roundIdBytes);
      if (!own.ok) return own;
      const signers = [{ base: null, commitment: own.commitment }];
      const refused = [];
      for (const base of this.peersFor(roundIdBytes)) {
        try {
          const r = await this.fetcher(`${base}/settle-commit?${q}`, { method: 'POST' });
          if (!r.ok) { refused.push(`${base}: ${(await r.text()).trim()}`); continue; }
          signers.push({ base, commitment: decodeCommitments(new Uint8Array(await r.arrayBuffer()))[0] });
        } catch (e) { refused.push(`${base}: ${e.message}`); }
      }
      if (signers.length < m.needed)
        return refuse(`${signers.length} of the ${m.needed} seats the settlement needs committed to it: ${refused.join('; ')}`);
      const commitments = signers.map((s) => s.commitment).sort((a, b) => a.id - b.id);
      const shares = [];
      for (const s of signers) {
        if (s.base === null) {
          const mine = await this.share(roundIdBytes, commitments);
          if (!mine.ok) return mine;
          shares.push(mine.share);
          continue;
        }
        const r = await this.fetcher(`${s.base}/settle-share?${q}`, { method: 'POST', body: encodeCommitments(commitments) });
        if (!r.ok) return refuse(`${s.base} gave no share: ${(await r.text()).trim()}`);
        shares.push(decodeShare(new Uint8Array(await r.arrayBuffer())));
      }
      ({ signature } = aggregate340({ commitments, message: m.message, groupPublicKey: m.claimPk, shares, curve: this.curve }));
      if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1)))
        return refuse('the combined settlement signature does not verify under the round\'s claim key', 500);
      for (const s of signers) {
        if (s.base === null) continue;
        try { await this.fetcher(`${s.base}/settle-signature?${q}`, { method: 'POST', body: signature }); } catch { /* it asks again */ }
      }
    }
    // THE INTENT IS ON DISK BEFORE THE SUBMIT, as a hold's settle is: a seat that
    // dies here comes back knowing it signed, and asks the federation.
    this.round.putLockSettlement({ roundId: roundIdBytes, txid: m.txid, message: m.message, signature, state: SUBMITTING,
      why: 'about to submit; if this seat dies here, ask the federation for the claimed locks' });
    const sent = await this.port.settle({ claimPk: m.claimPk, claims: m.claims, payouts: m.plan.payouts, nonce: m.plan.nonce, signature });
    const state = sent.accepted ? ACCEPTED : REFUSED;
    const stakeClaims = m.plan.claims.filter((c) => c.kind !== 'fee').length;
    const qualifiers = m.plan.payouts.filter((p) => p.kind !== 'seat').length;
    const feePart = m.plan.feeClaims && m.plan.feeClaims.length
      ? `; fee locks ${m.plan.feeClaims.length}, ${m.plan.feePoolMsat} msat, paid ${m.plan.seatPayouts.length} seat(s) ${m.plan.feePaidMsat} msat`
      : (m.plan.feeHole ? `; no fee lock claimed: ${m.plan.feeHole.why}` : '');
    const why = sent.accepted
      ? `claimed ${stakeClaims} loser lock(s), ${m.plan.poolMsat} msat; paid ${qualifiers} qualifier(s) ${m.plan.paidMsat} msat${feePart}`
      : `the guardians refused it: ${sent.error}`;
    this.round.putLockSettlement({ roundId: roundIdBytes, txid: m.txid, message: m.message, signature, state, why });
    return { ok: sent.accepted, state, why, txid: m.txid, signature, plan: m.plan, answer: sent };
  }
}

export { encodeCommitments, encodeShare, decodeCommitments };
