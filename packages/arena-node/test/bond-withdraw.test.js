// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER TAKES THE BOND BACK AFTER ITS LOCK (bond-withdraw.js). Measured 2026-10-18 against testnet4 Bitcoin
// Core: the recovery spend of test host seat 1's live template-2 bond (d4a317b8...:0, 50,000 sat, maturity 156,193, tip 156,900) built
// here was accepted by testmempoolaccept (126 vB, fee 262 sat) and never broadcast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ownBondOf, lockAt, withdrawSpend, bondKeyOf } from '../src/bond-withdraw.js';
import { buildBond } from '../../arena-installer/src/bond.js';
import { walletOf, payoutKeyOf } from '../../arena-installer/src/wallet.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { recoveryLeaf, tapLeafHash, BOND_TEMPLATE_V2 } from '../../arena-protocol/src/bond-script.js';
import { tapSighash } from '../../arena-protocol/src/bond-spend.js';
import { addressScript } from '../../arena-protocol/src/address.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('the node\'s bond from a census entry, its lock said plainly, and its recovery spend signed by the node\'s key at maturity', () => {
  const nodeSecret = new Uint8Array(32).fill(5);
  const nodeKey = schnorr.getPublicKey(nodeSecret);
  const seed = new Uint8Array(32).fill(6);
  const built = buildBond({ wallet: walletOf(seed), nodeSecret, coins: [{ txid: '33'.repeat(32), vout: 0, sats: 60000 }], tip: 156900,
    operatorId: 'op-test', roles: ['verify'], endpoint: 'https://node.example.com', payoutPubkey: payoutKeyOf(seed) });
  const tx = parseTransaction(fromHex(built.bond.hex));
  // the census's entry for it: the txid as the chain's bytes, vout, height, amount, advertisement
  const entry = { txid: tx.txid, vout: 0, pubkey: nodeKey, height: 156901, bondSats: 50000n, advert: advertInTransaction(fromHex(built.bond.hex)) };
  const other = { ...entry, pubkey: new Uint8Array(32).fill(1) };
  const bond = ownBondOf([other, entry], toHex(nodeKey));
  assert.deepEqual(bond, { txid: built.bond.txid, vout: 0, sats: '50000', height: 156901, maturity: built.maturity, template: BOND_TEMPLATE_V2 });
  assert.equal(ownBondOf([other], toHex(nodeKey)), null, 'a census without this node names no bond of it');

  const before = lockAt(bond, built.maturity - 10, 0);
  assert.deepEqual([before.blocksLeft, before.estimatedMs, before.withdrawable], [10, 10 * 600000, false], 'ten blocks to go: locked');
  assert.equal(lockAt(bond, built.maturity).withdrawable, true, 'at the maturity height: withdrawable');

  const to = addressScript('tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c');
  const w = withdrawSpend({ bond, nodeSecret, network: 'testnet4', script: to, feeRate: 2 });
  const spend = parseTransaction(fromHex(w.hex));
  assert.equal(spend.locktime, built.maturity, 'locktime = maturity (the leaf\'s CHECKLOCKTIMEVERIFY)');
  assert.equal(toHex(Uint8Array.from(spend.inputs[0].previousTxid).reverse()), built.bond.txid);
  assert.equal(toHex(spend.outputs[0].script), toHex(to));
  assert.equal(spend.outputs[0].value + BigInt(w.fee), 50000n, 'the whole bond less the fee');
  const leaf = recoveryLeaf(nodeKey, built.maturity);
  assert.equal(toHex(spend.witnesses[0][1]), toHex(leaf), 'spent on the recovery leaf');
  const spk = fromHex('5120' + toHex(bondKeyOf(nodeKey, built.maturity, 'testnet4').outputKey));
  assert.equal(toHex(spk), toHex(tx.outputs[0].script), 'the output it spends is the bond');
  const sighash = tapSighash({ version: 2, locktime: spend.locktime, inputs: [{ txid: spend.inputs[0].previousTxid, vout: 0, sequence: 0xfffffffe }],
    outputs: spend.outputs, prevouts: [{ value: 50000n, script: spk }], inputIndex: 0, leafHash: tapLeafHash(leaf) });
  assert.equal(schnorr.verify(spend.witnesses[0][0], sighash, nodeKey), true, 'signed by the node\'s key');
  assert.throws(() => withdrawSpend({ bond: { ...bond, sats: '400' }, nodeSecret, network: 'testnet4', script: to }), /leaves nothing after a fee/);
});
