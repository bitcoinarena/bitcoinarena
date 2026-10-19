// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODES THAT SERVED A ROUND IN THE LAST 24 HOURS: read from signed FINALs, the same list and root on every node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify as edVerify, createPublicKey } from 'node:crypto';
import { servedNodes, servedNodesRoot, servedNodesDiffer, SERVED_WINDOW_MS } from '../src/served-nodes.js';
import { signFinalSig } from '../src/final-sig.js';

const edKey = () => { const { privateKey, publicKey } = generateKeyPairSync('ed25519'); return { key: privateKey, pub: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) }; };
const verify = (sig, digest, key) => edVerify(null, Buffer.from(digest), createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key)]), format: 'der', type: 'spki' }), Buffer.from(sig));
const b32 = (n) => new Uint8Array(32).fill(n);
const NODES = Array.from({ length: 5 }, edKey);
const TO = 1792090683000n;                                   // the anchor block's time (testnet4 156660)
const FROM = TO - BigInt(SERVED_WINDOW_MS);
const final = (node, roundId, entry, atMs) => signFinalSig({ roundId, entryId: b32(entry), runId: b32(0x77), signerPubkey: node.pub, signedAtMs: atMs },
  (d) => new Uint8Array(sign(null, Buffer.from(d), node.key)));

test('a node counts once per round it signed FINAL for inside the window; the list and root are the same in any order', () => {
  const r1 = { roundId: b32(1), committee: NODES.slice(0, 3).map((n) => n.pub), finals: [] };
  const r2 = { roundId: b32(2), committee: NODES.slice(1, 4).map((n) => n.pub), finals: [] };
  const r3 = { roundId: b32(3), committee: NODES.slice(2, 5).map((n) => n.pub), finals: [] };
  for (const n of NODES.slice(0, 3)) r1.finals.push(final(n, r1.roundId, 0xa1, TO - 3600000n), final(n, r1.roundId, 0xa2, TO - 3500000n)); // two entries: one round
  for (const n of NODES.slice(1, 4)) r2.finals.push(final(n, r2.roundId, 0xb1, TO - 60000n));
  for (const n of NODES.slice(2, 5)) r3.finals.push(final(n, r3.roundId, 0xc1, FROM - 1n));                      // a day and a ms ago: not these 24 h
  const a = servedNodes({ rounds: [r1, r2, r3], fromMs: FROM, toMs: TO, verify });
  const b = servedNodes({ rounds: [r3, r2, { ...r1, finals: [...r1.finals].reverse() }], fromMs: FROM, toMs: TO, verify });
  assert.equal(a.root, b.root);
  assert.equal(a.rounds, 2);
  const hex = (n) => Buffer.from(n.pub).toString('hex');
  const want = new Map([[hex(NODES[0]), 1], [hex(NODES[1]), 2], [hex(NODES[2]), 2], [hex(NODES[3]), 1]]);
  assert.deepEqual(new Map(a.nodes.map((n) => [n.key, n.rounds])), want, 'node 4 served only outside the window');
  assert.deepEqual(a.nodes.map((n) => n.key), [...a.nodes.map((n) => n.key)].sort());
  assert.equal(a.root, Buffer.from(servedNodesRoot(a)).toString('hex'));
  assert.deepEqual(a.refused, []);
  console.log(`  SERVED: ${a.nodes.map((n) => n.key.slice(0, 8) + '=' + n.rounds).join(' ')} root ${a.root.slice(0, 16)}`);
});

test('a FINAL from outside the committee, about another round, or with a bad signature is refused by name', () => {
  const outsider = edKey();
  const r = { roundId: b32(9), committee: [NODES[0].pub], finals: [final(outsider, b32(9), 1, TO - 1n), final(NODES[0], b32(8), 1, TO - 1n)] };
  const forged = final(NODES[0], b32(9), 1, TO - 1n); forged[forged.length - 1] ^= 1; r.finals.push(forged);
  const got = servedNodes({ rounds: [r], fromMs: FROM, toMs: TO, verify });
  assert.deepEqual(got.nodes, []);
  assert.deepEqual(got.refused.map((x) => x.why.replace(/^[0-9a-f]{16}/, 'K')), ['K is not of this round\'s committee', `a FINAL about another round (${'08'.repeat(8)})`, 'K\'s FINAL does not verify']);
  assert.throws(() => servedNodes({ rounds: [], fromMs: TO, toMs: TO, verify }), /ends after it starts/);
  assert.throws(() => servedNodes({ rounds: [], fromMs: FROM, toMs: TO }), /needs a verifier/);
});

