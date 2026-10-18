// A LEADERBOARD PAYOUT REQUEST FROM THE PAGE (kanban #460): built from the form - the scope, the top N, the amount, the paying federation,
// an equal or a per-place split, the period and the payment date turned into a height - checked by the record's own rules before it is
// signed by the forum's key, and handed to every node as a funding proposal is (funding-page.js postFunding, kind 'leaderboard'). A
// winner's payout needs nothing here: it is a payout contract to the winner's identity key, recorded on the seats under that key, which
// the page's zap collector (identity.js collectZaps) already reads and spends into the wallet.
import { encodeLeaderboardPayout, leaderboardPayoutId, leaderboardVotePeriod, LB_SCOPE, LB_PERIOD_DAYS, LB_TOP_MAX } from '../../arena-protocol/src/leaderboard-payout.js';
import { FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const lbCurveOf = (curve) => { const c = curve || globalThis.BLWP_CURVE; if (!c || typeof c.pointX !== 'function') throw new Error('no curve loaded (blwp-curve.js)'); return c; };
/** A block about every 10 minutes: the height a date falls at, from the tip now. */
export const LB_BLOCK_MS = 600000;
export const heightAtDate = ({ tip, nowMs, dateMs }) => tip + Math.max(1, Math.ceil((Number(dateMs) - Number(nowMs)) / LB_BLOCK_MS));

/**
 * THE REQUEST, CHECKED THEN SIGNED: the record's own rules (leaderboard-payout.js encodeLeaderboardPayout) and a payment height no earlier
 * than its vote is decided (published + 2 weeks + depth) - one a seat would refuse is never signed. Answers { ok, id, hex, decidableAt }
 * or { ok: false, why }.
 */
export function signedLeaderboardPayout({ secretKey, networkId, publishedHeight, scope, gameName = '', top, amountSats, federationId, splitBps = [], periodDays,
  paymentHeight, purpose = '', schedule = FUNDING_SCHEDULES.spec, curve }) {
  const c = lbCurveOf(curve);
  const p = { networkId: fromHex(networkId), author: c.pointX(secretKey), publishedHeight, scope, gameName: scope === LB_SCOPE.ALL ? '' : String(gameName),
    top: Number(top), amountSats: BigInt(amountSats), federationId: fromHex(federationId), splitBps, periodDays: Number(periodDays), paymentHeight, purpose: String(purpose) };
  try { encodeLeaderboardPayout(p); } catch (e) { return { ok: false, why: e.message }; }
  const vp = leaderboardVotePeriod({ proposal: p, schedule });
  if (paymentHeight < vp.decidableAt) return { ok: false, why: `the payment comes before its 2-week vote is decided (block ${vp.decidableAt})` };
  const id = leaderboardPayoutId(p);
  return { ok: true, id: toHex(id), hex: toHex(Uint8Array.from([...encodeLeaderboardPayout(p), ...c.signSchnorr(id, secretKey)])), decidableAt: vp.decidableAt };
}

/** A per-place split typed as percents ("50, 30, 20"): bps that add up to 10000 for `top` places, or [] for equal. */
export function splitFromPercents(text, top) {
  const s = String(text || '').trim();
  if (!s) return { ok: true, splitBps: [] };
  const parts = s.split(/[,\s]+/).filter(Boolean).map((x) => Math.round(Number(x.replace(',', '.')) * 100));
  if (parts.length !== Number(top) || parts.some((b) => !Number.isInteger(b) || b < 1)) return { ok: false, why: `name a share for each of the ${top} places, or leave it empty for equal` };
  const sum = parts.reduce((t, b) => t + b, 0);
  if (sum !== 10000) return { ok: false, why: `the shares add up to ${sum / 100} %, not 100 %` };
  return { ok: true, splitBps: parts };
}

/** The leaderboard payout requests as the nodes hold them (GET /funding): the list of the node that answers with the most. */
export async function fetchLeaderboards({ nodes, fetcher = (u, o) => fetch(u, o), timeoutMs = 10000 } = {}) {
  const asked = [...new Set((nodes || []).map((n) => String(n).replace(/^ws(s?):/, 'http$1:').replace(/\/+$/, '')))];
  const answers = (await Promise.all(asked.map(async (b) => {
    try { const r = await fetcher(`${b}/funding`, { signal: AbortSignal.timeout(timeoutMs) }); return r.ok ? await r.json() : null; } catch { return null; }
  }))).filter((a) => a && Array.isArray(a.leaderboards));
  if (!answers.length) return { ok: false, why: 'no node answered with leaderboard payouts', asked: asked.length };
  const best = answers.sort((a, b) => b.leaderboards.length - a.leaderboards.length)[0];
  return { ok: true, leaderboards: best.leaderboards, tip: best.tip, answered: answers.length, asked: asked.length };
}
export { LB_SCOPE, LB_PERIOD_DAYS, LB_TOP_MAX };
