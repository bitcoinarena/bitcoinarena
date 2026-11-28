// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r40 gossip 2: #3147 HOLDS ON THE SEATS' FUNDING MERGE ONLY - NOT FOR ITEM PURCHASES (gap in #3147, money).
// #3147 (two bonded keys of one operator invent rounds naming only themselves as committee, each signs a FINAL, both are listed as
// served) was fixed with mergeServedRounds `drawn`, but item-buy.js servedFromSeats merges without it, and POST /item-purchase on the
// seat falls back to the undrawn merge (server.js "the page draws no committee yet ... Page side: follow-up"). So the page pays the
// two keys a share of the nodes' half of every item purchase on invented rounds, and every seat keeps the record.
// kanban #3867 (RULED 2026-11-28): the page draws every round it credits (census + beacon, pageDrawOf) and merges with `drawn` exactly as the seats
// do - a round whose committee is not its draw, or whose draw the page cannot verify, is not credited; no undrawn path.
// Safe behaviour: the page's served list does not credit keys whose only rounds are self-invented committees no census drew.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { servedFromSeats, pageDrawOf } from '../src/item-buy.js';
import { mergeServedRounds, servedNodes, undrawnRootTaken, UNDRAWN_PURCHASE_CUTOFF } from '../../arena-protocol/src/served-nodes.js';
import { encodePurchase, decodePurchase, purchaseId, PURCHASE_DRAWN_LAYOUT, PURCHASE_RESERVES_LAYOUT } from '../../arena-protocol/src/purchase.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex, fromHex as fromHexT } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const verify = (s, m, k) => schnorr.verify(s, m, k);
const NOW = 1792090683000;
const HONEST = [0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37].map(b32), A = [b32(0x51), b32(0x52)];   // A: one operator, two bonds
const pub = (s) => schnorr.getPublicKey(s);
const fin = (s, rid, at) => toHex(signFinalSig({ roundId: rid, entryId: b32(1), runId: b32(2), signerPubkey: pub(s), signedAtMs: BigInt(at) }, (d) => schnorr.sign(d, s)));

const CONTRACT = (n) => new Uint8Array(40).fill(n);   // stands in for a round's contract bytes: the draw stub below is keyed by round id
function world() {
  const realId = b32(0x5a);
  const real = { roundId: toHex(realId), committee: HONEST.map((s) => toHex(pub(s))), finals: HONEST.map((s) => fin(s, realId, NOW - 3600000)), contract: toHex(CONTRACT(1)) };
  const fakes = Array.from({ length: 10 }, (_, i) => b32(0x80 + i)).map((rid, i) => ({ roundId: toHex(rid), committee: A.map((s) => toHex(pub(s))),
    finals: A.map((s) => fin(s, rid, NOW - 60000 - i)), contract: toHex(CONTRACT(2)) }));
  const answers = { 'https://h1.example': [real], 'https://h2.example': [real], 'https://a.example': [real, ...fakes] };
  const fetch = async (url) => { const base = url.slice(0, url.indexOf('/served')); return { ok: true, json: async () => ({ held: answers[base] }) }; };
  const bondedKeys = [...HONEST, ...A].map((s) => toHex(pub(s)));
  // the census draw: every round of this census draws the seven honest nodes (an invented round id draws them too - never A1/A2 alone)
  const draw = async () => ({ keys: new Set(HONEST.map((s) => toHex(pub(s)))), threshold: 5 });
  return { answers, fetch, bondedKeys, draw, real, fakes };
}

test('#3867 the page credits only drawn committees: the 10 invented rounds of A1/A2 are not credited, the 7 honest nodes are listed', async () => {
  const w = world();
  const got = await servedFromSeats({ seats: Object.keys(w.answers), toMs: NOW, fetch: w.fetch, verify, bondedKeys: w.bondedKeys, drawnOf: w.draw });
  assert.ok(got.ok, got.why);
  const by = new Map(got.served.nodes.map((n) => [n.key, n.rounds]));
  console.log(`  FACTS (#3867): page served list ${got.served.nodes.length} nodes; A1 ${by.get(toHex(pub(A[0]))) || 0}, A2 ${by.get(toHex(pub(A[1]))) || 0} rounds; each honest ${by.get(toHex(pub(HONEST[0])))}`);
  assert.equal(got.served.nodes.length, 7);
  assert.ok(!by.has(toHex(pub(A[0]))) && !by.has(toHex(pub(A[1]))));
});

