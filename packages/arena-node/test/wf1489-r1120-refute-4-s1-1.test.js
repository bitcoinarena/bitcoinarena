// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3069 (ff216bc05): GET /served?finals=1 names a market round's committee as round.signerNodes (the game +
// settlement draw, roster.js assignSignerNodes), but the keys that sign a btc-updown attestation are the round's 7 DRAWN ATTESTORS
// (roster.attestorsFor -> sortition.js drawAttestors: "drawn ... on their own seed ... and not the settlement committee"; drawn-attestor.js
// wordFor signs only when selfKey is among them; combine keeps 5). node-bounty-check counts "signed" only when the node is in the committee
// AND its key is in the attestation - two independent draws. So:
//  (a) a node seated on market rounds but not drawn as their attestor: N committees, 0 signed - the #3069 symptom stays;
//  (b) a node that DID attest (its BIP-340 signature in the stored attestation) on a round whose committee it is not on: never counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeAttestation, attestationBodyId } from '../../arena-protocol/src/attested.js';

const sec = (b) => new Uint8Array(32).fill(b);
const SECRET = sec(0x2a), NODE = toHex(schnorr.getPublicKey(SECRET));
const ATTESTORS = [0x51, 0x52, 0x53, 0x54, 0x55].map(sec);           // the round's drawn attestors (5 of 7 combined)
const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000;
const rid = (d, x = 0) => toHex(new Uint8Array(32).fill(0x40 + d + x));
const att = (roundHex, secrets) => { const a = { roundId: fromHex(roundHex), outcome: 1, observedAtMs: BigInt(NOW - DAY) };
  const id = attestationBodyId(a);
  return toHex(encodeAttestation({ ...a, signatures: secrets.map((s) => ({ key: schnorr.getPublicKey(s), signature: schnorr.sign(id, s) })) })); };
const W = ['https://w1.example', 'https://w2.example'], W1K = '1e'.repeat(32), W2K = '2e'.repeat(32), SEAT1K = 'cc'.repeat(32);
const CENSUS = [{ node: NODE, endpoint: 'https://node.example', bondSats: '1000000' }, { node: SEAT1K, endpoint: 'https://seat1.example', bondSats: '1000000' },
  { node: W1K, endpoint: W[0], bondSats: '1000000' }, { node: W2K, endpoint: W[1], bondSats: '1000000' }];
const seats = ['https://seat1.example', 'https://node.example', ...W];
const dayOf = (url) => Math.round((Math.floor(NOW / DAY) * DAY - Number(new URL(url).searchParams.get('from'))) / DAY);
const run = (held) => nodeBountyCheck({ census: CENSUS, censusSeats: ['https://seat1.example'], node: NODE, seats, nowMs: NOW,
  fetchJson: async (url) => (url.endsWith('/owner') ? { node: NODE, claimed: false } : { held: dayOf(url) === 1 ? held : [] }) });
const c = (r, k) => r.checks.find((x) => x.key === k);

test('#1489 r1120-4 (a): a node seated on 3 market rounds whose attestors were drawn apart from it still reads 0 signed', async () => {
  // what a seat's /served?finals=1 hands over for a btc-updown round: committee = signer_nodes, attestation = the 5 drawn attestors' combine
  const held = [0, 1, 2].map((x) => ({ roundId: rid(1, x * 8), committee: [NODE, SEAT1K, W1K, W2K], finals: [], attestations: [att(rid(1, x * 8), ATTESTORS)] }));
  const r = await run(held);
  console.log('  MEASURED r1120-4 (a):', c(r, 'committees').says, 'passes:', r.passes);
  assert.equal(c(r, 'committees').ok, true, `a node that sat on market committees is not counted: ${c(r, 'committees').says}`);
});

test('#1489 r1120-4 (b): a node that attested a market round (its signature in the kept attestation) but is not on its committee is never counted', async () => {
  const held = [{ roundId: rid(1), committee: [SEAT1K, W1K, W2K, 'dd'.repeat(32)], finals: [], attestations: [att(rid(1), [SECRET, ...ATTESTORS.slice(0, 4)])] }];
  const r = await run(held);
  console.log('  MEASURED r1120-4 (b):', c(r, 'committees').says, c(r, 'census').says);
  assert.equal(c(r, 'committees').ok, true, `the node's own attestation of a market round counts for nothing: ${c(r, 'committees').says}`);
});
