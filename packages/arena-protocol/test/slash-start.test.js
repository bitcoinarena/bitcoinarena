// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A CENSUS KEY HOLDER SIGNS (spec 5A.3B, kanban #972): a start of that bond, to a hold its node signed, naming the proof it replayed, and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildSlashStart, checkSlashStart, slashStartDigest } from '../src/slash-start.js';
import { signSlashPresig, slashPresigDigest } from '../src/slash-presig.js';
import { taggedHash, fromHex } from '../src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const secret = taggedHash('ARENA/test/SlashStart', Uint8Array.of(1));
const nodeKey = schnorr.getPublicKey(secret), censusKey = schnorr.getPublicKey(taggedHash('ARENA/test/SlashStart', Uint8Array.of(2)));
const bond = { txid: new Uint8Array(32).fill(1), vout: 0, value: 100000n, script: fromHex(`5120${'11'.repeat(32)}`) };
const hold = { script: fromHex(`5120${'22'.repeat(32)}`) };
const proofId = new Uint8Array(32).fill(3), fee = { txid: new Uint8Array(32).fill(4), vout: 1, value: 700n, script: fromHex(`5120${'44'.repeat(32)}`) };
const presig = signSlashPresig(slashPresigDigest({ bond, nodeKey, censusKey, holdScript: hold.script }), (d) => schnorr.sign(d, secret));
const built = (over = {}) => buildSlashStart({ bond, holdScript: hold.script, proofId, slashHeight: 500, fee, ...over });
const check = (b, over = {}) => checkSlashStart({ ...b, bond, nodeKey, censusKey, holds: [hold], presig, proofId, verify, ...over });

test('the start its node signed is what a holder signs: the digest covers all of it', () => {
  const b = built(), c = check(b);
  assert.ok(c.ok, c.why);
  assert.equal(c.slashHeight, 500);
  assert.deepEqual(c.digest, slashStartDigest({ ...b, nodeKey, censusKey }));
  assert.equal(b.tx.outputs.length, 2, 'the fee coin holds the fee: no change');
  assert.notDeepEqual(slashStartDigest({ ...built({ slashHeight: 501 }), nodeKey, censusKey }), c.digest);
});

test('refused by name: another input, another output, another proof, a bent presig', () => {
  const b = built();
  const tx = (f) => { const t = structuredClone(b.tx); f(t); return { ...b, tx: t }; };
  assert.match(check(tx((t) => { t.locktime = 1; })).why, /nLockTime 0/);
  assert.match(check(tx((t) => { t.inputs[0].vout = 1; })).why, /input 0 is not that bond/);
  assert.match(check(tx((t) => { t.inputs[0].sequence = 0; })).why, /input 0 is not that bond/);
  assert.match(check({ ...b, prevouts: [{ ...b.prevouts[0], value: 1n }, b.prevouts[1]] }).why, /prevouts/);
  assert.match(check(tx((t) => { t.outputs[0].value = 99999n; })).why, /whole bond/);
  assert.match(check(built({ holdScript: fromHex(`5120${'55'.repeat(32)}`) })).why, /no hold output/);
  const bent = presig.slice(); bent[1] ^= 1;
  assert.match(check(b, { presig: bent }).why, /does not verify/);
  assert.match(check(built({ proofId: new Uint8Array(32).fill(9) })).why, /does not name that proof/);
});
