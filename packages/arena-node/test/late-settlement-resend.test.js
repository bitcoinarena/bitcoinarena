// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LATE SETTLEMENT THROUGH A RESTART (§13A; slice C3b-1, and WINNINGS-AUTO, RULED 2026-10-01). Since
// WINNINGS-AUTO a late share is a payout contract to the first winner's own lock key, never a send, so the late send's
// restart and its re-send after expiry (slice C3b-2b) are gone with it; what stands is the late transaction itself
// surviving a kill: settled once, rebuilt the same, never submitted twice.
//
// Split out of late-settlement.test.js so each file runs inside the 180 s cap. The same lock round - a winner who named an
// address, an on-time loser, and a late loser the round's settlement left out while it was in its re-run window - on
// FILE-BACKED stores, as lock-settlement-restart.test.js has them, so a signer node can die and start again on its own
// records. The late sweep is slowed out of the way and every step is driven by the round's asker, so each kill point is
// exactly where the pin says. `finalityOf` is the same test aid as late-settlement.test.js's.
import { presentDay } from './window-fixture.js';
import { testNow } from './test-clock.js';
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
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { lockAndPlay, closeRound, untilSettled, curve, lnurl } from './lock-round-fixture.js';
import { b32, WINDOW_MS, STAKE, WINNER, LOSER, contractFor, opts, wait } from './window-fixture.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { largestPayoutMsat } from '../../arena-protocol/src/lock-settlement.js';
import { askerOrder } from '../src/payout.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { HOSTED } from './plugins/hosted.js';

const LATE = { name: 'late', key: b32(6), worldSecret: b32(0xc1), ticks: 1000 };
const REAL_FEES = { ppm: 0n, baseMsat: 1000n };
const LOWEST = 'http://gw-a.example/';

