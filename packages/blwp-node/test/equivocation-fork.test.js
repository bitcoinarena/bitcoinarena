// §13B AT ANY TICK (kanban #25, RULED the owner 2026-10-04): "A player who publishes two different checkpoints for the same
// (round_id, player_pubkey, tick), or two chains that diverge at any tick, forfeits the entry." Before: only two FIRST marks
// diverted to forfeit; a fork at a later tick was stored and the canonical run signed as ever. On a 2-of-2 round of two
// running seats, the player's run with a first mark at tick 60 and, at its end, mark X sent only to seat A and a
// contradicting mark Y only to seat B - no seat holds both:
//   (a) same tick: each seat finds the pair (its own mark and the peer's, pulled), signs FORFEIT/0 over the canonical
//       transcript, logs "[close] <entry> FORFEIT: two chains at tick N (§13B)"; FINAL FORFEIT 2 of 2; both seats then serve
//       the pair at /equivocation; an honest entry in the same round is signed as before;
//   (b) a parent fork (Y one tick earlier from the same parent): the same;
//   (c) settlement: with a qualifier the FORFEIT lock is claimed into the pool and pays the winner; with nobody qualified
//       it is claimed like a walk-away's, into the remainder split (75% the sitting seats, 25% the donation set).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32, WINNER, LOSER, wait } from './window-fixture.js';
import { resultFinality } from '../src/finality.js';
import { splitSignedResult, decodePlayerResult } from '../../protocol/src/result.js';
import { SIGNED_CHECKPOINT_BYTES } from '../../protocol/src/checkpoint.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { TEST_DONATION_SET_REGTEST } from '../../protocol/src/test-donation-sets.js';
import { toHex } from '../../protocol/src/hash.js';

