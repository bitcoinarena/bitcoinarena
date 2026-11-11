// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY OUTPUT OF THE BOND WITHDRAWN (kanban #1439, money audit 8 M8-2). The owner door spent the first bond output only; an added
// output (#544) left alone below the floor dropped out of the next census, and the door then answered 409 "no census this seat holds
// names a bond of this node" - its sats reachable only by a hand-built spend. Now the spend takes every output of the node, one input
// each on its own recovery leaf, and the door finds the node's outputs beyond the census - checked against the chain's unspent output
// (its script this node's bond at its maturity), never trusted as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { withdrawSpend, ownOutputsOnChain, bondKeyOf } from '../src/bond-withdraw.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { recoveryLeaf, tapLeafHash, BOND_TEMPLATE_V2 } from '../../arena-protocol/src/bond-script.js';
import { tapSighash } from '../../arena-protocol/src/bond-spend.js';
import { addressScript } from '../../arena-protocol/src/address.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { joinedWithLock } from './lock-fixture.js';

const nodeSecret = new Uint8Array(32).fill(5);
const nodeKey = schnorr.getPublicKey(nodeSecret);
const spkOf = (key, maturity, network) => '5120' + toHex(bondKeyOf(key, maturity, network).outputKey);
const B1 = { txid: '01'.repeat(32), vout: 0, sats: '100000', maturity: 157000, template: BOND_TEMPLATE_V2 };
const B2 = { txid: '02'.repeat(32), vout: 1, sats: '32000', maturity: 157100, template: BOND_TEMPLATE_V2 };

test('#1439 the bond and its added output in one spend: an input each on its own recovery leaf, the latest maturity, both signed', () => {
  const to = addressScript('tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c');
  const w = withdrawSpend({ bonds: [B1, B2], nodeSecret, network: 'testnet4', script: to, feeRate: 2 });
  const tx = parseTransaction(fromHex(w.hex));
  assert.equal(tx.inputs.length, 2, 'both outputs spent');
  assert.deepEqual(tx.inputs.map((i) => [toHex(Uint8Array.from(i.previousTxid).reverse()), i.vout ?? i.previousVout ?? i.outIdx]).map((x) => x[0]), [B1.txid, B2.txid]);
  assert.equal(tx.locktime, 157100, 'the locktime is the later maturity (each leaf\'s CHECKLOCKTIMEVERIFY holds)');
  assert.equal(tx.outputs.length, 1);
  assert.equal(tx.outputs[0].value + BigInt(w.fee), 132000n, 'the whole bond - both outputs - less the fee');
  const prevouts = [B1, B2].map((b) => ({ value: BigInt(b.sats), script: fromHex(spkOf(nodeKey, b.maturity, 'testnet4')) }));
  [B1, B2].forEach((b, n) => {
    const leaf = recoveryLeaf(nodeKey, b.maturity);
    assert.equal(toHex(tx.witnesses[n][1]), toHex(leaf), `input ${n} on its own recovery leaf`);
    const sighash = tapSighash({ version: 2, locktime: tx.locktime, inputs: tx.inputs.map((i) => ({ txid: i.previousTxid, vout: i === tx.inputs[0] ? B1.vout : B2.vout, sequence: 0xfffffffe })),
      outputs: tx.outputs, prevouts, inputIndex: n, leafHash: tapLeafHash(leaf) });
    assert.equal(schnorr.verify(tx.witnesses[n][0], sighash, nodeKey), true, `input ${n} signed by the node's key`);
  });
  assert.deepEqual(w.spent.map((o) => `${o.txid.slice(0, 4)}:${o.vout}:${o.sats}`), ['0101:0:100000', '0202:1:32000']);
  assert.throws(() => withdrawSpend({ bonds: [B1, B1], nodeSecret, network: 'testnet4', script: to }), /named twice/);
  assert.throws(() => withdrawSpend({ bonds: [B1, { ...B2, template: 1 }], nodeSecret, network: 'testnet4', script: to }), /template 1 bond is not withdrawn here/);
});

test('#1439 the node\'s outputs on the chain: unspent and paying this node\'s bond script at that maturity, the chain\'s amount', async () => {
  const stranger = schnorr.getPublicKey(new Uint8Array(32).fill(9));
  const B3 = { txid: '03'.repeat(32), vout: 0, sats: '50000', maturity: 157000, template: BOND_TEMPLATE_V2 };
  const B4 = { txid: '04'.repeat(32), vout: 0, sats: '1', maturity: 157000, template: BOND_TEMPLATE_V2 };   // a record that lies about its maturity
  const chain = new Map([
    [`${B2.txid}:1`, { sats: 32000n, script: spkOf(nodeKey, B2.maturity, 'testnet4') }],
    [`${B3.txid}:0`, { sats: 50000n, script: spkOf(stranger, B3.maturity, 'testnet4') }],
    [`${B4.txid}:0`, { sats: 40000n, script: spkOf(nodeKey, 157555, 'testnet4') }],
  ]);
  const txOut = async (t, v) => chain.get(`${t}:${v}`) || null;
  const got = await ownOutputsOnChain({ outputs: [B1, B2, B3, B4, { ...B2, sats: '999' }], nodeKey, network: 'testnet4', txOut });
  assert.deepEqual(got.map((o) => [o.txid.slice(0, 4), o.sats]), [['0202', '32000']], 'B1 spent, B3 a stranger\'s, B4 not at its named maturity, B2 once');
  await assert.rejects(ownOutputsOnChain({ outputs: [B2], nodeKey, network: 'testnet4', txOut: async () => { throw new Error('down'); } }), /down/);
});

