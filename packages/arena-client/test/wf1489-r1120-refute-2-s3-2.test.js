// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 refute of #3081 / #3105 (r1120 item 2, skeptic 3: second copies of the same logic).
// (1) THE FEDERATION GATE BEFORE THE REFUSAL: finishPurchase / finishGift read the guardians' refusal only when the page hands the wallet of
//     the record's own federation. The page hands the FIRST federation holding the price (buy) or the RICHEST one (donateWallets, sorted).
//     A payment T1 from F1 whose acceptance read failed once (network) and which the guardians then refused (feedback #360: the notes spent
//     in another tab, F1 now short) is answered "paid (transaction T1) from federation F1 ... nothing is paid again" on every press with F2,
//     forever: never paid, never bought, the #3081 symptom through a second door.
// (2) THE UNCONDITIONAL PUT, THE TWIN OF THE #3105 DROP: tab A's paySubmit answers late and paidRecordPut overwrites whatever the key holds
//     - tab B's paid T2 (B dropped A's unanswered write-ahead and the player pressed again); A's T1 is then refused and #3105's drop-if
//     sees "its own" T1 and drops the key: T2's paid record is gone, the next press pays a third time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { pointKey } from '../../arena-protocol/test/point-key-fixture.js';
import * as SRC_BUY from '../src/item-buy.js';
import * as SRC_GIFT from '../src/donation-gift-page.js';

const require = createRequire(import.meta.url);
const BUNDLES = { src: { buyItem: SRC_BUY.buyItem, giftDonation: SRC_GIFT.giftDonation }, dist: require('../dist/arena-client.js') };

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
const donor = { pubkey: schnorr.getPublicKey(BUYER), sign: (m) => schnorr.sign(m, BUYER) };
const ROUND = b32(0x5a);
const finals = NODES.map((s) => signFinalSig({ roundId: ROUND, entryId: b32(1), runId: b32(2), signerPubkey: schnorr.getPublicKey(s), signedAtMs: BigInt(NOW - 3600000) }, (d) => schnorr.sign(d, s)));
const REFUSAL = 'the guardians did not accept the lock transaction: The transaction had an invalid input: 2-The note is already spent';
const F1 = 'f1'.repeat(32), F2 = 'f2'.repeat(32);
const T1 = '11'.repeat(32);
const txidN = (n) => (0x20 + n).toString(16).padStart(2, '0').repeat(32);

const fetch = async (url) => {
  if (url.includes('/served?')) return { ok: true, json: async () => ({ held: [{ roundId: toHex(ROUND), committee: NODE_KEYS.map(toHex), finals: finals.map(toHex) }] }) };
  return { ok: false, status: 503, text: async () => 'down', json: async () => ({}) };
};
const shared = () => { const kept = new Map(); return { kept, storage: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k),
  key: (i) => [...kept.keys()][i] ?? null, get length() { return kept.size; } } }; };
const paidKeys = (kept) => [...kept.keys()].filter((k) => k.startsWith('arena.purchase.') || k.startsWith('arena.gift.'));
const asSubmitted = (txid, json) => { const outs = JSON.parse(json); return JSON.stringify({ txid, outputs: outs.map((o, i) => ({ out_idx: i, amount_msat: o.msat, recipient_pk: o.pk })), payouts: outs }); };
const accepted = (s) => { const j = JSON.parse(s); return JSON.stringify({ donations: j.outputs.map((o) => ({ ...o, txid: j.txid, ids_match: true })) }); };

// (1) F1's wallet: pays T1; its first acceptance read fails on the network, every later one is the guardians' refusal. F2's wallet pays anew.
function twoFederations() {
  const paid = [];
  let reads = 0;
  const f1 = { paySubmit: async (j) => { paid.push(T1); return asSubmitted(T1, j); },
    lockAccepted: async () => { reads++; if (reads === 1) throw new Error('fetch failed: network timeout'); throw new Error(REFUSAL); } };
  const f2 = { paySubmit: async (j) => { const t = txidN(paid.length); paid.push(t); return asSubmitted(t, j); }, lockAccepted: async (s) => accepted(s) };
  const walletOf = (fid) => (fid === F1 ? f1 : fid === F2 ? f2 : null);
  return { paid, f1, f2, walletOf, wallets: new Map([[F1, f1], [F2, f2]]) };
}

for (const [name, AC] of Object.entries(BUNDLES)) {
  // (2) tab A's paySubmit answers late; tab B dropped A's unanswered write-ahead, the player pressed again in B and paid T2 (accepted, seats down)
  test(`#3105 twin (${name}): tab A's late paySubmit answer overwrites T2's paid record, then T1's refusal drops it`, async () => {
    const { kept, storage } = shared();
    const paid = [];
    let gateOpen; const gate = new Promise((r) => { gateOpen = r; });
    let aWaiting; const aReached = new Promise((r) => { aWaiting = r; });
    const tabA = { paySubmit: async (j) => { aWaiting(); await gate; paid.push(T1); return asSubmitted(T1, j); }, lockAccepted: async (s) => { if (JSON.parse(s).txid === T1) throw new Error(REFUSAL); return accepted(s); } };
    const tabB = { paySubmit: async (j) => { const t = txidN(paid.length); paid.push(t); return asSubmitted(t, j); }, lockAccepted: async (s) => { if (JSON.parse(s).txid === T1) throw new Error(REFUSAL); return accepted(s); } };
    const base = { manifest: MANIFEST, itemId: 'large-truck', networkSet: NET, gameSet: NET, federationId: F1, player, seats: ['https://s1', 'https://s2'], fetch, verify, nowMs: () => NOW,
      bondedKeys: NODE_KEYS.map(toHex), storage };
    const pA = AC.buyItem({ ...base, wallet: tabA });
    await aReached;
    const b1 = await AC.buyItem({ ...base, wallet: tabB });   // A's write-ahead has no answer yet: dropped, "look at the wallet history"
    const b2 = await AC.buyItem({ ...base, wallet: tabB });   // pressed again: T2 paid and accepted, no seat keeps it yet
    const before = paidKeys(kept).map((k) => JSON.parse(kept.get(k)).submitted.txid);
    gateOpen();
    const a = await pA;
    const after = paidKeys(kept).map((k) => JSON.parse(kept.get(k)).submitted.txid);
    const b3 = await AC.buyItem({ ...base, wallet: tabB });
    const real = paid.filter((t) => t !== T1);
    console.log(`  FACTS put (${name}): b1 ${b1.step} | b2 paid=${b2.paid} ${String(b2.txid).slice(0, 6)} | kept before A ${JSON.stringify(before.map((t) => t.slice(0, 6)))} | A ${a.step} | kept after A ${JSON.stringify(after.map((t) => t.slice(0, 6)))} | b3 ${b3.ok ? 'ok' : b3.step} | accepted payments ${real.length}`);
    assert.equal(b2.paid, true, 'T2 paid, its record not kept by a seat yet');
    assert.deepEqual(after, [b2.txid], 'tab A\'s late put of T1 (then dropped on its refusal) erased the record of the paid T2');
    assert.equal(real.length, 1, 'one item, two accepted payments: the next press paid again because T2\'s record was gone');
  });
}