const CHEAT = { name: 'cheat', key: b32(9), worldSecret: b32(0xc3), ticks: 1000 };
const key = (o) => `${toHex(o.txid)}:${o.outIdx}`;
const resultsAt = (d, w, eid) => [...new Set(d.round.results(w.rid, eid).map((r) => { const x = decodePlayerResult(splitSignedResult(r.bytes).body); return `${x.outcome}/${x.score}`; }))];
const pairsAt = async (d, w, eid) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/equivocation?round=${toHex(w.rid)}&entry=${toHex(eid)}`);
  const body = new Uint8Array(await r.arrayBuffer());
  return { status: r.status, pairs: Math.floor(body.length / (2 * SIGNED_CHECKPOINT_BYTES)) };
};

/** Watch both seats' console for the §13B close line of `eid`. */
function forfeitLines() {
  const seen = [];
  const log = console.log;
  console.log = (...a) => { const s = a.join(' '); if (/\[close\] .* FORFEIT: two chains at tick/.test(s) || /\[equivocation\]/.test(s)) seen.push(s); log(...a); };
  return { seen, stop: () => { console.log = log; } };
}

async function forkRound(mode) {
  const w = await lockRound();
  const won = await lockAndPlay(w, WINNER, { address: true });
  const cheat = await lockAndPlay(w, CHEAT, { fork: mode });
  return { w, won, cheat };
}

for (const mode of ['tick', 'parent']) {
  test(`(${mode === 'tick' ? 'a' : 'b'}) a fork by ${mode} after the first mark, one mark at each seat: FORFEIT/0 at both, FINAL 2 of 2, the pair served at both; the honest entry as before; its lock claimed into the pool`, async () => {
    const lines = forfeitLines();
    const { w, won, cheat } = await forkRound(mode);
    try {
      const before = await Promise.all([w.a, w.b].map((d) => pairsAt(d, w, cheat.eid)));
      await closeRound(w);
      const got = await untilSettled(w, 60000);
      const after = await Promise.all([w.a, w.b].map((d) => pairsAt(d, w, cheat.eid)));
      const facts = {
        fork: { mode, tick: cheat.forked.tick }, pairsBefore: before.map((p) => p.pairs), pairsAfter: after.map((p) => p.pairs),
        cheat: [w.a, w.b].map((d) => ({ results: resultsAt(d, w, cheat.eid), state: resultFinality(d.round, w.rid, cheat.eid).state })),
        honest: [w.a, w.b].map((d) => ({ results: resultsAt(d, w, won.eid), state: resultFinality(d.round, w.rid, won.eid).state })),
        lines: lines.seen.map((l) => l.slice(0, 160)), settled: got.state,
        claims: (w.port.settlements[0] ? w.port.settlements[0].claims : []).map((c) => key(c.outpoint) === key(cheat.outpoint) ? 'CHEAT STAKE' : key(c.outpoint) === key(won.outpoint) ? 'WINNER STAKE' : 'fee'),
        toWinner: [...w.port.payouts.values()].filter((p) => toHex(p.payoutPk) === toHex(refundKeyOf(WINNER.key))).map((p) => String(p.msat)),
      };
      console.log('  FACTS (fork):', JSON.stringify(facts));
      assert.deepEqual(facts.pairsBefore, [0, 0], 'a seat held both marks before the close: not the case the test names');
      for (const s of facts.cheat) assert.deepEqual(s, { results: ['FORFEIT/0'], state: 'FINAL' });
      assert.ok(facts.pairsAfter.every((n) => n >= 1), 'a seat does not serve the pair at /equivocation');
      for (const s of facts.honest) { assert.equal(s.state, 'FINAL'); assert.equal(s.results.length, 1); assert.match(s.results[0], /^DELIVERED\//); }
      // and both seats sign over the same signers: 2 of 2 on the FORFEIT
      for (const d of [w.a, w.b]) assert.equal(d.round.results(w.rid, cheat.eid).length, 2);
      assert.equal(lines.seen.filter((l) => new RegExp(`\\[close\\] ${toHex(cheat.eid).slice(0, 16)} FORFEIT: two chains at tick ${cheat.forked.tick} \\(§13B\\)`).test(l)).length >= 2, true,
        `not both seats logged the §13B close: ${JSON.stringify(lines.seen)}`);
      assert.equal(got.state, 'ACCEPTED', got.why);
      assert.ok(facts.claims.includes('CHEAT STAKE'), 'the equivocator\'s lock was not claimed into the pool');
      assert.equal(facts.toWinner.length, 1, 'the winner was not paid');
    } finally { lines.stop(); await w.close(); }
  });
}

test('(c) with nobody qualified, the proven equivocator\'s lock is claimed like a walk-away\'s: into the remainder split, 75% to the sitting seats and 25% to the donation set - not left to expire', async () => {
  const w = await lockRound({ serveOpts: { donationSets: [TEST_DONATION_SET_REGTEST] } });
  try {
    const lost = await lockAndPlay(w, LOSER);
    const cheat = await lockAndPlay(w, CHEAT, { fork: 'tick' });
    await closeRound(w);
    const got = await untilSettled(w, 60000);
    const claims = (w.port.settlements[0] ? w.port.settlements[0].claims : []).map((c) => key(c.outpoint) === key(cheat.outpoint) ? 'CHEAT STAKE' : key(c.outpoint) === key(lost.outpoint) ? 'LOSER STAKE' : 'fee');
    const facts = { cheat: [w.a, w.b].map((d) => resultsAt(d, w, cheat.eid)), settled: got.state, why: got.why, claims,
      cheatLockHeld: w.port.locks.has(key(cheat.outpoint)), loserLockHeld: w.port.locks.has(key(lost.outpoint)),
      payouts: [...w.port.payouts.values()].map((p) => String(p.msat)) };
    console.log('  FACTS (nobody qualified):', JSON.stringify(facts));
    assert.deepEqual(facts.cheat, [['FORFEIT/0'], ['FORFEIT/0']]);
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.ok(claims.includes('CHEAT STAKE'), 'the equivocator\'s lock was left unclaimed');
    assert.equal(facts.cheatLockHeld, false);
    assert.equal(claims.includes('LOSER STAKE'), false, 'an honest loser\'s lock was claimed with nobody qualified');
    assert.equal(facts.loserLockHeld, true, 'the honest loser\'s lock does not expire back to its player');
    // THE REMAINDER SPLIT of the equivocator's 98000 msat: 75% to the two sitting seats, 25% to the donation set
    const net = 98000n, sum = (xs) => xs.reduce((t, x) => t + BigInt(x), 0n);
    const seats = facts.payouts.filter((x) => x === String(net * 75n / 100n / 2n));
    assert.equal(seats.length, 2, `the seats' 75% is not two shares of ${net * 75n / 100n / 2n}: ${facts.payouts}`);
    const rest = facts.payouts.filter((x) => x !== String(net * 75n / 100n / 2n) && x !== '2000');
    assert.equal(sum(rest), net * 25n / 100n, `the donation set's 25% is not ${net * 25n / 100n}: ${rest}`);
  } finally { await w.close(); }
});

