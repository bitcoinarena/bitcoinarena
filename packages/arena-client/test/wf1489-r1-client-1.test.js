// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 r1 client-1: ONE SEAT'S /served ANSWER DOES NOT DECIDE WHO AN ITEM PURCHASE PAYS.
// The served list (who gets the nodes' half of an item's price) is merged from every seat's GET /served?finals=1. Each seat's
// answer carries the round's committee as the seat declares it, and servedNodes counts any FINAL signed by a key in that
// declared committee. So one seat can (a) invent a round whose "committee" is keys it made up, sign FINALs with them, and be paid
// for every one of them; (b) name a real round with another committee, so the merge drops that round and the honest nodes
// that served it are paid nothing. Safe: the nodes' half goes only to the nodes that really served (the honest seat's round).
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
const final = (round, s) => signFinalSig({ roundId: round, entryId: b32(1), runId: b32(2), signerPubkey: schnorr.getPublicKey(s), signedAtMs: BigInt(NOW - 3600000) }, (d) => schnorr.sign(d, s));
const honest = { roundId: toHex(ROUND), committee: NODE_KEYS.map(toHex), finals: NODES.map((s) => toHex(final(ROUND, s))) };
// the attacker's made-up keys: no bond, no seat, never on any committee
const SYBILS = Array.from({ length: 20 }, (_, i) => b32(0x90 + i));
const SYBIL_KEYS = SYBILS.map((s) => toHex(schnorr.getPublicKey(s)));
const FAKE_ROUND = b32(0xee);
const fake = { roundId: toHex(FAKE_ROUND), committee: SYBIL_KEYS, finals: SYBILS.map((s) => toHex(final(FAKE_ROUND, s))) };

function seats(badHeld) {
  const fetch = async (url) => {
    if (url.includes('/served?')) return { ok: true, json: async () => ({ held: url.startsWith('https://bad') ? badHeld : [honest] }) };
    if (url.endsWith('/item-purchase')) return { ok: true, status: 200, text: async () => '' };
    throw new Error(`no such door ${url}`);
  };
  return fetch;
}
function wallet() {
  const paid = [];
  return { paid, paySubmit: async (json) => { const outs = JSON.parse(json); paid.push(...outs); return JSON.stringify({ txid: '9a'.repeat(32), outputs: outs.map((o, i) => ({ out_idx: i, amount_msat: o.msat, recipient_pk: o.pk })) }); },
    lockAccepted: async (s) => { const j = JSON.parse(s); return JSON.stringify({ donations: j.outputs.map((o) => ({ ...o, ids_match: true })) }); } };
}
const paidTo = (paid, xonlyHex) => paid.filter((o) => String(o.pk).toLowerCase().endsWith(xonlyHex)).reduce((t, o) => t + BigInt(o.msat), 0n);

test('a seat that invents a round with its own made-up committee is paid nothing of the nodes\' half', async () => {
  const w = wallet();
  const r = await buyItem({ manifest: MANIFEST, itemId: 'large-truck', networkSet: NET, gameSet: NET, wallet: w, federationId: 'fe'.repeat(32),
    player, seats: ['https://good', 'https://bad'], fetch: seats([fake]), verify, nowMs: () => NOW });
  assert.equal(r.ok, true, r.why);
  const toSybils = SYBIL_KEYS.reduce((t, k) => t + paidTo(w.paid, k), 0n);
  assert.equal(toSybils, 0n, `${toSybils} msat of the buyer's payment went to ${SYBIL_KEYS.length} keys one seat made up`);
});

test('a seat that names a real round with another committee does not take the honest nodes\' share away', async () => {
  const w = wallet();
  const hijack = { roundId: toHex(ROUND), committee: [SYBIL_KEYS[0]], finals: [] };
  const r = await buyItem({ manifest: MANIFEST, itemId: 'large-truck', networkSet: NET, gameSet: NET, wallet: w, federationId: 'fe'.repeat(32),
    player, seats: ['https://good', 'https://bad'], fetch: seats([hijack, fake]), verify, nowMs: () => NOW });
  assert.equal(r.ok, true, r.why);
  for (const k of NODE_KEYS) assert.ok(paidTo(w.paid, toHex(k)) > 0n, `node ${toHex(k).slice(0, 16)} served the round and is paid nothing`);
});
