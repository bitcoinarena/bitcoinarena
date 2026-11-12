// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-29 (#1517 recheck, #1706): copies of one run whose inputs carry event rows the replay never applies
// (a tick far past the run's end, or an extra trailing integer in a row) - the replay's work and answer are those of the
// honest bundle, yet each copy is a new cache key, so a stranger still chooses how many full replays one entry costs.
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

test('wf1489 v1-refute-29: no-op event rows in a live run\'s inputs still force one full replay per copy', async () => {
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
    const batches = decodeTranscript(p.transcript).batches.length;
    assert.ok(p.inputs, `this fixture's run is not live (batches ${batches}) - the variant needs a live run's inputs`);
    const j0 = JSON.parse(Buffer.from(p.inputs).toString('utf8'));
    const variants = [
      // a liquidation at a tick the run never reaches (a billion ticks on): never applied
      (i) => ({ ...j0, liquidations: [...(j0.liquidations || []), [1e9 + i, 1]] }),
      // a price sample far past the end: never applied
      (i) => ({ ...j0, samples: [...(j0.samples || []), [2e9 + i, 1]] }),
      // a tape row far past the end
      (i) => ({ ...j0, tapes: [...(j0.tapes || []), [3e9 + i, 1, 1]] }),
      // a word changed at the last tick: a different run, the same full replay of every tick, refused at the mark
      (i) => ({ ...j0, ticks: j0.ticks.map((r, k) => (k === j0.ticks.length - 1 ? { tick: r.tick, words: r.words.map((x, n) => (n === 0 ? x + 1 + i : x)) } : r)) }),
    ];
    const enc = (j) => encodeObjectionBundle({ objection: p.objectionBytes, signature: p.signature, transcript: p.transcript, receipts: p.receipts,
      inputs: new TextEncoder().encode(JSON.stringify(j)) });
    const before = w.a.verifier.objectionReplayCount;
    const first = await postObjection(w.a, w, honest.eid, b.bundle);
    const firstText = (await first.text()).trim();
    const answers = [];
    for (const v of variants) for (let i = 0; i < 3; i++) { const r = await postObjection(w.a, w, honest.eid, enc(v(i))); answers.push([r.status, (await r.text()).trim()]); }
    const replays = w.a.verifier.objectionReplayCount - before;
    console.log('  FACTS:', JSON.stringify({ batches, first: [first.status, firstText], variants: [...new Set(answers.map((a) => a.join(' ')))], replays }));
    assert.equal(first.status, 422);
    assert.ok(answers.slice(0, 9).every((a) => a[0] === 422 && a[1] === firstText), 'a no-op variant was answered differently from the honest bundle - the rows were not no-ops');
    assert.equal(replays, 1, `13 bundles from one stranger against one live run cost ${replays} full replays (the entry held SUSPENDED behind each)`);
  } finally { await w.close(); }
});
