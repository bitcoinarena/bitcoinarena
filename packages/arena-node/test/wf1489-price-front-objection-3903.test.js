// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3903 (found by #3901 on the 2.0 devnet, price feed on as on the live seats): a price round's signed result carries the front its run ended
// on (§13 front_*). The objection check built the replayed and the claimed run without it, so they never equalled the signed run: an honest bundle,
// claiming exactly the signed outcome and score, HELD against an honest committee, and every auditor (which replays through the same check) objected
// instead of AUDITing. On the 2-of-2 fixture both seats here sign the honest result in its front form, as a seat with the feed signs a price round.
// The honest bundle must be refused "the replay agrees with the signed result", and a stranger's check must name the signed run as the replay's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { WINNER, wait } from './window-fixture.js';
import { testNow } from './test-clock.js';
import { resultFinality } from '../src/finality.js';
import { runId } from '../src/verdict.js';
import { buildObjectionBundle } from '../tools/objection-bundle.mjs';
import { checkObjectionAt } from '../tools/check-objection.mjs';
import { splitSignedResult, decodePlayerResult, encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { frontOfRun } from '../../arena-protocol/src/round-result.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const base = (d) => `http://127.0.0.1:${d.port}`;
const until = async (ok, ms = 30000) => { for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) if (ok()) return true; return ok(); };
const postObjection = (d, w, eid, body) => fetch(`${base(d)}/objection?round=${toHex(w.rid)}&entry=${toHex(eid)}`, { method: 'POST', body });
const ownResult = (d, w, eid) => decodePlayerResult(splitSignedResult(d.round.results(w.rid, eid).find((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey)).bytes).body);

test('#3903 an honest price-round result signed with its front: the honest objection is refused, the replay names the signed run', async () => {
  const w = await lockRound({ endMs: testNow() + 4000 });
  try {
    const honest = await lockAndPlay(w, WINNER);
    await closeRound(w, { window: false });
    assert.ok(await until(() => [w.a, w.b].every((d) => resultFinality(d.round, w.rid, honest.eid).state === 'PROVISIONALLY_FINAL')), 'the run was not signed at both seats');
    // EACH SEAT SIGNS THE SAME RUN IN ITS FRONT FORM, the front read off the run's own canonical transcript (verdict.js resultFrom priceRound)
    const truth = ownResult(w.a, w, honest.eid);
    const front = frontOfRun(w.a.round.canonicalTranscript(w.rid, honest.eid).batches || []);
    for (const d of [w.a, w.b]) d.round.db.prepare('DELETE FROM results WHERE round_id = ? AND entry_id = ?').run(w.rid, honest.eid);
    for (const s of [w.a, w.b]) {
      const r = { ...truth, ...front, nodePubkey: s.round.pubkey };
      const bytes = joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), s.round.identity.secret));
      for (const d of [w.a, w.b]) d.round.putResult(w.rid, honest.eid, s.round.pubkey, resultId(r), bytes);
    }
    const signed = ownResult(w.a, w, honest.eid);
    assert.notEqual(toHex(runId(signed)), toHex(runId(truth)), 'the front form is another run id than the plain one');
    const b = await buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: honest.eid, signedRunId: runId(signed),
      playerPubkey: signed.playerPubkey, claimed: { outcome: signed.outcome, score: signed.score } });
    const fair = await postObjection(w.a, w, honest.eid, b.bundle);
    const fairText = (await fair.text()).trim();
    const stranger = await checkObjectionAt({ base: base(w.b), roundId: w.rid, entryId: honest.eid, bundle: b.bundle });
    console.log('  FACTS:', JSON.stringify({ honest: [fair.status, fairText.slice(0, 160)], signedRun: toHex(runId(signed)).slice(0, 16),
      strangerHolds: stranger.holds, strangerReplayed: stranger.replayedRunId && stranger.replayedRunId.slice(0, 16), front }));
    assert.equal(fair.status, 422, `the honest objection was taken: ${fair.status} ${fairText}`);
    assert.equal(fairText, 'the replay agrees with the signed result');
    assert.equal(stranger.holds, false);
    assert.equal(stranger.replayedRunId, toHex(runId(signed)), 'the replay does not name the run the seats signed (an auditor would object)');
    assert.deepEqual([w.a, w.b].map((d) => d.round.objected(w.rid, honest.eid)), [false, false], 'a refused objection was stored');
  } finally { await w.close(); }
});
