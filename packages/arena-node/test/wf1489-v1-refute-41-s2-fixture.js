// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 v1 refute 41 skeptic 2: a seat holding the certified book that two minutes of the #1526 sell flood leaves behind -
// one order that filled once (a real lock) and 16 tiny never-crossing sells of it per seat per 500 ms batch, which is exactly what
// 07d81d630 still lets through (MAX_UNBATCHED_SELLS at every door, MAX_UNBATCHED_SELLS of one order from each proposal).
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, LOSER } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { testAttestedGame } from './plugins/sign.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { sellId, YES, NO } from '../../arena-protocol/src/order-book.js';
import { UP_DOWN_OUTCOMES } from '../../arena-protocol/src/up-down.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const UPDOWN = testAttestedGame({ name: 'btc-updown-15m-wf1489-v1r41s2', outcomes: [...UP_DOWN_OUTCOMES] });
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
export const B = 500;
export const SEATS = 7, PER = 16;

export async function floodedBook({ batches }) {
  const w = await lockRound({ n: SEATS, stakeMsat: 100_000_000n, round: ROUND, endMs: testNow() + 1800000,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  for (const d of w.nodes) d.orderBook.intervalMs = B;
  const z = await lockAndPlay(w, { ...LOSER, name: 'zz', key: b32(0xee), worldSecret: b32(0) }, { noMarks: true, pick: YES, order: { price: 40000n }, only: [] });
  const y = await lockAndPlay(w, { ...LOSER, name: 'yy', key: b32(0xef), worldSecret: b32(1) }, { noMarks: true, pick: NO, order: { price: 60000n }, only: [] });
  const seat = w.nodes[0], db = seat.orderBook.db, rid = Buffer.from(w.rid);
  const zh = toHex(z.eid), yh = toHex(y.eid);
  const sell = (outcome, nonce, price = 99000n, sharesMsat = 1n) => ({ entry: zh, outcome, price: String(price), sharesMsat: String(sharesMsat), nonce: String(nonce),
    signature: toHex(ed25519.sign(sellId({ roundId: w.rid, entryId: z.eid, outcome, price, sharesMsat, nonce: BigInt(nonce) }), z.session)) });
  // the certified batches this seat holds (what its peers certified with it): k0 fills z against y, then the flood rests
  const put = db.prepare('INSERT INTO market_batches (round_id, k, batch_id, record, own_sig, certificate, stored_ms) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const putOrder = db.prepare("INSERT OR REPLACE INTO market_orders (order_id, round_id, body, received_ms, batch) VALUES (?, ?, '', ?, ?)");
  const k0 = 1;
  putOrder.run(zh, rid, 0, k0); putOrder.run(yh, rid, 0, k0);
  const t0 = Date.now();
  db.exec('BEGIN');
  put.run(rid, k0, String(k0).padStart(64, '0'), JSON.stringify({ k: String(k0), orders: [zh, yh], cancels: [], sells: [], leader: '', leaderSig: '' }), null, '[]', 0);
  let n = 0;
  for (let k = k0 + 1; k <= k0 + batches; k++) {
    const sells = [];
    for (let i = 0; i < SEATS * PER; i++, n++) sells.push(sell(YES, n));
    put.run(rid, k, String(k).padStart(64, '0'), JSON.stringify({ k: String(k), orders: [], cancels: [], sells, leader: '', leaderSig: '' }), null, '[]', 0);
  }
  db.exec('COMMIT');
  return { w, seat, z, zh, sell, posted: n, signMs: Date.now() - t0, lastK: k0 + batches };
}
