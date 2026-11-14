// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 v1 refute 28 skeptic 2: shared fixtures (a real round served by three nodes, a made-up key, a wallet that records what it pays).
import { readFileSync } from 'node:fs';
import { schnorr, secp256k1 } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import * as src from '../src/item-buy.js';
import * as gamesSrc from '../src/games.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk33 = (n) => secp256k1.getPublicKey(b32(n), true);   // real points: the donation set is checked (kanban #1896 re-check)
export const verify = (s, m, k) => schnorr.verify(s, m, k);
export const NOW = 1792090683000;
const NODES = [b32(0x31), b32(0x32), b32(0x33)];
export const NODE_KEYS = NODES.map((s) => toHex(schnorr.getPublicKey(s)));
export const MANIFEST = { gameDevPubkey: b32(0xde), gameName: 'nextblock', items: [{ id: 'large-truck', name: 'Larger truck', priceSat: 500n, unlock: b32(0xa1) }], requiredProtocolVersion: 10 };
export const NET = [{ recipientPk: pk33(0x11), label: 'dev a', shareBps: 6667 }, { recipientPk: pk33(0x12), label: 'dev b', shareBps: 3333 }];
const BUYER = b32(0x77);
export const player = { pubkey: schnorr.getPublicKey(BUYER), sign: (d) => schnorr.sign(d, BUYER) };
const ROUND = b32(0x5a);
const final = (round, s) => signFinalSig({ roundId: round, entryId: b32(1), runId: b32(2), signerPubkey: schnorr.getPublicKey(s), signedAtMs: BigInt(NOW - 3600000) }, (d) => schnorr.sign(d, s));
export const honest = { roundId: toHex(ROUND), committee: NODE_KEYS, finals: NODES.map((s) => toHex(final(ROUND, s))) };
const SYBIL = b32(0x90);
export const SYBIL_KEY = toHex(schnorr.getPublicKey(SYBIL));
export const hijack = { roundId: toHex(ROUND), committee: [SYBIL_KEY], finals: [toHex(final(ROUND, SYBIL))] };
export const listedGame = { id: toHex(NEXTBLOCK.gameId), name: NEXTBLOCK.name, title: NEXTBLOCK.name, icon: null, manifest: toHex(encodeManifest(NEXTBLOCK.manifest)) };

export function wallet() {
  const paid = [];
  return { paid, paySubmit: async (json) => { const outs = JSON.parse(json); paid.push(...outs); return JSON.stringify({ txid: '9a'.repeat(32), outputs: outs.map((o, i) => ({ out_idx: i, amount_msat: o.msat, recipient_pk: o.pk })) }); },
    lockAccepted: async (s) => { const j = JSON.parse(s); return JSON.stringify({ donations: j.outputs.map((o) => ({ ...o, ids_match: true })) }); } };
}
export const paidTo = (paid, xonlyHex) => paid.filter((o) => String(o.pk).toLowerCase().endsWith(xonlyHex)).reduce((t, o) => t + BigInt(o.msat), 0n);
export const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

// the page's bundle (what index.html runs) next to the source
const mod = { exports: null };
new Function('module', readFileSync(new URL('../dist/arena-client.js', import.meta.url), 'utf8'))(mod);
export const builds = [['src', { buyItem: src.buyItem, fetchGames: gamesSrc.fetchGames }], ['dist bundle', { buyItem: mod.exports.buyItem, fetchGames: mod.exports.fetchGames }]];
