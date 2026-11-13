// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2596 (attacker audit, objection and replay): AN OUTSIDER OBJECTS AN HONEST RUN AWAY BY CUTTING ITS MARKS SHORT.
// An objection carries a transcript of the objector's choosing; the door checks that its mark chain is whole and that each
// mark it carries has a committee receipt - not that it carries the marks the committee receipted. The marks of a live
// run are a chain from the first, so the public canonical transcript with its last mark dropped is a whole chain; the public
// inputs cut before the new last mark reproduce every mark it still carries; the run is LIVE there and scored at that mark
// (§15) - another score, and another transcript hash in the run id besides. So a stranger, holding nothing but what any seat
// hands out (GET /canonical, /receipts, /replay/transcript), objects an honest DELIVERED run, the objection HOLDS
// (SUSPENDED, a re-run; the same trick against the re-run VOIDs the entry and slashes the honest signers).
// Safe: a seat refuses a transcript that stops short of the receipted marks it holds of that run (step 'chain').
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
import { decodeTranscript, encodeTranscript } from '../../arena-protocol/src/transcript.js';
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

test('wf1489 #2596-2: a stranger cannot object an honest live run away with its receipted marks cut short', async () => {
  const w = await lockRound({ endMs: testNow() + 4000 });
  try {
    // AN HONEST RUN: the whole run to both seats, a mark half way and one at the end, both receipted at both
    const p = await lockAndPlay(w, WINNER, { noMarks: true });
    const play = playFor(WINNER, w.randomness);
    const ticks = Array.from({ length: WINNER.ticks }, (_, t) => play.words(t));
    const K = Math.floor(WINNER.ticks / 2);
    const input = { roundId: w.rid, entryId: p.eid, previousHash: GENESIS_HASH, firstTick: 0, ticks, liquidations: [], loads: bedFrom(0) };
    const st = init(seedWordForEntry(p.entry, w.randomness || RANDOMNESS));
    submitLoad(st, ...bedFrom(0)[0].slice(1));
    const hashOf = () => Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16)));
    for (let t = 0; t < K; t++) step(st, ...ticks[t]);
    const markK = { roundId: w.rid, entryId: p.eid, tick: K, stateHash: hashOf(),
      inputChainHash: GENESIS_HASH, previousHash: NO_PREVIOUS, sessionPubkey: ed25519.getPublicKey(p.session) };
    for (let t = K; t < WINNER.ticks; t++) step(st, ...ticks[t]);
    const markEnd = { roundId: w.rid, entryId: p.eid, tick: WINNER.ticks, stateHash: hashOf(),
      inputChainHash: GENESIS_HASH, previousHash: checkpointId(markK), sessionPubkey: ed25519.getPublicKey(p.session) };
    const signedOf = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), p.session));
    const answers = [];
    for (const d of [w.a, w.b]) {
      const took = await say(d.port, signedBatchOf(input, (id) => ed25519.sign(id, p.session)));
      const r1 = await say(d.port, signedOf(markK));
      const r2 = await say(d.port, signedOf(markEnd));
      answers.push([String(took), ...[r1, r2].map((r) => (r instanceof Uint8Array ? `${r.length} bytes` : String(r).slice(0, 160)))]);
    }
    const receipted = answers.every((a) => a.slice(1).every((x) => x === `${SIGNED_RECEIPT_BYTES} bytes`));
    await closeRound(w, { window: false });
    const signedBoth = await until(() => [w.a, w.b].every((d) => stateAt(d, w, p.eid).state === 'PROVISIONALLY_FINAL'));
    const signed = signedBoth ? ownResult(w.a, w, p.eid) : null;
    const facts = { answers, receipted, signedBoth, signed: signed && { outcome: signed.outcome, score: signed.score } };
    if (!signedBoth || !receipted || signed.outcome !== 'DELIVERED') { console.log('  FACTS:', JSON.stringify(facts)); assert.fail(`setup: ${JSON.stringify(facts)}`); }

    // THE STRANGER: what seat B hands anyone, the canonical transcript's last mark dropped, the inputs cut before mark K
    const canon = decodeTranscript(new Uint8Array(await (await fetch(`${base(w.b)}/canonical?round=${toHex(w.rid)}&entry=${toHex(p.eid)}`)).arrayBuffer()));
    const cut = encodeTranscript({ ...canon, marks: canon.marks.slice(0, -1) });
    const j = await (await fetch(`${base(w.b)}/replay/transcript?round=${toHex(w.rid)}&entry=${toHex(p.eid)}`)).json();
    delete j.clock;
    j.ticks = j.ticks.filter((r) => r.tick < K);
    const inputs = new TextEncoder().encode(JSON.stringify(j));
    const ask = (claimed) => buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: p.eid, signedRunId: runId(signed),
      playerPubkey: signed.playerPubkey, claimed, transcript: cut, inputs });
    const probe = await checkObjectionAt({ base: base(w.b), roundId: w.rid, entryId: p.eid, bundle: (await ask({ outcome: signed.outcome, score: signed.score })).bundle });
    const claimed = probe.replayed || { outcome: signed.outcome, score: signed.score };
    const b = await ask(claimed);
    const r = await postObjection(w.a, w, p.eid, b.bundle);
    const text = (await r.text()).trim();
    Object.assign(facts, { canonMarks: canon.marks.length, probe: { holds: probe.holds, step: probe.step, why: probe.why }, claimed,
      seat: [r.status, text.slice(0, 220)], after: stateAt(w.a, w, p.eid).state });
    console.log('  FACTS:', JSON.stringify(facts));
    assert.equal(canon.marks.length, 2, 'the canonical transcript does not carry both marks - not the case the test names');
    assert.equal(r.status, 422, `the seat took a stranger's objection over the honest run's marks cut short: ${r.status} ${text} (now ${facts.after})`);
    assert.notEqual(facts.after, 'SUSPENDED');
  } finally { await w.close(); }
});
