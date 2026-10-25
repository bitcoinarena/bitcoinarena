// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND WHOSE RESULT IS NOT A REPLAY, ON TWO SIGNER NODES AND THE FAKE FEDERATION (§0A.7a; the owner
// 2026-10-07): an attested market's round - entries that back an outcome (`pick`) and play no run, the attestors' outcome
// in through POST /outcome, the pari-mutuel table out of GET /outcome, built by the seats from the picks and the outcome
// with no game code. Nothing moves in this slice: the settlement of an attested round is held.
//   1. the round never reaches the replay code - no worker job, no close queue, no gather, no settlement;
//   2. an attestation one signature short, signed by a key the manifest does not name, made for another round, or with an
//      outcome out of range is refused by name at the seat;
//   3. two standing attestations of different outcomes are held as the proof, and the round settles on neither;
//   4. the table balances to the msat, losers' net stakes to the winners pro rata, fee and donation as.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, openLockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32, LOSER } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame, attestorSign, testDevKey } from './plugins/sign.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId, splitDonation } from '../../arena-protocol/src/donation.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { toHex } from '../../arena-protocol/src/hash.js';

import { MARKET, MARKET_OUTCOMES as OUTCOMES } from './plugins/market/index.js';
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const STAKE = 1_000_000n;
// ITS ENTRIES OPEN FROM THE COMMITTEE UNTIL HALF A SECOND BEFORE ITS START (the fixture's 60.5 s), so a test has time to pick
const ROUND = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
const [A0, A1, A2] = MARKET.attestors;
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x40 + n), worldSecret: b32(0) });
const post = (d, rid, a) => fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`, { method: 'POST', body: encodeAttestation(a) });
const outcome = async (d, rid) => (await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`)).json();
const signedBy = (body, by) => ({ ...body, signatures: by.map((a) => attestorSign(a, body)) });

/** Every worker job a seat is handed, by its key (the replay's only door: verify.js pool.submit). */
function watchReplays(nodes) {
  const jobs = [];
  for (const d of nodes) {
    const submit = d.verifier.pool.submit.bind(d.verifier.pool);
    d.verifier.pool.submit = (job) => { jobs.push(String(job.key)); return submit(job); };
  }
  return jobs;
}

