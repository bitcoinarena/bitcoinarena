// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ADD TO BOND (add-bond.js, kanban #544): a second bond output beside the first - the plan first (the amount, the fees, the new
// total, the maturity), the broadcast only when asked, the first bond untouched, the state's `bonds` [first, added]; an old state
// with a single `bond` still reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { addBond } from '../src/add-bond.js';
import { nodeState, bondsOf } from '../src/state.js';
import { bondKeyAt } from '../src/bond.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

function node({ bond = { txid: '77'.repeat(32), vout: 0, sats: '50000', maturity: 157000 }, bonds } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'add-bond-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), toHex(new Uint8Array(32).fill(9)));
  const nodeSecret = new Uint8Array(32).fill(4);
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)');
  db.prepare('INSERT INTO identity (one, secret) VALUES (0, ?)').run(nodeSecret);
  db.close();
  state.save({ chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, roles: ['verify', 'settlement'], reach: { url: 'https://node.example.com' },
    ...(bond ? { bond } : {}), ...(bonds ? { bonds } : {}) });
  return { state, nodeSecret };
}
const kit = (sent, coins = [{ txid: '5a'.repeat(32), vout: 1, sats: 40000 }]) => ({ coinsOf: async () => ({ tip: 157070, coins }),
  broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } });

test('an old state file with a single bond still reads as one output; bonds[] when there is one', () => {
  assert.deepEqual(bondsOf({ bond: { txid: 'aa', sats: '50000' } }), [{ txid: 'aa', sats: '50000' }]);
  assert.deepEqual(bondsOf({ bond: { txid: 'aa' }, bonds: [{ txid: 'aa' }, { txid: 'bb' }] }).map((b) => b.txid), ['aa', 'bb']);
  assert.deepEqual(bondsOf({}), []);
  assert.deepEqual(bondsOf({ bond: null }), []);
});

test('+32,000 sat: the plan names the amount, the fees, the new total and the maturity, and sends nothing', async () => {
  const { state } = node();
  const sent = [];
  const r = await addBond({ state, addSats: 32000, chainKit: kit(sent) });
  assert.equal(r.ok, true, r.why);
  assert.equal(sent.length, 0, 'the plan sends nothing');
  const p = r.plan;
  assert.deepEqual([p.addSats, p.bondSats, p.totalSats], ['32000', '50000', '82000']);
  assert.equal(p.maturity, 157070 + 1 + 144 + 144, 'its own lock: the next block, the offset, the slack');
  assert.equal(BigInt(p.fees.total), BigInt(p.fees.funding) + BigInt(p.fees.bond));
  assert.ok(BigInt(p.fees.total) > 0n);
  assert.equal(BigInt(p.changeSats), 40000n - 32000n - 330n - BigInt(p.fees.total), 'the rest of the coin back to the wallet');
  assert.equal(p.countsAfter, 6);
  assert.deepEqual(p.outputs.map((o) => o.txid), ['77'.repeat(32)]);
  console.log('  plan:', JSON.stringify({ addSats: p.addSats, totalSats: p.totalSats, fees: p.fees.total, maturity: p.maturity }));
  assert.match((await addBond({ state, addSats: 'lots', chainKit: kit(sent) })).why, /not an amount of sat/);
  assert.match((await addBond({ state, addSats: 100, chainKit: kit(sent) })).why, /at least 330 sat/);
  assert.match((await addBond({ state, addSats: 32000, chainKit: kit(sent, [{ txid: '5a'.repeat(32), vout: 1, sats: 20000 }]) })).why, /the wallet holds 20000 sat: a bond of 32000 sat needs/);
  assert.match((await addBond({ state: node({ bond: null }).state, addSats: 32000, chainKit: kit(sent) })).why, /no posted bond to add to/);
});

test('posted: the second output carries its own advertisement - same node key and operator - the first bond untouched, bonds[] recorded', async () => {
  const { state, nodeSecret } = node();
  const sent = [];
  const r = await addBond({ state, addSats: 32000, chainKit: kit(sent), post: true });
  assert.equal(r.ok, true, r.why);
  assert.equal(sent.length, 2, 'the funding, then the bond');
  const funding = parseTransaction(fromHex(sent[0]));
  assert.equal(funding.inputs.length, 1, 'only the wallet coin');
  assert.notEqual(toHex(Uint8Array.from(funding.inputs[0].previousTxid).reverse()), '77'.repeat(32), 'the first bond is not an input');
  assert.equal(funding.locktime, 0);
  const nodeKey = schnorr.getPublicKey(nodeSecret);
  const bondTx = parseTransaction(fromHex(sent[1]));
  assert.equal(bondTx.outputs[0].value, 32000n);
  assert.equal(toHex(bondTx.outputs[0].script), '5120' + toHex(bondKeyAt(nodeKey, r.bond.maturity).outputKey), 'a bond output at its own maturity');
  const advert = advertInTransaction(fromHex(sent[1]));
  assert.equal(toHex(advert.nodePubkey), toHex(nodeKey), 'the same node key');
  assert.equal(advert.operatorId, `op-${'ab'.repeat(32).slice(0, 12)}`, 'the same operator');
  assert.equal(advert.bondMaturityHeight, r.bond.maturity);
  const s = state.read();
  assert.equal(s.bond.txid, '77'.repeat(32), 'bond stays the first output');
  assert.deepEqual(s.bonds.map((b) => [b.txid, b.sats]), [['77'.repeat(32), '50000'], [r.bond.txid, '32000']]);
  assert.equal(s.bonds[1].added, true);
  // a third output adds to the list
  const r3 = await addBond({ state, addSats: 10000, chainKit: kit([]), post: true });
  assert.equal(r3.plan.totalSats, '92000');
  assert.equal(state.read().bonds.length, 3);
});

test('a custody node\'s guardian seat goes into the added output\'s advertisement (the newest decides, protocol 19)', async () => {
  const { state } = node();
  const sent = [];
  const guardianOf = [{ federationId: new Uint8Array(32).fill(0x33), guardianKey: Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x7a)]) }];
  const r = await addBond({ state, addSats: 32000, chainKit: kit(sent), post: true, guardianOf, guardianEndpoint: 'wss://node.example.com/guardian' });
  assert.equal(r.ok, true, r.why);
  const advert = advertInTransaction(fromHex(sent[1]));
  assert.equal(advert.guardianOf.length, 1);
  assert.equal(toHex(advert.guardianOf[0].federationId), '33'.repeat(32));
  assert.equal(advert.guardianEndpoint, 'wss://node.example.com/guardian');
});
