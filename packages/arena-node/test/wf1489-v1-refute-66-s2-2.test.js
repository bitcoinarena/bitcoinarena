// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-66-s2-2 (a refute of #1488 / Hexbox #011 at cc9338fed): THE OBJECTION DOOR TAKES A LOAD NO
// HONEST BED DECLARES. The batch door (Round.batch -> load-checks.js) refuses Hexbox's full bed at 0 sats / 0 BTC. The
// attack: the player sends the seats an honest bed, signs his mark over the forbidden bed (0 fee, 0 BTC, room 393214), gets
// it receipted, and after the close objects with inputs carrying the forbidden load. If that objection held (SUSPENDED),
// the committee's re-run would replay the stored inputs and give the signed score again, and a second objection with the
// same inputs against the re-run would VOID the entry and file the honest re-run signers for slashing (REPLAY_CONTRADICTS).
// REBUILT FOR MARKS THAT NAME THEIR INPUTS (kanban #3760, after #3567 and #3758). The attack first ran on a live run: its marks
// named GENESIS, the canonical transcript carried no batch, and the objection's inputs went beside it as free JSON. A seat no
// longer signs such a run (#3567), and an honest client never sends one (#3758; #3762 for the run an old client still sends).
// Against marks that name their inputs, the forbidden load has no way in:
//   1. a batch carrying it is refused at the batch door, so no mark can name one: a mark naming it is refused too;
//   2. the mark names the honest batch the seats hold, its state hash over the forbidden bed: the run is signed over the
//      stored inputs, and an objection carrying the forbidden load as JSON beside that batch transcript is refused - so no
//      re-run starts, there is no second objection to make, the entry is not VOID and no slash proof is filed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { WINNER, wait, playFor, bedFrom, GENESIS_HASH, RANDOMNESS, say } from './window-fixture.js';
import { testNow } from './test-clock.js';
import { resultFinality } from '../src/finality.js';
import { runId } from '../src/verdict.js';
import { loadValueRefusal } from '../src/load-checks.js';
import { buildObjectionBundle } from '../tools/objection-bundle.mjs';
import { splitSignedResult, decodePlayerResult } from '../../arena-protocol/src/result.js';
import { decodeTranscript } from '../../arena-protocol/src/transcript.js';
import { signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { init, step, submitLoad } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const base = (d) => `http://127.0.0.1:${d.port}`;
const until = async (ok, ms = 30000) => { for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) if (ok()) return true; return ok(); };
const postObjection = (d, w, eid, body) => fetch(`${base(d)}/objection?round=${toHex(w.rid)}&entry=${toHex(eid)}`, { method: 'POST', body });
const ownResult = (d, w, eid) => decodePlayerResult(splitSignedResult(d.round.results(w.rid, eid).find((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey)).bytes).body);
const stateAt = (d, w, eid) => resultFinality(d.round, w.rid, eid);
const answer = (rc) => (rc instanceof Uint8Array ? `${rc.length} bytes` : String(rc).slice(0, 160));

const FORBIDDEN = [0, 0, 0, 393214];                     // Hexbox #011 attack 1: a full bed, 0 sats, 0 BTC

