// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLAIMS ON A HALTED FEDERATION'S ESCROW, AS THE ARBITRATION SET TAKES THEM (spec §23A.5 steps 2-4, RULED the owner
// 2026-09-21): "The arbitration set opens a claim window of claim_blocks ... The client ... presents each unspent
// note it holds for that federation, as it would present them to the federation itself ... A claim is valid if the note carries
// the federation's signature, its nonce is not in the published spent set, and it has not been claimed before. Valid claims are
// paid at face value from the escrow ... A note presented late is still paid from what is left, until drain_blocks".
//
// A CLAIM IS A SALE OF NOTES TO THE ESCROW: the client hands over its notes as out-of-band e-cash (the stock mint's send, the
// lock client's sendAllEcash) with the key it is paid to; the arbitration set holds them from then on. Should the federation
// come back (2f + 1 guardians return), the notes it bought are redeemed into the same escrow - the player was paid already.
//
// What the notes are is the federation's to say, so it is injected: `validate(federationHex, ecash)` checks every note's
// signature against that federation's mint keys and the spend keys, offline (fedimint-cli module mint validate), and answers
// { ok, amountMsat, notes: [{ nonce, amountMsat }] } or why not. `liquidationOf(federationHex)` is a seat's GET /liquidations
// entry for it (halt height, clocks, the newest spent set's nonces); `height()` the arbitration set's chain tip;
// `escrowMsatOf(federationHex)` what the escrow holds. Nothing here pays: `plan` is the table the window's end pays out.
import { settleClaims } from '../../arena-protocol/src/federation-slash.js';

const isHex = (s, n) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);

