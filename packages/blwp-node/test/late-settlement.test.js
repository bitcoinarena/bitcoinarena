// A LATE LOSER'S SECOND SETTLEMENT (§13A; RULED the owner 2026-09-24, slice C3b-1).
//
// The round's one settlement leaves out an entry still in its re-run window (C3a). When that entry then ends FINAL and
// FAILED, or FORFEIT, its lock is claimed in a second transaction of its own - one per (round, entry) - and its net
// stake, less that transaction's own fees, goes to the winners the first transaction paid, by the first table's shares,
// as pre-expired payout contracts to their own lock keys. The first transaction is not touched. A late VOID is never
// claimed (its lock returns at expiry); a late qualifier gets its stake back by its own forfeit and nothing else.
//
// THE FINALITY VIEW IS A TEST AID (`finalityOf`, as `finality.rerunMs` is): two signer nodes that agree on a run cannot
// hold a valid objection against it, so the "still in its re-run window" and the later outcome are handed to both
// signer nodes' settlement here. Everything else - the claim key made between them, the P opened by their shares, the
// federation port that checks every claim and payout - is the lock-round fixture's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultFinality } from '../src/finality.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, proposerOf } from './lock-round-fixture.js';
import { b32, WINNER, LOSER, wait } from './window-fixture.js';
import { lateLockSettlement } from '../../protocol/src/lock-settlement.js';
import { netStakeMsat, FAILED, FORFEIT } from '../../protocol/src/payout.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';
import { sendableInvoiceMsat, lowestLiveGateway } from '../../protocol/src/winnings-send.js';
import { readFileSync, readdirSync } from 'node:fs';

const LATE = { name: 'late', key: b32(6), worldSecret: b32(0xc1), ticks: 1000 };
const key = (o) => `${toHex(o.txid)}:${o.outIdx}`;
const IN_WINDOW = () => ({ state: 'SUSPENDED', why: 'test view: an objection holds it in its re-run window' });

/** A lock round whose settlement left `late` out, settled: the winner paid from the on-time loser alone. */
async function settledWithoutLate({ lateWho = LATE, winnerOnTime = true } = {}) {
  const view = new Map();
  const finalityOf = (round, rid, eid) => (view.has(toHex(eid)) ? view.get(toHex(eid))(round, rid, eid) : resultFinality(round, rid, eid));
  const w = await lockRound({ serveOpts: { finalityOf, finality: { everyMs: 100, lateEveryMs: 200 } } });
  const won = winnerOnTime ? await lockAndPlay(w, WINNER, { address: true }) : null;
  const lost = await lockAndPlay(w, LOSER);
  const late = await lockAndPlay(w, lateWho, lateWho === WINNER ? { address: true } : {});
  view.set(toHex(late.eid), IN_WINDOW);
  // THE OBJECTION, AS STORED: the intake row that makes the entry one to ask about (its validity is the view's).
  for (const d of [w.a, w.b]) d.round.object(w.rid, late.eid);
  await closeRound(w);
  const first = await untilSettled(w);
  return { w, view, won, lost, late, first };
}

const lateRow = (d, w, late) => d.round.lateLockSettlement(w.rid, late.eid);
async function untilLate(w, late, ms = 20000) {
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(200)) {
    const a = lateRow(w.a, w, late); const b = lateRow(w.b, w, late);
    if (a && b && a.state === 'ACCEPTED' && b.state === 'ACCEPTED') return { a, b };
  }
  return { a: lateRow(w.a, w, late), b: lateRow(w.b, w, late) };
}

