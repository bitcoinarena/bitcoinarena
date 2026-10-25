// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN OLD BOND TAKEN BACK (kanban #650): a node that moved to the key its 24 words give left its bond under the old key (identity_old in
// its store, oldBonds in the installer's state). The owner page lists it with its lock and whether this node holds its key; at maturity
// the owner's signed request spends it with the old key - the same spend the bond's own withdrawal makes. Locked, a stranger's request,
// an unknown bond: refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { withdrawSpend } from '../src/bond-withdraw.js';
import { addressScript } from '../../arena-protocol/src/address.js';
import { BOND_TEMPLATE_V2 } from '../../arena-protocol/src/bond-script.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { joinedWithLock } from './lock-fixture.js';

test('an old bond after a key switch: listed with its lock, taken back at maturity with the old key by the owner\'s signed request', async () => {
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const ownerRec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const store = { read: () => ownerRec, write: (o) => Object.assign(ownerRec, o), writeCode: () => {} };
  const oldSecret = new Uint8Array(32).fill(5);
  const oldKey = toHex(schnorr.getPublicKey(oldSecret));
  const bond = { txid: 'aa'.repeat(32), vout: 1, sats: '50000', maturity: 157700, key: oldKey };
  const home = mkdtempSync(join(tmpdir(), 'old-bond-'));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', oldBonds: [bond] }));
  const was = process.env.ARENA_HOME;
  process.env.ARENA_HOME = home;
  let tip = 157650; const sent = [];
  const s = await joinedWithLock({ owner: { store }, chainTip: async () => tip, chainSend: async (hex) => { sent.push(hex); return 'cd'.repeat(32); } });
  try {
    s.d.round.db.exec('CREATE TABLE IF NOT EXISTS identity_old (secret BLOB NOT NULL, pubkey BLOB NOT NULL, at_ms INTEGER NOT NULL)');
    s.d.round.db.prepare('INSERT INTO identity_old (secret, pubkey, at_ms) VALUES (?, ?, ?)').run(oldSecret, schnorr.getPublicKey(oldSecret), 1);
    const base = `http://127.0.0.1:${s.d.port}`;
    const node = (await (await fetch(`${base}/owner`)).json()).node;
    const listed = (await (await fetch(`${base}/owner/bond`)).json()).oldBonds;
    assert.deepEqual(listed.map((o) => [o.txid, o.vout, o.sats, o.maturity, o.held, o.lock.withdrawable, o.lock.blocksLeft]), [[bond.txid, 1, '50000', 157700, true, false, 50]]);
    const address = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    const ask = (k, args) => fetch(`${base}/owner/old-bond-withdraw`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signOwnerRequest({ node, action: 'old-bond-withdraw', args, secret: k, sign: (m, x) => schnorr.sign(m, x), pubkeyOf: (x) => schnorr.getPublicKey(x) })) });
    const args = { txid: bond.txid, vout: 1, address, feeRate: 2 };
    const locked = await ask(secret, args);
    assert.equal(locked.status, 409); assert.match((await locked.json()).why, /locked until block 157700: 50 blocks from now/);
    tip = 157700;
    assert.equal((await ask(ownerSecretFromSeed(new Uint8Array(32).fill(9)), args)).status, 403, 'a stranger: refused');
    assert.equal((await ask(secret, { ...args, txid: 'bb'.repeat(32) })).status, 404, 'no such old bond');
    const ok = await ask(secret, args);
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.deepEqual([j.ok, j.txid], [true, 'cd'.repeat(32)]);
    const want = withdrawSpend({ bond: { ...bond, template: BOND_TEMPLATE_V2 }, nodeSecret: oldSecret, network: 'testnet4', script: addressScript(address, 'tb'), feeRate: 2 });
    // the same transaction but its signature (BIP-340 signing is randomized): the witness's 64-byte signature masked on both sides
    const unsigned = (hex) => hex.replace(/0340[0-9a-f]{128}/, '0340' + '00'.repeat(64));
    assert.deepEqual([sent.length, unsigned(sent[0]), j.value], [1, unsigned(want.hex), want.value], 'the old key\'s spend, as the bond\'s own withdrawal builds it');
  } finally {
    if (was === undefined) delete process.env.ARENA_HOME; else process.env.ARENA_HOME = was;
    await s.d.close(); rmSync(home, { recursive: true, force: true });
  }
});