test('#3867 page root == seat root: the seats\' drawn merge of the same answers gives the root the page paid', async () => {
  const w = world();
  const got = await servedFromSeats({ seats: Object.keys(w.answers), toMs: NOW, fetch: w.fetch, verify, bondedKeys: w.bondedKeys, drawnOf: w.draw });
  const held = Object.values(w.answers).map((a) => a.map((x) => ({ roundId: fromHexT(x.roundId), committee: x.committee.map(fromHexT), finals: x.finals.map(fromHexT), contract: fromHexT(x.contract) })));
  const keys = new Set(HONEST.map((s) => toHex(pub(s))));
  const seat = servedNodes({ rounds: mergeServedRounds(held, { own: false, bonded: new Set(w.bondedKeys), drawn: () => ({ keys, threshold: 5 }) }).rounds, fromMs: BigInt(NOW) - 86400000n, toMs: BigInt(NOW), verify });
  assert.equal(seat.root, got.served.root);
});

test('#3867 a round whose draw the page cannot verify is left out, not credited; with no draw at all nothing is read', async () => {
  const w = world();
  const none = await servedFromSeats({ seats: Object.keys(w.answers), toMs: NOW, fetch: w.fetch, verify, bondedKeys: w.bondedKeys, drawnOf: async () => null });
  assert.equal(none.ok, false);
  assert.match(none.why, /no node served/);
  const blind = await servedFromSeats({ seats: Object.keys(w.answers), toMs: NOW, fetch: w.fetch, verify, bondedKeys: w.bondedKeys });
  assert.equal(blind.ok, false);
  assert.match(blind.why, /cannot draw/);
  // and the page's draw itself: a contract that does not decode, or a draw that fails, is null
  const d = pageDrawOf({ seats: ['https://h1.example'], curve: {}, fetch: w.fetch, draw: async () => ({ ok: false, why: 'census not loaded' }) });
  assert.equal(await d(w.real.roundId, CONTRACT(1)), null);
});

test('#3867 a drawn round is credited only with its committee\'s threshold of signers', async () => {
  const w = world();
  const few = { ...w.real, finals: w.real.finals.slice(0, 4) };   // 4 of a 5-of-7
  const answers = { 'https://h1.example': [few], 'https://h2.example': [few] };
  const fetch = async (url) => { const base = url.slice(0, url.indexOf('/served')); return { ok: true, json: async () => ({ held: answers[base] }) }; };
  const got = await servedFromSeats({ seats: Object.keys(answers), toMs: NOW, fetch, verify, bondedKeys: w.bondedKeys, drawnOf: w.draw });
  assert.equal(got.ok, false, 'four signers of a five-of-seven round credit nobody');
});

test('#3867 the purchase record: layout 37 marks a drawn root (no fallback); an earlier layout is kept undrawn only below the named cutoff', () => {
  const p = { gameDevPubkey: b32(1), gameName: 'g', itemId: 'i', priceSat: 500n, devsPct: 40, gameId: b32(2), reserveKey: Uint8Array.of(2, ...b32(3)),
    playerPubkey: b32(4), federationId: b32(5), txid: b32(6), servedFromMs: 1n, servedToMs: 2n, servedRoot: b32(7),
    outputs: [{ outIdx: 0, pk: Uint8Array.of(2, ...b32(8)), msat: 1000n }], boughtAtMs: 3n };
  const old = encodePurchase(p), drawn = encodePurchase({ ...p, drawn: true });
  assert.equal(old[1] * 256 + old[2], PURCHASE_RESERVES_LAYOUT, 'an unmarked record is layout 12, as before');
  assert.equal(drawn[1] * 256 + drawn[2], PURCHASE_DRAWN_LAYOUT);
  assert.equal(decodePurchase(drawn).drawn, true);
  assert.equal(decodePurchase(old).drawn, undefined);
  assert.notEqual(toHex(purchaseId({ ...p, drawn: true })), toHex(purchaseId(p)));
  assert.equal(undrawnRootTaken({ drawn: true, network: 'testnet4', height: 1 }), false, 'a drawn purchase is never kept undrawn');
  assert.equal(undrawnRootTaken({ drawn: false, network: 'testnet4', height: 1 }), true, 'no cutoff named yet: an old purchase is kept as today');
  assert.equal(UNDRAWN_PURCHASE_CUTOFF.testnet4, null);
  const cut = { testnet4: 100 };
  assert.equal(undrawnRootTaken({ drawn: false, network: 'testnet4', height: 99, cutoffs: cut }), true, 'before the cutoff');
  assert.equal(undrawnRootTaken({ drawn: false, network: 'testnet4', height: 100, cutoffs: cut }), false, 'from the cutoff: refused');
});
