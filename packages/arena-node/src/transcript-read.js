// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A RUN'S INPUTS, READ OUT OF A STORE, IN ONE PLACE - so the daemon's own thread and a replay worker read them the
// same way (2026-09-17 19:15, the ghost lag: the close held the event loop that feeds pictured trucks).
//
// Measured on the Daily with the daemon's own timing: a close held the loop 554-1511 ms before it waited, and none of
// its named steps was over 100 ms on its own - it is the per-entry work repeated, up to seven entries a round, and a
// transcript read is 21-31 ms of each. A read is not a decision and needs nothing but the store, so a worker that is
// already replaying the run can do its own reading instead of being handed the rows across a thread.
//
// NOTHING HERE TOUCHES THE SIMULATOR. It turns rows into the shape `replay` eats, and that is all it does.

/** The ticks, liquidations, loads, samples and tapes of one entry's run, in tick order. */
export function readTranscript(db, roundIdBytes, entryIdBytes) {
  const ticks = db.prepare(
    'SELECT tick, words FROM ticks WHERE round_id = ? AND entry_id = ? ORDER BY tick').all(roundIdBytes, entryIdBytes);
  const liq = db.prepare(
    'SELECT tick, size FROM liquidations WHERE round_id = ? AND entry_id = ? ORDER BY tick').all(roundIdBytes, entryIdBytes);
  const loads = db.prepare(
    'SELECT tick, fee_sats, btc_hund, room FROM loads WHERE round_id = ? AND entry_id = ? ORDER BY tick').all(roundIdBytes, entryIdBytes);
  const samples = db.prepare(
    'SELECT tick, price FROM samples WHERE round_id = ? AND entry_id = ? ORDER BY tick').all(roundIdBytes, entryIdBytes);
  const tapes = db.prepare('SELECT tick, prices FROM tapes WHERE round_id = ? AND entry_id = ? ORDER BY tick')
    .all(roundIdBytes, entryIdBytes)
    .map((r) => [r.tick, ...new Int32Array(new Uint8Array(r.prices).slice().buffer)]);
  return {
    tapes,
    ticks: ticks.map((r) => ({ tick: r.tick, words: [...new Int32Array(new Uint8Array(r.words).buffer)] })),
    liquidations: liq.map((r) => [r.tick, r.size]),
    loads: loads.map((r) => (r.room === null || r.room === undefined ? [r.tick, r.fee_sats, r.btc_hund] : [r.tick, r.fee_sats, r.btc_hund, r.room])),
    samples: samples.map((r) => [r.tick, r.price]),
  };
}
