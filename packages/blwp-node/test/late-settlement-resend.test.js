// A LATE WINNING THROUGH A RESTART, AND AFTER ITS CONTRACT EXPIRES (§13A; RULED the owner 2026-09-24, slice C3b-2b).
//
// Split out of late-settlement.test.js so each file runs inside the 180 s cap. The same lock round - a winner who named an
// address, an on-time loser, and a late loser the round's settlement left out while it was in its re-run window - on
// FILE-BACKED stores, as lock-settlement-restart.test.js has them, so a signer node can die and start again on its own
// records. The late sweep is slowed out of the way and every step is driven by the round's asker, so each kill point is
// exactly where the pin says. `finalityOf` is the same test aid as late-settlement.test.js's.
import { CLOCK } from './block-clock.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { resultFinality } from '../src/finality.js';
import { resendNonce } from '../src/winnings-send.js';
import { assumeAssigned } from './assignment.js';
import { lockPort } from './lock-fixture.js';
import { lockAndPlay, closeRound, untilSettled, curve, lnurl } from './lock-round-fixture.js';
import { b32, WINDOW_MS, STAKE, WINNER, LOSER, contractFor, opts, wait } from './window-fixture.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { largestPayoutMsat } from '../../protocol/src/lock-settlement.js';
import { askerOrder } from '../src/payout.js';
import { toHex, sha256 } from '../../protocol/src/hash.js';

const LATE = { name: 'late', key: b32(6), worldSecret: b32(0xc1), ticks: 1000 };
const REAL_FEES = { ppm: 0n, baseMsat: 1000n };
const LOWEST = 'http://gw-a.example/';

