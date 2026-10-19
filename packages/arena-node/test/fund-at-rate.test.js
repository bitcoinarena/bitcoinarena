// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A transaction funded under the wallet's floor (fund-at-rate.js): the coins chosen here, the fee the asked rate times
// the signed size, a change below dust given to the fee, every input replaceable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fundAtRate, serializeUnsigned } from '../src/fund-at-rate.js';

const CHANGE = '5120' + '11'.repeat(32);
// A WALLET THAT SIGNS BY ADDING 100 vB PER INPUT: decoderawtransaction reads the size back from the unsigned bytes
function wallet(coins) {
  const signed = new Map();
  return {
    seen: [],
    rpc: async (m, p) => {
      if (m === 'listunspent') return coins;
      if (m === 'getrawchangeaddress') return 'tb1pchange';
      if (m === 'getaddressinfo') return { scriptPubKey: CHANGE };
      if (m === 'signrawtransactionwithwallet') { const hex = 'ff' + p[0]; signed.set(hex, p[0]); return { complete: true, hex }; }
      if (m === 'decoderawtransaction') { const raw = Buffer.from(signed.get(p[0]), 'hex'); return { vsize: raw.length + 100 * raw[4] }; }
      throw new Error(m);
    },
  };
}
const op = Buffer.concat([Buffer.alloc(8), Buffer.from([38, 0x6a, 36]), Buffer.alloc(36, 1)]);

test('the fee is the asked rate times the signed size, the rest is change, inputs replaceable', async () => {
  const w = wallet([{ txid: 'aa'.repeat(32), vout: 1, amount: 0.0001, spendable: true, safe: true }]);
  const outs = Array(10).fill(op);
  const got = await fundAtRate(w.rpc, outs, 0.1);
  assert.equal(got.fee, BigInt(Math.ceil(got.vsize * 0.1)));
  const unsigned = Buffer.from(got.hex.slice(2), 'hex');
  assert.equal(unsigned.toString('hex'), serializeUnsigned([{ txid: 'aa'.repeat(32), vout: 1 }], outs, { value: 10000n - got.fee, script: Buffer.from(CHANGE, 'hex') }));
  assert.equal(unsigned.readUInt32LE(4 + 1 + 36 + 1), 0xfffffffd);
});

test('coins are taken largest first until they pay; a change below dust goes to the fee', async () => {
  const coins = [{ txid: '01'.repeat(32), vout: 0, amount: 0.00000300, spendable: true, safe: true },
    { txid: '02'.repeat(32), vout: 0, amount: 0.00000700, spendable: true, safe: true },
    { txid: '03'.repeat(32), vout: 0, amount: 0.5, spendable: false, safe: true }];
  const got = await fundAtRate(wallet(coins).rpc, [op], 1);
  // 700 sat less ~200 vB at 1 sat/vB leaves ~500 change: one input, change kept
  assert.equal(Buffer.from(got.hex.slice(2), 'hex')[4], 1);
  const dusty = await fundAtRate(wallet(coins).rpc, [op], 2.5);
  assert.equal(dusty.fee, 700n, 'a change under 330 sat is the fee');
});

test('coins that cannot pay are refused by name', async () => {
  await assert.rejects(fundAtRate(wallet([{ txid: '01'.repeat(32), vout: 0, amount: 0.00000100, spendable: true, safe: true }]).rpc, [op], 1), /do not pay 1 outputs at 1 sat\/vB/);
});
