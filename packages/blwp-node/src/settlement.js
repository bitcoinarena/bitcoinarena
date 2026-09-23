// THE SIGNER NODES' ONE SETTLEMENT OF A LOCK ROUND (W4; FEDERATION.md money flow step
// 5). the owner 2026-09-14 07:22: "a loser loses the stake. The lock is claimed into
// the pool. Winners are paid from that."
//
// "Each signer node then rebuilds one settlement transaction from the public payout
// table. Inputs: every loser's stake lock (`Claim(P)`) ... Outputs: one payout
// contract per qualifier (a pre-expired lock, `refund_pk` = the qualifier's
// key). A signer node signs only the txid it rebuilt itself; one FROST signing covers
// every input."
//
// FROM THIS SIGNER NODE'S OWN RECORD, as the forfeit is: its own signed result for every
// entry, its own no-quorum and ENTRY_VOID records, its own finality - nothing
// waiting inside its window, nothing suspended - and the locks IT verified. The
// decision is protocol's `lockSettlement` (the hold path's own verdict over one
// payout table). Each loser's P is opened by the signer nodes' share conversation and
// must be the scalar of the point that loser's lock names. The transaction is
// rebuilt by the stock client (blwp-stake-lock --mode settle, dry), and the signer node
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
import { sendPlanToJson } from './winnings-send.js';

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
   * `dkg` holds this signer node's share of the round's claim key; `port` is the
   * federation (blwp-stake-lock); `preimages` opens a loser's P with the other
   * signer nodes; `peersFor(rid)` names the other settlement signer nodes' bases.
   */
  constructor(round, { dkg, port, curve, random, preimages, peersFor = () => [], fetcher = (u, o) => fetch(u, o),
    signerNodesFor = (rid, contract) => ({ gameVerify: contract.nodes, settlement: contract.nodes }), winnings = null } = {}) {
    this.round = round;
    // WINNINGS ALWAYS SENT (winnings-send.js): when given, a qualifier who named an address is paid by send, not collect.
    this.winnings = winnings;
    // THE ROUND'S SITTING SIGNER NODES BY POOL (Pick A): who the fee locks pay, §22A's weights.
    this.signerNodesFor = signerNodesFor;
    this.dkg = dkg;
    this.port = port;
    this.curve = curve;
    this.random = random;
    this.preimages = preimages;
    this.peersFor = peersFor;
    this.fetcher = fetcher;
    this.built = new Map();          // round id hex -> the settlement this signer node rebuilt
    this.pairs = new Map();          // round id hex -> { hiding, binding, commitment, list, share }
    this.fees = new Map();           // round id hex -> the guardians' fee rule, read once
  }

  /** EVERY ENTRY OF THE ROUND, AS THIS SIGNER NODE HOLDS IT - or why the round still waits. */
  entriesOnRecord(roundIdBytes, contract) {
    const entries = [];
    for (const { entryId, entry } of this.round.entriesOf(roundIdBytes)) {
      // A STAKE THIS SIGNER NODE NEVER SAW COMMITTED IS NOT IN THE ROUND (§23.1 step 5: play begins
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
      if (!mine) return refuse(`this signer node signed no result for ${toHex(entryId).slice(0, 16)}, so it settles nothing`);
      const r = decodePlayerResult(splitSignedResult(mine.bytes).body);
      entries.push({ ...base, outcome: r.outcome, score: r.score });
    }
    void contract;
    return { ok: true, entries };
  }

  /** WHAT THIS SIGNER NODE WILL SIGN, rebuilt from its own store and the stock client - or the refusal. */
  async message(roundIdBytes) {
    const key = toHex(roundIdBytes);
    const kept = this.built.get(key);
    if (kept) return kept;
    const got = await this.planOf(roundIdBytes, { withSends: true });
    if (!got.ok) return got;
    const { plan, contract, claimPk, held, locks, lockEntry } = got;

    const claims = [];
    for (const c of plan.claims) {
      if (c.kind === 'fee') { claims.push(c); continue; }
      const entryId = lockEntry.get(toHex(c.pubkey));
      const opened = await this.preimages.open({ roundId: roundIdBytes, entryId, needed: receiptsNeeded(contract.nodes.length) });
      if (!opened.ok) return refuse(`a loser's P could not be opened: ${opened.why}`);
      const lock = locks.get(toHex(c.pubkey));
      if (lock.fields.paymentImage.kind === 'point') {
        const point = this.curve.pointFromScalar(scalarFrom32(opened.preimage) % FIELD);
        if (toHex(point) !== toHex(lock.fields.paymentImage.bytes))
          return refuse('the P the signer nodes opened is not the scalar of the point that loser\'s lock names');
      }
      claims.push({ ...c, preimage: opened.preimage });
    }
    const tx = await this.port.settle({ claimPk, claims, payouts: plan.payouts, nonce: plan.nonce });
    const built = { ok: true, message: fromHex(tx.message), txid: tx.txid, plan, claims, claimPk,
      signerNode: held.signerNode, needed: receiptsNeeded(contract.nodes.length) };
    this.built.set(key, built);
    return built;
  }

  /**
   * THE ROUND'S PLAN FROM THIS SIGNER NODE'S OWN STORE - no preimage opened, nothing cached. `withSends` pays each
   * qualifier with a kept send plan by its outgoing contract (winnings-send.js); without it, the base plan the send
   * plans are proposed and checked against.
   */
  async planOf(roundIdBytes, { withSends = false } = {}) {
    const key = toHex(roundIdBytes);
    const row = this.round.get(roundIdBytes);
    if (!row) return refuse('this node holds no such round', 404);
    const contract = decodeRoundContract(new Uint8Array(row.contract));
    if (!locksStake(contract)) return refuse('that round\'s stake is not a federation lock, so there is no lock to claim');
    if (!this.port || typeof this.port.settle !== 'function') return refuse('this signer node reaches no federation, so it settles nothing');
    const held = this.dkg.signerNodeFor(contract.nodes);
    if (!held.ok) return refuse(`this signer node holds no share of the round's claim key: ${held.why}`);
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
    // AND EVERY FEE LOCK THIS SIGNER NODE VERIFIED (Pick A), with the F its entry hands over.
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
    const args = { roundId: roundIdBytes, entries: on.entries, minScore: contract.minScore, locks, fees,
      feeLocks, signerNodes: feeLocks.size ? this.signerNodesFor(roundIdBytes, contract) : null, contract };
    let plan = lockSettlement(args);
    if (!plan.ok) return refuse(`no lock is claimed: ${plan.why}`);
    if (plan.nothing) return refuse(`no lock is claimed: ${plan.why}`);
    const base = { plan, entryOf: lockEntry };
    if (withSends && this.winnings) {
      const sends = this.winnings.sendsFor(roundIdBytes, base, claimPk);
      if (sends.size) {
        plan = lockSettlement({ ...args, sends });
        if (!plan.ok) return refuse(`no lock is claimed: ${plan.why}`);
      }
    }
    return { ok: true, plan, base, contract, claimPk, held, locks, lockEntry };
  }

  /**
   * WHAT THE SIGNER NODES' SETTLEMENT MOVES, AS THIS SIGNER NODE BUILT IT - for a reader (GET
   * /lock-settlement): every input with its kind and msat, every payout with its
   * kind, key, msat and the federation's fee on it, the input fees, the txid. Null
   * until this signer node has built it.
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

  /** ROUND ONE: this signer node's nonce commitment for the settlement it would sign. */
  async commit(roundIdBytes) {
    const m = await this.message(roundIdBytes);
    if (!m.ok) return m;
    const key = toHex(roundIdBytes);
    let pair = this.pairs.get(key);
    if (!pair || toHex(pair.message) !== toHex(m.message)) {
      const hiding = nonceGenerate340(this.random(32), m.signerNode.share);
      const binding = nonceGenerate340(this.random(32), m.signerNode.share);
      pair = { message: m.message, hiding, binding, list: null, share: null,
        commitment: { id: m.signerNode.id, hiding: this.curve.pointFromScalar(hiding), binding: this.curve.pointFromScalar(binding) } };
      this.pairs.set(key, pair);
    }
    return { ok: true, commitment: pair.commitment };
  }

  /** ROUND TWO: this signer node's signature share over the txid it rebuilt, for ONE commitment list. */
  async share(roundIdBytes, commitments) {
    const m = await this.message(roundIdBytes);
    if (!m.ok) return m;
    const pair = this.pairs.get(toHex(roundIdBytes));
    if (!pair || toHex(pair.message) !== toHex(m.message)) return refuse('this signer node committed to no settlement of that round');
    const own = commitments.find((c) => String(c.id) === String(pair.commitment.id));
    if (!own || toHex(own.hiding) !== toHex(pair.commitment.hiding) || toHex(own.binding) !== toHex(pair.commitment.binding))
      return refuse('that list does not carry this signer node\'s own commitment');
    if (commitments.length < m.needed) return refuse(`${commitments.length} commitments, and this round's key signs at ${m.needed}`);
    const key = listKey(commitments);
    if (pair.list && pair.list !== key) return refuse('this signer node signed that settlement over another list, and keeps no second pair');
    if (pair.share === null) {
      pair.share = signShare340({ id: pair.commitment.id, share: m.signerNode.share, groupPublicKey: m.claimPk,
        nonces: { hiding: pair.hiding, binding: pair.binding }, message: m.message, commitments, curve: this.curve });
      pair.list = key;
    }
    return { ok: true, share: pair.share };
  }

  /** A combined signature handed over by a peer: kept only if it verifies over what THIS signer node rebuilt. */
  async take(roundIdBytes, signature) {
    const m = await this.message(roundIdBytes);
    if (!m.ok) return m;
    if (!schnorr.verify(signature, m.message, m.claimPk.subarray(1))) return refuse('that settlement signature does not verify under the round\'s claim key');
    if (!this.round.lockSettlement(roundIdBytes)) {
      this.keepMoves(roundIdBytes, m);
      this.round.putLockSettlement({ roundId: roundIdBytes, txid: m.txid, message: m.message, signature, state: SUBMITTING,
        why: 'signed by the signer nodes; submitted by the signer node that combined it' });
    }
    return { ok: true };
  }

  /** What the signed settlement moves, kept with its intent (W6). */
  keepMoves(roundIdBytes, m) {
    this.round.putLockSettlementMoves({ roundId: roundIdBytes, txid: m.txid,
      claims: m.claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`), payouts: m.plan.payouts.length });
  }

  /**
   * DID THE SETTLEMENT THIS SIGNER NODE SIGNED GO THROUGH? (W6, the owner 2026-09-15). Asked of the
   * federation from what the signer node kept with its intent - never from a rebuild, which a restart
   * may not manage or may make differently. IN: a payout contract of that txid is stored (only
   * that transaction makes one) and none of its claimed locks is still held. OUT: every claimed
   * lock still held and no payout of it stored. Anything else is not decided here - a claimed lock
   * can leave by its own refund after expiry, and a winner can collect its payout.
   */
  async federationSaw(roundIdBytes, kept) {
    const moves = this.round.lockSettlementMoves(roundIdBytes);
    if (!moves || moves.txid !== kept.txid) return { verdict: 'unknown', why: 'this signer node kept no record of what its settlement moves' };
    if (!this.port || typeof this.port.status !== 'function') return { verdict: 'unknown', why: 'this signer node reaches no federation to ask' };
    const held = async (o) => !!(await this.port.status(o)).stored;
    const claimsHeld = [];
    for (const c of moves.claims) claimsHeld.push(await held(outpointOf(c)));
    const payoutsHeld = [];
    for (let i = 0; i < moves.payouts; i++) payoutsHeld.push(await held({ txid: fromHex(kept.txid), outIdx: BigInt(i) }));
    const locksGone = claimsHeld.filter((x) => !x).length;
    const paid = payoutsHeld.filter(Boolean).length;
    const seen = `${paid} of ${moves.payouts} payout contract(s) of ${kept.txid.slice(0, 12)} stored, ${locksGone} of ${moves.claims.length} claimed lock(s) gone`;
    if (paid > 0 && locksGone === moves.claims.length) return { verdict: 'in', why: seen };
    if (paid === 0 && locksGone === 0) return { verdict: 'out', why: seen };
    return { verdict: 'mixed', why: seen };
  }

  /**
   * A SIGNER NODE STARTED AGAIN ASKS ABOUT EVERY SETTLEMENT IT WAS INSIDE (W6): each round it holds as
   * SUBMITTING goes through settle(), which asks the federation before anything else.
   */
  async recover() {
    const out = [];
    for (const rid of this.round.lockSettlementsIn(SUBMITTING)) {
      const got = await this.settle(rid).catch((e) => ({ ok: false, why: e.message }));
      out.push({ round: toHex(rid), ok: !!got.ok, state: got.state || (this.round.lockSettlement(rid) || {}).state, why: got.why });
    }
    return out;
  }

  /**
   * THE SETTLEMENT, made now with the other signer nodes if this signer node holds none: the
   * combined signature checked under the claim key, the intent written, the
   * transaction submitted, and the guardians' answer kept.
   */
  async settle(roundIdBytes) {
    const kept = this.round.lockSettlement(roundIdBytes);
    if (kept && kept.state === ACCEPTED) {
      // WINNINGS ARE ALWAYS SENT, restart or not: a settled round whose winnings are not all PAID is sent now.
      const sent = await this.sendWinnings(roundIdBytes);
      return { ok: true, kept: true, ...kept, sent };
    }
    // THE SEND PLANS FIRST, before anything is rebuilt: proposed here, checked by every peer, or no settlement.
    if (this.winnings && !(kept && kept.state === SUBMITTING)) {
      const planned = await this.planSends(roundIdBytes);
      if (!planned.ok) return planned;
    }
    // A SETTLEMENT THIS SIGNER NODE WAS INSIDE (W6): the federation first. Measured before: a signer node
    // restarted inside one never asked again - its row stayed SUBMITTING whether the money had
    // moved or not.
    if (kept && kept.state === SUBMITTING) {
      const saw = await this.federationSaw(roundIdBytes, kept);
      if (saw.verdict === 'in') {
        const why = `found in the federation after this signer node was inside it: ${saw.why}`;
        this.round.putLockSettlement({ roundId: roundIdBytes, txid: kept.txid, message: kept.message, signature: kept.signature, state: ACCEPTED, why });
        return { ok: true, state: ACCEPTED, why, txid: kept.txid, signature: kept.signature, recovered: true };
      }
      if (saw.verdict === 'mixed') {
        const why = `neither in nor out - not settled here, not submitted again: ${saw.why}`;
        this.round.putLockSettlement({ roundId: roundIdBytes, txid: kept.txid, message: kept.message, signature: kept.signature, state: SUBMITTING, why });
        return refuse(why, 409);
      }
    }
    const m = await this.message(roundIdBytes);
    if (!m.ok) return m;
    // THE KEPT SIGNATURE ONLY OVER THE BYTES IT SIGNED: a plan rebuilt differently is signed afresh.
    let signature = kept && kept.signature && kept.txid === m.txid ? kept.signature : null;
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
        return refuse(`${signers.length} of the ${m.needed} signer nodes the settlement needs committed to it: ${refused.join('; ')}`);
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
    // THE INTENT IS ON DISK BEFORE THE SUBMIT, as a hold's settle is: a signer node that
    // dies here comes back knowing it signed, and asks the federation.
    this.keepMoves(roundIdBytes, m);
    this.round.putLockSettlement({ roundId: roundIdBytes, txid: m.txid, message: m.message, signature, state: SUBMITTING,
      why: 'about to submit; if this signer node dies here, ask the federation for the claimed locks' });
    const sent = await this.port.settle({ claimPk: m.claimPk, claims: m.claims, payouts: m.plan.payouts, nonce: m.plan.nonce, signature });
    const state = sent.accepted ? ACCEPTED : REFUSED;
    const stakeClaims = m.plan.claims.filter((c) => c.kind !== 'fee').length;
    const qualifiers = m.plan.payouts.filter((p) => p.kind !== 'signer node').length;
    const feePart = m.plan.feeClaims && m.plan.feeClaims.length
      ? `; fee locks ${m.plan.feeClaims.length}, ${m.plan.feePoolMsat} msat, paid ${m.plan.signerNodePayouts.length} signer node(s) ${m.plan.feePaidMsat} msat`
      : (m.plan.feeHole ? `; no fee lock claimed: ${m.plan.feeHole.why}` : '');
    const why = sent.accepted
      ? `claimed ${stakeClaims} loser lock(s), ${m.plan.poolMsat} msat; paid ${qualifiers} qualifier(s) ${m.plan.paidMsat} msat${feePart}`
      : `the guardians refused it: ${sent.error}`;
    this.round.putLockSettlement({ roundId: roundIdBytes, txid: m.txid, message: m.message, signature, state, why });
    const winnings = sent.accepted ? await this.sendWinnings(roundIdBytes) : null;
    return { ok: sent.accepted, state, why, txid: m.txid, signature, plan: m.plan, answer: sent, winnings };
  }

  /** THE COORDINATOR'S SEND PLANS: proposed from the base plan and handed to every peer, which checks them itself. */
  async planSends(roundIdBytes) {
    const got = await this.planOf(roundIdBytes);
    if (!got.ok) return got;
    // ONE PROPOSER PER ROUND: the round's signer node with the lowest key. Every signer node settles on its own clock,
    // and two proposals would fetch two invoices and build two transactions that no signature joins (measured: "the
    // combined settlement signature does not verify"). The others wait for its plan and check it.
    const proposer = [...got.contract.nodes].map((k) => toHex(k)).sort()[0];
    if (proposer !== toHex(this.round.pubkey)) {
      if (this.round.sendPlansOf(roundIdBytes).length || !this.winnings.qualifiersWithAddress(got.base).length) return { ok: true, rows: [] };
      return refuse(`the send plan is proposed by signer node ${proposer.slice(0, 16)}; this signer node waits for it and checks it`);
    }
    const proposed = await this.winnings.propose(roundIdBytes, got.base);
    if (!proposed.ok) return proposed;
    if (!proposed.rows.length) return { ok: true, rows: [] };
    const body = JSON.stringify(proposed.rows.map(sendPlanToJson));
    const refused = [];
    for (const base of this.peersFor(roundIdBytes)) {
      try {
        const r = await this.fetcher(`${base}/settle-sends?round=${toHex(roundIdBytes)}`, { method: 'POST', body });
        if (!r.ok) refused.push(`${base}: ${(await r.text()).trim()}`);
      } catch (e) { refused.push(`${base}: ${e.message}`); }
    }
    if (refused.length) return refuse(`a signer node did not take the send plan, so nothing is settled: ${refused.join('; ')}`);
    this.built.delete(toHex(roundIdBytes));
    return { ok: true, rows: proposed.rows };
  }

  /** A PEER takes the coordinator's plans only if each stands here - and then rebuilds with them. */
  async takeSends(roundIdBytes, proposed) {
    if (!this.winnings) return refuse('this signer node sends no winnings');
    const got = await this.planOf(roundIdBytes);
    if (!got.ok) return got;
    const checked = await this.winnings.check(roundIdBytes, got.base, proposed);
    if (checked.ok) this.built.delete(toHex(roundIdBytes));
    return checked;
  }

  /** The settled round's winnings, sent (winnings-send.js `sendAll`). */
  async sendWinnings(roundIdBytes) {
    if (!this.winnings || !this.round.sendPlansOf(roundIdBytes).length) return [];
    // THE ROUND'S PROPOSER DRIVES ITS SENDS; the others answer its signing rounds and keep its preimage.
    const row = this.round.get(roundIdBytes);
    const nodes = row ? decodeRoundContract(new Uint8Array(row.contract)).nodes : [];
    if ([...nodes].map((k) => toHex(k)).sort()[0] !== toHex(this.round.pubkey)) return [];
    // PLANNED BUT NOT YET SETTLED: the settlement is made first - the kept plan offered again - and the send follows it.
    // Measured: the proposer's one attempt met a peer whose run was not yet FINAL, the finality watch had nothing left
    // to wait for, and nothing tried again; the round sat unsettled.
    const kept = this.round.lockSettlement(roundIdBytes);
    if (!kept || kept.state !== ACCEPTED) {
      const got = await this.settle(roundIdBytes).catch((e) => ({ ok: false, why: e.message }));
      return [{ ok: !!got.ok, settle: got.state || null, why: got.why }];
    }
    const m = await this.message(roundIdBytes);
    if (!m.ok) return [{ ok: false, why: m.why }];
    return this.winnings.sendAll(roundIdBytes, m);
  }
}

export { encodeCommitments, encodeShare, decodeCommitments };
