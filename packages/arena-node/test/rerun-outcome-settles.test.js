// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AFTER AN OBJECTION RE-RUN ENDS FINAL, THE MONEY GOES BY THE RE-RUN (§13A "the replay outcome is authoritative", kanban #1049).
//
// Two running seats (their own DKG, the fake federation) sign one run for an entry; an objection holds; both sign a re-run with
// another outcome; the re-run's own window closes and both sign FINAL on it. Each seat's own PlayerResult still names the
// contradicted run. Measured here: what the table reads, what the lock does, what the forfeit door and the stake secret answer.
//
// THE RE-RUNS AND THE OBJECTION ARE WRITTEN TO THE STORES: a seat's honest replay cannot differ from itself, so the test hands each
// seat a re-run under its own key and the objection's row, as the door stores it once its replay holds. The rest - finality, the
// FINAL signatures, the settlement, the late sweep, the doors - is the seats' own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32, LOSER, wait, qualifiersUnder } from './window-fixture.js';
import { ROUND } from './protocol22-fixture.js';
import { skipTo } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { resultFinality } from '../src/finality.js';
import { windowsOf } from '../../arena-protocol/src/window.js';
import { splitSignedResult, decodePlayerResult, resultId } from '../../arena-protocol/src/result.js';
import { encodeRerunResult, rerunResultId, joinSignedRerun } from '../../arena-protocol/src/rerun.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const THIRD = { name: 'third', key: b32(6), worldSecret: b32(0xc1), ticks: 1000 };
const key = (o) => `${toHex(o.txid)}:${o.outIdx}`;
const OPTS = { serveOpts: { plugins: [NEXTBLOCK], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], finality: { everyMs: 100, lateEveryMs: 200 } } };
const until = async (ok, ms = 30000) => { for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) if (ok()) return true; return ok(); };

/** The objection and both seats' re-runs of `x`, stored at both seats inside the window. */
function objectAndRerun(w, x, over) {
  const shape = decodePlayerResult(splitSignedResult(w.a.round.results(w.rid, x.eid)[0].bytes).body);
  const contradicted = resultId({ ...shape, nodePubkey: new Uint8Array(32) });
  for (const d of [w.a, w.b]) d.round.object(w.rid, x.eid, null, b32(0xbb));
  for (const s of [w.a, w.b]) {
    const r = { contradictedRunId: contradicted, signedAtMs: BigInt(s.round.now()), result: { ...shape, ...over, nodePubkey: s.round.pubkey } };
    const bytes = joinSignedRerun(encodeRerunResult(r), schnorr.sign(rerunResultId(r), s.round.identity.secret));
    for (const d of [w.a, w.b]) d.round.putRerun(w.rid, x.eid, s.round.pubkey, bytes);
  }
}

/** The round settled without `x`, then the re-run's own window over and FINAL on it at both seats. */
async function finalOnRerun(w, x, over) {
  await closeRound(w, { inside: async () => objectAndRerun(w, x, over) });
  const first = await untilSettled(w, 60000);
  assert.equal(first.state, 'ACCEPTED', JSON.stringify(first));
  skipTo(Number(windowsOf(w.c).ownFinalAfterMs) + 50);
  const finalAt = (d) => resultFinality(d.round, w.rid, x.eid);
  const nudge = async () => {
    for (const d of [w.a, w.b]) {
      const q = `round=${toHex(w.rid)}&entry=${toHex(x.eid)}`;
      const own = await fetch(`http://127.0.0.1:${d.port}/final-sig?${q}`);
      if (own.status !== 200) continue;
      const bytes = new Uint8Array(await own.arrayBuffer());
      for (const e of [w.a, w.b]) await fetch(`http://127.0.0.1:${e.port}/final-sig?${q}`, { method: 'POST', body: bytes });
    }
  };
  await nudge();
  assert.ok(await until(() => [w.a, w.b].every((d) => finalAt(d).state === 'FINAL')), `not FINAL: ${finalAt(w.a).state}: ${finalAt(w.a).why}`);
  await wait(800);                                                             // four late sweeps
}

