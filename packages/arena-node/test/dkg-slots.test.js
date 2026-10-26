// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A ROUND THAT NAMES FEWER NODES THAN ITS SLOTS (kanban #675, measured 2026-10-26 07:4xZ on the 10-26 emergency Next Block grid: rounds
// naming 5 or 6 nodes for 7 slots, "no key after 158 runs - no committee threshold for 6 slots", so no claim key and no entry): the claim
// key's ceremony takes the threshold of the round's slots when the caller names it, and refuses one it cannot deal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { Dkg } from '../src/dkg.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';

const rand = (n) => new Uint8Array(randomBytes(n));
const curve = { ...feldmanGroup, tweakPoint };

function node(signerNodes, me) {
  const epochs = new Map();
  const round = { identity: { secret: rand(32) }, pubkey: signerNodes[me],
    epoch: (id) => epochs.get(Buffer.from(id).toString('hex')) || null,
    putEpoch: (row) => { epochs.set(Buffer.from(row.epochId).toString('hex'), row); },
    contributionsOf: () => [] };
  return new Dkg(round, { curve, random: rand });
}

test('a committee of 5 named nodes for 7 slots is dealt the slots\' threshold, 5, and not refused for its size', async () => {
  const five = Array.from({ length: 5 }, () => schnorr.getPublicKey(rand(32)));
  const refused = await node(five, 0).deal(five);
  assert.equal(refused.ok, false, 'by its size alone: no threshold');
  assert.match(refused.why, /no committee threshold for 5/);
  const dealt = await node(five, 0).deal(five, { needed: receiptsNeeded(7) });
  assert.equal(dealt.ok, true, dealt.why);
  assert.equal(dealt.contribution.commitments.length, 5, 'a polynomial for a threshold of 5');
});

test('a threshold above the nodes named cannot be dealt, said by name', async () => {
  const four = Array.from({ length: 4 }, () => schnorr.getPublicKey(rand(32)));
  const r = await node(four, 1).deal(four, { needed: 5 });
  assert.equal(r.ok, false);
  assert.match(r.why, /a threshold of 5 cannot be dealt to 4 signer nodes/);
});
