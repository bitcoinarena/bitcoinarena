// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4 census-2: ONE STRANGER'S POST /presents RUNS 4,096 BIP-340 VERIFIES ON THE SEAT'S EVENT LOOP, EVERY REQUEST.
// #1271 refuses PRESENTs of rounds the seat does not hold and of nodes not drawn before the verify, and #1565 keeps one PRESENT per
// (round, role, node) per body and remembers refused bytes. What is left: a seat holds hundreds of upcoming rounds (an RPS grid, the
// series it writes ahead), each drawing 9 nodes for 2 roles - all public (GET /rounds, the explorer). No drawn node has signed a PRESENT
// of a round whose seating window is still ahead, so a body of 4,096 PRESENTs, each naming a distinct (held round, role, drawn node)
// with 64 random signature bytes, passes every pre-check and costs 4,096 schnorr verifies; fresh random bytes defeat badPresents. No
// key, no bond, no rate limit: a loop of such posts holds the seat's loop, its seating tick misses its rounds' closes, and the rounds it
// was drawn for are seated without it (P5).
// SAFE: a body whose PRESENTs fail their signature check stops being checked after a small number of failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent, MAX_PRESENTS_PER_BATCH } from '../src/seating-agent.js';
import { encodeRoundContract, roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';
import { signPresent } from '../../arena-protocol/src/seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { contractFor } from './window-fixture.js';

const nodes = Array.from({ length: 9 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), endpoint: `http://seat-${i}` }; });
const START = 60500n;
const NOW = Number(START) - 600000;          // every held round's seating window still ahead

test('a stranger\'s POST /presents of junk PRESENTs for held rounds\' drawn nodes is not verified 4,096 times', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  // 228 upcoming rounds this seat holds (2 roles x 9 drawn = 18 PRESENT slots each: 4,104 >= one full batch)
  const held = new Map();
  for (let i = 0; i < 228; i++) {
    const c = { ...contractFor(nodes.slice(0, 7).map((n) => n.pubkey)), startTimeMs: START + BigInt(i) * 1000n };
    const bytes = encodeRoundContract(c), rid = roundIdOf(c);
    db.prepare('INSERT INTO rounds (round_id, contract) VALUES (?, ?)').run(rid, bytes);
    held.set(toHex(rid), { rid, bytes });
  }
  const round = { db, pubkey: nodes[0].pubkey, get: (id) => { const h = held.get(toHex(id)); return h ? { contract: h.bytes } : null; } };
  const drawn = nodes.map((n) => ({ pubkey: n.pubkey, advert: { endpoint: n.endpoint } }));
  const roster = { committeeFor: (id) => (held.has(toHex(id)) ? { ok: true, drawn } : { ok: false, why: 'this seat holds no such round' }) };
  let verifies = 0;
  const verify = (s, m, k) => { verifies++; try { return schnorr.verify(s, m, k); } catch { return false; } };
  const agent = seatingAgent({ round, roster, sign: (m) => schnorr.sign(m, nodes[0].secret), verify, fetcher: async () => new Response('{}'), nowMs: () => NOW, leftNode: () => false });
  // THE STRANGER'S BODY: one PRESENT per (held round, role, drawn node), random signature bytes
  const list = [];
  outer: for (const { rid } of held.values()) for (const role of ['game', 'settlement']) for (const n of nodes) {
    if (list.length >= MAX_PRESENTS_PER_BATCH) break outer;
    list.push(signPresent({ roundId: rid, role, nodePubkey: n.pubkey }, () => crypto.getRandomValues(new Uint8Array(64))));
  }
  const body = new Uint8Array(list.length * list[0].length); list.forEach((x, i) => body.set(x, i * x.length));
  const t0 = performance.now();
  const r = agent.takePresents(body);
  const ms = performance.now() - t0;
  console.log('  ONE POST /presents:', JSON.stringify({ presents: list.length, bytes: body.length, taken: r.taken, verifies, loopHeldMs: Math.round(ms) }));
  assert.equal(r.taken, 0);
  assert.ok(verifies <= 64, `one stranger's body of junk PRESENTs cost ${verifies} BIP-340 verifies (${Math.round(ms)} ms of the event loop)`);
});
