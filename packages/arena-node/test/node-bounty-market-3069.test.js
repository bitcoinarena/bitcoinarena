// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3069 (the owner 2026-11-20: "fix it"): a node seated only on Up/Down market rounds never signs a FINAL - a market round settles on an
// attested outcome - so the checklist read "not drawn into a committee". GET /served?finals=1 now hands over each market round's attestations,
// and the node's own valid signature in one counts like a signed FINAL; a forged or another node's signature does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeAttestation, attestationBodyId } from '../../arena-protocol/src/attested.js';

const SECRET = new Uint8Array(32).fill(0x2a), NODE = toHex(schnorr.getPublicKey(SECRET)), OTHER_SECRET = new Uint8Array(32).fill(0x3b);
const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000;
const rid = (d) => toHex(new Uint8Array(32).fill(0x40 + d));
const att = (d, secret) => { const a = { roundId: fromHex(rid(d)), outcome: 1, observedAtMs: BigInt(NOW - DAY * d) };
  const key = schnorr.getPublicKey(secret);
  return toHex(encodeAttestation({ ...a, signatures: [{ key, signature: schnorr.sign(attestationBodyId(a), secret) }] })); };
const W = ['https://w1.example', 'https://w2.example'], W1K = '1e'.repeat(32), W2K = '2e'.repeat(32), SEAT1K = 'cc'.repeat(32);
const CENSUS = [{ node: NODE, endpoint: 'https://node.example', bondSats: '1000000' }, { node: SEAT1K, endpoint: 'https://seat1.example', bondSats: '1000000' },
  { node: W1K, endpoint: W[0], bondSats: '1000000' }, { node: W2K, endpoint: W[1], bondSats: '1000000' }];
const seats = ['https://seat1.example', 'https://node.example', ...W];
const fake = (signer) => async (url) => {
  if (url.endsWith('/owner')) return { node: NODE, claimed: false };
  const from = Number(new URL(url).searchParams.get('from')), d = Math.round((Math.floor(NOW / DAY) * DAY - from) / DAY);
  return { held: d === 2 ? [{ roundId: rid(d), committee: [NODE, SEAT1K, W1K, W2K], finals: [], attestations: [att(d, signer)] }] : [] };
};

test('#3069: a market round the node attested counts as a signed committee round; another key\'s attestation does not', async () => {
  const run = (signer) => nodeBountyCheck({ census: CENSUS, censusSeats: ['https://seat1.example'], node: NODE, seats, fetchJson: fake(signer), nowMs: NOW });
  const mine = await run(SECRET), theirs = await run(OTHER_SECRET);
  const c = (r, k) => r.checks.find((x) => x.key === k);
  console.log('  MEASURED #3069:', JSON.stringify({ mine: [c(mine, 'committees').says, c(mine, 'online').ok], theirs: c(theirs, 'committees').says }));
  assert.equal(c(mine, 'committees').ok, true, c(mine, 'committees').says);
  assert.equal(c(mine, 'online').ok, true);
  assert.match(c(mine, 'committees').says, /1 signed/);
  assert.match(c(theirs, 'committees').says, /0 signed/);
});
