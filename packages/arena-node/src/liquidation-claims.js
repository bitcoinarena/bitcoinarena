// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLAIMS ON A HALTED FEDERATION'S ESCROW, AS THE ARBITRATION SET TAKES THEM (spec §23A.5 steps 2-4, RULED the owner
// 2026-09-21): "The arbitration set opens a claim window of claim_blocks ... The client ... presents each unspent
// note it holds for that federation, as it would present them to the federation itself ... A claim is valid if the note carries
// the federation's signature, its nonce is not in the published spent set, and it has not been claimed before. Valid claims are
// paid at face value from the escrow". Since kanban #1093 part 8 (the owner 2026-11-03): a claim is paid when it is made, the window
// runs 3 months from the halt (liquidationClaimBlocks), and only after it does the rest go to the protocol reserves.
//
// A CLAIM IS A SALE OF NOTES TO THE ESCROW: the client hands over its notes as out-of-band e-cash (the stock mint's send, the
// lock client's sendAllEcash) with the key it is paid to; the arbitration set holds them from then on. Should the federation
// come back (2f + 1 guardians return), the notes it bought are redeemed into the same escrow - the player was paid already.
// NOT AS BUILT (kanban #1849, state audit 2026-11-12): the book keeps each note's nonce, amount and payout key, not the e-cash, and the
// player is paid only at the window's end; a federation that comes back before then is no longer liquidated (liquidationOf null, plan
// 404) and its notes are nobody's. The page takes them back: the door's 409 "not being liquidated" has it receive its kept notes into
// its own wallet (arena-client liquidation-claim.js); reissued there, their nonces are spent, so a later halt's spent set refuses these rows.
//
// What the notes are is the federation's to say, so it is injected: `validate(federationHex, ecash)` checks every note's
// signature against that federation's mint keys and the spend keys, offline (fedimint-cli module mint validate), and answers
// { ok, amountMsat, notes: [{ nonce, amountMsat }] } or why not. `liquidationOf(federationHex)` is a seat's GET /liquidations
// entry for it (halt height, clocks, the newest spent set's nonces); `height()` the arbitration set's chain tip;
// `escrowMsatOf(federationHex)` what the escrow holds. Nothing here pays: `plan` is the table payOutLiquidation pays, pass by pass.
import { settleClaims } from '../../arena-protocol/src/federation-slash.js';
import { keyedPay, payoutOf, PAYOUT, runPayouts } from './keyed-payout.js';

// A HALT THE ARBITER CANNOT STAND ON (kanban #2617): liquidationOf answers { ok: false, why } - no verified HALTED record a strict majority of
// its seats list - and nothing is taken or settled, with the reason
const refusedLiq = (liq) => ({ ok: false, status: 409, why: `this arbitration set settles nothing for that federation yet: ${liq.why}` });
const isHex = (s, n) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
// left in the paying client for the remainder pay's own fees (one payout's measured 352 msat, room for many payees)
export const REMAINDER_FEE_MARGIN_MSAT = 10_000n;

