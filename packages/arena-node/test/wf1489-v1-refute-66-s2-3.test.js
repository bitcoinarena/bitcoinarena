// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1952, #1990 (the fix of v1-refute-66-s2): THE OBJECTION'S INPUTS ARE THE RUN THE SEAT STORED. A load check alone
// leaves the route open with any bed the batch door would take. The player sends the seats one honest bed, signs a mark over
// another honest-looking one (a full bed, 1000 sats, 20 BTC), and objects with inputs carrying that one.
// REBUILT FOR MARKS THAT NAME THEIR INPUTS (kanban #3760, after #3567 and #3758). The attack first ran on a live run: its marks
// named GENESIS, the canonical transcript carried no batch, and the objection's inputs went beside it as free JSON. A seat no
// longer signs such a run (#3567: the close replays only the inputs the last mark commits to), and an honest client never
// sends one (#3758; #3762 for the run an old client still sends). Against marks that name their inputs, the attack has two
// doors left, and both stay shut:
//   1. the mark names the batch carrying the other bed - a batch the seats were never sent: refused at the mark door;
//   2. the mark names the honest batch the seats hold, its state hash over the other bed: the run is signed over the stored
//      inputs, and an objection carrying the other bed as JSON beside that batch transcript is refused - the door replays
//      the transcript's own batches, which do not reproduce the player's mark.
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
import { checkObjectionAt } from '../tools/check-objection.mjs';
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

const OTHER = [0, 1000, 2000, 393214];                   // a bed the batch door takes - not the one the seats were sent

test('wf1489 v1-refute-66-s2-3: a mark over inputs the seats were not sent is refused, and an objection cannot carry inputs other than the batches the run committed to', async () => {
  assert.equal(loadValueRefusal(OTHER), null, 'the batch door refuses this load - not the case the test names');
  const w = await lockRound({ endMs: testNow() + 4000 });
  try {
    // seated and staked; the run goes out below by hand
    const p = await lockAndPlay(w, WINNER, { noMarks: true });
    const play = playFor(WINNER, w.randomness);
    const ticks = Array.from({ length: WINNER.ticks }, (_, t) => play.words(t));
    const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), p.session));
    // THE SEATS GET AN HONEST BED (the fixture's, which every check passes) ...
    const input = { roundId: w.rid, entryId: p.eid, previousHash: GENESIS_HASH, firstTick: 0, ticks, liquidations: [], loads: bedFrom(0) };
    // ... AND THE PLAYER'S STATE IS THE OTHER BED'S
    const st = init(seedWordForEntry(p.entry, w.randomness || RANDOMNESS));
    submitLoad(st, OTHER[1], OTHER[2], OTHER[3]);
    for (let t = 0; t < WINNER.ticks; t++) step(st, ...ticks[t]);
    const mark = { roundId: w.rid, entryId: p.eid, tick: WINNER.ticks,
      stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
      previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(p.session) };
    const other = { ...input, loads: [OTHER] };
    // each step at both seats before the next: a receipted mark is handed on to the peer, which then holds it
    const answers = [{}, {}];
    const atBoth = async (key, bytes) => { for (const [i, d] of [w.a, w.b].entries()) answers[i][key] = answer(await say(d.port, bytes)); };
    await atBoth('took', signedBatchOf(input, (id) => ed25519.sign(id, p.session)));
    // DOOR 1: the mark names the batch carrying the other bed, which no seat was sent
    await atBoth('toOther', sign({ ...mark, inputChainHash: batchId(other) }));
    // DOOR 2: the mark names the batch the seats hold
    await atBoth('toHeld', sign({ ...mark, inputChainHash: batchId(input) }));
    for (const a of answers) {
      assert.match(a.toOther, /names inputs this node has not seen/, `a mark over inputs the seat was never sent: ${JSON.stringify(answers)}`);
      assert.equal(a.toHeld, `${SIGNED_RECEIPT_BYTES} bytes`, `setup: the mark naming the held batch was not receipted: ${JSON.stringify(answers)}`);
    }
    await closeRound(w, { window: false });
    const signedBoth = await until(() => [w.a, w.b].every((d) => stateAt(d, w, p.eid).state === 'PROVISIONALLY_FINAL'));
    const signed = signedBoth ? ownResult(w.a, w, p.eid) : null;
    const facts = { answers, signedBoth, states: [w.a, w.b].map((d) => [stateAt(d, w, p.eid).state, stateAt(d, w, p.eid).why]),
      signed: signed && { outcome: signed.outcome, score: signed.score } };
    if (!signedBoth) { console.log('  FACTS:', JSON.stringify(facts)); assert.fail(`setup: ${JSON.stringify(facts)}`); }

    // THE OBJECTION: the canonical transcript (its batch the honest bed) and, beside it, inputs carrying the other bed
    const canon = new Uint8Array(await (await fetch(`${base(w.b)}/canonical?round=${toHex(w.rid)}&entry=${toHex(p.eid)}`)).arrayBuffer());
    const carried = decodeTranscript(canon).batches;
    assert.deepEqual(carried.map((b) => toHex(batchId(b))), [toHex(batchId(input))], 'setup: the canonical transcript carries the batch the mark committed to');
    const j = await (await fetch(`${base(w.b)}/replay/transcript?round=${toHex(w.rid)}&entry=${toHex(p.eid)}`)).json();
    delete j.clock;
    j.loads = [OTHER];
    const inputs = new TextEncoder().encode(JSON.stringify(j));
    // a claim other than the signed result: what the door must not reach is the claim at all
    const claimed = { outcome: signed.outcome, score: signed.score + 1 };
    const b = await buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: p.eid, signedRunId: runId(signed),
      playerPubkey: signed.playerPubkey, claimed, transcript: canon, inputs });
    const stranger = await checkObjectionAt({ base: base(w.b), roundId: w.rid, entryId: p.eid, bundle: b.bundle });
    const r = await postObjection(w.a, w, p.eid, b.bundle);
    const text = (await r.text()).trim();
    await wait(300);
    Object.assign(facts, { stranger: { holds: stranger.holds, step: stranger.step, why: stranger.why }, seat: [r.status, text],
      after: stateAt(w.a, w, p.eid).state });
    console.log('  FACTS:', JSON.stringify(facts));
    assert.equal(stranger.holds, false, `the stranger's checker held it: ${stranger.why}`);
    assert.equal(r.status, 422, `the seat took an objection whose inputs are not the batches the run committed to: ${r.status} ${text} (now ${facts.after})`);
    assert.match(text, /do not reproduce the receipted checkpoint/);
    assert.notEqual(facts.after, 'SUSPENDED');
  } finally { await w.close(); }
});
