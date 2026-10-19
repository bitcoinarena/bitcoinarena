// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OBJECTION WINDOW IS EXACTLY 600 s OF WALL TIME FROM THE ROUND'S END (§13A, WINDOW-10-SPEC, RULED 2026-10-01).
//
// Measured on one daemon of a seven-seat round (sevenSignerNodes: the holder, and six keys this test signs with), its
// round's end put a few seconds ahead (presentDay), on the fixtures' clock that skips (test-clock.js) - no test waits ten
// real minutes. What the accepted plan names:
//   1. a contract whose window is not 600000 ms is refused at open, list and entry; 600000 opens;
//   2. the window is 600000 ms with no block for 30 minutes and with fast blocks; FINAL is signed by 5 of 7 only from
//      end + 605 s, four signatures are not FINAL, five are, and a signature from a fast clock is not counted;
//   3. an objection received at end + 604.9 s suspends; at end + 605.1 s it does not, and it is filed for slashing;
//   4. re-run windows chain from end + 600 s: objections at + 30 s and + 590 s both close theirs at + 1200 s; an agreed
//      re-run is FINAL from + 1805 s; no re-run threshold by + 1205 s is VOID; a valid objection to the re-run is VOID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { resultFinality } from '../src/finality.js';
import { b32, rand, wait, sevenSignerNodes, object, contractFor, presentDay, WINDOW_MS } from './window-fixture.js';
import { testNow, skipTo } from './test-clock.js';
import { blockClock } from './block-clock.js';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { roundEndMs } from '../../arena-protocol/src/first-mark.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeRerunResult, splitSignedRerun, runOf } from '../../arena-protocol/src/rerun.js';
import { splitSignedResult, decodePlayerResult } from '../../arena-protocol/src/result.js';
import { HOSTED } from './plugins/hosted.js';

const S = 1000n;
const big = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? String(v) : v));
const stateOf = (w, eid, now) => resultFinality(w.holder.round, w.rid, eid, now === undefined ? {} : { now: Number(now) });
/** The holder's own FINAL signature, asked for as a peer asks (GET /final-sig) and handed back to it (POST). */
async function holderSigns(w, eid) {
  const q = `round=${toHex(w.rid)}&entry=${toHex(eid)}`;
  const got = await fetch(`http://127.0.0.1:${w.holder.port}/final-sig?${q}`);
  if (got.status !== 200) return `${got.status} ${await got.text()}`;
  const back = await fetch(`http://127.0.0.1:${w.holder.port}/final-sig?${q}`, { method: 'POST', body: new Uint8Array(await got.arrayBuffer()) });
  return `${back.status} ${await back.text()}`;
}
async function holdersRerun(w, eid, ms = 15000) {
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(100)) {
    const own = w.holder.round.reruns(w.rid, eid).find((r) => toHex(r.signerNodePubkey) === toHex(w.holder.round.pubkey));
    if (own) return decodeRerunResult(splitSignedRerun(own.bytes).body);
  }
  return null;
}
const roundAhead = () => sevenSignerNodes(WINDOW_MS, undefined, { endMs: testNow() + 4000 });

