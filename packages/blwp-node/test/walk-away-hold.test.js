// THE WALK-AWAY ON A LIGHTNING HOLD (§15, §23.2; M3.3-34 walk-away step 7).
//
// A paying round whose stakes are hold invoices: player W's preimage is dealt
// 2 of 2 to both signer nodes, W is joined and its hold is paid and seen at both - and
// W sends nothing at all; P, beside it, delivers. Ruled (2026-09-12): no first
// mark is FORFEIT, score 0, signed by both signer nodes, final 2 of 2 - never a refund.
// On a hold that is §23.2's FAILED / FORFEIT row: once FINAL, the signer nodes release
// their shares and SETTLE W's hold into the pool - never CANCEL it back - while
// the winner's own hold is cancelled back to it (its stake was never at risk).
// MEASURED FIRST, with W alone: FORFEIT/0 FINAL 2 of 2, and no stake moved -
// "the operator would keep 98000 msat: a pool of 98000 against 0 handed out.
// every hold stays in flight and expires to its player" - the rule that a
// round with no qualifier moves nothing, by design; so the settle is measured
// in a round with a winner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { feldmanGroup } from '../src/curve.js';
import { assumeAssigned } from './assignment.js';
import { paidPort, contractFor, say, wait, opts, rand, secretScalar, STAKE, joinAndPlay, WINNER } from './window-fixture.js';
import { encodeRoundContract, roundId, encodeEntryContract, entryId } from '../../protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../protocol/src/shares.js';
import { decodePlayerResult, splitSignedResult } from '../../protocol/src/result.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

const WINDOW = 800;

async function twoSignerNodesOnHolds() {
  const ports = [paidPort(), paidPort()];
  const [a, b] = await Promise.all(ports.map((lightning) =>
    serve(openStore(':memory:'), { port: 0, ...opts, lightning, finality: { everyMs: 100 } })));
  for (const [d, o] of [[a, b], [b, a]]) {
    const there = [`http://127.0.0.1:${o.port}`];
    d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
  }
  const c = contractFor([a.round.pubkey, b.round.pubkey], BigInt(WINDOW), [a, b].map((d) => `http://127.0.0.1:${d.port}`));
  const rid = roundId(c);
  for (const d of [a, b]) {
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(c) })).status, 201);
    assumeAssigned(d.round, rid, c.nodes);
  }
  return { a, b, ports, c, rid, async close() { await a.close(); await b.close(); } };
}

/** W: its preimage dealt 2 of 2, joined, its hold issued and seen at both signer nodes - and nothing sent. */
async function joinWithHold(w) {
  const preimage = secretScalar();
  const e = rand(32);
  const player = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: player,
    ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: [scalarFrom32(rand(32)) % FIELD], needed: 2, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const entry = {
    roundId: w.rid, playerPubkey: player, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()),
    stakeCommitment: sha256(preimage), stakeMsat: STAKE, feeMsat: entryFeeMsat(STAKE), donationMsat: 0n,
    joinTick: 0, worldSecret: rand(32), vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
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
  return { eid, paymentHash: toHex(sha256(preimage)) };
}

test('a walk-away on a Lightning hold, beside a winner, is FORFEIT 0 at both signer nodes, final 2 of 2 - and its hold is SETTLED into the pool, never cancelled back', async () => {
  const w = await twoSignerNodesOnHolds();
  try {
    const run = await joinWithHold(w);
    const winner = await joinAndPlay([w.a, w.b], w.c, w.rid, WINNER, 2);
    const winnerHash = toHex(sha256(winner.preimage));
    await Promise.all([say(w.a.port, `close ${toHex(w.rid)}`), say(w.b.port, `close ${toHex(w.rid)}`)]);
    const final = () => [w.a, w.b].every((d) => [run.eid, winner.eid].every((e) => resultFinality(d.round, w.rid, e).state === 'FINAL'));
    for (let t = Date.now(); Date.now() - t < 20000 && !final(); await wait(200));
    const settledAt = () => w.ports.map((p) => p.settled.filter((s) => s.paymentHash === run.paymentHash).length);
    for (let t = Date.now(); Date.now() - t < 20000 && settledAt().every((n) => n === 0); await wait(200));
    await wait(500);
    const at = (d) => {
      const rs = d.round.results(w.rid, run.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body));
      return { results: [...new Set(rs.map((p) => `${p.outcome}/${p.score}`))], signers: new Set(d.round.results(w.rid, run.eid).map((r) => toHex(r.nodePubkey))).size,
        finality: resultFinality(d.round, w.rid, run.eid).state, entryVoid: !!d.round.entryVoid(run.eid) };
    };
    const winnerAt = (d) => ({ results: [...new Set(d.round.results(w.rid, winner.eid).map((r) => decodePlayerResult(splitSignedResult(r.bytes).body).outcome))],
      finality: resultFinality(d.round, w.rid, winner.eid).state });
    const facts = { a: at(w.a), b: at(w.b), winner: { a: winnerAt(w.a), b: winnerAt(w.b) }, settledAtAB: settledAt(),
      cancelledAtAB: w.ports.map((p) => p.cancelled.filter((s) => s.paymentHash === run.paymentHash).length),
      winnerHold: { settledAtAB: w.ports.map((p) => p.settled.filter((s) => s.paymentHash === winnerHash).length),
        cancelledAtAB: w.ports.map((p) => p.cancelled.filter((s) => s.paymentHash === winnerHash).length) },
      mayRelease: [w.a, w.b].map((d) => { const m = d.preimages.mayRelease(w.rid, run.eid); return m.ok ? `ok ${m.outcome}` : m.why.slice(0, 60); }),
      // WHAT EACH SIGNER NODE'S OWN CUSTODY SAYS about W's hold: the action, its state, and why.
      custody: await Promise.all([w.a, w.b].map(async (d) => {
        const m = await d.stakes();
        const hexOf = (v) => (typeof v === 'string' ? v : v ? toHex(v) : '');
        return (m.actions || []).filter((x) => hexOf(x.entryId) === toHex(run.eid))
          .map((x) => ({ action: x.action, state: x.state, final: x.final, why: String(x.why || '').slice(0, 140) }));
      })) };
    console.log('  FACTS (walk-away on a hold):', JSON.stringify(facts));
    console.log('  STAKES AT A:', JSON.stringify(await w.a.stakes(), (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v).slice(0, 16) : v)).slice(0, 1800));
    for (const s of ['a', 'b']) assert.deepEqual(facts[s], { results: ['FORFEIT/0'], signers: 2, finality: 'FINAL', entryVoid: false }, s);
    assert.deepEqual(facts.cancelledAtAB, [0, 0], 'the hold was cancelled back to the player');
    assert.ok(facts.settledAtAB.some((n) => n > 0), 'no signer node settled the hold into the pool');
    assert.deepEqual(facts.mayRelease, ['ok FORFEIT', 'ok FORFEIT']);
    for (const s of ['a', 'b']) assert.deepEqual(facts.winner[s], { results: ['DELIVERED'], finality: 'FINAL' }, `the winner at ${s}`);
    assert.deepEqual(facts.winnerHold.settledAtAB, [0, 0], 'the winner\'s own hold was settled');
    assert.ok(facts.winnerHold.cancelledAtAB.some((n) => n > 0), 'the winner\'s hold was not cancelled back to it');
  } finally { await w.close(); }
});
