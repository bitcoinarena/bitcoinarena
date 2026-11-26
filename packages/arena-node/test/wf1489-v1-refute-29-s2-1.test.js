// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-29 s2 (#1517, #1706 recheck): a seat that does not hold the whole run (a peer fed behind, or one that missed
// the tail across a restart) gets no help from 7a, and then every one-word copy is a full replay of its own.
// REBUILT FOR MARKS THAT NAME THEIR INPUTS (kanban #3760, after #3567 and #3758). The copies first went against a live run:
// its mark named GENESIS, the canonical transcript carried no batch, and the inputs travelled beside it as free JSON - the
// part a stranger varied, checked against the seat's own stored run. A seat no longer signs such a run (#3567) and an honest
// client never sends one (#3758; #3762 for the run an old client still sends). The run's mark now names its batch, so the
// inputs the door replays are the transcript's own batches, pinned by the transcript hash the objection names - not the
// seat's store. A seat that does not hold the whole run replays the same thing as one that does: the copies are one key.
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

test('wf1489 v1-refute-29 s2: one-word copies at a seat that does not hold the whole run cost one replay between them', async () => {
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
    assert.equal(decodeTranscript(p.transcript).batches.length, 1, 'setup: the canonical transcript carries the batch the mark committed to');
    // the inputs as any seat hands them out, varied beside the transcript as the stranger did beside a live run's
    const j0 = await (await fetch(`${base(w.b)}/replay/transcript?round=${toHex(w.rid)}&entry=${toHex(honest.eid)}`)).json();
    delete j0.clock;
    // SEAT A DOES NOT HOLD THE RUN'S LAST TICK (a peer behind on the feed / the tail missed across a restart): the row is moved
    // out of the run's span (no row is removed), so A's own run stops one tick short of the receipted mark.
    const last = w.a.round.db.prepare('SELECT tick FROM ticks WHERE round_id = ? AND entry_id = ? ORDER BY tick DESC LIMIT 1').get(w.rid, honest.eid);
    w.a.round.db.prepare('UPDATE ticks SET tick = ? WHERE round_id = ? AND entry_id = ? AND tick = ?').run(last.tick + 1000000, w.rid, honest.eid, last.tick);
    const enc = (j) => encodeObjectionBundle({ objection: p.objectionBytes, signature: p.signature, transcript: p.transcript, receipts: p.receipts,
      inputs: new TextEncoder().encode(JSON.stringify(j)) });
    // a stranger's copies of the public bundle, one word changed in the last tick each
    const copy = (i) => ({ ...j0, ticks: j0.ticks.map((r, k) => (k === j0.ticks.length - 1 ? { tick: r.tick, words: r.words.map((x, n) => (n === 0 ? x + 1 + i : x)) } : r)) });
    const before = w.a.verifier.objectionReplayCount;
    const answers = [];
    for (let i = 0; i < 8; i++) { const r = await postObjection(w.a, w, honest.eid, enc(copy(i))); answers.push([r.status, (await r.text()).trim()]); }
    const replays = w.a.verifier.objectionReplayCount - before;
    console.log('  FACTS:', JSON.stringify({ answers: [...new Set(answers.map((a) => a.join(' ')))], replays }));
    assert.ok(answers.every((a) => a[0] === 422), 'a copy held');
    assert.ok(replays <= 1, `8 one-word copies of one run cost ${replays} full replays at a seat that does not hold the whole run (the entry SUSPENDED behind each)`);
  } finally { await w.close(); }
});
