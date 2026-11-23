// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3147 (fixed: mergeServedRounds `drawn`, the census draw of each round). REFUTE of #3037 (cf68753f0): "one node alone makes no round" - but TWO bonded keys of one operator (two cheap testnet4 bonds) make up a
// round id, name themselves as its whole committee, each sign one FINAL, and both are listed as served - on the page and on the seat.
// The node bounty check met exactly this shape before (kanban #2015/#2049: "three bonded nodes of one operator made a round up among
// themselves") - SERVED_SIGNERS_MIN = 2 counts signers, never asks whether the committee is one a round could have (drawn, 7 slots, threshold).
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

test('two bonded keys of one operator get served credit from a round they invented with only themselves as committee', () => {
  const honest = Array.from({ length: 7 }, edKey);
  const a1 = edKey(), a2 = edKey();                          // one operator, two bonds, drawn into no round
  const bonded = new Set([...honest, a1, a2].map((n) => hex(n.pub)));
  const real = { roundId: b32(1), contract: b32(0xc1), committee: honest.map((n) => n.pub), finals: honest.map((n) => final(n, b32(1), TO - 60000n)) };
  // an honest 2-seat round (2-of-2): drawn, so it still counts
  const pair = { roundId: b32(2), contract: b32(0xc2), committee: [honest[0].pub, honest[1].pub], finals: [final(honest[0], b32(2), TO - 50000n), final(honest[1], b32(2), TO - 49000n)] };
  const fakes = Array.from({ length: 5 }, () => new Uint8Array(randomBytes(32)));
  const attackerAnswer = [real, ...fakes.map((f) => ({ roundId: f, contract: new Uint8Array(randomBytes(64)), committee: [a1.pub, a2.pub], finals: [final(a1, f, TO - 30000n), final(a2, f, TO - 29000n)] }))];
  // the census draw of each round, as the reader derives it from the round's contract (here: the two real rounds; nothing drew a1/a2)
  const draws = new Map([[hex(b32(1)), [hex(b32(0xc1)), new Set(real.committee.map(hex))]], [hex(b32(2)), [hex(b32(0xc2)), new Set(pair.committee.map(hex))]]]);
  const drawn = (rid, contract) => { const d = draws.get(hex(rid)); return d && contract && hex(contract) === d[0] ? d[1] : null; };
  for (const asPage of [false, true]) {
    const merged = mergeServedRounds(asPage ? [[real], [pair], attackerAnswer] : [[real], [real], [pair], attackerAnswer], { own: !asPage, bonded, drawn });
    const got = servedNodes({ rounds: merged.rounds, fromMs: FROM, toMs: TO, verify });
    const byKey = new Map(got.nodes.map((n) => [n.key, n.rounds]));
    console.log(`  ${asPage ? 'page' : 'seat'}: ${got.nodes.length} nodes listed, attacker keys rounds: ${byKey.get(hex(a1.pub))} / ${byKey.get(hex(a2.pub))}, honest node rounds: ${byKey.get(hex(honest[0].pub))}`);
    assert.ok(!byKey.has(hex(a1.pub)) && !byKey.has(hex(a2.pub)),
      `${asPage ? 'the page' : 'the seat'} lists two colluding bonded keys as served on ${byKey.get(hex(a1.pub))} invented rounds each (honest nodes: ${byKey.get(hex(honest[0].pub))})`);
    assert.equal(byKey.get(hex(honest[0].pub)), 2, 'an honest node is served on the 7-seat round and the drawn 2-of-2 round');
    assert.equal(byKey.get(hex(honest[2].pub)), 1);
  }
});
