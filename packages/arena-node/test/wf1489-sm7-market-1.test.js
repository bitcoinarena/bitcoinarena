// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STATE MACHINE AUDIT round 7 (kanban #1489), market area, finding 1: A BATCH SIGNED BY needed-1 SEATS WHILE ONE SEAT IS DOWN CAN
// NEITHER BE CERTIFIED NOR VOIDED - THE BOOK IS FROZEN FOR GOOD.
// Seven seats, threshold 5 (5/7 tolerates two seats down). One seat is down. The leader of batch k hands its set out; it reaches the
// leader and three seats (four signatures), and the POST to the two other live seats is lost (the leader's 1 s ask, never retried).
//   - certify needs 5 signatures: the two live seats that never got the set cannot sign it any more (accept refuses a batch more than
//     maxLagMs after its cutoff), and the down seat cannot;
//   - void needs n - needed + 1 = 3 declines: only the two live seats that never signed can decline.
// So k stays SIGNED at four seats for good, those four sign no later batch (#signGuard: "batch k is not decided at this seat"), no later
// batch reaches 5, and every order of the round waits (standing: inPending) until its lock expires: no fill is ever paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { bookBatchId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-sm7m1', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const player = (n) => ({ ...LOSER, name: `sm7m${n}`, key: b32(0xc0 + n), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });

test('wf1489 sm7 market 1: a batch held by needed-1 seats with one seat down is decided (certified or void), the book does not freeze', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const rid = toHex(w.rid);
  const base = (d) => `http://127.0.0.1:${d.port}`;
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const order = (n, outcome, c) => lockAndPlay(w, player(n), { noMarks: true, pick: outcome, order: cents(c) });
  const leaderOf = (k) => w.nodes.find((d) => d.orderBook.leads(w.rid, k));
  const untilCutoff = async (k, extra = 20) => { while (testNow() < (k + 1) * B + extra) await wait(5); };
  let downClosed = false;
  try {
    // two crossing orders, their locks verified at every seat
    const R = await order(0, YES, 70);
    const S = await order(1, NO, 35);
    const kD = Math.floor(testNow() / B) + 1;
    const L = leaderOf(kD);
    // ONE SEAT GOES DOWN (not k's leader)
    const down = w.nodes.find((d) => d !== L);
    const origClose = down.close.bind(down);
    down.close = async () => { if (!downClosed) { downClosed = true; await origClose(); } };
    await down.close();
    const live = w.nodes.filter((d) => d !== down);
    await untilCutoff(kD);
    // k's leader signs its set and hands it out: it reaches three seats, the POST to the other two live seats is lost
    const ids = [toHex(R.eid), toHex(S.eid)].sort();
    const id = bookBatchId({ roundId: w.rid, k: BigInt(kD), orderIds: ids });
    const record = { k: String(kD), orders: ids, cancels: [], sells: [], leader: toHex(L.round.pubkey), leaderSig: toHex(schnorr.sign(id, L.round.identity.secret)) };
    const signers = [L, ...live.filter((d) => d !== L).slice(0, 3)];
    for (const d of signers) {
      const r = await fetch(`${base(d)}/batch?round=${rid}`, { method: 'POST', body: JSON.stringify(record) });
      assert.equal(r.status, 201, await r.text());
    }
    // every live seat leads its batches for the next three rounds of the committee: k must be decided by one of them
    const decided = [];
    for (let k = kD + 1; k <= kD + 21; k++) {
      const leader = leaderOf(k);
      await untilCutoff(k);
      if (leader === down) continue;
      const got = await leader.orderBook.lead(w.rid, k).catch((e) => ({ ok: false, why: e.message }));
      decided.push({ k, ok: got.ok, why: got.why ? got.why.replace(/\d{6,}/g, 'K').slice(0, 160) : null, decided: (got.decided || []).map((x) => `${x.k === String(kD) ? 'kD' : x.k}:${x.state}`) });
      if (live.every((d) => ['CERTIFIED', 'VOID'].includes(d.orderBook.batchState(w.rid, kD)))) break;
    }
    const states = live.map((d) => d.orderBook.batchState(w.rid, kD));
    const standingR = signers[1].orderBook.standing(w.rid, R.eid);
    // and the two seats that never signed k, asked to sign it now: refused (too late)
    const late = await fetch(`${base(live.find((d) => !signers.includes(d)))}/batch?round=${rid}`, { method: 'POST', body: JSON.stringify(record) });
    const lateWhy = `${late.status} ${(await late.text()).trim().replace(/-?\d+ ms/g, 'N ms').slice(0, 120)}`;
    console.log('  MEASURED sm7-market-1:', JSON.stringify({ kD, states, standingR, lateSign: lateWhy, leads: [...new Set(decided.map((x) => `${x.ok} ${x.why} ${x.decided.join(',')}`))] }, null, 1));
    assert.ok(states.every((s) => s === 'CERTIFIED' || s === 'VOID'),
      `batch ${kD} is still undecided after every live seat led three times with one seat of seven down: ${states.join(', ')} - the book is frozen, its orders wait for their locks' expiry`);
  } finally { await w.close(); }
});
