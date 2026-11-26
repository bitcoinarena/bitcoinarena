// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2596 (attacker audit, objection and replay; a refute of #1952 / #1990): A SEAT THAT HOLDS A PREFIX OF THE RUN
// DECIDES AN OBJECTION ALONE OVER A TAIL NOBODY STORED. #1990 binds a live run's objection inputs to the seat's stored run
// "over the ticks both hold" - so past the last tick a seat holds, the carried inputs are bound by nothing but the marks,
// whose state hashes the player computed himself. The player sends seats A and C his whole run (T1), seat B only its first
// half (5 of 7 lets him move on), and signs his live mark over another second half (T2) - receipted at A and C, which hold
// every tick before it and receipt without replaying. After the close he objects at B with T1's first half and T2: the prefix
// is B's own, B's short run and the runs A and C hand out (T1) do not reproduce the mark, so B replays the carried inputs,
// they reproduce it, and the objection HOLDS at B alone (SUSPENDED there, a re-run, relayed on) - while A and C refuse it.
// Safe: a seat takes carried inputs past the ticks it holds only when a run this seat or a committee seat holds vouches for
// them (it reproduces every receipted mark, or it is those inputs); otherwise they are refused at step 'inputs', unreplayed.
// REBUILT FOR MARKS THAT NAME THEIR INPUTS (kanban #3760, after #3567 and #3758). The attack first ran on a live run: its marks
// named GENESIS, the canonical transcript carried no batch, and the inputs travelled beside it as free JSON. A seat no longer
// signs such a run (#3567) and an honest client never sends one (#3758; #3762 for the run an old client still sends). Now the
// final mark names the batch of the second half the seats were sent (b2, which B never got), so the canonical transcript
// carries b1 and b2, pinned by the transcript hash the objection names, and the door replays those - not T2 beside them. The
// mark over T2 is reproduced by nothing, and B refuses the objection like A: it cannot decide alone over a tail no seat stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { WINNER, wait, playFor, bedFrom, GENESIS_HASH, RANDOMNESS, say } from './window-fixture.js';
import { testNow } from './test-clock.js';
import { resultFinality } from '../src/finality.js';
import { runId } from '../src/verdict.js';
import { buildObjectionBundle } from '../tools/objection-bundle.mjs';
import { checkObjectionAt } from '../tools/check-objection.mjs';
import { splitSignedResult, decodePlayerResult } from '../../arena-protocol/src/result.js';
import { signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
// kanban #3758: the marks name the input head the client names now (the batch reaching the mark's tick), not GENESIS - a GENESIS mark commits to no batch, and since #3567 a close over it holds for ever
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
import { seedWordForEntry } from '../../arena-protocol/src/seed.js';
import { init, step, submitLoad } from '../../nextblock/src/sim.js';
import { hash as stateHash } from '../../nextblock/src/state.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const base = (d) => `http://127.0.0.1:${d.port}`;
const until = async (ok, ms = 30000) => { for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) if (ok()) return true; return ok(); };
const postObjection = (d, w, eid, body) => fetch(`${base(d)}/objection?round=${toHex(w.rid)}&entry=${toHex(eid)}`, { method: 'POST', body });
const ownResult = (d, w, eid) => {
  const mine = d.round.results(w.rid, eid).find((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey));
  return mine ? decodePlayerResult(splitSignedResult(mine.bytes).body) : null;
};
const stateAt = (d, w, eid) => resultFinality(d.round, w.rid, eid);



