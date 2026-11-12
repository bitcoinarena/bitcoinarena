// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-29 s2 (#1517, #1706 recheck): a seat that does not hold the whole run (a peer fed behind, or one that missed
// the tail across a restart) gets no help from 7a, and then every one-word copy is a full replay of its own.
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
import { decodeObjectionBundle, encodeObjectionBundle } from '../../arena-protocol/src/objection.js';
import { decodeTranscript } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const base = (d) => `http://127.0.0.1:${d.port}`;
const until = async (ok, ms = 30000) => { for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) if (ok()) return true; return ok(); };
const postObjection = (d, w, eid, body) => fetch(`${base(d)}/objection?round=${toHex(w.rid)}&entry=${toHex(eid)}`, { method: 'POST', body });
const ownResult = (d, w, eid) => decodePlayerResult(splitSignedResult(d.round.results(w.rid, eid).find((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey)).bytes).body);
const stateAt = (d, w, eid) => resultFinality(d.round, w.rid, eid);

test('wf1489 v1-refute-29 s2: one-word copies at a seat that does not hold the whole run cost one replay each', async () => {
  const w = await lockRound({ endMs: testNow() + 4000 });
  try {
    // A LIVE RUN (canonical = receipted marks over no batches): the ticks sent as a batch, the one mark naming GENESIS
    const honest = await lockAndPlay(w, WINNER, { noMarks: true });
    const play = playFor(WINNER, w.randomness);
    const st = loaded(init(seedWordForEntry(honest.entry, w.randomness || RANDOMNESS)));
    for (let t = 0; t < WINNER.ticks; t++) step(st, ...play.words(t));
    const mark = { roundId: w.rid, entryId: honest.eid, tick: WINNER.ticks, stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
      inputChainHash: GENESIS_HASH, previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(honest.session) };
    const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), honest.session));
    for (const d of [w.a, w.b]) {
      const got = await say(d.port, honest.late[0]);
      assert.ok(got === String(WINNER.ticks) || got === '0', `batch: ${String(got).slice(0, 160)}`);
      const rc = await say(d.port, signedMark);
      assert.equal(rc.length, SIGNED_RECEIPT_BYTES, typeof rc === 'string' ? `the GENESIS mark was refused: ${rc}` : undefined);
    }
    await closeRound(w, { window: false });
    assert.ok(await until(() => [w.a, w.b].every((d) => stateAt(d, w, honest.eid).state === 'PROVISIONALLY_FINAL')), 'run not signed at both seats');
    const signed = ownResult(w.a, w, honest.eid);
    const b = await buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: honest.eid, signedRunId: runId(signed),
      playerPubkey: signed.playerPubkey, claimed: { outcome: signed.outcome, score: signed.score } });
    const p = decodeObjectionBundle(b.bundle);
    assert.ok(p.inputs, 'the variant needs a live run');
    const j0 = JSON.parse(Buffer.from(p.inputs).toString('utf8'));
    // SEAT A DOES NOT HOLD THE RUN'S LAST TICK (a peer behind on the feed / the tail missed across a restart): the row is moved
    // out of the run's span (no row is removed), so A's own run stops one tick short of the receipted mark.
    const last = w.a.round.db.prepare('SELECT tick FROM ticks WHERE round_id = ? AND entry_id = ? ORDER BY tick DESC LIMIT 1').get(w.rid, honest.eid);
    w.a.round.db.prepare('UPDATE ticks SET tick = ? WHERE round_id = ? AND entry_id = ? AND tick = ?').run(last.tick + 1000000, w.rid, honest.eid, last.tick);
    const enc = (j) => encodeObjectionBundle({ objection: p.objectionBytes, signature: p.signature, transcript: p.transcript, receipts: p.receipts,
      inputs: new TextEncoder().encode(JSON.stringify(j)) });
    // a stranger's copies of the public bundle, one word changed in the last tick each
    const copy = (i) => ({ ...j0, ticks: j0.ticks.map((r, k) => (k === j0.ticks.length - 1 ? { tick: r.tick, words: r.words.map((x, n) => (n === 0 ? x + 1 + i : x)) } : r)) });
    const before = w.a.verifier.objectionReplayCount;
    const answers = [];
    for (let i = 0; i < 8; i++) { const r = await postObjection(w.a, w, honest.eid, enc(copy(i))); answers.push([r.status, (await r.text()).trim()]); }
    const replays = w.a.verifier.objectionReplayCount - before;
    console.log('  FACTS:', JSON.stringify({ answers: [...new Set(answers.map((a) => a.join(' ')))], replays }));
    assert.ok(answers.every((a) => a[0] === 422), 'a copy held');
    assert.ok(replays <= 2, `8 one-word copies of one live run cost ${replays} full replays at a seat that does not hold the whole run (the entry SUSPENDED behind each)`);
  } finally { await w.close(); }
});
