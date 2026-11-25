// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-29 (#1517 recheck, #1706): copies of one run whose inputs carry event rows the replay never applies
// (a tick far past the run's end, or an extra trailing integer in a row) - the replay's work and answer are those of the
// honest bundle, yet each copy is a new cache key, so a stranger still chooses how many full replays one entry costs.
// REBUILT FOR MARKS THAT NAME THEIR INPUTS (kanban #3760, after #3567 and #3758). The copies first went against a live run:
// its mark named GENESIS, the canonical transcript carried no batch, and the inputs travelled beside it as free JSON - the
// part a stranger varied. A seat no longer signs such a run (#3567) and an honest client never sends one (#3758; #3762 for the
// run an old client still sends). The run's mark now names its batch, so the canonical transcript carries the inputs, and
// they are pinned by the transcript hash the objection names. The same copies - every row variant beside that transcript -
// are one replay key with the honest bundle: one entry still costs the stranger's copies one full replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { WINNER, wait, say } from './window-fixture.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';
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

test('wf1489 v1-refute-29: copies of a run\'s bundle with no-op or changed rows beside its batch transcript cost one full replay', async () => {
  const w = await lockRound({ endMs: testNow() + 4000 });
  try {
    // THE RUN, AS THE CLIENT SENDS IT: its batch, and its one mark naming that batch
    const honest = await lockAndPlay(w, WINNER, { noMarks: true });
    for (const d of [w.a, w.b]) {
      const got = await say(d.port, honest.late[0]);
      assert.ok(got === String(WINNER.ticks) || got === '0', `batch: ${String(got).slice(0, 160)}`);
      const rc = await say(d.port, honest.late[1]);
      assert.ok(rc instanceof Uint8Array && rc.length === SIGNED_RECEIPT_BYTES, `the mark was refused: ${String(rc).slice(0, 160)}`);
    }
    await closeRound(w, { window: false });
    assert.ok(await until(() => [w.a, w.b].every((d) => stateAt(d, w, honest.eid).state === 'PROVISIONALLY_FINAL')), 'run not signed at both seats');
    const signed = ownResult(w.a, w, honest.eid);
    const b = await buildObjectionBundle({ base: base(w.b), roundId: w.rid, entryId: honest.eid, signedRunId: runId(signed),
      playerPubkey: signed.playerPubkey, claimed: { outcome: signed.outcome, score: signed.score } });
    const p = decodeObjectionBundle(b.bundle);
    const batches = decodeTranscript(p.transcript).batches.length;
    assert.equal(batches, 1, 'setup: the canonical transcript carries the batch the mark committed to');
    // the inputs as any seat hands them out, varied beside the transcript as the stranger did beside a live run's
    const j0 = await (await fetch(`${base(w.b)}/replay/transcript?round=${toHex(w.rid)}&entry=${toHex(honest.eid)}`)).json();
    delete j0.clock;
    const variants = [
      // a liquidation at a tick the run never reaches (a billion ticks on): never applied
      (i) => ({ ...j0, liquidations: [...(j0.liquidations || []), [1e9 + i, 1]] }),
      // a price sample far past the end: never applied
      (i) => ({ ...j0, samples: [...(j0.samples || []), [2e9 + i, 1]] }),
      // a tape row far past the end
      (i) => ({ ...j0, tapes: [...(j0.tapes || []), [3e9 + i, 1, 1]] }),
      // a word changed at the last tick: against a live run a different run, one more full replay; beside a batch
      // transcript the door replays the transcript's own batches, so it is the honest bundle's replay too
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
    assert.ok(answers.every((a) => a[0] === 422 && a[1] === firstText), 'a copy was answered differently from the honest bundle - its rows were read beside the batch transcript');
    assert.equal(replays, 1, `13 bundles from one stranger against one run cost ${replays} full replays (the entry held SUSPENDED behind each)`);
  } finally { await w.close(); }
});
