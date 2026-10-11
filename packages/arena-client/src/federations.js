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
    nominal: best.record.nominal, threshold: best.record.threshold, exposureCapSats: String(best.record.exposureCapSats) };
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
