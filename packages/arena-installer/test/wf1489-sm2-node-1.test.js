// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (node lifecycle): THE NODE KEY MOVED TO THE WORDS' KEY (owner page POST /owner/key-from-words, identity-switch.js)
// leaves the OLD key's bond in the census as a serving node. After the move the seat signs only with the new key (identity), the old secret is kept
// in identity_old for the bond's withdrawal only (server.js oldBondsHere), and nothing steps the old key out: its bond stays unspent until its
// maturity with an advertisement that says serving = true (census.js counts it, draws it), so every committee that draws it waits on a node that
// never answers as it again. Invariant: once the node no longer signs with a key, that key is not serving in the census - the move must post
// the old bond's advertisement update with serving = false (as tools/testnet4-step-out.mjs does by hand), or refuse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { switchToSeedKey } from '../src/identity-switch.js';
import { nodeState } from '../src/state.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('wf1489-sm2-node-1: after the key move the old key is stepped out of the census (serving = false), not left drawn and silent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wf1489-sm2-node-1-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const random = new Uint8Array(32).fill(6);
  const oldPub = toHex(schnorr.getPublicKey(random));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB, pubkey BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?, ?)').run(random, schnorr.getPublicKey(random)); db.close();
  const oldBond = '77'.repeat(32);
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    bond: { txid: oldBond, vout: 0, sats: '50000', maturity: 170000 } });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 200000 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };

  const r = await switchToSeedKey({ home, release: home, state, chainKit, post: true });
  assert.equal(r.ok, true, r.why);
  // the move happened: the seat now signs with the words' key, the old one is kept only for the bond's withdrawal
  const after = new DatabaseSync(join(home, 'node.db'));
  const nowPub = toHex(new Uint8Array(after.prepare('SELECT pubkey FROM identity WHERE one = 0').get().pubkey));
  after.close();
  assert.notEqual(nowPub, oldPub, 'the node no longer signs with the old key');
  // the old bond is still locked (maturity 170000 > tip 157000): it stays in every census until then, unless its advertisement steps out
  const stepOut = sent.map((hex) => readAdvertUpdate(fromHex(hex), { network: 'testnet4' })).filter((u) => u.ok)
    .find((u) => [toHex(u.bondTxid), toHex(Uint8Array.from(u.bondTxid).reverse())].includes(oldBond));
  assert.ok(stepOut && toHex(stepOut.nodePubkey) === oldPub && stepOut.advert.serving === false,
    `the old key ${oldPub.slice(0, 16)} must step out (an advertisement update of bond ${oldBond.slice(0, 16)} with serving = false); the move broadcast ${sent.length} transaction(s) and none of them steps it out - the census keeps drawing a key nothing signs with until block 170000`);
});
