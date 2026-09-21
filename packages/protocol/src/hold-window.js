// CAN THE HOLD LAST UNTIL THE RESULT IS FINAL?
//
// A stake is held by an HTLC, and an HTLC dies at a BLOCK HEIGHT. A round becomes final after a length of
// TIME: its run, its close, and §13A's objection window. Nothing converts one into the other except the
// chain's own pace, so a round opened without asking how fast blocks are coming is a round whose money may
// time out before its result exists.
//
// MEASURED ON THE DAILY, 2026-09-21, one paid round driven to DELIVERED and one loser beside it:
//
//   the loser's HTLC was accepted at height 93748 and given expiry 93895
//   lnd let it go at height 93878 - SEVENTEEN blocks before the expiry it was asked for
//   that was 730 s of usable hold, against 830 s from acceptance to the window closing
//   `lncli settleinvoice` then refused: "invoice already canceled", and the pool never formed
//
// So two numbers come out of Lightning rather than out of the protocol: the blocks lnd keeps back, and the
// seconds a block takes. Both are measured and passed in here; nothing in this file guesses either.
//
// The run's length comes from the ROUND'S OWN CONTRACT, never from the core: the protocol names no game.

/**
 * THE BLOCKS lnd KEEPS BACK. It cancels a held HTLC before its stated expiry rather than risk a
 * force-close, and the amount is its business, not the protocol's - measured at 17 on the Daily's
 * lnd v0.21.3-beta. Treated as a floor: a node may be told a larger one, never a smaller.
 */
export const SETTLE_SAFETY_BLOCKS = 17;

/** The core's pace. A run is `blockTicks` of these. */
export const TICKS_PER_SECOND = 60;

/**
 * WHAT THE CLOSE ITSELF COSTS, beyond the run and the window: posting the transcripts, the gathers, the
 * re-runs, and the watch that carries a result to FINAL. Measured on the Daily across the two rounds that
 * reached a close: 216 s and 133 s from the last tick to `closed_ms`. Taken at the larger, rounded up.
 */
export const CLOSE_SECONDS = 240;

/** How long from the moment Lightning accepts the stake until the result can be FINAL, in seconds. */
export function finalSeconds({ blockTicks, objectionWindowMs = 0n } = {}) {
  if (!Number.isInteger(blockTicks) || blockTicks <= 0)
    throw new Error('a run\'s length is the round contract\'s own blockTicks, in whole ticks');
  const run = blockTicks / TICKS_PER_SECOND;
  const window = Number(objectionWindowMs) / 1000;
  return run + CLOSE_SECONDS + window;
}

/**
 * THE MARGIN. The Daily's own rate moved between 1.74 and 3.85 s/block inside one hour, and the fast end is
 * the dangerous one: the quicker blocks come, the sooner the HTLC dies. A hold sized exactly to the round
 * is a hold that loses whenever the chain speeds up, which is how the measured round lost by 100 s. Half
 * again is not a guess at the right number; it is room for the variation that was measured.
 */
export const HOLD_MARGIN = 1.5;

/**
 * HOW MANY BLOCKS THE STAKE'S HTLC MUST BE GIVEN, on a chain going this fast.
 *
 * Never fewer than the protocol's own `stakeExpiryBlocks`: on a chain with real ten-minute blocks the
 * arithmetic here asks for a handful, and the floor is what keeps a mainnet hold a day long. On a rehearsal
 * chain running thousands of times faster, the arithmetic wins and the floor is irrelevant.
 */
export function cltvBlocksFor({ secondsPerBlock, blockTicks, objectionWindowMs = 0n,
                                floorBlocks, safetyBlocks = SETTLE_SAFETY_BLOCKS } = {}) {
  if (!(secondsPerBlock > 0)) throw new Error('a chain\'s pace is seconds per block, and a positive number');
  if (!Number.isInteger(floorBlocks) || floorBlocks <= 0)
    throw new Error('the floor is the protocol\'s own stakeExpiryBlocks, in whole blocks');
  const need = finalSeconds({ blockTicks, objectionWindowMs }) * HOLD_MARGIN;
  return Math.max(floorBlocks, Math.ceil(need / secondsPerBlock) + safetyBlocks);
}

/**
 * THE DOOR'S OWN QUESTION (RULED 2026-09-21): does a hold of `cltvBlocks` last until this round is FINAL?
 *
 * A paying round that cannot be settled is not opened. The money law's reason is the plain one: a stake the
 * committee can never act on goes back to its player by timeout, so the operator keeps nothing - but the
 * round was a promise nobody could keep, and §23's Lightning gate already refuses "a hold it issues may
 * never be seen settled" for a node that is behind its chain. This is that sentence on the other clock.
 */
export function holdCoversRound({ secondsPerBlock, cltvBlocks, blockTicks,
                                  objectionWindowMs = 0n, safetyBlocks = SETTLE_SAFETY_BLOCKS } = {}) {
  if (!(secondsPerBlock > 0))
    return { ok: false, why: 'this node does not know how fast blocks are coming, so it cannot tell whether a hold would outlive the round' };
  if (!Number.isInteger(cltvBlocks) || cltvBlocks <= safetyBlocks)
    return { ok: false, why: `a hold of ${cltvBlocks} blocks is not longer than the ${safetyBlocks} Lightning keeps back` };
  const holdS = (cltvBlocks - safetyBlocks) * secondsPerBlock;
  const finalS = finalSeconds({ blockTicks, objectionWindowMs });
  if (holdS < finalS)
    return { ok: false, holdSeconds: holdS, finalSeconds: finalS,
      why: `a hold of ${cltvBlocks} blocks lasts ${Math.round(holdS)} s at ${secondsPerBlock.toFixed(3)} s a block `
        + `(${safetyBlocks} of them are kept back by Lightning), and this round is not final for ${Math.round(finalS)} s: `
        + 'a round whose stake times out before its own result exists is not opened' };
  return { ok: true, holdSeconds: holdS, finalSeconds: finalS, why: '' };
}
