// WHICH TWENTY OTHER TRUCKS YOU SEE, AND WHY EVERY NODE PICKS THE SAME TWENTY.
//
// IMPLEMENTATION section 7: "Ghost fan-out uses interest management: each
// connection subscribes to ~20 others (nearest plus leaderboard top),
// recomputed every few seconds - O(N.K), never O(N^2)."
//
// The bandwidth reason is the obvious one: sixty players each sent every other
// player's picture is sixty times fifty-nine frames a broadcast, and twenty
// each is sixty times twenty. That is measured in `interest.test.js` rather
// than asserted here.
//
// THE OTHER REASON IS THE ONE THAT MATTERS. A set a node chooses however it
// likes is a set the OPERATOR chooses: show a player the competitors it wants
// them to see, hide the one about to beat them, and the round looks different
// depending on which node you connected to. 0.9 lets a player "watch other
// competitors drive, struggle, fail and arrive" - it does not say "watch
// whichever ones your node felt like sending". So the rule is a pure function
// of the round's own state, total-ordered, and two nodes handed the same
// players return the same twenty in the same order.
//
// K IS NOT A CONTRACT FIELD, and that is a deliberate difference from the
// census depth and the committee size. Those decide who sits and what a bond
// is worth, so a caller who could pick them could pick the committee. A ghost
// decides nothing - `frames.js` says so, and the core has no argument one
// could arrive through - so how many pictures a node can afford to send is a
// node's own bandwidth policy, not a rule the round signs. Naming it here as a
// constant with a default keeps it out of the round id and still keeps it out
// of a per-call argument nobody declared.
import { compareBytes } from './payout.js';

/** IMPLEMENTATION's "~20 others". A node may send fewer; it may not send more. */
export const GHOST_SUBSCRIPTIONS = 20;

/**
 * How the budget splits between the two reasons to watch somebody.
 *
 * Half the leaders and half the neighbours. Not tuned - it is the smallest
 * split that keeps both halves of "nearest plus leaderboard top" from being
 * squeezed out by the other, and an odd budget gives the extra seat to the
 * nearest, because a truck beside you is the one you might otherwise think you
 * could touch.
 */
export const LEADER_SHARE = 2;

/**
 * Squared distance, in BigInt.
 *
 * The words are Q16.16 in an i32, so a difference of a few hundred metres
 * squared leaves 32 bits behind long before the map runs out. Doing it in
 * Number would be exact for a while and then quietly stop being, which is the
 * failure that only shows up on a big map with two players far apart.
 */
export function distanceSquared(a, b) {
  const dx = BigInt(a.x) - BigInt(b.x);
  const dz = BigInt(a.z) - BigInt(b.z);
  return dx * dx + dz * dz;
}

/**
 * A total order over players, so ties do not depend on arrival order.
 *
 * Every comparison below ends in the entry id. Two nodes handed the same
 * players in different orders must return the same set, and a sort that left
 * ties to the input order would give a player a different twenty depending on
 * which node answered - the same fault a census tie on work had before it was
 * broken on the tip hash.
 */
const byThen = (score) => (a, b) => {
  const x = score(a);
  const y = score(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return compareBytes(a.entryId, b.entryId);
};

/**
 * The others this viewer subscribes to: the leaders, then the nearest.
 *
 * `others` are `{ entryId, x, z, rank }` - rank 0 is the best standing, and it
 * is the LEADERBOARD's, which 0.11 makes presentation from signed results
 * rather than anything this function decides.
 *
 * The viewer is never in their own set: a player does not need a picture of
 * the truck they are driving.
 */
export function interestSet(viewer, others, { limit = GHOST_SUBSCRIPTIONS } = {}) {
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error('a subscription budget is a whole number of others');

  const pool = others.filter((o) => compareBytes(o.entryId, viewer.entryId) !== 0);
  if (limit === 0 || pool.length === 0) return [];

  const leaders = [...pool].sort(byThen((o) => o.rank));
  const near = [...pool].sort(byThen((o) => distanceSquared(viewer, o)));

  const room = Math.min(limit, pool.length);
  const wantLeaders = Math.floor(room / LEADER_SHARE);

  const taken = new Map();
  const add = (o) => { if (!taken.has(key(o))) taken.set(key(o), o); };
  for (const o of leaders) { if (taken.size >= wantLeaders) break; add(o); }
  for (const o of near) { if (taken.size >= room) break; add(o); }
  // a leaderboard shorter than its half leaves room the neighbours did not
  // fill either; top up from the leaders rather than send fewer than asked
  for (const o of leaders) { if (taken.size >= room) break; add(o); }

  return [...taken.values()];
}

const key = (o) => {
  let s = '';
  for (const b of o.entryId) s += b.toString(16).padStart(2, '0');
  return s;
};

/**
 * Every viewer's set, and what it costs to send.
 *
 * `frames` is the number of ghost frames one broadcast puts on the wire - the
 * N.K of section 7 - so a caller can print it against the N^2 it is not.
 */
export function fanOut(players, options = {}) {
  const sets = new Map();
  let frames = 0;
  for (const viewer of players) {
    const set = interestSet(viewer, players, options);
    sets.set(key(viewer), set);
    frames += set.length;
  }
  return { sets, frames, everyone: players.length * Math.max(0, players.length - 1) };
}
