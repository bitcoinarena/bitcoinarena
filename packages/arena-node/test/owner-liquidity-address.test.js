// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NEW TOP-UP ADDRESS FOR THE LIQUIDITY PROVIDER'S WALLET (2026-10-18: "a button generate a new address for the lp
// wallet"): the owner signs it, the seat asks its provider service (ARENA_LIQUIDITY_PROVIDER_URL), the answer comes back; no other key,
// and no provider service, is told so.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { joinedWithLock } from './lock-fixture.js';

test('on a running seat: the owner\'s signed ask reaches the provider service and its new address comes back', async () => {
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const ownerRec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const store = { read: () => ownerRec, write: (o) => Object.assign(ownerRec, o), writeCode: () => {} };
  let asked = 0;
  const prov = http.createServer((q, s) => { if (q.method === 'POST' && q.url === '/new-address') { asked++; s.writeHead(200, { 'content-type': 'application/json' }); return s.end(JSON.stringify({ ok: true, address: `tb1pnew${asked}` })); } s.writeHead(404); s.end(); });
  await new Promise((ok) => prov.listen(0, '127.0.0.1', ok));
  const was = process.env.ARENA_LIQUIDITY_PROVIDER_URL;
  const s = await joinedWithLock({ owner: { store } });
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const node = (await (await fetch(`${base}/owner`)).json()).node;
    const req = (k) => signOwnerRequest({ node, action: 'liquidity/new-address', args: {}, secret: k, sign: (m, x) => schnorr.sign(m, x), pubkeyOf: (x) => schnorr.getPublicKey(x) });
    const post = (body) => fetch(`${base}/owner/liquidity/new-address`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    delete process.env.ARENA_LIQUIDITY_PROVIDER_URL;
    const none = await post(req(secret));
    assert.equal(none.status, 501); assert.match((await none.json()).why, /runs no liquidity provider service/);
    process.env.ARENA_LIQUIDITY_PROVIDER_URL = `http://127.0.0.1:${prov.address().port}`;
    assert.equal((await post(req(ownerSecretFromSeed(new Uint8Array(32).fill(9))))).status, 403, 'another key: refused');
    assert.equal(asked, 0, 'the provider was not asked');
    const r = await post(req(secret));
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true, address: 'tb1pnew1' });
    assert.equal(asked, 1);
  } finally {
    if (was === undefined) delete process.env.ARENA_LIQUIDITY_PROVIDER_URL; else process.env.ARENA_LIQUIDITY_PROVIDER_URL = was;
    await s.d.close(); prov.close();
  }
});
