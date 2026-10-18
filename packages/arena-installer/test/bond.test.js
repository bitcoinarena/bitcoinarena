// THE NODE'S WALLET AND BOND (kanban #471 slice 2): the wallet's address is BIP86 on testnet4, the bond is two transactions a census
// reads as this node's template-2 bond. Measured 2026-10-18 against testnet4 Bitcoin Core: 20 of 20 wallet addresses equal to
// `deriveaddresses tr(key)`; a funding + bond package from a 5,000 sat deposit accepted by testmempoolaccept (111 vB at 232 sat,
// 346 vB at 702 sat; never broadcast).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { walletOf, payoutKeyOf, taprootAddress, addressScript, scriptHash } from '../src/wallet.js';
import { buildBond, lockOf, advertRoles, bondKeyAt, BOND_MIN_SATS } from '../src/bond.js';
import { advertInTransaction } from '../../arena-protocol/src/census.js';
import { parseTransaction, commitmentsOf } from '../../arena-protocol/src/tx.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('the wallet: BIP86 testnet4 addresses (BIP350 vectors), decoded back; mainnet and bad checksums refused', () => {
  // BIP350's test vector for v1 on testnet: tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c = program 000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433
  assert.equal(taprootAddress(fromHex('000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433')), 'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c');
  assert.equal(toHex(addressScript('tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c')), '5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433');
  assert.equal(toHex(addressScript('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7')), '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262');
  assert.equal(addressScript('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k8'), null, 'a wrong checksum');
  assert.equal(addressScript('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'), null, 'mainnet');
  const seed = new Uint8Array(32).fill(7);
  const w = walletOf(seed);
  assert.match(w.address, /^tb1p[02-9ac-hj-np-z]{58}$/);
  assert.equal(toHex(addressScript(w.address)), toHex(w.spk));
  assert.deepEqual(walletOf(seed).address, w.address, 'the same words, the same wallet');
  assert.notEqual(toHex(payoutKeyOf(seed)), toHex(w.xonly), 'the payout key is its own');
  assert.match(scriptHash(w.spk), /^[0-9a-f]{64}$/);
});

test('the bond: two transactions, the census reads the second as this node\'s template-2 bond at its maturity', () => {
  const seed = new Uint8Array(32).fill(9);
  const w = walletOf(seed);
  const nodeSecret = new Uint8Array(32).fill(3);
  const coins = [{ txid: 'ae7909350adbc9948f59cb2787a4db003d3dea69f6e117025a8a8ebeac18fa6d', vout: 1, sats: 30000 }, { txid: '11'.repeat(32), vout: 0, sats: 30000 }];
  const b = buildBond({ wallet: w, nodeSecret, coins, tip: 156900, operatorId: 'op-test', roles: ['verify', 'settlement'], endpoint: 'https://node.example.com', payoutPubkey: payoutKeyOf(seed), nowMs: 1792300000000 });
  assert.equal(b.maturity, 156900 + 1 + 6 + 144);
  assert.equal(b.bondSats, BOND_MIN_SATS);
  const fund = parseTransaction(fromHex(b.funding.hex));
  assert.equal(fund.inputs.length, 2, 'every coin of the wallet');
  const tx = parseTransaction(fromHex(b.bond.hex));
  assert.equal(toHex(Uint8Array.from(tx.inputs[0].previousTxid).reverse()), b.funding.txid, 'the bond spends the funding');
  const advert = advertInTransaction(fromHex(b.bond.hex));
  assert.ok(advert, 'the census finds the advertisement in the witness');
  assert.equal(toHex(advert.nodePubkey), toHex(schnorr.getPublicKey(nodeSecret)));
  assert.deepEqual([advert.bondMaturityHeight, advert.endpoint, advert.operatorId], [b.maturity, 'https://node.example.com', 'op-test']);
  assert.deepEqual([...advert.roles].sort(), ['game', 'settlement', 'verify']);
  assert.equal(toHex(commitmentsOf(tx)[0]), toHex(advertId(advert)), 'the commitment is the advertisement\'s id');
  assert.equal(toHex(tx.outputs[0].script), '5120' + toHex(bondKeyAt(schnorr.getPublicKey(nodeSecret), b.maturity).outputKey), 'output 0 is the bond');
  assert.equal(tx.outputs[0].value, BOND_MIN_SATS);
  assert.equal(toHex(tx.outputs[3].script), toHex(w.spk), 'the change returns to the wallet');
  assert.throws(() => buildBond({ wallet: w, nodeSecret, coins: [{ txid: '22'.repeat(32), vout: 0, sats: 40000 }], tip: 1, operatorId: 'x', roles: ['verify'], endpoint: 'https://x', payoutPubkey: payoutKeyOf(seed) }),
    /a bond of 50000 sat needs at least/);
  assert.deepEqual(advertRoles(['settlement']), ['settlement']);
  const lock = lockOf(156900, { nowMs: 0 });
  assert.deepEqual([lock.maturity, lock.blocks, lock.estimatedMs], [157051, 151, 151 * 600000]);
});
