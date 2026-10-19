// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE TEST UP/DOWN MARKET AT THE SEATS (2026-10-09): rounds on the market's own 15-minute clock, locks
// sized to outlive a whole round, locked orders resolved by the attestors' core and settled to the msat; a deadline missed
// voids and returns every lock; two attestations naming different outcomes - disputed - void too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, openLockRound, lockAndPlay, closeRound, standing } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { UPDOWN, UPDOWN_TERMS, UPDOWN_PERIOD_MS, UPDOWN_ATTESTOR_KEYS } from './plugins/updown/index.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { marketExpiryBlocks, marketSettledByMs, fastestBlockMsOf } from '../../arena-protocol/src/lock-expiry.js';
import { bookSettlement } from '../../arena-protocol/src/book-ledger.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { YES, NO } from '../../arena-protocol/src/order-book.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { attestWindow, combine } from '../../arena-attestor/src/attestor.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const STAKE = 10_000n;
const P = Number(UPDOWN_PERIOD_MS);
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const ATTESTORS = UPDOWN.attestors.map((a) => toHex(a.pubkey));
const player = (n) => ({ ...LOSER, name: `u${n}`, key: b32(0x70 + n), worldSecret: b32(0) });
const sum = (xs) => xs.reduce((t, x) => t + x, 0n);
const expiryFor = (c) => marketExpiryBlocks(c, UPDOWN_TERMS).blocks;
const B = 500;
// THE MARKET'S WINDOW (2026-10-11): orders from entry_close - period on, never before
const windowOpen = (x) => Math.max(Number(x.c.committeeTimeMs), Number(x.c.entryCloseMs) - P) + 100;