async function scene({ honest = false } = {}) {
  const w = await lockRound({ endMs: testNow() + 4000, n: 3 });
  try {
    const [A, B, C] = w.nodes;
    const p = await lockAndPlay(w, WINNER, { noMarks: true });
    const play = playFor(WINNER, w.randomness);
    const ticks = Array.from({ length: WINNER.ticks }, (_, t) => play.words(t));
    const K = Math.floor(WINNER.ticks / 2);
    // T2: the same first half, then a second half never sent anywhere (the truck held still)
    const t2 = honest ? ticks : ticks.map((x, t) => (t < K ? x : x.map(() => 0)));
    // the run as the client sends it: the first half, then the rest chained on it; B holds the first only
    const b1 = { roundId: w.rid, entryId: p.eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: ticks.slice(0, K), liquidations: [], loads: bedFrom(0) };
    const b2 = { roundId: w.rid, entryId: p.eid, previousHash: batchId(b1), firstTick: K, ticks: ticks.slice(K), liquidations: [], loads: [] };
    const batch = (b) => signedBatchOf(b, (id) => ed25519.sign(id, p.session));
    // TWO MARKS: one at K over the first half (every seat holds it), and the final one naming b2, its state over the honest bed and T2
    const st = init(seedWordForEntry(p.entry, w.randomness || RANDOMNESS));
    submitLoad(st, ...bedFrom(0)[0].slice(1));
    const hashOf = () => Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
    for (let t = 0; t < K; t++) step(st, ...t2[t]);
    const markK = { roundId: w.rid, entryId: p.eid, tick: K, stateHash: hashOf(),
      inputChainHash: batchId(b1), previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(p.session) };
    for (let t = K; t < WINNER.ticks; t++) step(st, ...t2[t]);
    const mark = { roundId: w.rid, entryId: p.eid, tick: WINNER.ticks, stateHash: hashOf(),
      inputChainHash: batchId(b2), previousHash: checkpointId(markK), sessionPubkey: ed25519.getPublicKey(p.session) };
    const signedOf = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), p.session));
    const answers = [];
    for (const d of [A, C]) {
      const took = Number(await say(d.port, batch(b1))) + Number(await say(d.port, batch(b2)));
      const rk = await say(d.port, signedOf(markK));
      const rc = await say(d.port, signedOf(mark));
      answers.push([String(took), rk instanceof Uint8Array ? `${rk.length} bytes` : String(rk).slice(0, 160), rc instanceof Uint8Array ? `${rc.length} bytes` : String(rc).slice(0, 160)]);
    }
    const tookB = String(await say(B.port, batch(b1)));
    const rkB = await say(B.port, signedOf(markK));
    answers.push([tookB, rkB instanceof Uint8Array ? `${rkB.length} bytes` : String(rkB).slice(0, 160)]);
    const receipted = answers.every((a) => a.slice(1).every((x) => x === `${SIGNED_RECEIPT_BYTES} bytes`));
    await closeRound(w, { window: false });
    // B HOLDS BACK ITS CLOSE (a peer holds the final mark over inputs it is short of) until the round's settlement is
    // combined; then it signs its stopped run (verify.js #holdBack). The combine A and C make, as B reads it from a peer:
    B.verifier.combinedElsewhere = async () => true;
    const signedAt = await until(() => [A, C].every((d) => stateAt(d, w, p.eid).runId));
    // B's standing: the run the committee agreed, once B signed its own stopped run and gathered
    const bStanding = await until(() => !!stateAt(B, w, p.eid).runId, 60000);
    const signed = ownResult(A, w, p.eid);
    const bOwn = ownResult(B, w, p.eid);
    const facts = { answers, tookB, receipted, signedAt, states: [A, B, C].map((d) => [stateAt(d, w, p.eid).state, String(stateAt(d, w, p.eid).why).slice(0, 120)]),
      bStanding, bOwn: bOwn && { outcome: bOwn.outcome, score: bOwn.score }, bHolds: B.round.transcript(w.rid, p.eid).ticks.length,
      signed: signed && { outcome: signed.outcome, score: signed.score } };
    if (!signedAt || !receipted || !signed || !bStanding) { console.log('  FACTS:', JSON.stringify(facts)); assert.fail(`setup: ${JSON.stringify(facts)}`); }
    const against = stateAt(B, w, p.eid).runId;

    // THE OBJECTION: the canonical transcript and receipts A hands out, the inputs A hands out with T2 as the second half
    const j = await (await fetch(`${base(A)}/replay/transcript?round=${toHex(w.rid)}&entry=${toHex(p.eid)}`)).json();
    delete j.clock;
    if (!honest) j.ticks = j.ticks.map((r) => (r.tick < K ? r : { tick: r.tick, words: r.words.map(() => 0) }));
    const inputs = new TextEncoder().encode(JSON.stringify(j));
    const ask = (claimed) => buildObjectionBundle({ base: base(A), roundId: w.rid, entryId: p.eid, signedRunId: against,
      playerPubkey: signed.playerPubkey, claimed, inputs });
    const probe = await checkObjectionAt({ base: base(A), roundId: w.rid, entryId: p.eid, bundle: (await ask({ outcome: signed.outcome, score: signed.score })).bundle });
    // the claim: what the probe names, else (no replay reproduces the mark, so it names none) another score than the signed one
    const claimed = probe.replayed || { outcome: signed.outcome, score: honest ? signed.score : signed.score + 1 };
    const b = await ask(claimed);
    const atA = await postObjection(A, w, p.eid, b.bundle);
    const textA = (await atA.text()).trim();
    const r = await postObjection(B, w, p.eid, b.bundle);
    const text = (await r.text()).trim();
    Object.assign(facts, { against: typeof against === 'string' ? against.slice(0, 16) : String(against), probe: { holds: probe.holds, step: probe.step, why: probe.why }, claimed,
      seatA: [atA.status, textA.slice(0, 160)], seatB: [r.status, text.slice(0, 220)], afterB: stateAt(B, w, p.eid).state });
    console.log('  FACTS:', JSON.stringify(facts));
    return { facts, atA, r, text, claimed, signed };
  } finally { await w.close(); }
}

test('wf1489 #2596-1: a seat holding a prefix of a run does not uphold an objection over a tail no seat stored', async () => {
  const { facts, atA, r, text, claimed, signed } = await scene();
  assert.notEqual(claimed.score, signed.score, 'the objection claims the signed score - not the case the test names');
  assert.equal(atA.status, 422, 'seat A (which stored the whole run) refuses it already - #1990');
  assert.equal(r.status, 422, `seat B, holding the first half of the run, took an objection over a tail no seat stored: ${r.status} ${text} (now ${facts.afterB})`);
  assert.match(text, /do not reproduce the receipted checkpoint/, 'seat B did not replay the batches the canonical transcript carries');
  assert.notEqual(facts.afterB, 'SUSPENDED');
});

test('wf1489 #2596-1: the same seat still replays a tail a committee seat stored (the run it vouches for)', async () => {
  const { facts, r, text } = await scene({ honest: true });
  assert.equal(r.status, 422);
  assert.equal(text, 'the replay agrees with the signed result', `seat B did not replay the run seat A stored: ${text}`);
  assert.notEqual(facts.afterB, 'SUSPENDED');
});
