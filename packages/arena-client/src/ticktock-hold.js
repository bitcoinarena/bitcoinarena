// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLIENT HOLDS A TICK TOCK SNAPSHOT FIVE OF SEVEN SEATS SIGN (spec ruling of kanban #2571, #2574).
//
// A round on a core that draws its parcels plays the transactions of its beacon block. The client gets the snapshot from any
// seat (GET /snapshot?round=), recomputes its id itself (arena-protocol ticktock-snapshot.js), checks the txids against the
// walked blocks' headers (merkle roots, parent links, which transactions the walk takes), and holds it only when the round's
// threshold of its own signer nodes name that id in their signed listing (GET /rounds: each row's `snapshot`, signed with the
// row - lobby-listing.js). The sizes and fees are not in a header: that is what the seats' signatures vouch for. Then the offers
// are drawn here with the same function every seat checks a load by: offersOf(snapshot, round, entry).
import { snapshotFromJson, snapshotIdOf, snapshotStandsOnHeaders, offersOf, offeredParcel } from '../../arena-protocol/src/ticktock-snapshot.js';
import { blockHashOf } from '../../arena-protocol/src/chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lobbySignedArgs } from './lobby.js';

/**
 * The snapshot, held or not. `roundId` hex; `signers` the round's signer node keys (hex, from its verified contract); `needed`
 * the round's threshold (5 of 7); `listings` what seats answered at GET /rounds - [{ node, nowMs, rounds }]; `snapshot` a GET
 * /snapshot answer; `verify(sig, msg, key)` BIP-340. Answers { ok, snapshot, id, signedBy } or { ok: false, why, signedBy }.
 */
export function snapshotHeld({ roundId, signers, needed, listings, snapshot, verify }) {
  if (typeof verify !== 'function') throw new Error('a snapshot is held on signatures: inject verify');
  let s;
  try { s = snapshotFromJson(snapshot); } catch (e) { return { ok: false, why: `that is no snapshot: ${e.message}`, signedBy: [] }; }
  const id = toHex(snapshotIdOf(s));
  const stands = snapshotStandsOnHeaders(s, snapshot.blocks || [], { blockHashOf });
  if (!stands.ok) return { ok: false, why: `the snapshot does not stand on its blocks: ${stands.why}`, signedBy: [] };
  const keys = new Set([...signers].map((k) => String(k).toLowerCase()));
  const signedBy = new Set();
  for (const l of listings || []) {
    const nodeKey = l && String(l.node || '').toLowerCase();
    if (!keys.has(nodeKey) || signedBy.has(nodeKey)) continue;
    const row = Array.isArray(l.rounds) ? l.rounds.find((x) => x && x.id === roundId) : null;
    if (!row || row.snapshot !== id) continue;
    const a = lobbySignedArgs({ id: roundId, nodeKey, nowMs: l.nowMs, x: row });
    let good = false;
    try { good = !!a && !!verify(a.sig, a.msg, a.key); } catch { good = false; }
    if (good) signedBy.add(nodeKey);
  }
  if (signedBy.size < needed) return { ok: false, why: `${signedBy.size} of the round's signer nodes sign snapshot ${id.slice(0, 16)}, and it needs ${needed}`, signedBy: [...signedBy] };
  return { ok: true, snapshot: s, id, signedBy: [...signedBy] };
}

/**
 * Asks the seats: each one's listing of the round, and the snapshot from the first seat that serves one that is held.
 * `nodes` base URLs. Answers what snapshotHeld answers, with the offers drawn for `entryId` (hex) when given.
 */
export async function fetchHeldSnapshot({ nodes, roundId, entryId = null, signers, needed, verify, fetcher = fetch }) {
  const listings = (await Promise.all(nodes.map(async (n) => {
    try { const r = await fetcher(`${n.replace(/\/+$/, '')}/rounds?all=1`); return r.ok ? await r.json() : null; } catch { return null; }
  }))).filter(Boolean);
  let last = { ok: false, why: 'no seat served the snapshot', signedBy: [] };
  for (const n of nodes) {
    let j;
    try { const r = await fetcher(`${n.replace(/\/+$/, '')}/snapshot?round=${roundId}`); if (!r.ok) continue; j = await r.json(); } catch { continue; }
    const held = snapshotHeld({ roundId, signers, needed, listings, snapshot: j, verify });
    if (!held.ok) { last = held; continue; }
    if (entryId) {
      const rid = Uint8Array.from(roundId.match(/../g).map((h) => parseInt(h, 16))), eid = Uint8Array.from(entryId.match(/../g).map((h) => parseInt(h, 16)));
      held.offers = offersOf(held.snapshot, rid, eid).map((o) => ({ slot: o.slot, txid: toHex(o.txid), vsize: o.vsize, fee: String(o.feeSat) }));
    }
    return held;
  }
  return last;
}

export { offersOf, offeredParcel };
