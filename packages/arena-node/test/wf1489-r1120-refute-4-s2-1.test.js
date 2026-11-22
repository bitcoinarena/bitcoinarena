// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute (skeptic 2) of #3069 / #3094 / #3096 (855ddc14e): the attacker is not the node's own door now but PEERS - three cheap
// bonded census nodes of one operator, each at its own advertised endpoint (the #2015 / #2049 threat: a testnet4 bond is faucet coin).
// Before 855ddc14e a witness had to sit in the round's committee, and the committee is part of what the trusted census seat confirms.
// 855ddc14e lets a door be a witness when ITS OWN /served lists it among the round's `attestors` - a list nothing checks: not the trusted
// seat, not the chain. So three sybils copy a real round the trusted seat holds (the node really seated, never served), list themselves (and
// the node) as its drawn attestors, and hand over whatever the node signs at check time: (a) an attestation, (b) on a plain game round, a FINAL.
// Both read "1 signed"; the honest committee witnesses hold nothing from the node.
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
const SEAT1K = 'cc'.repeat(32), W1K = '1e'.repeat(32), W2K = '2e'.repeat(32);
const SYB = ['5a', '5b', '5c'].map((x) => x.repeat(32)), SYBU = ['https://s1.example', 'https://s2.example', 'https://s3.example'];
const CENSUS = [{ node: NODE, endpoint: 'https://node.example', bondSats: '50000' }, { node: SEAT1K, endpoint: 'https://seat1.example', bondSats: '1000000' },
  { node: W1K, endpoint: 'https://w1.example', bondSats: '1000000' }, { node: W2K, endpoint: 'https://w2.example', bondSats: '1000000' },
  ...SYB.map((k, i) => ({ node: k, endpoint: SYBU[i], bondSats: '50000' }))];
const COMMITTEE = [NODE, SEAT1K, W1K, W2K];   // the real round: the node seated, it never sent anything
const seats = ['https://seat1.example', 'https://w1.example', 'https://w2.example', 'https://node.example', ...SYBU];
const dayOf = (url) => Math.round((Math.floor(NOW / DAY) * DAY - Number(new URL(url).searchParams.get('from'))) / DAY);
// what the node signs at check time
const selfAtt = (() => { const a = { roundId: fromHex(RID), outcome: 1, observedAtMs: BigInt(NOW - DAY) };
  return toHex(encodeAttestation({ ...a, signatures: [{ key: fromHex(NODE), signature: schnorr.sign(attestationBodyId(a), SECRET) }] })); })();
const selfFinal = toHex(signFinalSig({ roundId: fromHex(RID), entryId: sec(0x77), runId: sec(0x78), signerPubkey: fromHex(NODE), signedAtMs: BigInt(NOW - DAY) },
  (m) => schnorr.sign(m, SECRET)));
const run = (sybilRow) => nodeBountyCheck({ census: CENSUS, censusSeats: ['https://seat1.example'], node: NODE, seats, nowMs: NOW,
  fetchJson: async (url) => {
    if (url.endsWith('/owner')) return { node: NODE, claimed: false };
    if (!url.includes('/served') || dayOf(url) !== 1) return { held: [] };
    const i = SYBU.findIndex((s) => url.startsWith(s));
    if (i >= 0) return { node: SYB[i], held: [sybilRow] };
    if (url.startsWith('https://node.example')) return { node: NODE, held: [] };   // the node was offline: its door holds nothing
    // the honest committee seats: the round, nothing from the node
    return { held: [{ roundId: RID, committee: COMMITTEE, finals: [] }] };
  } });
const says = (r) => r.checks.find((x) => x.key === 'committees').says;

test('#1489 r1120-4-s2-1 (a): three bonded sybils listing themselves as attestors hand over an attestation the node signs at check time', async () => {
  const r = await run({ roundId: RID, committee: COMMITTEE, finals: [], attestors: [NODE, ...SYB, 'a1'.repeat(32), 'a2'.repeat(32), 'a3'.repeat(32)], attestations: [selfAtt] });
  console.log('  MEASURED r1120-4-s2-1 (a):', says(r), 'passes:', r.passes);
  assert.match(says(r), /0 signed/, `peers outside the committee, self-listed as attestors, made the round signed: ${says(r)}`);
});

test('#1489 r1120-4-s2-1 (b): the same sybils hand over a FINAL the node signs at check time on a plain game round', async () => {
  const r = await run({ roundId: RID, committee: COMMITTEE, finals: [selfFinal], attestors: [NODE, ...SYB] });
  console.log('  MEASURED r1120-4-s2-1 (b):', says(r), 'passes:', r.passes);
  assert.match(says(r), /0 signed/, `peers outside the committee, self-listed as attestors, made a FINAL round signed: ${says(r)}`);
});
