// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute (skeptic 2) of #3069 / #3094 / #3096 (855ddc14e), the resume / reload path: 855ddc14e counts a COMMITTEE seat of a
// market round as signed when the round's outcome stands at NODE_BOUNTY_AGREE witnesses and "the node's own door keeps that same body".
// The own door is the node's own answer, and a standing attestation is public (GET /outcome, every seat's /served). A node seated on a
// market round that was offline the whole round - it never took the outcome, never signed a settlement - comes back (or never does: only
// its door answers at check time), copies the public standing attestation into its /served, and reads "1 signed". With the copy left out
// it reads "0 signed": nothing but the node's own word decides it. FINAL rounds need the node's FINAL held by OTHER nodes; this does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeAttestation, attestationBodyId } from '../../arena-protocol/src/attested.js';

const sec = (b) => new Uint8Array(32).fill(b);
const SECRET = sec(0x2a), NODE = toHex(schnorr.getPublicKey(SECRET));
const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000, RID = toHex(new Uint8Array(32).fill(0x41));
const DRAWN_S = [0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57].map(sec), DRAWN = DRAWN_S.map((s) => toHex(schnorr.getPublicKey(s)));
const standing = (() => { const a = { roundId: fromHex(RID), outcome: 1, observedAtMs: BigInt(NOW - DAY) }, id = attestationBodyId(a);
  return toHex(encodeAttestation({ ...a, signatures: DRAWN_S.slice(0, 5).map((s) => ({ key: schnorr.getPublicKey(s), signature: schnorr.sign(id, s) })) })); })();
const SEAT1K = 'cc'.repeat(32), W1K = '1e'.repeat(32), W2K = '2e'.repeat(32);
const CENSUS = [{ node: NODE, endpoint: 'https://node.example', bondSats: '50000' }, { node: SEAT1K, endpoint: 'https://seat1.example', bondSats: '1000000' },
  { node: W1K, endpoint: 'https://w1.example', bondSats: '1000000' }, { node: W2K, endpoint: 'https://w2.example', bondSats: '1000000' }];
const COMMITTEE = [NODE, SEAT1K, W1K, W2K];
const seats = ['https://seat1.example', 'https://w1.example', 'https://w2.example', 'https://node.example'];
const dayOf = (url) => Math.round((Math.floor(NOW / DAY) * DAY - Number(new URL(url).searchParams.get('from'))) / DAY);
const run = (ownCopy) => nodeBountyCheck({ census: CENSUS, censusSeats: ['https://seat1.example'], node: NODE, seats, nowMs: NOW,
  fetchJson: async (url) => {
    if (url.endsWith('/owner')) return { node: NODE, claimed: false };
    if (!url.includes('/served') || dayOf(url) !== 1) return { held: [] };
    const row = { roundId: RID, committee: COMMITTEE, finals: [], attestors: DRAWN, attestations: [standing] };
    if (url.startsWith('https://node.example')) return { node: NODE, held: ownCopy ? [row] : [] };
    return { held: [row] };
  } });
const says = (r) => r.checks.find((x) => x.key === 'committees').says;

test('#1489 r1120-4-s2-2: a seated node that was offline reads "signed" by copying the public standing attestation into its own door', async () => {
  const without = await run(false), copied = await run(true);
  console.log('  MEASURED r1120-4-s2-2:', JSON.stringify({ without: says(without), copied: says(copied), passes: copied.passes }));
  assert.match(says(without), /0 signed/);
  assert.match(says(copied), /0 signed/, `the node's own copy of a public attestation alone made the round signed: ${says(copied)}`);
});
