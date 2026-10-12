// WHAT THIS CLIENT BELIEVES ABOUT A FEDERATION (spec §23A.4, kanban #321): its guardians' newest signed record, read from
// the round's nodes (GET /federations) and checked against the census this client checked itself (committee.js, #296) -
// at least the threshold of the federation's bonded guardians, the invite naming that federation. Nothing else: "a client
// trusts nothing about a federation that has no record it can verify".
//   OPEN      everything as before
//   DRAINING  no deposit into it (said by name); everything else runs, withdrawals included
//   CRITICAL  Withdraw and Move only
//   HALTED    everything frozen, said so
//   CLOSED    its successor holds everything
//   unverified  no record that stands: shown, and nothing about it is taken on trust
import { verifyFederationRecord, newestRecord } from '../../arena-protocol/src/federation-record.js';
import { readInvite } from '../../arena-node/src/invite.js';
import { readWithOneRetry } from './reread.js';

const hexToBytes = (h) => Uint8Array.from(String(h).match(/../g).map((x) => parseInt(x, 16)));
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const inviteFederationId = (invite) => { const f = readInvite(invite).federationId; return f ? hexToBytes(f) : null; };

/** What a page may do with a federation in each status. */
export const FEDERATION_ALLOWS = Object.freeze({
  OPEN: { deposit: true, join: true, withdraw: true, move: true },
  DRAINING: { deposit: false, join: true, withdraw: true, move: true },
  CRITICAL: { deposit: false, join: false, withdraw: true, move: true },
  HALTED: { deposit: false, join: false, withdraw: false, move: false },
  CLOSED: { deposit: false, join: false, withdraw: true, move: true },
  unverified: { deposit: true, join: true, withdraw: true, move: true },
});

/**
 * THE FEDERATION'S STATUS AS THIS CLIENT CAN STAND BEHIND IT. `census` is the entries of a census this client checked
 * (with their advertisements); `verify` BIP-340. Answers { status, allows, signers, height, from, why }.
 */
export async function federationStatus({ federationIdHex, nodes, census, verify, fetcher = fetch }) {
  const fid = String(federationIdHex).toLowerCase();
  const verified = [], refused = [];
  await Promise.all((nodes || []).map(async (u) => {
    try {
      const r = await readWithOneRetry(fetcher, `${String(u).replace(/\/+$/, '')}/federations`);
      if (!r.ok) { refused.push(`${u}: ${r.status}`); return; }
      const j = await r.json();
      for (const f of j.federations || []) {
        if (String(f.federation).toLowerCase() !== fid) continue;
        const v = verifyFederationRecord(hexToBytes(f.record), { census, verify, inviteFederationId });
        if (v.ok) verified.push({ ...v, from: u }); else refused.push(`${u}: ${v.why}`);
      }
    } catch (e) { refused.push(`${u}: ${e.message}`); }
  }));
  const best = newestRecord(verified);
  if (!best) return { status: 'unverified', allows: FEDERATION_ALLOWS.unverified, why: refused.length ? `no record stands: ${refused[0]}` : 'no node holds a record of this federation' };
  return { status: best.status, allows: FEDERATION_ALLOWS[best.status], signers: best.signers, height: best.record.height, from: best.from,
    nominal: best.record.nominal, threshold: best.record.threshold, exposureCapSats: String(best.record.exposureCapSats),
    // THE LOAD (§23A.3, kanban #324): the signed reserve over the signed exposure cap - what the federation holds against what
    // its smallest set of leavers' bonds covers; null when the record names no cap
    reserveSats: String(best.record.reserveSats ?? 0n),
    load: best.record.exposureCapSats > 0n ? Number(((best.record.reserveSats ?? 0n) * 10000n) / best.record.exposureCapSats) / 10000 : null,
    // THE SUCCESSION (§23A.6, kanban #325): the successor the guardians named (hex, or null) and this federation's own invite,
    // so a page can open the player's wallet in the successor from the successor's record
    successorId: best.record.successorId && best.record.successorId.some((x) => x) ? bytesToHex(best.record.successorId) : null,
    invite: best.record.invite || null };
}

/** The sentence a page shows when a federation holds more than its guardians' bonds cover (load >= 1), else ''. */
export function loadSays(fed) {
  if (!fed || typeof fed.load !== 'number' || fed.load < 1) return '';
  const sat = (x) => `${Number(BigInt(x || 0)).toLocaleString('en-US')} sat`;
  return `Load ${fed.load.toFixed(2)}: this federation holds ${sat(fed.reserveSats)}, more than the ${sat(fed.exposureCapSats)} its guardians' bonds cover.`;
}

/** The sentence a page shows for a status that holds something back. */
export function federationSays(status) {
  return ({
    DRAINING: 'This federation is being replaced: no new deposit goes into it. Play, Withdraw and Move work as before.',
    CRITICAL: 'This federation is one guardian away from halting: only Withdraw and Move are open.',
    HALTED: 'This federation has halted: every note and lock is frozen until its guardians return or it is liquidated.',
    CLOSED: 'This federation is closed: its successor holds everything.',
    unverified: 'No signed record of this federation could be checked: nothing about it is taken on trust.',
  })[status] || '';
}

// ---- the known-good list and the player's own confirmation (kanban #318, spec §23.6) ----
import { federationIsKnown, knownFederation } from '../../arena-protocol/src/known-federations.js';
export { federationIsKnown, knownFederation };

/** Every guardian of `federationIdHex` in a census this client checked: operator, node key, guardian endpoint, bond. */
export function guardianRowsOf(census, federationIdHex) {
  const fid = String(federationIdHex).toLowerCase();
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const rows = [];
  for (const e of census || []) {
    const g = ((e.advert && e.advert.guardianOf) || []).find((x) => hex(x.federationId) === fid);
    if (g) rows.push({ operator: (e.advert && e.advert.operatorId) || '', nodeKey: hex(e.pubkey), guardianKey: hex(g.guardianKey),
      endpoint: (e.advert && e.advert.guardianEndpoint) || '', bondSats: String(e.bondSats) });
  }
  return rows.sort((a, b) => (a.nodeKey < b.nodeKey ? -1 : 1));
}

const CONFIRM_KEY = 'arena.fed.confirmed.';
/** This browser's own confirmation of a federation not on the list: asked once, kept until Forget. */
export const federationConfirmed = (storage, fidHex) => { try { return !!storage.getItem(CONFIRM_KEY + String(fidHex).toLowerCase()); } catch { return false; } };
export function confirmFederation(storage, fidHex, nowMs = Date.now()) { storage.setItem(CONFIRM_KEY + String(fidHex).toLowerCase(), String(nowMs)); }
export function forgetFederation(storage, fidHex) { storage.removeItem(CONFIRM_KEY + String(fidHex).toLowerCase()); }
export function confirmedFederations(storage) {
  const out = [];
  try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(CONFIRM_KEY)) out.push({ federation: k.slice(CONFIRM_KEY.length), atMs: Number(storage.getItem(k)) }); } } catch { /* none */ }
  return out;
}

/** Does this invite name the round's federation? The stock Fedimint client checks the config hash itself when it joins. */
export function inviteNamesFederation(invite, federationIdHex) {
  let f; try { f = readInvite(invite).federationId; } catch { return false; }
  return !!f && String(f).toLowerCase() === String(federationIdHex).toLowerCase();
}
