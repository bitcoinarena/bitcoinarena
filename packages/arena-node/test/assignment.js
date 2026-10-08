import { entryId as entryIdOf } from '../../arena-protocol/src/contracts.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';

// A FIXTURE'S PREMISE ABOUT WHO WAS ASSIGNED.
//
// Since letter 26 a node trusts the keys the Census assigned, not a list a
// round's author wrote: `takeReceipt` and `verifiedFinal` read `round.signerNodes()`
// and refuse a round this node was never assigned. That rule is measured where
// assignment happens - `roster.test.js` derives a census from blocks and signer nodes
// from it, and `one-key.test.js` pins what a signer node has to be able to sign.
//
// The files that use this are not about assignment. They are about marks,
// receipts, canonical chains and verdicts, and they need a round whose
// committee is known. So they SAY what they are assuming, in one line, instead
// of every one of them building a chain view with bonded identities.
//
// It is not a back door: nothing in `src/` assigns from a contract, and a test
// that assumed the wrong thing would be assuming it out loud.
export const assumeAssigned = (round, roundId, keys) => round.recordSignerNodes(roundId, keys);

// AND ITS PREMISE ABOUT WHOSE STAKE WAS PAID. 23.1 step 5: play begins only
// once the held HTLC has been seen, and the daemon now refuses a paying round's
// batches and marks until this node has seen it (stake-committed.test.js
// measures that, against a port that is paid or not). The files that use this
// play a paying round to test marks, ghosts and verdicts, not payment, so they
// say the stake was seen - after the entry is joined - instead of each standing
// up a Lightning node that reports it paid. Nothing in `src/` writes this row
// except `Custody.seenPaid`, after Lightning showed the full amount.
export const assumeStakeSeen = (round, entry) =>
  round.putStakeSeen({ entryId: entryIdOf(entry), paidMsat: netStakeMsat(entry) });
