// THE PROTOCOL RESERVES ON THE PAGE (§27A.9, kanban #397 slice 3): a version-11 round's entry pays the developers' 4 % and the
// reserves' 2 % - mandatory, not the player's donation choice - and locks the reserves' part to its federation's 5-of-7 reserve
// key. The key is read from the round's signer nodes (GET /reserves), and taken only when at least `needed` of them name the
// same one for that federation: no single seat can point the reserves somewhere else.
import { roundSplit, RESERVES_DONATION_BPS, ROUND_SPLIT_BPS } from '../../arena-protocol/src/reserves.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { stakeOf } from './join.js';

export async function fetchReserveKey({ federationId, nodes, needed = 5, fetcher = (u, o) => fetch(u, o), timeoutMs = 8000 } = {}) {
  if (!(federationId instanceof Uint8Array) || federationId.length !== 32) return { ok: false, why: 'the round names no federation to pay the reserves in' };
  const fed = toHex(federationId);
  const said = new Map();
  const asked = [...new Set((nodes || []).map((n) => String(n).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '')))];
  await Promise.all(asked.map(async (base) => {
    try {
      const r = await fetcher(`${base}/reserves`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return;
      const f = ((await r.json()).federations || []).find((x) => x.federationId === fed && /^0[23][0-9a-f]{64}$/.test(String(x.key || '')));
      if (f) said.set(f.key, (said.get(f.key) || 0) + 1);
    } catch { /* a node that does not answer names nothing */ }
  }));
  const best = [...said.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best) return { ok: false, why: `none of the round's ${asked.length} signer nodes names a reserve key for federation ${fed.slice(0, 8)}` };
  if (best[1] < needed) return { ok: false, why: `only ${best[1]} of the round's signer nodes name reserve key ${best[0].slice(0, 16)}, and ${needed} must` };
  return { ok: true, key: fromHex(best[0]), agreeing: best[1], asked: asked.length };
}

/** What a version-11 entry gives beside its stake: { bps, donationMsat, reserveMsat, mandatory } - the developers' 4 % and the reserves' 2 %. */
export function reservesDonation(stakeMsat) {
  const s = roundSplit(BigInt(stakeMsat));
  return { bps: RESERVES_DONATION_BPS + ROUND_SPLIT_BPS.reserves, donationMsat: s.protocolDevsMsat + s.gameDevsMsat + s.reservesMsat, reserveMsat: s.reservesMsat, mandatory: true };
}

/** The same for a round as the page holds it (its stake as the join reads it, stakeOf). */
export const reservesDonationForRound = (round) => reservesDonation(stakeOf(round));

/**
 * THE RESERVES' TOTAL ON THE PAGE (§27A.9.2, kanban #397 slice 4: "testnet.bitcoin-arena.io shows the total and the latest
 * payments in"): GET /reserves on the network's nodes; a total is shown only when at least `needed` of them answer the same one,
 * and its payments in are those nodes' own list, newest first. Answers { ok, totalMsat, entries, paidIn, agreeing, asked } or why not.
 */
export async function fetchReservesTotal({ nodes, needed = 5, fetcher = (u, o) => fetch(u, o), timeoutMs = 8000 } = {}) {
  const asked = [...new Set((nodes || []).map((n) => String(n).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '')))];
  const by = new Map();
  await Promise.all(asked.map(async (base) => {
    try {
      const r = await fetcher(`${base}/reserves`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return;
      const j = await r.json();
      if (!/^\d+$/.test(String(j.totalMsat ?? ''))) return;
      const k = String(j.totalMsat);
      const had = by.get(k) || { n: 0, answer: j };
      had.n++; by.set(k, had);
    } catch { /* a node that does not answer names nothing */ }
  }));
  const best = [...by.entries()].sort((a, b) => b[1].n - a[1].n || (BigInt(b[0]) > BigInt(a[0]) ? 1 : -1))[0];
  if (!best) return { ok: false, why: `none of ${asked.length} nodes answered the reserves`, asked: asked.length };
  if (best[1].n < needed) return { ok: false, why: `only ${best[1].n} of ${asked.length} nodes name the same reserves, and ${needed} must`, asked: asked.length };
  const a = best[1].answer;
  return { ok: true, totalMsat: BigInt(best[0]), entries: Number(a.entries) || 0, paidIn: Array.isArray(a.paidIn) ? a.paidIn : [], agreeing: best[1].n, asked: asked.length };
}
