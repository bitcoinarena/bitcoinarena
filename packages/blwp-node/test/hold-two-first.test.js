// TWO FIRST MARKS ON A LIGHTNING HOLD (M3.3-34, ruled 2026-09-13, path 3).
//
// Ruled: two first marks is the player's FORFEIT, not an escape - the player
// does not get the hold back. Beside a winner, a no-quorum FORFEIT's hold is
// settled into the pool like the paid walk-away's (walk-away-hold.test.js),
// never cancelled nor left to expire to the player - and without minting a
// signed FORFEIT 0 result or an agreed run that never happened.
//
// THE ORDER: the entry joined and its hold seen at both signer nodes; B down; the
// player's on-time first mark (60) reaches A only; B back; a DIFFERENT on-time
// first mark (30) to B. Neither mark reaches two signer nodes and the signer nodes hold the
// pair: no quorum, proven equivocation - FORFEIT at both after the result
// window (§13C), a local no-quorum record, no signed result. A winner plays
// beside it, so the pool has somebody to go to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeAssigned } from './assignment.js';
import { paidPort, contractFor, say, wait, opts, rand, secretScalar, STAKE, joinAndPlay, WINNER, LOSER,
  RANDOMNESS, GENESIS_HASH, wordsAt } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { encodeInputBatch, batchId } from '../../protocol/src/batch.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../protocol/src/checkpoint.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { seedWordForEntry } from '../../protocol/src/seed.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { init, step } from '../../core/src/sim.js';
import { hash as stateHash } from '../../core/src/state.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

const WINDOW = 800;
const answer = (s) => (typeof s === 'string' ? (s.length > 30 && !s.startsWith('error') ? 'receipt' : s.slice(0, 90)) : 'receipt');

