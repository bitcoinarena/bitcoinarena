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
// at the door: nothing yet - not ENTRY_VOID and not FORFEIT. A walk-away is
// decided at the round's close (`stoppedOutcome`, §15, ruled 2026-09-12).
//
// THE LOCK: a FORFEIT stake is claimed in the round's settlement transaction
// (§23.2) - W4, parked behind the fee-lock ruling. Until then a FORFEIT lock
// refunds at expiry: the money hole every loser has, listed, not closed.
import { START_DEADLINE_TICKS } from './constants.js';
import { FORFEIT, FAILED } from './payout.js';
import { msForTicks } from './tick.js';
import { BLOCK_TICKS } from '../../core/src/rules/gate.js';

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
      why: 'no first mark yet: nothing is decided at the door - not ENTRY_VOID and not FORFEIT (a walk-away is §15\'s, decided at the round\'s close)' };
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

/**
 * §15 AT THE ROUND'S CLOSE: "A TRANSCRIPT THAT STOPS BECOMES A DETERMINISTIC
 * RESULT" - never a refund (ruled 2026-09-12). Closing the tab is no escape:
 *   - no receipted first mark once the start deadline has passed (the round's
 *     close is past it) is FORFEIT: the player never started - the late
 *     start's family - score 0, over the empty receipted transcript;
 *   - a run whose checkpoints stopped before the close ends at its last
 *     receipted checkpoint; one still LIVE there did not deliver: FAILED,
 *     scored at that checkpoint.
 * Neither is VOID (§13C: seats that cannot agree through no fault of the
 * player) or ENTRY_VOID (§16: seats out before the first tick). A run that
 * ended on its own is its replay's, and nothing is decided here.
 *
 *   receiptedMarks  marks the committee carried (the canonical prefix)
 *   liveAtLast      that prefix replays to a run still LIVE at its last mark
 *   deadlinePassed  the round's start deadline has passed
 * @returns {{ outcome: 'FORFEIT' | 'FAILED' | null, why: string }}
 */
export function stoppedOutcome({ receiptedMarks, liveAtLast = false, deadlinePassed } = {}) {
  if (!Number.isInteger(receiptedMarks) || receiptedMarks < 0) throw new Error('receipted marks are a whole count');
  if (receiptedMarks === 0)
    return deadlinePassed
      ? { outcome: FORFEIT, why: 'no receipted first mark by the start deadline: the player never started - FORFEIT, score 0, as a late start is; not a refund' }
      : { outcome: null, why: 'no first mark yet, and the start deadline has not passed' };
  if (liveAtLast)
    return { outcome: FAILED, why: 'the checkpoints stopped before the round closed: the run ends at its last receipted checkpoint, undelivered - FAILED' };
  return { outcome: null, why: 'the run ended on its own: its replay decides' };
}

/**
 * WHEN A ROUND IS OVER, so its seats close it (M3.3-34, the Daily's close): the
 * latest a player can join (entry close), plus the start deadline their first
 * tick may take, a whole run (BLOCK_TICKS - the network's, which every valid
 * contract carries), and the start deadline once more for the last mark to
 * reach the seats: the window the first mark already gets, not a new constant.
 * Rounded UP to the millisecond, so no run is cut short by a remainder. By then
 * every run has ended or stopped (§15), and the close decides nothing a player
 * could still change.
 * @returns {bigint} milliseconds
 */
export function roundEndMs(contract) {
  if (!contract || contract.entryCloseMs === undefined) throw new Error('a round\'s end is counted from its entry close, and it names none');
  const span = msForTicks(2 * startDeadlineOf(contract) + BLOCK_TICKS);
  return BigInt(contract.entryCloseMs) + span.ms + (span.exact ? 0n : 1n);
}
