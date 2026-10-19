// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BOTS BUILD ORDER DEPTH (2026-10-08: "A few bots simulate real bot behavior and build order depth").
// Seven seats of one Up/Down market round, every order an entry whose stake and fee locks the seats verified (the
// order-batch fixture). Two bots read the same window from slightly different last prices, so their fair chances differ:
// each quotes a ladder of buys on both sides (arena-client book-bot.js), the seats clear the batch, the bots' best quotes
// cross each other where their fair values disagree, and the rest of the ladders rest as depth on Up and on Down. A taker
// who pays the spread then fills at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { fairUp, quoteLadder, depthOf, stakeFor } from '../../btc-updown/page/book-bot.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m', outcomes: [...UP_DOWN_OUTCOMES] });
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(TEST_DONATION_SET_KEYS_REGTEST.recipients), entryCloseMs: 900000n };
const player = (n) => ({ ...LOSER, name: `bot${n}`, key: b32(0x40 + n), worldSecret: b32(0) });

test('the quotes: a fair chance from the price, the time and a 1-minute volatility; both sides below fair, never crossing itself', () => {
  assert.ok(Math.abs(fairUp({ beat: 82556.29, last: 82556.29, msLeft: 600000 }) - 0.5) < 1e-6, 'at the price to beat: even');
  assert.ok(fairUp({ beat: 82556.29, last: 82600, msLeft: 600000 }) > 0.6, 'above the price to beat, Up is likelier');
  assert.ok(fairUp({ beat: 82556.29, last: 82600, msLeft: 30000 }) > fairUp({ beat: 82556.29, last: 82600, msLeft: 600000 }), 'and more so with less time left');
  assert.equal(fairUp({ beat: 100, last: 100, msLeft: 0 }), 1, 'a tie at the end is Up');
  const q = quoteLadder({ fair: 0.52, levels: 3, stepCents: 2, edgeCents: 1 });
  assert.deepEqual(q.map((x) => [x.outcome, x.priceCents]), [[YES, 51], [YES, 49], [YES, 47], [NO, 47], [NO, 45], [NO, 43]]);
  assert.ok(q.filter((x) => x.outcome === YES)[0].priceCents + q.filter((x) => x.outcome === NO)[0].priceCents < 100, 'its own best Up and Down do not cross');
  assert.equal(stakeFor({ shares: 5, priceCents: 51 }), 2577n, '5 shares at 51 c: 2550 msat, its 1 % fee on top');
  assert.deepEqual(quoteLadder({ fair: 0.99, levels: 3 }).map((x) => [x.outcome, x.priceCents]), [[YES, 98], [YES, 96], [YES, 94]], 'Down at 0 c is no price');
});

test('two bots on seven seats: their best quotes cross where they disagree, the rest of both ladders rests as depth on Up and Down, and a taker fills at once', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const beat = 82556.29, msLeft = 600000;
    const bots = [{ name: 'A', last: 82580 }, { name: 'B', last: 82530 }].map((b) => ({ ...b, fair: fairUp({ beat, last: b.last, msLeft }) }));
    const placed = new Map();          // entry id -> { bot, outcome, price }
    let n = 0;
    for (const b of bots) {
      for (const q of quoteLadder({ fair: b.fair, levels: 3, stepCents: 2, edgeCents: 1 })) {
        const got = await lockAndPlay(w, player(n++), { noMarks: true, pick: q.outcome, order: { price: q.price } });
        placed.set(toHex(got.eid), { bot: b.name, outcome: q.outcome, price: q.price, cents: q.priceCents });
      }
    }
    const lead = async () => {
      const k = Math.floor(testNow() / 500);
      while (testNow() < (k + 1) * 500) await wait(5);
      const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
      const got = await leader.orderBook.lead(w.rid, k);
      assert.equal(got.ok, true, got.why);
      assert.equal(got.certified, true);
      return got;
    };
    await lead();
    const book = async () => (await fetch(`http://127.0.0.1:${w.nodes[0].port}/book?round=${toHex(w.rid)}`)).json();
    const b1 = await book();
    const resting1 = b1.resting.buys.map((e) => placed.get(e)).filter(Boolean);
    const depth1 = depthOf(resting1);
    const priced = b1.batches.filter((x) => x.price !== null);
    // A TAKER: Up at 99 c takes the best resting Down
    const taker = await lockAndPlay(w, player(n++), { noMarks: true, pick: YES, order: { price: 99000n } });
    await lead();
    const b2 = await book();
    const takerPos = b2.positions.find((p) => p.entry === toHex(taker.eid));
    const depth2 = depthOf(b2.resting.buys.map((e) => placed.get(e)).filter(Boolean));
    console.log('  BOTS:', JSON.stringify({ fair: bots.map((b) => [b.name, b.fair.toFixed(3)]),
      quotes: [...placed.values()].map((p) => `${p.bot} ${p.outcome === YES ? 'Up' : 'Down'} ${p.cents}c`),
      batch1: { price: priced.map((x) => x.price), resting: b1.resting.buys.length, depth: depth1 },
      taker: { upShares: takerPos && String(takerPos.shares[YES] ?? takerPos.shares['0']) }, batch2depth: depth2 }));
    assert.ok(priced.length >= 1, 'the bots\' best quotes crossed where their fair values disagree');
    assert.ok(depth1.up.levels >= 2 && depth1.down.levels >= 2, `depth on both sides: ${JSON.stringify(depth1)}`);
    assert.ok(takerPos && BigInt(takerPos.shares[YES] ?? takerPos.shares['0']) > 0n, 'the taker filled');
  } finally { await w.close(); }
});
