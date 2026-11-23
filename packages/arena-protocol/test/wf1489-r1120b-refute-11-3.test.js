// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// REFUTE of #3037 (cf68753f0), the honest path: #3037 exempts the reader's OWN record (`own`) from SERVED_SIGNERS_MIN but the page has no
// own record (item-buy.js, own: false). A real round the seat sat on where only its own FINAL is held in the window (its committee mates
// went offline before answering GET /final-sig, or their FINALs fell outside the window) is credited by the seat (server.js: own record
// first) and refused by the page. The page pays the nodes' half under its root, the seat rebuilds another one, and POST /item-purchase
// answers 422 after the payment went out (the #2912 failure shape). Before #3037 both counted it and the roots agreed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify as edVerify, createPublicKey } from 'node:crypto';
import { servedNodes, mergeServedRounds, SERVED_WINDOW_MS } from '../src/served-nodes.js';
import { signFinalSig } from '../src/final-sig.js';

const edKey = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
const verify = (sig, digest, key) => edVerify(null, Buffer.from(digest), createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const TO = 1792090683000n, FROM = TO - BigInt(SERVED_WINDOW_MS);
const final = (node, roundId, atMs) => signFinalSig({ roundId, entryId: b32(0xe1), runId: b32(0x77), signerPubkey: node.pub, signedAtMs: atMs },
  (d) => new Uint8Array(sign(null, Buffer.from(d), node.key)));

test('the seat and the page build the same served root over a real round whose other FINALs are not held in the window', () => {
  const committee = Array.from({ length: 7 }, edKey);
  const bonded = new Set(committee.map((n) => hex(n.pub)));
  const full = { roundId: b32(1), committee: committee.map((n) => n.pub), finals: committee.map((n) => final(n, b32(1), TO - 60000n)) };
  // round 2: seat 0 signed its FINAL in the window; its mates' FINALs are not held (offline, or signed after the window's end)
  const lone = { roundId: b32(2), committee: committee.map((n) => n.pub), finals: [final(committee[0], b32(2), TO - 1000n)] };
  const seat0 = [full, lone], seat1 = [full];
  const atSeat = servedNodes({ rounds: mergeServedRounds([seat0, seat0, seat1], { bonded }).rounds, fromMs: FROM, toMs: TO, verify });
  const atPage = servedNodes({ rounds: mergeServedRounds([seat0, seat1], { own: false, bonded }).rounds, fromMs: FROM, toMs: TO, verify });
  const c0 = (g) => (g.nodes.find((n) => n.key === hex(committee[0].pub)) || {}).rounds;
  console.log(`  seat root ${atSeat.root.slice(0, 16)} (seat 0: ${c0(atSeat)} rounds), page root ${atPage.root.slice(0, 16)} (seat 0: ${c0(atPage)} rounds)`);
  assert.equal(atPage.root, atSeat.root, 'the page pays under one served root and the seat rebuilds another: the item purchase is refused after the payment');
});
