// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3800 (RULED 2026-11-26, protocol 34): GET /identity?nonce= answers, beside the unbound signature it always gave (#2982/#3253),
// the Host it was asked at (`at`) and the seat's signature over identityBoundDigest(nonce, at) (`atSig`). The unbound answer is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve, identityProofDigest } from '../src/server.js';
import { openStore } from '../src/store.js';
import { opts } from './window-fixture.js';
import { HOSTED } from './plugins/hosted.js';
import { identityBoundDigest } from '../../arena-protocol/src/identity-proof.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

// node:http, so the test names the Host header itself (fetch does not let a caller set it)
const ask = (port, path, headers = {}) => new Promise((ok, fail) => {
  const r = request({ host: '127.0.0.1', port, path, headers }, (res) => {
    const parts = []; res.on('data', (c) => parts.push(c));
    res.on('end', () => { const raw = Buffer.concat(parts); ok({ status: res.statusCode, raw, body: raw.toString('utf8') }); });
  });
  r.on('error', fail); r.end();
});

test('#3800 GET /identity?nonce= signs the Host it was asked at beside the unbound proof', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const key = toHex(d.round.pubkey);
    const nonce = 'ab'.repeat(32);
    const r = await ask(d.port, `/identity?nonce=${nonce}`, { host: 'Seat-3.Example.:8443', 'x-forwarded-host': 'liar.example' });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.node, key);
    assert.equal(j.nonce, nonce);
    assert.equal(schnorr.verify(fromHex(j.sig), identityProofDigest(fromHex(nonce)), fromHex(key)), true, 'the unbound proof is as before');
    assert.equal(j.at, 'seat-3.example:8443', 'the Host as asked, lower case, no trailing dot - never X-Forwarded-Host');
    assert.equal(schnorr.verify(fromHex(j.atSig), identityBoundDigest(fromHex(nonce), 'seat-3.example:8443'), fromHex(key)), true);
    assert.equal(schnorr.verify(fromHex(j.atSig), identityBoundDigest(fromHex(nonce), 'liar.example'), fromHex(key)), false);
    // the same seat asked under another name signs that name
    const other = JSON.parse((await ask(d.port, `/identity?nonce=${nonce}`, { host: 'h.example' })).body);
    assert.equal(other.at, 'h.example');
    assert.notEqual(other.atSig, j.atSig);
    // no nonce: the bare key, as before
    const bare = await ask(d.port, '/identity', { host: 'h.example' });
    assert.deepEqual([bare.status, toHex(new Uint8Array(bare.raw))], [200, key]);
  } finally { await d.close(); }
});