// PENDING OUTPUTS (spec §23A.5 "Notes still in issuance at the halt", RULED 2026-10-14): `checkPending(federationHex, requestHex)`
// recomputes an issuance request's note nonce, the hash160 of its blinded message and its amount (the fork's `mintv2 check-pending`)
// and answers { ok, nonce, nonceHash, amountMsat } or why not; `liquidationOf(fid).issuedHashes` is the issued set's nonce hashes.
export function createLiquidationClaims({ validate, liquidationOf, height, escrowMsatOf, clocks, checkPending = null, load = () => [], save = () => {}, take = null }) {
  const claims = new Map();                  // federation hex -> Map(nonce hex -> { nonce, amountMsat, height, payoutPk })
  // NOTES BEING TAKEN, WRITTEN AHEAD (kanban #1352, audit 4 fixesB-2): a reissue that lands after its timeout, or across a restart, took the notes
  // and kept no claim - presented again, the federation answered "spent" and the holder got 409 for good. Each fresh note is kept as TAKING (its
  // payout key, the height) before `take` runs; a re-presentation the federation refuses as spent is the earlier reissue landed, and is accepted.
  const taking = new Map();                  // federation hex -> Map(nonce hex -> { payoutPk, height })
  const takingOf = (fid) => { if (!taking.has(fid)) taking.set(fid, new Map()); return taking.get(fid); };
  for (const c of load() || []) {
    if (c && c.taking) { takingOf(c.federation).set(c.nonce, { payoutPk: c.payoutPk, height: c.height }); continue; }
    if (!claims.has(c.federation)) claims.set(c.federation, new Map());
    claims.get(c.federation).set(c.nonce, { nonce: c.nonce, amountMsat: BigInt(c.amountMsat), height: c.height, payoutPk: c.payoutPk, ...(c.messageHash ? { messageHash: c.messageHash } : {}) });
  }
  const persist = () => save([...claims.entries()].flatMap(([federation, m]) => [...m.values()].map((c) => ({ federation, ...c, amountMsat: String(c.amountMsat) })))
    .concat([...taking.entries()].flatMap(([federation, m]) => [...m.entries()].map(([nonce, t]) => ({ federation, nonce, taking: true, payoutPk: t.payoutPk, height: t.height })))));

  /** POST /liquidation-claims { federation, ecash, payoutPk }: the notes taken, each one already claimed refused by name. */
  async function offer(body) {
    const fid = String(body && body.federation || '').toLowerCase();
    const payoutPk = String(body && body.payoutPk || '').toLowerCase();
    if (!isHex(fid, 64)) return { ok: false, status: 400, why: 'a claim names its federation (64 hex)' };
    if (!isHex(payoutPk, 66) || !/^0[23]/.test(payoutPk)) return { ok: false, status: 400, why: 'a claim names the key it is paid to: a refund key, 33 bytes compressed (66 hex)' };
    if (typeof body.ecash !== 'string' || !body.ecash) return { ok: false, status: 400, why: 'a claim presents its notes as e-cash' };
    const liq = await liquidationOf(fid);
    if (!liq) return { ok: false, status: 409, why: 'that federation is not being liquidated: no seat holds it HALTED' };
    if (liq.ok === false) return refusedLiq(liq);
    const at = await height();
    if (at < liq.liquidatesAt) return { ok: false, status: 409, why: `the claim window opens at ${liq.liquidatesAt} (halted at ${liq.haltHeight} + abandon_blocks); the tip is ${at}` };
    if (at > liq.lateClaimsUntil) return { ok: false, status: 409, why: `claims closed at ${liq.lateClaimsUntil}, the end of the claim window after the halt: notes presented later are the holder's loss` };
    const v = await validate(fid, body.ecash);
    if (!v || !v.ok) return { ok: false, status: 422, why: `those notes do not stand: ${v && v.why ? v.why : 'not validated'}` };
    const mine = claims.get(fid) || new Map(); claims.set(fid, mine);
    const spent = new Set((liq.spentNonces || []).map((n) => String(n).toLowerCase()));
    // A CLAIM TAKES ITS NOTES (kanban #1253, audit 3 MONEY-3): a claim kept only the notes' nonces, so in a federation that still runs (a theft-alarm halt)
    // or comes back, the holder could redeem the same notes after the escrow paid them. Notes not claimed before are reissued into this set's own client
    // of the federation first (`take`); a federation that answers no reissue takes the claim offline only when its halt is stopped consensus (a record
    // or a halt proof) - a mark of theft alone leaves a federation that may still run, and the holder presents the notes again
    const freshNotes = (v.notes || []).map((n) => String(n.nonce).toLowerCase()).filter((x) => !mine.has(x) && !spent.has(x));
    const fresh = freshNotes.length > 0;
    if (fresh && typeof take === 'function') {
      const tk = takingOf(fid);
      // notes another key is already taking are that holder's: not this presentation's to take
      const other = freshNotes.filter((x) => tk.has(x) && tk.get(x).payoutPk !== payoutPk);
      if (other.length) return { ok: false, status: 409, why: `${other.length} of those notes are being claimed for another key` };
      const before = freshNotes.every((x) => tk.has(x));        // every fresh note was being taken for this key: a re-presentation
      for (const x of freshNotes) if (!tk.has(x)) tk.set(x, { payoutPk, height: at });
      persist();                                                // AHEAD of the reissue: a restart or a late landing keeps the claim
      let t; try { t = await take(fid, body.ecash); } catch (e) { t = { ok: false, offline: true, why: e.message }; }
      if (!t || !t.ok) {
        if (!(t && t.offline)) {
          // REFUSED: the notes this set was already taking for this key, refused now as spent, are the earlier reissue landed - claimed
          if (!(before && /spent|already/i.test(String(t && t.why || '')))) {
            for (const x of freshNotes) tk.delete(x);
            persist();
            return { ok: false, status: 409, why: `the federation refused to reissue those notes into the arbitration set's client: ${(t && t.why) || 'no answer'}` };
          }
        } else if (liq.alarm) return { ok: false, status: 503, why: `the federation answers no reissue (${t.why}), and its halt is a mark of theft, not stopped consensus: the notes are claimed once they are taken - present them again` };
      }
    }
    const accepted = []; const refused = [];
    for (const n of v.notes || []) {
      const nonce = String(n.nonce).toLowerCase();
      if (mine.has(nonce)) { refused.push({ nonce, why: 'that note was claimed before' }); continue; }
      if (spent.has(nonce)) { refused.push({ nonce, why: 'that note\'s nonce is in the published spent set' }); continue; }
      mine.set(nonce, { nonce, amountMsat: BigInt(n.amountMsat), height: at, payoutPk });
      if (taking.has(fid)) taking.get(fid).delete(nonce);
      accepted.push({ nonce, amountMsat: String(n.amountMsat) });
    }
    if (accepted.length) persist();
    // WAITING FOR THE SPENT SET (ruled 2026-11-07, kanban #1237): a claim is always taken; whether it is paid now or waits for the set is said
    return { ok: accepted.length > 0, status: accepted.length ? 200 : 409, accepted, refused, height: at, inWindow: at <= liq.claimWindowCloses,
      spentSetPublished: Array.isArray(liq.spentNonces), ...(accepted.length ? {} : { why: 'none of those notes can be claimed' }) };
  }

  /**
   * POST /liquidation-claims { federation, pending: [issuance request hex], payoutPk }: outputs the consensus issued but whose notes
   * were never signed (§23A.5). Each is valid when its blinded message is in the issued set, its nonce not in the spent set, and
   * neither its nonce nor its message claimed before; taken like a note, at face.
   */
  async function offerPending(body) {
    const fid = String(body && body.federation || '').toLowerCase();
    const payoutPk = String(body && body.payoutPk || '').toLowerCase();
    if (!isHex(fid, 64)) return { ok: false, status: 400, why: 'a claim names its federation (64 hex)' };
    if (!isHex(payoutPk, 66) || !/^0[23]/.test(payoutPk)) return { ok: false, status: 400, why: 'a claim names the key it is paid to: a refund key, 33 bytes compressed (66 hex)' };
    if (!Array.isArray(body.pending) || !body.pending.length) return { ok: false, status: 400, why: 'a pending-output claim presents its issuance requests' };
    if (typeof checkPending !== 'function') return { ok: false, status: 501, why: 'this arbitration service checks no pending outputs' };
    const liq = await liquidationOf(fid);
    if (!liq) return { ok: false, status: 409, why: 'that federation is not being liquidated: no seat holds it HALTED' };
    if (liq.ok === false) return refusedLiq(liq);
    const at = await height();
    if (at < liq.liquidatesAt) return { ok: false, status: 409, why: `the claim window opens at ${liq.liquidatesAt}; the tip is ${at}` };
    if (at > liq.lateClaimsUntil) return { ok: false, status: 409, why: `claims closed at ${liq.lateClaimsUntil}` };
    const issued = new Set((liq.issuedHashes || []).map((h) => String(h).toLowerCase()));
    if (!issued.size) return { ok: false, status: 409, why: 'no issued set is published for that federation yet' };
    const spent = new Set((liq.spentNonces || []).map((n) => String(n).toLowerCase()));
    const mine = claims.get(fid) || new Map(); claims.set(fid, mine);
    const accepted = []; const refused = [];
    for (const req of body.pending) {
      const c = await checkPending(fid, String(req));
      if (!c || !c.ok) { refused.push({ request: String(req).slice(0, 16), why: c && c.why ? c.why : 'not an issuance request' }); continue; }
      const nonce = String(c.nonce).toLowerCase(); const mh = String(c.nonceHash).toLowerCase();
      if (!issued.has(mh)) { refused.push({ nonce, why: 'that output is not in the issued set' }); continue; }
      if (spent.has(nonce)) { refused.push({ nonce, why: 'that note\'s nonce is in the published spent set' }); continue; }
      if (mine.has(nonce) || [...mine.values()].some((x) => x.messageHash === mh)) { refused.push({ nonce, why: 'that output was claimed before' }); continue; }
      mine.set(nonce, { nonce, amountMsat: BigInt(c.amountMsat), height: at, payoutPk, messageHash: mh });
      accepted.push({ nonce, amountMsat: String(c.amountMsat), pending: true });
    }
    if (accepted.length) persist();
    return { ok: accepted.length > 0, status: accepted.length ? 200 : 409, accepted, refused, height: at, inWindow: at <= liq.claimWindowCloses,
      ...(accepted.length ? {} : { why: 'none of those outputs can be claimed' }) };
  }

  /** GET /liquidation-claims?federation=: who is paid what from the escrow, at the tip, by settleClaims' order. */
  async function plan(fidHex, { escrowMsat: given = null } = {}) {
    const fid = String(fidHex || '').toLowerCase();
    const liq = await liquidationOf(fid);
    if (!liq) return { ok: false, status: 404, why: 'that federation is not being liquidated' };
    if (liq.ok === false) return refusedLiq(liq);
    const mine = [...(claims.get(fid) || new Map()).values()];
    // what the escrow holds: on chain until it is pegged in, then what the safe federation credited for it (payOutLiquidation)
    const escrowMsat = given !== null ? BigInt(given) : BigInt(await escrowMsatOf(fid));
    const got = settleClaims({ escrowMsat, claims: mine, spentNonces: liq.spentNonces || null, haltHeight: liq.haltHeight, atHeight: await height(),
      clocks, noteSigned: () => true });
    if (!got.ok) return { ok: false, status: 409, why: got.why };
    const payTo = new Map(mine.map((c) => [c.nonce, c.payoutPk]));
    const byKey = new Map();
    for (const p of got.paid) byKey.set(payTo.get(p.nonce), (byKey.get(payTo.get(p.nonce)) || 0n) + p.msat);
    return { ok: true, federation: fid, escrowMsat: String(escrowMsat), notes: mine.length, proRata: got.proRata, rate: got.rate, short: got.short,
      // THE ONE LEDGER (kanban #1093 part 2, ruling #1111): every claim accepted, at face, so a census-key liquidation escrow pays what this escrow's paidNotes leave
      accepted: claimed(fid),
      claimWindowOpens: liq.liquidatesAt,
      paidNotes: got.paid.map((p) => ({ nonce: p.nonce, msat: String(p.msat), late: p.late, payoutPk: payTo.get(p.nonce) })),
      claimWindowCloses: liq.claimWindowCloses, lateClaimsUntil: liq.lateClaimsUntil,
      spentSetPublished: got.spentSetPublished, payouts: [...byKey.entries()].map(([payoutPk, msat]) => ({ payoutPk, msat: String(msat) })),
      refused: got.refused, remainderMsat: String(got.remainderMsat), split: got.split ? { reserves: String(got.split.reserves) } : null,
      remainderSplitsAt: got.remainderSplitsAt };
  }
  // THE CLAIMS TAKEN for one federation, as kept (kanban #723: the liquidation's event names every note accepted)
  const claimed = (fidHex) => [...(claims.get(String(fidHex || '').toLowerCase()) || new Map()).values()]
    .map((c) => ({ nonce: c.nonce, amountMsat: String(c.amountMsat), height: c.height, payoutPk: c.payoutPk }));
  return { offer, offerPending, plan, claimed, liquidation: liquidationOf };
}

