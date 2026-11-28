// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 refute of #3081 (r1120 item 2, skeptic 2: two tabs, the retry path). The #3081 fix drops the kept paid record by its key
// (arena.purchase.<game>.<item>.<buyer16> / arena.gift.<donor16>.<to>.<sat>) when lockAccepted says the guardians refused - without looking
// at WHICH payment the key holds now. Two tabs of one player share localStorage (feedback #360's own setting): tab A still awaits the
// refusal of payment T1; tab B reads the same refusal first, drops the key, the player presses again in B, B pays T2 and keeps its record
// (no seat kept it yet). Then tab A's refusal of T1 arrives and drops the key again - now T2's paid record. Nothing is handed again on the
// next load, and the next press pays a THIRD time (T3): one item, two payments - the invariant of paid-records.js broken.
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
const T1 = '11'.repeat(32);

// the seats are down for now (503): a paid record must stay kept for the next load / press
const fetch = async (url) => {
  if (url.includes('/served?')) return { ok: true, json: async () => ({ held: [{ roundId: toHex(ROUND), committee: NODE_KEYS.map(toHex), finals: finals.map(toHex) }] }) };
  return { ok: false, status: 503, text: async () => 'down', json: async () => ({}) };
};

// one player's wallet: the payments it made (one txid each); T1 refused by the guardians, every later one accepted.
// `gate` holds back the refusal as tab A's (throttled, background) lock client sees it.
function wallets() {
  const paid = [];
  let gateOpen; const gate = new Promise((r) => { gateOpen = r; });
  let aWaiting; const aReached = new Promise((r) => { aWaiting = r; });
  const pay = async (json) => { const outs = JSON.parse(json); const txid = paid.length === 0 ? T1 : (paid.length + 0x20).toString(16).padStart(2, '0').repeat(32);
    paid.push(txid); return JSON.stringify({ txid, outputs: outs.map((o, i) => ({ out_idx: i, amount_msat: o.msat, recipient_pk: o.pk })), payouts: outs }); };
  const accepted = (s) => { const j = JSON.parse(s); return JSON.stringify({ donations: j.outputs.map((o) => ({ ...o, txid: j.txid, ids_match: true })) }); };
  const tabA = { paySubmit: pay, lockAccepted: async (s) => { aWaiting(); await gate; if (JSON.parse(s).txid === T1) throw new Error(REFUSAL); return accepted(s); } };
  const tabB = { paySubmit: pay, lockAccepted: async (s) => { if (JSON.parse(s).txid === T1) throw new Error(REFUSAL); return accepted(s); } };
  return { paid, tabA, tabB, aReached, open: () => gateOpen() };
}
const shared = () => { const kept = new Map(); return { kept, storage: { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k),
  key: (i) => [...kept.keys()][i] ?? null, get length() { return kept.size; } } }; };
const paidKeys = (kept) => [...kept.keys()].filter((k) => k.startsWith('arena.purchase.') || k.startsWith('arena.gift.'));

for (const [name, AC] of Object.entries(BUNDLES)) {
  test(`#3081 two tabs (${name}): a late refusal of T1 in tab A does not drop T2's paid record kept by tab B`, async () => {
    const { kept, storage } = shared();
    const w = wallets();
    const base = { manifest: MANIFEST, itemId: 'large-truck', networkSet: NET, gameSet: NET, federationId: 'fe'.repeat(32), player, seats: ['https://s1', 'https://s2'], fetch, verify, nowMs: () => NOW, bondedKeys: NODE_KEYS.map(toHex), drawnOf: async () => ({ keys: new Set([...NODE_KEYS].map((k) => (typeof k === 'string' ? k : toHex(k)))) }), storage };
    const pA = AC.buyItem({ ...base, wallet: w.tabA });          // tab A: pays T1, awaits its acceptance
    await w.aReached;
    const b1 = await AC.buyItem({ ...base, wallet: w.tabB });    // tab B: the kept T1 resumed, refused -> dropped
    const b2 = await AC.buyItem({ ...base, wallet: w.tabB });    // tab B: pressed again -> pays T2, no seat keeps it yet
    const before = paidKeys(kept).map((k) => JSON.parse(kept.get(k)).submitted.txid);
    w.open();
    const a = await pA;                                          // tab A: T1's refusal arrives late
    const after = paidKeys(kept).map((k) => JSON.parse(kept.get(k)).submitted.txid);
    const b3 = await AC.buyItem({ ...base, wallet: w.tabB });    // the next press
    console.log(`  FACTS (${name}): b1 ${b1.step} | b2 ${b2.step} paid=${b2.paid} txid ${String(b2.txid).slice(0, 8)} | kept before A ${JSON.stringify(before.map((t) => t.slice(0, 8)))} | A ${a.step}: ${String(a.why).slice(0, 60)} | kept after A ${JSON.stringify(after.map((t) => t.slice(0, 8)))} | b3 ${b3.step} | payments ${w.paid.length} ${JSON.stringify(w.paid.map((t) => t.slice(0, 8)))}`);
    assert.equal(b2.paid, true, 'T2 paid, its record not kept by a seat yet');
    assert.deepEqual(after, [b2.txid], 'tab A\'s late refusal of T1 dropped the record of the paid T2');
    assert.equal(w.paid.length, 2, 'one item paid twice: the next press paid again because T2\'s record was gone');
  });

  test(`#3081 two tabs (${name}): a late refusal of gift T1 in tab A does not drop gift T2's paid record`, async () => {
    const { kept, storage } = shared();
    const w = wallets();
    const base = { recipients: NET, sat: 21, federationId: 'fe'.repeat(32), donor, seats: ['https://s1.example', 'https://s2.example'], fetch, storage };
    const pA = AC.giftDonation({ ...base, wallet: w.tabA });
    await w.aReached;
    await AC.giftDonation({ ...base, wallet: w.tabB });
    const b2 = await AC.giftDonation({ ...base, wallet: w.tabB });
    w.open();
    await pA;
    const after = paidKeys(kept).map((k) => JSON.parse(kept.get(k)).submitted.txid);
    await AC.giftDonation({ ...base, wallet: w.tabB });
    console.log(`  FACTS gift (${name}): b2 paid=${b2.paid} | kept after A ${JSON.stringify(after.map((t) => t.slice(0, 8)))} | payments ${w.paid.length}`);
    assert.equal(b2.paid, true);
    assert.deepEqual(after, [b2.txid], 'tab A\'s late refusal of T1 dropped the record of the paid gift T2');
    assert.equal(w.paid.length, 2, 'the same gift paid twice');
  });
}