/** The lock round on disk, settled without the late loser, the winner's first-round send PAID, the late loser now FAILED. */
async function settledOnDisk() {
  const dir = mkdtempSync(join(tmpdir(), 'late-'));
  const port = lockPort();
  const address = lnurl(port);
  const view = new Map();
  const finalityOf = (round, rid, eid) => (view.has(toHex(eid)) ? view.get(toHex(eid))(round, rid, eid) : resultFinality(round, rid, eid));
  const start = async (name, at = 0) => {
    const d = await serve(openStore(join(dir, `${name}.sqlite`)), { port: at, ...opts, stakeLocks: port, poolCurve: curve,
      finality: { everyMs: 100, lateEveryMs: 3600000 }, lnurlFetch: address.fetchLike, finalityOf });
    d.round.chainView = CLOCK.chainView();
    return d;
  };
  const w = { dir, port, view, lnurl: address, a: await start('a'), b: await start('b') };
  const wire = () => {
    for (const [d, o] of [[w.a, w.b], [w.b, w.a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.payouts.peers = there; d.preimages.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  w.c = { ...contractFor([w.a.round.pubkey, w.b.round.pubkey], BigInt(WINDOW_MS), [w.a, w.b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, minScore: 1, stakeMsat: STAKE };
  w.rid = roundId(w.c);
  for (const d of [w.a, w.b]) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: encodeRoundContract(w.c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, w.rid, w.c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of [w.a, w.b]) await d.dkg.run(w.c.nodes);
  const held = w.a.dkg.signerNodeFor(w.c.nodes);
  assert.equal(held.ok, true, held.why);
  w.claimPk = held.pool.groupPublicKey;
  // STARTED AGAIN ON ITS FILE AND ITS PORT: the kill.
  w.restart = async () => {
    const at = { a: w.a.port, b: w.b.port };
    for (const n of ['a', 'b']) { await w[n].close(); w[n] = null; }
    for (const n of ['a', 'b']) w[n] = await start(n, at[n]);
    wire();
  };
  w.close = async () => { for (const n of ['a', 'b']) if (w[n]) await w[n].close(); rmSync(dir, { recursive: true, force: true }); };
  // THE ROUND'S ASKER, by key, so it is found again after a restart.
  w.asker = () => {
    const keys = [w.a, w.b].map((d) => d.round.pubkey).sort((x, y) => (toHex(x) < toHex(y) ? -1 : 1));
    const first = toHex(askerOrder(w.rid, keys).order[0]);
    return [w.a, w.b].find((d) => toHex(d.round.pubkey) === first);
  };
  w.won = await lockAndPlay(w, WINNER, { address: true });
  w.lost = await lockAndPlay(w, LOSER);
  w.late = await lockAndPlay(w, LATE);
  view.set(toHex(w.late.eid), () => ({ state: 'SUSPENDED', why: 'test view: an objection holds it in its re-run window' }));
  for (const d of [w.a, w.b]) d.round.object(w.rid, w.late.eid);
  await closeRound(w);
  const first = await untilSettled(w);
  assert.equal(first.state, 'ACCEPTED', first.why);
  for (const stop = Date.now() + 15000; Date.now() < stop; await wait(200))
    if ([w.a, w.b].every((d) => d.round.sendAttemptsOf(w.rid).some((r) => r.state === 'PAID'))) break;
  w.firstRows = () => [w.a, w.b].map((d) => d.round.sendAttemptsOf(w.rid).map((r) => `${toHex(r.entryId).slice(0, 8)}:${r.attempt}:${r.state}:${r.paymentHash}`));
  w.firstBefore = JSON.stringify(w.firstRows());
  assert.ok(w.firstBefore.includes(':0:PAID:'), 'the winner\'s first-round send is not PAID');
  view.delete(toHex(w.late.eid));                                            // the late loser is FINAL and FAILED now
  w.lateRows = (d = w.asker()) => d.round.lateSendScope(w.late.eid).sendAttemptsOf(w.rid);
  w.lateSubmissions = () => port.settlements.filter((x) => x.claims.some((c) => toHex(c.outpoint.txid) === toHex(w.late.outpoint.txid))).length;
  w.paidRight = (r) => r.state === 'PAID' && !!r.preimage && toHex(sha256(Uint8Array.from(Buffer.from(r.preimage, 'hex')))) === r.paymentHash;
  return w;
}

// AS THE LATE SWEEP DRIVES IT, a bounded number of passes: right after a restart on the same ports a peer's first answer
// can fail at the connection ("fetch failed"), and the daemon's sweep simply asks again. The passes taken are reported.
async function asTheSweep(fn, done, most = 20) {
  let got; let passes = 0;
  for (; passes < most; passes++) { got = await fn(); if (done(got)) break; await wait(200); }
  return { got, passes: passes + 1 };
}

async function untilPaid(w, attempt, ms = 15000) {
  for (const stop = Date.now() + ms; Date.now() < stop; await wait(200)) {
    const rows = [w.a, w.b].map((d) => w.lateRows(d).find((r) => r.attempt === attempt));
    if (rows.every((r) => r && r.state === 'PAID')) return;
  }
}

test('restart (a): killed after the late plans are proposed and taken, before the late transaction is signed - the kept plan, the same payment hash, is resumed to PAID', async () => {
  const w = await settledOnDisk();
  try {
    const planned = await w.asker().settlements.planLateSends(w.rid, w.late.eid);
    assert.equal(planned.ok, true, planned.why);
    const hashesBefore = [w.a, w.b].map((d) => w.lateRows(d).map((r) => r.paymentHash));
    assert.equal(w.lateSubmissions(), 0);
    await w.restart();                                                        // the kill
    const { got, passes } = await asTheSweep(() => w.asker().settlements.settleLate(w.rid, w.late.eid), (x) => x.state === 'ACCEPTED');
    await untilPaid(w, 0);
    const rows = [w.a, w.b].map((d) => w.lateRows(d));
    console.log('  FACTS (restart a):', JSON.stringify({ settled: got.state, why: got.why, passes, hashesBefore, rows: rows.map((r) => r.map((x) => `${x.attempt}:${x.state}:${x.paymentHash}`)),
      submissions: w.lateSubmissions() }));
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.deepEqual(rows.map((r) => r.map((x) => x.paymentHash)), hashesBefore, 'the kept plan was replaced after the restart');
    assert.deepEqual(rows.map((r) => r.length), [1, 1]);
    assert.ok(rows.every((r) => w.paidRight(r[0]) && r[0].attempt === 0), 'the late send is not PAID with its invoice\'s preimage');
    assert.equal(w.lateSubmissions(), 1);
    assert.equal(JSON.stringify(w.firstRows()), w.firstBefore, 'the first-round send changed');
  } finally { await w.close(); }
});

test('restart (b): killed after the late transaction is ACCEPTED, before the send is paid - the one row is resumed to PAID on the same txid, nothing submitted again', async () => {
  const w = await settledOnDisk();
  try {
    w.port.gatewayDown = LOWEST;                                              // the send does not go through before the kill
    const got = await w.asker().settlements.settleLate(w.rid, w.late.eid);
    assert.equal(got.state, 'ACCEPTED', got.why);
    const txidBefore = w.asker().round.lateLockSettlement(w.rid, w.late.eid).txid;
    const before = w.lateRows().map((r) => `${r.attempt}:${r.state}`);
    await w.restart();                                                        // the kill
    w.port.gatewayDown = null;
    const { got: sent, passes } = await asTheSweep(() => w.asker().settlements.sendLate(w.rid, w.late.eid), (x) => x.some((y) => y.state === 'PAID'));
    await untilPaid(w, 0);
    const rows = [w.a, w.b].map((d) => w.lateRows(d));
    const txidAfter = w.asker().round.lateLockSettlement(w.rid, w.late.eid).txid;
    const rebuilt = await w.asker().settlements.lateMessage(w.rid, w.late.eid);
    console.log('  FACTS (restart b):', JSON.stringify({ before, passes, txidBefore: txidBefore.slice(0, 16), txidAfter: txidAfter.slice(0, 16), rebuilt: rebuilt.txid && rebuilt.txid.slice(0, 16),
      sent: sent.map((x) => x.state || x.why), rows: rows.map((r) => r.map((x) => `${x.attempt}:${x.state}`)), submissions: w.lateSubmissions() }));
    assert.notEqual(before[0], '0:PAID', 'the send was paid before the kill');
    assert.equal(txidAfter, txidBefore);
    assert.equal(rebuilt.txid, txidBefore, 'the late transaction rebuilt after the restart is not the one signed');
    assert.deepEqual(rows.map((r) => r.length), [1, 1]);
    assert.ok(rows.every((r) => w.paidRight(r[0])), 'the late send is not PAID with its invoice\'s preimage');
    assert.equal(w.lateSubmissions(), 1, 'the late transaction was submitted again');
    assert.equal(JSON.stringify(w.firstRows()), w.firstBefore, 'the first-round send changed');
  } finally { await w.close(); }
});

/** The late settlement ACCEPTED, its send through the lowest gateway unpaid, and the federation past that contract's expiration. */
async function expiredLateSend(w) {
  w.port.gatewayDown = LOWEST;
  const got = await w.asker().settlements.settleLate(w.rid, w.late.eid);
  assert.equal(got.state, 'ACCEPTED', got.why);
  const row0 = w.lateRows()[0];
  assert.equal(row0.gatewayUrl, LOWEST);
  w.port.height = Number(row0.expiration) + 1;
  return row0;
}

test('re-send after expiry: attempt 1 through the other gateway to a new invoice, paid; a second re-send adds no row; a late route naming no late settlement is refused by name', async () => {
  const w = await settledOnDisk();
  try {
    const row0 = await expiredLateSend(w);
    const proposed = await w.asker().settlements.sendLate(w.rid, w.late.eid);  // finds attempt 0 expired, proposes attempt 1
    const funded = await w.asker().settlements.sendLate(w.rid, w.late.eid);    // funds attempt 1 and asks its gateway
    await untilPaid(w, 1);
    const rows = [w.a, w.b].map((d) => w.lateRows(d));
    const r1 = rows[0].find((r) => r.attempt === 1);
    const resent = w.port.settlements.find((x) => x.refunds && x.refunds.length && x.payouts.some((p) => p.sent && p.sent.paymentHash === (r1 && r1.paymentHash)));
    const lateNonce = resendNonce({ roundId: w.rid, lateEntryId: w.late.eid, entryId: w.won.eid, attempt: 1 });
    const firstNonce = resendNonce({ roundId: w.rid, entryId: w.won.eid, attempt: 1 });
    console.log('  FACTS (re-send):', JSON.stringify({ proposed: proposed.map((x) => x.resend ?? x.why), funded: funded.map((x) => x.state || x.why),
      rows: rows.map((r) => r.map((x) => `${x.attempt}:${x.state}:${x.gatewayUrl}:${String(x.payoutMsat)}`)),
      resentTo: resent && toHex(resent.payouts[0].payoutPk).slice(0, 16), lateNonce: toHex(lateNonce), firstNonce: toHex(firstNonce) }));
    assert.ok(r1, 'no attempt 1');
    assert.notEqual(r1.gatewayUrl, row0.gatewayUrl, 'the re-send went through the gateway that did not pay');
    assert.notEqual(r1.paymentHash, row0.paymentHash, 'the expired payment hash was reused');
    assert.equal(r1.address, row0.address);
    assert.equal(r1.payoutMsat, 98000n, 'on the zero-fee federation the re-send is not the split');
    assert.equal(r1.payoutMsat, largestPayoutMsat(await w.port.fees(), row0.payoutMsat - 0n));
    assert.ok(resent, 'the re-send transaction was not submitted');
    assert.equal(toHex(resent.payouts[0].payoutPk), toHex(w.claimPk), 'the re-send does not refund to the committee claim key');
    assert.ok(rows.every((r) => w.paidRight(r.find((x) => x.attempt === 1))), 'attempt 1 is not PAID with its invoice\'s preimage at both signer nodes');
    assert.notEqual(toHex(lateNonce), toHex(firstNonce), 'a late re-send shares its nonce with the first round\'s');
    // PIN 4: A SECOND RE-SEND OF ATTEMPT 0 ADDS NO ROW.
    const again = await w.asker().settlements.lateWinningsFor(w.rid, w.late.eid).proposeResend(w.rid, row0,
      await w.asker().settlements.lateMessage(w.rid, w.late.eid));
    assert.deepEqual([w.a, w.b].map((d) => w.lateRows(d).map((r) => r.attempt)), [[0, 1], [0, 1]], `a second re-send added a row (${again.why || 'taken'})`);
    // PIN 5: `late` NAMING NO LATE SETTLEMENT OF THIS ROUND - the winner's own first-round entry - refused by name, nothing stored.
    const firstBefore = JSON.stringify(w.firstRows());
    const base = `http://127.0.0.1:${w.a.port}`;
    const q = `round=${toHex(w.rid)}&late=${toHex(w.won.eid)}`;
    const resendAsk = await fetch(`${base}/resend-sends?${q}`, { method: 'POST', body: JSON.stringify({ entry: toHex(w.won.eid), attempt: 1 }) });
    const commitAsk = await fetch(`${base}/send-commit?${q}&entry=${toHex(w.won.eid)}&kind=auth&attempt=0`, { method: 'POST' });
    const said = [(await resendAsk.text()).trim(), (await commitAsk.text()).trim()];
    assert.deepEqual([resendAsk.status, commitAsk.status], [409, 409]);
    assert.deepEqual(said, ['no late settlement for that entry', 'no late settlement for that entry']);
    assert.deepEqual([w.a, w.b].map((d) => d.round.lateSendScope(w.won.eid).sendAttemptsOf(w.rid).length), [0, 0]);
    assert.equal(JSON.stringify(w.firstRows()), firstBefore);
    assert.equal(JSON.stringify(w.firstRows()), w.firstBefore, 'the first-round send changed');
  } finally { await w.close(); }
});

test('the re-send under the 1000 msat base fee: a 98000 msat expired contract pays exactly largestPayoutMsat(fees, 98000 - 1000), and is paid', async () => {
  const w = await settledOnDisk();
  try {
    const row0 = await expiredLateSend(w);
    assert.equal(row0.payoutMsat, 98000n);
    w.port.feeRule = REAL_FEES;                                                // the federation charges its real fee from here
    await w.asker().settlements.sendLate(w.rid, w.late.eid);
    await w.asker().settlements.sendLate(w.rid, w.late.eid);
    await untilPaid(w, 1);
    const r1 = w.lateRows().find((r) => r.attempt === 1);
    const want = largestPayoutMsat(REAL_FEES, 98000n - 1000n);
    console.log('  FACTS (re-send, 1000 msat fee):', JSON.stringify({ payout: r1 && String(r1.payoutMsat), want: String(want), state: r1 && r1.state }));
    assert.equal(want, 96000n);
    assert.equal(r1.payoutMsat, want);
    assert.ok(w.paidRight(r1), 'attempt 1 is not PAID with its invoice\'s preimage');
  } finally { await w.close(); }
});
