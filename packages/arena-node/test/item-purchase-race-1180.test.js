// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1180: ONE PAYMENT IS ONE PURCHASE, AND IT NAMES ITS ITEM. Two records of one txid handed at once both passed the txid check (the
// check and the insert were split by awaits) and both answered kept 'new'; and a payment whose contracts named the buyer's key alone fitted
// any item of the same price, so two seats could keep two different items for one payment. Now the txid is claimed PENDING before the
// federation is asked, kept by compare-and-set, and every contract's image is the purchase's commitment (purchaseImage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import * as seat from '../src/item-purchase-seat.js';
import * as purchase from '../../arena-protocol/src/purchase.js';
import { ITEMS_VERSION } from '../../arena-protocol/src/constants.js';
import { SERVED_WINDOW_MS } from '../../arena-protocol/src/served-nodes.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const { keepItemPurchase, itemsOwned } = seat;
const { purchaseOutputs, purchaseId } = purchase;
const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => Uint8Array.from([0x02, ...b32(n)]);
const SECRET = b32(0x77), BUYER = schnorr.getPublicKey(SECRET);
const verify = (s, m, k) => schnorr.verify(s, m, k);
const MANIFEST = { gameDevPubkey: b32(0xde), gameName: 'nextblock', requiredProtocolVersion: ITEMS_VERSION,
  items: [{ id: 'large-truck', name: 'Larger truck', priceSat: 500n, unlock: b32(0xa1) }, { id: 'red-paint', name: 'Red paint', priceSat: 500n, unlock: b32(0xa2) }] };
const NET = [{ recipientPk: pk33(0x11), label: 'dev a', shareBps: 6667 }, { recipientPk: pk33(0x12), label: 'dev b', shareBps: 3333 }];
const NODES = Array.from({ length: 7 }, (_, i) => ({ key: (i + 1).toString(16).padStart(2, '0').repeat(32), rounds: 1 }));
const TO = 1792090683000n, FROM = TO - BigInt(SERVED_WINDOW_MS);
const SERVED = { fromMs: FROM, toMs: TO, nodes: NODES, root: 'ab'.repeat(32) };
const cid = (f) => createHash('sha256').update(JSON.stringify(f, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v))).digest('hex');
// a federation answering after a pause, as a real port does: two requests interleave at their awaits
const slowFed = (held) => ({ status: async (o) => { await new Promise((r) => setTimeout(r, 5)); const c = held.get(`${toHex(o.txid)}:${o.outIdx}`); return c ? { stored: { contractId: c } } : null; },
  contractId: async (f) => cid(f) });
function record(itemId, at = 0n) {
  const { outputs } = purchaseOutputs({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NET, gameSet: NET });
  const p = { gameDevPubkey: MANIFEST.gameDevPubkey, gameName: 'nextblock', itemId, priceSat: 500n, playerPubkey: BUYER, federationId: b32(0xfe),
    txid: b32(0x7a), servedFromMs: FROM, servedToMs: TO, servedRoot: b32(0xab), outputs: outputs.map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat })), boughtAtMs: TO + 60000n + at };
  return { ...p, signature: schnorr.sign(purchaseId(p), SECRET) };
}
// the federation holds the payment's contracts with this image: the purchase's commitment (new pages), or the buyer's key (old pages)
const paidWith = (p, image) => new Map(p.outputs.map((o) => [`${toHex(p.txid)}:${o.outIdx}`, cid({ paymentImage: { kind: 'hash', bytes: image }, amountMsat: o.msat, claimPk: o.pk, refundPk: o.pk, expiration: 0 })]));
const imageOf = (p) => (typeof purchase.purchaseImage === 'function' ? purchase.purchaseImage(p) : p.playerPubkey);
const base = { manifest: MANIFEST, networkSet: NET, gameSet: NET, served: SERVED, verify };

