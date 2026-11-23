// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit 2026-11-19 r4, module attest, round 1, finding 2: THE FIXED ATTESTOR SIGNS A WINDOW IT DID NOT READ (gap in #2461's fix).
// #2461 made a drawn seat sign only a window it read (drawn-attestor.js windowRead): a reading at most 30 s before each 60 s
// average and no gap over 30 s inside it. The fixed daemon (arena-attestor.mjs -> attestor.js attestWindow / attestValue) still
// signs from whatever readings it holds: after a downtime over the window's end (its SAMPLES_FILE restores the readings from before
// it) the last reading before the downtime is taken as in force through the whole gap, and the END PRICE it signs is minutes old.
// A stranger reaches this through finding 1 (one `GET //[` ends the daemon; repeated from end - 5 min until just after the end,
// each restart is killed before its first exchange read lands): attestors A and C run on one host, both come back after the end
// and sign the stale outcome - 2 of 3, it stands, and the market pays the outcome of five minutes before the end.
// SAFE: no word for a window whose end (or start) average was not read - as the drawn seat's windowRead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attestorKey, attestWindow, attestValue } from '../src/attestor.js';

const A = attestorKey(new Uint8Array(32).fill(0x61));
const ROUND = new Uint8Array(32).fill(0x7a);
const START = 900000n * 2000n, END = START + 900000n;

// read every 10 s from a minute before the start until 310 s before the end: the price to beat 80,000.00, then 81,000.00 -
// and the daemon down from end - 310 s (the true end price, never read, is 79,000.00: Down)
const samples = [];
for (let t = START - 60000n; t < END - 300000n; t += 10000n) samples.push({ atMs: t, price: t < START ? 8000000n : 8100000n });

test('the fixed attestor signs no Up/Down word over a window end it did not read', () => {
  const w = attestWindow({ samples, roundId: ROUND, window: { startMs: START, endMs: END }, attestor: A });
  console.log(`  last reading ${Number(END - samples.at(-1).atMs) / 1000} s before the end -> ${w.ok ? `signed '${w.label}' (end price ${w.endPrice})` : `signs nothing: ${w.why}`}`);
  assert.equal(w.ok, false, `attestWindow signed outcome '${w.label}' with end price ${w.endPrice} from a reading ${Number(END - samples.at(-1).atMs) / 1000} s before the window's end`);
});

test('the fixed attestor signs no scalar value over a window end it did not read', () => {
  const v = attestValue({ samples, roundId: ROUND, window: { startMs: START, endMs: END }, attestor: A });
  assert.equal(v.ok, false, `attestValue signed value ${v.value} from a reading ${Number(END - samples.at(-1).atMs) / 1000} s before the window's end`);
});
