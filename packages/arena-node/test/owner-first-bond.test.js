// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE FIRST BOND FROM THE OWNER PAGE (kanban #728, 2026-10-27: "Du hast die Option es zu skippen und dann später einzurichten, was aber nicht
// geht - Bug"): POST /owner/first-bond on a running seat - the owner signs it, another key is refused, a seat the installer did not set up
// says so, an installed node answers the installer's firstBondOnNode (arena-installer/src/add-bond.js): why not, or the bond it has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { nodeState } from '../../arena-installer/src/state.js';
import { joinedWithLock } from './lock-fixture.js';

test('on a running seat: signed by the owner, refused for another key and on a seat set up by hand; an installed node\'s answer', async () => {
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const ownerRec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const store = { read: () => ownerRec, write: (o) => Object.assign(ownerRec, o), writeCode: () => {} };
  const home = mkdtempSync(join(tmpdir(), 'first-bond-'));
  const st = nodeState(home);
  st.save({ roles: ['verify'], chain: { kind: 'electrum' }, done: {} });
  const was = process.env.ARENA_HOME;
  delete process.env.ARENA_HOME;
  const s = await joinedWithLock({ owner: { store } });
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const node = (await (await fetch(`${base}/owner`)).json()).node;
    const req = (k, args = { post: false }) => signOwnerRequest({ node, action: 'first-bond', args, secret: k, sign: (m, x) => schnorr.sign(m, x), pubkeyOf: (x) => schnorr.getPublicKey(x) });
    const post = (body) => fetch(`${base}/owner/first-bond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const none = await post(req(secret));
    assert.equal(none.status, 501); assert.match((await none.json()).why, /not set up by the installer/);
    process.env.ARENA_HOME = home;
    assert.equal((await post(req(ownerSecretFromSeed(new Uint8Array(32).fill(9))))).status, 403, 'another key: refused');
    assert.equal((await post({ action: 'first-bond', args: { post: false } })).status, 401, 'unsigned: refused');
    const early = await post(req(secret));
    assert.equal(early.status, 400); assert.match((await early.json()).why, /not installed yet/);
    st.save({ done: { service: 1, bond: 1 } });
    const noSeed = await post(req(secret, { post: true }));
    assert.equal(noSeed.status, 400); assert.match((await noSeed.json()).why, /wallet seed is not in this node's home/);
    st.save({ bond: { txid: 'b0'.repeat(32), vout: 0, sats: '50000', maturity: 158000 } });
    const had = await post(req(secret, { post: true }));
    assert.equal(had.status, 200);
    const j = await had.json();
    assert.deepEqual([j.ok, j.done, j.bond.txid], [true, true, 'b0'.repeat(32)], 'a posted bond: nothing posted again');
  } finally {
    if (was === undefined) delete process.env.ARENA_HOME; else process.env.ARENA_HOME = was;
    await s.d.close();
  }
});
