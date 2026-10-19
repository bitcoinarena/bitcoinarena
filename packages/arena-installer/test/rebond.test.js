// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LARGER BOND, IN ONE STEP (kanban #471 part D, rebond.js): the posted bond from its maturity on and the wallet's coins become a new
// bond; the plan first, the broadcast only when asked, the new bond recorded. Measured against testnet4 Core: see rebond.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { rebond } from '../src/rebond.js';
import { nodeState } from '../src/state.js';
import { walletOf } from '../src/wallet.js';
import { bondKeyAt } from '../src/bond.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('the posted bond and the wallet\'s coins become a larger bond: planned, then posted on request, the old one spent on its recovery leaf', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rebond-'));
  const state = nodeState(home);
  const seed = new Uint8Array(32).fill(9);
  writeFileSync(join(home, 'seed.hex'), toHex(seed));
  const nodeSecret = new Uint8Array(32).fill(4);
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)');
  db.prepare('INSERT INTO identity (one, secret) VALUES (0, ?)').run(nodeSecret);
  db.close();
  state.save({ chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, roles: ['verify', 'settlement'], reach: { url: 'https://node.example.com' },
    bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 156193 } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 156906, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 5000 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };

  assert.match((await rebond({ state, bondSats: 50000, chainKit })).why, /holds 50000 sat already/);
  assert.match((await rebond({ state, bondSats: 60000, chainKit })).why, /hold 55000 sat: a bond of 60000 sat needs/);
  assert.match((await rebond({ state, bondSats: 53500, chainKit: { ...chainKit, coinsOf: async () => ({ tip: 156100, coins: [] }) } })).why, /locked until block 156193: 93 blocks/);

  const plan = await rebond({ state, bondSats: 53500, chainKit });
  assert.equal(plan.ok, true);
  assert.equal(sent.length, 0, 'the plan sends nothing');
  assert.deepEqual([plan.plan.bondSats, plan.plan.maturity, plan.plan.from.sats], ['53500', 157195, '50000']);

  const r = await rebond({ state, bondSats: 53500, chainKit, post: true });
  assert.equal(r.ok, true);
  assert.equal(sent.length, 2, 'the funding, then the bond');
  const funding = parseTransaction(fromHex(sent[0]));
  assert.equal(funding.locktime, 156193, 'the old bond is spent from its maturity on');
  assert.equal(toHex(Uint8Array.from(funding.inputs[0].previousTxid).reverse()), '77'.repeat(32), 'the old bond is the first input');
  assert.equal(funding.witnesses[0].length, 3, 'on its recovery leaf: signature, leaf, control block');
  assert.equal(funding.witnesses[1].length, 1, 'the wallet coin on the key path');
  const nodeKey = schnorr.getPublicKey(nodeSecret);
  const bondTx = parseTransaction(fromHex(sent[1]));
  assert.equal(bondTx.outputs[0].value, 53500n);
  assert.equal(toHex(bondTx.outputs[0].script), '5120' + toHex(bondKeyAt(nodeKey, 157195).outputKey), 'the new bond, at the new maturity');
  assert.equal(toHex(advertInTransaction(fromHex(sent[1])).nodePubkey), toHex(nodeKey));
  const after = state.read().bond;
  assert.deepEqual([after.txid, after.sats, after.maturity, after.replaced.txid], [r.bond.txid, '53500', 157195, '77'.repeat(32)], 'the new bond recorded');
  assert.equal(walletOf(seed).address.startsWith('tb1p'), true);
});
