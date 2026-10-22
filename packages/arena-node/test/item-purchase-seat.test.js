// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ITEM PURCHASE, AS A SEAT KEEPS IT: its own terms, then every output with the federation; one payment, one purchase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { keepItemPurchase, itemsOwned } from '../src/item-purchase-seat.js';
import { purchaseOutputs, purchaseId } from '../../arena-protocol/src/purchase.js';
import { ITEMS_VERSION } from '../../arena-protocol/src/constants.js';
import { SERVED_WINDOW_MS } from '../../arena-protocol/src/served-nodes.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => Uint8Array.from([0x02, ...b32(n)]);
const SECRET = b32(0x77), BUYER = schnorr.getPublicKey(SECRET);
const verify = (s, m, k) => schnorr.verify(s, m, k);
const MANIFEST = { gameDevPubkey: b32(0xde), gameName: 'nextblock', items: [{ id: 'large-truck', name: 'Larger truck', priceSat: 500n, unlock: b32(0xa1) }], requiredProtocolVersion: ITEMS_VERSION };
const NET = [{ recipientPk: pk33(0x11), label: 'dev a', shareBps: 6667 }, { recipientPk: pk33(0x12), label: 'dev b', shareBps: 3333 }];
const NODES = Array.from({ length: 7 }, (_, i) => ({ key: (i + 1).toString(16).padStart(2, '0').repeat(32), rounds: 1 }));
const TO = 1792090683000n, FROM = TO - BigInt(SERVED_WINDOW_MS);
const SERVED = { fromMs: FROM, toMs: TO, nodes: NODES, root: 'ab'.repeat(32) };
// a federation that holds, at each outpoint, the contract whose id is the hash of its fields
const cid = (f) => createHash('sha256').update(JSON.stringify(f, (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v))).digest('hex');
const fedWith = (held) => ({ status: async (o) => { const c = held.get(`${toHex(o.txid)}:${o.outIdx}`); return c ? { stored: { contractId: c } } : null; }, contractId: async (f) => cid(f) });

function bought(txid = b32(0x7a)) {
  const { outputs } = purchaseOutputs({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NET, gameSet: NET });
  const p = { gameDevPubkey: MANIFEST.gameDevPubkey, gameName: 'nextblock', itemId: 'large-truck', priceSat: 500n, playerPubkey: BUYER, federationId: b32(0xfe),
    txid, servedFromMs: FROM, servedToMs: TO, servedRoot: b32(0xab), outputs: outputs.map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat })), boughtAtMs: TO + 60000n };
  return { ...p, signature: schnorr.sign(purchaseId(p), SECRET) };
}
const heldFor = (p) => new Map(p.outputs.map((o) => [`${toHex(p.txid)}:${o.outIdx}`, cid({ paymentImage: { kind: 'hash', bytes: p.playerPubkey }, amountMsat: o.msat, claimPk: o.pk, refundPk: o.pk, expiration: 0 })]));

test('a purchase whose outputs the federation holds is kept once, and is the buyer\'s ownership', async () => {
  const db = openStore(':memory:');
  const p = bought();
  const args = { p, manifest: MANIFEST, networkSet: NET, gameSet: NET, served: SERVED, port: fedWith(heldFor(p)), db, verify };
  const a = await keepItemPurchase(args);
  assert.deepEqual([a.ok, a.kept, a.id], [true, 'new', toHex(purchaseId(p))]);
  assert.equal((await keepItemPurchase(args)).kept, 'held', 'handed again: the same purchase');
  const owned = itemsOwned(db, { player: toHex(BUYER) });
  assert.deepEqual(owned.map((o) => [o.gameName, o.itemId, o.txid]), [['nextblock', 'large-truck', toHex(p.txid)]]);
  assert.deepEqual(itemsOwned(db, { player: toHex(BUYER), gameName: 'other' }), []);
  assert.deepEqual(itemsOwned(db, { player: 'cd'.repeat(32) }), [], 'not transferable: nobody else owns it');
});