/** Two live signer nodes on hold invoices, B restartable on the same store, port and Lightning. */
async function twoSignerNodesOnHolds() {
  const ports = [paidPort(), paidPort()];
  const dbs = [openStore(':memory:'), openStore(':memory:')];
  const mk = (i, port = 0) => serve(dbs[i], { port, ...opts, lightning: ports[i], finality: { everyMs: 100 } });
  const a = await mk(0);
  let b = await mk(1);
  const bPort = b.port;
  const wire = () => {
    for (const [d, o] of [[a, b], [b, a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  const c = contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW), [a, b].map((d) => `http://127.0.0.1:${d.port}`));
  const rid = roundId(c);
  for (const d of [a, b]) {
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    assumeAssigned(d.round, rid, c.nodes);
  }
  return {
    a, get b() { return b; }, ports, c, rid,
    async downB() { await b.close(); },
    async upB() { b = await mk(1, bPort); wire(); },
    async close() { try { await a.close(); } catch { /* down */ } try { await b.close(); } catch { /* down */ } },
  };
}

/** The player: dealt 2 of 2, joined, its hold issued and seen at both signer nodes; two different on-time first marks. */
async function joinWithTwoFirstMarks(w) {
  const preimage = secretScalar();
  const e = rand(32);
  const session = ed25519.utils.randomSecretKey();
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: LOSER.key,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const entry = {
    roundId: w.rid, playerPubkey: LOSER.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: LOSER.worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    claimKeyAttestationRef: new Uint8Array(32),
  };
  const eid = entryId(entry);
  for (const d of [w.a, w.b]) {
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const joined = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    assert.equal(joined.status, 201, await joined.text());
    assert.equal((await fetch(`${base}/invoice?entry=${toHex(eid)}`)).status, 200);
    const seen = await fetch(`${base}/stake?entry=${toHex(eid)}`);
    assert.equal(seen.status, 200, await seen.text());
  }
  const sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
  const firstAt = (tick) => {
    const st = init(seedWordForEntry(entry, RANDOMNESS));
    for (let t = 0; t < tick; t++) step(st, ...wordsAt(t));
    const b = { roundId: w.rid, entryId: eid, previousHash: GENESIS_HASH, firstTick: 0,
      ticks: Array.from({ length: tick }, (_, t) => wordsAt(t)), liquidations: [] };
    const m = { roundId: w.rid, entryId: eid, tick, stateHash: Uint8Array.from(stateHash(st).match(/../g).map((x) => parseInt(x, 16))),
      inputChainHash: batchId(b), previousHash: NO_PREVIOUS, sessionPubkey: entry.sessionPubkey };
    return [encodeInputBatch(b), sign(m)];
  };
  return { eid, paymentHash: toHex(sha256(preimage)), first: firstAt(60), other: firstAt(30) };
}

test('two first marks on a Lightning hold, beside a winner: FORFEIT at both signer nodes with no signed result, and the hold is SETTLED into the pool - never cancelled, never left to expire to the player', slice2(), async () => {
  const w = await twoSignerNodesOnHolds();
  try {
    const run = await joinWithTwoFirstMarks(w);
    await w.downB();
    const saidA = [];
    for (const m of run.first) saidA.push(answer(await say(w.a.port, m)));   // on time, to A only (B down)
    await w.upB();
    const saidB = [];
    for (const m of run.other) saidB.push(answer(await say(w.b.port, m)));   // a different on-time first mark, to B
    await wait(1000);
    const before = { saidA, saidB, proof: [w.a, w.b].map((d) => d.round.equivocation(w.rid, run.eid).length) };
    const winner = await joinAndPlay([w.a, w.b], w.c, w.rid, WINNER, 2);
    const winnerHash = toHex(sha256(winner.preimage));
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    const decided = () => [w.a, w.b].every((d) => d.round.noQuorum(run.eid) && resultFinality(d.round, w.rid, winner.eid).state === 'FINAL');
    for (let t = Date.now(); Date.now() - t < 20000 && !decided(); await wait(200));
    const movedW = () => w.ports.some((p) => [...p.settled, ...p.cancelled].some((s) => s.paymentHash === run.paymentHash));
    const movedWinner = () => w.ports.some((p) => [...p.settled, ...p.cancelled].some((s) => s.paymentHash === winnerHash));
    for (let t = Date.now(); Date.now() - t < 15000 && !(movedW() && movedWinner()); await wait(200));
    await wait(1000);
    const at = (d) => {
      const nq = d.round.noQuorum(run.eid);
      return { noQuorum: nq ? nq.outcome : null, finality: resultFinality(d.round, w.rid, run.eid).state,
        results: d.round.results(w.rid, run.eid).length, proof: d.round.equivocation(w.rid, run.eid).length };
    };
    const count = (list, hash) => w.ports.map((p) => p[list].filter((s) => s.paymentHash === hash).length);
    const facts = {
      before, a: at(w.a), b: at(w.b),
      hold: { settledAtAB: count('settled', run.paymentHash), cancelledAtAB: count('cancelled', run.paymentHash) },
      winner: { results: [...new Set(w.a.round.results(w.rid, winner.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body).outcome))],
        finality: [w.a, w.b].map((d) => resultFinality(d.round, w.rid, winner.eid).state),
        settledAtAB: count('settled', winnerHash), cancelledAtAB: count('cancelled', winnerHash) },
      mayRelease: [w.a, w.b].map((d) => { const m = d.preimages.mayRelease(w.rid, run.eid); return m.ok ? `ok ${m.outcome}` : m.why.slice(0, 80); }),
    };
    // THE MONEY'S END AT EACH SIGNER NODE: the payout table's row for the winner (its
    // own net stake back plus the pool) and the payout's state - the settled
    // stake must reach the winner, not stay with the operator.
    const winnerKey = toHex(WINNER.key);
    facts.payout = await Promise.all([w.a, w.b].map(async (d) => {
      const m = await d.stakes();
      const row = ((m.table && m.table.table) || []).find((r) => toHex(r.pubkey) === winnerKey);
      return { ok: m.ok, why: m.ok === false ? String(m.why).slice(0, 80) : null, pool: m.table ? String(m.table.pool) : null,
        winnerMsat: row ? String(row.amountMsat) : null, owed: m.owed ? (m.owed.ok ? m.owed.state : String(m.owed.why).slice(0, 80)) : null };
    }));
    console.log('  FACTS (two first marks on a hold):', JSON.stringify(facts));
    const bigs = (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v).slice(0, 16) : v);
    console.log('  STAKES AT A:', JSON.stringify(await w.a.stakes(), bigs).slice(0, 2400));
    for (const [i, p] of facts.payout.entries())
      assert.equal(p.winnerMsat, String(2n * (STAKE - entryFeeMsat(STAKE))),
        `signer node ${'AB'[i]}'s payout table does not hand the winner its own net stake plus the forfeited one: ${JSON.stringify(p)}`);
    for (const s of ['a', 'b']) {
      assert.equal(facts[s].noQuorum, 'FORFEIT', `${s} did not decide FORFEIT: ${JSON.stringify(facts[s])}`);
      assert.equal(facts[s].results, 0, `${s} signed a result for a run no quorum ever carried`);
    }
    assert.deepEqual(facts.winner.finality, ['FINAL', 'FINAL'], 'the winner is not FINAL at both signer nodes');
    assert.deepEqual(facts.hold.cancelledAtAB, [0, 0], 'the two-first-marks hold was cancelled back to the player');
    assert.ok(facts.hold.settledAtAB.some((n) => n > 0), 'no signer node settled the two-first-marks hold into the pool: it expires to the player');
    assert.deepEqual(facts.winner.settledAtAB, [0, 0], 'the winner\'s own hold was settled');
    assert.ok(facts.winner.cancelledAtAB.some((n) => n > 0), 'the winner\'s hold was not cancelled back to it');
  } finally { await w.close(); }
});

