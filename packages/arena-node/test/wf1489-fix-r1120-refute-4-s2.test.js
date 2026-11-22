// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3109, #3110 (fix of refute r1120-4-s2): the honest path stays - a node DRAWN as attestor of a market round it is not seated on, the
// drawn list as the TRUSTED census seat's /served lists it, reads "1 signed" when three drawn attestors off the committee hand over its signature.
// The same three, when the trusted seat does not list them as drawn, are no witnesses at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeAttestation, attestationBodyId } from '../../arena-protocol/src/attested.js';

const sec = (b) => new Uint8Array(32).fill(b);
const SECRET = sec(0x2a), NODE = toHex(schnorr.getPublicKey(SECRET));
const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000, RID = toHex(new Uint8Array(32).fill(0x41));
const DS = [0x51, 0x52, 0x53, 0x54, 0x55, 0x56].map(sec), DK = DS.map((s) => toHex(schnorr.getPublicKey(s)));
const DRAWN = [NODE, ...DK];
const standing = (() => { const a = { roundId: fromHex(RID), outcome: 1, observedAtMs: BigInt(NOW - DAY) }, id = attestationBodyId(a);
  return toHex(encodeAttestation({ ...a, signatures: [SECRET, ...DS.slice(0, 4)].map((s) => ({ key: schnorr.getPublicKey(s), signature: schnorr.sign(id, s) })) })); })();
const SEAT1K = 'cc'.repeat(32), W1K = '1e'.repeat(32), W2K = '2e'.repeat(32), XK = 'dd'.repeat(32);
const DU = ['https://d1.example', 'https://d2.example', 'https://d3.example'];
const CENSUS = [{ node: NODE, endpoint: 'https://node.example', bondSats: '50000' }, { node: SEAT1K, endpoint: 'https://seat1.example', bondSats: '1000000' },
  { node: W1K, endpoint: 'https://w1.example', bondSats: '1000000' }, { node: W2K, endpoint: 'https://w2.example', bondSats: '1000000' },
  ...DU.map((u, i) => ({ node: DK[i], endpoint: u, bondSats: '1000000' }))];
const COMMITTEE = [SEAT1K, W1K, W2K, XK];   // the node is not seated: it was drawn as attestor
const seats = ['https://seat1.example', 'https://w1.example', 'https://w2.example', 'https://node.example', ...DU];
const dayOf = (url) => Math.round((Math.floor(NOW / DAY) * DAY - Number(new URL(url).searchParams.get('from'))) / DAY);
const run = (trustedLists) => nodeBountyCheck({ census: CENSUS, censusSeats: ['https://seat1.example'], node: NODE, seats, nowMs: NOW,
  fetchJson: async (url) => {
    if (url.endsWith('/owner')) return { node: NODE, claimed: false };
    if (!url.includes('/served') || dayOf(url) !== 1) return { held: [] };
    const i = DU.findIndex((s) => url.startsWith(s));
    if (i >= 0) return { node: DK[i], held: [{ roundId: RID, committee: COMMITTEE, finals: [], attestors: DRAWN, attestations: [standing] }] };
    // KANBAN #3118-#3121: the trusted seat holds the standing attestation it lists the market round for (a real /served lists a market round
    // only from the attestations it keeps) - the node's signature is read from that copy, the drawn attestors only confirm the round
    if (url.startsWith('https://seat1.example')) return { held: [{ roundId: RID, committee: COMMITTEE, finals: [], ...(trustedLists ? { attestors: DRAWN } : {}), attestations: [standing] }] };
    return { held: [] };
  } });
const says = (r) => r.checks.find((x) => x.key === 'committees').says;

test('#3109: drawn attestors off the committee, listed as drawn by the trusted seat, hand over the node\'s signature: 1 signed', async () => {
  const r = await run(true);
  console.log('  MEASURED fix-r1120-4-s2 listed:', says(r));
  assert.match(says(r), /^1 committees, 1 signed/);
});

test('#3109: the same peers, not listed as drawn by the trusted seat, are no witnesses', async () => {
  const r = await run(false);
  console.log('  MEASURED fix-r1120-4-s2 unlisted:', says(r));
  assert.match(says(r), /^0 committees, 0 signed/);
});
