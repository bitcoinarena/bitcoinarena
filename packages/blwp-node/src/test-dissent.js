// A TEST FAULT, OFF BY DEFAULT (ORDER-2116, RULED the owner 2026-10-02: invalidation case 1 - "for one named entry, 4 of the 7
// seats sign a different run. Their valid objection suspends it, the re-run voids it, and the pending line goes").
//
// BLWP_TEST_DISSENT_ENTRY names one entry (64 hex) at start; BLWP_TEST_DISSENT_FILE names a file whose first line names it,
// read again at most every 2 s - so a seat can be armed for an entry that did not exist when it started, without a
// restart. On a seat started with either, and for that entry only:
//   - this seat's replay counts as differing from the agreed run, so an objection to it holds here (finality.js);
//   - this seat's re-run is signed with the score one higher - a different run (verify.js rerun).
// Nothing else changes, for that entry or any other. Neither set - the default on every seat - this module answers false.
import { readFileSync } from 'node:fs';
const valid = (s) => { const v = String(s || '').trim().toLowerCase(); return /^[0-9a-f]{64}$/.test(v) ? v : null; };
const hex = (b) => Buffer.from(b).toString('hex');
const fromEnv = valid(process.env.BLWP_TEST_DISSENT_ENTRY);
const file = process.env.BLWP_TEST_DISSENT_FILE || null;
let readAt = 0, fromFile = null;
const named = () => {
  if (fromEnv) return fromEnv;
  if (!file) return null;
  if (Date.now() - readAt > 2000) {
    readAt = Date.now();
    try { fromFile = valid(readFileSync(file, 'utf8').split('\n')[0]); } catch { fromFile = null; }
  }
  return fromFile;
};

export const testDissentEntry = fromEnv;
export const dissentsOn = (entryIdBytes) => { const n = named(); return n !== null && !!entryIdBytes && hex(entryIdBytes) === n; };