async function claimedLate(outcome) {
  const { w, view, won, lost, late, first } = await settledWithoutLate();
  try {
    assert.equal(first.state, 'ACCEPTED', first.why);
    assert.equal(w.port.settlements.length, 1);
    const firstSettlement = w.port.settlements[0];
    assert.deepEqual(firstSettlement.claims.filter((c) => c.kind !== 'fee').map((c) => key(c.outpoint)), [key(lost.outpoint)], 'the first settlement did not leave the late lock out');
    assert.equal(w.port.locks.has(key(late.outpoint)), true, 'the late lock was touched by the first settlement');
    const firstPayouts = firstSettlement.payouts.map((p) => [toHex(p.payoutPk), p.msat]);
    // GUARD: STILL IN ITS RE-RUN WINDOW, NO SECOND TRANSACTION.
    const early = await proposerOf(w).settlements.settleLate(w.rid, late.eid);
    assert.equal(early.ok, false);
    assert.match(early.why, /still in its re-run window: no second settlement yet/);
    assert.equal(w.port.settlements.length, 1);

    // NOW IT ENDS: FINAL and FAILED as the store has it, or FORFEIT as §13C says on a proven equivocation.
    if (outcome === FAILED) view.delete(toHex(late.eid));
    else view.set(toHex(late.eid), () => ({ state: FORFEIT, noQuorum: true, why: 'test view: §13C at the re-run window\'s end, the equivocation proven' }));
    const got = await untilLate(w, late);
    const second = w.port.settlements.find((x) => x.claims.some((c) => key(c.outpoint) === key(late.outpoint)));
    const fees = await w.port.fees();
    const shares = w.a.round.lockSettlementShares(w.rid);
    const want = lateLockSettlement({ roundId: w.rid, entryId: late.eid,
      entry: { pubkey: late.entry.playerPubkey, stakeMsat: late.entry.stakeMsat, feeMsat: late.entry.feeMsat, donationMsat: 0n, outcome, score: 0 },
      lock: { outpoint: late.outpoint, amountMsat: netStakeMsat(late.entry), refundPk: refundKeyOf(late.entry.playerPubkey) },
      shares, winnerLocks: new Map([[toHex(won.entry.playerPubkey), { refundPk: refundKeyOf(won.entry.playerPubkey) }]]), fees });
    const facts = {
      states: [got.a && got.a.state, got.b && got.b.state],
      sameTxid: !!(got.a && got.b && got.a.txid === got.b.txid),
      submissions: w.port.settlements.length,
      lateLockGone: !w.port.locks.has(key(late.outpoint)),
      stakeClaims: second ? second.claims.filter((c) => c.kind !== 'fee').map((c) => key(c.outpoint)) : null,
      feeClaims: second ? second.claims.filter((c) => c.kind === 'fee').map((c) => key(c.outpoint)) : null,
      winnerPaid: second ? second.payouts.filter((p) => p.kind !== 'signer node').map((p) => [toHex(p.payoutPk), p.msat]) : null,
      winnerSent: second ? second.payouts.filter((p) => p.kind !== 'signer node').map((p) => !!p.sent) : null,
      signerNodePayouts: second ? second.payouts.filter((p) => p.kind === 'signer node').length : null,
      firstUnchanged: JSON.stringify(w.port.settlements[0].payouts.map((p) => [toHex(p.payoutPk), p.msat]), (k, v) => (typeof v === 'bigint' ? String(v) : v))
        === JSON.stringify(firstPayouts, (k, v) => (typeof v === 'bigint' ? String(v) : v)),
      after: [w.a, w.b].map((d) => d.settlements.lockAfterSettlement(w.rid, late.eid).why),
    };
    console.log(`  FACTS (late ${outcome}):`, JSON.stringify(facts, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    assert.equal(want.ok, true, want.why);
    assert.deepEqual(facts.states, ['ACCEPTED', 'ACCEPTED']);
    assert.equal(facts.sameTxid, true, 'the two signer nodes hold different second settlements');
    assert.equal(facts.submissions, 2, 'not exactly one second transaction');
    assert.equal(facts.lateLockGone, true);
    assert.deepEqual(facts.stakeClaims, [key(late.outpoint)]);
    assert.deepEqual(facts.feeClaims, [key(late.feeOutpoint)], 'the late fee lock was not claimed with it');
    // SENT, NOT COLLECTED (RULED 2026-09-24, slice C3b-2a): exactly the base payout's msat, as an outgoing contract to the
    // winner's invoice refunding to the committee claim key. (C3b-1 paid it by a contract to the winner's own lock key.)
    assert.deepEqual(facts.winnerPaid, want.payouts.map((p) => [toHex(w.claimPk), p.msat]));
    assert.deepEqual(facts.winnerSent, [true], 'the late winner was not paid by a send');
    assert.equal(want.payouts[0].msat, 98000n, 'the late payout on the zero-fee federation is not the whole net stake');
    // THE LATE SEND: invoice = 98000 less the lowest live gateway's own fee; PAID with the invoice's preimage; the first
    // round's send still PAID at attempt 0; the winner paid exactly twice, once per transaction.
    // THE SENDS FOLLOW THE ACCEPTED LATE SETTLEMENT: waited on until both signer nodes hold them PAID, a bounded while.
    for (const stop = Date.now() + 15000; Date.now() < stop; await wait(200)) {
      const rows = [w.a, w.b].map((d) => d.round.lateSendScope(late.eid).sendAttemptsOf(w.rid));
      if (rows.every((r) => r.length && r.every((x) => x.state === 'PAID'))) break;
    }
    const gw = lowestLiveGateway((await w.port.gateways()).gateways);
    const lateRows = [w.a, w.b].map((d) => d.round.lateSendScope(late.eid).sendAttemptsOf(w.rid));
    const firstRows = [w.a, w.b].map((d) => d.round.sendAttemptsOf(w.rid).filter((r) => toHex(r.entryId) === toHex(won.eid)));
    const sendFacts = {
      invoiceMsat: lateRows[0].map((r) => r.invoiceMsat),
      wantInvoiceMsat: sendableInvoiceMsat(98000n, gw.sendFeeDefault),
      latePaid: lateRows.map((rows) => rows.map((r) => `${r.state}:${r.attempt}:${r.preimage && toHex(sha256(Uint8Array.from(Buffer.from(r.preimage, 'hex')))) === r.paymentHash}`)),
      firstPaid: firstRows.map((rows) => rows.map((r) => `${r.state}:${r.attempt}`)),
      paidRowsForWinner: firstRows[0].filter((r) => r.state === 'PAID').length + lateRows[0].filter((r) => toHex(r.entryId) === toHex(won.eid) && r.state === 'PAID').length,
      lateHashIsTheOutput: lateRows[0].length === 1 && second.payouts.some((p) => p.sent && p.sent.paymentHash === lateRows[0][0].paymentHash),
    };
    console.log(`  FACTS (late ${outcome} send):`, JSON.stringify(sendFacts, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    assert.deepEqual(sendFacts.invoiceMsat, [sendFacts.wantInvoiceMsat]);
    // 98000 LESS THE LOWEST LIVE GATEWAY'S OWN FEE (4000 msat + 6000 ppm): the largest invoice whose fee still fits.
    const gwFee = (a) => 4000n + (a * 6000n) / 1000000n;
    const inv = sendFacts.wantInvoiceMsat;
    assert.ok(inv + gwFee(inv) <= 98000n && inv + 1n + gwFee(inv + 1n) > 98000n, `the invoice ${inv} is not 98000 less the gateway's own fee`);
    assert.deepEqual(sendFacts.latePaid, [['PAID:0:true'], ['PAID:0:true']], 'the late send is not PAID with the invoice\'s preimage at both signer nodes');
    assert.deepEqual(sendFacts.firstPaid, [['PAID:0'], ['PAID:0']], 'the first round\'s send changed');
    assert.equal(sendFacts.paidRowsForWinner, 2, 'the winner is not paid exactly twice, once per transaction');
    assert.equal(sendFacts.lateHashIsTheOutput, true, 'the late transaction does not commit to the late plan\'s payment hash');
    assert.ok(facts.signerNodePayouts > 0, 'the late fee lock paid no signer node');
    assert.equal(facts.firstUnchanged, true, 'the first settlement changed');
    assert.deepEqual(facts.after, ['claimed in the round\'s second settlement', 'claimed in the round\'s second settlement']);
    // GUARD: A SECOND ATTEMPT BUILDS NOTHING.
    const again = await proposerOf(w).settlements.settleLate(w.rid, late.eid);
    assert.equal(again.kept, true);
    await wait(600);
    assert.equal(w.port.settlements.length, 2, 'a second attempt submitted again');
    assert.equal(w.a.round.lateSendScope(late.eid).sendAttemptsOf(w.rid).length, 1, 'a second sweep added a second late send row');
  } finally { await w.close(); }
}

test('a late FAILED loser is claimed in its own second transaction, its net stake less the fees paid to the winner the first settlement paid; the first settlement untouched', async () => {
  await claimedLate(FAILED);
});

test('a late FORFEIT (§13C, proven equivocation) is claimed the same way', async () => {
  await claimedLate(FORFEIT);
});

test('a late VOID is not claimed: no second transaction, the lock still held for its player\'s refund at expiry', async () => {
  const { w, view, late, first } = await settledWithoutLate();
  try {
    assert.equal(first.state, 'ACCEPTED', first.why);
    view.set(toHex(late.eid), () => ({ state: 'VOID', noQuorum: true, why: 'test view: §13C at the re-run window\'s end, no quorum' }));
    await wait(1200);                                                          // six sweeps
    const direct = await proposerOf(w).settlements.settleLate(w.rid, late.eid);
    console.log('  FACTS (late VOID):', JSON.stringify({ submissions: w.port.settlements.length, held: w.port.locks.has(key(late.outpoint)), direct: direct.why,
      after: w.a.settlements.lockAfterSettlement(w.rid, late.eid).why }));
    assert.equal(w.port.settlements.length, 1, 'a VOID was claimed');
    assert.equal(w.port.locks.has(key(late.outpoint)), true);
    assert.equal(direct.ok, false);
    assert.match(direct.why, /a late VOID is not claimed: nothing acts, and the lock returns to its player at its expiry/);
    assert.equal(w.a.settlements.lockAfterSettlement(w.rid, late.eid).why, 'VOID: nothing acts, and the lock returns to the player at its expiry');
    assert.equal(lateRow(w.a, w, late), null);
  } finally { await w.close(); }
});

test('a late DELIVERED qualifier is in no second transaction: its stake comes back by its own forfeit, and it takes no share', async () => {
  const { w, view, late, first } = await settledWithoutLate({ lateWho: WINNER, winnerOnTime: false });
  try {
    // With the qualifier left out the first table pays nobody: the on-time loser's lock is not claimed, the fees still are.
    const submissionsBefore = w.port.settlements.length;
    view.delete(toHex(late.eid));                                              // FINAL, DELIVERED, as the store has it
    await wait(1200);
    const direct = await proposerOf(w).settlements.settleLate(w.rid, late.eid);
    const forfeit = await fetch(`http://127.0.0.1:${w.a.port}/forfeit?round=${toHex(w.rid)}&entry=${toHex(late.eid)}`);
    const forfeitSaid = await forfeit.text();
    console.log('  FACTS (late qualifier):', JSON.stringify({ first: first && first.state, submissions: [submissionsBefore, w.port.settlements.length],
      direct: direct.why, forfeit: forfeit.status, after: w.a.settlements.lockAfterSettlement(w.rid, late.eid).why }));
    assert.equal(w.port.settlements.length, submissionsBefore, 'a late qualifier entered a second transaction');
    assert.ok(!w.port.settlements.some((x) => x.claims.some((c) => key(c.outpoint) === key(late.outpoint))), 'the qualifier\'s lock was claimed');
    assert.ok(!w.port.settlements.some((x) => x.payouts.some((p) => p.kind === 'qualifier' && toHex(p.payoutPk) === toHex(refundKeyOf(late.entry.playerPubkey)))),
      'the late qualifier was paid a share');
    assert.equal(direct.ok, false);
    assert.match(direct.why, /a late DELIVERED run is not claimed: a qualifier's stake comes back by its own forfeit - stake back only, no share/);
    assert.equal(forfeit.status, 200, forfeitSaid);
    assert.equal(w.a.settlements.lockAfterSettlement(w.rid, late.eid).why, 'a qualifier: its stake comes back by its own forfeit - stake back only, no share');
  } finally { await w.close(); }
});

// `finalityOf` IS A SERVE TEST AID ONLY (RULED the owner 2026-09-24): in blwp-node/src it is server.js's option, defaulting to
// resultFinality, handed only to the LockSettlement it makes; LockSettlement's own option defaults to resultFinality too;
// main.js - the daemon - never names it, and no other source passes one. A SOURCE-LEVEL PIN, named as such.
test('finalityOf is an option only of server.js and settlement.js, each defaulting to resultFinality, and never named by main.js', () => {
  const dir = new URL('../src/', import.meta.url);
  const naming = readdirSync(dir).filter((f) => f.endsWith('.js') && readFileSync(new URL(f, dir), 'utf8').includes('finalityOf')).sort();
  const server = readFileSync(new URL('server.js', dir), 'utf8');
  const settlement = readFileSync(new URL('settlement.js', dir), 'utf8');
  console.log('  FACTS (finalityOf):', JSON.stringify({ naming }));
  // verify.js names it only as its own local alias of resultFinality itself - an import, not the option.
  assert.deepEqual(naming, ['server.js', 'settlement.js', 'verify.js']);
  const verify = readFileSync(new URL('verify.js', dir), 'utf8');
  assert.match(verify, /import \{ resultFinality as finalityOf \} from '\.\/finality\.js';/);
  assert.equal(/finalityOf\s*[:=]/.test(verify), false, 'verify.js takes or passes a finalityOf of its own');
  assert.match(server, /\n  finalityOf = resultFinality,\n/);
  assert.match(settlement, /finalityOf = resultFinality \} = \{\}\) \{/);
  assert.equal((server.match(/finalityOf/g) || []).length, 3, 'server.js names finalityOf beyond its default, the settle pass and the LockSettlement it makes');
  assert.equal(readFileSync(new URL('main.js', dir), 'utf8').includes('finalityOf'), false);
});