// PENDING OUTPUTS (spec §23A.5 "Notes still in issuance at the halt", RULED 2026-10-14): `checkPending(federationHex, requestHex)`
// recomputes an issuance request's note nonce, the hash160 of its blinded message and its amount (the fork's `mintv2 check-pending`)
// and answers { ok, nonce, nonceHash, amountMsat } or why not; `liquidationOf(fid).issuedHashes` is the issued set's nonce hashes.
export function createLiquidationClaims({ validate, liquidationOf, height, escrowMsatOf, clocks, checkPending = null, load = () => [], save = () => {} }) {
  const claims = new Map();                  // federation hex -> Map(nonce hex -> { nonce, amountMsat, height, payoutPk })
  for (const c of load() || []) {
    if (!claims.has(c.federation)) claims.set(c.federation, new Map());
    claims.get(c.federation).set(c.nonce, { nonce: c.nonce, amountMsat: BigInt(c.amountMsat), height: c.height, payoutPk: c.payoutPk, ...(c.messageHash ? { messageHash: c.messageHash } : {}) });
  }
  const persist = () => save([...claims.entries()].flatMap(([federation, m]) => [...m.values()].map((c) => ({ federation, ...c, amountMsat: String(c.amountMsat) }))));

  /** POST /liquidation-claims { federation, ecash, payoutPk }: the notes taken, each one already claimed refused by name. */
  async function offer(body) {
    const fid = String(body && body.federation || '').toLowerCase();
    const payoutPk = String(body && body.payoutPk || '').toLowerCase();
    if (!isHex(fid, 64)) return { ok: false, status: 400, why: 'a claim names its federation (64 hex)' };
    if (!isHex(payoutPk, 66) || !/^0[23]/.test(payoutPk)) return { ok: false, status: 400, why: 'a claim names the key it is paid to: a refund key, 33 bytes compressed (66 hex)' };
    if (typeof body.ecash !== 'string' || !body.ecash) return { ok: false, status: 400, why: 'a claim presents its notes as e-cash' };
    const liq = await liquidationOf(fid);
    if (!liq) return { ok: false, status: 409, why: 'that federation is not being liquidated: no seat holds it HALTED' };
    const at = await height();
    if (at < liq.liquidatesAt) return { ok: false, status: 409, why: `the claim window opens at ${liq.liquidatesAt} (halted at ${liq.haltHeight} + abandon_blocks); the tip is ${at}` };
    if (at > liq.lateClaimsUntil) return { ok: false, status: 409, why: `claims close at ${liq.lateClaimsUntil}, drain_blocks after the halt: notes presented later are the holder's loss` };
    const v = await validate(fid, body.ecash);
    if (!v || !v.ok) return { ok: false, status: 422, why: `those notes do not stand: ${v && v.why ? v.why : 'not validated'}` };
    const mine = claims.get(fid) || new Map(); claims.set(fid, mine);
    const spent = new Set((liq.spentNonces || []).map((n) => String(n).toLowerCase()));
    const accepted = []; const refused = [];
    for (const n of v.notes || []) {
      const nonce = String(n.nonce).toLowerCase();
      if (mine.has(nonce)) { refused.push({ nonce, why: 'that note was claimed before' }); continue; }
      if (spent.has(nonce)) { refused.push({ nonce, why: 'that note\'s nonce is in the published spent set' }); continue; }
      mine.set(nonce, { nonce, amountMsat: BigInt(n.amountMsat), height: at, payoutPk });
      accepted.push({ nonce, amountMsat: String(n.amountMsat) });
    }
    if (accepted.length) persist();
    return { ok: accepted.length > 0, status: accepted.length ? 200 : 409, accepted, refused, height: at, inWindow: at <= liq.claimWindowCloses,
      ...(accepted.length ? {} : { why: 'none of those notes can be claimed' }) };
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
    const mine = [...(claims.get(fid) || new Map()).values()];
    // what the escrow holds: on chain until it is pegged in, then what the safe federation credited for it (payOutLiquidation)
    const escrowMsat = given !== null ? BigInt(given) : BigInt(await escrowMsatOf(fid));
    const got = settleClaims({ escrowMsat, claims: mine, spentNonces: liq.spentNonces || null, haltHeight: liq.haltHeight, atHeight: await height(),
      clocks, noteSigned: () => true });
    if (!got.ok) return { ok: false, status: 409, why: got.why };
    const payTo = new Map(mine.map((c) => [c.nonce, c.payoutPk]));
    const byKey = new Map();
    for (const p of got.paid) byKey.set(payTo.get(p.nonce), (byKey.get(payTo.get(p.nonce)) || 0n) + p.msat);
    return { ok: true, federation: fid, escrowMsat: String(escrowMsat), notes: mine.length, proRata: got.proRata, rate: got.rate,
      paidNotes: got.paid.map((p) => ({ nonce: p.nonce, msat: String(p.msat), late: p.late, payoutPk: payTo.get(p.nonce) })),
      claimWindowCloses: liq.claimWindowCloses, lateClaimsUntil: liq.lateClaimsUntil,
      spentSetPublished: got.spentSetPublished, payouts: [...byKey.entries()].map(([payoutPk, msat]) => ({ payoutPk, msat: String(msat) })),
      refused: got.refused, remainderMsat: String(got.remainderMsat), split: got.split ? { nodes: String(got.split.nodes), developers: String(got.split.developers) } : null,
      remainderSplitsAt: got.remainderSplitsAt };
  }
  return { offer, offerPending, plan, liquidation: liquidationOf };
}

/**
 * PAYING THE TABLE (§23A.5 step 4), one pass at a time, every step kept (`v`, the service's state for this
 * federation) before the next, as payOutSlash does for a slash (§5A.3B):
 *   1. from the claim window's close: the whole escrow is spent by k of the set to a peg-in address of its own client of a SAFE
 *      federation (`run` the stake-lock tool over that client), and claimed there;
 *   2. the table (`claims.plan`, over what that federation credited) is paid note by note: every note not paid yet, summed per
 *      payout key, locked to that key (the tool's `pay`) - so a late note is paid by a later pass from what is left, never twice;
 *   3. after drain_blocks, the remainder - what no note claimed - 75 % to the nodes and 25 % to the donation set, as
 *      `remainderPayees(fid, msat)` names them ([{ key, msat }]: the census at that height less the slashed nodes and that
 *      federation's guardians, evenly, and the donation set by share_bps - federation-slash.js guardianSlashPayees' rule).
 * `spendEscrow(toScript)` builds, signs and posts the escrow's spend (buildEscrowPegin + assemble + post) and answers { txid } or why.
 */