/**
 * PAYING THE TABLE (§23A.5 step 4), one pass at a time, every step kept (`v`, the service's state for this
 * federation) before the next, as payOutSlash does for a slash (§5A.3B). A claim is paid when it is made (kanban #1093 part 8):
 *   1. from the claim window's opening (the liquidation): the whole escrow is spent by k of the set to a peg-in address of its own client of a SAFE
 *      federation (`run` the stake-lock tool over that client), and claimed there;
 *   2. the table (`claims.plan`, over what that federation credited) is paid note by note: every note not paid yet, summed per
 *      payout key, locked to that key (the tool's `pay`) - so a late note is paid by a later pass from what is left, never twice;
 *   3. after the claim window (3 months from the halt), the remainder - what no note claimed - to the protocol reserves (§5A.3, RULED 2026-11-02, kanban #976), as
 *      `remainderPayees(fid, msat)` names them ([{ key, msat }]: the reserve key of the federation it was paid into).
 * `spendEscrow(toScript)` builds, signs and posts the escrow's spend (buildEscrowPegin + assemble + post) and answers { txid } or why.
 */
export async function payOutLiquidation({ fid, v, claims, height, run, spendEscrow, remainderPayees = null, keep = () => {}, say = () => {}, resume = null }) {
  const p0 = await claims.plan(fid);
  if (!p0.ok) return { why: p0.why };
  if (Number.isInteger(p0.claimWindowOpens) && (await height()) < p0.claimWindowOpens) return { why: `the claim window opens at ${p0.claimWindowOpens}` };
  // WHAT THE PAYING CLIENT HELD BEFORE THE ESCROW CAME (kanban #326, rehearsal 17 live 10-26): a claim that went through outside a recorded
  // pass - by hand, or one ending right at the tool's timeout - left the balance risen before the next pass's pegin-claim began, which then
  // saw no rise and the service waited for good. The rise over this mark stands for the claim, never more than the escrow carried.
  const markBalance = async () => {
    if (v.balanceBeforeClaimMsat !== undefined) return;
    const b = await run(['--mode', 'balance']);
    if (b && b.msat !== undefined) { v.balanceBeforeClaimMsat = String(b.msat); keep(); }
  };
  // A SPEND RECORDED BEFORE ITS BROADCAST (kanban #1232): a lost answer left the escrow spent, nothing kept, and every later pass "the
  // escrow output is spent or unknown" - the safe federation's peg-in never claimed. `resume` finishes it (arbiter.js resumeIntent).
  if (!v.escrowTxid && v.escrowIntent && resume) {
    const i = v.escrowIntent;
    const r = await resume(i);
    if (!r.ok) { delete v.escrowIntent; keep(); return { why: `the recorded escrow spend is refused: ${r.why}` }; }
    Object.assign(v, { escrowTxid: i.txid, pegInAddress: i.pegInAddress, escrowAtMs: Date.now(), ...(i.sats !== undefined ? { escrowSats: String(i.sats) } : {}) }); delete v.escrowIntent; keep();
    say({ federation: fid.slice(0, 16), escrowIntoSafeFederation: i.txid, resumed: r.landed ? 'found' : r.inferred ? 'its input is spent' : 'sent again' });
  }
  if (!v.escrowTxid) {
    await markBalance();
    const addr = await run(['--mode', 'pegin-address']);
    if (!addr.address) return { why: `no peg-in address: ${addr.error || JSON.stringify(addr)}` };
    const sent = await spendEscrow(addr.address, (intent) => { v.escrowIntent = { ...intent, pegInAddress: addr.address }; keep(); });
    if (!sent || !sent.txid) { if (v.escrowIntent) { delete v.escrowIntent; keep(); } return { why: sent && sent.why ? sent.why : 'the escrow was not spent' }; }
    // with when and how much (kanban #723: the explorer names every step of a liquidation with its amount and its transaction)
    Object.assign(v, { escrowTxid: sent.txid, pegInAddress: addr.address, escrowAtMs: Date.now(), ...(sent.sats !== undefined ? { escrowSats: String(sent.sats) } : {}) }); delete v.escrowIntent; keep();
    say({ federation: fid.slice(0, 16), escrowIntoSafeFederation: sent.txid });
  }
  if (!v.claimedMsat) {
    await markBalance();
    const c = await run(['--mode', 'pegin-claim', '--address', v.pegInAddress, '--timeout-s', '840']);
    let got = c.balance_after_msat > c.balance_before_msat ? BigInt(c.balance_after_msat) - BigInt(c.balance_before_msat) : 0n;
    if (got <= 0n && v.balanceBeforeClaimMsat !== undefined) {
      const b = await run(['--mode', 'balance']);
      const rose = b && b.msat !== undefined ? BigInt(b.msat) - BigInt(v.balanceBeforeClaimMsat) : 0n;
      const cap = v.escrowSats !== undefined ? BigInt(v.escrowSats) * 1000n : null;
      if (rose > 0n && (cap === null || rose <= cap)) { got = rose; say({ federation: fid.slice(0, 16), claimedOutsideAPass: String(rose) }); }
    }
    if (got <= 0n) return { why: `the peg-in is not claimed yet: ${c.error || JSON.stringify(c)}` };
    v.claimedMsat = String(got); v.claimedAtMs = Date.now(); keep();
  }
  const p = await claims.plan(fid, { escrowMsat: BigInt(v.claimedMsat) });
  if (!p.ok) return { why: p.why };
  const done = new Set(v.paidNonces || []);
  // A NOTE BATCH ASKED BEFORE A STOP (kanban #1174) is the batch: its notes, its list, read back under its key - not the notes due now
  const asked = v.notesPay && payoutOf(v.notesPay) === PAYOUT.ASKED ? v.notesPay : null;
  // PAID AT ONCE ONLY AGAINST A VERIFIED SPENT SET (ruled 2026-11-07, kanban #1237, audit 2 RES-4): without one nothing per note is paid, and no
  // remainder, until the claim window closes - then against the empty set, pro rata if the escrow is short (§23A.5 rule 3). A set that arrives
  // first pays every waiting claim at once, against it. A batch asked before a stop is finished whatever (kanban #1174).
  if (!asked && p.spentSetPublished === false && Number.isInteger(p.claimWindowCloses) && (await height()) <= p.claimWindowCloses)
    return { why: `no verified spent set of the federation yet: the claims wait for one, or for the claim window to close at ${p.claimWindowCloses}` };
  const due = asked ? asked.notes.map((n) => ({ ...n })) : p.paidNotes.filter((n) => !done.has(n.nonce) && BigInt(n.msat) > 0n);
  if (!due.length) {
    // THE REMAINDER, once: only after the claim window (settleClaims names a split only then), every note's payout made first
    if (!p.split || v.remainderTxid || !remainderPayees) return { paid: 0, notes: done.size, ...(p.split && !remainderPayees ? { why: 'the remainder waits for its payees' } : {}) };
    // WHAT THE CLIENT CAN STILL PAY (kanban #326 rehearsal 17, 2026-10-26): the table's remainder is the claim less the notes paid,
    // but every pay costs the safe federation's fees (352 msat for one payout, measured), so the client holds less than that and a
    // remainder of the full figure was refused as "balance insufficient" on every pass; it is paid from what is there, less this
    // margin for its own pay's fees
    // A REMAINDER ASKED BEFORE A STOP (kanban #1174) is not worked out again from the balance - its pay may have taken it: its record is the remainder
    const askedRest = v.remainderPay && payoutOf(v.remainderPay) === PAYOUT.ASKED ? v.remainderPay : null;
    const held = askedRest ? { msat: '0' } : await run(['--mode', 'balance']);
    if (!(held && held.msat !== undefined)) return { why: `no balance of the paying client: ${(held && held.error) || JSON.stringify(held)}` };
    const can = BigInt(held.msat) - REMAINDER_FEE_MARGIN_MSAT;
    const rest = askedRest ? BigInt(askedRest.rest) : BigInt(p.remainderMsat) < can ? BigInt(p.remainderMsat) : can;
    if (rest <= 0n) return { why: `the paying client holds ${held.msat} msat, nothing left for the remainder after fees` };
    const to = askedRest ? askedRest.list.map((x) => ({ ...x, part: (askedRest.parts.find((y) => y.key === x.key) || {}).part || null }))
      : (await remainderPayees(fid, rest)).filter((x) => BigInt(x.msat) > 0n);
    if (!to.length) return { why: 'no payee for the remainder' };
    if (to.reduce((a, x) => a + BigInt(x.msat), 0n) > rest) return { why: 'the remainder\'s payees come to more than the remainder' };
    // THE REMAINDER ONCE (kanban #1174, keyed-payout.js): its record ASKED (key, list, parts) before the tool; a record ASKED before a stop is the remainder
    if (!v.remainderPay) v.remainderPay = { rest: String(rest), parts: to.map((x) => ({ key: String(x.key).toLowerCase(), part: x.part || null })) };
    const got = await keyedPay({ rec: v.remainderPay, save: keep, list: to, key: `liq-remainder:${fid}`, ...runPayouts(run) });
    if (!got.ok) return { why: `no remainder transaction: ${got.why}`, held: !!got.held };
    const r = { txid: got.txid, payouts: got.payouts };
    const restPaid = BigInt(v.remainderPay.rest);
    // EVERY PAYEE OF THE REMAINDER KEPT, not only their count (kanban #723, 2026-10-27: T2's remainder 1f107491 went to 44 payees and the
    // state said "44" - who got what had to be rebuilt from the census by hand): its key, its part (node or donation), msat and out_idx
    const partOf = new Map(to.map((x) => [String(x.key).toLowerCase(), x.part || null]));
    const outs = Array.isArray(r.payouts) && r.payouts.length ? r.payouts.map((x) => ({ payoutPk: String(x.refund_pk).toLowerCase(), msat: String(x.amount_msat), outIdx: x.out_idx }))
      : to.map((x) => ({ payoutPk: String(x.key).toLowerCase(), msat: String(x.msat), outIdx: null }));
    const remainderPayouts = outs.map((x) => ({ part: partOf.get(x.payoutPk) || null, ...x, txid: r.txid }));
    Object.assign(v, { remainderTxid: r.txid, remainderMsat: String(restPaid), remainderPayees: to.length, remainderPayouts, remainderAtMs: Date.now() }); keep();
    say({ federation: fid.slice(0, 16), remainder: String(restPaid), payees: to.length, txid: r.txid });
    return { paid: 0, notes: done.size, remainder: String(restPaid) };
  }
  const byKey = new Map();
  for (const n of due) byKey.set(n.payoutPk, (byKey.get(n.payoutPk) || 0n) + BigInt(n.msat));
  // THE BATCH ONCE (kanban #1174, keyed-payout.js): the batch's record ASKED - its key (the federation and the batch's number), its notes and list -
  // before the tool; the notes are paid only when it is PAID, in the same write
  if (!asked) v.notesPay = { batch: (v.notesBatches || 0) + 1, notes: due.map((n) => ({ nonce: n.nonce, payoutPk: n.payoutPk, msat: String(n.msat) })) };
  const got = await keyedPay({ rec: v.notesPay, save: keep, list: [...byKey.entries()].map(([k, m]) => ({ key: k, msat: m })), key: `liq-notes:${fid}:${v.notesPay.batch}`, ...runPayouts(run) });
  if (!got.ok) return { why: `no payout transaction: ${got.why}`, held: !!got.held };
  const paid = { txid: got.txid, payouts: got.payouts };
  v.notesBatches = v.notesPay.batch;
  v.notesPay = null;
  v.paidNonces = [...done, ...due.map((n) => n.nonce).filter((x) => !done.has(x))];
  const atMs = Date.now();
  v.payouts = [...(v.payouts || []), ...(paid.payouts || []).map((x) => ({ payoutPk: x.refund_pk, msat: String(x.amount_msat), txid: paid.txid, outIdx: x.out_idx, atMs }))];
  keep();
  say({ federation: fid.slice(0, 16), paidNotes: due.length, keys: byKey.size, txid: paid.txid });
  return { paid: due.length, notes: v.paidNonces.length, txid: paid.txid };
}

/**
 * WHAT THE ARBITRATION SET HOLDS FOR A LIQUIDATION'S TABLE (kanban #1247, audit 3 MONEY-2): its escrow on chain until it is spent into the safe
 * federation, then what that federation credited for it (`v.claimedMsat`, else the escrow's own amount). The spent output reads 0, and the door's
 * plan then gave every claim 0 - so a census-key escrow carried every claim the set had already paid at face, paid twice.
 */
export function escrowCoverageMsat(v, onChainMsat) {
  if (v && v.escrowTxid) {
    if (v.claimedMsat !== undefined && v.claimedMsat !== null) return BigInt(v.claimedMsat);
    if (v.escrowSats !== undefined && v.escrowSats !== null) return BigInt(v.escrowSats) * 1000n;
  }
  return BigInt(onChainMsat || 0n);
}
