// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3888: before the advertisement update is posted the node checks its wallet can pay it; if not, it says the amount needed and the
// deposit address, and sends nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nodeState } from '../src/state.js';
import { advertFeeCheck } from '../src/change-roles.js';
import { followReach } from '../src/reach-follow.js';
import { walletOf } from '../src/wallet.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const NEW = 'https://arena.example.org', OLD = 'https://old.example.org';
function node(sats) {
  const home = mkdtempSync(join(tmpdir(), 'fee3888-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(new Uint8Array(32).fill(6)); db.close();
  state.save({ roles: ['verify'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: NEW }, bond: { txid: '77'.repeat(32), vout: 0, maturity: 1 } });
  const chainKit = { coinsOf: async () => ({ tip: 100, coins: sats === null ? [] : [{ txid: '5a'.repeat(32), vout: 1, sats }] }), broadcast: async () => { throw new Error('nothing is sent'); } };
  return { home, state, chainKit };
}
const deposit = walletOf(fromHex('11'.repeat(32))).address;

test('advertFeeCheck: enough coins - the fee; too few or none - what the update needs, what to send and where', async () => {
  let n = node(20000);
  let c = await advertFeeCheck({ home: n.home, release: n.home, state: n.state, chainKit: n.chainKit });
  assert.equal(c.ok, true); assert.equal(c.enough, true); assert.ok(Number(c.feeSats) > 0); assert.equal(c.haveSats, '20000'); assert.equal(c.deposit, deposit);
  n = node(600);
  c = await advertFeeCheck({ home: n.home, release: n.home, state: n.state, chainKit: n.chainKit });
  assert.equal(c.enough, false); assert.equal(c.haveSats, '600');
  assert.ok(Number(c.needSats) > 600); assert.equal(c.sendSats, String(Number(c.needSats) - 600));
  assert.match(c.why, new RegExp(`holds 600 sat, the advertisement update needs ${c.needSats} sat: send at least ${c.sendSats} sat to ${deposit}`));
  n = node(null);
  const e = await advertFeeCheck({ home: n.home, release: n.home, state: n.state, chainKit: n.chainKit });
  assert.equal(e.enough, false); assert.equal(e.haveSats, '0'); assert.ok(Number(e.needSats) > 330, e.needSats);
  assert.ok(Number(e.needSats) >= Number(c.needSats), 'built over one coin with change: never less than the update needs');
});

test('followReach with feeCheck: a wallet that cannot pay posts nothing and says the amount and the address', async () => {
  const n = node(600);
  const posted = [];
  const f = await followReach({ home: n.home, state: n.state, publicEndpoint: NEW, censusRead: true, ownEndpoints: [OLD], nowMs: 1,
    refresh: async () => { posted.push(1); return { ok: true }; }, removeTunnel: async () => ({ ok: true }),
    feeCheck: () => advertFeeCheck({ home: n.home, release: n.home, state: n.state, chainKit: n.chainKit }) });
  assert.equal(posted.length, 0, 'nothing posted');
  assert.equal(f.view.update.fee.enough, false);
  assert.equal(f.view.update.fee.deposit, deposit);
  assert.match(f.view.update.why, /send at least \d+ sat to /);
});
