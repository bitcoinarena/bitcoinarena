// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ITEM ON THE RESERVES' TERMS BOUGHT FROM THE PAGE: a game version requiring protocol 11 - the page takes the
// federation's reserve key only when five of the game's nodes name it, pays 20 % of the list price to it in the same transaction, and
// signs a layout-12 record naming the key and the version; with no key from five nodes it pays nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { buyItem, itemTermsOf, itemShareOn, itemPriceOn } from '../src/item-buy.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { decodePurchase, purchaseStands, PURCHASE_RESERVES_LAYOUT } from '../../arena-protocol/src/purchase.js';
import { gameIdOf } from '../../arena-protocol/src/manifest.js';
import { RESERVES_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { MANIFEST_V3 } from '../../nextblock/plugin/nextblock-v3.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => Uint8Array.from([0x02, ...b32(n)]);
const verify = (s, m, k) => schnorr.verify(s, m, k);
const NOW = 1792090683000;
const NODES = [b32(0x31), b32(0x32), b32(0x33)];
const NODE_KEYS = NODES.map((s) => schnorr.getPublicKey(s));
const V4 = { ...MANIFEST_V3, version: 4, requiredProtocolVersion: RESERVES_VERSION, signature: new Uint8Array(64) };
const NET = [{ recipientPk: pk33(0x11), label: 'dev a', shareBps: 6667 }, { recipientPk: pk33(0x12), label: 'dev b', shareBps: 3333 }];
const BUYER = b32(0x77);
const player = { pubkey: schnorr.getPublicKey(BUYER), sign: (d) => schnorr.sign(d, BUYER) };
const ROUND = b32(0x5a);
const FED = 'fe'.repeat(32);
const RESERVE = pk33(0xc3);
const SEATS = ['https://s1', 'https://s2', 'https://s3', 'https://s4', 'https://s5', 'https://s6', 'https://s7'];
const finals = NODES.map((s) => signFinalSig({ roundId: ROUND, entryId: b32(1), runId: b32(2), signerPubkey: schnorr.getPublicKey(s), signedAtMs: BigInt(NOW - 3600000) }, (d) => schnorr.sign(d, s)));

function seatsWith({ naming = 7 } = {}) {
  const posted = [];
  const fetch = async (url, o = {}) => {
    if (url.endsWith('/reserves')) { const i = Number(url.match(/s(\d)/)[1]);
      return { ok: true, json: async () => ({ federations: [{ federationId: FED, key: i <= naming ? toHex(RESERVE) : null }] }) }; }
    if (url.includes('/served?')) return { ok: true, json: async () => ({ held: [{ roundId: toHex(ROUND), committee: NODE_KEYS.map(toHex), finals: finals.map(toHex) }] }) };
    if (url.endsWith('/item-purchase')) { posted.push(JSON.parse(o.body)); return { ok: true, status: 200, text: async () => '' }; }
    throw new Error(`no such door ${url}`);
  };
  return { fetch, posted };
}
const paid = [];
const walletPaying = () => ({
  paySubmit: async (json) => { const outs = JSON.parse(json); paid.push(outs); return JSON.stringify({ txid: '9a'.repeat(32), outputs: outs.map((o, i) => ({ out_idx: i, amount_msat: o.msat, recipient_pk: o.pk })) }); },
  lockAccepted: async (s) => { const j = JSON.parse(s); return JSON.stringify({ donations: j.outputs.map((o) => ({ ...o, ids_match: true })) }); },
});

test('the terms: version 4 (protocol 11) sells at nodes 40 %, reserves 20 %, shares 40 .. 0; a kept 50 % is 40; 500 sat at 40 %, 300 at 0 %', () => {
  assert.deepEqual([itemTermsOf(V4).reserves, itemTermsOf(V4).shares], [true, [40, 30, 20, 10, 0]]);
  assert.deepEqual([itemTermsOf(MANIFEST_V3).reserves, itemTermsOf(MANIFEST_V3).shares], [false, [50, 40, 30, 20, 10, 0]]);
  assert.deepEqual([itemShareOn(V4, 50), itemShareOn(V4, 20), itemShareOn(MANIFEST_V3, 50)], [40, 20, 50]);
  assert.deepEqual([itemPriceOn(V4, 500n, 40), itemPriceOn(V4, 500n, 0), itemPriceOn(MANIFEST_V3, 500n, 0)], [500n, 300n, 250n]);
});

test('bought on version 4: 100,000 msat to the reserve key five nodes name, the layout-12 record names it and stands', async () => {
  const { fetch, posted } = seatsWith();
  const r = await buyItem({ manifest: V4, itemId: 'large-truck', networkSet: NET, gameSet: NET, wallet: walletPaying(), federationId: FED, player, seats: SEATS, fetch, verify, nowMs: () => NOW });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.devsPct, r.paidSat, r.reserveKey, r.reserveMsat], [40, 500n, toHex(RESERVE), 100000n]);
  const bytes = fromHex(posted[0].purchase);
  assert.equal((bytes[1] << 8) | bytes[2], PURCHASE_RESERVES_LAYOUT);
  const p = { ...decodePurchase(bytes), signature: fromHex(posted[0].signature) };
  assert.deepEqual([toHex(p.reserveKey), toHex(p.gameId)], [toHex(RESERVE), toHex(gameIdOf(V4))]);
  assert.deepEqual(p.outputs.filter((o) => toHex(o.pk) === toHex(RESERVE)).map((o) => o.msat), [100000n]);
  const served = { fromMs: p.servedFromMs, toMs: p.servedToMs, nodes: NODE_KEYS.map((k) => ({ key: toHex(k), rounds: 1 })).sort((a, b) => (a.key < b.key ? -1 : 1)), root: toHex(p.servedRoot) };
  assert.equal(purchaseStands(p, { manifest: V4, networkSet: NET, gameSet: NET, served, verify, reserveKey: RESERVE }).ok, true);
});

test('no reserve key from five nodes: refused at "reserves", and nothing is paid; a 50 % share on version 4 is refused', async () => {
  const before = paid.length;
  const { fetch, posted } = seatsWith({ naming: 4 });
  const r = await buyItem({ manifest: V4, itemId: 'large-truck', networkSet: NET, gameSet: NET, wallet: walletPaying(), federationId: FED, player, seats: SEATS, fetch, verify, nowMs: () => NOW });
  assert.deepEqual([r.ok, r.step], [false, 'reserves']); assert.match(r.why, /only 4 of the round's signer nodes name reserve key/);
  assert.equal(paid.length, before, 'no payment'); assert.equal(posted.length, 0);
  const odd = await buyItem({ manifest: V4, itemId: 'large-truck', networkSet: NET, gameSet: NET, wallet: walletPaying(), federationId: FED, player, seats: SEATS, fetch, verify, nowMs: () => NOW, devsPct: 50 });
  assert.deepEqual([odd.ok, odd.step], [false, 'share']);
});