test('#1439 the door: an added output no census counts any more is still withdrawn by the owner, the census\'s spent output left out', async () => {
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const ownerRec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const store = { read: () => ownerRec, write: (o) => Object.assign(ownerRec, o), writeCode: () => {} };
  let tip = 900050; const sent = []; const chain = new Map();
  const s = await joinedWithLock({ owner: { store }, chainTip: async () => tip, chainSend: async (hex) => { sent.push(hex); return 'cd'.repeat(32); },
    chainTxOut: async (t, v) => chain.get(`${t}:${v}`) || null });
  try {
    const me = s.d.round.pubkey;
    const base = `http://127.0.0.1:${s.d.port}`;
    // the census this seat holds names this node's first output (the fixture's); the chain says it is spent - withdrawn before
    const first = (await (await fetch(`${base}/owner/bond`)).json());
    assert.equal(first.bond.sats, '100000000', 'the census names the first output');
    // the added output: kept when a census named it, then left alone below the floor, now in no census
    const added = { txid: '0a'.repeat(32), vout: 2, sats: '32000', maturity: 900100, template: BOND_TEMPLATE_V2 };
    chain.set(`${added.txid}:2`, { sats: 32000n, script: spkOf(me, added.maturity, 'regtest') });
    s.d.round.db.exec('CREATE TABLE IF NOT EXISTS own_bond_outputs (node TEXT NOT NULL, txid TEXT NOT NULL, vout INTEGER NOT NULL, sats TEXT NOT NULL, maturity INTEGER, template INTEGER, PRIMARY KEY (node, txid, vout))');
    s.d.round.db.prepare('INSERT OR IGNORE INTO own_bond_outputs (node, txid, vout, sats, maturity, template) VALUES (?, ?, ?, ?, ?, ?)').run(toHex(me), added.txid, 2, '32000', added.maturity, BOND_TEMPLATE_V2);
    const node = (await (await fetch(`${base}/owner`)).json()).node;
    const ask = (k, args) => fetch(`${base}/owner/bond-withdraw`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signOwnerRequest({ node, action: 'bond-withdraw', args, secret: k, sign: (m, x) => schnorr.sign(m, x), pubkeyOf: (x) => schnorr.getPublicKey(x) })) });
    const address = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
    const locked = await ask(secret, { address, feeRate: 2 });
    assert.equal(locked.status, 409); assert.match((await locked.json()).why, /locked until block 900100: 50 blocks from now/);
    tip = 900100;
    assert.equal((await ask(ownerSecretFromSeed(new Uint8Array(32).fill(9)), { address })).status, 403, 'a stranger: refused');
    // a second added output, locked longer: the unlocked one goes now, this one stays findable and goes once its own lock is over
    const later = { txid: '0b'.repeat(32), vout: 0, sats: '20000', maturity: 900200, template: BOND_TEMPLATE_V2 };
    chain.set(`${later.txid}:0`, { sats: 20000n, script: spkOf(me, later.maturity, 'regtest') });
    s.d.round.db.prepare('INSERT OR IGNORE INTO own_bond_outputs (node, txid, vout, sats, maturity, template) VALUES (?, ?, ?, ?, ?, ?)').run(toHex(me), later.txid, 0, '20000', later.maturity, BOND_TEMPLATE_V2);
    const ok = await ask(secret, { address, feeRate: 2 });
    const j = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(j));
    assert.deepEqual(j.spent.map((o) => [o.txid, o.vout, o.sats]), [[added.txid, 2, '32000']], 'the unlocked added output, and only what is unspent');
    assert.deepEqual(j.stillLocked.map((o) => [o.txid, o.maturity]), [[later.txid, 900200]], 'the locked one said, not spent');
    const tx = parseTransaction(fromHex(sent[0]));
    assert.deepEqual([sent.length, tx.inputs.length, tx.locktime, tx.outputs[0].value + BigInt(j.fee)], [1, 1, 900100, 32000n]);
    // the next block: the first spent on the chain; the later one still locked, so the door says when
    chain.delete(`${added.txid}:2`);
    const wait = await ask(secret, { address });
    assert.equal(wait.status, 409); assert.match((await wait.json()).why, /locked until block 900200: 100 blocks from now/);
    tip = 900200;
    const two = await ask(secret, { address, feeRate: 2 });
    const j2 = await two.json();
    assert.equal(two.status, 200, JSON.stringify(j2));
    assert.deepEqual([j2.spent.map((o) => o.txid), j2.stillLocked], [[later.txid], []], 'the later output withdrawn too: nothing left behind');
    // no output of this node left on the chain: said so
    chain.clear();
    const none = await ask(secret, { address });
    assert.equal(none.status, 409); assert.match((await none.json()).why, /no output of this node's bond is unspent on the chain/);
  } finally { await s.d.close(); }
});
