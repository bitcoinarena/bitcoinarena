// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-29 (#1517 recheck, #1706): the two halves of the fix, each held to its edge.
//   1. inputsFormOf puts a live run's inputs in one form: rows at ticks no replay steps are dropped, rows are put in
//      tick order, a row wider than its kind or a second row at one tick is refused by name.
//   2. The seat-run check (objection-check.js 7a) only refuses when the seat's OWN run reproduces the marks: a seat whose
//      stored ticks do not (here: one word of its store changed after it signed) replays the bundle carried, as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { WINNER, wait, say, playFor, loaded, RANDOMNESS, GENESIS_HASH } from './window-fixture.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { init, step } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { testNow } from './test-clock.js';
import { resultFinality } from '../src/finality.js';
import { runId } from '../src/verdict.js';
import { buildObjectionBundle } from '../tools/objection-bundle.mjs';
import { splitSignedResult, decodePlayerResult } from '../../arena-protocol/src/result.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { inputsFormOf, replayKeyOf } from '../src/objection-check.js';

test('wf1489 v1-refute-29 s1: inputsFormOf drops rows no replay applies, orders the rest, refuses wide and doubled rows', () => {
  const ticks = [10, 11, 12].map((tick) => ({ tick, words: [1, 2, 3, 4, 5] }));
  const honest = inputsFormOf({ ticks, liquidations: [[11, 7]], loads: [[10, 1, 2]], samples: [[12, 9]], tapes: [[10, 1, 2, 3]] });
  const padded = inputsFormOf({ ticks, liquidations: [[1e9, 1], [11, 7], [3, 1]], loads: [[10, 1, 2], [13, 1, 2, 3]], samples: [[2e9, 1], [12, 9]],
    tapes: [[3e9, 1, 1], [10, 1, 2, 3], [9, 4]] });
  assert.equal(replayKeyOf(padded, []), replayKeyOf(honest, []), 'rows outside ticks 10..12 changed the key');
  const shuffled = inputsFormOf({ ticks, liquidations: [[12, 1], [11, 7]] });
  assert.deepEqual(shuffled.liquidations, [[11, 7], [12, 1]]);
  assert.throws(() => inputsFormOf({ ticks, liquidations: [[11, 7, 0]] }), /liquidations row 0 carries 3 integers/);
  assert.throws(() => inputsFormOf({ ticks, samples: [[11]] }), /samples row 0 carries 1 integers/);
  assert.throws(() => inputsFormOf({ ticks, loads: [[11, 1, 2, 3, 4]] }), /loads row 0 carries 5 integers/);
  assert.throws(() => inputsFormOf({ ticks, liquidations: [[11, 7], [11, 8]] }), /a second one at tick 11/);
  assert.deepEqual(inputsFormOf({ ticks, loads: [[11, 1, 2], [12, 1, 2, 3]] }).loads, [[11, 1, 2], [12, 1, 2, 3]]);
});

const base = (d) => `http://127.0.0.1:${d.port}`;
const until = async (ok, ms = 30000) => { for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) if (ok()) return true; return ok(); };
const postObjection = (d, w, eid, body) => fetch(`${base(d)}/objection?round=${toHex(w.rid)}&entry=${toHex(eid)}`, { method: 'POST', body });
const ownResult = (d, w, eid) => decodePlayerResult(splitSignedResult(d.round.results(w.rid, eid).find((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey)).bytes).body);

test('wf1489 v1-refute-29 s1: a seat whose own stored run does not reproduce the marks replays the bundle carried (no refusal by its own run)', async () => {
  const w = await lockRound({ endMs: testNow() + 4000 });
  try {
    const honest = await lockAndPlay(w, WINNER, { noMarks: true });
    const play = playFor(WINNER, w.randomness);
    const st = loaded(init(seedWordForEntry(honest.entry, w.randomness || RANDOMNESS)));
    for (let t = 0; t < WINNER.ticks; t++) step(st, ...play.words(t));
    const mark = { roundId: w.rid, entryId: honest.eid, tick: WINNER.ticks, stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
      inputChainHash: GENESIS_HASH, previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(honest.session) };
    const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), honest.session));
    for (const d of [w.a, w.b]) {
      await say(d.port, honest.late[0]);
      const rc = await say(d.port, signedMark);
      assert.equal(rc.length, SIGNED_RECEIPT_BYTES);
    }
    await closeRound(w, { window: false });
    assert.ok(await until(() => [w.a, w.b].every((d) => resultFinality(d.round, w.rid, honest.eid).state === 'PROVISIONALLY_FINAL')), 'run not signed at both seats');
    const signed = ownResult(w.a, w, honest.eid);
    const b = await buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: honest.eid, signedRunId: runId(signed),
      playerPubkey: signed.playerPubkey, claimed: { outcome: signed.outcome, score: signed.score } });
    // seat A's store loses the true run after it signed: one word of its last tick changed
    const last = w.a.round.db.prepare('SELECT tick, words FROM ticks WHERE round_id = ? AND entry_id = ? ORDER BY tick DESC LIMIT 1').get(w.rid, honest.eid);
    const words = new Int32Array(new Uint8Array(last.words).slice().buffer);
    words[0] += 1;
    w.a.round.db.prepare('UPDATE ticks SET words = ? WHERE round_id = ? AND entry_id = ? AND tick = ?').run(Buffer.from(words.buffer), w.rid, honest.eid, last.tick);
    const before = w.a.verifier.objectionReplayCount;
    const r = await postObjection(w.a, w, honest.eid, b.bundle);
    const text = (await r.text()).trim();
    const replays = w.a.verifier.objectionReplayCount - before;
    console.log('  FACTS:', JSON.stringify({ status: r.status, text, replays }));
    assert.equal(r.status, 422);
    assert.equal(text, 'the replay agrees with the signed result', 'the bundle was not replayed on its own evidence');
    assert.equal(replays, 2, 'the seat\'s own run and then the bundle carried');
  } finally { await w.close(); }
});