// THE #25 AUDIT. (d) THE EQUIVOCATOR'S OBJECTION: the FORFEIT is signed over the canonical transcript, whose inputs a replay
// would "contradict" - a stranger's check of the player's own bundle holds against FORFEIT/0 - so the seat holding the proof
// refuses it at the door by §13B, before any replay, and stores nothing; the entry stays FORFEIT.
test('(d) the equivocator objecting to its own FORFEIT with its canonical transcript is refused at the door by §13B, and the FORFEIT stands', async () => {
  const { buildObjectionBundle } = await import('../tools/objection-bundle.mjs');
  const { checkObjectionAt } = await import('../tools/check-objection.mjs');
  const { runId } = await import('../src/verdict.js');
  const w = await lockRound();
  try {
    const won = await lockAndPlay(w, WINNER, { address: true });
    const cheat = await lockAndPlay(w, CHEAT, { fork: 'tick' });
    await closeRound(w, { window: false });
    const forfeitBoth = () => [w.a, w.b].every((d) => { const f = resultFinality(d.round, w.rid, cheat.eid); return f.state === 'PROVISIONALLY_FINAL'; });
    for (const stop = Date.now() + 30000; Date.now() < stop && !forfeitBoth(); await wait(100));
    const signed = decodePlayerResult(splitSignedResult(w.a.round.results(w.rid, cheat.eid)[0].bytes).body);
    const base = `http://127.0.0.1:${w.b.port}`;
    // what the replay of the cheat's own inputs gives - read off a first bundle's refusal - and the bundle claiming it
    const probe = await buildObjectionBundle({ base, roundId: w.rid, entryId: cheat.eid, signedRunId: runId(signed), playerPubkey: signed.playerPubkey, claimed: { outcome: 'DELIVERED', score: 1 } });
    const probed = await checkObjectionAt({ base, roundId: w.rid, entryId: cheat.eid, bundle: probe.bundle });
    const bundle = (await buildObjectionBundle({ base, roundId: w.rid, entryId: cheat.eid, signedRunId: runId(signed), playerPubkey: signed.playerPubkey, claimed: probed.replayed })).bundle;
    const stranger = await checkObjectionAt({ base, roundId: w.rid, entryId: cheat.eid, bundle });
    const atSeats = [];
    for (const d of [w.a, w.b]) {
      const r = await fetch(`http://127.0.0.1:${d.port}/objection?round=${toHex(w.rid)}&entry=${toHex(cheat.eid)}`, { method: 'POST', body: bundle });
      atSeats.push([r.status, (await r.text()).trim()]);
    }
    const after = [w.a, w.b].map((d) => ({ objected: d.round.objected(w.rid, cheat.eid), state: resultFinality(d.round, w.rid, cheat.eid).state, results: resultsAt(d, w, cheat.eid) }));
    console.log('  FACTS (the equivocator objects):', JSON.stringify({ signed: `${signed.outcome}/${signed.score}`, replayed: probed.replayed,
      strangerAlone: { holds: stranger.holds, why: stranger.why }, atSeats, after }));
    assert.equal(stranger.holds, true, 'the checker alone did not find the FORFEIT contradicted: not the case the test names');
    for (const [status, text] of atSeats) {
      assert.equal(status, 422);
      assert.match(text, /^that entry forfeited by §13B: this seat holds the proof that the player signed two chains \(at tick 1000\), which no replay contradicts$/);
    }
    for (const x of after) assert.deepEqual(x, { objected: false, state: 'PROVISIONALLY_FINAL', results: ['FORFEIT/0'] });
    assert.ok(won);
  } finally { await w.close(); }
});

