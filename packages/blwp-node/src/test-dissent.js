// A TEST FAULT, OFF BY DEFAULT (ORDER-2116, RULED the owner 2026-10-02: invalidation case 1 - "for one named entry, 4 of the 7
// seats sign a different run. Their valid objection suspends it, the re-run voids it, and the pending line goes").
//
// BLWP_TEST_DISSENT_ENTRY names one entry (64 hex). On a seat started with it, and for that entry only:
//   - this seat's replay counts as differing from the agreed run, so an objection to it holds here (finality.js);
//   - this seat's re-run is signed with the score one higher - a different run (verify.js rerun).
// Nothing else changes, for that entry or any other. Unset - the default on every seat - this module answers false.
const named = String(process.env.BLWP_TEST_DISSENT_ENTRY || '').trim().toLowerCase();
const hex = (b) => Buffer.from(b).toString('hex');

export const testDissentEntry = /^[0-9a-f]{64}$/.test(named) ? named : null;
export const dissentsOn = (entryIdBytes) => testDissentEntry !== null && !!entryIdBytes && hex(entryIdBytes) === testDissentEntry;
