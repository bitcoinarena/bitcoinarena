// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-3 skeptic 3 (second copies of the #1889 legacy-row fix): 77f6e8588 made Round.entriesOf, firstEntryNamingLock,
// the order book's #syncTradable and the settlement's cancel carry skip a stored entry the stricter decoder refuses (an off-curve
// website key frontendPk, taken by a seat on the build before settle-2). The order book's OTHER read, #orderEntry, still decodes
// unguarded - and ledger() calls it for every order of every certified batch. An order taken (and batched) before the upgrade
// therefore makes ledger() THROW after it: every new batch's #check, every sell's #sellBacked and the settlement's #bookPlan.
// The market can neither trade on nor settle - the effect the #1889 fix closed for pool rounds, still open for books.
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
import { FRONTEND_FEE_VERSION } from '../../arena-protocol/src/constants.js';
import { onCurveX } from '../../arena-protocol/src/guardian-payout.js';   // 2.0: onCurveX lives here (no point.js)
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-s3', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n,
  protocolVersion: FRONTEND_FEE_VERSION };
const player = (n) => ({ ...LOSER, name: `s3${n}`, key: b32(0x70 + n), worldSecret: b32(0) });
const SITE = (() => { const k = new Uint8Array(33).fill(0x5e); k[0] = 2; while (!onCurveX(k.subarray(1))) k[32]++; return k; })();
const B = 1000;

async function batch(w) {
  const k = Math.floor(testNow() / B);
  while (testNow() < (k + 1) * B + 20) await wait(5);
  const leader = w.nodes.find((d) => d.orderBook.leads(w.rid, k));
  try { return await leader.orderBook.lead(w.rid, k); } catch (e) { return { ok: false, why: `threw: ${e.message}` }; }
}

test('#1489 s3: an order with an off-curve website key taken before the upgrade does not make the book ledger throw, and the market still batches', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 3, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  const facts = {};
  try {
    for (const d of w.nodes) d.orderBook.intervalMs = B;
    const o1 = await lockAndPlay(w, player(1), { noMarks: true, pick: YES, order: { price: 52000n }, frontendPk: SITE });
    await lockAndPlay(w, player(2), { noMarks: true, pick: NO, order: { price: 50000n } });
    const first = await batch(w);
    facts.first = first.ok ? (first.certified ? 'certified' : 'signed') : first.why;
    for (const d of w.nodes) await d.orderBook.sync(w.rid, { force: true }).catch(() => null);
    // THE BYTES THE OLD BUILD TOOK: the same order with 0x02 || 0xff*32 as its website key (the key is the entry's last field)
    for (const d of w.nodes) {
      const raw = new Uint8Array(d.round.entry(o1.eid));
      assert.equal(toHex(raw.subarray(raw.length - 33)), toHex(SITE), 'the website key is the entry\'s last field');
      const legacy = raw.slice(); legacy.fill(0xff, legacy.length - 32);
      d.round.db.prepare('UPDATE entries SET contract = ? WHERE entry_id = ?').run(Buffer.from(legacy), Buffer.from(o1.eid));
    }
    facts.ledger = w.nodes.map((d) => { try { const L = d.orderBook.ledger(w.rid); return L.ok ? 'ok' : `refused: ${L.why}`; } catch (e) { return `threw: ${e.message}`; } });
    // TWO NEW HONEST ORDERS: the market must still batch them
    await lockAndPlay(w, player(3), { noMarks: true, pick: YES, order: { price: 53000n } });
    await lockAndPlay(w, player(4), { noMarks: true, pick: NO, order: { price: 49000n } });
    const second = await batch(w);
    facts.second = second.ok ? (second.certified ? 'certified' : 'signed') : second.why;
  } finally { await w.close(); }
  console.log('  MEASURED s3-1:', JSON.stringify(facts));
  assert.equal(facts.first, 'certified', `the first batch: ${facts.first}`);
  for (const l of facts.ledger) assert.doesNotMatch(l, /^threw/, `the book's ledger threw for one legacy order: ${l}`);
  assert.equal(facts.second, 'certified', `one legacy order stopped every later batch of the market: ${facts.second}`);
});