test('#1180: two records of one txid handed at once: one is kept, the other refused - not both "new"', async () => {
  const db = openStore(':memory:');
  const a = record('large-truck'), b = record('large-truck', 1n);    // one payment, two records (another bought-at time)
  const port = slowFed(paidWith(a, imageOf(a)));
  const rows = [];
  const [ra, rb] = await Promise.all([a, b].map((p) => keepItemPurchase({ ...base, db, p, port, keepDonations: (r) => rows.push(...r) })));
  console.log(`#1180 race: record A ${ra.ok ? ra.kept : `${ra.status} ${ra.why}`} | record B ${rb.ok ? rb.kept : `${rb.status} ${rb.why}`} | donation rows written ${rows.length}`);
  assert.deepEqual([ra.ok, ra.kept], [true, 'new']);
  assert.deepEqual([rb.ok, rb.status], [false, 409], 'the second record of that payment is refused');
  assert.equal(rows.length, a.outputs.length, 'one purchase\'s donation rows, once');
  assert.deepEqual(itemsOwned(db, { player: toHex(BUYER) }).map((o) => o.id), [toHex(purchaseId(a))]);
});

test('#1180: the payment names its item: a record for another item of the same price does not stand on it at another seat', async () => {
  const one = openStore(':memory:'), two = openStore(':memory:');
  const truck = record('large-truck'), paint = record('red-paint');
  const port = slowFed(paidWith(truck, imageOf(truck)));          // the buyer paid for the truck
  const r1 = await keepItemPurchase({ ...base, db: one, p: truck, port, legacyImage: false });
  const r2 = await keepItemPurchase({ ...base, db: two, p: paint, port, legacyImage: false });
  console.log(`#1180 one payment, two items at two seats: truck at seat 1 ${r1.ok ? r1.kept : r1.status} | paint at seat 2 ${r2.ok ? r2.kept : `${r2.status} ${r2.why}`}`);
  assert.deepEqual([r1.ok, r1.kept], [true, 'new']);
  assert.deepEqual([r2.ok, r2.status], [false, 422], 'the contracts name the truck');
  // an old page's payment (the buyer's key alone) is refused where the operator no longer takes them, and still read where it does
  const old = openStore(':memory:');
  const legacyPort = slowFed(paidWith(truck, BUYER));
  assert.equal((await keepItemPurchase({ ...base, db: old, p: truck, port: legacyPort, legacyImage: false })).status, 422);
  assert.equal((await keepItemPurchase({ ...base, db: old, p: truck, port: legacyPort, legacyImage: true })).kept, 'new', 'its failed claim was dropped: the retry is kept');
});

test('#1180: the purchase row\'s transition function: PENDING -> KEPT; KEPT never changes; a stale claim is taken again', () => {
  const { purchaseStep: step, PURCHASE_STATE: S, PURCHASE_PENDING_MS } = seat;
  const pending = { id: 'aa'.repeat(32), txid: '7a'.repeat(32), state: S.PENDING, kept_ms: 1000 };
  assert.deepEqual(step(null, { kind: 'claim', id: 'aa'.repeat(32) }, 1000), { ok: true, state: S.PENDING });
  assert.equal(step(pending, { kind: 'claim', id: 'bb'.repeat(32) }, 2000).status, 409, 'claimed by another record');
  assert.equal(step(pending, { kind: 'claim', id: 'aa'.repeat(32) }, 2000).status, 409, 'being checked');
  assert.equal(step(pending, { kind: 'claim', id: 'bb'.repeat(32) }, 1001 + PURCHASE_PENDING_MS).takeover, true, 'a crash\'s claim goes stale');
  assert.deepEqual(step(pending, { kind: 'keep', id: 'aa'.repeat(32) }, 2000), { ok: true, state: S.KEPT });
  const kept = { ...pending, state: S.KEPT };
  assert.equal(step(kept, { kind: 'keep', id: 'aa'.repeat(32) }, 2000).ok, false, 'kept once');
  assert.equal(step(kept, { kind: 'drop', id: 'aa'.repeat(32) }, 2000).ok, false, 'a kept purchase is never dropped');
  assert.equal(step(kept, { kind: 'claim', id: 'bb'.repeat(32) }, 10 ** 12).status, 409, 'nor taken over, however old');
});
