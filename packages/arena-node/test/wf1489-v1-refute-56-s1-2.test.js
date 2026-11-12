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
const STRANGER = b32(0x5e); // a key that is no entry's session key: the seat needs no player's help
const cents = (c) => ({ price: BigInt(c) * 1000n });


// VARIANT 2: as -1, but the sells carry signatures of a stranger's key - a refused verify is never cached, so a seat needs no player at all.
// VARIANT (one seat, kanban #1547 bypass): the door (ask) now refuses unbacked sells, but the LEADER still takes every sell a seat's
// GET /batch-proposal hands it and verifies each one's Ed25519 signature (a sell is cached only once verified - and a fresh nonce is a
// fresh sell). One seat that serves SELLS sells of an entry holding nothing, with fresh nonces each batch, never passes ask(): it puts
// them in its own book (as a modified seat answers its proposal). The leader still verifies every one and runs the ledger over them.
test('wf1489-v1-refute-56-s1-2: one seat\'s proposal of sells no session key signed (no player needed) does not hold a batch past its interval', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 7, stakeMsat: 10_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const order = (n, outcome, c) => lockAndPlay(w, player(n), { noMarks: true, pick: outcome, order: cents(c) });
  const nextK = () => Math.floor(testNow() / B);
  const batch = async (k) => {
    while (testNow() < (k + 1) * B + 20) await wait(5);
    const t0 = Date.now();
    const got = await w.nodes.find((d) => d.orderBook.leads(w.rid, k)).orderBook.lead(w.rid, k);
    return { k, ms: Date.now() - t0, ...got };
  };
  let nonce = 0;
  const signed = () => Array.from({ length: SELLS }, () => {
    nonce++;
    const id = sellId({ roundId: w.rid, entryId: A.eid, outcome: YES, price: 90000n, sharesMsat: 1000n, nonce: BigInt(nonce) });
    return { id: toHex(id), s: { entry: toHex(A.eid), outcome: YES, price: '90000', sharesMsat: '1000', nonce: String(nonce), signature: toHex(ed25519.sign(id, STRANGER)) } };
  });
  const flood = (k, list) => {
    // a seat that does not lead k puts SELLS fresh sells of A into its own book, past the door (signed beforehand: the insert is instant)
    const bad = w.nodes.find((d) => !d.orderBook.leads(w.rid, k));
    const ins = bad.orderBook.db.prepare('INSERT INTO market_book_events (event_id, round_id, kind, entry_id, body, received_ms, batch) VALUES (?, ?, ?, ?, ?, ?, NULL)');
    bad.orderBook.db.exec('BEGIN'); for (const x of list) ins.run(x.id, Buffer.from(w.rid), 'sell', x.s.entry, JSON.stringify(x.s), k * B); bad.orderBook.db.exec('COMMIT');
  };
  let A;
  try {
    await order(1, YES, 60); await order(2, NO, 55);
    const base = await batch(nextK());
    assert.equal(base.certified, true, base.why);
    A = await order(0, YES, 10);
    await batch(nextK());
    // the door refuses such a sell (the fix): check it
    { const s = { entry: toHex(A.eid), outcome: YES, price: '90000', sharesMsat: '1000', nonce: '999999' };
      s.signature = toHex(ed25519.sign(sellId({ roundId: w.rid, entryId: A.eid, outcome: YES, price: 90000n, sharesMsat: 1000n, nonce: 999999n }), A.session));
      assert.equal(w.nodes[0].orderBook.ask(w.rid, 'sell', s).ok, false, 'the door refuses an unbacked sell'); }
    const results = [];
    for (let r = 0; r < 2; r++) {
      await order(10 + 2 * r, YES, 61); await order(11 + 2 * r, NO, 56);
      const list = signed();
      const k = nextK();
      flood(k, list);
      results.push(await batch(k));
    }
    console.log('  MEASURED:', JSON.stringify({ baselineLeadMs: base.ms, rounds: results.map((x) => ({ ms: x.ms, certified: x.certified, sells: x.sells, why: x.why })), intervalMs: B }));
    for (const x of results) {
      assert.equal(x.certified, true, x.why);
      assert.ok(x.ms < B, `one seat's ${SELLS} fresh unbacked sells in its proposal held the batch ${x.ms} ms (interval ${B} ms; baseline ${base.ms} ms)`);
    }
  } finally { await w.close(); }
});
