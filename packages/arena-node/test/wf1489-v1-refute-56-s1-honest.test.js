// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 2 (order books): ONE PLAYER'S FREE SELLS STALL EVERY BATCH OF THE MARKET.
// POST /sell (order-batch.js ask) keeps any sell its entry's session key signed - a fresh nonce is a fresh sell - with no bound per entry and
// no check that the entry holds a share. A sell of shares the entry does not hold is refused only inside the ledger, by the leader, and is
// LEFT OUT of the batch: it stays unbatched at every seat for ever (until the close). So every batch from then on, each seat's GET
// /batch-proposal hands the leader all of them, the leader checks each one's Ed25519 signature again for every proposal (#sellStands) and
// runs the ledger over them - and a batch that should be certified inside its 0.5 s interval takes seconds, every interval, for the whole
// market. It costs the player one small order and nothing per sell (no lock, no fee: a sell that never fills owes nothing).
// SAFE: the seats bound what one entry keeps pending (or refuse a sell its entry cannot back), so a batch still certifies inside its interval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { sellId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489-3', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
const B = 500;
const SELLS = 3000;
const player = (n) => ({ ...LOSER, name: `s${n}`, key: b32(0xc0 + n), worldSecret: b32(0) });
const cents = (c) => ({ price: BigInt(c) * 1000n });


// HONEST + BOUND CHECK (not a failure test): an entry that bought YES sells it at every seat; oversized sells of it stop at 16 per seat.
test('wf1489-v1-refute-56-s1 honest: a filled entry sells; its oversized sells are bounded per seat', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const order = (n, outcome, c) => lockAndPlay(w, player(n), { noMarks: true, pick: outcome, order: cents(c) });
  const batch = async () => {
    const k = Math.floor(testNow() / B);
    while (testNow() < (k + 1) * B + 20) await wait(5);
    return w.nodes.find((d) => d.orderBook.leads(w.rid, k)).orderBook.lead(w.rid, k);
  };
  const sign = (E, n, shares, outcome = YES) => { const s = { entry: toHex(E.eid), outcome, price: '90000', sharesMsat: String(shares), nonce: String(n) };
    s.signature = toHex(ed25519.sign(sellId({ roundId: w.rid, entryId: E.eid, outcome, price: 90000n, sharesMsat: BigInt(shares), nonce: BigInt(n) }), E.session)); return s; };
  try {
    const P = await order(1, YES, 60); await order(2, NO, 55);
    const b = await batch(); assert.equal(b.certified, true, b.why);
    for (const d of w.nodes) { const L = d.orderBook.ledger(w.rid); assert.ok(L.positions.get(toHex(P.eid)).shares[YES] > 0n); }
    const got = w.nodes.map((d) => d.orderBook.ask(w.rid, 'sell', sign(P, 1, 1000)));
    console.log('  HONEST:', JSON.stringify(got.map((g) => g.ok ? 'ok' : g.why)));
    assert.ok(got.every((g) => g.ok));
    // string outcome '0' as a JSON client might send: same answer
    const g2 = w.nodes[0].orderBook.ask(w.rid, 'sell', sign(P, 2, 1000, YES));
    assert.ok(g2.ok);
    let kept = 0; for (let i = 0; i < 100; i++) if (w.nodes[0].orderBook.ask(w.rid, 'sell', sign(P, 100 + i, '9000000000000')).ok) kept++;
    console.log('  OVERSIZED KEPT AT SEAT 0:', kept);
    assert.ok(kept <= 16);
    const a = await batch(); console.log('  NEXT BATCH:', JSON.stringify({ certified: a.certified, sells: a.sells, why: a.why }));
    assert.equal(a.certified, true, a.why);
  } finally { await w.close(); }
});
