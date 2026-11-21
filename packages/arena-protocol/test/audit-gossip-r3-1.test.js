// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT gossip r3-1: a BONDED seat that served no round names an invented round id with itself as the whole committee and one
// FINAL it signed itself in GET /served?finals=1. The #1896/#2739 bonded filter only asks that every committee key is bonded,
// so the invented round passes and the seat is listed as having served - it takes an equal share of every item purchase's
// nodes' half (and counts as ACTIVE for funding signals) without sitting on any round. Safe behaviour: a round no honest
// record holds, named by one seat with a committee it made up of itself, gives that seat no served credit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify as edVerify, createPublicKey, randomBytes } from 'node:crypto';
import { servedNodes, mergeServedRounds, SERVED_WINDOW_MS } from '../src/served-nodes.js';
import { signFinalSig } from '../src/final-sig.js';

const edKey = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
const verify = (sig, digest, key) => edVerify(null, Buffer.from(digest), createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const b32 = (n) => new Uint8Array(32).fill(n);
const hex = (b) => Buffer.from(b).toString('hex');
const TO = 1792090683000n, FROM = TO - BigInt(SERVED_WINDOW_MS);
const final = (node, roundId, atMs) => signFinalSig({ roundId, entryId: b32(0xe1), runId: b32(0x77), signerPubkey: node.pub, signedAtMs: atMs },
  (d) => new Uint8Array(sign(null, Buffer.from(d), node.key)));

test('a bonded seat that sat on no round gets no served credit from a round it invented with itself as committee', () => {
  const honest = Array.from({ length: 3 }, edKey);
  const attacker = edKey();                                  // bonded: in the census like every other node, but drawn into no round
  const bonded = new Set([...honest, attacker].map((n) => hex(n.pub)));
  // the honest record: one real round the three honest nodes sat on, each with its FINAL
  const real = { roundId: b32(1), committee: honest.map((n) => n.pub), finals: honest.map((n) => final(n, b32(1), TO - 60000n)) };
  const own = [real];
  const honestSeat = [real];
  // the attacker's answer: the real round as it is, plus a round id it made up, its committee the attacker alone, FINAL self-signed
  const fake = new Uint8Array(randomBytes(32));
  const attackerAnswer = [real, { roundId: fake, committee: [attacker.pub], finals: [final(attacker, fake, TO - 30000n)] }];
  for (const asPage of [false, true]) {
    const merged = mergeServedRounds(asPage ? [honestSeat, attackerAnswer] : [own, honestSeat, attackerAnswer], { own: !asPage, bonded });
    const got = servedNodes({ rounds: merged.rounds, fromMs: FROM, toMs: TO, verify });
    const keys = got.nodes.map((n) => n.key);
    console.log(`  ${asPage ? 'page' : 'seat'} served list: ${keys.map((k) => k.slice(0, 8)).join(' ')} (attacker ${hex(attacker.pub).slice(0, 8)})`);
    assert.ok(!keys.includes(hex(attacker.pub)),
      `${asPage ? 'the page' : 'the seat'} lists the attacker as having served on a round id it invented, committee itself alone (${got.rounds} rounds counted)`);
  }
});
