// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BECOME A LIQUIDITY PROVIDER FROM THE OWNER PAGE (kanban #567): POST /owner/liquidity/become on a running seat - the owner signs it,
// another key is refused, a seat the installer did not set up says so, an installed node's answer is the installer's plan or why not
// (arena-installer/src/add-liquidity.js); and the claim its provider writes into the node's home is served before the next restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { nodeState } from '../../arena-installer/src/state.js';
import { joinedWithLock } from './lock-fixture.js';

test('on a running seat: signed by the owner, refused for another key; the installed node\'s why; its home\'s claim served', async () => {
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const ownerRec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const store = { read: () => ownerRec, write: (o) => Object.assign(ownerRec, o), writeCode: () => {} };
  const home = mkdtempSync(join(tmpdir(), 'become-'));
  nodeState(home).save({ roles: ['verify'], chain: { kind: 'electrum' }, lightning: null });
  const was = { home: process.env.ARENA_HOME, claim: process.env.ARENA_LIQUIDITY_CLAIM_FILE };
  delete process.env.ARENA_HOME; delete process.env.ARENA_LIQUIDITY_CLAIM_FILE;
  const s = await joinedWithLock({ owner: { store } });
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const node = (await (await fetch(`${base}/owner`)).json()).node;
    const req = (k, args = { post: false }) => signOwnerRequest({ node, action: 'liquidity/become', args, secret: k, sign: (m, x) => schnorr.sign(m, x), pubkeyOf: (x) => schnorr.getPublicKey(x) });
    const post = (body) => fetch(`${base}/owner/liquidity/become`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const none = await post(req(secret));
    assert.equal(none.status, 501); assert.match((await none.json()).why, /not set up by the installer/);
    process.env.ARENA_HOME = home;
    assert.equal((await post(req(ownerSecretFromSeed(new Uint8Array(32).fill(9))))).status, 403, 'another key: refused');
    const r = await post(req(secret));
    assert.equal(r.status, 400); assert.match((await r.json()).why, /needs your own Bitcoin Core/);
    assert.equal((await fetch(`${base}/liquidity-claim`)).status, 404, 'no claim yet');
    writeFileSync(join(home, 'liquidity-claim.json'), JSON.stringify({ node: 'ab'.repeat(32), freeSats: '0', channels: [] }));
    const c = await fetch(`${base}/liquidity-claim`);
    assert.equal(c.status, 200); assert.equal((await c.json()).node, 'ab'.repeat(32), 'the home\'s claim, with no ARENA_LIQUIDITY_CLAIM_FILE');
  } finally {
    for (const [k, v] of [['ARENA_HOME', was.home], ['ARENA_LIQUIDITY_CLAIM_FILE', was.claim]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await s.d.close();
  }
});
