// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE BOUNTY'S CHECKLIST (kanban #1342, Daniel 2026-11-08): "the conditions as a checklist that fills in live from the census for the reporter's npub
// (in census, bonded, online 7 days, committees and signed rounds, owner key = your npub)". Read from the seats' public doors only, so it works for a
// node on any release:
//   owner       the node's own GET /owner (its claimed owner key) - found among the seats GET /network-games lists
//   committees  every seat's GET /served?finals=1 for each of the last 7 UTC days: the rounds whose committee names the node, and those it signed FINAL
//   in census   a node drawn into a committee is a bonded census node (only those are drawn); the days it served are its days online
// Answers { ok, node, checks: [{ key, label, ok, says }], passes } - `passes` only when every check holds. Team nodes are refused by `excluded`.
import { splitSignedFinalSig, decodeFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const DAY_MS = 24 * 3600 * 1000;
// a held FINAL (hex of its signed bytes) -> its signer's node key hex; a key given as such is taken as it is (a test's)
const signerOf = (f) => {
  const h = String(f).toLowerCase();
  if (/^[0-9a-f]{64}$/.test(h)) return h;
  try { const bytes = fromHex(h); const { signature } = splitSignedFinalSig(bytes); return toHex(decodeFinalSig(bytes.subarray(0, bytes.length - signature.length)).signerPubkey); } catch { return null; }
};
export const NODE_BOUNTY_DAYS = 7;

// `teamHosts` hostnames the team runs its nodes on: a node whose own door answers there is a team node, never paid
export async function nodeBountyCheck({ node, npub, seats, fetchJson, nowMs = Date.now(), excluded = new Set(), days = NODE_BOUNTY_DAYS, teamHosts = [] }) {
  const n = String(node || '').toLowerCase(), me = String(npub || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(n) || !/^[0-9a-f]{64}$/.test(me)) return { ok: false, why: 'a node key and an owner key, 64 hex each' };
  const urls = [...new Set((seats || []).map((u) => String(u).replace(/\/+$/, '')))];
  // THE OWNER: the node's own word, from its own door
  let owner = null, at = null;
  await Promise.all(urls.map(async (u) => { try { const o = await fetchJson(`${u}/owner`); if (o && String(o.node).toLowerCase() === n) { at = u; if (o.claimed) owner = String(o.owner || '').toLowerCase(); } } catch { /* not answering */ } }));
  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
  const team = excluded.has(n) || excluded.has(me) || (at !== null && (teamHosts || []).map((h) => String(h).toLowerCase()).includes(hostOf(at)));
  // THE LAST `days` UTC DAYS: each seat's rounds of that day, merged by round id
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  // the days in parallel (measured 2026-11-08 on 17 seats: one after another took 120 s)
  const perDay = await Promise.all(Array.from({ length: days }, (_, i) => days - i).map(async (d) => {
    const from = today - d * DAY_MS, to = from + DAY_MS;
    const rounds = new Map();
    await Promise.all(urls.map(async (u) => {
      try {
        const j = await fetchJson(`${u}/served?from=${from}&to=${to}&finals=1`);
        for (const r of (j && j.held) || []) if (!rounds.has(r.roundId)) rounds.set(r.roundId, r);
      } catch { /* a seat that does not answer adds nothing */ }
    }));
    const mine = [...rounds.values()].filter((r) => (r.committee || []).map((k) => String(k).toLowerCase()).includes(n));
    return { from, committees: mine.length, signed: mine.filter((r) => (r.finals || []).map(signerOf).includes(n)).length };
  }));
  const committees = perDay.reduce((t, x) => t + x.committees, 0), signed = perDay.reduce((t, x) => t + x.signed, 0);
  const daysOn = perDay.filter((x) => x.committees > 0).length;
  const checks = [
    { key: 'census', label: 'In the census and bonded', ok: committees > 0, says: committees > 0 ? 'drawn into committees: only bonded census nodes are' : 'not drawn into any committee in the last 7 days' },
    { key: 'online', label: `Online ${days} days`, ok: daysOn >= days, says: `served on ${daysOn} of the last ${days} days` },
    { key: 'committees', label: 'Committees and signed rounds', ok: committees > 0 && signed > 0, says: `${committees} committees, ${signed} signed rounds` },
    { key: 'owner', label: 'Owner key = your npub', ok: owner === me, says: owner === null ? 'the node did not name its owner (no seat lists it, or it is not claimed)' : owner === me ? 'its owner page is claimed by your key' : 'its owner is another key' },
    { key: 'outside', label: 'Not a team node', ok: !team, says: team ? `a team node is never paid${at ? ` (it answers at ${hostOf(at)})` : ''}` : 'outside the team' },
  ];
  return { ok: true, node: n, npub: me, days: perDay, checks, passes: checks.every((c) => c.ok) };
}
