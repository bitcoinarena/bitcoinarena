// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHICH ROUNDS COUNT FOR THE SEASON (ruling 2026-11-07 on #1218, kanban #1242, audit 3 #1210 FIXES-1). The settlement committee was drawn on
// the contract the account itself carried: two colluding bonded seats wrote 2-slot contracts after a beacon existed, ground a free field until
// the 3-seat draw held both, and signed an invented round onto the board, the leaderboard payout and the badges. A round now counts only when
// (1) its contract is byte-for-byte what a series this seat holds derives for its slot (seriesRoundCheck - grid, late-join and day grids, and the
// head-to-head grids published on demand), and it is a paid round: a paid series round's committee is drawn only on a series publication
// confirmed strictly below its beacon block (roster.js #chainCheck, in committeeFor, which seasonSeatsOf asks next) - before the round's
// start, as ruled - while a free round is never posted on chain, so it does not count; (2) it has the standard committees, 7 game / 7
// settlement seats, on every network (a smaller contract may be played, it does not count); (3) the committee's threshold signed the
// account (#1153, seasonSeatsOf). Every input is what this seat holds itself, so every seat answers the same.
import { seriesRoundCheck } from '../../arena-protocol/src/series.js';
import { slotsForRole } from '../../arena-protocol/src/sortition.js';
import { toHex } from '../../arena-protocol/src/hash.js';

export const SEASON_GAME_SLOTS = 7;
export const SEASON_SETTLEMENT_SLOTS = 7;

/**
 * Whether `contract` may count for the season at this seat: { ok } or { ok: false, why }. `series` the series this seat holds,
 * `pastSeries` (Map id hex -> template) the ones taken out of its file.
 */
export function seasonRoundStands(contract, { series = [], pastSeries = null } = {}) {
  if (!contract) return { ok: false, why: 'no contract' };
  let game, settlement;
  try { game = slotsForRole(contract, 'game'); settlement = slotsForRole(contract, 'settlement'); } catch (e) { return { ok: false, why: e.message }; }
  if (game !== SEASON_GAME_SLOTS || settlement !== SEASON_SETTLEMENT_SLOTS)
    return { ok: false, why: `a season round has ${SEASON_GAME_SLOTS} game and ${SEASON_SETTLEMENT_SLOTS} settlement seats, and this one ${game} and ${settlement}` };
  if (!(contract.seriesId instanceof Uint8Array)) return { ok: false, why: 'a season round is a round of a published series, and this one names none' };
  const past = pastSeries && typeof pastSeries.get === 'function' ? pastSeries.get(toHex(contract.seriesId)) : null;
  const c = seriesRoundCheck(contract, past ? [past] : series);
  if (!c.ok || !c.series) return { ok: false, why: c.why || 'not a round of a series this seat holds' };
  if (!(BigInt(contract.stakeMsat || 0n) > 0n)) return { ok: false, why: 'a free round is not published on chain before its start, so it does not count for the season' };
  return { ok: true };
}
