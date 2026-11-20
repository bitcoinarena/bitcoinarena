// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Kept by kanban #3088 (wf1489 r1120 refute 2, s1): the #3081 fix carried into dist and the WebGL template with its bundle rebuild.
// KANBAN #1489 refute of #3081 (r1120 item 2): the fix is in src/item-buy.js and src/donation-gift-page.js, but the page runs the
// committed bundle (dist/arena-client.js and its copy in the WebGL template src/arena-ui/). Feedback #360's refusal is run against
// both bundles: a purchase / gift the guardians refuse must not be kept as "paid, acceptance not read yet".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { pointKey } from '../../arena-protocol/test/point-key-fixture.js';

const require = createRequire(import.meta.url);
const BUNDLES = { dist: require('../dist/arena-client.js'), template: require('../../../src/arena-ui/arena-client.js') };

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => pointKey(0x02, n);
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
const REFUSAL = 'the guardians did not accept the lock transaction: The transaction had an invalid input: 2-The note is already spent';
const fetch = async (url) => {
  if (url.includes('/served?')) return { ok: true, json: async () => ({ held: [{ roundId: toHex(ROUND), committee: NODE_KEYS.map(toHex), finals: finals.map(toHex) }] }) };
  if (url.endsWith('/item-purchase') || url.endsWith('/donation-gift')) return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  return new Response('{}', { status: 200 });
};
const refusing = {
  paySubmit: async (json) => { const outs = JSON.parse(json); return JSON.stringify({ txid: '9a'.repeat(32), outputs: outs.map((o, i) => ({ out_idx: i, amount_msat: o.msat, recipient_pk: o.pk })), payouts: outs }); },
  lockAccepted: async () => { throw new Error(REFUSAL); },
};
const store = () => { const kept = new Map(); return { kept, storage: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) } }; };

for (const [name, AC] of Object.entries(BUNDLES)) {
  test(`#3081 in the ${name} bundle: a purchase the guardians refuse is not kept as paid`, async () => {
    const { kept, storage } = store();
    const r = await AC.buyItem({ manifest: MANIFEST, itemId: 'large-truck', networkSet: NET, gameSet: NET, wallet: refusing, federationId: 'fe'.repeat(32),
      player, seats: ['https://s1'], fetch, verify, nowMs: () => NOW, bondedKeys: NODE_KEYS.map(toHex), storage });
    console.log(`  FACTS (${name} buyItem): ${JSON.stringify({ ok: r.ok, step: r.step, why: r.why })}; kept ${kept.size}`);
    assert.equal(r.ok, false);
    assert.match(r.why, /not paid: the federation refused the payment/, 'the page still says "paid, acceptance not read yet"');
    assert.equal(kept.size, 0, 'the refused purchase is still kept as paid, handed again forever');
  });
  test(`#3081 in the ${name} bundle: a gift the guardians refuse is not kept as paid`, async () => {
    const { kept, storage } = store();
    const donor = { pubkey: schnorr.getPublicKey(BUYER), sign: (m) => schnorr.sign(m, BUYER) };
    const r = await AC.giftDonation({ recipients: NET, sat: 21, wallet: refusing, federationId: 'fe'.repeat(32), donor, seats: ['https://s.example'], fetch, storage });
    console.log(`  FACTS (${name} giftDonation): ${JSON.stringify({ ok: r.ok, step: r.step, why: r.why })}; kept ${[...kept.keys()].filter((k) => !/ledger/i.test(k)).length}`);
    assert.equal(r.ok, false);
    assert.match(r.why, /not paid: the federation refused the payment/);
    assert.deepEqual([...kept.keys()].filter((k) => !/ledger/i.test(k)), []);
  });
}