test('an attested round: picks in, no replay, the outcome\'s refusals by name, the pari-mutuel table to the msat, nothing settled; a contradiction is held as proof', async () => {
  // ITS ENTRIES OPEN: the round's end 15 min out and the clock at its committee (slice 2: no pick after the entry close)
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000, serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const jobs = watchReplays(w.nodes);
    const target = { network: NETWORK, game: MARKET.registration.donationSet };
    // FOUR ENTRIES: picks 0, 0, 1, 2 - each its stake lock and its fee lock, which holds the market default's 0.5 % node fee
    // AND 0.5 % donation, both due at resolution (2026-10-09): no donation outputs beside the stake
    const picks = [[0], [0], [1], [2]];
    const entries = [];
    for (const [i, [pick]] of picks.entries()) entries.push(await lockAndPlay(w, player(i), { noMarks: true, pick }));
    // A MARKET ENTRY THAT DONATES AT ENTRY IS REFUSED: its donation is in its fee lock, due at resolution
    await assert.rejects(lockAndPlay(w, player(7), { noMarks: true, pick: 0, donation: { msat: STAKE * 50n / 10000n, target } }),
      /a market's donation is in its fee lock, due at resolution: that entry names a donation of 5000 msat beside it/);
    // AN ENTRY WITHOUT A PICK, OR OUT OF RANGE, IS REFUSED AT THE DOOR
    await assert.rejects(lockAndPlay(w, player(8), { noMarks: true }), /backs one of its outcomes: it carries no pick/);
    await assert.rejects(lockAndPlay(w, player(9), { noMarks: true, pick: 3 }), /picks outcome 3, out of range: game "btc-close" has 3 outcomes/);
    await closeRound(w);

    // CHECK 1: NOTHING OF IT REACHED THE REPLAY CODE
    const rid = toHex(w.rid);
    const gathered = await Promise.all(entries.map((e) => w.a.verifier.gather(w.rid, e.eid)));
    const settled = await w.a.settlements.settle(w.rid);
    const facts1 = { workerJobs: jobs.filter((k) => k.startsWith(rid)).length, closeQueued: w.a.verifier.queued.length,
      gather: gathered[0].why, settle: settled.state, settleWhy: settled.why };
    console.log('  CHECK 1:', JSON.stringify(facts1));
    assert.equal(facts1.workerJobs, 0, 'an attested round was handed to a replay worker');
    assert.equal(facts1.closeQueued, 0);
    assert.ok(gathered.every((g) => g.stored === false && /attested: its result is its attestors' outcome/.test(g.why)));
    assert.equal(settled.state, 'HELD');
    assert.equal((await (await fetch(`http://127.0.0.1:${w.a.port}/replay/core.js?round=${rid}`)).status), 404);

    // CHECK 2: EACH REFUSAL BY NAME, AT BOTH SEATS
    // seen after the round's entries closed (slice 2: an outcome observed before the last pick is refused)
    const body = { roundId: w.rid, outcome: 0, observedAtMs: w.c.entryCloseMs + 1n };
    const stranger = testDevKey('not an attestor of btc-close');
    const cases = {
      'one signature short': signedBy(body, [A1]),
      'a key the manifest does not name': signedBy(body, [A0, stranger]),
      'made for another round': signedBy({ ...body, roundId: b32(0x33) }, [A0, A1]),
      'outcome out of range': signedBy({ ...body, outcome: 3 }, [A0, A1]),
    };
    const refusals = {};
    for (const [name, a] of Object.entries(cases)) {
      const said = await Promise.all(w.nodes.map(async (d) => { const r = await post(d, w.rid, a); return `${r.status} ${await r.text()}`; }));
      refusals[name] = said[0];
      assert.equal(said[0], said[1], `${name}: the two seats answered differently`);
    }
    console.log('  CHECK 2:', JSON.stringify(refusals, null, 1));
    assert.match(refusals['one signature short'], /^409 that attestation carries 1 attestor signature\(s\), and game "btc-close" asks 2 of its 3/);
    assert.match(refusals['a key the manifest does not name'], /^409 that attestation is signed by key [0-9a-f]{16}, which game "btc-close" does not name as an attestor/);
    assert.match(refusals['made for another round'], /^409 that attestation is for round 3333333333333333, not this round/);
    assert.match(refusals['outcome out of range'], /^409 that attestation names outcome 3, out of range: game "btc-close" has 3 outcomes \(0 to 2\)/);
    assert.equal((await outcome(w.a, w.rid)).state, 'OPEN', 'a refused attestation was held');

    // THE OUTCOME: two of three attestors say 0
    for (const d of w.nodes) assert.equal((await post(d, w.rid, signedBy(body, [A0, A2]))).status, 201);
    assert.equal((await post(w.a, w.rid, signedBy(body, [A0, A2]))).status, 200, 'the same attestation twice is held once');

    // CHECK 4: THE TABLE, AT BOTH SEATS, AGAINST THE RULE WRITTEN OUT HERE
    const got = await Promise.all(w.nodes.map((d) => outcome(d, w.rid)));
    assert.deepEqual(got[0].table, got[1].table, 'the two seats built different tables');
    const t = got[0].table;
    const fee = entryFeeMsat(STAKE, 100);
    const net = picks.map(() => STAKE - fee);
    const losing = net[2] + net[3];
    const winning = net[0] + net[1];
    const want = new Map(entries.map((e, i) => [toHex(e.eid), i < 2 ? net[i] + (losing * net[i]) / winning : 0n]));
    let left = losing - [0, 1].reduce((s, i) => s + (losing * net[i]) / winning, 0n);
    for (const id of [...want.keys()].filter((k, i) => i < 2).sort()) if (left > 0n) { want.set(id, want.get(id) + 1n); left--; }
    const rows = t.rows.map((r) => `| ${r.entryId.slice(0, 8)} | ${r.pick} (${OUTCOMES[r.pick]}) | ${r.stakeMsat} | ${r.feeMsat} | ${r.donationMsat} | ${r.netMsat} | ${r.payoutMsat} |`);
    console.log(['  CHECK 4 (outcome 0, "above 100k"):', '| entry | pick | stake | fee | donation | net | payout |', ...rows,
      `| total | | ${t.grossMsat} | ${t.feesMsat} | ${t.donationsMsat} | ${t.poolMsat} | ${t.payoutsMsat} |`].join('\n'));
    assert.equal(got[0].state, 'ATTESTED');
    assert.equal(got[0].label, 'above 100k');
    for (const r of t.rows) assert.equal(BigInt(r.payoutMsat), want.get(r.entryId), `entry ${r.entryId.slice(0, 8)}`);
    assert.equal(BigInt(t.feesMsat) + BigInt(t.donationsMsat) + BigInt(t.payoutsMsat), BigInt(t.grossMsat), 'a msat of the gross went to nobody');
    // THE WALLET'S PENDING LINE READS THE SAME TABLE (2026-10-20: "The pending balance doesn't appear in the wallet but does in
    // the prediction market" - /standing answered a market order as a replay game, "0 of 5 agree on any one run", nothing pending):
    // every entry's /standing at both seats is its table row - a winner's payout, a loser's 0 - provisional until the outcome is final
    // (each seat's final time is its own: 600 s from when IT held the attestation)
    for (const [i, d] of w.nodes.entries()) for (const e of entries) {
      const st = await (await fetch(`http://127.0.0.1:${d.port}/standing?entry=${toHex(e.eid)}`)).json();
      assert.deepEqual([st.state, st.kind, st.pendingMsat, st.provisional, st.windowCloseMs],
        ['ATTESTED', 'payout', String(want.get(toHex(e.eid))), true, got[i].finalAtMs], `entry ${toHex(e.eid).slice(0, 8)}'s pending line`);
    }
    assert.equal(BigInt(t.feesMsat), 4n * fee, 'the fee is not the market\'s 1 % of each stake (0.5 % nodes + 0.5 % donation)');
    assert.equal(BigInt(t.donationsMsat), 0n, 'a market entry donated beside its fee lock');
    assert.deepEqual(entries.map((e) => (e.donated || []).length), [0, 0, 0, 0], 'a market entry made donation outputs at entry');
    // the listing says it too (/api/rounds: upcoming and finished; /rounds carries the same row field while a round is upcoming)
    const listing = await (await fetch(`http://127.0.0.1:${w.a.port}/api/rounds`)).json();
    const row = [...(listing.upcoming || []), ...(listing.finished || [])].find((r) => r.id === rid);
    assert.equal(row && row.outcome && row.outcome.state, 'ATTESTED');
    assert.equal(row.outcome.label, 'above 100k');
    // still nothing settled: slice 2 pays the table
    assert.equal((await w.a.settlements.settle(w.rid)).state, 'HELD');

    // CHECK 3: A SECOND ROUND, TWO STANDING ATTESTATIONS OF DIFFERENT OUTCOMES - THE PROOF, AND NEITHER SETTLES
    const r2 = await openLockRound(w, { stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000 });
    skipTo(Number(r2.c.committeeTimeMs) + 100);
    const two = [];
    for (const [i, pick] of [1, 2].entries()) two.push(await lockAndPlay(r2, player(20 + i), { noMarks: true, pick }));
    // NO PICK ONCE AN OUTCOME IS HELD, even with the entry door still open: it would be a copy, not a pick (an attestation
    // held at a seat whose clock ran ahead of the others' - put straight into its store here, as the door takes none before
    // the entry close)
    w.b.round.putOutcomeAttestation({ bodyId: b32(0x5e), roundId: r2.rid, outcome: 1, observedAtMs: 1n, bytes: encodeAttestation(signedBy({ roundId: r2.rid, outcome: 1, observedAtMs: 1n }, [A0, A1])) });
    await assert.rejects(lockAndPlay(r2, player(27), { noMarks: true, pick: 1 }), /outcome is already attested at this signer node: it takes no pick after it/);
    await closeRound(r2);
    const after = r2.c.entryCloseMs + 1n;
    const said1 = await post(w.a, r2.rid, signedBy({ roundId: r2.rid, outcome: 1, observedAtMs: after }, [A0, A1]));
    const said2 = await post(w.a, r2.rid, signedBy({ roundId: r2.rid, outcome: 2, observedAtMs: after + 1n }, [A1, A2]));
    const disputed = await outcome(w.a, r2.rid);
    const settled2 = await w.a.settlements.settle(r2.rid);
    console.log('  CHECK 3:', JSON.stringify({ first: said1.status, second: said2.status, state: disputed.state, outcomesNamed: disputed.outcomesNamed,
      proof: disputed.proof.length, table: disputed.table === undefined ? 'none' : 'BUILT', settle: settled2.state, why: disputed.why }));
    assert.equal(said1.status, 201);
    assert.equal(said2.status, 201);
    assert.equal(disputed.state, 'DISPUTED');
    assert.deepEqual(disputed.outcomesNamed, [1, 2]);
    assert.equal(disputed.proof.length, 2, 'the two attestations are kept as the proof');
    assert.equal(disputed.table, undefined, 'a disputed round has no table');
    assert.equal(settled2.state, 'VOID', 'a contradiction voids the round: nothing settles, every stake back at once');
    assert.equal(jobs.filter((k) => k.startsWith(toHex(r2.rid))).length, 0);
  } finally { await w.close(); }
});

test('a replayed round takes no pick, and its outcome door is shut', async () => {
  const w = await lockRound({});
  try {
    await assert.rejects(lockAndPlay(w, player(1), { noMarks: true, pick: 0 }), /carries a pick, and its round is a replayed game's/);
    const r = await post(w.a, w.rid, { roundId: w.rid, outcome: 0, observedAtMs: 1n, signatures: [] });
    assert.equal(r.status, 409);
    assert.match(await r.text(), /not an attested game this node hosts/);
  } finally { await w.close(); }
});
