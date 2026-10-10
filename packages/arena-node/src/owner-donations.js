// THE DEV CLIENT IN THE OWNER AREA (kanban #276 step 3, the owner 2026-10-09: "The dev client is fully integrated. Show
// donations for his games and as protocol dev"): what this seat verified for each recipient key it deals with - the
// protocol developers' sets it holds (signed by the network's donation authority) and the developer set of every game it
// hosts - in msat, per round and per UTC day the seat verified it, from its own donation index (round.donationsFor, filled by settlements).
// Read-only and public, as GET /donations is: amounts and outpoints already are. A dev's own client redeems.
import { toHex } from '../../arena-protocol/src/hash.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';

const hexKey = (k) => (k instanceof Uint8Array ? toHex(k) : String(k)).toLowerCase();

/** One recipient's rows (round.donationsFor shape) as totals: all, by round, by UTC day; amounts as decimal msat strings. */
export function donationTotals(rows) {
  let total = 0n;
  const byRound = new Map(), byDay = new Map();
  for (const r of rows || []) {
    const m = BigInt(r.amountMsat);
    total += m;
    const round = byRound.get(r.roundId) || { roundId: r.roundId, msat: 0n, donations: 0, firstMs: r.verifiedMs };
    round.msat += m; round.donations += 1; round.firstMs = Math.min(round.firstMs, r.verifiedMs);
    byRound.set(r.roundId, round);
    const day = new Date(Number(r.verifiedMs)).toISOString().slice(0, 10);
    const d = byDay.get(day) || { day, msat: 0n, donations: 0 };
    d.msat += m; d.donations += 1;
    byDay.set(day, d);
  }
  const s = (o) => ({ ...o, msat: String(o.msat) });
  return { totalMsat: String(total), donations: (rows || []).length,
    byRound: [...byRound.values()].sort((a, b) => b.firstMs - a.firstMs).map(s),
    byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)).map(s) };
}

/**
 * The report: `protocolSets` (signed sets: { networkId, serial, recipients }), `games` ([{ name, gameId, donationSet:
 * recipients }]) and `rowsFor(keyHex)` (the seat's index). Each set lists its recipients with their totals.
 */
export function donationReport({ protocolSets = [], games = [], rowsFor }) {
  const recipient = (r) => ({ label: r.label || '', key: hexKey(r.recipientPk), shareBps: Number(r.shareBps || 0), ...donationTotals(rowsFor(hexKey(r.recipientPk))) });
  const sets = [];
  for (const s of protocolSets) sets.push({ kind: 'protocol', title: 'Protocol developers', network: toHex(s.networkId).slice(0, 16), serial: Number(s.serial),
    setId: toHex(donationSetId(s.recipients)), recipients: s.recipients.map(recipient) });
  for (const g of games) if (Array.isArray(g.donationSet) && g.donationSet.length)
    sets.push({ kind: 'game', title: g.title || g.name, game: g.name, gameId: toHex(g.gameId), setId: toHex(donationSetId(g.donationSet)), recipients: g.donationSet.map(recipient) });
  const total = sets.reduce((t, s) => t + s.recipients.reduce((u, r) => u + BigInt(r.totalMsat), 0n), 0n);
  return { totalMsat: String(total), sets };
}
