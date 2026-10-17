// THE PAYOUT OF A PASSED FUNDING PROPOSAL FROM THE PROTOCOL RESERVES (§27A.9.3 "Payout", kanban #397 slice 8, the owner 2026-10-17: "Accepted:
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

export const PAYOUT = Object.freeze({ PLANNED: 'PLANNED', SENT: 'SENT', PAID: 'PAID', REFUNDED: 'REFUNDED', SHORT: 'SHORT' });
export const TAKEOVER_BLOCKS = 2;
export const RESERVE_PAYOUT_SQL = `CREATE TABLE IF NOT EXISTS reserve_payouts (proposal TEXT PRIMARY KEY, plan_id TEXT, federation TEXT, state TEXT NOT NULL,
    plan TEXT, txid TEXT, preimage TEXT, refund_txid TEXT, why TEXT, updated_ms INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS reserve_payout_inputs (outpoint TEXT PRIMARY KEY, proposal TEXT NOT NULL)`;

const refuse = (why, status = 422) => ({ ok: false, status, why });
const utf8 = (s) => new TextEncoder().encode(s);
const PLAN_KEYS = ['proposal', 'federation', 'reserveKey', 'lnurl', 'amountSats', 'invoiceMsat', 'contractMsat', 'changeMsat', 'refunds', 'invoice',
  'paymentHash', 'gatewayUrl', 'gatewayPk', 'expiration', 'nonce'];
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
 * `db`; `me` this seat's node key (hex); `curve` and `random` for FROST; `passed()` -> [{ id, lnurl, amountSats, decidableAt }] the
 * proposals whose vote THIS seat decided passed; `guardians()` -> Map fedHex -> { members: [hex] sorted, key (33 bytes) or null,
 * signer { id, share } or null, needed, peers: [{ commit(body), share(body) }] }; `reserveRows(fedHex)` -> [{ outpoint, amountMsat,
 * verifiedMs }] under that federation's reserve key; `portOf(fedHex)`; `payRequest(lnurl, msat)` and `invoiceFor(lnurl, msat)` as
 * winnings-send.js; `network`; `keepRow(row)` a reserve row to keep (putDonationOutputs' shape); `broadcast(record)` to every seat.
 */
export function createReservePayouts({ db, me, curve, random, passed, guardians, reserveRows, portOf, payRequest, invoiceFor, network = 'testnet',
  keepRow = () => {}, broadcast = () => {}, log = () => {}, now = () => Date.now() }) {
  db.exec(RESERVE_PAYOUT_SQL);
  // `${planId}:${kind}` -> [{ message, hiding, binding, commitment, list, share }]: a nonce pair signs ONE list, once; a coordinator taking
  // over opens a new session, and gets a fresh pair - a used pair is never offered again (FROST: one nonce pair, one signature)
  const pairs = new Map();
  const rowOf = (pid) => db.prepare('SELECT * FROM reserve_payouts WHERE proposal = ?').get(pid) || null;
  const planOfRow = (r) => (r && r.plan ? JSON.parse(r.plan) : null);
  const spentBy = (outpoint) => { const r = db.prepare('SELECT proposal FROM reserve_payout_inputs WHERE outpoint = ?').get(outpoint); return r ? r.proposal : null; };
  const write = (pid, fields) => {
    const had = rowOf(pid);
    const r = { plan_id: null, federation: null, plan: null, txid: null, preimage: null, refund_txid: null, why: null, ...(had || {}), ...fields, proposal: pid, updated_ms: now() };
    db.prepare(`INSERT OR REPLACE INTO reserve_payouts (proposal, plan_id, federation, state, plan, txid, preimage, refund_txid, why, updated_ms)
      VALUES (@proposal, @plan_id, @federation, @state, @plan, @txid, @preimage, @refund_txid, @why, @updated_ms)`).run(r);
    return r;
  };
  const markInputs = (pid, plan) => { for (const x of plan.refunds) db.prepare('INSERT OR IGNORE INTO reserve_payout_inputs (outpoint, proposal) VALUES (?, ?)').run(x.outpoint, pid); };
  const unspent = (fed) => (reserveRows(fed) || []).filter((r) => { const s = spentBy(r.outpoint); return !s; })
    .sort((a, b) => (a.verifiedMs - b.verifiedMs) || (a.outpoint < b.outpoint ? -1 : 1));
  const recordOf = (r) => ({ proposal: r.proposal, planId: r.plan_id, federation: r.federation, state: r.state, plan: planOfRow(r), txid: r.txid,
    preimage: r.preimage, refundTxid: r.refund_txid, why: r.why });
  const payoutsOf = (pr) => {
    const p = planOfRow(pr);
    const outs = [{ payoutPk: fromHex(p.reserveKey), msat: BigInt(p.contractMsat), sent: { paymentHash: p.paymentHash, gatewayPk: p.gatewayPk, expiration: BigInt(p.expiration) } }];
    if (BigInt(p.changeMsat) > 0n) outs.push({ payoutPk: fromHex(p.reserveKey), msat: BigInt(p.changeMsat) });
    return outs;
  };
  const changeRowOf = (plan, txid) => ({ outpoint: { txid: fromHex(txid), outIdx: 1n }, entryId: fromHex(plan.proposal), roundId: new Uint8Array(32),
    federationId: fromHex(plan.federation), recipientPk: fromHex(plan.reserveKey), amountMsat: BigInt(plan.changeMsat), contractId: `payout-change:${plan.proposal}`,
    senderOnContract: false, item: 'payout change' });

  // WHAT THE FEDERATION IS ASKED TO SIGN, rebuilt here from the plan: the transaction (`tx`), the gateway's auth (`auth`), or the
  // refund of an expired contract back to the reserve key (`refund`)
  async function messageFor(kind, plan, extra = {}) {
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
    const vote = (passed() || []).find((p) => p.id === plan.proposal);
    if (!vote) return refuse('this seat has no passed vote for that proposal');
    if (vote.lnurl !== plan.lnurl || String(vote.amountSats) !== String(plan.amountSats)) return refuse('the plan pays another LNURL or amount than the proposal');
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
    const contractMsat = contractForInvoice(invoiceMsat, gw.sendFeeDefault);
    if (String(plan.contractMsat) !== String(contractMsat)) return refuse(`the contract is ${plan.contractMsat} msat, and an invoice of ${invoiceMsat} at that gateway's fee needs ${contractMsat}`);
    const amounts = payoutAmounts({ inputs: plan.refunds, contractMsat, fees });
    if (!amounts.covers) return refuse('the inputs do not cover the contract and its fee');
    const lastIn = plan.refunds.length ? BigInt(plan.refunds[plan.refunds.length - 1].amountMsat) : 0n;
    if (plan.refunds.length > 1 && amounts.total - lastIn >= contractMsat + amounts.contractFee) return refuse('the plan spends more reserve outputs than X plus fees needs');
    if (String(plan.changeMsat) !== String(amounts.changeMsat)) return refuse(`the change is ${plan.changeMsat} msat, and those inputs leave ${amounts.changeMsat}`);
    if (late) return { ok: true, planId: pid, signer: g };
    const pr = await payRequest(plan.lnurl, invoiceMsat);
    if (!pr.ok) return refuse(`the LNURL did not answer here: ${pr.why}`, 503);
    const st = sendPlanStands({ plan: { invoice: plan.invoice, paymentHash: plan.paymentHash, gatewayUrl: plan.gatewayUrl, gatewayPk: plan.gatewayPk, expiration: plan.expiration },
      payoutMsat: contractMsat, gateways: gws.gateways || [], height: gws.height, metadata: pr.metadata, network });
    if (!st.ok) return refuse(st.why);
    return { ok: true, planId: pid, signer: g };
  }

  // FROST, ROUND ONE: a commitment to the message of `kind` this seat rebuilt for that plan (taken, and recorded as PLANNED, only once
  // the plan stands here)
  async function commit({ plan, kind, txid = null }) {
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
    const message = await messageFor(kind, plan, { txid });
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
    const r = db.prepare('SELECT federation FROM reserve_payouts WHERE plan_id = ?').get(planId);
    const g = r && guardians().get(r.federation);
    if (!g || !g.signer) return refuse('this seat holds no share of that reserve key');
    if (commitments.length < g.needed) return refuse(`${commitments.length} commitments, and the reserve key signs at ${g.needed}`);
    const list = commitments.map((c) => `${c.id}:${toHex(c.hiding)}:${toHex(c.binding)}`).join('|');
    if (pair.list && pair.list !== list) return refuse('this seat signed that message over another list');
    if (pair.share === null) { pair.share = signShare340({ id: g.signer.id, share: g.signer.share, groupPublicKey: g.key, nonces: { hiding: pair.hiding, binding: pair.binding }, message: pair.message, commitments, curve }); pair.list = list; }
    return { ok: true, share: pair.share };
  }
  // THE COORDINATOR'S SIGNATURE of `kind`: its own commitment and the peers', then their shares, aggregated and checked under the key
  async function sign(plan, kind, extra = {}) {
    const g = guardians().get(plan.federation);
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
    if (rec.state === PAYOUT.PAID && !(rec.preimage && toHex(sha256(fromHex(rec.preimage))) === rec.plan.paymentHash)) return refuse('that preimage is not the invoice\'s');
    // A GUARDIAN OF THAT FEDERATION keeps a plan it was told about only when the plan stands on its own records: a forged plan
    // would otherwise hold the proposal's one place here and refuse the real one
    const g = guardians().get(rec.plan.federation);
    if (g && g.signer && !(had && had.plan_id === rec.planId)) { const st = await planStands(rec.plan, { late: rec.state !== PAYOUT.PLANNED }); if (!st.ok) return st; }
    const rank = { [PAYOUT.PLANNED]: 0, [PAYOUT.SENT]: 1, [PAYOUT.PAID]: 2, [PAYOUT.REFUNDED]: 2 };
    if (had && (had.state === PAYOUT.PAID || had.state === PAYOUT.REFUNDED || had.state === PAYOUT.SHORT || rank[had.state] > rank[rec.state])) return { ok: true, kept: had.state };
    write(rec.proposal, { plan_id: rec.planId, federation: rec.plan.federation, state: rec.state, plan: JSON.stringify(rec.plan), txid: rec.txid || (had && had.txid) || null,
      preimage: rec.preimage || null, refund_txid: rec.refundTxid || null, why: rec.why || null });
    markInputs(rec.proposal, rec.plan);
    if (rec.txid && BigInt(rec.plan.changeMsat) > 0n) keepRow(changeRowOf(rec.plan, rec.txid));
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
  const payAmountsCover = (have, contractMsat, fees) => payoutAmounts({ inputs: have, contractMsat, fees }).covers;

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