// A SIGNER NODE THAT STAYS DOWN (M3.3-34, the hole named after path 3): the same two
// first marks, the winner beside - and signer node B goes down before the close and
// stays down through the hold's expiry. Ruled: the down signer node must not return the
// stake; two first marks is FORFEIT, the hold settled into the pool, never left
// to expire back to the player. (The fake port has no clock: a hold neither
// settled nor cancelled here is one lnd hands back to the player at its expiry.)
test('two first marks on a hold, and signer node B down from before the close through the hold\'s expiry: the stake is settled into the pool, never left to expire back to the player', slice2(), async () => {
  const w = await twoSignerNodesOnHolds();
  try {
    const run = await joinWithTwoFirstMarks(w);
    await w.downB();
    for (const m of run.first) await say(w.a.port, m);                       // on time, to A only (B down)
    await w.upB();
    for (const m of run.other) await say(w.b.port, m);                       // a different on-time first mark, to B
    await wait(1000);
    const winner = await joinAndPlay([w.a, w.b], w.c, w.rid, WINNER, 2);
    const winnerHash = toHex(sha256(winner.preimage));
    const before = { proof: [w.a, w.b].map((d) => d.round.equivocation(w.rid, run.eid).length) };
    await w.downB();                                                          // B unreachable from here through the expiry
    assert.equal(await say(w.a.port, `close ${toHex(w.rid)}`), 'closed');
    await wait(3 * WINDOW + 3000);                                            // three result windows
    for (let t = Date.now(); Date.now() - t < 10000
      && !w.ports[0].settled.some((s) => s.paymentHash === run.paymentHash); await wait(200));
    const count = (list, hash) => w.ports.map((p) => p[list].filter((s) => s.paymentHash === hash).length);
    const nq = w.a.round.noQuorum(run.eid);
    const opened = await w.a.preimages.open({ roundId: w.rid, entryId: run.eid, needed: 2 });
    const m = await w.a.stakes();
    const row = ((m.table && m.table.table) || []).find((r) => toHex(r.pubkey) === toHex(WINNER.key));
    const rowOf = (d) => { const h = d.round.hold(run.eid); return h ? h.state : null; };
    const facts = {
      before,
      a: { noQuorum: nq ? nq.outcome : null, finality: resultFinality(w.a.round, w.rid, run.eid).state,
        results: w.a.round.results(w.rid, run.eid).length, proof: w.a.round.equivocation(w.rid, run.eid).length,
        opensPreimage: opened.ok ? 'OPENED' : String(opened.why).slice(0, 120) },
      hold: { settledAtAB: count('settled', run.paymentHash), cancelledAtAB: count('cancelled', run.paymentHash), custodyRows: [rowOf(w.a), rowOf(w.b)] },
      winnerHold: { settledAtAB: count('settled', winnerHash), cancelledAtAB: count('cancelled', winnerHash) },
      tableAtA: { ok: m.ok, why: m.ok === false ? String(m.why).slice(0, 100) : null, pool: m.table ? String(m.table.pool) : null,
        winnerMsat: row ? String(row.amountMsat) : null, owed: m.owed ? (m.owed.ok ? m.owed.state : String(m.owed.why).slice(0, 80)) : null },
    };
    console.log('  FACTS (two first marks on a hold, B down through the expiry):', JSON.stringify(facts));
    assert.equal(facts.a.results, 0, 'A signed a result for a run no quorum ever carried');
    assert.deepEqual(facts.hold.cancelledAtAB, [0, 0], 'the two-first-marks hold was cancelled back to the player');
    assert.equal(facts.hold.settledAtAB[0], 1, `A did not settle the two-first-marks hold: it expires back to the player - ${JSON.stringify(facts.a)}`);
    assert.equal(facts.hold.custodyRows[0], 'SETTLED', 'A\'s custody row is not SETTLED');
    assert.equal(facts.a.noQuorum, 'FORFEIT', `A did not decide FORFEIT with B down: ${JSON.stringify(facts.a)}`);

    // THE TWO RESIDUALS (does either hand the stake back?): B comes back, with
    // its custody row still HELD and A's settled stake waiting on B's payout
    // signature. Measured: what B decides, what it tells its Lightning to do with
    // the two-first-marks hold, and what A's payout is then.
    await w.upB();
    for (let t = Date.now(); Date.now() - t < 15000 && !w.b.round.noQuorum(run.eid); await wait(200));
    await wait(3000);
    const nqB = w.b.round.noQuorum(run.eid);
    const back = {
      b: { noQuorum: nqB ? nqB.outcome : null, results: w.b.round.results(w.rid, run.eid).length, custodyRow: rowOf(w.b) },
      hold: { settledAtAB: count('settled', run.paymentHash), cancelledAtAB: count('cancelled', run.paymentHash) },
      owedAtA: await w.a.stakes().then((x) => (x.owed ? (x.owed.ok ? x.owed.state : String(x.owed.why).slice(0, 80)) : null)),
    };
    console.log('  FACTS (B back after A settled):', JSON.stringify(back));
    assert.deepEqual(back.hold.cancelledAtAB, [0, 0], 'a signer node cancelled the two-first-marks hold back to the player once B was back');
    assert.notEqual(back.b.noQuorum, 'VOID', 'B came back and voided the entry');
  } finally { await w.close(); }
});

/** Why this test does not run in Step 1 of the THRESHOLD_LN disposal (see TASKBOOK). */
function slice2() { return { skip: "slice 2: the subject is the hold path (hold invoices on a Lightning port). It still runs at HEAD on a FEDERATION round given a Lightning port, so it is skipped, not moved to FEDERATION (RULED 2026-09-23); slice 2 deletes this test with the code" }; }
