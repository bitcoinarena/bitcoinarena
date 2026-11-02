// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLAIM KEY, BYTE FOR BYTE (kanban #972): the census key's run was added beside dkg.js and must leave every round's key as it was. Fixed
// inputs, and every value below was printed by the tree before that work (42acb14c4): the epoch, the deals, the group key, a share, the
// agreement and a signature. A round's committee still refuses one key twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as d from '../../arena-protocol/src/dkg.js';
import { signShare340, aggregate340 } from '../../arena-protocol/src/frost-bip340.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { scalarFrom32, FIELD } from '../../arena-protocol/src/shares.js';
import { feldmanGroup } from '../src/curve.js';

const curve = feldmanGroup;
const R = (label, n) => { const b = taggedHash('ARENA/test/DkgPin', new TextEncoder().encode(`${label}:${n}`)); return b; };
const S = (label, n) => scalarFrom32(R(label, n)) % FIELD;
const secrets = Array.from({ length: 7 }, (_, i) => R('identity', i));
const nodes = secrets.map((k) => schnorr.getPublicKey(k));
const id = d.epochId(nodes);

test('a committee of seven makes the same epoch, deals, key, share, agreement and signature as before the census key', async () => {
  const id = d.epochId(nodes);
  assert.equal(toHex(id), 'cb2d972bc5f00851c7f672c5307d564a745f677a30dd21d0d8d04d3916fd8760');
  assert.equal(toHex(d.reserveEpochId(new Uint8Array(32).fill(7), nodes)), '8450df3f658299bfe17d4dd99f4e76e4d72131b192d5fde1dad307147eabdeaa');
  const contributions = [];
  for (let i = 0; i < 7; i++) {
    const eph = R('eph', i);
    const made = await d.dealContribution({ secret: R('secret', i), signerNodes: nodes, epochId: id, from: nodes[i], ephemeralSecret: eph, ephemeralPubkey: curve.pointX(eph),
      coefficients: Array.from({ length: 4 }, (_, j) => S(`coef${i}`, j)), needed: 5, curve });
    assert.equal(made.ok, true, made.why);
    contributions.push(made.contribution);
    assert.equal(d.acceptContribution(made.contribution, { curve }).ok, true);
  }
  assert.equal(toHex(taggedHash('ARENA/test/Pin', d.encodeContribution(contributions[0]))), '70ab1fa2404c621bc60d47034fbec5be270d1e4809da90f69addf183bcd223b8');
  assert.equal(toHex(d.contributionId(contributions[6])), 'efed05897f0645b2782c9560767f007498cd17eacacb77f49c8947932fe5c5a6');
  const all = [];
  for (let n = 0; n < 7; n++) {
    const opened = [];
    for (const c of contributions) opened.push(await d.openMyContribution(c, { pubkey: nodes[n], secret: secrets[n], curve }));
    all.push(d.combineShares({ opened, signerNodes: nodes, contributions, curve }));
  }
  const combined = all[0];
  assert.equal(toHex(combined.groupPublicKey), '02bdd1ab91bc37016d21c0c92fb44b54a60cbeb893a60f35e0c6c2fea85c4b4cc2');
  assert.equal(combined.negated, true);
  assert.equal(combined.share.toString(16), 'af88b65c10c09ec0c3bd0ecc8ef63ae0bb7c157569ffaa18235a221c28bc5a14');
  assert.equal(toHex(d.agreementId({ epochId: id, signerNode: nodes[0], held: d.contributionSetOf(contributions) })), '719c03331eaac0cc65aaaaaf65930615bd4ed57c561101b29fa74eaba143ab62');
  const msg = R('message', 0);
  const signers = all.slice(0, 5);
  const nonces = signers.map((_, i) => ({ hiding: S('h', i), binding: S('b', i) }));
  const commitments = signers.map((s, i) => ({ id: s.signerNode, hiding: curve.pointFromScalar(nonces[i].hiding), binding: curve.pointFromScalar(nonces[i].binding) }));
  const shares = signers.map((s, i) => signShare340({ id: s.signerNode, share: s.share, groupPublicKey: combined.groupPublicKey, nonces: nonces[i], message: msg, commitments, curve }));
  const sig = aggregate340({ commitments, message: msg, groupPublicKey: combined.groupPublicKey, shares, curve });
  assert.equal(toHex(sig.signature), '60898402c0d4e700cb33b8934a74e738d5d64b2179f9228fb0d713a866c5b57b6ca1c60879ae17642e71c07b3ff3d7e1af1070534adf2428b8bfeb9c29376d3e');
  assert.equal(schnorr.verify(sig.signature, msg, sig.publicKey), true);
});

test('a round\'s committee still refuses what the census key allows: one key twice, a subset of deals', () => {
  assert.throws(() => d.epochId([nodes[0], nodes[0]]), /two signer nodes of that committee are one key/);
  assert.equal(d.combineShares({ opened: [{}], signerNodes: nodes, contributions: [{}], curve }).ok, false);
  assert.equal(d.agreementHolds({ epochId: new Uint8Array(32), signerNodes: nodes, statements: [], verify: () => true }).ok, false);
});