test('wf1489 v1-refute-66-s2-2: a load the batch door refuses reaches no mark and no objection, so it cannot VOID the entry or slash its signers', async () => {
  assert.notEqual(loadValueRefusal(FORBIDDEN), null, 'the batch door takes this load - not the case the test names');
  const w = await lockRound({ endMs: testNow() + 4000 });
  try {
    const p = await lockAndPlay(w, WINNER, { noMarks: true });
    const play = playFor(WINNER, w.randomness);
    const ticks = Array.from({ length: WINNER.ticks }, (_, t) => play.words(t));
    const signB = (b) => signedBatchOf(b, (id) => ed25519.sign(id, p.session));
    const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), p.session));
    const input = { roundId: w.rid, entryId: p.eid, previousHash: GENESIS_HASH, firstTick: 0, ticks, liquidations: [], loads: bedFrom(0) };
    const forbidden = { ...input, loads: [FORBIDDEN] };
    const st = init(seedWordForEntry(p.entry, w.randomness || RANDOMNESS));
    submitLoad(st, FORBIDDEN[1], FORBIDDEN[2], FORBIDDEN[3]);
    for (let t = 0; t < WINNER.ticks; t++) step(st, ...ticks[t]);
    const mark = { roundId: w.rid, entryId: p.eid, tick: WINNER.ticks,
      stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
      previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(p.session) };
    // each step at both seats before the next: a receipted mark is handed on to the peer, which then holds it
    const answers = [{}, {}];
    const atBoth = async (key, bytes) => { for (const [i, d] of [w.a, w.b].entries()) answers[i][key] = answer(await say(d.port, bytes)); };
    // DOOR 1: the forbidden bed in a batch, and a mark naming that batch
    await atBoth('forbiddenBatch', signB(forbidden));
    await atBoth('toForbidden', sign({ ...mark, inputChainHash: batchId(forbidden) }));
    // DOOR 2: the honest bed in a batch, and the mark over the forbidden bed naming it
    await atBoth('took', signB(input));
    await atBoth('toHeld', sign({ ...mark, inputChainHash: batchId(input) }));
    for (const a of answers) {
      assert.match(a.forbiddenBatch, /^error /, `the batch door took a batch carrying ${JSON.stringify(FORBIDDEN)}: ${JSON.stringify(answers)}`);
      assert.match(a.toForbidden, /names inputs this node has not seen/, `a mark naming the refused batch: ${JSON.stringify(answers)}`);
      assert.equal(a.took, String(WINNER.ticks), `setup: the honest batch: ${JSON.stringify(answers)}`);
      assert.equal(a.toHeld, `${SIGNED_RECEIPT_BYTES} bytes`, `setup: the mark naming the held batch was not receipted: ${JSON.stringify(answers)}`);
    }
    await closeRound(w, { window: false });
    assert.ok(await until(() => [w.a, w.b].every((d) => stateAt(d, w, p.eid).state === 'PROVISIONALLY_FINAL')), 'not signed at both seats');
    const signed = ownResult(w.a, w, p.eid);
    const canon = new Uint8Array(await (await fetch(`${base(w.b)}/canonical?round=${toHex(w.rid)}&entry=${toHex(p.eid)}`)).arrayBuffer());
    assert.deepEqual(decodeTranscript(canon).batches.map((b) => toHex(batchId(b))), [toHex(batchId(input))], 'setup: the canonical transcript carries the batch the mark committed to');
    const j = await (await fetch(`${base(w.b)}/replay/transcript?round=${toHex(w.rid)}&entry=${toHex(p.eid)}`)).json();
    delete j.clock;
    j.loads = [FORBIDDEN];
    const inputs = new TextEncoder().encode(JSON.stringify(j));
    const claimed = { outcome: signed.outcome, score: signed.score + 1 };
    // THE FIRST OBJECTION, at both seats
    const first = await buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: p.eid, signedRunId: runId(signed),
      playerPubkey: signed.playerPubkey, claimed, transcript: canon, inputs });
    const firsts = [];
    for (const d of [w.a, w.b]) { const r = await postObjection(d, w, p.eid, first.bundle); firsts.push([r.status, (await r.text()).trim()]); }
    await wait(1000);
    const after = [w.a, w.b].map((d) => stateAt(d, w, p.eid));
    const proofs = [w.a, w.b].map((d) => d.round.slashProofs(w.rid, p.eid).length);
    console.log('  FACTS:', JSON.stringify({ answers, signed: { outcome: signed.outcome, score: signed.score }, firsts,
      after: after.map((f) => [f.state, f.rerun ? 'rerun' : null]), slashProofs: proofs }));
    for (const [status, text] of firsts) {
      assert.equal(status, 422, `an objection carrying ${JSON.stringify(FORBIDDEN)} beside the batch transcript was taken: ${text}`);
      assert.match(text, /do not reproduce the receipted checkpoint/);
    }
    // NO RE-RUN, SO NO SECOND OBJECTION: the entry stays as signed, and nobody is filed for slashing
    for (const f of after) {
      assert.equal(f.state, 'PROVISIONALLY_FINAL', `the entry is ${f.state}: ${f.why}`);
      assert.ok(!f.rerun, 'a re-run started on an objection carrying a load the batch door refuses');
    }
    assert.deepEqual(proofs, [0, 0], `slash proof(s) filed against honest seats on inputs carrying ${JSON.stringify(FORBIDDEN)}`);
  } finally { await w.close(); }
});
