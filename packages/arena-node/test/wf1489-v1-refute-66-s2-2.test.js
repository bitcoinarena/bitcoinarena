// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-66-s2-2 (a refute of #1488 / Hexbox #011 at cc9338fed): THE OBJECTION DOOR TAKES A LOAD NO
// HONEST BED DECLARES. The batch door (Round.batch -> load-checks.js) refuses Hexbox's full bed at 0 sats / 0 BTC. But a
// seat receipts a live mark (inputChainHash = GENESIS) without replaying it, and an objection on a live run carries its
// inputs as free JSON beside the transcript (objection-check.js inputsFormOf) - bound only by the receipted marks' state
// hashes, which the player computed himself. So the player sends the seats an honest bed, signs his mark over the
// forbidden bed (0 fee, 0 BTC, room 393214), gets it receipted, and after the close objects with inputs that carry the
// forbidden load: the replay reproduces every receipted mark, gives another score than the committee signed, and the
// objection HOLDS (the result SUSPENDED; a second one after the re-run VOIDs and slashes the signers).
// THE RETRY: the committee's re-run replays the seats' own stored inputs, gives the signed score again, and the player
// objects a second time with the same forbidden-bed inputs, against the re-run: the entry goes VOID and the honest
// re-run signers are filed for slashing (REPLAY_CONTRADICTS) - on a load the batch door would never have taken.
// Safe: the second objection is refused like the first; the entry is not VOID and no slash proof is filed.
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
import { signedBatchOf } from '../../arena-protocol/src/batch.js';
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

const FORBIDDEN = [0, 0, 0, 393214];                     // Hexbox #011 attack 1: a full bed, 0 sats, 0 BTC


async function forbiddenRun(w) {
  const p = await lockAndPlay(w, WINNER, { noMarks: true });
  const play = playFor(WINNER, w.randomness);
  const ticks = Array.from({ length: WINNER.ticks }, (_, t) => play.words(t));
  const input = { roundId: w.rid, entryId: p.eid, previousHash: GENESIS_HASH, firstTick: 0, ticks, liquidations: [], loads: bedFrom(0) };
  const st = init(seedWordForEntry(p.entry, w.randomness || RANDOMNESS));
  submitLoad(st, FORBIDDEN[1], FORBIDDEN[2], FORBIDDEN[3]);
  for (let t = 0; t < WINNER.ticks; t++) step(st, ...ticks[t]);
  const mark = { roundId: w.rid, entryId: p.eid, tick: WINNER.ticks,
    stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
    inputChainHash: GENESIS_HASH, previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(p.session) };
  const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), p.session));
  for (const d of [w.a, w.b]) {
    assert.equal(String(await say(d.port, signedBatchOf(input, (id) => ed25519.sign(id, p.session)))), String(WINNER.ticks));
    const rc = await say(d.port, signedMark);
    assert.ok(rc instanceof Uint8Array && rc.length === SIGNED_RECEIPT_BYTES, `the mark was not receipted: ${String(rc).slice(0, 160)}`);
  }
  return p;
}

test('wf1489 v1-refute-66-s2-2: a second objection after the re-run cannot VOID the entry and slash its signers on a load the batch door refuses', async () => {
  const w = await lockRound({ endMs: testNow() + 4000 });
  try {
    const p = await forbiddenRun(w);
    await closeRound(w, { window: false });
    assert.ok(await until(() => [w.a, w.b].every((d) => stateAt(d, w, p.eid).state === 'PROVISIONALLY_FINAL')), 'not signed at both seats');
    const signed = ownResult(w.a, w, p.eid);
    const canon = new Uint8Array(await (await fetch(`${base(w.b)}/canonical?round=${toHex(w.rid)}&entry=${toHex(p.eid)}`)).arrayBuffer());
    const j = await (await fetch(`${base(w.b)}/replay/transcript?round=${toHex(w.rid)}&entry=${toHex(p.eid)}`)).json();
    delete j.clock;
    j.loads = [FORBIDDEN];
    const inputs = new TextEncoder().encode(JSON.stringify(j));
    const ask = (against, claimed) => buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: p.eid, signedRunId: against,
      playerPubkey: signed.playerPubkey, claimed, transcript: canon, inputs });
    const probe = await checkObjectionAt({ base: base(w.b), roundId: w.rid, entryId: p.eid, bundle: (await ask(runId(signed), { outcome: signed.outcome, score: signed.score })).bundle });
    const claimed = probe.replayed || { outcome: signed.outcome, score: signed.score };
    // THE FIRST OBJECTION, at both seats
    const first = await ask(runId(signed), claimed);
    const firsts = [];
    for (const d of [w.a, w.b]) { const r = await postObjection(d, w, p.eid, first.bundle); firsts.push([r.status, (await r.text()).trim()]); }
    // THE RE-RUN, agreed by both seats (it replays their stored inputs)
    const agreed = await until(() => [w.a, w.b].every((d) => { const f = stateAt(d, w, p.eid); return f.rerun && f.rerun.runId; }), 30000);
    const rerunRun = stateAt(w.a, w, p.eid).rerun && stateAt(w.a, w, p.eid).rerun.runId;
    const facts = { signed: { outcome: signed.outcome, score: signed.score }, claimed, firsts, agreed, rerunRun: rerunRun && rerunRun.slice(0, 16),
      states: [w.a, w.b].map((d) => stateAt(d, w, p.eid).state) };
    if (!agreed) { console.log('  FACTS:', JSON.stringify(facts)); assert.equal(firsts[0][0], 422, `the first objection held (${JSON.stringify(firsts)}) and the re-run never agreed`); return; }
    // THE RETRY: the same forbidden-bed inputs against the agreed re-run
    const second = await ask(Buffer.from(rerunRun, 'hex'), claimed);
    const r2 = await postObjection(w.a, w, p.eid, second.bundle);
    const t2 = (await r2.text()).trim();
    await wait(500);
    const after = stateAt(w.a, w, p.eid);
    const proofs = w.a.round.slashProofs(w.rid, p.eid);
    Object.assign(facts, { second: [r2.status, t2], after: [after.state, after.why], slashProofs: proofs.length });
    console.log('  FACTS:', JSON.stringify(facts));
    assert.notEqual(after.state, 'VOID', `the entry was VOIDed by two objections whose inputs carry ${JSON.stringify(FORBIDDEN)}: ${after.why}`);
    assert.equal(proofs.length, 0, `${proofs.length} slash proof(s) filed against honest seats on inputs carrying ${JSON.stringify(FORBIDDEN)}`);
  } finally { await w.close(); }
});
