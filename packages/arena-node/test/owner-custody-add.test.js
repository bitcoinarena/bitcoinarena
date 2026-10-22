// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ADD CUSTODY FROM THE OWNER PAGE (kanban #563): POST /owner/custody/add on a running seat - the owner signs it, another key is refused, a
// seat the installer did not set up says so; an installed node's plan or why not (arena-installer/src/add-custody.js), its progress, and
// the start refused without the typed I UNDERSTAND.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { nodeState } from '../../arena-installer/src/state.js';
import { joinedWithLock } from './lock-fixture.js';

test('on a running seat: signed by the owner, refused for another key; the installer\'s plan or why; the progress; I UNDERSTAND needed', async () => {
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const ownerRec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const store = { read: () => ownerRec, write: (o) => Object.assign(ownerRec, o), writeCode: () => {} };
  const home = mkdtempSync(join(tmpdir(), 'custody-'));
  nodeState(home).save({ roles: ['verify'], chain: { kind: 'electrum' }, bond: { txid: 'b0'.repeat(32), sats: '60000' } });
  const was = process.env.ARENA_HOME;
  delete process.env.ARENA_HOME;
  const s = await joinedWithLock({ owner: { store } });
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const node = (await (await fetch(`${base}/owner`)).json()).node;
    const req = (k, args = { post: false }) => signOwnerRequest({ node, action: 'custody/add', args, secret: k, sign: (m, x) => schnorr.sign(m, x), pubkeyOf: (x) => schnorr.getPublicKey(x) });
    const post = (body) => fetch(`${base}/owner/custody/add`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const none = await post(req(secret));
    assert.equal(none.status, 501); assert.match((await none.json()).why, /not set up by the installer/);
    process.env.ARENA_HOME = home;
    assert.equal((await post(req(ownerSecretFromSeed(new Uint8Array(32).fill(9))))).status, 403, 'another key: refused');
    const plan = await post(req(secret));
    assert.equal(plan.status, 400); assert.match((await plan.json()).why, /needs your own Bitcoin Core/);
    const p = await post(req(secret, { progress: true }));
    assert.equal(p.status, 200); assert.deepEqual(await p.json(), { ok: true, progress: null }, 'no run yet');
    const bare = await post(req(secret, { post: true, understood: 'yes' }));
    assert.equal(bare.status, 400); assert.match((await bare.json()).why, /type I UNDERSTAND/);
    assert.ok(!existsSync(join(home, 'custody-add.req')), 'nothing started');
    writeFileSync(join(home, 'custody-add.json'), JSON.stringify({ state: 'funds', step: 'waiting for the wallet', needSats: 85000, haveSats: 40000, atMs: Date.now() }));
    const again = await post(req(secret, { post: true, understood: 'I UNDERSTAND' }));
    assert.equal(again.status, 409, 'a run in progress is not started twice');
    assert.equal((await (await post(req(secret, { progress: true }))).json()).progress.state, 'funds');
  } finally {
    if (was === undefined) delete process.env.ARENA_HOME; else process.env.ARENA_HOME = was;
    await s.d.close();
  }
});
