import { entryId as entryIdOf } from '../../protocol/src/contracts.js';
import { netStakeMsat } from '../../protocol/src/payout.js';

// A FIXTURE'S PREMISE ABOUT WHO WAS SEATED.
//
// Since letter 26 a node trusts the keys the CENSUS seated, not a list a
// round's author wrote: `takeReceipt` and `verifiedFinal` read `round.seats()`
// and refuse a round this node never seated. That rule is measured where
// seating happens - `roster.test.js` derives a census from blocks and seats
// from it, and `one-key.test.js` pins what a seat has to be able to sign.
//
// The files that use this are not about seating. They are about marks,
// receipts, canonical chains and verdicts, and they need a round whose
// committee is known. So they SAY what they are assuming, in one line, instead
// of every one of them building a chain view with bonded identities.
//
// It is not a back door: nothing in `src/` seats from a contract, and a test
// that assumed the wrong thing would be assuming it out loud.
export const assumeSeated = (round, roundId, keys) => round.seat(roundId, keys);

// AND ITS PREMISE ABOUT WHOSE STAKE WAS PAID. 23.1 step 5: play begins only
// once the held HTLC has been seen, and the daemon now refuses a paying round's
// batches and marks until this node has seen it (stake-committed.test.js
// measures that, against a port that is paid or not). The files that use this
// play a paying round to test marks, ghosts and verdicts, not payment, so they
// say the stake was seen - after the entry is seated - instead of each standing
// up a Lightning node that reports it paid. Nothing in `src/` writes this row
// except `Custody.seenPaid`, after Lightning showed the full amount.
export const assumeStakeSeen = (round, entry) =>
  round.putStakeSeen({ entryId: entryIdOf(entry), paidMsat: netStakeMsat(entry) });
