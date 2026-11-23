// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3069 (ff216bc05): node-bounty-check takes `attestations` from EVERY door it reads, the claimed node's own included
// (witness === n is still read, only not counted as a witness), and attestedBy checks only the round id and the node's own BIP-340 signature -
// not that the attestation stands (5 of the drawn attestors), not that any witness holds it, not its outcome. A node that sat on a real market
// round (confirmed by the trusted census seat and 2 witnesses) but never attested signs a made-up attestation (any outcome) at check time and
// serves it from its own /served: "1 signed". The witnesses hold no attestation from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeAttestation, attestationBodyId } from '../../arena-protocol/src/attested.js';

const sec = (b) => new Uint8Array(32).fill(b);
const SECRET = sec(0x2a), NODE = toHex(schnorr.getPublicKey(SECRET));
const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000, RID = toHex(new Uint8Array(32).fill(0x41));
const forged = (() => { const a = { roundId: fromHex(RID), outcome: 200, observedAtMs: 1n };   // an outcome out of range, observed at 1 ms
  return toHex(encodeAttestation({ ...a, signatures: [{ key: schnorr.getPublicKey(SECRET), signature: schnorr.sign(attestationBodyId(a), SECRET) }] })); })();
const honestKept = (() => { const a = { roundId: fromHex(RID), outcome: 1, observedAtMs: BigInt(NOW - DAY) }, s = [0x51, 0x52, 0x53, 0x54, 0x55].map(sec);
  return toHex(encodeAttestation({ ...a, signatures: s.map((x) => ({ key: schnorr.getPublicKey(x), signature: schnorr.sign(attestationBodyId(a), x) })) })); })();
const W = ['https://w1.example', 'https://w2.example'], W1K = '1e'.repeat(32), W2K = '2e'.repeat(32), SEAT1K = 'cc'.repeat(32);
const CENSUS = [{ node: NODE, endpoint: 'https://node.example', bondSats: '1000000' }, { node: SEAT1K, endpoint: 'https://seat1.example', bondSats: '1000000' },
  { node: W1K, endpoint: W[0], bondSats: '1000000' }, { node: W2K, endpoint: W[1], bondSats: '1000000' }];
const seats = ['https://seat1.example', 'https://node.example', ...W];
const dayOf = (url) => Math.round((Math.floor(NOW / DAY) * DAY - Number(new URL(url).searchParams.get('from'))) / DAY);

test('#1489 r1120-4-2: a self-signed attestation the node serves from its own door (no witness holds it) does not make a round signed', async () => {
  const fetchJson = async (url) => {
    if (url.endsWith('/owner')) return { node: NODE, claimed: false };
    if (dayOf(url) !== 1) return { held: [] };
    const own = url.startsWith('https://node.example');
    return { held: [{ roundId: RID, committee: [NODE, SEAT1K, W1K, W2K], finals: [], attestations: own ? [forged] : [honestKept] }] };
  };
  const r = await nodeBountyCheck({ census: CENSUS, censusSeats: ['https://seat1.example'], node: NODE, seats, nowMs: NOW, fetchJson });
  const says = r.checks.find((x) => x.key === 'committees').says;
  console.log('  MEASURED r1120-4-2:', says, 'passes:', r.passes);
  assert.match(says, /0 signed/, `a made-up attestation (outcome 200, observed at 1 ms) from the node's own door counted: ${says}`);
});
