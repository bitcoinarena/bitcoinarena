// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN EXISTING NODE MOVES TO THE KEY ITS 24 WORDS GIVE (kanban #650, "b but optional"): the plan, then a new bond under the words' key from
// the node's wallet and the node signing with it, the old key kept for its bond; refused for a Nostr node, a guardian, no bond.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { switchToSeedKey } from '../src/identity-switch.js';
import { nodeState } from '../src/state.js';
import { nodeKeyOf } from '../src/seed.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

function node(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'keyswitch-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const random = new Uint8Array(32).fill(6);
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB, pubkey BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?, ?)').run(random, schnorr.getPublicKey(random)); db.close();
  state.save({ roles: ['verify', 'settlement'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    bond: { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157057 }, ...extra });
  const sent = [];
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 80000 }] }),
    broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  return { home, state, random, sent, chainKit };
}

test('a node with a random key moves to the key from its words: the plan, then the new bond, the new key, the old one kept', async () => {
  const n = node();
  const want = toHex(schnorr.getPublicKey(nodeKeyOf(fromHex('11'.repeat(32)))));
  const plan = await switchToSeedKey({ home: n.home, release: n.home, state: n.state, chainKit: n.chainKit });
  assert.equal(plan.ok, true, plan.why);
  assert.deepEqual([plan.plan.keyNow, plan.plan.keyNext, plan.plan.bondSats], [toHex(schnorr.getPublicKey(n.random)), want, '50000']);
  assert.equal(n.sent.length, 0, 'the plan sends nothing');
  const r = await switchToSeedKey({ home: n.home, release: n.home, state: n.state, chainKit: n.chainKit, post: true });
  assert.equal(r.ok, true, r.why);
  assert.equal(n.sent.length, 2, 'the funding and the bond');
  const db = new DatabaseSync(join(n.home, 'node.db'));
  assert.equal(toHex(new Uint8Array(db.prepare('SELECT pubkey FROM identity WHERE one = 0').get().pubkey)), want, 'the node signs with the words\' key');
  assert.deepEqual(new Uint8Array(db.prepare('SELECT secret FROM identity_old').get().secret), n.random, 'the old key kept for its bond');
  db.close();
  const s = n.state.read();
  assert.deepEqual([s.bond.txid, s.oldBonds[0].txid, s.oldBonds[0].key, s.keySwitch.to], [r.bond.txid, '77'.repeat(32), toHex(schnorr.getPublicKey(n.random)), want]);
  assert.deepEqual(await switchToSeedKey({ home: n.home, release: n.home, state: n.state, chainKit: n.chainKit }), { ok: true, already: true, key: want }, 'once is enough');
});

test('refused: a Nostr node, a guardian with a seat, no bond, too few coins', async () => {
  assert.match((await switchToSeedKey({ ...(() => { const n = node({ control: 'nostr' }); return { home: n.home, state: n.state, chainKit: n.chainKit }; })(), release: '/r' })).why, /your nsec/);
  const g = node({ custody: { guardianOf: true } });
  assert.match((await switchToSeedKey({ home: g.home, release: '/r', state: g.state, chainKit: g.chainKit })).why, /guardian keeps its key/);
  const b = node({ bond: null });
  assert.match((await switchToSeedKey({ home: b.home, release: '/r', state: b.state, chainKit: b.chainKit })).why, /no bond yet/);
  const p = node();
  p.chainKit.coinsOf = async () => ({ tip: 157000, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 1000 }] });
  assert.match((await switchToSeedKey({ home: p.home, release: '/r', state: p.state, chainKit: p.chainKit })).why, /needs 50000 sat plus fees/);
});
