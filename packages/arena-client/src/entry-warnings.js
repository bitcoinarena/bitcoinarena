// WARNINGS BEFORE ENTRY (spec §18A.7 / §22A, kanban #316): "Clients SHOULD warn before entry when r >= 0.95, when K > 0.5 ·
// qualifier_count, or when the declared score function is not exposure-multiplicative" - and "rather than leaving the
// player to read a hash". The engine's own (contracts.js contractWarnings: a flat rank curve, a danger-level min_score) are
// read here from the contract the lobby checked; the game's own (its plugin's roundWarnings - nextblock's "exposure
// ignored", a non-multiplicative score, and a degenerate time factor) are the seats' word, and only codes this page can name
// are taken from it. K is not a contract field: the engine pays K = ceil(q / 4) (payout.js), never above half of two or
// more qualifiers, so that warning has no round to fire on.
import { contractWarnings } from '../../arena-protocol/src/contracts.js';

export const WARNING_SAYS = Object.freeze({
  flat_rank_curve: 'Its payout curve is nearly flat (r >= 0.95): the last paying rank is paid almost as much as the first, so playing it safe pays.',
  minimum_score_is_a_danger_rule: 'Its minimum score is above 100 points: a run that scores less is paid nothing.',
  exposure_ignored: 'Its score ignores exposure (not exposure-multiplicative): the safe route pays as well as the risky one.',
  time_factor_degenerate: 'Its time factor does nothing (its floor is not below its ceiling): time does not count in the score.',
});

/** The warning codes for a paying round: the engine's from its contract, and the game's the seats named that this page knows. */
export function entryWarnings(contract, fromSeats = []) {
  const own = contract ? contractWarnings(contract) : [];
  const seats = (fromSeats || []).filter((k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(WARNING_SAYS, k));
  return [...new Set([...own, ...seats])];
}

/** The sentences a page shows for the codes. */
export const warningsSay = (codes) => (codes || []).map((k) => WARNING_SAYS[k]).filter(Boolean);
