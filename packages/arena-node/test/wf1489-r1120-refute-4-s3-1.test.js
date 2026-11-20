// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute (skeptic 3) of #3069 / #3094 / #3096 / #3109 / #3110 (7bf303fad). The witnesses are now real COMMITTEE MATES of a real
// market round the trusted census seat holds - three cheap bonded nodes of the node's own operator that the draw seated beside it (the #2015
// threat: a testnet4 bond is faucet coin; with many bonds, four of one operator in one committee is a matter of time). The node was offline and
// signed nothing for the round. 7bf303fad checks only that the node's key signed SOME body for the round id, not that the body is one the round
// stood on (the trusted seat keeps only attestations that stand, server.js holdOutcome / attestationStands) - so the mates hand over:
//  (a) an attestation the node signs at check time - the node drawn (trusted list), never attested;
//  (b) the same, the node only a committee seat (NOT drawn) and the trusted seat on a build that lists no `attestors` (origin/main, the 2.0 line:
//      ff216bc05 only) - readAttestation then takes any key, and #3110's "a committee seat that was not drawn is not a signed round" is gone;
//  (c) a FINAL the node signs at check time for the MARKET round id - signerOf checks only round id + signature; a market round never has a FINAL,
//      so #3110 is bypassed even with the drawn list in place.
// Each must read "0 signed"; on 7bf303fad each reads "1 signed".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeAttestation, attestationBodyId } from '../../arena-protocol/src/attested.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';

const sec = (b) => new Uint8Array(32).fill(b);
const SECRET = sec(0x2a), NODE = toHex(schnorr.getPublicKey(SECRET));
const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000, RID = toHex(new Uint8Array(32).fill(0x41));
const SEAT1K = 'cc'.repeat(32);
const MATES = ['5a', '5b', '5c'].map((x) => x.repeat(32)), MU = ['https://m1.example', 'https://m2.example', 'https://m3.example'];
const CENSUS = [{ node: NODE, endpoint: 'https://node.example', bondSats: '50000' }, { node: SEAT1K, endpoint: 'https://seat1.example', bondSats: '1000000' },
  ...MATES.map((k, i) => ({ node: k, endpoint: MU[i], bondSats: '50000' }))];
const COMMITTEE = [NODE, SEAT1K, ...MATES];   // a real round the trusted seat sat on; the draw seated the node and three of its operator's nodes
const DS = [0x61, 0x62, 0x63, 0x64, 0x65, 0x66].map(sec), DK = DS.map((s) => toHex(schnorr.getPublicKey(s)));
// the round's real outcome: five honest drawn attestors signed it, the node did not
const standing = (() => { const a = { roundId: fromHex(RID), outcome: 0, observedAtMs: BigInt(NOW - DAY) }, id = attestationBodyId(a);
  return toHex(encodeAttestation({ ...a, signatures: DS.slice(0, 5).map((s) => ({ key: schnorr.getPublicKey(s), signature: schnorr.sign(id, s) })) })); })();
// what the node signs at check time
const selfAtt = (() => { const a = { roundId: fromHex(RID), outcome: 1, observedAtMs: BigInt(NOW - DAY) };
  return toHex(encodeAttestation({ ...a, signatures: [{ key: fromHex(NODE), signature: schnorr.sign(attestationBodyId(a), SECRET) }] })); })();
const selfFinal = toHex(signFinalSig({ roundId: fromHex(RID), entryId: sec(0x77), runId: sec(0x78), signerPubkey: fromHex(NODE), signedAtMs: BigInt(NOW - DAY) },
  (m) => schnorr.sign(m, SECRET)));
const seats = ['https://seat1.example', 'https://node.example', ...MU];
const dayOf = (url) => Math.round((Math.floor(NOW / DAY) * DAY - Number(new URL(url).searchParams.get('from'))) / DAY);
const run = ({ trustedAttestors, mateRow }) => nodeBountyCheck({ census: CENSUS, censusSeats: ['https://seat1.example'], node: NODE, seats, nowMs: NOW,
  fetchJson: async (url) => {
    if (url.endsWith('/owner')) return { node: NODE, claimed: false };
    if (!url.includes('/served') || dayOf(url) !== 1) return { held: [] };
    const i = MU.findIndex((s) => url.startsWith(s));
    if (i >= 0) return { node: MATES[i], held: [mateRow] };
    if (url.startsWith('https://node.example')) return { node: NODE, held: [] };   // the node was offline
    // the trusted seat: the round, its committee, the standing attestation it kept (nothing of the node's)
    return { node: SEAT1K, held: [{ roundId: RID, committee: COMMITTEE, finals: [], ...(trustedAttestors ? { attestors: trustedAttestors } : {}), attestations: [standing] }] };
  } });
const says = (r) => r.checks.find((x) => x.key === 'committees').says;

test('#1489 r1120-4-s3-1 (a): committee mates hand over an attestation the drawn-but-offline node signs at check time', async () => {
  const r = await run({ trustedAttestors: [NODE, ...DK], mateRow: { roundId: RID, committee: COMMITTEE, finals: [], attestations: [standing, selfAtt] } });
  console.log('  MEASURED r1120-4-s3-1 (a):', says(r), 'passes:', r.passes);
  assert.match(says(r), /0 signed/, `a body no trusted seat holds, signed at check time, made the round signed: ${says(r)}`);
});

test('#1489 r1120-4-s3-1 (b): a trusted seat listing no attestors (older build) - a committee seat NOT drawn reads signed', async () => {
  const r = await run({ trustedAttestors: null, mateRow: { roundId: RID, committee: COMMITTEE, finals: [], attestations: [standing, selfAtt] } });
  console.log('  MEASURED r1120-4-s3-1 (b):', says(r), 'passes:', r.passes);
  assert.match(says(r), /0 signed/, `with no drawn list every key counts, so an undrawn committee seat was signed: ${says(r)}`);
});

test('#1489 r1120-4-s3-1 (c): committee mates hand over a FINAL for the MARKET round, signed at check time by the undrawn node', async () => {
  const r = await run({ trustedAttestors: DK.concat(['a1'.repeat(32)]), mateRow: { roundId: RID, committee: COMMITTEE, finals: [selfFinal], attestations: [standing] } });
  console.log('  MEASURED r1120-4-s3-1 (c):', says(r), 'passes:', r.passes);
  assert.match(says(r), /0 signed/, `a market round never has a FINAL, yet a check-time FINAL made the undrawn seat signed: ${says(r)}`);
});
