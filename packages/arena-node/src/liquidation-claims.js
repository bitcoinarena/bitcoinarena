// THE CLAIMS ON A HALTED FEDERATION'S ESCROW, AS THE ARBITRATION SET TAKES THEM (spec §23A.5 steps 2-4, RULED the owner
// 2026-09-21, kanban #323): "The arbitration set opens a claim window of claim_blocks ... The client ... presents each unspent
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

export function createLiquidationClaims({ validate, liquidationOf, height, escrowMsatOf, clocks, load = () => [], save = () => {} }) {
  const claims = new Map();                  // federation hex -> Map(nonce hex -> { nonce, amountMsat, height, payoutPk })
  for (const c of load() || []) {
    if (!claims.has(c.federation)) claims.set(c.federation, new Map());
    claims.get(c.federation).set(c.nonce, { nonce: c.nonce, amountMsat: BigInt(c.amountMsat), height: c.height, payoutPk: c.payoutPk });
  }
  const persist = () => save([...claims.entries()].flatMap(([federation, m]) => [...m.values()].map((c) => ({ federation, ...c, amountMsat: String(c.amountMsat) }))));

  /** POST /liquidation-claims { federation, ecash, payoutPk }: the notes taken, each one already claimed refused by name. */
  async function offer(body) {
    const fid = String(body && body.federation || '').toLowerCase();
    const payoutPk = String(body && body.payoutPk || '').toLowerCase();
    if (!isHex(fid, 64)) return { ok: false, status: 400, why: 'a claim names its federation (64 hex)' };
    if (!isHex(payoutPk, 64)) return { ok: false, status: 400, why: 'a claim names the x-only key it is paid to (64 hex)' };
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

  /** GET /liquidation-claims?federation=: who is paid what from the escrow, at the tip, by settleClaims' order. */
  async function plan(fidHex) {
    const fid = String(fidHex || '').toLowerCase();
    const liq = await liquidationOf(fid);
    if (!liq) return { ok: false, status: 404, why: 'that federation is not being liquidated' };
    const mine = [...(claims.get(fid) || new Map()).values()];
    const escrowMsat = BigInt(await escrowMsatOf(fid));
    const got = settleClaims({ escrowMsat, claims: mine, spentNonces: liq.spentNonces || null, haltHeight: liq.haltHeight, atHeight: await height(),
      clocks, noteSigned: () => true });
    if (!got.ok) return { ok: false, status: 409, why: got.why };
    const payTo = new Map(mine.map((c) => [c.nonce, c.payoutPk]));
    const byKey = new Map();
    for (const p of got.paid) byKey.set(payTo.get(p.nonce), (byKey.get(payTo.get(p.nonce)) || 0n) + p.msat);
    return { ok: true, federation: fid, escrowMsat: String(escrowMsat), notes: mine.length, proRata: got.proRata, rate: got.rate,
      spentSetPublished: got.spentSetPublished, payouts: [...byKey.entries()].map(([payoutPk, msat]) => ({ payoutPk, msat: String(msat) })),
      refused: got.refused, remainderMsat: String(got.remainderMsat), split: got.split ? { nodes: String(got.split.nodes), developers: String(got.split.developers) } : null,
      remainderSplitsAt: got.remainderSplitsAt };
  }
  return { offer, plan };
}