test('1. a contract whose window is 0, 599999 or 600001 ms is refused at open, list and entry; 600000 opens and is listed', async () => {
  const slot = bondedChainSlot(lockPort());
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, funded: () => true, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  const base = `http://127.0.0.1:${d.port}`;
  try {
    const now = BigInt(Date.now());
    const round = (objectionWindowMs) => {
      const c = { ...contractFor([d.round.pubkey, b32(0x33)], 0n, [base]), committeeTimeMs: now - 1000n, startTimeMs: now + 59000n,
        entryCloseMs: now + 179000n, stakeMsat: 0n, objectionWindowMs };
      return { ...c, censusRoot: bondedChainFor(c.nodes, c, slot, { endpoints: [`ws://127.0.0.1:${d.port}`] }).censusRoot };
    };
    const facts = { open: {} };
    for (const w of [0n, 599999n, 600001n, 600000n]) {
      const r = await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(round(w)) });
      facts.open[String(w)] = `${r.status} ${(await r.text()).slice(0, 90)}`;
    }
    // A ROUND HELD FROM BEFORE THE RULE (written past the door, as an old store holds one): never listed, never entered.
    const held = round(599999n);
    d.round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, ?, ?)')
      .run(roundId(held), encodeRoundContract(held), d.round.get(roundId(round(600000n))).state, Date.now());
    const listed = (await (await fetch(`${base}/rounds`)).json()).rounds.map((x) => x.id);
    facts.listed = { good: listed.includes(toHex(roundId(round(600000n)))), held: listed.includes(toHex(roundId(held))) };
    try { d.round.enter({ roundId: roundId(held) }); facts.entry = 'taken'; } catch (e) { facts.entry = e.message.slice(0, 90); }
    console.log('  FACTS (1):', big(facts));
    for (const w of ['0', '599999', '600001']) assert.match(facts.open[w], new RegExp(`objection window is ${w}ms: the objection window is exactly 600000ms`));
    assert.match(facts.open['600000'], /^201 /);
    assert.deepEqual(facts.listed, { good: true, held: false });
    assert.match(facts.entry, /objection window is 599999ms: the objection window is exactly 600000ms/);
  } finally { await d.close(); }
});

