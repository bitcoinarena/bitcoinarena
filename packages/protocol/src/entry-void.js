// ENTRY_VOID (§16): THE OUTAGE REFUND.
//
// "After commitment, before the first financial tick: if fewer than 5
// game/verify nodes are available, the entry becomes ENTRY_VOID and the stake
// is refunded by forfeit or by the stake lock's expiry (§23.2)." §14: reachable
// only from PROVISIONAL. §18: a Void entry neither pays into nor draws from the
// pool. The operator must not profit from a technical failure, and the player
// must not be able to make one (§13C: "a player cannot manufacture a refund").
//
// WHAT "NOT AVAILABLE" IS, AS EVIDENCE. The player's on-time first mark, which
// every signer node that takes it forwards at once to the round's other signer nodes, and
// what each of them answered. When the start deadline has passed at a signer node -
// it holds a mark the player signed past join tick + deadline, or its round is
// closed - and the first mark still has fewer than the threshold's receipts,
// and every signer node it is short of was offered the mark and did not take it in
// time, the signer nodes were not available: ENTRY_VOID. A signer node that answered and
// REFUSED was up: not an outage. A signer node never offered proves nothing.
//
// NOT HERE: a first mark after the deadline is the player's own late start -
// FORFEIT (first-mark.js), never a refund. No first mark at all is neither
// (§15's walk-away, unbuilt). A run already past PROVISIONAL is not voided.
import { ENTRY_VOID } from './payout.js';

/** What a signer node answered when it was offered the first mark. */
export const OFFER_ANSWERS = ['receipted', 'unanswered', 'late', 'refused'];

/**
 * IS THIS ENTRY ENTRY_VOID, on one signer node's own record?
 *
 *   firstMark        this signer node holds the player's signed first mark
 *   lateStart        that mark is after the start deadline (first-mark.js: FORFEIT)
 *   deadlinePassed   the start deadline has passed at this signer node
 *   receipts         distinct signer nodes' receipts of the first mark this signer node held
 *                    when the deadline passed
 *   needed           the round's threshold (2 of 2, 5 of 7)
 *   offers           what each other signer node answered the offer: 'receipted',
 *                    'unanswered', 'late' (took it only after the line), 'refused'
 *   state            this signer node's finality state for the run (null = PROVISIONAL)
 *
 * @returns {{ outcome: 'ENTRY_VOID' | null, why: string }}
 */
export function outageOutcome({ firstMark, lateStart = false, deadlinePassed, receipts, needed, offers = [], state = null } = {}) {
  if (!Number.isInteger(needed) || needed < 1) throw new Error('the threshold is a positive count of signer nodes');
  if (!Number.isInteger(receipts) || receipts < 0) throw new Error('receipts are a count of signer nodes');
  for (const o of offers) if (!OFFER_ANSWERS.includes(o)) throw new Error(`an offer is answered ${OFFER_ANSWERS.join(', ')}, not ${o}`);
  if (state) return { outcome: null, why: `that run is ${state}: ENTRY_VOID is reachable only from PROVISIONAL (§14)` };
  if (!firstMark) return { outcome: null, why: 'no first mark: nothing shows a signer node was unavailable - not ENTRY_VOID (a walk-away is §15\'s, unbuilt)' };
  if (lateStart) return { outcome: null, why: 'the first mark is after the start deadline: the player\'s own late start is FORFEIT, not ENTRY_VOID' };
  if (!deadlinePassed) return { outcome: null, why: 'the start deadline has not passed at this signer node: the other signer nodes may still take the first mark' };
  if (receipts >= needed) return { outcome: null, why: `the first mark was receipted by ${receipts} of ${needed} signer nodes in time: the run started` };
  const refused = offers.filter((o) => o === 'refused').length;
  if (refused) return { outcome: null, why: `${refused} signer node(s) answered the first mark and refused it: they were up, so it is not an outage` };
  const missing = needed - receipts;
  const down = offers.filter((o) => o === 'unanswered' || o === 'late').length;
  if (down < missing)
    return { outcome: null, why: `${missing} receipt(s) are missing and only ${down} signer node(s) were offered the first mark and did not take it in time: an outage cannot be told from a mark never offered` };
  return { outcome: ENTRY_VOID,
    why: `the on-time first mark had ${receipts} of ${needed} receipts when the start deadline passed, and ${down} signer node(s) offered it did not take it in time: `
      + 'the signer nodes were unavailable - ENTRY_VOID, refunded (§16)' };
}
