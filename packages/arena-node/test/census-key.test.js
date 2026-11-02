// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS KEY AT A SIZE A TEST CAN HOLD (kanban #972, spec 5A.3B). The figures are tools/census-key-measure.mjs's. This holds the
// parts true at 15 nodes: a key by weight signs what a BIP-340 verifier takes, one share short does not, the reshare keeps the public key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  weightsFor, shareMap, thresholdOf, weightedKeygen, signersFor, signByShare, signByNode, verifies, reshare, plainDkg, weightedRefusals,
} from '../tools/census-key-measure.mjs';

const message = () => new Uint8Array(randomBytes(32));

test('one share per weight, threshold 2/3 of the shares', () => {
  assert.deepEqual(weightsFor(5, 10), [10, 5, 3, 2, 2]);
  assert.deepEqual(shareMap([2, 1, 3]), [[1, 2], [3], [4, 5, 6]]);
  assert.deepEqual([15, 32, 96, 357, 1000].map(thresholdOf), [10, 22, 64, 238, 667]);
});

test('dkg.js as it stands signs at 15 nodes of weight 1, and refuses a key twice: that is the weighted census', async () => {
  const r = await plainDkg(15);
  const m = message();
  const run = signByShare({ ...r.key, needed: r.needed }, m, Array.from({ length: r.needed }, (_, i) => ({ node: i, list: [i + 1] })));
  assert.equal(verifies(run.sig, m, r.key), true);
  const refused = weightedRefusals();
  assert.match(refused.epoch, /two signer nodes of that committee are one key/);
  assert.match(refused.accept, /two signer nodes of that contribution are one key/);
});

test('a weighted key signs both ways, under BIP-340; one share short signs nothing', async () => {
  const key = await weightedKeygen({ weights: weightsFor(15, 10) });
  assert.deepEqual([key.total, key.needed], [32, 22]);
  const m = message();
  const signers = signersFor(key);
  assert.equal(signers.flatMap((x) => x.list).length, 22);
  assert.equal(verifies(signByShare(key, m, signers).sig, m, key), true, 'one nonce per share');
  const byNode = signByNode(key, m, signers);
  assert.equal(verifies(byNode.sig, m, key), true, 'one nonce per node');
  assert.ok(byNode.participants < 22, 'nodes of weight above one send one pair');
  const short = signers.map((x) => ({ ...x, list: [...x.list] }));
  short[short.length - 1].list.pop();
  assert.equal(verifies(signByNode(key, m, short).sig, m, key), false, 'below the threshold the shares add up to nothing');
});

test('the reshare keeps the public key: the new census signs for it, at its own threshold, and old shares mixed in do not', async () => {
  const old = await weightedKeygen({ weights: weightsFor(15, 10) });
  const next = reshare(old, [8, 8, 4, 2, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(Buffer.from(next.groupPublicKey).toString('hex'), Buffer.from(old.groupPublicKey).toString('hex'));
  assert.deepEqual([next.total, next.needed], [30, 20]);
  const m = message();
  assert.equal(verifies(signByNode(next, m, signersFor(next)).sig, m, next), true);
  const mixed = { ...next, shares: next.shares.map((v, x) => (x === 1 ? old.shares[1] : v)) };
  assert.equal(verifies(signByNode(mixed, m, signersFor(next)).sig, m, next), false);
});
