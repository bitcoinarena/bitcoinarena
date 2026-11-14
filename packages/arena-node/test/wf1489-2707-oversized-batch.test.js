// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 4 (play path): A STRANGER'S UNSIGNED, OVERSIZED BATCH FRAME IS DECODED AND RE-ENCODED SEVERAL TIMES ON THE
// SEAT'S ONE THREAD BEFORE ANYTHING REFUSES IT. The /play socket takes frames up to MAX_FRAME_BYTES (the largest batch the
// encoder can write, several MB), while round.batch refuses any batch over TRANSCRIPT_BATCH_MAX_BYTES (65535) - and only
// after the signature check. Before that, playOf (splitSignedBatch: decode, the canonical re-encode, batchId's encode +
// hash) and round.signedBatch (the same again) run on the whole frame, for any made-up entry id, with a zero signature.
// One frame of a few MB from anybody holds the loop that answers every player's batch and mark. Safe: a signed batch frame
// larger than any batch the store takes is refused before it is decoded, so one such frame costs the seat almost nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { lockPort } from './lock-fixture.js';
import { lockRound } from './lock-round-fixture.js';
import { wait } from './window-fixture.js';
import { encodeInputBatch, joinSignedBatch, TAPE_PRICES } from '../../arena-protocol/src/batch.js';
import { TRANSCRIPT_BATCH_MAX_BYTES } from '../src/round.js';
import { MAX_FRAME_BYTES } from '../src/server.js';

test('#1489-r4-play-4: an oversized unsigned batch frame does not hold the seat\'s thread', async () => {
  const port = lockPort();
  const w = await lockRound({ port });
  try {
    const N = 65535;
    const b = {
      roundId: w.rid, entryId: new Uint8Array(32).fill(7), previousHash: new Uint8Array(32), firstTick: 0,
      ticks: Array.from({ length: N }, () => [1, 2, 3, 4, 5]),
      liquidations: Array.from({ length: N }, (_, i) => [i, 1]),
      loads: Array.from({ length: N }, (_, i) => [i, 1, 1, 1]),
      samples: Array.from({ length: N }, (_, i) => [i, 1]),
      tapes: [[0, ...Array.from({ length: TAPE_PRICES }, () => 1)]],
    };
    const body = encodeInputBatch(b);
    const frame = joinSignedBatch(body, new Uint8Array(64));
    assert.ok(frame.length <= MAX_FRAME_BYTES, 'the frame must fit the socket cap');
    assert.ok(frame.length > TRANSCRIPT_BATCH_MAX_BYTES * 10, 'the frame is far over any batch the store takes');
    const port0 = w.a.port;
    const ws = new WebSocket(`ws://127.0.0.1:${port0}/play`);
    await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
    const answers = [];
    ws.on('message', (d) => answers.push(d.toString()));
    let last = Date.now(); let worst = 0;
    const tick = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 5);
    const FRAMES = 5;
    const t0 = Date.now();
    for (let i = 0; i < FRAMES; i++) ws.send(frame);
    for (const stop = Date.now() + 60000; Date.now() < stop && answers.length < FRAMES; await wait(20));
    const took = Date.now() - t0;
    clearInterval(tick);
    ws.close();
    const facts = { frameBytes: frame.length, storeMax: TRANSCRIPT_BATCH_MAX_BYTES, frames: FRAMES, answers: answers.length,
      answer: (answers[0] || '').slice(0, 120), tookMs: took, worstLoopGapMs: worst };
    console.log('  FACTS:', JSON.stringify(facts));
    assert.equal(answers.length, FRAMES, 'every frame is answered');
    assert.ok(worst < 150, `one stranger's ${frame.length}-byte unsigned batch frame held the seat's thread ${worst} ms (${FRAMES} frames ${took} ms in all)`);
  } finally {
    await Promise.race([w.close(), wait(5000)]);
  }
});
