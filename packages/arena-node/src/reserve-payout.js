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
//                 Every write is one compare-and-set step along PAYOUT_NEXT (kanban #1156); a record from another seat is kept only signed
//                 by a guardian seat of the federation whose step it is, a SHORT only as this seat's reserves say it, a step past PLANNED
//                 only as the federation says it.
//                 A seat's own steps (kanban #1159): SUBMITTING and REFUNDING - the signed transaction or refund kept before it goes in, so
//                 a stop hands in the same one again; EXPIRED - no transaction PLAN_EXPIRY_BLOCKS after this seat first held the plan and every
//                 input unspent in the federation: its inputs are freed and the turn's guardian plans the next attempt (its own nonce).
//                 Only the turn's guardian opens a plan, by signed asks; a plan held goes on with any guardian, its window checked once.
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
import { moveSeedOf, moveSeedFor } from './reserve-move.js';
import { leaderboardCap } from '../../arena-protocol/src/leaderboard-winners.js';
import { payeeOf } from './winnings-send.js';

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

// SUBMITTING, REFUNDING and EXPIRED are this seat's own (kanban #1159): the signed transaction (or refund) kept before it is handed to the
// federation, and a plan that went nowhere in PLAN_EXPIRY_BLOCKS. No other seat is told them.
export const PAYOUT = Object.freeze({ PLANNED: 'PLANNED', SUBMITTING: 'SUBMITTING', SENT: 'SENT', REFUNDING: 'REFUNDING', PAID: 'PAID', REFUNDED: 'REFUNDED',
  SHORT: 'SHORT', CLAIMED: 'CLAIMED', EXPIRED: 'EXPIRED' });
/** The states a record from another seat may carry (kanban #1159): never a seat's own SUBMITTING, REFUNDING or EXPIRED. */
export const PAYOUT_SAID = Object.freeze([PAYOUT.PLANNED, PAYOUT.SENT, PAYOUT.PAID, PAYOUT.REFUNDED, PAYOUT.SHORT, PAYOUT.CLAIMED]);
/**
 * THE ONE TRANSITION TABLE (kanban #1156, #1159): from a state (NONE: no record yet) to the states it may go to, and no other. Every write
 * of a payout record is one compare-and-set step along it (`transition`); REFUNDED, SHORT and CLAIMED go nowhere, PAID only to CLAIMED (a
 * move). EXPIRED ends one attempt: the next attempt's PLANNED, or the expired plan's own transaction found landed after all.
 */
export const PAYOUT_NEXT = Object.freeze({
  NONE: [PAYOUT.PLANNED, PAYOUT.SENT, PAYOUT.PAID, PAYOUT.REFUNDED, PAYOUT.SHORT, PAYOUT.CLAIMED],
  [PAYOUT.PLANNED]: [PAYOUT.SUBMITTING, PAYOUT.SENT, PAYOUT.PAID, PAYOUT.REFUNDED, PAYOUT.CLAIMED, PAYOUT.EXPIRED],
  [PAYOUT.SUBMITTING]: [PAYOUT.SENT, PAYOUT.PAID, PAYOUT.REFUNDED, PAYOUT.CLAIMED],
  [PAYOUT.SENT]: [PAYOUT.REFUNDING, PAYOUT.PAID, PAYOUT.REFUNDED, PAYOUT.CLAIMED],
  [PAYOUT.REFUNDING]: [PAYOUT.REFUNDED, PAYOUT.PAID],
  [PAYOUT.PAID]: [PAYOUT.CLAIMED],
  [PAYOUT.EXPIRED]: [PAYOUT.PLANNED, PAYOUT.SENT, PAYOUT.PAID, PAYOUT.REFUNDED],
  [PAYOUT.REFUNDED]: [], [PAYOUT.SHORT]: [], [PAYOUT.CLAIMED]: [],
});
/** A PLAN THAT WENT NOWHERE (kanban #1159): no transaction this many blocks after this seat first held it - its inputs are freed. */
export const PLAN_EXPIRY_BLOCKS = 12;
export const canMove = (from, to) => (PAYOUT_NEXT[from || 'NONE'] || []).includes(to);
/** WHAT A PAYOUT RECORD'S SIGNATURE COVERS (kanban #1156): every field it carries, the seat that says it last. */
const RECORD_FIELDS = ['proposal', 'planId', 'federation', 'state', 'plan', 'txid', 'preimage', 'refundTxid', 'why', 'claimTxid', 'claimMsat', 'from'];
export const recordDigestOf = (rec) => taggedHash('ARENA/v1/ReservePayoutRecord', new TextEncoder().encode(JSON.stringify(RECORD_FIELDS.map((k) => (rec[k] === undefined ? null : rec[k])))));
export const TAKEOVER_BLOCKS = 2;
export const RESERVE_PAYOUT_SQL = `CREATE TABLE IF NOT EXISTS reserve_payouts (proposal TEXT PRIMARY KEY, plan_id TEXT, federation TEXT, state TEXT NOT NULL,
    plan TEXT, txid TEXT, preimage TEXT, refund_txid TEXT, why TEXT, updated_ms INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS reserve_payout_inputs (outpoint TEXT PRIMARY KEY, proposal TEXT NOT NULL)`;

const refuse = (why, status = 422) => ({ ok: false, status, why });
const utf8 = (s) => new TextEncoder().encode(s);
const PLAN_KEYS = ['proposal', 'federation', 'reserveKey', 'lnurl', 'amountSats', 'invoiceMsat', 'contractMsat', 'changeMsat', 'refunds', 'invoice',
  'paymentHash', 'gatewayUrl', 'gatewayPk', 'expiration', 'nonce', 'kind', 'to', 'toKey', 'contractHex', 'decidableAt', 'seedTag'];
/** A plan's id: the tagged hash of its fields in one order - what a second plan for the same proposal is told apart by. A leaderboard
 *  plan's id names its winners list too (kanban #1153: `winnersId`, leaderboard-freeze.js winnersIdOf), so two lists are two plans. */
export const planIdOf = (plan) => toHex(taggedHash('ARENA/v1/ReservePayoutPlan', utf8(JSON.stringify([...PLAN_KEYS, ...(plan && plan.kind === 'leaderboard' ? ['winnersId'] : [])].map((k) => plan[k])))));
/** The transaction nonce, the proposal's own: every signer rebuilds the same transaction. 8 bytes, a federation transaction's
 *  nonce (kanban #326, measured 2026-10-22 on second-host seat 4: the 32-byte hash was refused, "--nonce is 8 bytes", so no move could start). */
export const payoutNonce = (proposalHex, kind = 'pay') => taggedHash('ARENA/v1/ReservePayoutNonce', utf8(`${kind}:${proposalHex}`)).subarray(0, 8);
/** A PLAN'S ATTEMPT (kanban #1159): 0 for the first plan of a proposal (no field: as before), n for the plan after n expired ones. */
export const attemptOf = (plan) => { const n = Number(plan && plan.attempt !== undefined ? plan.attempt : 0); return Number.isSafeInteger(n) && n >= 0 ? n : -1; };
/** The nonce of `kind` for that attempt: the first attempt's as before, a later one in its own `kind:attempt` domain - a new plan id. */
export const nonceOf = (proposalHex, attempt = 0, kind = 'pay') => payoutNonce(proposalHex, attempt > 0 ? `${kind}:${attempt}` : kind);
/** WHO MAY OPEN A PLAN AT A HEIGHT (kanban #1159): the guardian seat whose turn it is - each one for TAKEOVER_BLOCKS from `start`, in key order, round again. */
export const turnOf = (members, start, height) => (Number.isInteger(height) && Number.isInteger(start) && height >= start && members.length
  ? members[Math.floor((height - start) / TAKEOVER_BLOCKS) % members.length] : null);
const ASK_FIELDS = (a) => [a.ask, a.kind, a.planId, a.txid === undefined ? null : a.txid, a.list === undefined ? null : a.list, a.from];
/** WHAT A SIGNED ASK COVERS (kanban #1159): a commit or share asked of a guardian seat, by the guardian seat that asks it. */
export const askDigestOf = (a) => taggedHash('ARENA/v1/ReservePayoutAsk', new TextEncoder().encode(JSON.stringify(ASK_FIELDS(a))));
export const commitmentListOf = (commitments) => commitments.map((c) => `${c.id}:${toHex(c.hiding)}:${toHex(c.binding)}`).join('|');
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
 * `payeeFor(lnurl, msat)` -> { ok, payee } the node key of an invoice THIS seat fetched from the address for that amount (kanban #1154:
 * sendPlanStands takes a plan only when its invoice is signed by the same key); by default this seat's own `invoiceFor`, read by payeeOf.
 */
// `leaderboards()` -> [{ id, federation (hex), amountSats, paymentHeight, decidableAt }] the leaderboard payouts whose vote passed here;
// `winners` the seat's winners book (leaderboard-freeze.js createWinnersBook, kanban #1153): its own frozen read of the season's SIGNED
// accounts, the list a plan carries checked against it, and that list persisted before this seat commits. A guardian peer's `winners(id)`
// is its GET /leaderboard-winners. With no book a leaderboard payout is never planned or signed.
const NO_WINNERS = { freeze: async () => ({ ok: false, why: 'this seat keeps no winners book' }), union: async () => ({ ok: false, why: 'this seat keeps no winners book' }),
  check: async () => ({ ok: false, status: 503, why: 'this seat keeps no winners book' }), plan: () => ({ ok: false, status: 503, why: 'this seat keeps no winners book' }) };
