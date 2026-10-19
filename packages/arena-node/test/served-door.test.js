// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// GET /served: who served a round in a window, from the FINAL signatures a seat holds - the protocol's list exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { servedNodes } from '../../arena-protocol/src/served-nodes.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { b32, opts } from './window-fixture.js';

const SECRETS = [b32(0x41), b32(0x42), b32(0x43)];
const SEATS = SECRETS.map((s) => schnorr.getPublicKey(s));
const OUTSIDER = b32(0x49);

test('a seat answers who served from the FINALs it holds; an outsider\'s FINAL and one outside the window do not count', async () => {
  const store = openStore(':memory:');
  const now = Date.now();
  const final = (secret, rid, entry, atMs) => signFinalSig({ roundId: rid, entryId: b32(entry), runId: b32(0x77), signerPubkey: schnorr.getPublicKey(secret), signedAtMs: BigInt(atMs) },
    (d) => schnorr.sign(d, secret));
  const put = (rid, bytes, seenMs) => store.prepare('INSERT INTO final_sigs (round_id, entry_id, run_id, signer_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run(rid, bytes.subarray(35, 67), b32(0x77), bytes.subarray(99, 131), bytes, seenMs);
  const rounds = [b32(1), b32(2)];
  for (const rid of rounds) for (const k of SEATS) store.prepare('INSERT INTO signer_nodes (round_id, pubkey) VALUES (?, ?)').run(rid, k);
  // round 1: all three seats, an hour ago; round 2: seats 0 and 1 a minute ago, seat 2 two days ago, and an outsider's FINAL
  const held = new Map(rounds.map((r) => [toHex(r), []]));
  const keep = (rid, bytes, seenMs) => { held.get(toHex(rid)).push(bytes); put(rid, bytes, seenMs); };
  for (const s of SECRETS) keep(rounds[0], final(s, rounds[0], 1, now - 3600000), now - 3600000);
  for (const s of SECRETS.slice(0, 2)) keep(rounds[1], final(s, rounds[1], 1, now - 60000), now - 60000);
  keep(rounds[1], final(SECRETS[2], rounds[1], 2, now - 2 * 86400000), now - 2 * 86400000);
  keep(rounds[1], final(OUTSIDER, rounds[1], 3, now - 60000), now - 60000);
  const d = await serve(store, { port: 0, ...opts });
  try {
    const got = await (await fetch(`http://127.0.0.1:${d.port}/served?to=${now}`)).json();
    const k = (s) => toHex(schnorr.getPublicKey(s));
    assert.deepEqual(new Map(got.nodes.map((n) => [n.key, n.rounds])), new Map([[k(SECRETS[0]), 2], [k(SECRETS[1]), 2], [k(SECRETS[2]), 1]]));
    assert.equal(got.rounds, 2);
    assert.equal(got.refused, 1, 'the outsider');
    assert.equal(got.fromMs, String(now - 86400000));
    // the protocol's own list from the same FINALs has the same root
    const want = servedNodes({ rounds: rounds.map((r) => ({ roundId: r, committee: SEATS, finals: held.get(toHex(r)) })), fromMs: now - 86400000, toMs: now,
      verify: (sg, m, k) => schnorr.verify(sg, m, k) });
    assert.equal(got.root, want.root);
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/served?to=abc`)).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${d.port}/served?to=${now}&from=${now - 8 * 86400000}`)).status, 400);
    console.log(`  SERVED DOOR: ${got.nodes.map((n) => n.key.slice(0, 8) + '=' + n.rounds).join(' ')} root ${got.root.slice(0, 16)}`);
  } finally { await d.close(); }
});