// (e) A FORK HELD AT ONE SEAT ONLY: both marks reached seat A (the second refused there as an equivocation, and kept);
// seat B holds X alone - and pulls the pair from A's /equivocation at its close. FORFEIT at both.
test('(e) a fork held at one seat only is pulled by the other: FORFEIT/0 at both, FINAL', async () => {
  const w = await lockRound();
  try {
    const won = await lockAndPlay(w, WINNER, { address: true });
    const cheat = await lockAndPlay(w, CHEAT, { fork: 'one-seat' });
    const before = await Promise.all([w.a, w.b].map((d) => pairsAt(d, w, cheat.eid)));
    await closeRound(w);
    const got = await untilSettled(w, 60000);
    const after = await Promise.all([w.a, w.b].map((d) => pairsAt(d, w, cheat.eid)));
    const facts = { refusedAtA: cheat.forked.refusedAtFirst, pairsBefore: before.map((p) => p.pairs), pairsAfter: after.map((p) => p.pairs),
      cheat: [w.a, w.b].map((d) => ({ results: resultsAt(d, w, cheat.eid), state: resultFinality(d.round, w.rid, cheat.eid).state })), settled: got.state };
    console.log('  FACTS (fork at one seat):', JSON.stringify(facts));
    assert.match(facts.refusedAtA, /equivocation at tick 1000/);
    assert.deepEqual(facts.pairsBefore, [1, 0], 'the pair was not at seat A alone before the close');
    for (const s of facts.cheat) assert.deepEqual(s, { results: ['FORFEIT/0'], state: 'FINAL' });
    assert.ok(facts.pairsAfter[1] >= 1, 'seat B does not serve the pair it pulled');
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.ok(won);
  } finally { await w.close(); }
});

// (f) THE SPLIT: a seat signs the run without the proof (seat B's FORFEIT replaced by a run it signs) - no run at 2 of 2 in
// the window - and §13C decides FORFEIT at the deadline, the fork counting as proven equivocation; the lock claimed.
test('(f) a seat signing the run without the proof makes a split: §13C decides FORFEIT at the deadline on the fork, and the lock is claimed', async () => {
  const { schnorr } = await import('@noble/curves/secp256k1.js');
  const { encodePlayerResult, joinSignedResult, resultId } = await import('../../protocol/src/result.js');
  const { windowsOf } = await import('../../protocol/src/window.js');
  const { skipTo } = await import('./test-clock.js');
  const w = await lockRound();
  try {
    const won = await lockAndPlay(w, WINNER, { address: true });
    const cheat = await lockAndPlay(w, CHEAT, { fork: 'tick' });
    await closeRound(w, { window: false });
    for (const stop = Date.now() + 30000; Date.now() < stop && !([w.a, w.b].every((d) => d.round.results(w.rid, cheat.eid).length === 2)); await wait(100));
    const forfeitB = decodePlayerResult(splitSignedResult(w.b.round.results(w.rid, cheat.eid).find((r) => toHex(r.nodePubkey) === toHex(w.b.round.pubkey)).bytes).body);
    const run = { ...forfeitB, outcome: 'FAILED', score: 0 };
    const bytes = joinSignedResult(encodePlayerResult(run), schnorr.sign(resultId(run), w.b.round.identity.secret));
    for (const d of [w.a, w.b]) {
      d.round.db.prepare('DELETE FROM results WHERE round_id = ? AND entry_id = ? AND node_pubkey = ?').run(w.rid, cheat.eid, w.b.round.pubkey);
      d.round.putResult(w.rid, cheat.eid, w.b.round.pubkey, resultId(run), bytes);
    }
    const ready = () => [w.a, w.b].every((d) => { const f = resultFinality(d.round, w.rid, won.eid); return f.state === 'PROVISIONALLY_FINAL' && f.published === true; });
    for (const stop = Date.now() + 30000; Date.now() < stop && !ready(); await wait(100));
    skipTo(Number(windowsOf(w.c).finalAfterMs) + 50);
    const got = await untilSettled(w, 60000);
    const at = [w.a, w.b].map((d) => resultFinality(d.round, w.rid, cheat.eid));
    const claims = (w.port.settlements[0] ? w.port.settlements[0].claims : []).map((c) => key(c.outpoint) === key(cheat.outpoint) ? 'CHEAT STAKE' : 'other');
    console.log('  FACTS (split on a fork):', JSON.stringify({ results: [w.a, w.b].map((d) => resultsAt(d, w, cheat.eid)), at: at.map((f) => [f.state, f.why]), settled: got.state, claims }));
    for (const f of at) {
      assert.equal(f.state, 'FORFEIT', f.why);
      assert.match(f.why, /1 of 2 matching results held in time - .*the player signed two chains/);
    }
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.ok(claims.includes('CHEAT STAKE'), 'the equivocator\'s lock was not claimed');
  } finally { await w.close(); }
});
