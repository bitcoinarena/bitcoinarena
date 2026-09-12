// THE PLAYER'S FIRST MARK AGAINST THE ROUND'S START DEADLINE (§15, §16, §13C).
//
// A round names a start deadline in ticks after a player's join tick (or gets
// START_DEADLINE_TICKS). The first mark - the one that chains to nothing - is
// where the player commits to a first tick, under the entry's session key; the
// tick it names is the player's own, and every seat reads the same number.
//
// RULED (M3, pick (a)): A FIRST MARK SIGNED AFTER join_tick + THE DEADLINE IS
// THE PLAYER'S OWN ACT, so it is FORFEIT - player conduct (§15: "the player
// normally becomes FAILED or FORFEIT") - and NOT ENTRY_VOID. The world is known
// before the first tick, so a late first mark that refunded would be a refund
// the player chose after seeing the run; §13C: "a player cannot manufacture a
// refund". ENTRY_VOID stays §16's outage refund ("if fewer than 5 game/verify
// nodes are available ... refunded"), and it is not decided here.
//
// In time: nothing is decided here; the mark goes on as any mark. No first mark
// at all: nothing - not ENTRY_VOID and not FORFEIT (§15's walk-away, unbuilt).
//
// THE LOCK: a FORFEIT stake is claimed in the round's settlement transaction
// (§23.2) - W4, parked behind the fee-lock ruling. Until then a FORFEIT lock
// refunds at expiry: the money hole every loser has, listed, not closed.
import { START_DEADLINE_TICKS } from './constants.js';
import { FORFEIT } from './payout.js';

/** The round's start deadline, in ticks after a player's join tick. */
export const startDeadlineOf = (contract) =>
  (contract && contract.startDeadlineTicks !== undefined ? contract.startDeadlineTicks : START_DEADLINE_TICKS);

const firstMarkIsChainStart = (previousHash) =>
  previousHash === undefined || (previousHash instanceof Uint8Array && previousHash.length === 32 && previousHash.every((b) => b === 0));

/**
 * WHAT THE PLAYER'S FIRST MARK DECIDES.
 *
 *   joinTick        the entry's join tick
 *   deadlineTicks   the round's start deadline (startDeadlineOf(contract))
 *   firstMark       { tick, previousHash? } - a first mark chains to nothing
 *                   (previousHash is 32 zeros) - or null when there is none
 *
 * @returns {{ outcome: 'FORFEIT' | null, lastTick: number, why: string }}
 */
export function firstMarkOutcome({ joinTick, deadlineTicks, firstMark } = {}) {
  if (!Number.isInteger(joinTick) || joinTick < 0) throw new Error('a join tick is a whole tick, not negative');
  if (!Number.isInteger(deadlineTicks) || deadlineTicks < 1) throw new Error('a start deadline is a whole number of ticks, at least 1');
  const lastTick = joinTick + deadlineTicks;
  if (firstMark == null)
    return { outcome: null, lastTick,
      why: 'no first mark: nothing is decided - not ENTRY_VOID and not FORFEIT (a walk-away is §15\'s, and unbuilt)' };
  if (!Number.isInteger(firstMark.tick) || firstMark.tick < joinTick)
    throw new Error(`a first mark is at a tick at or after the join tick ${joinTick}`);
  if (!firstMarkIsChainStart(firstMark.previousHash))
    throw new Error('that mark chains to another: it is not the first mark');
  if (firstMark.tick <= lastTick)
    return { outcome: null, lastTick,
      why: `the first mark at tick ${firstMark.tick} is inside the start deadline (join ${joinTick} + ${deadlineTicks} = ${lastTick})` };
  return { outcome: FORFEIT, lastTick,
    why: `the first mark at tick ${firstMark.tick} is after the start deadline (join ${joinTick} + ${deadlineTicks} = ${lastTick}): `
      + 'a late start is the player\'s own act, not a refund' };
}