test('a claimed list that leaves a node out, adds one, or miscounts is shown exactly where it differs', () => {
  const r = { roundId: b32(5), committee: NODES.slice(0, 2).map((n) => n.pub), finals: NODES.slice(0, 2).map((n) => final(n, b32(5), 1, TO - 5n)) };
  const mine = servedNodes({ rounds: [r], fromMs: FROM, toMs: TO, verify });
  assert.deepEqual(servedNodesDiffer(mine, mine), []);
  const k = (i) => Buffer.from(NODES[i].pub).toString('hex');
  const claimed = { fromMs: FROM, toMs: TO, nodes: [{ key: k(0), rounds: 2 }, { key: k(4), rounds: 1 }] };
  assert.deepEqual(servedNodesDiffer(claimed, mine).map((d) => d.why).sort(),
    ['named with 1 round(s), and served none here', 'named with 2 round(s), and 1 here', 'served 1 round(s) here, and is left out']);
  assert.notEqual(Buffer.from(servedNodesRoot(claimed)).toString('hex'), mine.root);
  assert.throws(() => servedNodesRoot({ fromMs: FROM, toMs: TO, nodes: [{ key: k(0), rounds: 1 }, { key: k(0), rounds: 2 }] }), /listed twice/);
});

test('seats that each hold only their own rounds merge into one list: the same root whichever seats answer first, a forged FINAL adds nothing', async () => {
  const { mergeServedRounds } = await import('../src/served-nodes.js');
  const rA = { roundId: b32(0x21), committee: NODES.slice(0, 3).map((n) => n.pub) };
  const rB = { roundId: b32(0x22), committee: NODES.slice(2, 5).map((n) => n.pub) };
  const fA = NODES.slice(0, 3).map((n) => final(n, rA.roundId, 1, TO - 100n));
  const fB = NODES.slice(2, 5).map((n) => final(n, rB.roundId, 1, TO - 100n));
  const forged = final(NODES[0], rB.roundId, 1, TO - 100n);       // node 0 is not of rB's committee
  const seat1 = [{ ...rA, finals: fA.slice(0, 2) }];
  const seat2 = [{ ...rA, finals: fA.slice(1) }, { ...rB, finals: fB.slice(0, 1) }];
  const seat3 = [{ ...rB, finals: [...fB.slice(1), forged] }];
  const one = servedNodes({ rounds: mergeServedRounds([seat1, seat2, seat3]).rounds, fromMs: FROM, toMs: TO, verify });
  const two = servedNodes({ rounds: mergeServedRounds([seat3, seat1, seat2]).rounds, fromMs: FROM, toMs: TO, verify });
  assert.equal(one.root, two.root);
  assert.deepEqual(one.nodes.map((n) => n.rounds), [...one.nodes.map((n) => n.rounds)]);
  assert.equal(one.nodes.length, 5); assert.equal(one.rounds, 2);
  assert.equal(one.nodes.find((n) => n.key === Buffer.from(NODES[2].pub).toString('hex')).rounds, 2);
  assert.equal(one.refused.length, 1, 'the forged FINAL');
  const partial = servedNodes({ rounds: seat1, fromMs: FROM, toMs: TO, verify });
  assert.notEqual(partial.root, one.root, 'one seat alone sees less');
  const clash = mergeServedRounds([[{ ...rA, finals: fA }], [{ ...rA, committee: NODES.slice(1, 4).map((n) => n.pub), finals: [] }]]);
  assert.deepEqual([clash.rounds.length, clash.conflicts.length], [0, 1]);
});