test('2. the window is 600000 ms from the round\'s end with no block for 30 minutes and with fast blocks; FINAL is 5 of 7 signatures from end + 605 s, four are not, a fast clock is not counted', async () => {
  const w = await roundAhead();
  try {
    w.sign('agrees', () => ({}));
    const eid = w.runs.agrees.eid;
    const E = roundEndMs(w.contract);
    const s = stateOf(w, eid);
    assert.equal(s.state, 'PROVISIONALLY_FINAL', s.why);
    assert.equal(s.windowOpenMs, E, 'the window does not open at the round\'s end');
    assert.equal(s.windowCloseMs - s.windowOpenMs, 600000n, 'the window is not 600000 ms');
    // NO BLOCK FOR 30 MINUTES, AND FAST BLOCKS: the chain this seat reads changes nothing about when FINAL may be signed.
    const realView = w.holder.round.chainView;
    const fast = blockClock({ spacingS: 1, startS: Math.floor(Number(E) / 1000) });
    const chains = {
      none: function noBlocks() { return { firstHeight: 500000, blocks: [], pending: false }; },
      fast: function fastBlocks() { return fast.viewAt(Number(E) + 3600 * 1000); },      // an hour of blocks already
    };
    const per = {};
    for (const [name, view] of Object.entries(chains)) {
      w.holder.round.chainView = view;
      per[name] = { at604999: stateOf(w, eid, E + 604999n).signable ? 'signable' : 'not',
        at605000: stateOf(w, eid, E + 605000n).signable ? 'signable' : 'not',
        at1800000: stateOf(w, eid, E + 1800000n).signable ? 'signable' : 'not',
        lengthMs: String(stateOf(w, eid, E + 1800000n).windowCloseMs - stateOf(w, eid, E + 1800000n).windowOpenMs) };
    }
    w.holder.round.chainView = realView;
    const heightAt = (ms) => { const v = realView.call({ now: () => Number(ms) }); return v.firstHeight + v.blocks.length - 1; };
    console.log('  FACTS (2, window):', big({ openMs: E, closeMs: s.windowCloseMs, endMinusOpen: s.windowCloseMs - s.windowOpenMs,
      blockAtOpen: heightAt(E), blockAtClose: heightAt(E + 600000n), per }));
    for (const name of Object.keys(chains))
      assert.deepEqual(per[name], { at604999: 'not', at605000: 'signable', at1800000: 'signable', lengthMs: '600000' }, name);

    // BEFORE end + 605 s NO SEAT SIGNS: the holder refuses, and a signature dated before final_after is not counted.
    skipTo(Number(E + 604000n));
    const early = { holder: await holderSigns(w, eid), others: await w.finalBy('agrees', 5) };
    assert.match(early.holder, /^409 the objection window closes at/);
    assert.ok(early.others.every((x) => /^409 .*before the window's final_after/.test(x)), big(early.others));
    assert.equal(stateOf(w, eid).state, 'PROVISIONALLY_FINAL');

    skipTo(Number(E + 605000n) + 50);
    const four = { holder: await holderSigns(w, eid), others: await w.finalBy('agrees', 3) };
    const atFour = stateOf(w, eid);
    // ONE SEAT WITH A CLOCK 20 s FAST: its signature does not count, and is kept as evidence against it.
    const [fastClock] = await w.finalBy('agrees', 1, { keys: w.others.slice(3, 4), signedAtMs: testNow() + 20000 });
    const atFast = stateOf(w, eid);
    const [fifth] = await w.finalBy('agrees', 1, { keys: w.others.slice(4, 5) });
    const atFive = stateOf(w, eid);
    console.log('  FACTS (2, FINAL):', big({ early, four, atFour: [atFour.state, atFour.finalSigs], fastClock, atFast: [atFast.state, atFast.finalSigs],
      evidence: w.holder.round.finalSigEvidence(w.rid, eid).map((x) => x.why.slice(0, 80)), fifth, atFive: [atFive.state, atFive.finalSigs, atFive.why] }));
    assert.match(four.holder, /^201 kept/);
    assert.equal(atFour.state, 'PROVISIONALLY_FINAL', 'four signatures made it FINAL');
    assert.deepEqual(atFour.finalSigs, { signed: 4, needed: 5 });
    assert.match(fastClock, /^409 .*outside the 5 s tolerance/);
    assert.deepEqual(atFast.finalSigs, { signed: 4, needed: 5 }, 'the fast clock\'s signature was counted');
    assert.equal(w.holder.round.finalSigEvidence(w.rid, eid).filter((x) => /tolerance/.test(x.why)).length, 1);
    assert.equal(atFive.state, 'FINAL', atFive.why);
    assert.deepEqual(atFive.finalSigs, { signed: 5, needed: 5 });
  } finally { await w.close(); }
});

test('3. an objection received at end + 604.9 s suspends the run and no FINAL is signed; one at end + 605.1 s does not, and it is filed for slashing', async () => {
  const w = await roundAhead();
  try {
    const rewrite = (r) => ({ score: r.score + 1 });
    w.sign('agrees', rewrite);
    w.sign('dissents', rewrite);
    const E = roundEndMs(w.contract);
    skipTo(Number(E + 604900n));
    const inTime = await object(w, w.runs.agrees.eid);
    const a = stateOf(w, w.runs.agrees.eid);
    skipTo(Number(E + 605100n));
    const late = await object(w, w.runs.dissents.eid);
    const d = stateOf(w, w.runs.dissents.eid);
    // EVERY OTHER SEAT SIGNS FINAL ON BOTH: the suspended one stays suspended here, the other becomes FINAL.
    const signedA = await w.finalBy('agrees', 5);
    await w.finalBy('dissents', 4);
    // THE HOLDER'S OWN WATCH SIGNS, GATHERS AND - THE RUN FINAL - FILES THE LATE OBJECTION BY ITSELF.
    for (const stop = Date.now() + 20000; Date.now() < stop && !w.holder.round.slashProofs(w.rid, w.runs.dissents.eid).length; await wait(200));
    const after = { agrees: stateOf(w, w.runs.agrees.eid), dissents: stateOf(w, w.runs.dissents.eid) };
    const filed = w.holder.round.slashProofs(w.rid, w.runs.dissents.eid).length;
    console.log('  FACTS (3):', big({ inTime: inTime.status, atInTime: [a.state, a.filedAtMs - Number(E)], late: late.status,
      atLate: [d.state, d.lateObjection], holderSignsA: await holderSigns(w, w.runs.agrees.eid), signedA: signedA.slice(0, 1),
      after: { agrees: after.agrees.state, dissents: [after.dissents.state, after.dissents.lateObjection, after.dissents.finalSigs] }, filed }));
    assert.equal(a.state, 'SUSPENDED', a.why);
    assert.ok(a.filedAtMs - Number(E) >= 604900 && a.filedAtMs - Number(E) < 605000, 'the objection was not placed by its arrival on this seat\'s clock');
    assert.equal(after.agrees.state, 'SUSPENDED', 'an objection in time did not keep the run from FINAL');
    assert.equal(d.state, 'PROVISIONALLY_FINAL', 'a late objection suspended the run');
    assert.equal(d.lateObjection, true);
    assert.equal(after.dissents.state, 'FINAL', after.dissents.why);
    // FILED AGAINST THE SIGNERS (5A.3B step 1), by the holder itself once the run was FINAL.
    // filed one signer after another once FINAL lands, so read until all five are in (measured under load: 2, then 5)
    let proofs = 0;
    for (const stop = Date.now() + 15000; Date.now() < stop && (proofs = w.holder.round.slashProofs(w.rid, w.runs.dissents.eid).length) < 5;) await wait(200);
    console.log('  FACTS (3, slash):', big({ proofs }));
    assert.ok(proofs >= 5, `the late objection was not filed against the five signers: ${proofs} proof(s)`);
  } finally { await w.close(); }
});

test('4. re-run windows chain from end + 600 s: objections at + 30 s and + 590 s both close theirs at + 1200 s; an agreed re-run is FINAL from + 1805 s; no threshold by + 1205 s is VOID', async () => {
  const w = await roundAhead();
  try {
    const rewrite = (r) => ({ score: r.score + 1 });
    w.sign('agrees', rewrite);
    w.sign('dissents', rewrite);
    const E = roundEndMs(w.contract);
    skipTo(Number(E + 30000n));
    assert.equal((await object(w, w.runs.agrees.eid)).status, 201);
    skipTo(Number(E + 590000n));
    assert.equal((await object(w, w.runs.dissents.eid)).status, 201);
    const a = stateOf(w, w.runs.agrees.eid);
    const d = stateOf(w, w.runs.dissents.eid);
    assert.deepEqual([a.state, d.state], ['SUSPENDED', 'SUSPENDED']);
    // 'agrees': the holder re-runs by itself, and four seats agree with it - inside the re-run window.
    assert.ok(await holdersRerun(w, w.runs.agrees.eid), 'the holder never re-ran');
    w.rerunBy('agrees', 4);
    const agreed = stateOf(w, w.runs.agrees.eid);
    // 'dissents': three re-runs only (and the holder's own).
    w.rerunBy('dissents', 3);
    skipTo(Number(E + 1204000n));
    const before = stateOf(w, w.runs.dissents.eid);
    skipTo(Number(E + 1205000n) + 50);
    const voided = stateOf(w, w.runs.dissents.eid);
    const notYet = { at1804: stateOf(w, w.runs.agrees.eid, E + 1804999n), holder: null };
    skipTo(Number(E + 1805000n) + 50);
    const rerunRun = fromHex(agreed.rerun.runId);
    await holderSigns(w, w.runs.agrees.eid);
    await w.finalBy('agrees', 4, { run: rerunRun });
    const fin = stateOf(w, w.runs.agrees.eid);
    console.log('  FACTS (4):', big({ rerunClose: { agrees: a.rerunWindowCloseMs - E, dissents: d.rerunWindowCloseMs - E },
      agreed: [agreed.state, agreed.ownWindowOpenMs - E, agreed.ownWindowCloseMs - E, agreed.finalAfterMs - E],
      dissentsAt1204: before.state, dissentsAt1205: [voided.state, voided.why.slice(0, 100)],
      agreesAt1804: [notYet.at1804.state, !!notYet.at1804.signable], agreesFinal: [fin.state, fin.finalSigs, fin.runId === agreed.rerun.runId] }));
    assert.equal(a.rerunWindowCloseMs - E, 1200000n, 'the re-run window of the + 30 s objection does not close at + 1200 s');
    assert.equal(d.rerunWindowCloseMs - E, 1200000n, 'the re-run window of the + 590 s objection does not close at + 1200 s');
    assert.equal(agreed.state, 'PROVISIONALLY_FINAL', agreed.why);
    assert.deepEqual([agreed.ownWindowOpenMs - E, agreed.ownWindowCloseMs - E, agreed.finalAfterMs - E], [1200000n, 1800000n, 1805000n]);
    assert.equal(before.state, 'SUSPENDED', 'decided before + 1205 s');
    assert.equal(voided.state, 'VOID', voided.why);
    assert.equal(notYet.at1804.signable, undefined, 'the re-run was signable before + 1805 s');
    assert.equal(fin.state, 'FINAL', fin.why);
    assert.equal(fin.runId, agreed.rerun.runId, 'FINAL is not on the agreed re-run');
  } finally { await w.close(); }
});

test('4b. a valid objection to the agreed re-run, received before end + 1805 s, makes the entry VOID at once', async () => {
  const w = await roundAhead();
  try {
    w.sign('dissents', (r) => ({ score: r.score + 1 }));
    const eid = w.runs.dissents.eid;
    const E = roundEndMs(w.contract);
    skipTo(Number(E + 60000n));
    assert.equal((await object(w, eid)).status, 201);
    assert.ok(await holdersRerun(w, eid), 'the holder never re-ran');
    // FIVE SEATS AGREE ON A RE-RUN THE HOLDER'S OWN REPLAY CONTRADICTS: the second objection holds.
    w.rerunBy('dissents', 5, { over: { score: 7 } });
    const agreed = stateOf(w, eid);
    assert.equal(agreed.state, 'PROVISIONALLY_FINAL', agreed.why);
    skipTo(Number(E + 1500000n));
    const second = await object(w, eid);
    const after = stateOf(w, eid);
    console.log('  FACTS (4b):', big({ agreed: agreed.state, second: second.status, after: [after.state, after.secondObjection, after.why.slice(0, 120)] }));
    assert.equal(second.status, 201);
    assert.equal(after.state, 'VOID', after.why);
    assert.equal(after.secondObjection, true);
  } finally { await w.close(); }
});

// WINDOW-LIVE-1155 (2026-10-02: "The measured rounds that stayed PROVISIONALLY_FINAL are not done"): a seat that held
// no valid objection and whose run never reached five FINAL signatures decides §13C at the re-run window's end, once.
test('2b. short of five FINAL signatures at end + 1205 s, a seat that held no objection and signed FINAL itself decides VOID, and a later FINAL signature does not turn it back', async () => {
  const w = await roundAhead();
  try {
    w.sign('agrees', () => ({}));
    const eid = w.runs.agrees.eid;
    const E = roundEndMs(w.contract);
    skipTo(Number(E + 605000n) + 50);
    await holderSigns(w, eid);
    await w.finalBy('agrees', 3);
    const atFour = stateOf(w, eid);
    skipTo(Number(E + 1204000n));
    const before = stateOf(w, eid);
    skipTo(Number(E + 1205000n) + 50);
    const at = stateOf(w, eid);
    const kept = w.holder.round.noQuorum(eid);
    await w.finalBy('agrees', 1, { keys: w.others.slice(4, 5) });
    const after = stateOf(w, eid);
    console.log('  FACTS (2b):', big({ atFour: [atFour.state, atFour.finalSigs], before: before.state, at: [at.state, at.why], kept: kept && kept.outcome, after: after.state }));
    assert.equal(atFour.state, 'PROVISIONALLY_FINAL');
    assert.equal(before.state, 'PROVISIONALLY_FINAL', 'decided before the re-run window\'s end + 5 s');
    assert.equal(at.state, 'VOID', at.why);
    assert.match(at.why, /not FINAL by the re-run window's end/);
    assert.equal(kept && kept.outcome, 'VOID', 'the decision was not written');
    assert.equal(after.state, 'VOID', 'a FINAL signature arriving later turned the decision back');
  } finally { await w.close(); }
});
