// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1 refute 28 (kanban #1522 variant): mergeServedRounds counts a committee once per ENTRY, not once per SEAT. One seat
// that repeats a real round three times in its own /served answer, each time with a committee of one made-up key, outvotes two
// honest seats that name the real committee: the honest nodes are paid nothing and the made-up key takes the nodes' half.
// Safe: one seat's answer counts once for a round, however many times it lists it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { buyItem } from '../src/item-buy.js';
import { mergeServedRounds } from '../../arena-protocol/src/served-nodes.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { pointKey } from '../../arena-protocol/test/point-key-fixture.js';  // kanban #1675: fixture keys are curve points

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => pointKey(0x02, n);   // kanban #1675: a donation recipient key is a curve point
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
const SYBIL = b32(0x90), SYBIL_KEY = toHex(schnorr.getPublicKey(SYBIL));
const hijack = { roundId: toHex(ROUND), committee: [SYBIL_KEY], finals: [toHex(final(ROUND, SYBIL))] };

function wallet() {
  const paid = [];
  return { paid, paySubmit: async (json) => { const outs = JSON.parse(json); paid.push(...outs); return JSON.stringify({ txid: '9a'.repeat(32), outputs: outs.map((o, i) => ({ out_idx: i, amount_msat: o.msat, recipient_pk: o.pk })) }); },
    lockAccepted: async (s) => { const j = JSON.parse(s); return JSON.stringify({ donations: j.outputs.map((o) => ({ ...o, ids_match: true })) }); } };
}
const paidTo = (paid, xonlyHex) => paid.filter((o) => String(o.pk).toLowerCase().endsWith(xonlyHex)).reduce((t, o) => t + BigInt(o.msat), 0n);

test('the protocol merge: one seat listing a round three times does not outvote two seats', () => {
  const dec = (x) => ({ roundId: fromHex(x.roundId), committee: x.committee.map(fromHex), finals: x.finals.map(fromHex) });
  const m = mergeServedRounds([[dec(honest)], [dec(honest)], [dec(hijack), dec(hijack), dec(hijack)]]);
  assert.deepEqual(m.rounds[0].committee.map(toHex).sort(), NODE_KEYS.map(toHex).sort(), 'one seat\'s repeated entries outvoted two seats');
});

test('the page: a seat repeating a real round with its own committee does not take the honest nodes\' share', async () => {
  const w = wallet();
  const fetch = async (url) => {
    if (url.includes('/served?')) return { ok: true, json: async () => ({ held: url.startsWith('https://bad') ? [hijack, hijack, hijack] : [honest] }) };
    if (url.endsWith('/item-purchase')) return { ok: true, status: 200, text: async () => '' };
    throw new Error(`no such door ${url}`);
  };
  const r = await buyItem({ manifest: MANIFEST, itemId: 'large-truck', networkSet: NET, gameSet: NET, wallet: w, federationId: 'fe'.repeat(32),
    player, seats: ['https://good1', 'https://good2', 'https://bad'], fetch, verify, nowMs: () => NOW, bondedKeys: NODE_KEYS.map(toHex) });   // kanban #1896: the keys of a census the page checked
  assert.equal(r.ok, true, r.why);
  const toSybil = paidTo(w.paid, SYBIL_KEY);
  for (const k of NODE_KEYS) assert.ok(paidTo(w.paid, toHex(k)) > 0n, `node ${toHex(k).slice(0, 16)} served the round and is paid nothing (${toSybil} msat went to the one made-up key)`);
  assert.equal(toSybil, 0n);
});
