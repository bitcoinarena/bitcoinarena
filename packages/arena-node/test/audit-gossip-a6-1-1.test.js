// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT gossip a6-1-1: the funding signal's activeAt (server.js servedRoundsBetween) asks every network seat GET /served for one
// FUNDING_SCHEDULES.spec.week (1008 blocks) of median time. A 1008-block week whose blocks average more than 600 s is longer than
// 7 days, and every seat's GET /served refuses such a window (400 "a window of at most 7 days"), so servedRoundsBetween drops every
// peer answer silently and each seat counts only the FINALs it holds itself. The safe behaviour: the door answers the window its
// own network's funding reader asks for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { b32, opts } from './window-fixture.js';

const SECRETS = [b32(0x41), b32(0x42), b32(0x43)];
const SEATS = SECRETS.map((s) => schnorr.getPublicKey(s));

test('a seat answers GET /served for one funding week of 1008 blocks at 10.5 min a block (what activeAt asks every peer)', async () => {
  const store = openStore(':memory:');
  const now = Date.now();
  const rid = b32(1);
  for (const k of SEATS) store.prepare('INSERT INTO signer_nodes (round_id, pubkey) VALUES (?, ?)').run(rid, k);
  for (const s of SECRETS) {
    const bytes = signFinalSig({ roundId: rid, entryId: b32(1), runId: b32(0x77), signerPubkey: schnorr.getPublicKey(s), signedAtMs: BigInt(now - 3600000) },
      (d) => schnorr.sign(d, s));
    store.prepare('INSERT INTO final_sigs (round_id, entry_id, run_id, signer_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(rid, bytes.subarray(35, 67), b32(0x77), bytes.subarray(99, 131), bytes, now - 3600000);
  }
  const d = await serve(store, { port: 0, ...opts });
  try {
    // the window server.js activeAt reads: blockTimeAt(to) - blockTimeAt(to - week), median times; at 630 s a block 7.35 days
    const weekMs = FUNDING_SCHEDULES.spec.week * 630 * 1000;
    const r = await fetch(`http://127.0.0.1:${d.port}/served?to=${now}&from=${now - weekMs}&finals=1`);
    const body = await r.text();
    console.log(`  FUNDING WEEK ${(weekMs / 86400000).toFixed(2)} days: GET /served -> ${r.status} ${body.slice(0, 80)}`);
    assert.equal(r.status, 200, `the funding reader's week of ${(weekMs / 86400000).toFixed(2)} days is refused by every peer: ${body.slice(0, 120)}`);
    assert.equal(JSON.parse(body).held.length, 1);
  } finally { await d.close(); }
});