// `sign(digest)` this seat's node-key signature (BIP-340) over a 32-byte digest: every record it hands on is signed (kanban #1156); a seat
// without it hands on records nobody keeps. `keepRow` must keep a row once and throw on an outpoint kept with other fields: it runs inside
// the record's transition, and a throw undoes the whole step.
export function createReservePayouts({ db, me, curve, random, passed, guardians, reserveRows, portOf, payRequest, invoiceFor, network = 'testnet',
  keepRow = () => {}, broadcast = () => {}, log = () => {}, now = () => Date.now(), moves = () => [], leaderboards = () => [], winners: winnersBook = NO_WINNERS,
  sign: signNode = null, heightNow = () => null, payeeFor = null }) {
  db.exec(RESERVE_PAYOUT_SQL);
  const ownPayee = payeeFor || (async (lnurl, msat) => {
    const inv = await invoiceFor(lnurl, msat);
    if (!inv || !inv.ok) return inv || refuse('no answer', 503);
    try { return { ok: true, payee: payeeOf(inv.invoice) }; } catch (e) { return refuse(`the address's own invoice names no payee: ${e.message}`); }
  });
  // A MOVE'S CLAIM (the drained-federation move): the destination's claim transaction and what it put under its reserve key
  for (const col of ['claim_txid', 'claim_msat']) if (!db.prepare('PRAGMA table_info(reserve_payouts)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE reserve_payouts ADD COLUMN ${col} TEXT`);
  // kanban #1159: the height this seat first held the plan at, its attempt, and the signed transaction / refund kept before it is handed in
  for (const [col, type] of [['planned_at', 'INTEGER'], ['attempt', 'INTEGER'], ['submit_sig', 'TEXT'], ['refund_sig', 'TEXT']])
    if (!db.prepare('PRAGMA table_info(reserve_payouts)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE reserve_payouts ADD COLUMN ${col} ${type}`);
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
  /**
   * THE ONE WRITE OF A PAYOUT RECORD (kanban #1156): `from` -> `to` along PAYOUT_NEXT, compare-and-set - the row must still be in `from`
   * (none for a new record) or nothing is written. In the same database step: `fields` (column names), the plan's inputs marked spent
   * (`plan`; an input another payout holds undoes the step) and the derived reserve rows (`rows`, keepRow). All of it or none of it.
   */
  const COLS = ['plan_id', 'federation', 'plan', 'txid', 'preimage', 'refund_txid', 'why', 'claim_txid', 'claim_msat', 'planned_at', 'attempt', 'submit_sig', 'refund_sig'];
  // `release`: the inputs this proposal held are freed first (kanban #1159: an expired plan, or the plan that replaces it)
  function transition(pid, from, to, fields = {}, { plan = null, rows = [], release = false } = {}) {
    if (!canMove(from, to)) return refuse(`a payout does not go from ${from || 'no record'} to ${to}`, 409);
    const set = Object.fromEntries(Object.entries(fields).filter(([k, v]) => COLS.includes(k) && v !== undefined));
    db.exec('SAVEPOINT reserve_payout_step');
    try {
      if (!from) {
        const r = { ...Object.fromEntries(COLS.map((c) => [c, null])), ...set, proposal: pid, state: to, updated_ms: now() };
        const c = db.prepare(`INSERT OR IGNORE INTO reserve_payouts (proposal, plan_id, federation, state, plan, txid, preimage, refund_txid, why, updated_ms, claim_txid, claim_msat,
          planned_at, attempt, submit_sig, refund_sig)
          VALUES (@proposal, @plan_id, @federation, @state, @plan, @txid, @preimage, @refund_txid, @why, @updated_ms, @claim_txid, @claim_msat, @planned_at, @attempt, @submit_sig, @refund_sig)`).run(r);
        if (c.changes !== 1) throw new Error(`a record of that payout is kept already: not ${to} from nothing`);
      } else {
        const keys = Object.keys(set);
        const c = db.prepare(`UPDATE reserve_payouts SET state = @state, updated_ms = @updated_ms${keys.map((k) => `, ${k} = @${k}`).join('')} WHERE proposal = @proposal AND state = @from`)
          .run({ ...set, state: to, updated_ms: now(), proposal: pid, from });
        if (c.changes !== 1) throw new Error(`that payout is no longer ${from} here: not moved to ${to}`);
      }
      if (release) db.prepare('DELETE FROM reserve_payout_inputs WHERE proposal = ?').run(pid);
      if (plan) for (const x of plan.refunds || []) {
        const sb = spentBy(x.outpoint);
        if (sb && sb !== pid) throw new Error(`${String(x.outpoint).slice(0, 16)}… is spent by another payout`);
        db.prepare('INSERT OR IGNORE INTO reserve_payout_inputs (outpoint, proposal) VALUES (?, ?)').run(x.outpoint, pid);
      }
      for (const row of rows) keepRow(row);
      db.exec('RELEASE reserve_payout_step');
      return { ok: true, state: to };
    } catch (e) {
      db.exec('ROLLBACK TO reserve_payout_step'); db.exec('RELEASE reserve_payout_step');
      return refuse(e.message, 409);
    }
  }
  /** What a step said, kept on the record without moving it (only while it is still in `state`). */
  const note = (pid, state, why) => db.prepare('UPDATE reserve_payouts SET why = ?, updated_ms = ? WHERE proposal = ? AND state = ?').run(why, now(), pid, state);
  // A RECORD HANDED ON, signed by this seat's node key (kanban #1156): the record the others keep, and who said it
  const signed = (rec) => { const r = { ...rec, from: me }; return signNode ? { ...r, sig: toHex(signNode(recordDigestOf(r))) } : r; };
  const say = (rec) => broadcast(signed(rec));
  // THE STATES A PASS LEAVES ALONE, and the fields a new attempt starts from (kanban #1159)
  const DONE = new Set([PAYOUT.PAID, PAYOUT.SHORT, PAYOUT.REFUNDED, PAYOUT.CLAIMED]);
  const FRESH = { txid: null, preimage: null, refund_txid: null, submit_sig: null, refund_sig: null, why: null, claim_txid: null, claim_msat: null };
  // THIS SEAT'S CHAIN HEIGHT (kanban #1159): what `heightNow` says, else the height its last pass ran at
  let lastHeight = null;
  const tipNow = () => { let h = null; try { h = Number(heightNow()); } catch { h = null; } return Number.isInteger(h) && h > 0 ? h : lastHeight; };
  const unspent = (fed, alsoBy = null) => (reserveRows(fed) || []).filter((r) => { const s = spentBy(r.outpoint); return !s || (alsoBy && s === alsoBy); })
    .sort((a, b) => (a.verifiedMs - b.verifiedMs) || (a.outpoint < b.outpoint ? -1 : 1));
  const recordResent = new Set();
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
      const c = await to.claimIncoming({ contractHex: plan.contractHex, seed: moveSeedFor(plan), payoutPk: fromHex(plan.toKey), nonce: nonceOf(plan.proposal, attemptOf(plan), 'claim'), waitS: 30 });
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
        payouts: [{ payoutPk: key, msat: largestPayoutMsat(fees, BigInt(plan.contractMsat)) }], nonce: nonceOf(plan.proposal, attemptOf(plan), 'refund') });
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
  // A LATER ATTEMPT over a plan that expired here (kanban #1159): the one way a second plan of a proposal is taken
  const laterAttempt = (had, plan) => had.state === PAYOUT.EXPIRED && attemptOf(plan) > attemptOf(planOfRow(had));
  async function planStands(plan, { late = false, evidence = [] } = {}) {
    if (!plan || typeof plan !== 'object') return refuse('no plan');
    if (plan.kind === 'leaderboard') return leaderboardPlanStands(plan, { late, evidence });
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
    if (had && had.plan_id !== pid && !late && !laterAttempt(had, plan)) return refuse(`a payout of that proposal is already ${had.state} here (plan ${String(had.plan_id || '-').slice(0, 16)}): no second plan`, 409);
    if (attemptOf(plan) < 0 || plan.nonce !== toHex(nonceOf(plan.proposal, attemptOf(plan)))) return refuse('the plan carries another nonce than the proposal\'s for its attempt');
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
    // THE GATEWAY AND ITS FEE ARE READ ONCE, at the first commit (kanban #1159): a plan held or past PLANNED (`late`) is not refused
    // because the gateway or its fee moved since - its contract amount is the plan's
    const [fees, gws] = await Promise.all([port.fees(), late ? null : port.gateways()]);
    const gw = late ? null : lowestLiveGateway(gws.gateways || []);
    if (!late && !gw) return refuse('this seat sees no live gateway on that federation', 503);
    const invoiceMsat = BigInt(plan.amountSats) * 1000n;
    if (String(plan.invoiceMsat) !== String(invoiceMsat)) return refuse('the invoice is not for exactly the proposal\'s amount');
    // a move takes all the reserves this seat holds unspent in the drained federation, less the fees: the amount is rebuilt here
    if (isMove && !late) {
      const most = moveAmountSats(unspent(plan.federation, plan.proposal), gw.sendFeeDefault, fees);
      if (String(most) !== String(plan.amountSats)) return refuse(`the move is ${plan.amountSats} sat, and the reserves this seat holds there move ${most} sat`);
    }
    let contractMsat;
    try { contractMsat = late ? BigInt(plan.contractMsat) : contractForInvoice(invoiceMsat, gw.sendFeeDefault); } catch { return refuse('the plan names no contract amount'); }
    if (contractMsat < invoiceMsat) return refuse('the contract is less than the invoice');
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
      let c; try { c = await to.claimIncoming({ contractHex: plan.contractHex, seed: moveSeedFor(plan), payoutPk: fromHex(plan.toKey), nonce: nonceOf(plan.proposal, attemptOf(plan), 'claim'), waitS: 0 }); }
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
    // WHO THE PLAN PAYS (kanban #1154, as the winnings sender checks it): an invoice of this seat's own from the address, for the same
    // amount - the plan's invoice must be signed by that invoice's node key, or anyone's invoice with the public description hash stands
    const said = await ownPayee(plan.lnurl, invoiceMsat);
    if (!said || !said.ok) return refuse(`this seat could not read the address's own invoice: ${said ? said.why : 'no answer'}`, 503);
    const st = sendPlanStands({ plan: { invoice: plan.invoice, paymentHash: plan.paymentHash, gatewayUrl: plan.gatewayUrl, gatewayPk: plan.gatewayPk, expiration: plan.expiration },
      payoutMsat: contractMsat, gateways: gws.gateways || [], height: gws.height, metadata: pr.metadata, network, payee: said.payee, payeeOf });
    if (!st.ok) return refuse(st.why);
    return { ok: true, planId: pid, signer: g };
  }

  /**
   * DOES A LEADERBOARD PLAN STAND HERE - a signer's own rebuild: the vote passed in its own record and the payment height is
   * reached; its own key of that federation; no other plan for it; every input one of its own unspent reserve outputs at that amount and
   * no more of them than the payout needs; the winners exactly what the plan's signed rounds give, none of the rounds of this seat's own
   * frozen read left out (winners book `check`, kanban #1153); at most 10 % of that federation's reserves; the change as those inputs
   * leave it. `bind` in the answer: the list to persist (book `plan`) before this seat commits.
   */
  async function leaderboardPlanStands(plan, { late = false, evidence = [] } = {}) {
    const lb = (leaderboards() || []).find((x) => x.id === plan.proposal);
    if (!lb) return refuse('this seat has no passed leaderboard payout of that id');
    if (lb.federation !== plan.federation || String(lb.amountSats) !== String(plan.amountSats)) return refuse('the plan pays from another federation or another amount than the request');
    const g = guardians().get(plan.federation);
    if (!g || !g.key || toHex(g.key) !== plan.reserveKey) return refuse('the plan names another reserve key than this seat holds for that federation');
    const pid = planIdOf(plan);
    const had = rowOf(plan.proposal);
    if (had && had.plan_id !== pid && !late && !laterAttempt(had, plan)) return refuse(`a payout of that request is already ${had.state} here (plan ${String(had.plan_id || '-').slice(0, 16)}): no second plan`, 409);
    if (attemptOf(plan) < 0 || plan.nonce !== toHex(nonceOf(plan.proposal, attemptOf(plan)))) return refuse('the plan carries another nonce than the request\'s for its attempt');
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
    // THE WINNERS: never read again here - the plan's list, checked against this seat's frozen read and the signed rounds it names
    const fetchPeers = async () => (await Promise.all((g.peers || []).map(async (p) => { try { return typeof p.winners === 'function' ? await p.winners(plan.proposal) : null; } catch { return null; } })))
      .filter((x) => x && Array.isArray(x.evidence)).map((x) => x.evidence);
    const w = await winnersBook.check(plan.proposal, plan, { evidence, fetch: fetchPeers });
    if (!w || !w.ok) return refuse(`the plan's winners do not stand here: ${w ? w.why : '?'}`, (w && w.status) || 422);
    return { ok: true, planId: pid, signer: g, bind: w.bind };
  }
  // A LEADERBOARD PLAN'S LIST, PERSISTED (winners FROZEN -> PLANNED) before anything is written or signed for it
  const bindWinners = (plan, st) => (plan && plan.kind === 'leaderboard' ? (st && st.bind ? winnersBook.plan(plan.proposal, st.bind) : refuse('no winners list to persist for that plan', 503)) : { ok: true });

  /**
   * A SIGNED ASK (kanban #1159): a commit or a share asked of this seat is signed by the guardian seat that asks it, a guardian seat of the
   * federation whose key signs. An outsider's plan opens nothing here.
   */
  function askStands(ask, fed) {
    if (typeof ask.from !== 'string' || !/^[0-9a-f]{64}$/.test(ask.from) || typeof ask.sig !== 'string' || !/^[0-9a-f]{128}$/.test(ask.sig))
      return refuse('an ask is signed by the guardian seat that asks it (from, sig)', 401);
    let good = false; try { good = schnorr.verify(fromHex(ask.sig), askDigestOf(ask), fromHex(ask.from)); } catch { good = false; }
    if (!good) return refuse('that ask\'s signature does not verify under its from key', 401);
    const g = typeof fed === 'string' ? guardians().get(fed) : null;
    if (!g || !(g.members || []).includes(ask.from)) return refuse(`${ask.from.slice(0, 16)}… is no guardian seat of that federation`, 403);
    return { ok: true, from: ask.from };
  }
  const askOf = (fields) => { const a = { ...fields, from: me }; return signNode ? { ...a, sig: toHex(signNode(askDigestOf(a))) } : a; };
  // THE HEIGHT A PAYOUT'S TURNS COUNT FROM: the vote's decision, a leaderboard's payment height (or its decision, the later), a move's drain
  function startOf(plan) {
    if (plan.kind === 'move') { const m = moveOf(plan.proposal); const h = Number(m ? m.decidableAt : plan.decidableAt); return Number.isInteger(h) ? h : null; }
    if (plan.kind === 'leaderboard') { const lb = (leaderboards() || []).find((x) => x.id === plan.proposal); return lb ? Math.max(Number(lb.paymentHeight), Number(lb.decidableAt)) : null; }
    const v = (passed() || []).find((p) => p.id === plan.proposal);
    return v && Number.isInteger(Number(v.decidableAt)) ? Number(v.decidableAt) : null;
  }
  /**
   * WHO OPENS A PLAN HERE (kanban #1159): only the guardian seat whose turn it is at this seat's height (turnOf; the turn before too, for a
   * seat a block behind). A plan this seat already holds goes on with any of its guardians; a plan that splits the signers expires.
   */
  function mayOpen(plan, from) {
    if (from === me) return { ok: true };
    const g = guardians().get(plan.federation);
    if (!g) return refuse('this seat holds no guardian set for that federation', 409);
    const h = tipNow(), start = startOf(plan);
    if (!Number.isInteger(h)) return refuse('this seat has read no chain height yet: it opens no plan', 503);
    if (!Number.isInteger(start)) return refuse('this seat holds no start height for that payout: it opens no plan', 409);
    const turns = [h, h + 1, h - TAKEOVER_BLOCKS].map((x) => turnOf(g.members || [], start, x));
    if (!turns.includes(from)) return refuse(`${from.slice(0, 16)}… is not the guardian seat whose turn it is to open a plan at height ${h}`, 409);
    return { ok: true };
  }
  /**
   * PLANNED -> EXPIRED (kanban #1159): a plan this seat has held PLAN_EXPIRY_BLOCKS with no transaction. The federation is read first: a
   * transaction of the plan that landed (its output 0 held) moves it on instead; an input spent by anything keeps it PLANNED until the
   * record of that spend arrives. Only when every input is still unspent are they freed, and a later attempt may be planned.
   */
  async function expireIfDue(r) {
    const h = tipNow();
    if (!r || r.state !== PAYOUT.PLANNED || !Number.isInteger(h)) return { expired: false };
    if (r.planned_at === null || r.planned_at === undefined) {
      db.prepare('UPDATE reserve_payouts SET planned_at = ? WHERE proposal = ? AND state = ? AND planned_at IS NULL').run(h, r.proposal, PAYOUT.PLANNED);
      return { expired: false };
    }
    if (h < Number(r.planned_at) + PLAN_EXPIRY_BLOCKS) return { expired: false };
    const plan = planOfRow(r);
    const port = plan && await portOf(plan.federation);
    if (!port) return { expired: false, why: 'no port into that federation: a plan is expired only on the federation\'s word' };
    const st = async (o) => { try { return await port.status(o); } catch (e) { return { error: e.message }; } };
    let txid = null; try { txid = await txidOfPlan(port, plan); } catch { txid = null; }
    if (txid) {
      const out0 = await st({ txid: fromHex(txid), outIdx: 0n });
      if (out0.stored) {
        const to = plan.kind === 'leaderboard' ? PAYOUT.PAID : PAYOUT.SENT;
        const rows = [...(plan.kind === 'leaderboard' ? winnerRowsOf(plan, txid) : []), ...(BigInt(plan.changeMsat || 0) > 0n ? [changeRowOf(plan, txid)] : [])];
        const t = transition(r.proposal, PAYOUT.PLANNED, to, { txid, why: 'its transaction is in the federation (read when it was due to expire)' }, { rows });
        if (t.ok) say(recordOf(rowOf(r.proposal)));
        return { expired: false, landed: t.ok };
      }
    }
    for (const x of plan.refunds || []) {
      const s = await st(outpointOf(x.outpoint));
      if (s.error || !s.stored) {
        note(r.proposal, PAYOUT.PLANNED, s.error ? `due to expire, and the federation could not be read: ${s.error}` : `due to expire, and ${String(x.outpoint).slice(0, 16)}… is spent in the federation: it waits for the record of that spend`);
        return { expired: false };
      }
    }
    const t = transition(r.proposal, PAYOUT.PLANNED, PAYOUT.EXPIRED, { why: `no transaction ${h - Number(r.planned_at)} blocks after it was planned here (height ${r.planned_at}): its inputs are free again` }, { release: true });
    if (t.ok) log(`[payout] ${r.proposal.slice(0, 16)}: EXPIRED - attempt ${attemptOf(plan)} went nowhere in ${PLAN_EXPIRY_BLOCKS} blocks; its inputs are free`);
    return { expired: t.ok };
  }

  // FROST, ROUND ONE: a commitment to the message of `kind` this seat rebuilt for that plan, for the guardian seat that asked it (signed)
  async function commit(body = {}) {
    const { plan, kind } = body || {};
    if (!plan || typeof plan !== 'object' || typeof plan.proposal !== 'string') return refuse('no plan');
    const txid = body.txid || null;
    const a = askStands({ ask: 'commit', kind: String(kind), planId: planIdOf(plan), txid, from: body.from, sig: body.sig }, fedOf(kind, plan));
    if (!a.ok) return a;
    return commitHere({ plan, kind, txid }, a.from);
  }
  // a commitment taken - and recorded as PLANNED - only once the plan stands here, and opened only by the turn's guardian (kanban #1159)
  async function commitHere({ plan, kind, txid = null }, asker) {
    if (kind === 'claim') return commitClaim({ plan });
    const done = rowOf(plan.proposal);
    if (done && (done.state === PAYOUT.PAID || done.state === PAYOUT.REFUNDED || done.state === PAYOUT.SHORT || done.state === PAYOUT.CLAIMED)) return refuse(`that payout is ${done.state} here: nothing more is signed`, 409);
    const held = !!(done && done.plan_id === planIdOf(plan) && done.state !== PAYOUT.EXPIRED);
    if (kind === 'tx' && held && done.state !== PAYOUT.PLANNED) return refuse('that payout\'s transaction is accepted already: it is signed once', 409);
    if (held && done.state === PAYOUT.PLANNED && (await expireIfDue(done)).expired) return refuse(`that plan expired here (no transaction in ${PLAN_EXPIRY_BLOCKS} blocks): nothing more is signed for it`, 409);
    let st;
    if (held) {
      // THE WINDOW ONCE (kanban #1159): a plan this seat holds is checked for its structure - not again for the invoice's, the gateway's
      // or the expiration's window, which move on while the signers are asked
      st = await planStands(plan, { late: true });
      if (!st.ok && kind === 'tx') return st;    // past PLANNED its inputs are spent: the auth and refund go on
    } else {
      if (kind !== 'tx') return refuse('this seat holds no such plan: a plan is opened by its transaction', 409);
      const o = mayOpen(plan, asker); if (!o.ok) return o;
      if (done && done.state === PAYOUT.PLANNED && attemptOf(plan) > attemptOf(planOfRow(done))) await expireIfDue(done);
      st = await planStands(plan);
      if (!st.ok) return st;
    }
    const g = guardians().get(plan.federation);
    if (!g || !g.signer) return refuse('this seat holds no share of that reserve key');
    if (!held) {
      const b = bindWinners(plan, st); if (!b.ok) return b;
      const cur = rowOf(plan.proposal);
      const t = transition(plan.proposal, cur ? cur.state : null, PAYOUT.PLANNED, { plan_id: planIdOf(plan), federation: plan.federation, plan: JSON.stringify(plan),
        planned_at: tipNow(), attempt: attemptOf(plan), txid: null, preimage: null, refund_txid: null, submit_sig: null, refund_sig: null, why: null }, { plan, release: !!cur });
      if (!t.ok) return t;
    }
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
  // ROUND TWO: one share over that message for one commitment list, never a second list - asked by a guardian seat (signed, kanban #1159)
  async function share(body = {}) {
    const { planId, kind, commitments } = body || {};
    if (!Array.isArray(commitments)) return refuse('a share is asked over a commitment list');
    const r = db.prepare('SELECT federation, plan FROM reserve_payouts WHERE plan_id = ?').get(String(planId));
    if (!r) return refuse('this seat keeps no such plan');
    const a = askStands({ ask: 'share', kind: String(kind), planId: String(planId), list: commitmentListOf(commitments), from: body.from, sig: body.sig }, kind === 'claim' ? JSON.parse(r.plan).to : r.federation);
    if (!a.ok) return a;
    return shareHere({ planId, kind, commitments });
  }
  async function shareHere({ planId, kind, commitments }) {
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
    const own = await commitHere({ plan, kind, txid: extra.txid || null }, me);
    if (!own.ok) return own;
    const signers = [{ peer: null, commitment: own.commitment }];
    const ask = askOf({ ask: 'commit', kind, planId: planIdOf(plan), txid: extra.txid || null });
    for (const peer of g.peers || []) {
      try { const r = await peer.commit({ plan, kind, ...extra, ...ask }); if (r && r.ok) signers.push({ peer, commitment: r.commitment }); } catch { /* a peer down: the threshold decides */ }
      if (signers.length >= g.needed) break;
    }
    if (signers.length < g.needed) return refuse(`${signers.length} of ${g.needed} guardian seats committed to the ${kind}`, 503);
    const commitments = signers.map((x) => x.commitment).sort((a, b) => a.id - b.id);
    const shares = [];
    const planId = planIdOf(plan);
    for (const x of signers) {
      const r = x.peer === null ? await shareHere({ planId, kind, commitments })
        : await Promise.resolve(x.peer.share({ planId, kind, commitments, ...askOf({ ask: 'share', kind, planId, list: commitmentListOf(commitments) }) })).catch((e) => refuse(e.message));
      if (!r || !r.ok) return refuse(`a ${kind} share was refused: ${r ? r.why : '?'}`);
      shares.push(r.share);
    }
    const message = (pairs.get(`${planId}:${kind}`) || []).find((p) => p.commitment === own.commitment).message;
    const { signature } = aggregate340({ commitments, message, groupPublicKey: g.key, shares, curve });
    if (!schnorr.verify(signature, message, g.key.subarray(1))) return refuse(`the ${kind} signature does not verify under the reserve key`);
    return { ok: true, signature };
  }

  /**
   * WHO SAID A RECORD (kanban #1156): its `from` signed every field of it with its node key, and `from` is a guardian seat of the
   * federation whose step it is - the paying federation's, the destination's for a move's claim. Nobody else moves a record here.
   */
  function saidByGuardian(rec) {
    if (typeof rec.from !== 'string' || !/^[0-9a-f]{64}$/.test(rec.from) || typeof rec.sig !== 'string' || !/^[0-9a-f]{128}$/.test(rec.sig))
      return refuse('a payout record is signed by the guardian seat that says it (from, sig)', 401);
    let good = false; try { good = schnorr.verify(fromHex(rec.sig), recordDigestOf(rec), fromHex(rec.from)); } catch { good = false; }
    if (!good) return refuse('that record\'s signature does not verify under its from key', 401);
    const fed = rec.state === PAYOUT.CLAIMED ? rec.plan && rec.plan.to : rec.plan ? rec.plan.federation : rec.federation;
    const isGuardian = (f) => { const g = typeof f === 'string' ? guardians().get(f) : null; return !!(g && (g.members || []).includes(rec.from)); };
    // a move's PAID record is handed on by the destination's claimer too (kanban #326): the claim is its step next
    const handedOn = rec.state === PAYOUT.PAID && rec.plan && rec.plan.kind === 'move' && isGuardian(rec.plan.to);
    if (!isGuardian(fed) && !handedOn) return refuse(`${rec.from.slice(0, 16)}… is no guardian seat of the federation that record's step is for`, 403);
    if (rec.plan && rec.federation && rec.federation !== rec.plan.federation) return refuse('the record names another federation than its plan');
    return { ok: true, fed };
  }
  // WHICH FEDERATION PAYS A PASSED PROPOSAL, as this seat holds the reserves: the lowest federation id whose unspent reserves cover X
  // plus fees, or none (`needs` what each one holds and needs)
  async function payerFor(v, feds) {
    const needs = {};
    for (const fed of [...feds.keys()].sort()) {
      const g = feds.get(fed); if (!g.key) continue;
      const port = await portOf(fed); if (!port) continue;
      const [fees, gws] = await Promise.all([port.fees(), port.gateways()]);
      const gw = lowestLiveGateway(gws.gateways || []); if (!gw) continue;
      const contractMsat = contractForInvoice(BigInt(v.amountSats) * 1000n, gw.sendFeeDefault);
      const have = unspent(fed);
      const held = have.reduce((t, x) => t + BigInt(x.amountMsat), 0n);
      needs[fed] = { held: String(held), need: String(contractMsat + lnv2FeeMsat(fees, contractMsat)) };
      if (payAmountsCover(have, contractMsat, fees)) return { payer: fed, needs };
    }
    return { payer: null, needs };
  }
  /**
   * A SHORTFALL ANOTHER SEAT SAID (kanban #1156): a seat that holds a share of a reserve key - one that would pay - keeps it only when
   * its own records come to the same: the vote passed here and no federation's reserves, as it holds them, cover it (a leaderboard
   * payout: over the cap, no winner, or not covered). A seat that pays nothing keeps the signed record as it was said.
   */
  async function shortStands(rec) {
    const feds = guardians();
    if (![...feds.values()].some((g) => g && g.signer)) return { ok: true };
    const lb = (leaderboards() || []).find((x) => x.id === rec.proposal);
    if (lb) {
      if (rec.federation !== lb.federation) return refuse('that shortfall names another federation than the leaderboard payout');
      const have = unspent(lb.federation);
      const heldSats = have.reduce((t, x) => t + BigInt(x.amountMsat), 0n) / 1000n;
      if (!leaderboardCap({ amountSats: lb.amountSats, reservesSats: heldSats }).ok) return { ok: true };
      const port = await portOf(lb.federation);
      if (!port) return refuse('this seat reaches no port into that federation: it cannot recompute the shortfall', 503);
      const w = await winnersBook.union(lb.id, []);
      if (!w || !w.ok) return refuse(`this seat cannot read the season's winners: ${w ? w.why : '?'}`, 503);
      if (!w.winners.length) return { ok: true };
      const winners = w.winners.map((x) => ({ payoutPk: String(x.payoutPk).toLowerCase(), msat: String(x.msat) }));
      const fees = await port.fees();
      return leaderboardAmounts({ inputs: have, winners, fees }).covers ? refuse('this seat\'s reserves there cover that leaderboard payout: no shortfall here', 409) : { ok: true };
    }
    const v = (passed() || []).find((p) => p.id === rec.proposal);
    if (!v) return refuse('this seat has no passed vote for that proposal: it keeps no shortfall of it', 409);
    const { payer } = await payerFor(v, feds);
    return payer ? refuse(`this seat's reserves in ${payer.slice(0, 8)} cover that payout: no shortfall here`, 409) : { ok: true };
  }
  // THE TRANSACTION A PLAN MAKES, rebuilt here without signing (the stake-lock tool's dry run): its id, or null
  async function txidOfPlan(port, plan, kind = 'tx', extra = {}) {
    let tx;
    if (kind === 'refund') {
      const fees = await port.fees();
      tx = await port.settle({ claimPk: fromHex(plan.reserveKey), claims: [], refunds: [{ outpoint: { txid: fromHex(extra.txid), outIdx: 0n }, amountMsat: BigInt(plan.contractMsat) }],
        payouts: [{ payoutPk: fromHex(plan.reserveKey), msat: largestPayoutMsat(fees, BigInt(plan.contractMsat)) }], nonce: nonceOf(plan.proposal, attemptOf(plan), 'refund') });
    } else {
      tx = await port.settle({ claimPk: fromHex(plan.reserveKey), claims: [], refunds: plan.refunds.map((x) => ({ outpoint: outpointOf(x.outpoint), amountMsat: BigInt(x.amountMsat) })),
        payouts: payoutsOf({ plan: JSON.stringify(plan) }), nonce: fromHex(plan.nonce) });
    }
    const id = tx && (tx.txid && tx.txid !== 'undefined' ? tx.txid : tx.message);
    return id ? String(id).toLowerCase() : null;
  }
  /**
   * WHAT THE FEDERATION SAYS OF A RECORD PAST PLANNED (kanban #1156), read through this seat's own port into it: the transaction the
   * record names is the one its plan makes, and the plan's inputs are spent; REFUNDED - the refund is the one the plan makes and the
   * contract is gone. A seat with no port into it keeps the guardian's signed word and the preimage.
   */
  async function federationSays(rec) {
    if (rec.state === PAYOUT.PLANNED || rec.state === PAYOUT.CLAIMED) return { ok: true };
    if (!/^[0-9a-f]{64}$/.test(String(rec.txid || ''))) return refuse(`a ${rec.state} record names its transaction`);
    if (!Array.isArray(rec.plan.refunds) || !rec.plan.refunds.length) return refuse('a plan spends at least one reserve output');
    const port = await portOf(rec.plan.federation);
    if (!port) return { ok: true };
    let built; try { built = await txidOfPlan(port, rec.plan); } catch (e) { return refuse(`this seat cannot rebuild that plan's transaction: ${e.message}`, 503); }
    if (built !== String(rec.txid).toLowerCase()) return refuse('the record names another transaction than its plan makes');
    const st = async (outpoint) => { try { return await port.status(outpoint); } catch (e) { return { error: e.message }; } };
    // THE PLAN'S INPUTS ARE SPENT in the federation (its first one, read here): the transaction went in. Not its output 0 - by the time
    // a SENT arrives the gateway may have paid and spent the contract already
    const first = await st(outpointOf(rec.plan.refunds[0].outpoint));
    if (first.error) return refuse(`this seat cannot read the federation: ${first.error}`, 503);
    if (first.stored) return refuse(`the plan's inputs are unspent in the federation: not ${rec.state}`, 409);
    if (rec.state === PAYOUT.REFUNDED) {
      if (!/^[0-9a-f]{64}$/.test(String(rec.refundTxid || ''))) return refuse('a refunded record names its refund');
      let back; try { back = await txidOfPlan(port, rec.plan, 'refund', { txid: rec.txid }); } catch (e) { return refuse(`this seat cannot rebuild the refund: ${e.message}`, 503); }
      if (back !== String(rec.refundTxid).toLowerCase()) return refuse('the record names another refund than its plan makes');
      const s = await st({ txid: fromHex(rec.txid), outIdx: 0n });
      if (s.error) return refuse(`this seat cannot read the federation: ${s.error}`, 503);
      if (s.stored) return refuse('the federation still holds the contract: not REFUNDED', 409);
    }
    return { ok: true };
  }

  // A RECORD ANOTHER SEAT SENT (its broadcast): signed by a guardian seat of the federation whose step it is (kanban #1156), kept once per
  // proposal - a PAID one only with the preimage of the plan's invoice, a step past PLANNED only as the federation says it, a SHORT one
  // only as this seat's own records come to it - and moved only along PAYOUT_NEXT
  async function learn(rec) {
    if (!rec || typeof rec.proposal !== 'string' || !/^[0-9a-f]{64}$/.test(rec.proposal) || !PAYOUT_SAID.includes(rec.state)) return refuse('no payout record');
    const who = saidByGuardian(rec);
    if (!who.ok) return who;
    const had = rowOf(rec.proposal);
    if (rec.state === PAYOUT.SHORT) {
      if (had) return { ok: true, kept: had.state };
      const st = await shortStands(rec); if (!st.ok) return st;
      const t = transition(rec.proposal, null, PAYOUT.SHORT, { why: typeof rec.why === 'string' ? rec.why.slice(0, 500) : null, federation: who.fed });
      return t.ok ? { ok: true, kept: PAYOUT.SHORT } : t;
    }
    if (!rec.plan || typeof rec.plan !== 'object' || planIdOf(rec.plan) !== rec.planId) return refuse('the record\'s plan is not its id');
    let from = had ? had.state : null, release = false;
    if (had && had.plan_id && had.plan_id !== rec.planId) {
      // ANOTHER PLAN OF THE PROPOSAL (kanban #1159): a later attempt over one that expired (here, or - a seat that pays nothing - on the
      // guardian's word), or the landed transaction of another attempt over one that went nowhere; never over a plan that went on
      const r = await mayReplace(had, rec);
      if (!r.ok) return r;
      from = r.from; release = true;
    }
    if (from && !canMove(from, rec.state)) return { ok: true, kept: from };
    if (rec.state === PAYOUT.PLANNED && !(had && had.plan_id === rec.planId)) {
      // a PLANNED record opens the plan here: from the turn's guardian, where this seat can tell the turn (kanban #1159)
      const known = Number.isInteger(startOf(rec.plan)) && Number.isInteger(tipNow());
      const g0 = guardians().get(rec.plan.federation);
      if (known || (g0 && g0.signer)) { const o = mayOpen(rec.plan, rec.from); if (!o.ok) return o; }
    }
    if (rec.state === PAYOUT.PAID && rec.plan.kind !== 'leaderboard' && !(rec.preimage && toHex(sha256(fromHex(rec.preimage))) === rec.plan.paymentHash)) return refuse('that preimage is not the invoice\'s');
    if (rec.state === PAYOUT.CLAIMED && !(rec.plan.kind === 'move' && rec.claimTxid && rec.claimMsat && rec.preimage && toHex(sha256(fromHex(rec.preimage))) === rec.plan.paymentHash))
      return refuse('a claimed move names its claim and the payment\'s preimage');
    if (rec.state === PAYOUT.CLAIMED && !/^[0-9a-f]{64}$/.test(String(rec.claimTxid))) return refuse('a claimed move names its claim transaction');
    // A GUARDIAN OF THAT FEDERATION keeps a plan it was told about only when the plan stands on its own records: a forged plan
    // would otherwise hold the proposal's one place here and refuse the real one
    const g = guardians().get(rec.plan.federation);
    if (g && g.signer && !(had && had.plan_id === rec.planId)) {
      const st = await planStands(rec.plan, { late: rec.state !== PAYOUT.PLANNED }); if (!st.ok) return st;
      if (rec.state === PAYOUT.PLANNED) { const b = bindWinners(rec.plan, st); if (!b.ok) return b; }
    }
    const fs = await federationSays(rec);
    if (!fs.ok) return fs;
    const txid = rec.txid || (had && had.txid) || null;
    // THE ROWS THE STEP MAKES, kept in the same step: the change, a leaderboard's winners, a move's claim, a refund's return
    const rows = [];
    if (txid && BigInt(rec.plan.changeMsat || 0) > 0n) rows.push(changeRowOf(rec.plan, txid));
    if (rec.state === PAYOUT.PAID && rec.plan.kind === 'leaderboard') rows.push(...winnerRowsOf(rec.plan, txid));
    if (rec.state === PAYOUT.CLAIMED) rows.push(claimRowOf(rec.plan, rec.claimTxid, rec.claimMsat));
    if (rec.state === PAYOUT.REFUNDED) {
      const port = await portOf(rec.plan.federation);
      if (port) { const back = largestPayoutMsat(await port.fees(), BigInt(rec.plan.contractMsat));
        rows.push({ ...changeRowOf(rec.plan, rec.refundTxid), outpoint: { txid: fromHex(rec.refundTxid), outIdx: 0n }, amountMsat: back, contractId: `payout-refund:${rec.proposal}`, item: 'payout refund' }); }
    }
    const same = had && had.plan_id === rec.planId;
    const t = transition(rec.proposal, from, rec.state, { plan_id: rec.planId, federation: rec.plan.federation, plan: JSON.stringify(rec.plan), txid: rec.txid || (same && had.txid) || null,
      preimage: rec.preimage || (same && had.preimage) || null, refund_txid: rec.refundTxid || null, why: typeof rec.why === 'string' ? rec.why.slice(0, 500) : null,
      claim_txid: rec.claimTxid || null, claim_msat: rec.claimMsat ? String(rec.claimMsat) : null, attempt: attemptOf(rec.plan),
      ...(same ? {} : { planned_at: tipNow() }) }, { plan: rec.plan, rows, release });
    return t.ok ? { ok: true, kept: rec.state } : t;
  }
  async function mayReplace(had, rec) {
    const held = planOfRow(had);
    if (rec.state === PAYOUT.PLANNED) {
      if (attemptOf(rec.plan) <= attemptOf(held)) return refuse('another plan of that proposal is kept here', 409);
      if (had.state === PAYOUT.EXPIRED) return { ok: true, from: PAYOUT.EXPIRED };
      if (had.state !== PAYOUT.PLANNED) return refuse(`that payout is ${had.state} here: no later attempt`, 409);
      const g = guardians().get(held.federation);
      if (g && g.signer) {
        const e = await expireIfDue(had);
        return e.expired ? { ok: true, from: PAYOUT.EXPIRED } : refuse('this seat\'s plan of that proposal has not expired here: no later attempt yet', 409);
      }
      // a seat that pays nothing frees the inputs on the guardian's signed word
      const t = transition(had.proposal, PAYOUT.PLANNED, PAYOUT.EXPIRED, { why: `attempt ${attemptOf(rec.plan)} was planned by ${rec.from.slice(0, 16)}…` }, { release: true });
      return t.ok ? { ok: true, from: PAYOUT.EXPIRED } : t;
    }
    if ((rec.state === PAYOUT.SENT || rec.state === PAYOUT.PAID || rec.state === PAYOUT.REFUNDED)
      && (had.state === PAYOUT.PLANNED || had.state === PAYOUT.SUBMITTING || had.state === PAYOUT.EXPIRED)) return { ok: true, from: had.state };
    return refuse('another plan of that proposal is kept here', 409);
  }

  /** THE COORDINATOR'S PASS: plan, sign, submit, have the gateway pay - for every passed proposal whose turn this seat has. */
  async function round({ height } = {}) {
    const out = [];
    if (Number.isInteger(height)) lastHeight = height;
    const feds = guardians();
    out.push(...await moveRound({ height, feds }));
    out.push(...await leaderboardRound({ height, feds }));
    for (const v of passed() || []) {
      let r = rowOf(v.id);
      if (r && DONE.has(r.state)) continue;
      // A PLAN THAT WENT NOWHERE gives way (kanban #1159): expired here, its inputs freed, the turn's guardian plans the next attempt
      if (r && r.state === PAYOUT.PLANNED) { await expireIfDue(r); r = rowOf(v.id); if (DONE.has(r.state)) continue; }
      const live = !!(r && r.state !== PAYOUT.EXPIRED);
      // which federation pays: the lowest federation id whose unspent reserves (as this seat holds them) cover X plus fees
      let payer = null, needs = {};
      if (live) payer = r.federation;
      else ({ payer, needs } = await payerFor(v, feds));
      const coordFed = payer || [...feds.keys()].filter((f) => feds.get(f).key).sort()[0];
      const g = coordFed && feds.get(coordFed);
      if (!g || !g.signer) continue;                                      // not a guardian of the paying federation: it only records
      const i = g.members.indexOf(me);
      if (i < 0 || !(Number.isInteger(height) && height >= v.decidableAt + TAKEOVER_BLOCKS * i)) continue;   // not this seat's turn yet
      // a plan is opened (or found short) only by the guardian seat whose turn it is now (kanban #1159); a plan held goes on with any
      if (!live && turnOf(g.members, Number(v.decidableAt), height) !== me) continue;
      if (r && !live && !payer) { out.push({ id: v.id, ok: false, why: 'its plan expired, and the reserves cannot pay it now' }); continue; }
      if (!r && !payer) {
        const why = `the reserves cannot pay ${v.amountSats} sat: ${Object.entries(needs).map(([f, n]) => `${f.slice(0, 8)} holds ${n.held} msat, needs ${n.need}`).join('; ') || 'no federation can be read'} (a payout over several federations is not built)`;
        const t = transition(v.id, null, PAYOUT.SHORT, { why, federation: coordFed });
        if (!t.ok) { out.push({ id: v.id, ...t }); continue; }
        say({ proposal: v.id, state: PAYOUT.SHORT, why, federation: coordFed });
        log(`[payout] ${v.id.slice(0, 16)}: SHORT - ${why}`); out.push({ id: v.id, state: PAYOUT.SHORT }); continue;
      }
      let plan = live ? planOfRow(r) : null;
      if (!plan) {
        const attempt = r ? attemptOf(planOfRow(r)) + 1 : 0;
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
          nonce: toHex(nonceOf(v.id, attempt)), ...(attempt ? { attempt: String(attempt) } : {}) };
        const st = await planStands(plan);
        if (!st.ok) { log(`[payout] ${v.id.slice(0, 16)}: own plan refused - ${st.why}`); out.push({ id: v.id, ...st }); continue; }
        const t = transition(v.id, r ? r.state : null, PAYOUT.PLANNED, { ...FRESH, plan_id: st.planId, federation: payer, plan: JSON.stringify(plan), planned_at: height, attempt }, { plan, release: !!r });
        if (!t.ok) { out.push({ id: v.id, ...t }); continue; }
        say(recordOf(rowOf(v.id)));
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
      let r = rowOf(lb.id);
      if (r && DONE.has(r.state)) continue;
      const g = feds.get(lb.federation);
      if (!g || !g.signer || !g.key) continue;
      const i = g.members.indexOf(me);
      const from = Math.max(Number(lb.paymentHeight), Number(lb.decidableAt));
      if (i < 0 || !(Number.isInteger(height) && height >= from + TAKEOVER_BLOCKS * i)) continue;
      if (r && r.state === PAYOUT.PLANNED) { await expireIfDue(r); r = rowOf(lb.id); if (DONE.has(r.state)) continue; }
      const live = !!(r && r.state !== PAYOUT.EXPIRED);
      if (!live && turnOf(g.members, from, height) !== me) continue;    // opened only on its turn (kanban #1159)
      let plan = live ? planOfRow(r) : null;
      if (!plan) {
        const attempt = r ? attemptOf(planOfRow(r)) + 1 : 0;
        const short = (why) => { if (r) return { id: lb.id, ok: false, why: `its plan expired, and now: ${why}` };
          const t = transition(lb.id, null, PAYOUT.SHORT, { why, federation: lb.federation }); if (!t.ok) return { id: lb.id, ...t };
          say({ proposal: lb.id, state: PAYOUT.SHORT, why, federation: lb.federation });
          log(`[leaderboard] ${lb.id.slice(0, 16)}: SHORT - ${why}`); return { id: lb.id, state: PAYOUT.SHORT, why }; };
        const port = await portOf(lb.federation); if (!port) continue;
        const fees = await port.fees();
        const have = unspent(lb.federation);
        const heldSats = have.reduce((t, x) => t + BigInt(x.amountMsat), 0n) / 1000n;
        const cap = leaderboardCap({ amountSats: lb.amountSats, reservesSats: heldSats });
        if (!cap.ok) { out.push(short(cap.why)); continue; }
        // THE WINNERS (kanban #1153): this seat's own read frozen once, merged with every guardian peer's frozen evidence, so the plan
        // holds every signed round any co-signer counts; each co-signer checks that list on the evidence and persists it before it commits
        const theirs = (await Promise.all((g.peers || []).map(async (p) => { try { return typeof p.winners === 'function' ? await p.winners(lb.id) : null; } catch { return null; } })))
          .filter((x) => x && Array.isArray(x.evidence)).map((x) => x.evidence);
        const w = await winnersBook.union(lb.id, theirs);
        if (!w || !w.ok) { out.push({ id: lb.id, ok: false, why: w ? w.why : 'no winners read' }); continue; }   // read again next pass
        if (!w.winners.length) { out.push(short('the season names no identity to pay')); continue; }
        const winners = w.winners.map((x) => ({ player: x.player, payoutPk: String(x.payoutPk).toLowerCase(), msat: String(x.msat) }));
        const inputs = [];
        for (const x of have) { inputs.push({ outpoint: x.outpoint, amountMsat: String(x.amountMsat) }); if (leaderboardAmounts({ inputs, winners, fees }).covers) break; }
        const amounts = leaderboardAmounts({ inputs, winners, fees });
        if (!amounts.covers) { out.push(short(`the reserves there (${heldSats} sat) do not cover ${lb.amountSats} sat and the fees`)); continue; }
        plan = { kind: 'leaderboard', proposal: lb.id, federation: lb.federation, reserveKey: toHex(g.key), amountSats: String(lb.amountSats), winners,
          rounds: w.pairs, winnersId: w.winnersId, refunds: inputs, changeMsat: String(amounts.changeMsat), nonce: toHex(nonceOf(lb.id, attempt)), ...(attempt ? { attempt: String(attempt) } : {}) };
        const st = await planStands(plan, { evidence: w.evidence });
        if (!st.ok) { log(`[leaderboard] ${lb.id.slice(0, 16)}: own plan refused - ${st.why}`); out.push({ id: lb.id, ...st }); continue; }
        const b = bindWinners(plan, st);
        if (!b.ok) { log(`[leaderboard] ${lb.id.slice(0, 16)}: winners not persisted - ${b.why}`); out.push({ id: lb.id, ...b }); continue; }
        const t = transition(lb.id, r ? r.state : null, PAYOUT.PLANNED, { ...FRESH, plan_id: st.planId, federation: lb.federation, plan: JSON.stringify(plan), planned_at: height, attempt }, { plan, release: !!r });
        if (!t.ok) { out.push({ id: lb.id, ...t }); continue; }
        say(recordOf(rowOf(lb.id)));
      }
      const port = await portOf(plan.federation);
      if (!port) { out.push({ id: lb.id, ok: false, why: 'no port into that federation' }); continue; }
      const sub = await submit(lb.id, plan, port);
      if (!sub.ok) { out.push({ id: lb.id, ...sub }); continue; }
      const kept = rowOf(lb.id);
      if (kept.state === PAYOUT.PAID) log(`[leaderboard] ${lb.id.slice(0, 16)}: PAID ${plan.amountSats} sat to ${plan.winners.length} winner(s) (tx ${String(kept.txid).slice(0, 16)})`);
      out.push({ id: lb.id, ok: true, state: kept.state, txid: kept.txid });
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
      // THE RECORD HANDED ON FIRST, once a process (kanban #326, measured 2026-10-22: four of A's seats restarted after the PAID
      // record went round and kept no such move - the claim stopped at "3 of 5 guardian seats committed")
      if (!recordResent.has(r.proposal)) { recordResent.add(r.proposal); say(recordOf(r)); }
      out.push({ id: r.proposal, ...(await claimMove(r.proposal, plan)) });
    }
    // the moves the records call for, and those under way here (planned or sent: no longer listed once their inputs are spent)
    const todo = new Map((moves() || []).map((m) => { knownMoves.set(m.id, m); return [m.id, m]; }));
    for (const r of db.prepare(`SELECT * FROM reserve_payouts WHERE state IN ('PLANNED', 'SUBMITTING', 'SENT', 'REFUNDING', 'EXPIRED')`).all()) {
      const p = planOfRow(r); if (!p || p.kind !== 'move' || todo.has(r.proposal)) continue;
      const m = moveOf(r.proposal) || { id: r.proposal, from: p.federation, to: p.to, toKey: p.toKey, fromKey: p.reserveKey, decidableAt: Number(p.decidableAt) || 0 };
      todo.set(r.proposal, m);
    }
    for (const m of todo.values()) {
      let r = rowOf(m.id);
      if (r && (DONE.has(r.state) || r.state === PAYOUT.PAID)) continue;
      const g = feds.get(m.from);
      if (!g || !g.signer || !g.key) continue;
      const i = g.members.indexOf(me);
      if (i < 0 || !(Number.isInteger(height) && height >= m.decidableAt + TAKEOVER_BLOCKS * i)) continue;
      if (r && r.state === PAYOUT.PLANNED) { await expireIfDue(r); r = rowOf(m.id); if (DONE.has(r.state) || r.state === PAYOUT.PAID) continue; }
      const live = !!(r && r.state !== PAYOUT.EXPIRED);
      if (!live && turnOf(g.members, Number(m.decidableAt), height) !== me) continue;    // opened only on its turn (kanban #1159)
      let plan = live ? planOfRow(r) : null;
      if (!plan) {
        const attempt = r ? attemptOf(planOfRow(r)) + 1 : 0;
        const port = await portOf(m.from), to = await portOf(m.to);
        // SAID, NOT SKIPPED (kanban #326, 2026-10-22: B's move to A stayed unplanned with every input right and nothing said)
        if (!port || !to) { out.push({ id: m.id, ok: false, why: `no federation port for ${!port ? 'the drained federation' : 'the destination'}` }); continue; }
        const [fees, gws] = await Promise.all([port.fees(), port.gateways()]);
        const gw = lowestLiveGateway(gws.gateways || []);
        if (!gw) { out.push({ id: m.id, ok: false, why: 'the drained federation has no live gateway to pay through' }); continue; }
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
        const seedTag = toHex(random(8));   // this attempt's own payment hash (moveSeedFor)
        let inv; try { inv = await to.receiveToKey({ claimPk: fromHex(m.toKey), amountMsat: invoiceMsat, seed: moveSeedFor({ proposal: m.id, seedTag }), gateway: tg.url }); }
        catch (e) { out.push({ id: m.id, ok: false, why: `no invoice from the destination yet: ${e.message}` }); continue; }   // asked again next pass
        plan = { proposal: m.id, kind: 'move', decidableAt: String(m.decidableAt), federation: m.from, to: m.to, toKey: m.toKey, reserveKey: toHex(g.key), lnurl: `move:${m.to}`, amountSats: String(amountSats),
          invoiceMsat: String(invoiceMsat), contractMsat: String(contractMsat), changeMsat: '0', refunds: inputs,
          invoice: inv.invoice, paymentHash: String(inv.paymentHash).toLowerCase(), contractHex: inv.contractHex, gatewayUrl: gw.url,
          gatewayPk: String(gw.modulePublicKey).toLowerCase(), expiration: String(proposedExpiration(gws.height, gw)), nonce: toHex(nonceOf(m.id, attempt)), seedTag,
          ...(attempt ? { attempt: String(attempt) } : {}) };
        const st = await planStands(plan);
        if (!st.ok) { log(`[move] ${m.id.slice(0, 16)}: own plan refused - ${st.why}`); out.push({ id: m.id, ...st }); continue; }
        const t = transition(m.id, r ? r.state : null, PAYOUT.PLANNED, { ...FRESH, plan_id: st.planId, federation: m.from, plan: JSON.stringify(plan), planned_at: height, attempt }, { plan, release: !!r });
        if (!t.ok) { out.push({ id: m.id, ...t }); continue; }
        say(recordOf(rowOf(m.id)));
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
    const c = await to.claimIncoming({ contractHex: plan.contractHex, seed: moveSeedFor(plan), payoutPk: fromHex(plan.toKey), nonce: nonceOf(pid, attemptOf(plan), 'claim'), signature: s.signature });
    if (!c || !c.accepted) return refuse(`the destination's guardians refused the claim: ${c ? c.error : '?'}`);
    const msat = String(c.payout && c.payout.msat);
    const t = transition(pid, PAYOUT.PAID, PAYOUT.CLAIMED, { claim_txid: c.txid, claim_msat: msat, why: `claimed into ${msat} msat under the destination's reserve key` },
      { rows: [claimRowOf(plan, c.txid, msat)] });
    if (!t.ok) return t;
    say(recordOf(rowOf(pid)));
    log(`[move] ${pid.slice(0, 16)}: CLAIMED ${msat} msat in ${String(plan.to).slice(0, 8)} (tx ${String(c.txid).slice(0, 16)})`);
    return { ok: true, state: PAYOUT.CLAIMED };
  }

  /**
   * THE PLAN'S TRANSACTION INTO THE FEDERATION (kanban #1159): PLANNED -> SUBMITTING -> SENT (a leaderboard payout: PAID). Its id and the
   * 5-of-7 signature are persisted (SUBMITTING) before it is handed in, so a seat that stops between the hand-in and the record hands in the
   * same transaction again on its next pass - the federation answers an accepted transaction accepted - or finds its output 0 held.
   */
  async function submit(pid, plan, port) {
    let r = rowOf(pid);
    if (r.state === PAYOUT.PLANNED) {
      const s = await sign(plan, 'tx');
      if (!s.ok) return s;
      let txid; try { txid = await txidOfPlan(port, plan); } catch (e) { return refuse(`this seat cannot rebuild the transaction it signed: ${e.message}`, 503); }
      if (!txid) return refuse('this seat cannot rebuild the transaction it signed', 503);
      const t = transition(pid, PAYOUT.PLANNED, PAYOUT.SUBMITTING, { txid, submit_sig: toHex(s.signature), why: 'signed by the reserve key; handed to the federation' });
      if (!t.ok) return t;
      r = rowOf(pid);
    }
    if (r.state !== PAYOUT.SUBMITTING) return { ok: true, state: r.state };
    let tx; try {
      tx = await port.settle({ claimPk: fromHex(plan.reserveKey), claims: [], refunds: plan.refunds.map((x) => ({ outpoint: outpointOf(x.outpoint), amountMsat: BigInt(x.amountMsat) })),
        payouts: payoutsOf(r), nonce: fromHex(plan.nonce), signature: fromHex(r.submit_sig) });
    } catch (e) { tx = { accepted: false, error: e.message }; }
    if (!(tx && tx.accepted)) {
      // HANDED IN BEFORE: the federation holds the transaction's output 0 (its answer to the first hand-in was lost)
      let s0 = null; try { s0 = await port.status({ txid: fromHex(r.txid), outIdx: 0n }); } catch { s0 = null; }
      if (!(s0 && s0.stored)) {
        const why = `the guardians refused the payout: ${tx ? tx.error : '?'}`;
        note(pid, PAYOUT.SUBMITTING, `${why} - handed in again next pass`);
        return refuse(why);
      }
    }
    const lb = plan.kind === 'leaderboard';
    const rows = [...(lb ? winnerRowsOf(plan, r.txid) : []), ...(BigInt(plan.changeMsat || 0) > 0n ? [changeRowOf(plan, r.txid)] : [])];
    const t = transition(pid, PAYOUT.SUBMITTING, lb ? PAYOUT.PAID : PAYOUT.SENT,
      { why: lb ? `${plan.winners.length} winner(s) paid ${plan.amountSats} sat in the federation` : 'the payout transaction is accepted; the gateway is asked' }, { rows });
    if (!t.ok) return t;
    say(recordOf(rowOf(pid)));
    return { ok: true, state: t.state };
  }
  /**
   * THE REFUND OF AN EXPIRED CONTRACT (kanban #1159): SENT -> REFUNDING -> REFUNDED, the refund's id and signature persisted before it is
   * handed in - handed in again after a stop, or found held at its output 0.
   */
  async function refund(pid, plan, port) {
    let r = rowOf(pid);
    const at = { txid: fromHex(r.txid), outIdx: 0n };
    if (r.state === PAYOUT.SENT) {
      const s = await sign(plan, 'refund', { txid: r.txid });
      if (!s.ok) return s;
      let back; try { back = await txidOfPlan(port, plan, 'refund', { txid: r.txid }); } catch (e) { return refuse(`this seat cannot rebuild the refund it signed: ${e.message}`, 503); }
      if (!back) return refuse('this seat cannot rebuild the refund it signed', 503);
      const t = transition(pid, PAYOUT.SENT, PAYOUT.REFUNDING, { refund_txid: back, refund_sig: toHex(s.signature), why: 'the contract expired unpaid; its refund is handed to the federation' });
      if (!t.ok) return t;
      r = rowOf(pid);
    }
    if (r.state !== PAYOUT.REFUNDING) return { ok: true, state: r.state };
    const fees = await port.fees();
    const back = largestPayoutMsat(fees, BigInt(plan.contractMsat));
    let tx; try {
      tx = await port.settle({ claimPk: fromHex(plan.reserveKey), claims: [], refunds: [{ outpoint: at, amountMsat: BigInt(plan.contractMsat) }],
        payouts: [{ payoutPk: fromHex(plan.reserveKey), msat: back }], nonce: nonceOf(pid, attemptOf(plan), 'refund'), signature: fromHex(r.refund_sig) });
    } catch (e) { tx = { accepted: false, error: e.message }; }
    if (!(tx && tx.accepted)) {
      let s0 = null; try { s0 = await port.status({ txid: fromHex(r.refund_txid), outIdx: 0n }); } catch { s0 = null; }
      if (!(s0 && s0.stored)) {
        const why = `the guardians refused the refund: ${tx ? tx.error : '?'}`;
        note(pid, PAYOUT.REFUNDING, `${why} - handed in again next pass`);
        return refuse(why);
      }
    }
    const t = transition(pid, PAYOUT.REFUNDING, PAYOUT.REFUNDED, { why: `the gateway did not pay; ${back} msat back to the reserve key` },
      { rows: [{ ...changeRowOf(plan, r.refund_txid), outpoint: { txid: fromHex(r.refund_txid), outIdx: 0n }, amountMsat: back, contractId: `payout-refund:${pid}`, item: 'payout refund' }] });
    if (!t.ok) return t;
    say(recordOf(rowOf(pid)));
    return { ok: true, state: PAYOUT.REFUNDED };
  }

  // PLANNED -> SUBMITTING -> SENT -> PAID, or REFUNDING -> REFUNDED when the gateway left the contract to expire
  async function advance(pid, plan) {
    const port = await portOf(plan.federation);
    if (!port) return refuse('this seat reaches no port into that federation', 503);
    const sub = await submit(pid, plan, port);
    if (!sub.ok) return sub;
    let r = rowOf(pid);
    if (r.state === PAYOUT.REFUNDING) return refund(pid, plan, port);
    if (r.state !== PAYOUT.SENT) return { ok: true, state: r.state };
    const at = { txid: fromHex(r.txid), outIdx: 0n };
    const st = await port.status(at);
    // the gateway did not pay before the contract expired: spent back to the reserve key, recorded REFUNDED (no re-try here)
    if (st && st.stored && st.stored.blocksLeft <= 0) return refund(pid, plan, port);
    const a = await sign(plan, 'auth', { txid: r.txid });
    if (!a.ok) return a;
    const said = await port.send({ gateway: plan.gatewayUrl, outpoint: at, paymentHash: plan.paymentHash, amountMsat: BigInt(plan.contractMsat), expiration: BigInt(plan.expiration),
      claimPk: plan.gatewayPk, refundPk: fromHex(plan.reserveKey), invoice: plan.invoice, auth: a.signature });
    if (said && said.sent && said.preimage && toHex(sha256(said.preimage)) === plan.paymentHash) {
      const t = transition(pid, PAYOUT.SENT, PAYOUT.PAID, { preimage: toHex(said.preimage), why: `the gateway at ${plan.gatewayUrl} paid ${plan.amountSats} sat to ${plan.lnurl}; its preimage checked` });
      if (!t.ok) return t;
      say(recordOf(rowOf(pid)));
      log(`[payout] ${pid.slice(0, 16)}: PAID ${plan.amountSats} sat to ${plan.lnurl} (tx ${r.txid.slice(0, 16)})`);
      return { ok: true, state: PAYOUT.PAID };
    }
    note(pid, PAYOUT.SENT, `the gateway did not pay yet: ${(said && said.why) || 'no preimage'}`);
    return refuse(`the gateway did not pay yet: ${(said && said.why) || 'no preimage'}`, 503);
  }

  return {
    round, commit, share, learn, planStands, payoutsOfRecord: (rec) => payoutsOf({ plan: JSON.stringify(rec.plan) }),
    stateOf: (pid) => { const r = rowOf(pid); return r ? recordOf(r) : null; },
    list: () => db.prepare('SELECT * FROM reserve_payouts ORDER BY updated_ms DESC').all().map(recordOf),
    spent: () => new Set(db.prepare('SELECT outpoint FROM reserve_payout_inputs').all().map((x) => x.outpoint)),
  };
}
