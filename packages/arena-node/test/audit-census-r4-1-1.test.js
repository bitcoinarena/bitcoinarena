// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit census r4-1 #1: POST /present (server.js: seating.takePresent(await read(req)), body up to BODY_MOST = 8 MiB) hands the whole
// body to takePresent. A body that is no PRESENT fails to decode, verifyPresent refuses it, and takePresent remembers it in
// badPresents (#1565) as toHex(bytes) - the hex of the WHOLE body, up to 16 MiB a string, up to 8192 of them. A stranger posting
// distinct junk bodies one after another makes the seat keep every one of them in memory (8192 x 16 MiB): the seat runs out of memory.
// SAFE: a body that is not one PRESENT (132 bytes) is refused without being kept; what badPresents keeps per entry is bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatingAgent } from '../src/seating-agent.js';

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc');

test('junk POST /present bodies are not kept whole in memory by the refused-PRESENT cache', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE rounds (round_id BLOB, contract BLOB)');
  const secret = new Uint8Array(32).fill(1);
  const round = { db, pubkey: schnorr.getPublicKey(secret), get: () => null };
  const roster = { committeeFor: () => ({ ok: false, why: 'this seat holds no such round' }) };
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  const agent = seatingAgent({ round, roster, sign: (m) => schnorr.sign(m, secret), verify, fetcher: async () => new Response('{}'), nowMs: () => 0, leftNode: () => false });
  const MB = 1024 * 1024, POSTS = 48;
  gc(); const before = process.memoryUsage().heapUsed + process.memoryUsage().external;
  for (let i = 0; i < POSTS; i++) {
    const body = new Uint8Array(MB); body.fill(i + 1);          // a distinct junk body of 1 MiB each time (the door takes 8 MiB)
    const r = agent.takePresent(body);
    assert.equal(r.ok, false);
  }
  gc(); gc();
  const after = process.memoryUsage().heapUsed + process.memoryUsage().external;
  const grownMb = Math.round((after - before) / MB);
  console.log('  ', JSON.stringify({ posts: POSTS, bodyMb: 1, retainedMb: grownMb }));
  assert.ok(grownMb < 16, `${POSTS} junk 1 MiB POST /present bodies left ${grownMb} MiB held by the seat (the refused-PRESENT cache keeps each body's hex)`);
});