export async function payOutLiquidation({ fid, v, claims, height, run, spendEscrow, remainderPayees = null, keep = () => {}, say = () => {} }) {
  const p0 = await claims.plan(fid);
  if (!p0.ok) return { why: p0.why };
  if ((await height()) <= p0.claimWindowCloses) return { why: `the claim window closes at ${p0.claimWindowCloses}` };
  if (!v.escrowTxid) {
    const addr = await run(['--mode', 'pegin-address']);
    if (!addr.address) return { why: `no peg-in address: ${addr.error || JSON.stringify(addr)}` };
    const sent = await spendEscrow(addr.address);
    if (!sent || !sent.txid) return { why: sent && sent.why ? sent.why : 'the escrow was not spent' };
    Object.assign(v, { escrowTxid: sent.txid, pegInAddress: addr.address }); keep();
    say({ federation: fid.slice(0, 16), escrowIntoSafeFederation: sent.txid });
  }
  if (!v.claimedMsat) {
    const c = await run(['--mode', 'pegin-claim', '--address', v.pegInAddress, '--timeout-s', '840']);
    if (!(c.balance_after_msat > c.balance_before_msat)) return { why: `the peg-in is not claimed yet: ${c.error || JSON.stringify(c)}` };
    v.claimedMsat = String(BigInt(c.balance_after_msat) - BigInt(c.balance_before_msat)); keep();
  }
  const p = await claims.plan(fid, { escrowMsat: BigInt(v.claimedMsat) });
  if (!p.ok) return { why: p.why };
  const done = new Set(v.paidNonces || []);
  const due = p.paidNotes.filter((n) => !done.has(n.nonce) && BigInt(n.msat) > 0n);
  if (!due.length) {
    // THE REMAINDER, once: only after drain_blocks (settleClaims names a split only then), every note's payout made first
    if (!p.split || v.remainderTxid || !remainderPayees) return { paid: 0, notes: done.size, ...(p.split && !remainderPayees ? { why: 'the remainder waits for its payees' } : {}) };
    const rest = BigInt(p.remainderMsat);
    const to = (await remainderPayees(fid, rest)).filter((x) => BigInt(x.msat) > 0n);
    if (!to.length) return { why: 'no payee for the remainder' };
    if (to.reduce((a, x) => a + BigInt(x.msat), 0n) > rest) return { why: 'the remainder\'s payees come to more than the remainder' };
    const r = await run(['--mode', 'pay', '--payouts', to.map((x) => `${x.key}:${x.msat}`).join(',')]);
    if (!r.txid) return { why: `no remainder transaction: ${r.error || JSON.stringify(r)}` };
    Object.assign(v, { remainderTxid: r.txid, remainderMsat: String(rest), remainderPayees: to.length }); keep();
    say({ federation: fid.slice(0, 16), remainder: String(rest), payees: to.length, txid: r.txid });
    return { paid: 0, notes: done.size, remainder: String(rest) };
  }
  const byKey = new Map();
  for (const n of due) byKey.set(n.payoutPk, (byKey.get(n.payoutPk) || 0n) + BigInt(n.msat));
  const paid = await run(['--mode', 'pay', '--payouts', [...byKey.entries()].map(([k, m]) => `${k}:${m}`).join(',')]);
  if (!paid.txid) return { why: `no payout transaction: ${paid.error || JSON.stringify(paid)}` };
  v.paidNonces = [...done, ...due.map((n) => n.nonce)];
  v.payouts = [...(v.payouts || []), ...(paid.payouts || []).map((x) => ({ payoutPk: x.refund_pk, msat: String(x.amount_msat), txid: paid.txid, outIdx: x.out_idx }))];
  keep();
  say({ federation: fid.slice(0, 16), paidNotes: due.length, keys: byKey.size, txid: paid.txid });
  return { paid: due.length, notes: v.paidNonces.length, txid: paid.txid };
}
