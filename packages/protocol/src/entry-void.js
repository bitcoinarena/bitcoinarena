// ENTRY_VOID (§16), DECIDED ON THE PLAYER'S OWN SIGNED TICK.
//
// "After commitment, before the first financial tick: if fewer than 5
// game/verify nodes are available, the entry becomes ENTRY_VOID and the stake
// is refunded by forfeit or by the stake lock's expiry (§23.2)." §14: reachable
// only from PROVISIONAL. §18: a Void entry neither pays into nor draws from
// the pool.
//
// THE NAMED PICK (M3, ENTRY_VOID): Void is the player's FIRST-MARK TICK against
// join_tick + start_deadline_ticks - not "a seat was down". A first mark signed
// at a tick after that line came too late to be the first financial tick: the
// entry is ENTRY_VOID, and a seat refuses the mark. A first mark at or before
// the line is in time and NOT Void, even if a seat has not seen it yet - getting
// it to every seat is the forwarding beat, after this one.
//
// NO FIRST MARK AT ALL IS NOT ENTRY_VOID. That is §15's walk-away - a transcript
// that stops is a deterministic result - which is unbuilt; today such a lock
// refunds at expiry, and that stays a listed hole, not a Void.
//
// THE CLOCK IS THE PLAYER'S SIGNED TICK. A mark names its own tick and is signed
// by the entry's session key; independent seats read the same number from it,
// and no wall clock is consulted.
import { START_DEADLINE_TICKS } from './constants.js';
import { ENTRY_VOID } from './payout.js';

/** The round's start deadline, in ticks after a player's join tick. */
export const startDeadlineOf = (contract) =>
  (contract && contract.startDeadlineTicks !== undefined ? contract.startDeadlineTicks : START_DEADLINE_TICKS);

const firstMarkIsChainStart = (previousHash) =>
  previousHash === undefined || (previousHash instanceof Uint8Array && previousHash.length === 32 && previousHash.every((b) => b === 0));

/**
 * IS THIS ENTRY ENTRY_VOID?
 *
 *   joinTick        the entry's join tick
 *   deadlineTicks   the round's start deadline (startDeadlineOf(contract))
 *   firstMark       the player's first mark as evidence - { tick, previousHash? }
 *                   (a first mark chains to nothing: previousHash is 32 zeros)
 *                   - or null when there is none
 *
 * @returns {{ outcome: 'ENTRY_VOID' | null, lastTick: number, why: string }}
 */
export function entryVoidOutcome({ joinTick, deadlineTicks, firstMark } = {}) {
  if (!Number.isInteger(joinTick) || joinTick < 0) throw new Error('a join tick is a whole tick, not negative');
  if (!Number.isInteger(deadlineTicks) || deadlineTicks < 1) throw new Error('a start deadline is a whole number of ticks, at least 1');
  const lastTick = joinTick + deadlineTicks;
  if (firstMark == null)
    return { outcome: null, lastTick,
      why: 'no first mark: nothing was committed to a first tick - not ENTRY_VOID (a walk-away is §15\'s, and unbuilt)' };
  if (!Number.isInteger(firstMark.tick) || firstMark.tick < joinTick)
    throw new Error(`a first mark is at a tick at or after the join tick ${joinTick}`);
  if (!firstMarkIsChainStart(firstMark.previousHash))
    throw new Error('that mark chains to another: it is not the first mark');
  if (firstMark.tick <= lastTick)
    return { outcome: null, lastTick,
      why: `the first mark at tick ${firstMark.tick} is inside the start deadline (join ${joinTick} + ${deadlineTicks} = ${lastTick})` };
  return { outcome: ENTRY_VOID, lastTick,
    why: `the first mark at tick ${firstMark.tick} is after the start deadline (join ${joinTick} + ${deadlineTicks} = ${lastTick}): `
      + 'it came too late to be the first financial tick' };
}
