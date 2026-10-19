// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A TEST FAULT, OFF BY DEFAULT (ORDER-2116, RULED 2026-10-02: invalidation case 1 - "for one named entry, 4 of the 7
// seats sign a different run. Their valid objection suspends it, the re-run voids it, and the pending line goes").
//
// ARENA_TEST_DISSENT_ENTRY names one entry (64 hex) at start; ARENA_TEST_DISSENT_FILE names a file whose first line names it,
// read again at most every 2 s - so a seat can be armed for an entry that did not exist when it started, without a
// restart. On a seat started with either, and for that entry only:
//   - this seat's replay counts as differing from the agreed run, so an objection to it holds here (finality.js);
//   - this seat's re-run is signed with the score one higher - a different run (verify.js rerun).
// Nothing else changes, for that entry or any other. Neither set - the default on every seat - this module answers false.
import { readFileSync } from 'node:fs';
const valid = (s) => { const v = String(s || '').trim().toLowerCase(); return /^[0-9a-f]{64}$/.test(v) ? v : null; };
const hex = (b) => Buffer.from(b).toString('hex');
const fromEnv = valid(process.env.ARENA_TEST_DISSENT_ENTRY);
const file = process.env.ARENA_TEST_DISSENT_FILE || null;
let readAt = 0, fromFile = null;
const named = () => {
  if (fromEnv) return fromEnv;
  if (!file) return null;
  if (Date.now() - readAt > 2000) {
    readAt = Date.now();
    try { fromFile = valid(readFileSync(file, 'utf8').split('\n')[0].trim().split(/\s+/)[0]); } catch { fromFile = null; }
  }
  return fromFile;
};

export const testDissentEntry = fromEnv;
export const dissentsOn = (entryIdBytes) => { const n = named(); return n !== null && !!entryIdBytes && hex(entryIdBytes) === n; };

// AND ITS FIRST RESULT TOO, when asked (RULED 2026-10-04: "extend ARENA_TEST_DISSENT_FILE to sign one
// score higher for one named entry" - the live split). The file's first line `<entry hex> first`, or
// ARENA_TEST_DISSENT_FIRST=1 beside the env entry: this seat then signs that entry's FIRST result one score higher too, so
// with its peers honest the committee splits with every seat up. Without the word nothing changes: the re-run fault above.
let firstAt = 0, firstFromFile = false;
const firstNamed = () => {
  if (fromEnv) return process.env.ARENA_TEST_DISSENT_FIRST === '1';
  if (!file) return false;
  if (Date.now() - firstAt > 2000) {
    firstAt = Date.now();
    try { firstFromFile = /^\s*[0-9a-f]{64}\s+first\b/i.test(readFileSync(file, 'utf8').split('\n')[0]); } catch { firstFromFile = false; }
  }
  return firstFromFile;
};
export const dissentsFirstOn = (entryIdBytes) => dissentsOn(entryIdBytes) && firstNamed();

// THE LATE POSTING (RULED 2026-10-04: "Off by default, same shape as ARENA_TEST_DISSENT_FILE: one named
// entry, one seat posts after the deadline"). ARENA_TEST_LATE_POSTING_ENTRY names one entry (64 hex) at start;
// ARENA_TEST_LATE_POSTING_FILE names a file whose first line names it, read again at most every 2 s. On a seat started with
// either, and for that entry only, this seat makes no posting of its transcript until its own clock reads the round's
// final_after + 10 s - after the result window's deadline. Nothing else changes. Neither set - every seat's default - false.
const lateEnv = valid(process.env.ARENA_TEST_LATE_POSTING_ENTRY);
const lateFile = process.env.ARENA_TEST_LATE_POSTING_FILE || null;
let lateAt = 0, lateFromFile = null;
const lateNamed = () => {
  if (lateEnv) return lateEnv;
  if (!lateFile) return null;
  if (Date.now() - lateAt > 2000) {
    lateAt = Date.now();
    try { lateFromFile = valid(readFileSync(lateFile, 'utf8').split('\n')[0].split(/\s+/)[0]); } catch { lateFromFile = null; }
  }
  return lateFromFile;
};
export const LATE_POSTING_AFTER_MS = 10000n;
export const postsLateOn = (entryIdBytes) => { const n = lateNamed(); return n !== null && !!entryIdBytes && hex(entryIdBytes) === n; };