test('refused by name: outputs the federation does not hold, or holds otherwise; a payment counted twice; a record that does not stand', async () => {
  const db = openStore(':memory:');
  const p = bought();
  const base = { manifest: MANIFEST, networkSet: NET, gameSet: NET, served: SERVED, db, verify };
  const none = await keepItemPurchase({ ...base, p, port: fedWith(new Map()) });
  assert.deepEqual([none.ok, none.status], [false, 409]); assert.match(none.why, /holds nothing at/);
  const wrong = heldFor(p); wrong.set(`${toHex(p.txid)}:0`, 'ff'.repeat(32));
  const bad = await keepItemPurchase({ ...base, p, port: fedWith(wrong) });
  assert.deepEqual([bad.ok, bad.status], [false, 422]); assert.match(bad.why, /is not \d+ msat to key/);
  assert.equal((await keepItemPurchase({ ...base, p, port: fedWith(heldFor(p)) })).ok, true);
  // the same transaction under another record (signed again with another bought-at time)
  const again = { ...p, boughtAtMs: p.boughtAtMs + 1n }; again.signature = schnorr.sign(purchaseId(again), SECRET);
  const twice = await keepItemPurchase({ ...base, p: again, port: fedWith(heldFor(p)) });
  assert.deepEqual([twice.ok, twice.status], [false, 409]); assert.match(twice.why, /one payment is one purchase/);
  const unsigned = await keepItemPurchase({ ...base, p: { ...bought(b32(0x7b)), signature: new Uint8Array(64) }, port: fedWith(new Map()) });
  assert.deepEqual([unsigned.ok, unsigned.status], [false, 422]); assert.match(unsigned.why, /signature does not verify/);
  const noFed = await keepItemPurchase({ ...base, p: bought(b32(0x7c)), port: null });
  assert.deepEqual([noFed.ok, noFed.status], [false, 503]);
});

// THE BUYER'S DEVELOPERS' SHARE (2026-10-16: "fully optional ... Node fees are never optional"): a 0 % purchase pays
// the seven nodes alone - 250 sat - and a seat keeps it as the buyer's, the record handed as the page sends it (decoded from its bytes)
test('a purchase at 0 % - the nodes alone, 250 sat - is kept as the buyer\'s, read back from its bytes as the door reads it', async () => {
  const { decodePurchase, encodePurchase } = await import('../../arena-protocol/src/purchase.js');
  const db = openStore(':memory:');
  const { outputs } = purchaseOutputs({ priceSat: 500n, servedKeys: NODES.map((n) => n.key), networkSet: NET, gameSet: NET, devsPct: 0 });
  assert.equal(outputs.length, 7);
  assert.equal(outputs.reduce((t, o) => t + o.msat, 0n), 249998n, '7 x 35714 msat');
  const rec = { gameDevPubkey: MANIFEST.gameDevPubkey, gameName: 'nextblock', itemId: 'large-truck', priceSat: 500n, devsPct: 0, playerPubkey: BUYER, federationId: b32(0xfe),
    txid: b32(0x7d), servedFromMs: FROM, servedToMs: TO, servedRoot: b32(0xab), outputs: outputs.map((o, i) => ({ outIdx: i, pk: o.pk, msat: o.msat })), boughtAtMs: TO + 60000n };
  const signature = schnorr.sign(purchaseId(rec), SECRET);
  const p = { ...decodePurchase(encodePurchase(rec)), signature };
  const a = await keepItemPurchase({ p, manifest: MANIFEST, networkSet: NET, gameSet: NET, served: SERVED, port: fedWith(heldFor(p)), db, verify });
  assert.deepEqual([a.ok, a.kept], [true, 'new'], a.why);
  assert.deepEqual(itemsOwned(db, { player: toHex(BUYER) }).map((o) => o.itemId), ['large-truck']);
});

test('every output of a purchase is a donation row naming its game and item, grouped later by both (kanban #578)', async () => {
  const { donationRowsOf, itemOfRow, itemLabel } = await import('../src/item-purchase-seat.js');
  const pk = (n) => new Uint8Array(33).fill(n);
  const p = { txid: new Uint8Array(32).fill(7), federationId: new Uint8Array(32).fill(3), playerPubkey: new Uint8Array(32).fill(9), gameName: 'Tick Tock, Next Block', itemId: 'turbo',
    outputs: [{ outIdx: 0, pk: pk(2), msat: 4000n }, { outIdx: 1, pk: pk(4), msat: 6000n }] };
  const rows = donationRowsOf(p, 'ab'.repeat(32), (i) => `c${i}`);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.item, r.contractId, r.amountMsat, r.roundId.every((x) => x === 0)]), [['Tick Tock, Next Block · turbo', 'c0', 4000n, true], ['Tick Tock, Next Block · turbo', 'c1', 6000n, true]]);
  assert.deepEqual(itemOfRow(itemLabel('Tick Tock, Next Block', 'turbo')), { game: 'Tick Tock, Next Block', item: 'turbo' });
  assert.equal(itemOfRow('no separator'), null);
});
