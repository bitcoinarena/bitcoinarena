// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 refute of fix:faucet:1 (70c049ea0): the node bounty checklist now needs NODE_BOUNTY_AGREE (3) listed seats holding the same round,
// but nothing checks the round is real or that the node is in any census. Three seats one operator runs (the unsigned rule kanban #1153 already
// rejected for money paths) invent a round naming a FRESH key the operator also holds, sign its FINAL with it - and the 10,000 sat bounty passes,
// for as many fresh keys as the operator likes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000;

test('#1489 refute-0-s1-1: three colluding seats pass the bounty for never-bonded fresh keys', async () => {
  let passed = 0;
  for (let i = 1; i <= 10; i++) {
    const SECRET = new Uint8Array(32).fill(0x40 + i), NODE = toHex(schnorr.getPublicKey(SECRET)), RID = toHex(new Uint8Array(32).fill(0x90 + i));
    const fin = toHex(signFinalSig({ roundId: fromHex(RID), entryId: new Uint8Array(32).fill(2), runId: new Uint8Array(32).fill(3), signerPubkey: fromHex(NODE), signedAtMs: BigInt(NOW - 1000) }, (d) => schnorr.sign(d, SECRET)));
    const EVIL = ['https://evil1.example', 'https://evil2.example', 'https://evil3.example'];
    const fetchJson = async (url) => (url.endsWith('/owner') ? { node: 'dd'.repeat(32), claimed: false }
      : EVIL.some((h) => url.startsWith(h)) ? { held: [{ roundId: RID, committee: [NODE], finals: [fin] }] } : { held: [] });
    const r = await nodeBountyCheck({ node: NODE, seats: ['https://honest1.example', 'https://honest2.example', 'https://honest3.example', 'https://honest4.example', ...EVIL], fetchJson, nowMs: NOW });
    if (r.passes) passed++;
    if (i === 1) console.log('  MEASURED refute-0-s1-1:', JSON.stringify(r.checks.map((c) => [c.key, c.ok, c.says])));
  }
  console.log(`  MEASURED refute-0-s1-1: ${passed} of 10 fresh never-bonded keys pass (no honest seat ever held their rounds)`);
  assert.equal(passed, 0, 'a key no honest seat ever saw in a committee, in no census, must not pass the node bounty');
});
