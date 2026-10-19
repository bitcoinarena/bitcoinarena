// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAYOUT OF A PASSED FUNDING PROPOSAL FROM THE PROTOCOL RESERVES (§27A.9.3 "Payout"2026-10-17: "Accepted:
// the 5-of-7 LNURL payout you just wrote. Build that slice. No new fork.").
//
//   WHO SIGNS     the seven guardian seats of the federation that holds the reserves - its reserve key's DKG shares; any 5 of 7.
//                 The lowest-key guardian coordinates; the next takes over after 2 blocks of silence. The other seats do not sign:
//                 they check what they are told (a PAID record's preimage against the plan's invoice) and record it.
//   WHAT          one PAYOUT PLAN per proposal: the reserve outputs it spends (the coordinator's oldest first, no more than X plus
//                 fees needs), an invoice for exactly X sat from the proposal's LNURL, the lowest live gateway, the outgoing
//                 contract to that invoice (output 0) and one change output back to the reserve key (output 1). Every signer
//                 rebuilds it from its own records and refuses anything else. Two 5-of-7 signatures under the reserve key: the
//                 federation transaction's message (`settle`), and the invoice's consensus hash the gateway checks (`send`).
//   WHEN          that seat's own record has the vote decided passed; no payout record exists for the proposal; the federation's
//                 unspent reserves cover X plus the federation's and the gateway's fees.
//   STATES        PLANNED -> SENT (the transaction accepted) -> PAID (the preimage checked) | REFUNDED (the gateway did not pay: the
//                 expired contract spent back to the reserve key). SHORT: the reserves cannot cover it - nothing is paid, for good.
//                 One record per proposal on every seat; a second plan for a proposal is refused; a spent output is never planned again.
//   NOT HERE      a re-try after a refund, a payout split over federations, giving up on an LNURL that stays silent.
//
// The transport is injected: `peers` are objects with commit / share (the seat's HTTP doors; direct calls in a test).
import { schnorr } from '@noble/curves/secp256k1.js';
import { signShare340, aggregate340, nonceGenerate340 } from '../../arena-protocol/src/frost-bip340.js';
import { sendableInvoiceMsat, lowestLiveGateway, sendPlanStands, proposedExpiration } from '../../arena-protocol/src/winnings-send.js';
import { lnv2FeeMsat, largestPayoutMsat } from '../../arena-protocol/src/lock-settlement.js';
import { taggedHash, toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { lightningAddressEndpoint, payRequestStands, callbackFor, invoiceAnswersPayRequest } from '../../arena-protocol/src/lnurl-pay.js';
import { urlOfLnurl } from '../../arena-protocol/src/bech32.js';
import { decodeBolt11 } from '../../arena-protocol/src/bolt11.js';
import { moveSeedOf } from './reserve-move.js';
import { leaderboardCap } from '../../arena-protocol/src/leaderboard-winners.js';

/**
 * A LEADERBOARD PAYOUT'S MONEY: the inputs (reserve outputs) less their fees pay every winner's output and its fee; what is
 * left is the change back to the reserve key (largestPayoutMsat: it pays its own fee). `covers` false when the inputs fall short.
 */
export function leaderboardAmounts({ inputs, winners, fees }) {
  const total = inputs.reduce((t, x) => t + BigInt(x.amountMsat), 0n);
  const left = total - inputs.reduce((t, x) => t + lnv2FeeMsat(fees, BigInt(x.amountMsat)), 0n)
    - winners.reduce((t, w) => t + BigInt(w.msat) + lnv2FeeMsat(fees, BigInt(w.msat)), 0n);
  return { total, covers: left >= 0n, changeMsat: left > 0n ? largestPayoutMsat(fees, left) : 0n };
}

/**
 * THE PROPOSAL'S LNURL, ASKED AS THE WINNINGS SENDER ASKS AN ADDRESS (winnings-send.js): a Lightning address (LUD-16) or an LNURL
 * (LUD-01); the pay request (LUD-06), then the invoice for exactly `msat`, taken only when its amount and description hash stand.
 */
export function lnurlClient({ fetch: get = (u, o) => fetch(u, o), network = 'testnet4', timeoutMs = 15000 } = {}) {
  const fetchJson = async (u) => (await get(u, { signal: AbortSignal.timeout(timeoutMs) })).json();
  async function payRequest(address, msat) {
    let url;
    if (/^lnurl1/i.test(String(address || ''))) { try { url = urlOfLnurl(String(address).toLowerCase()); } catch (e) { return refuse(`that LNURL does not decode: ${e.message}`); } }
    else { const ep = lightningAddressEndpoint(address); if (!ep.ok) return refuse(ep.why); url = ep.url; }
    let said; try { said = await fetchJson(url); } catch (e) { return refuse(`${url} did not answer: ${e.message}`, 503); }
    const pr = payRequestStands(said, msat);
    return pr.ok ? { ok: true, ...pr } : refuse(pr.why);
  }
  async function invoiceFor(address, msat) {
    const pr = await payRequest(address, msat);
    if (!pr.ok) return pr;
    let said; try { said = await fetchJson(callbackFor({ callback: pr.callback, amountMsat: msat })); } catch (e) { return refuse(`the callback did not answer: ${e.message}`, 503); }
    const inv = invoiceAnswersPayRequest({ invoice: said && said.pr, amountMsat: msat, metadata: pr.metadata, network });
    if (!inv.ok) return refuse(inv.why);
    return { ok: true, invoice: said.pr, paymentHash: toHex(inv.paymentHash), metadata: pr.metadata };
  }
  return { payRequest, invoiceFor };
}

export const PAYOUT = Object.freeze({ PLANNED: 'PLANNED', SENT: 'SENT', PAID: 'PAID', REFUNDED: 'REFUNDED', SHORT: 'SHORT', CLAIMED: 'CLAIMED' });
export const TAKEOVER_BLOCKS = 2;
export const RESERVE_PAYOUT_SQL = `CREATE TABLE IF NOT EXISTS reserve_payouts (proposal TEXT PRIMARY KEY, plan_id TEXT, federation TEXT, state TEXT NOT NULL,
    plan TEXT, txid TEXT, preimage TEXT, refund_txid TEXT, why TEXT, updated_ms INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS reserve_payout_inputs (outpoint TEXT PRIMARY KEY, proposal TEXT NOT NULL)`;

const refuse = (why, status = 422) => ({ ok: false, status, why });
const utf8 = (s) => new TextEncoder().encode(s);
const PLAN_KEYS = ['proposal', 'federation', 'reserveKey', 'lnurl', 'amountSats', 'invoiceMsat', 'contractMsat', 'changeMsat', 'refunds', 'invoice',
  'paymentHash', 'gatewayUrl', 'gatewayPk', 'expiration', 'nonce', 'kind', 'to', 'toKey', 'contractHex', 'decidableAt'];
/** A plan's id: the tagged hash of its fields in one order - what a second plan for the same proposal is told apart by. */
export const planIdOf = (plan) => toHex(taggedHash('ARENA/v1/ReservePayoutPlan', utf8(JSON.stringify(PLAN_KEYS.map((k) => plan[k])))));
/** The transaction nonce, the proposal's own: every signer rebuilds the same transaction. */
export const payoutNonce = (proposalHex, kind = 'pay') => taggedHash('ARENA/v1/ReservePayoutNonce', utf8(`${kind}:${proposalHex}`));
const outpointOf = (s) => { const [txid, idx] = String(s).split(':'); return { txid: fromHex(txid), outIdx: BigInt(idx) }; };

/**
 * THE OUTGOING CONTRACT FOR AN INVOICE OF EXACTLY `invoiceMsat`: the smallest contract whose amount, less the gateway's own fee, is
 * that invoice (the rule sendPlanStands checks: sendableInvoiceMsat(contract) === invoice).
 */
export function contractForInvoice(invoiceMsat, fee) {
  const base = BigInt(fee && fee.baseMsat !== undefined ? fee.baseMsat : 0), ppm = BigInt(fee && fee.ppm !== undefined ? fee.ppm : 0);
  let c = invoiceMsat + base + (invoiceMsat * ppm + 999999n) / 1000000n;
  while (c > invoiceMsat && sendableInvoiceMsat(c - 1n, fee) >= invoiceMsat) c -= 1n;
  while (sendableInvoiceMsat(c, fee) < invoiceMsat) c += 1n;
  return c;
}

/**
 * THE MONEY OF A PLAN from a list of inputs (amounts in msat): the contract, its federation fee, and the change the rest buys back to
 * the reserve key (largestPayoutMsat: the change pays its own fee). `covers` false when the inputs do not reach contract + fee.
 */
export function payoutAmounts({ inputs, contractMsat, fees }) {
  const total = inputs.reduce((t, x) => t + BigInt(x.amountMsat), 0n);
  const contractFee = lnv2FeeMsat(fees, contractMsat);
  const rest = total - contractMsat - contractFee;
  return { total, contractFee, covers: rest >= 0n, changeMsat: rest > 0n ? largestPayoutMsat(fees, rest) : 0n };
}

/**
 * THE MOST A MOVE CAN CARRY, in whole sat: the largest invoice whose contract at the gateway's fee, and its federation fee, all the given
 * reserve outputs still cover (a drained federation's reserves move whole, less the fees).
 */
export function moveAmountSats(inputs, gwFee, fees) {
  const total = (inputs || []).reduce((t, x) => t + BigInt(x.amountMsat), 0n);
  let lo = 0n, hi = total / 1000n;
  const fits = (sat) => sat === 0n || payoutAmounts({ inputs, contractMsat: contractForInvoice(sat * 1000n, gwFee), fees }).covers;
  while (lo < hi) { const mid = (lo + hi + 1n) / 2n; if (fits(mid)) lo = mid; else hi = mid - 1n; }
  return lo;
}

/**
 * `db`; `me` this seat's node key (hex); `curve` and `random` for FROST; `passed()` -> [{ id, lnurl, amountSats, decidableAt }] the
 * proposals whose vote THIS seat decided passed; `guardians()` -> Map fedHex -> { members: [hex] sorted, key (33 bytes) or null,
 * signer { id, share } or null, needed, peers: [{ commit(body), share(body) }] }; `reserveRows(fedHex)` -> [{ outpoint, amountMsat,
 * verifiedMs }] under that federation's reserve key; `portOf(fedHex)`; `payRequest(lnurl, msat)` and `invoiceFor(lnurl, msat)` as
 * winnings-send.js; `network`; `keepRow(row)` a reserve row to keep (putDonationOutputs' shape); `broadcast(record)` to every seat.
 */
// `leaderboards()` -> [{ id, federation (hex), amountSats, paymentHeight, decidableAt }] the leaderboard payouts whose vote passed here
//; `winnersOf(id)` -> { ok, winners: [{ player, payoutPk (33-byte hex), msat }] } this seat's own reading of the season
export function createReservePayouts({ db, me, curve, random, passed, guardians, reserveRows, portOf, payRequest, invoiceFor, network = 'testnet',
  keepRow = () => {}, broadcast = () => {}, log = () => {}, now = () => Date.now(), moves = () => [], leaderboards = () => [], winnersOf = async () => ({ ok: false, why: 'no season reader' }) }) {
  db.exec(RESERVE_PAYOUT_SQL);
  // A MOVE'S CLAIM (the drained-federation move): the destination's claim transaction and what it put under its reserve key
  for (const col of ['claim_txid', 'claim_msat']) if (!db.prepare('PRAGMA table_info(reserve_payouts)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE reserve_payouts ADD COLUMN ${col} TEXT`);
  // A MOVE ONCE CALLED FOR STAYS KNOWN: planned, its inputs count as spent and the drained federation's unspent reserves read 0, so the
  // records no longer list it - and its signing, sending and claiming must go on
  const knownMoves = new Map();
  const moveOf = (id) => { const m = (moves() || []).find((x) => x.id === id); if (m) knownMoves.set(id, m); return m || knownMoves.get(id) || null; };
  const fedOf = (kind, plan) => (kind === 'claim' ? plan.to : plan.federation);
  const keyOfKind = (kind, plan) => (kind === 'claim' ? plan.toKey : plan.reserveKey);
  // `${planId}:${kind}` -> [{ message, hiding, binding, commitment, list, share }]: a nonce pair signs ONE list, once; a coordinator taking
  // over opens a new session, and gets a fresh pair - a used pair is never offered again (FROST: one nonce pair, one signature)
  const pairs = new Map();
  const rowOf = (pid) => db.prepare('SELECT * FROM reserve_payouts WHERE proposal = ?').get(pid) || null;
  const planOfRow = (r) => (r && r.plan ? JSON.parse(r.plan) : null);
  const spentBy = (outpoint) => { const r = db.prepare('SELECT proposal FROM reserve_payout_inputs WHERE outpoint = ?').get(outpoint); return r ? r.proposal : null; };
  const write = (pid, fields) => {
    const had = rowOf(pid);
    const r = { plan_id: null, federation: null, plan: null, txid: null, preimage: null, refund_txid: null, why: null, claim_txid: null, claim_msat: null, ...(had || {}), ...fields, proposal: pid, updated_ms: now() };
    db.prepare(`INSERT OR REPLACE INTO reserve_payouts (proposal, plan_id, federation, state, plan, txid, preimage, refund_txid, why, updated_ms, claim_txid, claim_msat)
      VALUES (@proposal, @plan_id, @federation, @state, @plan, @txid, @preimage, @refund_txid, @why, @updated_ms, @claim_txid, @claim_msat)`).run(r);
    return r;
  };
  const markInputs = (pid, plan) => { for (const x of plan.refunds) db.prepare('INSERT OR IGNORE INTO reserve_payout_inputs (outpoint, proposal) VALUES (?, ?)').run(x.outpoint, pid); };
  const unspent = (fed, alsoBy = null) => (reserveRows(fed) || []).filter((r) => { const s = spentBy(r.outpoint); return !s || (alsoBy && s === alsoBy); })
    .sort((a, b) => (a.verifiedMs - b.verifiedMs) || (a.outpoint < b.outpoint ? -1 : 1));
  const recordOf = (r) => ({ proposal: r.proposal, planId: r.plan_id, federation: r.federation, state: r.state, plan: planOfRow(r), txid: r.txid,
    preimage: r.preimage, refundTxid: r.refund_txid, why: r.why, claimTxid: r.claim_txid || null, claimMsat: r.claim_msat || null });
  // THE MOVE'S NEW RESERVE OUTPUT in the destination: its claim transaction's output 0, under the destination's reserve key
  const claimRowOf = (plan, txid, msat) => ({ outpoint: { txid: fromHex(txid), outIdx: 0n }, entryId: fromHex(plan.proposal), roundId: new Uint8Array(32),
    federationId: fromHex(plan.to), recipientPk: fromHex(plan.toKey), amountMsat: BigInt(msat), contractId: `move-claim:${plan.proposal}`, senderOnContract: false,
    item: `reserves moved from ${String(plan.federation).slice(0, 8)}` });
  const payoutsOf = (pr) => {
    const p = planOfRow(pr);
    // A LEADERBOARD PAYOUT: one payout contract per winner, to its identity's refund key, then the change
    if (p.kind === 'leaderboard') {
      const outs = p.winners.map((w) => ({ payoutPk: fromHex(w.payoutPk), msat: BigInt(w.msat) }));
      if (BigInt(p.changeMsat) > 0n) outs.push({ payoutPk: fromHex(p.reserveKey), msat: BigInt(p.changeMsat) });
      return outs;
    }
    const outs = [{ payoutPk: fromHex(p.reserveKey), msat: BigInt(p.contractMsat), sent: { paymentHash: p.paymentHash, gatewayPk: p.gatewayPk, expiration: BigInt(p.expiration) } }];
    if (BigInt(p.changeMsat) > 0n) outs.push({ payoutPk: fromHex(p.reserveKey), msat: BigInt(p.changeMsat) });
    return outs;
  };
  const changeRowOf = (plan, txid) => ({ outpoint: { txid: fromHex(txid), outIdx: plan.kind === 'leaderboard' ? BigInt(plan.winners.length) : 1n }, entryId: fromHex(plan.proposal), roundId: new Uint8Array(32),
    federationId: fromHex(plan.federation), recipientPk: fromHex(plan.reserveKey), amountMsat: BigInt(plan.changeMsat), contractId: `payout-change:${plan.proposal}`,
    senderOnContract: false, item: 'payout change' });

  // A WINNER'S OUTPUT, kept as a row under its key (GET /donations?key= serves it): its page collects it as a zap
  const winnerRowsOf = (plan, txid) => plan.winners.map((w, i) => ({ outpoint: { txid: fromHex(txid), outIdx: BigInt(i) }, entryId: fromHex(plan.proposal), roundId: new Uint8Array(32),
    federationId: fromHex(plan.federation), recipientPk: fromHex(w.payoutPk), amountMsat: BigInt(w.msat), contractId: `leaderboard:${plan.proposal}:${i}`,
    senderOnContract: false, item: 'leaderboard payout' }));
  // WHAT THE FEDERATION IS ASKED TO SIGN, rebuilt here from the plan: the transaction (`tx`), the gateway's auth (`auth`), or the
  // refund of an expired contract back to the reserve key (`refund`)
  async function messageFor(kind, plan, extra = {}) {
    if (kind === 'claim') {
      const to = await portOf(plan.to);
      if (!to) return null;
      const c = await to.claimIncoming({ contractHex: plan.contractHex, seed: moveSeedOf(plan.proposal), payoutPk: fromHex(plan.toKey), nonce: payoutNonce(plan.proposal, 'claim'), waitS: 30 });
      if (!c || !c.funded || !c.commitment || String(c.commitment.claim_pk).toLowerCase() !== String(plan.toKey).toLowerCase()) return null;
      return c.message ? fromHex(c.message) : null;
    }
    const port = await portOf(plan.federation);
    if (!port) return null;
    const key = fromHex(plan.reserveKey);
    if (kind === 'tx') {
      const tx = await port.settle({ claimPk: key, claims: [], refunds: plan.refunds.map((x) => ({ outpoint: outpointOf(x.outpoint), amountMsat: BigInt(x.amountMsat) })),
        payouts: payoutsOf({ plan: JSON.stringify(plan) }), nonce: fromHex(plan.nonce) });
      return tx && tx.message ? fromHex(tx.message) : null;
    }
    if (kind === 'auth') {
      if (!extra.txid) return null;
      const s = await port.send({ gateway: plan.gatewayUrl, outpoint: { txid: fromHex(extra.txid), outIdx: 0n }, paymentHash: plan.paymentHash, amountMsat: BigInt(plan.contractMsat),
        expiration: BigInt(plan.expiration), claimPk: plan.gatewayPk, refundPk: key, invoice: plan.invoice });
      return s && s.message ? s.message : null;
    }
    if (kind === 'refund') {
      if (!extra.txid) return null;
      const fees = await port.fees();
      const tx = await port.settle({ claimPk: key, claims: [], refunds: [{ outpoint: { txid: fromHex(extra.txid), outIdx: 0n }, amountMsat: BigInt(plan.contractMsat) }],
        payouts: [{ payoutPk: key, msat: largestPayoutMsat(fees, BigInt(plan.contractMsat)) }], nonce: payoutNonce(plan.proposal, 'refund') });
      return tx && tx.message ? fromHex(tx.message) : null;
    }
    return null;
  }

  /**
   * DOES A PLAN STAND HERE - a signer's own rebuild: the vote passed in its own record, its own key and share of that federation, no
   * other plan for the proposal, every input one of its own unspent reserve outputs at that amount, no more inputs than X plus fees
   * needs, the contract for exactly X sat at the lowest live gateway's fee, the change, the invoice (amount and description hash).
   */
  // `late`: a record past PLANNED (the federation accepted it, five signers agreed) - its structure is checked, not the invoice's
  // window, which has moved on since
  async function planStands(plan, { late = false } = {}) {
    if (!plan || typeof plan !== 'object') return refuse('no plan');
    if (plan.kind === 'leaderboard') return leaderboardPlanStands(plan, { late });
    const isMove = plan.kind === 'move';
    if (isMove) {
      // A MOVE: this seat's own records call for it - the same drained federation, the same destination and its key
      const m = moveOf(plan.proposal);
      if (!m) return refuse('this seat\'s records call for no such move');
      if (m.from !== plan.federation || m.to !== plan.to || m.toKey !== String(plan.toKey).toLowerCase()) return refuse('the plan moves to another federation or key than this seat\'s records say');
      if (String(m.decidableAt) !== String(plan.decidableAt)) return refuse('the plan names another drain height than this seat\'s records');
    } else {
      const vote = (passed() || []).find((p) => p.id === plan.proposal);
      if (!vote) return refuse('this seat has no passed vote for that proposal');
      if (vote.lnurl !== plan.lnurl || String(vote.amountSats) !== String(plan.amountSats)) return refuse('the plan pays another LNURL or amount than the proposal');
    }
    const g = guardians().get(plan.federation);
    if (!g || !g.key || toHex(g.key) !== plan.reserveKey) return refuse('the plan names another reserve key than this seat holds for that federation');
    const pid = planIdOf(plan);
    const had = rowOf(plan.proposal);
    if (had && had.plan_id !== pid) return refuse(`a payout of that proposal is already ${had.state} here (plan ${String(had.plan_id || '-').slice(0, 16)}): no second plan`, 409);
    if (plan.nonce !== toHex(payoutNonce(plan.proposal))) return refuse('the plan carries another nonce than the proposal\'s');
    const own = new Map(unspent(plan.federation).map((r) => [r.outpoint, r]));
    const seen = new Set();
    for (const x of plan.refunds || []) {
      if (seen.has(x.outpoint)) return refuse('an input twice'); seen.add(x.outpoint);
      const sb = spentBy(x.outpoint);
      if (sb && sb !== plan.proposal) return refuse(`${x.outpoint.slice(0, 16)}… was spent by another payout`, 409);
      const r = own.get(x.outpoint);
      if (!r && sb !== plan.proposal) return refuse(`${x.outpoint.slice(0, 16)}… is no unspent reserve output of this seat`);
      if (r && String(r.amountMsat) !== String(x.amountMsat)) return refuse(`${x.outpoint.slice(0, 16)}… holds ${r.amountMsat} msat, not ${x.amountMsat}`);
    }
    const port = await portOf(plan.federation);
    if (!port) return refuse('this seat reaches no port into that federation', 503);
    const [fees, gws] = await Promise.all([port.fees(), port.gateways()]);
    const gw = lowestLiveGateway(gws.gateways || []);
    if (!gw) return refuse('this seat sees no live gateway on that federation', 503);
    const invoiceMsat = BigInt(plan.amountSats) * 1000n;
    if (String(plan.invoiceMsat) !== String(invoiceMsat)) return refuse('the invoice is not for exactly the proposal\'s amount');
    // a move takes all the reserves this seat holds unspent in the drained federation, less the fees: the amount is rebuilt here
    if (isMove && !late) {
      const most = moveAmountSats(unspent(plan.federation, plan.proposal), gw.sendFeeDefault, fees);
      if (String(most) !== String(plan.amountSats)) return refuse(`the move is ${plan.amountSats} sat, and the reserves this seat holds there move ${most} sat`);
    }
    const contractMsat = contractForInvoice(invoiceMsat, gw.sendFeeDefault);
    if (String(plan.contractMsat) !== String(contractMsat)) return refuse(`the contract is ${plan.contractMsat} msat, and an invoice of ${invoiceMsat} at that gateway's fee needs ${contractMsat}`);
    const amounts = payoutAmounts({ inputs: plan.refunds, contractMsat, fees });
    if (!amounts.covers) return refuse('the inputs do not cover the contract and its fee');
    const lastIn = plan.refunds.length ? BigInt(plan.refunds[plan.refunds.length - 1].amountMsat) : 0n;
    if (plan.refunds.length > 1 && amounts.total - lastIn >= contractMsat + amounts.contractFee) return refuse('the plan spends more reserve outputs than X plus fees needs');
    // a move leaves nothing behind: what the whole sat and the fees leave over (under one sat) is no change output worth its fee
    const wantChange = isMove ? 0n : amounts.changeMsat;
    if (String(plan.changeMsat) !== String(wantChange)) return refuse(`the change is ${plan.changeMsat} msat, and those inputs leave ${wantChange}`);
    if (late) return { ok: true, planId: pid, signer: g };
    if (isMove) {
      // THE DESTINATION'S CONTRACT, read through this seat's own port into it: claimed only by the destination's reserve key, its
      // preimage the move's seed's, and the invoice for exactly that amount and that payment hash; the gateway and window as a payout's
      let d; try { d = decodeBolt11(plan.invoice); } catch (e) { return refuse(`that is no invoice: ${e.message}`); }
      if (d.amountMsat !== invoiceMsat || toHex(d.paymentHash) !== String(plan.paymentHash).toLowerCase()) return refuse('the invoice is not for that amount and payment hash');
      const to = await portOf(plan.to);
      if (!to) return refuse('this seat reaches no port into the destination', 503);
      let c; try { c = await to.claimIncoming({ contractHex: plan.contractHex, seed: moveSeedOf(plan.proposal), payoutPk: fromHex(plan.toKey), nonce: payoutNonce(plan.proposal, 'claim'), waitS: 0 }); }
      catch (e) { return refuse(`the destination's contract does not stand: ${e.message}`); }
      if (!c || !c.commitment || String(c.commitment.claim_pk).toLowerCase() !== String(plan.toKey).toLowerCase()) return refuse('the destination\'s contract is claimed by another key than its reserve key');
      if (String(c.commitment.payment_hash).toLowerCase() !== String(plan.paymentHash).toLowerCase()) return refuse('the destination\'s contract is for another payment hash than the invoice');
      if (String(plan.gatewayUrl) !== String(gw.url) || String(plan.gatewayPk).toLowerCase() !== String(gw.modulePublicKey).toLowerCase()) return refuse('the plan names another gateway than the lowest live one');
      const exp = BigInt(plan.expiration), lo = BigInt(gws.height) + BigInt(gw.expirationDeltaMinimum), hi = BigInt(gws.height) + BigInt(gw.expirationDeltaDefault) + 36n;
      if (exp < lo || exp > hi) return refuse(`the plan's expiration ${exp} is outside the gateway's window ${lo}..${hi}`);
      return { ok: true, planId: pid, signer: g };
    }
    const pr = await payRequest(plan.lnurl, invoiceMsat);
    if (!pr.ok) return refuse(`the LNURL did not answer here: ${pr.why}`, 503);
    const st = sendPlanStands({ plan: { invoice: plan.invoice, paymentHash: plan.paymentHash, gatewayUrl: plan.gatewayUrl, gatewayPk: plan.gatewayPk, expiration: plan.expiration },
      payoutMsat: contractMsat, gateways: gws.gateways || [], height: gws.height, metadata: pr.metadata, network });
    if (!st.ok) return refuse(st.why);
    return { ok: true, planId: pid, signer: g };
  }

  /**
   * DOES A LEADERBOARD PLAN STAND HERE - a signer's own rebuild: the vote passed in its own record and the payment height is
   * reached; its own key of that federation; no other plan for it; every input one of its own unspent reserve outputs at that amount and
   * no more of them than the payout needs; the winners exactly as its own reading of the season names them (who, how much, in that
   * order); at most 10 % of that federation's reserves; the change as those inputs leave it.
   */
  async function leaderboardPlanStands(plan, { late = false } = {}) {
    const lb = (leaderboards() || []).find((x) => x.id === plan.proposal);
    if (!lb) return refuse('this seat has no passed leaderboard payout of that id');
    if (lb.federation !== plan.federation || String(lb.amountSats) !== String(plan.amountSats)) return refuse('the plan pays from another federation or another amount than the request');
    const g = guardians().get(plan.federation);
    if (!g || !g.key || toHex(g.key) !== plan.reserveKey) return refuse('the plan names another reserve key than this seat holds for that federation');
    const pid = planIdOf(plan);
    const had = rowOf(plan.proposal);
    if (had && had.plan_id !== pid) return refuse(`a payout of that request is already ${had.state} here (plan ${String(had.plan_id || '-').slice(0, 16)}): no second plan`, 409);
    if (plan.nonce !== toHex(payoutNonce(plan.proposal))) return refuse('the plan carries another nonce than the request\'s');
    if (!Array.isArray(plan.winners) || !plan.winners.length) return refuse('a leaderboard payout pays at least one winner');
    const own = new Map(unspent(plan.federation).map((r) => [r.outpoint, r]));
    const seen = new Set();
    for (const x of plan.refunds || []) {
      if (seen.has(x.outpoint)) return refuse('an input twice'); seen.add(x.outpoint);
      const sb = spentBy(x.outpoint);
      if (sb && sb !== plan.proposal) return refuse(`${x.outpoint.slice(0, 16)}… was spent by another payout`, 409);
      const r = own.get(x.outpoint);
      if (!r && sb !== plan.proposal) return refuse(`${x.outpoint.slice(0, 16)}… is no unspent reserve output of this seat`);
      if (r && String(r.amountMsat) !== String(x.amountMsat)) return refuse(`${x.outpoint.slice(0, 16)}… holds ${r.amountMsat} msat, not ${x.amountMsat}`);
    }
    const port = await portOf(plan.federation);
    if (!port) return refuse('this seat reaches no port into that federation', 503);
    const fees = await port.fees();
    const amounts = leaderboardAmounts({ inputs: plan.refunds, winners: plan.winners, fees });
    if (!amounts.covers) return refuse('the inputs do not cover the winners and their fees');
    if (plan.refunds.length > 1 && leaderboardAmounts({ inputs: plan.refunds.slice(0, -1), winners: plan.winners, fees }).covers) return refuse('the plan spends more reserve outputs than the payout needs');
    if (String(plan.changeMsat) !== String(amounts.changeMsat)) return refuse(`the change is ${plan.changeMsat} msat, and those inputs leave ${amounts.changeMsat}`);
    const paid = plan.winners.reduce((t, w) => t + BigInt(w.msat), 0n);
    if (paid !== BigInt(plan.amountSats) * 1000n) return refuse(`the winners are paid ${paid} msat, and the request is ${plan.amountSats} sat`);
    if (late) return { ok: true, planId: pid, signer: g };
    // THE 10 % CAP over the reserves this seat holds there now (the plan's own inputs counted)
    const held = unspent(plan.federation, plan.proposal).reduce((t, r) => t + BigInt(r.amountMsat), 0n) / 1000n;
    const cap = leaderboardCap({ amountSats: plan.amountSats, reservesSats: held });
    if (!cap.ok) return refuse(cap.why);
    const w = await winnersOf(plan.proposal);
    if (!w || !w.ok) return refuse(`this seat cannot read the season's winners: ${w ? w.why : '?'}`, 503);
    const same = (a, b) => a.length === b.length && a.every((x, i) => String(x.payoutPk).toLowerCase() === String(b[i].payoutPk).toLowerCase() && String(x.msat) === String(b[i].msat));
    if (!same(plan.winners, w.winners)) return refuse('the plan pays other winners or other amounts than this seat\'s reading of the season');
    return { ok: true, planId: pid, signer: g };
  }

  // FROST, ROUND ONE: a commitment to the message of `kind` this seat rebuilt for that plan (taken, and recorded as PLANNED, only once
  // the plan stands here)
  async function commit({ plan, kind, txid = null }) {
    if (kind === 'claim') return commitClaim({ plan });
    const done = plan && rowOf(plan.proposal);
    if (done && (done.state === PAYOUT.PAID || done.state === PAYOUT.REFUNDED || done.state === PAYOUT.SHORT)) return refuse(`that payout is ${done.state} here: nothing more is signed`, 409);
    if (kind === 'tx' && done && done.state !== PAYOUT.PLANNED) return refuse('that payout\'s transaction is accepted already: it is signed once', 409);
    const st = await planStands(plan);
    if (!st.ok) {
      const r = rowOf(plan && plan.proposal);
      if (!(r && r.plan_id === planIdOf(plan) && kind !== 'tx')) return st;    // past PLANNED its inputs are spent: the auth and refund go on
    }
    const g = guardians().get(plan.federation);
    if (!g || !g.signer) return refuse('this seat holds no share of that reserve key');
    if (!rowOf(plan.proposal)) { write(plan.proposal, { plan_id: planIdOf(plan), federation: plan.federation, state: PAYOUT.PLANNED, plan: JSON.stringify(plan) }); markInputs(plan.proposal, plan); }
    return pairFor(plan, kind, g, await messageFor(kind, plan, { txid }));
  }
  // THE DESTINATION'S CLAIM OF A MOVE: only once the move is PAID here (its preimage checked) and only by a guardian of the destination,
  // over the claim its own port rebuilds into the destination's reserve key
  async function commitClaim({ plan }) {
    const r = plan && rowOf(plan.proposal);
    if (!r || r.plan_id !== planIdOf(plan) || plan.kind !== 'move') return refuse('this seat keeps no such move');
    if (r.state === PAYOUT.CLAIMED) return refuse('that move is claimed already: it is signed once', 409);
    if (r.state !== PAYOUT.PAID) return refuse(`that move is ${r.state} here, not paid: nothing is claimed`, 409);
    const g = guardians().get(plan.to);
    if (!g || !g.signer || !g.key || toHex(g.key) !== String(plan.toKey).toLowerCase()) return refuse('this seat holds no share of the destination\'s reserve key');
    return pairFor(plan, 'claim', g, await messageFor('claim', plan));
  }
  function pairFor(plan, kind, g, message) {
    if (!message) return refuse(`this seat cannot rebuild the ${kind} message`);
    const key = `${planIdOf(plan)}:${kind}`;
    const kept = (pairs.get(key) || []).filter((p) => toHex(p.message) === toHex(message));
    let pair = kept.find((p) => p.share === null);
    if (!pair) {
      const hiding = nonceGenerate340(random(32), g.signer.share), binding = nonceGenerate340(random(32), g.signer.share);
      pair = { message, hiding, binding, list: null, share: null, commitment: { id: g.signer.id, hiding: curve.pointFromScalar(hiding), binding: curve.pointFromScalar(binding) } };
      pairs.set(key, [...kept, pair].slice(-8));
    }
    return { ok: true, commitment: pair.commitment };
  }
  // ROUND TWO: one share over that message for one commitment list, never a second list
  async function share({ planId, kind, commitments }) {
    const kept = pairs.get(`${planId}:${kind}`) || [];
    if (!kept.length) return refuse(`this seat committed to no ${kind} of that plan`);
    const pair = kept.find((p) => commitments.some((c) => String(c.id) === String(p.commitment.id) && toHex(c.hiding) === toHex(p.commitment.hiding) && toHex(c.binding) === toHex(p.commitment.binding)));
    if (!pair) return refuse('that list does not carry this seat\'s commitment');
    const r = db.prepare('SELECT federation, plan FROM reserve_payouts WHERE plan_id = ?').get(planId);
    const g = r && guardians().get(kind === 'claim' ? JSON.parse(r.plan).to : r.federation);
    if (!g || !g.signer) return refuse('this seat holds no share of that reserve key');
    if (commitments.length < g.needed) return refuse(`${commitments.length} commitments, and the reserve key signs at ${g.needed}`);
    const list = commitments.map((c) => `${c.id}:${toHex(c.hiding)}:${toHex(c.binding)}`).join('|');
    if (pair.list && pair.list !== list) return refuse('this seat signed that message over another list');
    if (pair.share === null) { pair.share = signShare340({ id: g.signer.id, share: g.signer.share, groupPublicKey: g.key, nonces: { hiding: pair.hiding, binding: pair.binding }, message: pair.message, commitments, curve }); pair.list = list; }
    return { ok: true, share: pair.share };
  }
  // THE COORDINATOR'S SIGNATURE of `kind`: its own commitment and the peers', then their shares, aggregated and checked under the key
  async function sign(plan, kind, extra = {}) {
    const g = guardians().get(fedOf(kind, plan));
    const own = await commit({ plan, kind, ...extra });
    if (!own.ok) return own;
    const signers = [{ peer: null, commitment: own.commitment }];
    for (const peer of g.peers || []) {
      try { const r = await peer.commit({ plan, kind, ...extra }); if (r && r.ok) signers.push({ peer, commitment: r.commitment }); } catch { /* a peer down: the threshold decides */ }
      if (signers.length >= g.needed) break;
    }
    if (signers.length < g.needed) return refuse(`${signers.length} of ${g.needed} guardian seats committed to the ${kind}`, 503);
    const commitments = signers.map((x) => x.commitment).sort((a, b) => a.id - b.id);
    const shares = [];
    const planId = planIdOf(plan);
    for (const x of signers) {
      const r = x.peer === null ? await share({ planId, kind, commitments }) : await x.peer.share({ planId, kind, commitments }).catch((e) => refuse(e.message));
      if (!r || !r.ok) return refuse(`a ${kind} share was refused: ${r ? r.why : '?'}`);
      shares.push(r.share);
    }
    const message = (pairs.get(`${planId}:${kind}`) || []).find((p) => p.commitment === own.commitment).message;
    const { signature } = aggregate340({ commitments, message, groupPublicKey: g.key, shares, curve });
    if (!schnorr.verify(signature, message, g.key.subarray(1))) return refuse(`the ${kind} signature does not verify under the reserve key`);
    return { ok: true, signature };
  }

  // A RECORD ANOTHER SEAT SENT (its broadcast): kept once per proposal - a PAID one only with the preimage of the plan's invoice
  async function learn(rec) {
    if (!rec || typeof rec.proposal !== 'string' || !PAYOUT[rec.state]) return refuse('no payout record');
    const had = rowOf(rec.proposal);
    if (rec.state === PAYOUT.SHORT) { if (!had) write(rec.proposal, { state: PAYOUT.SHORT, why: rec.why || null, federation: rec.federation || null }); return { ok: true }; }
    if (!rec.plan || planIdOf(rec.plan) !== rec.planId) return refuse('the record\'s plan is not its id');
    if (had && had.plan_id && had.plan_id !== rec.planId) return refuse('another plan of that proposal is kept here', 409);
    if (rec.state === PAYOUT.PAID && rec.plan.kind === 'leaderboard' && !rec.txid) return refuse('a paid leaderboard payout names its transaction');
    if (rec.state === PAYOUT.PAID && rec.plan.kind !== 'leaderboard' && !(rec.preimage && toHex(sha256(fromHex(rec.preimage))) === rec.plan.paymentHash)) return refuse('that preimage is not the invoice\'s');
    // A GUARDIAN OF THAT FEDERATION keeps a plan it was told about only when the plan stands on its own records: a forged plan
    // would otherwise hold the proposal's one place here and refuse the real one
    const g = guardians().get(rec.plan.federation);
    if (g && g.signer && !(had && had.plan_id === rec.planId)) { const st = await planStands(rec.plan, { late: rec.state !== PAYOUT.PLANNED }); if (!st.ok) return st; }
    const rank = { [PAYOUT.PLANNED]: 0, [PAYOUT.SENT]: 1, [PAYOUT.PAID]: 2, [PAYOUT.REFUNDED]: 2, [PAYOUT.CLAIMED]: 3 };
    const final = had && (had.state === PAYOUT.CLAIMED || had.state === PAYOUT.REFUNDED || had.state === PAYOUT.SHORT || (had.state === PAYOUT.PAID && rec.state !== PAYOUT.CLAIMED));
    if (final || (had && rank[had.state] > rank[rec.state])) return { ok: true, kept: had.state };
    if (rec.state === PAYOUT.CLAIMED && !(rec.plan.kind === 'move' && rec.claimTxid && rec.claimMsat && rec.preimage && toHex(sha256(fromHex(rec.preimage))) === rec.plan.paymentHash))
      return refuse('a claimed move names its claim and the payment\'s preimage');
    write(rec.proposal, { plan_id: rec.planId, federation: rec.plan.federation, state: rec.state, plan: JSON.stringify(rec.plan), txid: rec.txid || (had && had.txid) || null,
      preimage: rec.preimage || null, refund_txid: rec.refundTxid || null, why: rec.why || null, claim_txid: rec.claimTxid || null, claim_msat: rec.claimMsat || null });
    if (rec.state === PAYOUT.CLAIMED) keepRow(claimRowOf(rec.plan, rec.claimTxid, rec.claimMsat));
    markInputs(rec.proposal, rec.plan);
    if (rec.txid && BigInt(rec.plan.changeMsat) > 0n) keepRow(changeRowOf(rec.plan, rec.txid));
    if (rec.state === PAYOUT.PAID && rec.plan.kind === 'leaderboard' && rec.txid) for (const row of winnerRowsOf(rec.plan, rec.txid)) keepRow(row);
    // THE REFUNDED CONTRACT is back under the reserve key: kept as a reserve row here too (its amount the refund's, rebuilt from the fees)
    if (rec.state === PAYOUT.REFUNDED && rec.refundTxid) {
      const port = await portOf(rec.plan.federation);
      if (port) { const back = largestPayoutMsat(await port.fees(), BigInt(rec.plan.contractMsat));
        keepRow({ ...changeRowOf(rec.plan, rec.refundTxid), outpoint: { txid: fromHex(rec.refundTxid), outIdx: 0n }, amountMsat: back, contractId: `payout-refund:${rec.proposal}`, item: 'payout refund' }); }
    }
    return { ok: true, kept: rec.state };
  }

  /** THE COORDINATOR'S PASS: plan, sign, submit, have the gateway pay - for every passed proposal whose turn this seat has. */
  async function round({ height } = {}) {
    const out = [];
    const feds = guardians();
    out.push(...await moveRound({ height, feds }));
    out.push(...await leaderboardRound({ height, feds }));
    for (const v of passed() || []) {
      const r = rowOf(v.id);
      if (r && (r.state === PAYOUT.PAID || r.state === PAYOUT.SHORT || r.state === PAYOUT.REFUNDED)) continue;
      // which federation pays: the lowest federation id whose unspent reserves (as this seat holds them) cover X plus fees
      let payer = null, needs = {};
      if (r) payer = r.federation;
      else {
        for (const fed of [...feds.keys()].sort()) {
          const g = feds.get(fed); if (!g.key) continue;
          const port = await portOf(fed); if (!port) continue;
          const [fees, gws] = await Promise.all([port.fees(), port.gateways()]);
          const gw = lowestLiveGateway(gws.gateways || []); if (!gw) continue;
          const contractMsat = contractForInvoice(BigInt(v.amountSats) * 1000n, gw.sendFeeDefault);
          const have = unspent(fed);
          const held = have.reduce((t, x) => t + BigInt(x.amountMsat), 0n);
          needs[fed] = { held: String(held), need: String(contractMsat + lnv2FeeMsat(fees, contractMsat)) };
          if (payAmountsCover(have, contractMsat, fees)) { payer = fed; break; }
        }
      }
      const coordFed = payer || [...feds.keys()].filter((f) => feds.get(f).key).sort()[0];
      const g = coordFed && feds.get(coordFed);
      if (!g || !g.signer) continue;                                      // not a guardian of the paying federation: it only records
      const i = g.members.indexOf(me);
      if (i < 0 || !(Number.isInteger(height) && height >= v.decidableAt + TAKEOVER_BLOCKS * i)) continue;   // not this seat's turn yet
      if (!r && !payer) {
        const why = `the reserves cannot pay ${v.amountSats} sat: ${Object.entries(needs).map(([f, n]) => `${f.slice(0, 8)} holds ${n.held} msat, needs ${n.need}`).join('; ') || 'no federation can be read'} (a payout over several federations is not built)`;
        write(v.id, { state: PAYOUT.SHORT, why }); broadcast({ proposal: v.id, state: PAYOUT.SHORT, why });
        log(`[payout] ${v.id.slice(0, 16)}: SHORT - ${why}`); out.push({ id: v.id, state: PAYOUT.SHORT }); continue;
      }
      let plan = planOfRow(r);
      if (!plan) {
        const port = await portOf(payer);
        const [fees, gws] = await Promise.all([port.fees(), port.gateways()]);
        const gw = lowestLiveGateway(gws.gateways || []);
        const invoiceMsat = BigInt(v.amountSats) * 1000n;
        const contractMsat = contractForInvoice(invoiceMsat, gw.sendFeeDefault);
        const inputs = [];
        for (const x of unspent(payer)) { inputs.push({ outpoint: x.outpoint, amountMsat: String(x.amountMsat) }); if (payoutAmounts({ inputs, contractMsat, fees }).covers) break; }
        const inv = await invoiceFor(v.lnurl, invoiceMsat);
        if (!inv.ok) { log(`[payout] ${v.id.slice(0, 16)}: no invoice yet - ${inv.why}`); out.push({ id: v.id, ok: false, why: inv.why }); continue; }   // asked again next pass
        plan = { proposal: v.id, federation: payer, reserveKey: toHex(g.key), lnurl: v.lnurl, amountSats: String(v.amountSats), invoiceMsat: String(invoiceMsat),
          contractMsat: String(contractMsat), changeMsat: String(payoutAmounts({ inputs, contractMsat, fees }).changeMsat), refunds: inputs, invoice: inv.invoice,
          paymentHash: inv.paymentHash, gatewayUrl: gw.url, gatewayPk: String(gw.modulePublicKey).toLowerCase(), expiration: String(proposedExpiration(gws.height, gw)),
          nonce: toHex(payoutNonce(v.id)) };
        const st = await planStands(plan);
        if (!st.ok) { log(`[payout] ${v.id.slice(0, 16)}: own plan refused - ${st.why}`); out.push({ id: v.id, ...st }); continue; }
        write(v.id, { plan_id: st.planId, federation: payer, state: PAYOUT.PLANNED, plan: JSON.stringify(plan) }); markInputs(v.id, plan);
        broadcast(recordOf(rowOf(v.id)));
      }
      out.push({ id: v.id, ...(await advance(v.id, plan)) });
    }
    return out;
  }
  // THE LEADERBOARD PAYOUTS: from the payment height (and the vote decided) each guardian of the paying federation in
  // turn plans, signs and submits; PAID once the federation accepts the transaction - the winners' outputs are theirs then
  async function leaderboardRound({ height, feds }) {
    const out = [];
    for (const lb of leaderboards() || []) {
      const r = rowOf(lb.id);
      if (r && (r.state === PAYOUT.PAID || r.state === PAYOUT.SHORT)) continue;
      const g = feds.get(lb.federation);
      if (!g || !g.signer || !g.key) continue;
      const i = g.members.indexOf(me);
      const from = Math.max(Number(lb.paymentHeight), Number(lb.decidableAt));
      if (i < 0 || !(Number.isInteger(height) && height >= from + TAKEOVER_BLOCKS * i)) continue;
      let plan = planOfRow(r);
      if (!plan) {
        const short = (why) => { write(lb.id, { state: PAYOUT.SHORT, why, federation: lb.federation }); broadcast({ proposal: lb.id, state: PAYOUT.SHORT, why, federation: lb.federation });
          log(`[leaderboard] ${lb.id.slice(0, 16)}: SHORT - ${why}`); return { id: lb.id, state: PAYOUT.SHORT, why }; };
        const port = await portOf(lb.federation); if (!port) continue;
        const fees = await port.fees();
        const have = unspent(lb.federation);
        const heldSats = have.reduce((t, x) => t + BigInt(x.amountMsat), 0n) / 1000n;
        const cap = leaderboardCap({ amountSats: lb.amountSats, reservesSats: heldSats });
        if (!cap.ok) { out.push(short(cap.why)); continue; }
        const w = await winnersOf(lb.id);
        if (!w || !w.ok) { out.push({ id: lb.id, ok: false, why: w ? w.why : 'no winners read' }); continue; }   // read again next pass
        if (!w.winners.length) { out.push(short('the season names no identity to pay')); continue; }
        const winners = w.winners.map((x) => ({ player: x.player, payoutPk: String(x.payoutPk).toLowerCase(), msat: String(x.msat) }));
        const inputs = [];
        for (const x of have) { inputs.push({ outpoint: x.outpoint, amountMsat: String(x.amountMsat) }); if (leaderboardAmounts({ inputs, winners, fees }).covers) break; }
        const amounts = leaderboardAmounts({ inputs, winners, fees });
        if (!amounts.covers) { out.push(short(`the reserves there (${heldSats} sat) do not cover ${lb.amountSats} sat and the fees`)); continue; }
        plan = { kind: 'leaderboard', proposal: lb.id, federation: lb.federation, reserveKey: toHex(g.key), amountSats: String(lb.amountSats), winners,
          refunds: inputs, changeMsat: String(amounts.changeMsat), nonce: toHex(payoutNonce(lb.id)) };
        const st = await planStands(plan);
        if (!st.ok) { log(`[leaderboard] ${lb.id.slice(0, 16)}: own plan refused - ${st.why}`); out.push({ id: lb.id, ...st }); continue; }
        write(lb.id, { plan_id: st.planId, federation: lb.federation, state: PAYOUT.PLANNED, plan: JSON.stringify(plan) }); markInputs(lb.id, plan);
        broadcast(recordOf(rowOf(lb.id)));
      }
      const s = await sign(plan, 'tx');
      if (!s.ok) { out.push({ id: lb.id, ...s }); continue; }
      const port = await portOf(plan.federation);
      const tx = await port.settle({ claimPk: fromHex(plan.reserveKey), claims: [], refunds: plan.refunds.map((x) => ({ outpoint: outpointOf(x.outpoint), amountMsat: BigInt(x.amountMsat) })),
        payouts: payoutsOf({ plan: JSON.stringify(plan) }), nonce: fromHex(plan.nonce), signature: s.signature });
      if (!tx || !tx.accepted) { out.push({ id: lb.id, ...refuse(`the guardians refused the payout: ${tx ? tx.error : '?'}`) }); continue; }
      write(lb.id, { state: PAYOUT.PAID, txid: tx.txid, why: `${plan.winners.length} winner(s) paid ${plan.amountSats} sat in the federation` });
      for (const row of winnerRowsOf(plan, tx.txid)) keepRow(row);
      if (BigInt(plan.changeMsat) > 0n) keepRow(changeRowOf(plan, tx.txid));
      broadcast(recordOf(rowOf(lb.id)));
      log(`[leaderboard] ${lb.id.slice(0, 16)}: PAID ${plan.amountSats} sat to ${plan.winners.length} winner(s) (tx ${String(tx.txid).slice(0, 16)})`);
      out.push({ id: lb.id, ok: true, state: PAYOUT.PAID, txid: tx.txid });
    }
    return out;
  }
  const payAmountsCover = (have, contractMsat, fees) => payoutAmounts({ inputs: have, contractMsat, fees }).covers;

  // THE MOVES: each one the drained federation's guardians pay, then the destination's guardians claim
  async function moveRound({ height, feds }) {
    const out = [];
    const ids = new Set((moves() || []).map((m) => m.id));
    // a move PAID here is claimed by the destination's coordinator, whether or not the drained federation still lists it
    for (const r of db.prepare(`SELECT * FROM reserve_payouts WHERE state = 'PAID'`).all()) {
      const plan = planOfRow(r); if (!plan || plan.kind !== 'move') continue;
      const g = feds.get(plan.to); if (!g || !g.signer) continue;
      const i = g.members.indexOf(me);
      const from = Number(plan.decidableAt) || 0;   // the drain's height, as the plan names it (X's signers checked it)
      if (i < 0 || !(Number.isInteger(height) && height >= from + TAKEOVER_BLOCKS * (i + 1))) continue;
      out.push({ id: r.proposal, ...(await claimMove(r.proposal, plan)) });
    }
    // the moves the records call for, and those under way here (planned or sent: no longer listed once their inputs are spent)
    const todo = new Map((moves() || []).map((m) => { knownMoves.set(m.id, m); return [m.id, m]; }));
    for (const r of db.prepare(`SELECT * FROM reserve_payouts WHERE state IN ('PLANNED', 'SENT')`).all()) {
      const p = planOfRow(r); if (!p || p.kind !== 'move' || todo.has(r.proposal)) continue;
      const m = moveOf(r.proposal) || { id: r.proposal, from: p.federation, to: p.to, toKey: p.toKey, fromKey: p.reserveKey, decidableAt: 0 };
      todo.set(r.proposal, m);
    }
    for (const m of todo.values()) {
      const r = rowOf(m.id);
      if (r && r.state !== PAYOUT.PLANNED && r.state !== PAYOUT.SENT) continue;
      const g = feds.get(m.from);
      if (!g || !g.signer || !g.key) continue;
      const i = g.members.indexOf(me);
      if (i < 0 || !(Number.isInteger(height) && height >= m.decidableAt + TAKEOVER_BLOCKS * i)) continue;
      let plan = planOfRow(r);
      if (!plan) {
        const port = await portOf(m.from), to = await portOf(m.to);
        if (!port || !to) continue;
        const [fees, gws] = await Promise.all([port.fees(), port.gateways()]);
        const gw = lowestLiveGateway(gws.gateways || []); if (!gw) continue;
        const have = unspent(m.from);
        const amountSats = moveAmountSats(have, gw.sendFeeDefault, fees);
        if (amountSats <= 0n) { out.push({ id: m.id, ok: false, why: 'the reserves there do not cover the fees of a move' }); continue; }
        const invoiceMsat = amountSats * 1000n;
        const contractMsat = contractForInvoice(invoiceMsat, gw.sendFeeDefault);
        const inputs = [];
        for (const x of have) { inputs.push({ outpoint: x.outpoint, amountMsat: String(x.amountMsat) }); if (payoutAmounts({ inputs, contractMsat, fees }).covers) break; }
        // the destination's invoice, through the lowest live gateway of the destination
        const tg = lowestLiveGateway(((await to.gateways()) || {}).gateways || []);
        if (!tg) { out.push({ id: m.id, ok: false, why: 'the destination has no live gateway' }); continue; }
        let inv; try { inv = await to.receiveToKey({ claimPk: fromHex(m.toKey), amountMsat: invoiceMsat, seed: moveSeedOf(m.id), gateway: tg.url }); }
        catch (e) { out.push({ id: m.id, ok: false, why: `no invoice from the destination yet: ${e.message}` }); continue; }   // asked again next pass
        plan = { proposal: m.id, kind: 'move', decidableAt: String(m.decidableAt), federation: m.from, to: m.to, toKey: m.toKey, reserveKey: toHex(g.key), lnurl: `move:${m.to}`, amountSats: String(amountSats),
          invoiceMsat: String(invoiceMsat), contractMsat: String(contractMsat), changeMsat: '0', refunds: inputs,
          invoice: inv.invoice, paymentHash: String(inv.paymentHash).toLowerCase(), contractHex: inv.contractHex, gatewayUrl: gw.url,
          gatewayPk: String(gw.modulePublicKey).toLowerCase(), expiration: String(proposedExpiration(gws.height, gw)), nonce: toHex(payoutNonce(m.id)) };
        const st = await planStands(plan);
        if (!st.ok) { log(`[move] ${m.id.slice(0, 16)}: own plan refused - ${st.why}`); out.push({ id: m.id, ...st }); continue; }
        write(m.id, { plan_id: st.planId, federation: m.from, state: PAYOUT.PLANNED, plan: JSON.stringify(plan) }); markInputs(m.id, plan);
        broadcast(recordOf(rowOf(m.id)));
      }
      out.push({ id: m.id, ...(await advance(m.id, plan)) });
    }
    void ids;
    return out;
  }
  async function claimMove(pid, plan) {
    const s = await sign(plan, 'claim');
    if (!s.ok) return s;
    const to = await portOf(plan.to);
    const c = await to.claimIncoming({ contractHex: plan.contractHex, seed: moveSeedOf(pid), payoutPk: fromHex(plan.toKey), nonce: payoutNonce(pid, 'claim'), signature: s.signature });
    if (!c || !c.accepted) return refuse(`the destination's guardians refused the claim: ${c ? c.error : '?'}`);
    const msat = String(c.payout && c.payout.msat);
    write(pid, { state: PAYOUT.CLAIMED, claim_txid: c.txid, claim_msat: msat, why: `claimed into ${msat} msat under the destination's reserve key` });
    keepRow(claimRowOf(plan, c.txid, msat));
    broadcast(recordOf(rowOf(pid)));
    log(`[move] ${pid.slice(0, 16)}: CLAIMED ${msat} msat in ${String(plan.to).slice(0, 8)} (tx ${String(c.txid).slice(0, 16)})`);
    return { ok: true, state: PAYOUT.CLAIMED };
  }

  // PLANNED -> SENT -> PAID, or REFUNDED when the gateway left the contract to expire
  async function advance(pid, plan) {
    const port = await portOf(plan.federation);
    let r = rowOf(pid);
    if (r.state === PAYOUT.PLANNED) {
      const s = await sign(plan, 'tx');
      if (!s.ok) return s;
      const tx = await port.settle({ claimPk: fromHex(plan.reserveKey), claims: [], refunds: plan.refunds.map((x) => ({ outpoint: outpointOf(x.outpoint), amountMsat: BigInt(x.amountMsat) })),
        payouts: payoutsOf(r), nonce: fromHex(plan.nonce), signature: s.signature });
      if (!tx || !tx.accepted) return refuse(`the guardians refused the payout: ${tx ? tx.error : '?'}`);
      write(pid, { state: PAYOUT.SENT, txid: tx.txid, why: 'the payout transaction is accepted; the gateway is asked' });
      if (BigInt(plan.changeMsat) > 0n) keepRow(changeRowOf(plan, tx.txid));
      broadcast(recordOf(rowOf(pid)));
      r = rowOf(pid);
    }
    if (r.state !== PAYOUT.SENT) return { ok: true, state: r.state };
    const at = { txid: fromHex(r.txid), outIdx: 0n };
    const st = await port.status(at);
    if (st && st.stored && st.stored.blocksLeft <= 0) {
      // the gateway did not pay before the contract expired: spent back to the reserve key, recorded REFUNDED (no re-try here)
      const s = await sign(plan, 'refund', { txid: r.txid });
      if (!s.ok) return s;
      const fees = await port.fees();
      const back = largestPayoutMsat(fees, BigInt(plan.contractMsat));
      const tx = await port.settle({ claimPk: fromHex(plan.reserveKey), claims: [], refunds: [{ outpoint: at, amountMsat: BigInt(plan.contractMsat) }],
        payouts: [{ payoutPk: fromHex(plan.reserveKey), msat: back }], nonce: payoutNonce(pid, 'refund'), signature: s.signature });
      if (!tx || !tx.accepted) return refuse(`the guardians refused the refund: ${tx ? tx.error : '?'}`);
      write(pid, { state: PAYOUT.REFUNDED, refund_txid: tx.txid, why: `the gateway did not pay; ${back} msat back to the reserve key` });
      keepRow({ ...changeRowOf(plan, tx.txid), outpoint: { txid: fromHex(tx.txid), outIdx: 0n }, amountMsat: back, contractId: `payout-refund:${pid}`, item: 'payout refund' });
      broadcast(recordOf(rowOf(pid)));
      return { ok: true, state: PAYOUT.REFUNDED };
    }
    const a = await sign(plan, 'auth', { txid: r.txid });
    if (!a.ok) return a;
    const said = await port.send({ gateway: plan.gatewayUrl, outpoint: at, paymentHash: plan.paymentHash, amountMsat: BigInt(plan.contractMsat), expiration: BigInt(plan.expiration),
      claimPk: plan.gatewayPk, refundPk: fromHex(plan.reserveKey), invoice: plan.invoice, auth: a.signature });
    if (said && said.sent && said.preimage && toHex(sha256(said.preimage)) === plan.paymentHash) {
      write(pid, { state: PAYOUT.PAID, preimage: toHex(said.preimage), why: `the gateway at ${plan.gatewayUrl} paid ${plan.amountSats} sat to ${plan.lnurl}; its preimage checked` });
      broadcast(recordOf(rowOf(pid)));
      log(`[payout] ${pid.slice(0, 16)}: PAID ${plan.amountSats} sat to ${plan.lnurl} (tx ${r.txid.slice(0, 16)})`);
      return { ok: true, state: PAYOUT.PAID };
    }
    write(pid, { why: `the gateway did not pay yet: ${(said && said.why) || 'no preimage'}` });
    return refuse(`the gateway did not pay yet: ${(said && said.why) || 'no preimage'}`, 503);
  }

  return {
    round, commit, share, learn, planStands, payoutsOfRecord: (rec) => payoutsOf({ plan: JSON.stringify(rec.plan) }),
    stateOf: (pid) => { const r = rowOf(pid); return r ? recordOf(r) : null; },
    list: () => db.prepare('SELECT * FROM reserve_payouts ORDER BY updated_ms DESC').all().map(recordOf),
    spent: () => new Set(db.prepare('SELECT outpoint FROM reserve_payout_inputs').all().map((x) => x.outpoint)),
  };
}
