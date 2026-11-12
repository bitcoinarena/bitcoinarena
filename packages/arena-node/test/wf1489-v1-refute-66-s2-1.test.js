// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-66-s2-1 (a refute of #1488 / Hexbox #011 at cc9338fed): THE OBJECTION DOOR TAKES A LOAD NO
// HONEST BED DECLARES. The batch door (Round.batch -> load-checks.js) refuses Hexbox's full bed at 0 sats / 0 BTC. But a
// seat receipts a live mark (inputChainHash = GENESIS) without replaying it, and an objection on a live run carries its
// inputs as free JSON beside the transcript (objection-check.js inputsFormOf) - bound only by the receipted marks' state
// hashes, which the player computed himself. So the player sends the seats an honest bed, signs his mark over the
// forbidden bed (0 fee, 0 BTC, room 393214), gets it receipted, and after the close objects with inputs that carry the
// forbidden load: the replay reproduces every receipted mark, gives another score than the committee signed, and the
// objection HOLDS (the result SUSPENDED; a second one after the re-run VOIDs and slashes the signers).
// Safe: a seat (and the stranger's checker) refuses an objection whose inputs carry a load the batch door refuses.
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

test('wf1489 v1-refute-66-s2-1: an objection on a live run cannot carry a load the batch door refuses', async () => {
  assert.ok(loadValueRefusal(FORBIDDEN), 'the batch door takes this load - not the case the test names');
  const w = await lockRound({ endMs: testNow() + 4000 });
  try {
    // seated and staked; the run goes out below by hand
    const p = await lockAndPlay(w, WINNER, { noMarks: true });
    const play = playFor(WINNER, w.randomness);
    const ticks = Array.from({ length: WINNER.ticks }, (_, t) => play.words(t));
    // THE SEATS GET AN HONEST BED (the fixture's, which every check passes) ...
    const input = { roundId: w.rid, entryId: p.eid, previousHash: GENESIS_HASH, firstTick: 0, ticks, liquidations: [], loads: bedFrom(0) };
    // ... AND A LIVE MARK SIGNED OVER THE FORBIDDEN BED
    const st = init(seedWordForEntry(p.entry, w.randomness || RANDOMNESS));
    submitLoad(st, FORBIDDEN[1], FORBIDDEN[2], FORBIDDEN[3]);
    for (let t = 0; t < WINNER.ticks; t++) step(st, ...ticks[t]);
    const mark = { roundId: w.rid, entryId: p.eid, tick: WINNER.ticks,
      stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
      inputChainHash: GENESIS_HASH, previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(p.session) };
    const signedMark = joinSigned(encodeCheckpoint(mark), ed25519.sign(checkpointId(mark), p.session));
    const answers = [];
    for (const d of [w.a, w.b]) {
      const took = await say(d.port, signedBatchOf(input, (id) => ed25519.sign(id, p.session)));
      const rc = await say(d.port, signedMark);
      answers.push([String(took), rc instanceof Uint8Array ? `${rc.length} bytes` : String(rc).slice(0, 160)]);
    }
    const receipted = answers.every((a) => a[1] === `${SIGNED_RECEIPT_BYTES} bytes`);
    await closeRound(w, { window: false });
    const signedBoth = await until(() => [w.a, w.b].every((d) => stateAt(d, w, p.eid).state === 'PROVISIONALLY_FINAL'));
    const signed = signedBoth ? ownResult(w.a, w, p.eid) : null;
    const facts = { answers, receipted, signedBoth, states: [w.a, w.b].map((d) => [stateAt(d, w, p.eid).state, stateAt(d, w, p.eid).why]),
      signed: signed && { outcome: signed.outcome, score: signed.score } };
    if (!signedBoth || !receipted) { console.log('  FACTS:', JSON.stringify(facts)); assert.fail(`setup: ${JSON.stringify(facts)}`); }

    // THE OBJECTION: the canonical transcript and the seats' receipts as handed out, the inputs with the forbidden load
    const canon = new Uint8Array(await (await fetch(`${base(w.b)}/canonical?round=${toHex(w.rid)}&entry=${toHex(p.eid)}`)).arrayBuffer());
    const batches = decodeTranscript(canon).batches.length;
    const j = await (await fetch(`${base(w.b)}/replay/transcript?round=${toHex(w.rid)}&entry=${toHex(p.eid)}`)).json();
    delete j.clock;
    const servedLoads = j.loads;
    j.loads = [FORBIDDEN];
    const inputs = new TextEncoder().encode(JSON.stringify(j));
    const ask = (claimed) => buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: p.eid, signedRunId: runId(signed),
      playerPubkey: signed.playerPubkey, claimed, transcript: canon, inputs });
    // what the forbidden bed replays to (the stranger's checker names it)
    const probe = await checkObjectionAt({ base: base(w.b), roundId: w.rid, entryId: p.eid, bundle: (await ask({ outcome: signed.outcome, score: signed.score })).bundle });
    const claimed = probe.replayed || { outcome: signed.outcome, score: signed.score };
    const b = await ask(claimed);
    const stranger = await checkObjectionAt({ base: base(w.b), roundId: w.rid, entryId: p.eid, bundle: b.bundle });
    const r = await postObjection(w.a, w, p.eid, b.bundle);
    const text = (await r.text()).trim();
    Object.assign(facts, { canonicalBatches: batches, servedLoads, probe: { holds: probe.holds, step: probe.step, why: probe.why },
      claimed, stranger: { holds: stranger.holds, step: stranger.step, why: stranger.why },
      seat: [r.status, text], after: stateAt(w.a, w, p.eid).state });
    console.log('  FACTS:', JSON.stringify(facts));
    assert.equal(stranger.holds, false, `the stranger's checker upholds an objection whose inputs carry ${JSON.stringify(FORBIDDEN)}: ${stranger.why}`);
    assert.equal(r.status, 422, `the seat took an objection whose inputs carry ${JSON.stringify(FORBIDDEN)}: ${r.status} ${text} (now ${facts.after})`);
  } finally { await w.close(); }
});