test('the Up/Down market: its 15-minute clock, locks that outlive a round (144 refused), orders resolved by the attestors and settled to the msat; a missed deadline and a dispute void, every lock back', async () => {
  const opts = { n: 2, stakeMsat: STAKE, round: ROUND, alignCloseMs: P, stakeExpiryFor: expiryFor };
  const w = await lockRound({ ...opts, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  const base = (d) => `http://127.0.0.1:${d.port}`;
  // THE LISTING SAYS SO TOO: closed at the committee time, open from the window's start
  const listedOpen = async (x) => { const b = await (await fetch(`${base(x.a)}/rounds`)).json(); const r = b.rounds.find((y) => y.id === toHex(x.rid)); return r && { entryOpen: r.entryOpen, windowStartMs: r.windowStartMs }; };
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const post = (d, path, body) => fetch(`${base(d)}${path}`, { method: 'POST', body }).then(async (r) => `${r.status} ${(await r.text()).trim()}`);
  const back = (x, e, lock = '') => fetch(`${base(x.a)}/forfeit?round=${toHex(x.rid)}&entry=${toHex(e.eid)}${lock}`).then(async (r) => (r.status === 200 ? '200' : `${r.status} ${(await r.text()).trim()}`));
  const batch = async (x) => {
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const leader = x.nodes.find((d) => d.orderBook.leads(x.rid, k));
    const got = await leader.orderBook.lead(x.rid, k);
    assert.equal(got.ok, true, got.why);
    return got;
  };
  // THE ATTESTORS' CORE on a feed: a reading at the window's start, then `after` for the rest of it
  const attest = (x, signers, startCents, afterCents) => {
    const startMs = x.c.entryCloseMs - UPDOWN_PERIOD_MS;
    const samples = [{ atMs: startMs - 60000n, price: BigInt(startCents) }, { atMs: startMs + 60000n, price: BigInt(afterCents) }];
    const words = signers.map((l) => attestWindow({ samples, roundId: x.rid, window: { startMs, endMs: x.c.entryCloseMs }, attestor: UPDOWN_ATTESTOR_KEYS[l] }));
    return combine(words, { attestors: ATTESTORS, threshold: 2 });
  };
  const settle = async (x) => {
    let got;
    for (const stop = Date.now() + 60000, nudged = { at: 0 }; Date.now() < stop; await wait(250)) {
      got = await standing(x.a, x);
      if (got.state === 'ACCEPTED') break;
      if (Date.now() - nudged.at > 1000) { nudged.at = Date.now(); await Promise.all(x.nodes.map((d) => d.settlements.settle(x.rid).catch(() => null))); }
    }
    return got;
  };
  const facts = {};
  try {
    skipTo(windowOpen(w));
    const inside = await listedOpen(w);
    assert.deepEqual(inside, { entryOpen: true, windowStartMs: String(w.c.entryCloseMs - UPDOWN_PERIOD_MS) });
    // 1. THE MARKET'S OWN CLOCK AND THE LOCK SPAN AT THE ROUND DOOR
    const need = marketExpiryBlocks(w.c, UPDOWN_TERMS);
    const offGrid = await post(w.a, '/round', encodeRoundContract({ ...w.c, entryCloseMs: w.c.entryCloseMs + 1000n, stakeExpiryBlocks: expiryFor({ ...w.c, entryCloseMs: w.c.entryCloseMs + 1000n }) }));
    const short = await post(w.a, '/round', encodeRoundContract({ ...w.c, stakeExpiryBlocks: 144 }));
    // the span outlives the whole round: its blocks at the chain's fastest cover committee time -> settled-by + margin
    const coversMs = BigInt(w.c.stakeExpiryBlocks) * fastestBlockMsOf(w.c.networkId);
    facts.clock = { close: new Date(Number(w.c.entryCloseMs)).toISOString(), onGrid: w.c.entryCloseMs % UPDOWN_PERIOD_MS === 0n, offGrid: offGrid.slice(0, 140), short: short.slice(0, 160),
      span: w.c.stakeExpiryBlocks, needBlocks: need.blocks, coversMin: Number(coversMs / 60000n), roundLivesMin: Number((marketSettledByMs(w.c, UPDOWN_TERMS) - w.c.committeeTimeMs) / 60000n) };
    assert.equal(facts.clock.onGrid, true);
    assert.match(offGrid, /^409 game "btc-updown-15m" runs one round per 900000 ms on the UTC grid/);
    assert.match(short, /^409 that market round names stake_expiry_blocks 144, and its locks must last \d+ blocks/);
    assert.ok(coversMs >= marketSettledByMs(w.c, UPDOWN_TERMS) - w.c.committeeTimeMs, 'the lock span does not outlive the round');
    // 2. A LOCK AT THE OLD 144 BLOCKS IS REFUSED; ON THE ROUND'S SPAN IT IS TAKEN
    const old = await lockAndPlay(w, player(0), { noMarks: true, pick: YES, order: { price: 55000n }, expirySpan: 144 }).then(() => 'taken', (e) => e.message.split('\n')[0]);
    facts.oldLock = old.slice(0, 200);
    assert.match(old, /lock height .* less the round's \d+ blocks\) is more than 12 blocks below the height/);
    // 3. LOCKED ORDERS: Up and Down cross; the attestors' core resolves Up (the end price above the price to beat); settled to the msat
    const up = await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 60000n } });
    const down = await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 45000n } });
    const b1 = await batch(w);
    assert.equal(b1.certified, true);
    skipTo(Number(w.c.entryCloseMs) + 2 * B + 10);
    await closeRound(w, { window: false });
    const att = attest(w, ['A', 'B'], 8295000, 8299000);
    const posted = await Promise.all(w.nodes.map((d) => post(d, `/outcome?round=${toHex(w.rid)}`, att.bytes)));
    const o = await (await fetch(`${base(w.a)}/outcome?round=${toHex(w.rid)}`)).json();
    skipTo(Number(o.finalAtMs) + 100);
    const got = await settle(w);
    assert.equal(got.state, 'ACCEPTED', got.why);
    const table = bookSettlement({ positions: w.a.orderBook.ledger(w.rid).positions, outcome: YES });
    const payouts = (got.moved && got.moved.payouts) || [];
    for (const e of [up, down]) {
      const r = table.claimed.find((x) => x.entry === toHex(e.eid));
      const p = payouts.find((x) => x.kind === 'qualifier' && String(x.pk) === toHex(refundKeyOf(e.entry.playerPubkey)));
      if (r.outMsat > 0n) assert.equal(BigInt(p.msat), r.outMsat, 'a player was not paid its table out to the msat');
    }
    const claims = (got.moved && got.moved.claims) || [];
    facts.settled = { posted: posted.map((x) => x.slice(0, 3)), outcome: o.label, claims: claims.length, paid: String(sum(payouts.map((x) => BigInt(x.msat)))),
      locks: String(sum(claims.map((c) => BigInt(c.msat ?? c.amountMsat)))), feesDue: String(table.feesDueMsat) };
    assert.deepEqual(facts.settled.posted, ['201', '201']);
    assert.equal(facts.settled.paid, facts.settled.locks, 'the payouts are not the locks claimed, to the msat');
    assert.equal(claims.length, 4, 'not the two locks of each filled order');
    // 4. A MISSED DEADLINE: a round nobody attests - VOID 10 min after its window's end, every lock back
    const r2 = await openLockRound(w, { stakeMsat: STAKE, round: ROUND, endMs: Number(w.c.entryCloseMs) + 3600000, alignCloseMs: P, stakeExpiryFor: expiryFor });
    skipTo(windowOpen(r2));
    const e2 = await lockAndPlay(r2, player(3), { noMarks: true, pick: YES, order: { price: 50000n } });
    const before2 = await back(r2, e2);
    skipTo(Number(r2.c.entryCloseMs) + 600000 + 1000);
    await closeRound(r2, { window: false });
    const held2 = await r2.a.settlements.settle(r2.rid);
    facts.deadline = { before: before2.slice(0, 90), state: held2.state, why: (held2.why || '').slice(0, 120), back: [await back(r2, e2), await back(r2, e2, '&lock=fee')] };
    assert.match(before2, /^409 that order stands unfilled/);
    assert.equal(held2.state, 'VOID');
    assert.deepEqual(facts.deadline.back, ['200', '200']);
    // 5. A DISPUTE: A+B say Up, B+C say Down (B signed both) - DISPUTED, VOID, every lock back
    const r3 = await openLockRound(w, { stakeMsat: STAKE, round: ROUND, endMs: Number(r2.c.entryCloseMs) + 3600000, alignCloseMs: P, stakeExpiryFor: expiryFor });
    skipTo(windowOpen(r3));
    const u3 = await lockAndPlay(r3, player(4), { noMarks: true, pick: YES, order: { price: 60000n } });
    const d3 = await lockAndPlay(r3, player(5), { noMarks: true, pick: NO, order: { price: 45000n } });
    await batch(r3);
    skipTo(Number(r3.c.entryCloseMs) + 2 * B + 10);
    await closeRound(r3, { window: false });
    const upAtt = attest(r3, ['A', 'B'], 8295000, 8299000);
    const downAtt = attest(r3, ['B', 'C'], 8295000, 8290000);
    for (const a of [upAtt, downAtt]) await Promise.all(r3.nodes.map((d) => post(d, `/outcome?round=${toHex(r3.rid)}`, a.bytes)));
    const o3 = await (await fetch(`${base(r3.a)}/outcome?round=${toHex(r3.rid)}`)).json();
    const held3 = await r3.a.settlements.settle(r3.rid);
    facts.dispute = { state: o3.state, settle: held3.state, why: (held3.why || '').slice(0, 100), back: [await back(r3, u3), await back(r3, u3, '&lock=fee'), await back(r3, d3), await back(r3, d3, '&lock=fee')] };
    assert.equal(o3.state, 'DISPUTED');
    assert.equal(held3.state, 'VOID');
    assert.deepEqual(facts.dispute.back, ['200', '200', '200', '200']);
    console.log('  UPDOWN:', JSON.stringify(facts));
  } finally { await w.close(); }
});
