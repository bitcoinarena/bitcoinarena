// THE CLIENT PRESENTS ITS NOTES TO A LIQUIDATION (spec §23A.5 step 2, kanban #323): "The client does the rest on its own: on
// every start it presents each unspent note it holds for that federation, as it would present them to the federation itself."
//
// For each federation a seat lists at GET /liquidations whose claim window is open and that names where claims go, and that this
// browser holds a wallet in: the whole wallet as out-of-band e-cash (the lock client's sendAllEcash - the notes leave the wallet),
// presented with the player's payout key. The e-cash is written to storage BEFORE it is presented and removed only once the
// arbitration set took it, so a closed tab or a refused post loses nothing: the next start presents the same string again,
// and notes claimed before are named, not lost.
const KEY = 'blwp-liquidation-ecash-';
export const pendingClaimKey = (fid) => `${KEY}${String(fid).toLowerCase()}`;

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
