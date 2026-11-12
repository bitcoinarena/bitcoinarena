// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-settle-1: THE OBJECTION DOOR'S REPLAY BOUND HOLDS FOR ANY BYTES OF ONE RUN.
// verify.js checkObjection keys its "the same run is replayed once" cache by sha256 of the bundle's RAW transcript and
// inputs bytes. A stranger who copied the public canonical transcript and receipts can append a fifth part (inputs) that
// differs only in bytes the checker ignores - JSON whitespace, an unknown key, or inputs beside a transcript that carries
// batches (never read at all) - and every copy is a fresh full replay, queued one at a time per entry while the entry is
// held SUSPENDED at the seat (finality.js: a check in flight holds it whatever its age). Safe: copies of one run whose
// replay input is the same cost one replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { WINNER, wait } from './window-fixture.js';
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

test('wf1489 r1-settle-1: copies of one run that differ only in ignored inputs bytes cost one objection replay', async () => {
  const w = await lockRound({ endMs: testNow() + 4000 });
  try {
    const honest = await lockAndPlay(w, WINNER);
    await closeRound(w, { window: false });
    assert.ok(await until(() => [w.a, w.b].every((d) => stateAt(d, w, honest.eid).state === 'PROVISIONALLY_FINAL')), 'run not signed at both seats');
    const signed = ownResult(w.a, w, honest.eid);
    const b = await buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: honest.eid, signedRunId: runId(signed),
      playerPubkey: signed.playerPubkey, claimed: { outcome: signed.outcome, score: signed.score } });
    const p = decodeObjectionBundle(b.bundle);
    const batches = decodeTranscript(p.transcript).batches.length;
    // the same objection, transcript and receipts; only the inputs part's bytes differ in what the checker never reads
    const variant = (i) => {
      let inputs;
      if (p.inputs) { const j = JSON.parse(Buffer.from(p.inputs).toString('utf8')); j[`pad${i}`] = i; inputs = new TextEncoder().encode(JSON.stringify(j)); }
      else inputs = new TextEncoder().encode(`{"pad":${i}}`);         // a batch transcript: the inputs part is ignored outright
      return encodeObjectionBundle({ objection: p.objectionBytes, signature: p.signature, transcript: p.transcript, receipts: p.receipts, inputs });
    };
    const before = w.a.verifier.objectionReplayCount;
    const first = await postObjection(w.a, w, honest.eid, b.bundle);
    const firstText = (await first.text()).trim();
    const answers = [];
    for (let i = 0; i < 5; i++) { const r = await postObjection(w.a, w, honest.eid, variant(i)); answers.push([r.status, (await r.text()).trim()]); }
    const replays = w.a.verifier.objectionReplayCount - before;
    console.log('  FACTS:', JSON.stringify({ batches, liveInputs: !!p.inputs, first: [first.status, firstText], variants: [...new Set(answers.map((a) => a.join(' ')))], replays }));
    assert.equal(first.status, 422);
    assert.ok(answers.every((a) => a[0] === 422), 'a variant was not refused as the honest bundle was');
    assert.equal(replays, 1, `six bundles of one run (the replay input identical) cost ${replays} full replays - a stranger chooses how many`);
  } finally { await w.close(); }
});
