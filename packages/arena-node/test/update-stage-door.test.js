// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// GET /release?nonce= (kanban #1169): a seat signs what it runs with its node key over the asker's nonce; without a nonce it answers unsigned,
// and a fellow's seat counts that as silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { releaseAnswerDigest, verifiedAnswer } from '../src/update-stage.js';
import { opts } from './window-fixture.js';

test('#1169 GET /release?nonce= is signed by the node key over the nonce; without a nonce, unsigned', async () => {
  const d = await serve(openStore(':memory:'), { port: 0, ...opts });
  try {
    const at = `http://127.0.0.1:${d.port}`;
    const nonce = '5a'.repeat(16);
    const a = await (await fetch(`${at}/release?nonce=${nonce}`)).json();
    assert.equal(a.nonce, nonce);
    assert.match(a.signature, /^[0-9a-f]{128}$/);
    assert.ok(schnorr.verify(fromHex(a.signature), releaseAnswerDigest(a), fromHex(a.node)), 'its node key over the answer and the nonce');
    assert.ok(!schnorr.verify(fromHex(a.signature), releaseAnswerDigest({ ...a, nonce: '6b'.repeat(16) }), fromHex(a.node)), 'not over another nonce');
    if (a.version) assert.ok(verifiedAnswer(a, { node: a.node, nonce, verify: (s, m, k) => schnorr.verify(s, m, k) }));
    const plain = await (await fetch(`${at}/release`)).json();
    assert.equal(plain.signature, undefined);
    assert.equal(verifiedAnswer(plain, { node: plain.node, nonce, verify: (s, m, k) => schnorr.verify(s, m, k) }), null, 'unsigned: counts as silent');
  } finally { await d.close(); }
});