async function facts(w, x) {
  const q = `round=${toHex(w.rid)}&entry=${toHex(x.eid)}`;
  const table = [w.a, w.b].map((d) => { const on = d.settlements.entriesOnRecord(w.rid, w.c); const e = on.ok && on.entries.find((y) => toHex(y.entryId) === toHex(x.eid)); return on.ok ? (e ? `${e.outcome}/${e.score}` : 'left out') : on.why; });
  const after = [w.a, w.b].map((d) => d.settlements.lockAfterSettlement(w.rid, x.eid).why);
  const forfeit = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?${q}`);
  const forfeitSaid = (await forfeit.text()).slice(0, 120);
  const release = w.a.stakeSecrets.mayRelease(w.rid, x.eid);
  const second = w.port.settlements.find((s) => s.claims.some((c) => key(c.outpoint) === key(x.outpoint)));
  const standing = resultFinality(w.a.round, w.rid, x.eid);
  return { state: standing.state, onRerun: !!standing.contradictedRunId, table, after, forfeit: forfeit.status, forfeitSaid, release: release.ok ? release.outcome : release.why,
    secondSettlementClaimsIt: !!second, lockHeld: w.port.locks.has(key(x.outpoint)) };
}

test('an own FAILED run re-run to DELIVERED is a qualifier: nobody claims its lock, its stake comes back by its forfeit, its P stays sealed', { timeout: 110000 }, async () => {
  const w = await lockRound({ ...OPTS, round: ROUND });
  try {
    const [q] = await qualifiersUnder(w.randomness, 1);
    await lockAndPlay(w, q, { address: true });
    await lockAndPlay(w, LOSER);
    const x = await lockAndPlay(w, THIRD);
    await finalOnRerun(w, x, { outcome: 'DELIVERED', score: 9 });
    await until(() => w.port.settlements.some((s) => s.claims.some((c) => key(c.outpoint) === key(x.outpoint))), 8000);   // the sweeps have time to get it wrong
    const f = await facts(w, x);
    console.log('  FACTS (own FAILED, re-run DELIVERED):', JSON.stringify(f));
    assert.equal(f.state, 'FINAL');
    assert.deepEqual(f.table, ['DELIVERED/9', 'DELIVERED/9']);
    assert.equal(f.secondSettlementClaimsIt, false, 'a qualifier by the re-run was claimed as a loser');
    assert.equal(f.lockHeld, true);
    assert.equal(f.forfeit, 200, f.forfeitSaid);
    assert.match(String(f.release), /stake secret/);
    assert.match(f.after[0], /a qualifier/);
  } finally { await w.close(); }
});

test('an own DELIVERED run re-run to FAILED is a loser: its lock is claimed in the second settlement, no forfeit, its P released', { timeout: 110000 }, async () => {
  const w = await lockRound({ ...OPTS, round: ROUND });
  try {
    const [q1, q2] = await qualifiersUnder(w.randomness, 2);
    await lockAndPlay(w, q1, { address: true });
    await lockAndPlay(w, LOSER);
    const x = await lockAndPlay(w, q2, { address: true });
    await finalOnRerun(w, x, { outcome: 'FAILED', score: 0 });
    await until(() => w.port.settlements.some((s) => s.claims.some((c) => key(c.outpoint) === key(x.outpoint))), 8000);
    const f = await facts(w, x);
    console.log('  FACTS (own DELIVERED, re-run FAILED):', JSON.stringify(f));
    assert.equal(f.state, 'FINAL');
    assert.deepEqual(f.table, ['FAILED/0', 'FAILED/0']);
    assert.equal(f.secondSettlementClaimsIt, true, 'a loser by the re-run kept its stake');
    assert.notEqual(f.forfeit, 200, 'the lock of a loser by the re-run was forfeited back');
    assert.equal(f.release, 'FAILED');
  } finally { await w.close(); }
});

test('GATED: a round before protocol 22 settles on each seat\'s own result, as it always did: its table and its late plan are unchanged', { timeout: 110000 }, async () => {
  const w = await lockRound(OPTS);
  try {
    const [q] = await qualifiersUnder(w.randomness, 1);
    await lockAndPlay(w, q, { address: true });
    await lockAndPlay(w, LOSER);
    const x = await lockAndPlay(w, THIRD);
    await finalOnRerun(w, x, { outcome: 'DELIVERED', score: 9 });
    await until(() => w.port.settlements.some((s) => s.claims.some((c) => key(c.outpoint) === key(x.outpoint))), 8000);
    const f = await facts(w, x);
    console.log('  FACTS (protocol 1, own FAILED, re-run DELIVERED):', JSON.stringify(f));
    assert.equal(f.state, 'FINAL');
    assert.match(f.table[0], /^FAILED\//);
    assert.equal(f.secondSettlementClaimsIt, true);
    assert.equal(f.release, 'FAILED');
  } finally { await w.close(); }
});
