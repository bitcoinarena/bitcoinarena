// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 SM7 NODE-2: the owner page's bond withdrawal (POST /owner/bond-withdraw, server.js: chainSend of withdrawSpend over every unlocked
// output) is never written into the installer's record of the bond (state.json bond / bonds). The bond's life on an installed node
//   none --first-bond--> posted --6 deep--> counted --maturity--> withdrawable --bond-withdraw--> WITHDRAWN (spent on the chain)
// ends in a state the record never reaches: state.json keeps naming the spent outputs. From then on
//   - POST /owner/first-bond (firstBond) answers { done: true, bond: <the spent bond> } for good: the owner page can never post a new bond;
//   - POST /owner/add-bond (addBond) plans "total = the spent outputs + the added sat", while the census sees only the added output.
// The invariant: the bond the installer's record names is one the chain still holds unspent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addBond, firstBond } from '../src/add-bond.js';
import { nodeState, bondsOf, withoutSpentBonds } from '../src/state.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const WITHDRAWN = { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157000 };

function installedNode() {
  const home = mkdtempSync(join(tmpdir(), 'wf1489-sm7-node-2-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), toHex(new Uint8Array(32).fill(9)));
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)');
  db.prepare('INSERT INTO identity (one, secret) VALUES (0, ?)').run(new Uint8Array(32).fill(4));
  db.close();
  // the wizard posted the bond (done.bond, state.bond); the owner later withdrew it on the owner page after its maturity
  state.save({ chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, roles: ['verify', 'settlement'], reach: { url: 'https://node.example.com' },
    done: { service: 1, bond: 1 }, bond: WITHDRAWN });
  return state;
}
// the chain after the withdrawal: the bond output is spent (no unspent output there); the wallet holds fresh coins for a new bond
const chainAfterWithdraw = (sent) => ({
  coinsOf: async () => ({ tip: 157200, coins: [{ txid: '5a'.repeat(32), vout: 1, sats: 90000, height: 157190 }] }),
  broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); },
  txOut: async (txid, vout) => (txid === WITHDRAWN.txid && vout === WITHDRAWN.vout ? null : { sats: 1 }),
  utxo: async (txid, vout) => (txid === WITHDRAWN.txid && vout === WITHDRAWN.vout ? null : { sats: 1 }),
});

test('wf1489-sm7-node-2: after the owner withdrew the bond, the first-bond door posts a new bond instead of answering "posted already" with the spent one', async () => {
  const state = installedNode();
  const sent = [];
  const r = await firstBond({ state, chainKit: chainAfterWithdraw(sent), askMinimum: async () => ({ sats: 60000 }), post: true, nowMs: 1000 });
  console.log(`  wf1489-sm7-node-2: first-bond after the withdrawal: ok ${r.ok}, done ${!!r.done}, bond ${r.bond && r.bond.txid.slice(0, 8)}, ${sent.length} tx sent`);
  assert.ok(!(r.done && r.bond && r.bond.txid === WITHDRAWN.txid), 'first-bond answers "posted already" with a bond the chain shows spent: the owner page can never bond this node again');
});

test('wf1489-sm7-node-2: after the owner withdrew the bond, the add-bond plan does not count the spent outputs in the new total', async () => {
  const state = installedNode();
  const p = await addBond({ state, addSats: 32000, chainKit: chainAfterWithdraw([]) });
  console.log(`  wf1489-sm7-node-2: add-bond plan after the withdrawal: ok ${p.ok}, bondSats ${p.plan && p.plan.bondSats}, totalSats ${p.plan && p.plan.totalSats}`);
  assert.ok(!p.ok || p.plan.totalSats === '32000', `the plan says the node's bond will be ${p.plan && p.plan.totalSats} sat; the chain holds only the 32000 sat output it adds`);
});

test('wf1489-sm7-node-2 (kanban #2098): the new first bond leaves the spent one out of the record and keeps it as withdrawn', async () => {
  const state = installedNode();
  const r = await firstBond({ state, chainKit: chainAfterWithdraw([]), askMinimum: async () => ({ sats: 60000 }), post: true, nowMs: 1000 });
  assert.equal(r.ok, true);
  const s = state.read();
  assert.deepEqual(bondsOf(s).map((b) => b.txid), [r.bond.txid]);
  assert.deepEqual((s.withdrawn || []).map((b) => b.txid), [WITHDRAWN.txid]);
  // the owner page's withdrawal record (server.js /owner/bond-withdraw) is the same patch
  const p = withoutSpentBonds({ bond: WITHDRAWN, bonds: [WITHDRAWN, { txid: '88'.repeat(32), vout: 0, sats: '40000' }] }, [{ txid: WITHDRAWN.txid, vout: 0 }], { txid: 'aa'.repeat(32) });
  assert.equal(p.bond.txid, '88'.repeat(32));
  assert.equal(p.bonds.length, 1);
  assert.equal(p.withdrawn[0].withdrawTxid, 'aa'.repeat(32));
});
