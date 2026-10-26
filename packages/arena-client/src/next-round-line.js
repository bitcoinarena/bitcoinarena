// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHEN THE NEXT ROUND STARTS, SAID PLAINLY (kanban #690, 2026-10-26, the owner on "Next round expected: entry opens with the next window. It
// starts once its committee block is in: a block after 18:00 UTC, then 6 confirmations (~1 h)": "It should communicate clearly when the next round
// starts, clear timing - X hours, Y minutes and N confirmations"). From the grids a seat's GET /pending names for a game - each with its first
// window, its publication's confirmations and its draw (beacon) block's depth on the seat's own chain - one line: when entry opens, in hours
// and minutes and at what UTC time, and where the committee block stands. A grid already posted to the seats is skipped: one the page does not
// list then has no window it can be drawn for. A round's entry opens at its window, but never before its committee block is 6 deep.

const NEEDED = 6;
/** "2 h 14 min", "45 min", "less than a minute". */
export function inHoursMinutes(ms) {
  const m = Math.round(Number(ms) / 60000);
  if (m < 1) return 'less than a minute';
  const h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}
const hhmm = (ms) => new Date(Number(ms)).toISOString().slice(11, 16) + ' UTC';

/**
 * The line for `game` (its name) from /pending's `grids` at `nowMs`. `blockMs` the average block time the estimate uses (testnet4: 10 min).
 * Answers { text, grid, opensMs } or null when no grid of the game is on its way.
 */
export function nextRoundLine({ grids, game, nowMs = Date.now(), blockMs = 600000 }) {
  const opensOf = (g) => {
    const beacon = g.beacon || {}, needed = Number(beacon.needed) || NEEDED, depth = Number(beacon.depth) || 0;
    // the committee block 6 deep: the blocks still missing at the average block time; before the beacon, the committee time plus 6 blocks
    const deepMs = beacon.height !== null && beacon.height !== undefined ? nowMs + Math.max(0, needed - depth) * blockMs
      : Math.max(nowMs, Number(g.committeeTimeMs)) + needed * blockMs;
    return Math.max(Number(g.firstWindowMs), deepMs);
  };
  // A LIVE GRID FIRST (measured 2026-10-26 11:3xZ: the line named an emergency grid whose round table a replaced coin had conflicted -
  // "not on chain yet", 11:54 - while its reposted grid waited in the mempool): one in a block or in the mempool, the soonest to open;
  // a round table in neither only when nothing else is on its way
  const live = (g) => { const p = g.publication || {}; return (p.height !== null && p.height !== undefined) || !!p.inMempool; };
  const mine = (Array.isArray(grids) ? grids : []).filter((g) => g && g.game === game && Number(g.lastCloseMs) > nowMs && g.stage !== 'posted')
    .map((g) => ({ g, opens: opensOf(g), live: live(g) }))
    .sort((a, b) => Number(b.live) - Number(a.live) || a.opens - b.opens);
  if (!mine.length) return null;
  const { g, opens: opensMs } = mine[0];
  const pub = g.publication || {}, beacon = g.beacon || {};
  const needed = Number(beacon.needed) || NEEDED, depth = Number(beacon.depth) || 0;
  const confirmed = pub.height !== null && pub.height !== undefined;
  const when = opensMs > nowMs ? `Next round in ${inHoursMinutes(opensMs - nowMs)} (about ${hhmm(opensMs)})` : 'Next round: any minute now';
  const draw = !confirmed ? (pub.inMempool ? 'its round table is waiting to be mined' : 'its round table is not on chain yet')
    : beacon.height === null || beacon.height === undefined ? `its committee block is the first after ${hhmm(g.committeeTimeMs)}, then ${needed} confirmations`
    : depth >= needed ? `its committee block has all ${needed} confirmations` : `its committee block has ${depth} of ${needed} confirmations`;
  return { text: `${when} · ${draw}.`, grid: g, opensMs };
}
