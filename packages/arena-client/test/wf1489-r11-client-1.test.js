// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round r11 (client): ONE seat, first in the game's list, answers 200 to POST /item-purchase and keeps nothing (never
// hands it on). The page takes that one 200 as "kept" and stops: no other seat ever gets the record, GET /items needs two seats to
// name a purchase, so the item the player paid for never shows and never plays. Safe: the record reaches the other seats too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { buyItem } from '../src/item-buy.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => Uint8Array.from([0x02, ...b32(n)]);
const verify = (s, m, k) => schnorr.verify(s, m, k);
const NOW = 1792090683000;
const NODES = [b32(0x31), b32(0x32), b32(0x33)];
const NODE_KEYS = NODES.map((s) => schnorr.getPublicKey(s));
const MANIFEST = { gameDevPubkey: b32(0xde), gameName: 'nextblock', items: [{ id: 'large-truck', name: 'Larger truck', priceSat: 500n, unlock: b32(0xa1) }], requiredProtocolVersion: 10 };
const NET = [{ recipientPk: pk33(0x11), label: 'dev a', shareBps: 6667 }, { recipientPk: pk33(0x12), label: 'dev b', shareBps: 3333 }];
const BUYER = b32(0x77);
const player = { pubkey: schnorr.getPublicKey(BUYER), sign: (d) => schnorr.sign(d, BUYER) };
const ROUND = b32(0x5a);
const finals = NODES.map((s) => signFinalSig({ roundId: ROUND, entryId: b32(1), runId: b32(2), signerPubkey: schnorr.getPublicKey(s), signedAtMs: BigInt(NOW - 3600000) }, (d) => schnorr.sign(d, s)));
const wallet = {
  paySubmit: async (json) => { const outs = JSON.parse(json); return JSON.stringify({ txid: '9a'.repeat(32), outputs: outs.map((o, i) => ({ out_idx: i, amount_msat: o.msat, recipient_pk: o.pk })), payouts: outs }); },
  lockAccepted: async (s) => { const j = JSON.parse(s); return JSON.stringify({ donations: j.outputs.map((o) => ({ ...o, ids_match: true })) }); },
};

test('a paid item record is not left with the one seat that says 200 first (it reaches the other seats too)', async () => {
  const postedTo = [];
  const fetch = async (url, o = {}) => {
    if (url.includes('/served?')) return { ok: true, json: async () => ({ held: [{ roundId: toHex(ROUND), committee: NODE_KEYS.map(toHex), finals: finals.map(toHex) }] }) };
    if (url.endsWith('/item-purchase')) { postedTo.push(new URL(url).host); return { ok: true, status: 200, text: async () => '', json: async () => ({ kept: 'new' }) }; }
    throw new Error(`no such door ${url}`);
  };
  const r = await buyItem({ manifest: MANIFEST, itemId: 'large-truck', networkSet: NET, gameSet: NET, wallet, federationId: 'fe'.repeat(32),
    player, seats: ['https://evil', 'https://s2', 'https://s3'], fetch, verify, nowMs: () => NOW });
  assert.equal(r.ok, true, r.why);
  // the evil seat said 200 and dropped the record: unless another seat holds it, the purchase never reaches the two GET /items needs
  assert.ok(postedTo.filter((h) => h !== 'evil').length >= 1, `the paid record went only to ${JSON.stringify(postedTo)} - one lying seat buries the purchase`);
});