/** The lock round on disk, settled without the late loser, the winner's first-round send PAID, the late loser now FAILED. */
async function settledOnDisk() {
  const dir = mkdtempSync(join(tmpdir(), 'late-'));
  // A CHAIN THAT BONDS THE ROUND'S TWO SIGNER NODES (RULED 2026-09-25), as lockRound in lock-round-fixture.js: both are
  // running daemons, so the claim key is their own live DKG; the round's beacon is that chain's, and players seed from it.
  const slot = bondedChainSlot(lockPort());
  const port = slot.port;
  const address = lnurl(port);
  const view = new Map();
  const finalityOf = (round, rid, eid) => (view.has(toHex(eid)) ? view.get(toHex(eid))(round, rid, eid) : resultFinality(round, rid, eid));
  const start = async (name, at = 0) => {
    const d = await serve(openStore(join(dir, `${name}.sqlite`)), { plugins: HOSTED, port: at, ...opts, stakeLocks: port, poolCurve: curve,
      finality: { everyMs: 100, lateEveryMs: 3600000 }, lnurlFetch: address.fetchLike, finalityOf,
      chainFor: slot.chainFor, randomnessFor: slot.randomnessFor });
    d.round.chainView = CLOCK.chainView();
    return d;
  };
  const w = { dir, port, view, lnurl: address, a: await start('a'), b: await start('b') };
  const wire = () => {
    for (const [d, o] of [[w.a, w.b], [w.b, w.a]]) {
      const there = [`http://127.0.0.1:${o.port}`];
      d.verifier.peers = there; d.stakeSecrets.peers = there; d.dkg.peers = there;
    }
  };
  wire();
  // THE ROUND ENDS NOW, NOT IN 1970, as lock-round-fixture's; closeRound skips past final_after in live order
  w.c = presentDay({ ...contractFor([w.a.round.pubkey, w.b.round.pubkey], BigInt(WINDOW_MS), [w.a, w.b].map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, minScore: 1, stakeMsat: STAKE }, testNow() + 3000);
  w.c = { ...w.c, censusRoot: bondedChainFor(w.c.nodes, w.c, slot,
    { endpoints: [w.a, w.b].map((d) => `ws://127.0.0.1:${d.port}`) }).censusRoot };
  w.rid = roundId(w.c);
  w.randomness = slot.randomnessFor({ contract: w.c }).hash;
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
  w.firstPayouts = () => JSON.stringify(port.settlements[0].payouts.map((p) => [toHex(p.payoutPk), String(p.msat)]));
  w.firstBefore = w.firstPayouts();
  view.delete(toHex(w.late.eid));                                            // the late loser is FINAL and FAILED now
  w.lateRows = (d = w.asker()) => d.round.lateSendScope(w.late.eid).sendAttemptsOf(w.rid);
  w.lateSubmissions = () => port.settlements.filter((x) => x.claims.some((c) => toHex(c.outpoint.txid) === toHex(w.late.outpoint.txid))).length;
  w.lateTx = () => port.settlements.find((x) => x.claims.some((c) => toHex(c.outpoint.txid) === toHex(w.late.outpoint.txid)));
  w.winnerKey = toHex(refundKeyOf(w.won.entry.playerPubkey));
  return w;
}

// AS THE LATE SWEEP DRIVES IT, a bounded number of passes: right after a restart on the same ports a peer's first answer
// can fail at the connection ("fetch failed"), and the daemon's sweep simply asks again. The passes taken are reported.
async function asTheSweep(fn, done, most = 20) {
  let got; let passes = 0;
  for (; passes < most; passes++) { got = await fn(); if (done(got)) break; await wait(200); }
  return { got, passes: passes + 1 };
}


test('restart (a): killed before the late transaction is settled - after the restart it is settled once, the late share a contract to the winner\'s own key, no send', async () => {
  const w = await settledOnDisk();
  try {
    assert.equal(w.lateSubmissions(), 0);
    await w.restart();                                                        // the kill
    const { got, passes } = await asTheSweep(() => w.asker().settlements.settleLate(w.rid, w.late.eid), (x) => x.state === 'ACCEPTED');
    const tx = w.lateTx();
    console.log('  FACTS (restart a):', JSON.stringify({ settled: got.state, why: got.why, passes, submissions: w.lateSubmissions(),
      payouts: tx ? tx.payouts.map((p) => [toHex(p.payoutPk).slice(0, 12), String(p.msat), !!p.sent]) : null, lateRows: [w.a, w.b].map((d) => w.lateRows(d).length) }));
    assert.equal(got.state, 'ACCEPTED', got.why);
    assert.equal(w.lateSubmissions(), 1);
    const toWinner = tx.payouts.filter((p) => toHex(p.payoutPk) === w.winnerKey);
    assert.equal(toWinner.length, 1, 'the late share is not one contract to the winner\'s own key');
    assert.ok(!toWinner[0].sent, 'the late share was sent');
    assert.deepEqual([w.a, w.b].map((d) => w.lateRows(d).length), [0, 0], 'a late send was planned');
    assert.equal(w.firstPayouts(), w.firstBefore, 'the first settlement changed');
  } finally { await w.close(); }
});

test('restart (b): killed after the late transaction is ACCEPTED - the same txid, rebuilt the same, nothing submitted again', async () => {
  const w = await settledOnDisk();
  try {
    // untilSettled reads node a only; the other seat can record the round's own settlement a moment later and refuse the
    // first ask ("not accepted here yet"), so the first late settlement is driven as the sweep drives it, as restart (a)'s
    const { got } = await asTheSweep(() => w.asker().settlements.settleLate(w.rid, w.late.eid), (x) => x.state === 'ACCEPTED');
    assert.equal(got.state, 'ACCEPTED', got.why);
    const txidBefore = w.asker().round.lateLockSettlement(w.rid, w.late.eid).txid;
    await w.restart();                                                        // the kill
    const { got: again, passes } = await asTheSweep(() => w.asker().settlements.settleLate(w.rid, w.late.eid), (x) => x.kept || x.state === 'ACCEPTED');
    const txidAfter = w.asker().round.lateLockSettlement(w.rid, w.late.eid).txid;
    const rebuilt = await w.asker().settlements.lateMessage(w.rid, w.late.eid);
    console.log('  FACTS (restart b):', JSON.stringify({ passes, again: again.kept || again.state, txidBefore: txidBefore.slice(0, 16), txidAfter: txidAfter.slice(0, 16),
      rebuilt: rebuilt.txid && rebuilt.txid.slice(0, 16), submissions: w.lateSubmissions() }));
    assert.equal(txidAfter, txidBefore);
    assert.equal(rebuilt.txid, txidBefore, 'the late transaction rebuilt after the restart is not the one signed');
    assert.equal(w.lateSubmissions(), 1, 'the late transaction was submitted again');
    assert.equal(w.firstPayouts(), w.firstBefore, 'the first settlement changed');
  } finally { await w.close(); }
});
