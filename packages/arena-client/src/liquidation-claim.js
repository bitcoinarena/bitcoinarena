// THE CLIENT PRESENTS ITS NOTES TO A LIQUIDATION (spec §23A.5 step 2, kanban #323): "The client does the rest on its own: on
// every start it presents each unspent note it holds for that federation, as it would present them to the federation itself."
//
// For each federation a seat lists at GET /liquidations whose claim window is open and that names where claims go, and that this
// browser holds a wallet in: the whole wallet as out-of-band e-cash (the lock client's sendAllEcash - the notes leave the wallet),
// presented with the player's payout key. The e-cash is written to storage BEFORE it is presented and removed only once the
// arbitration set took it, so a closed tab or a refused post loses nothing: the next start presents the same string again,
// and notes claimed before are named, not lost.
const LIQUIDATION_ECASH_PREFIX = 'blwp-liquidation-ecash-';
export const pendingClaimKey = (fid) => `${LIQUIDATION_ECASH_PREFIX}${String(fid).toLowerCase()}`;

/**
 * `liquidations`: a seat's GET /liquidations entries; `held`: federation ids hex this browser holds a wallet in (ledgerFederations);
 * `walletFor(fid)`: the open lock client of that federation (with sendAllEcash); `payoutPk`: 64 hex, the key the claim is paid
 * to; `height`: the chain tip the page read; `storage`: getItem/setItem/removeItem. Answers one row per federation acted on.
 */
export async function presentNotes({ liquidations, held, walletFor, payoutPk, height, storage, fetcher = fetch }) {
  const out = [];
  const mine = new Set((held || []).map((f) => String(f).toLowerCase()));
  for (const l of liquidations || []) {
    const fid = String(l.federation || '').toLowerCase();
    if (!mine.has(fid) || !l.claims) continue;
    if (Number.isInteger(height) && (height < l.liquidatesAt || height > l.lateClaimsUntil)) { out.push({ federation: fid, ok: false, why: height < l.liquidatesAt ? `claims open at ${l.liquidatesAt}` : 'the claims closed' }); continue; }
    let ecash = storage.getItem(pendingClaimKey(fid));
    if (!ecash) {
      let sent;
      try { sent = JSON.parse(await (await walletFor(fid)).sendAllEcash()); } catch (e) { out.push({ federation: fid, ok: false, why: `the wallet could not hand over its notes: ${e.message}` }); continue; }
      if (!sent || !sent.ecash) { out.push({ federation: fid, ok: true, nothing: true, why: 'this wallet holds no note of that federation' }); continue; }
      ecash = sent.ecash;
      storage.setItem(pendingClaimKey(fid), ecash);   // kept before it leaves the page
    }
    try {
      const r = await fetcher(String(l.claims).replace(/\/+$/, '').replace(/\/liquidation-claims$/, '') + '/liquidation-claims',
        { method: 'POST', body: JSON.stringify({ federation: fid, ecash, payoutPk }), signal: AbortSignal.timeout(30000) });
      const j = await r.json().catch(() => ({}));
      const taken = r.ok || (Array.isArray(j.refused) && j.refused.length && j.refused.every((x) => /claimed before|spent set/.test(x.why)));
      if (taken) storage.removeItem(pendingClaimKey(fid));
      out.push({ federation: fid, ok: !!r.ok, accepted: j.accepted || [], refused: j.refused || [], inWindow: j.inWindow, why: j.why || null, kept: !taken });
    } catch (e) { out.push({ federation: fid, ok: false, why: e.message, kept: true }); }
  }
  return out;
}

// THE KEY A CLAIM IS PAID TO: one per federation, from the player's seed alone (the derivation of a round's player key over a
// round id of its own, H(tag || federation id)), so a seed restored on another device collects what the first presented.
// A payout is a pre-expired lock to refundKeyOf(that key), collected by Refund under it - as a slash payout is (kanban #307).
import { playerSecretFor } from '../../arena-protocol/src/player-key.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';

export function liquidationKeyFor(seed, federationHex, curve) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('a claim key comes from the player\'s 32-byte seed');
  if (!curve || typeof curve.pointX !== 'function') throw new Error('a claim key is a key on a curve, and none was injected');
  const secret = playerSecretFor(seed, taggedHash('ARENA/v1/LiquidationKey', fromHex(String(federationHex).toLowerCase())), 0);
  const pubkey = curve.pointX(secret);
  return { secret, pubkey, payoutPk: toHex(refundKeyOf(pubkey)) };
}

/**
 * THE PAYOUTS OF A LIQUIDATION THAT NAME THIS SEED (`listed`: the arbitration set's GET /liquidation-payouts), each collected
 * by Refund into `client` - this player's wallet of the federation the payout was locked in - once (`storage` notes it).
 */
export async function collectLiquidationPayouts({ listed, seed, curve, clientFor, storage }) {
  const out = [];
  for (const p of (listed && listed.payouts) || []) {
    const key = liquidationKeyFor(seed, p.federation, curve);
    if (String(p.payoutPk).toLowerCase() !== key.payoutPk) continue;
    const note = `blwp-liquidation-paid-${p.txid}:${p.outIdx}`;
    if (storage.getItem(note)) { out.push({ ...p, ok: true, kept: true }); continue; }
    const fields = { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: String(p.msat), claimPk: key.payoutPk, refundPk: key.payoutPk, expiration: 0 };
    try {
      const client = await clientFor(p.into);
      const said = JSON.parse(await client.refund(p.txid, Number(p.outIdx), JSON.stringify(fields), toHex(key.secret)));
      if (said.accepted === true) storage.setItem(note, JSON.stringify({ msat: p.msat, at: Date.now() }));
      out.push({ ...p, ok: said.accepted === true, why: said.accepted === true ? null : (said.error || 'the federation did not accept the refund') });
    } catch (e) { out.push({ ...p, ok: false, why: e.message }); }
  }
  return out;
}
