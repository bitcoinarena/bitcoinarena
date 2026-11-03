// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S WALLET AND BOND: the wallet's address is BIP86 on testnet4, the bond is two transactions a census
// reads as this node's template-2 bond. Measured 2026-10-18 against testnet4 Bitcoin Core: 20 of 20 wallet addresses equal to
// `deriveaddresses tr(key)`; a funding + bond package from a 5,000 sat deposit accepted by testmempoolaccept (111 vB at 232 sat,
// 346 vB at 702 sat; never broadcast).
import { test } from 'node:test';
import { ownerKeysOf } from '../src/seed.js';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { walletOf, payoutKeyOf, taprootAddress, addressScript, scriptHash } from '../src/wallet.js';
import { buildBond, lockOf, advertRoles, bondKeyAt, BOND_MIN_SATS, BOND_SLACK_BLOCKS, bondCounts, censusKeyOfNode, bondNetworkOf, NETWORK } from '../src/bond.js';
import { readsTemplate3Only } from '../../arena-protocol/src/genesis.js';
import { recognizeBond } from '../../arena-protocol/src/chain.js';
import { readAdvertUpdate } from '../../arena-protocol/src/advert-update.js';
import { bondPresigStands } from '../../arena-protocol/src/slash-presig.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { bondSetFor, tweakPoint } from '../../arena-node/src/curve.js';
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
  assert.equal(b.maturity, 156900 + 1 + BOND_SLACK_BLOCKS + 144, 'a day of slack to confirm in');
  assert.equal(b.bondSats, BOND_MIN_SATS);
  const fund = parseTransaction(fromHex(b.funding.hex));
  assert.equal(fund.inputs.length, 2, 'every coin of the wallet');
  const tx = parseTransaction(fromHex(b.bond.hex));
  assert.equal(toHex(Uint8Array.from(tx.inputs[0].previousTxid).reverse()), b.funding.txid, 'the bond spends the funding');
  const advert = advertInTransaction(fromHex(b.bond.hex));
  assert.ok(advert, 'the census finds the advertisement in the witness');
  assert.equal(toHex(advert.nodePubkey), toHex(schnorr.getPublicKey(nodeSecret)));
  assert.deepEqual([advert.bondMaturityHeight, advert.endpoint, advert.operatorId], [b.maturity, 'https://node.example.com', 'op-test']);
  assert.deepEqual([...advert.roles].sort(), ['game', 'relay', 'settlement', 'verify']);
  assert.equal(toHex(commitmentsOf(tx)[0]), toHex(advertId(advert)), 'the commitment is the advertisement\'s id');
  assert.equal(toHex(tx.outputs[0].script), '5120' + toHex(bondKeyAt(schnorr.getPublicKey(nodeSecret), b.maturity).outputKey), 'output 0 is the bond');
  assert.equal(tx.outputs[0].value, BOND_MIN_SATS);
  assert.equal(toHex(tx.outputs[3].script), toHex(w.spk), 'the change returns to the wallet');
  assert.throws(() => buildBond({ wallet: w, nodeSecret, coins: [{ txid: '22'.repeat(32), vout: 0, sats: 40000 }], tip: 1, operatorId: 'x', roles: ['verify'], endpoint: 'https://x', payoutPubkey: payoutKeyOf(seed) }),
    /a bond of 50000 sat needs at least/);
  assert.deepEqual(advertRoles(['settlement']), ['settlement', 'relay']);   // relay always (2026-10-26)
  assert.deepEqual(advertRoles(['verify', 'settlement', 'custody', 'liquidity']), ['game', 'verify', 'settlement', 'relay'], 'custody and liquidity are no advertisement roles (macOS node A: "unknown role: liquidity")');
  const lock = lockOf(156900, { nowMs: 0 });
  assert.deepEqual([lock.maturity, lock.blocks, lock.estimatedMs], [157189, 289, 289 * 600000]);
  // measured on testnet4 2026-10-19: built at 156976 with the old 6 blocks of slack (maturity 157121), confirmed at 157000 - never counted
  assert.deepEqual(bondCounts({ maturity: 157121, confirmedAt: 157000 }), { counts: false, short: 23 });
  assert.deepEqual(bondCounts({ maturity: 157156, confirmedAt: 157012 }), { counts: true, short: 0 }, 'installer node B: no block to spare');
  assert.equal(bondCounts({ maturity: lock.maturity, confirmedAt: 156900 + 1 + BOND_SLACK_BLOCKS }).counts, true, 'now a day late still counts');
});

// kanban #575: the release no longer carries the apps, so bond.js names Next Block's game id as a constant - the id of the pinned app
test('the advertisement\'s hosted game is the id of the Next Block the Arena pins', async () => {
  const { NEXTBLOCK_GAME_ID } = await import('../src/bond.js');
  const app = await import('../../nextblock/plugin/nextblock.js');
  assert.equal(toHex(NEXTBLOCK_GAME_ID), toHex(app.NEXTBLOCK_GAME_ID));
});

test('a template-3 bond (5A.3B, kanban #1053): it names the census key, and its slash_presig goes out as a third transaction the one funding pays for', () => {
  const seed = new Uint8Array(32).fill(9), w = walletOf(seed), nodeSecret = new Uint8Array(32).fill(3);
  const censusKey = schnorr.getPublicKey(new Uint8Array(32).fill(8));
  const built = buildBond({ wallet: w, nodeSecret, coins: [{ txid: '11'.repeat(32), vout: 0, sats: 200000 }], tip: 156900, operatorId: 'op-test', roles: ['verify', 'settlement'], endpoint: 'wss://node.example.com',
    payoutPubkey: payoutKeyOf(seed), softwareHash: new Uint8Array(32).fill(1), censusKey, network: 'regtest', ownerPubkey: ownerKeysOf(seed).pubkey });
  const funding = parseTransaction(fromHex(built.funding.hex)), bond = parseTransaction(fromHex(built.bond.hex)), update = parseTransaction(fromHex(built.presigUpdate.hex));
  const a = advertInTransaction(fromHex(built.bond.hex));
  assert.equal(a.bondScriptTemplateVersion, 3);
  assert.equal(toHex(a.censusKey), toHex(censusKey));
  // path A is the owner key's from the 24 words (kanban #1093 part 1): the advert names it
  assert.equal(toHex(a.ownerPubkey), toHex(ownerKeysOf(seed).pubkey));
  assert.ok(recognizeBond(bond, 0, a, { network: 'regtest', bond: bondSetFor('regtest') }).ok, 'the census reads it as that node\'s template-3 bond');
  assert.equal(toHex(bond.inputs[0].previousTxid), toHex(funding.txid));
  assert.deepEqual([bond.inputs[0].previousVout, update.inputs[0].previousVout], [0, 1], 'both carriers are the one funding\'s');
  assert.equal(toHex(update.inputs[0].previousTxid), toHex(funding.txid));
  const read = readAdvertUpdate(fromHex(built.presigUpdate.hex), { network: 'regtest' });
  assert.ok(read.ok, read.why);
  assert.equal(toHex(read.bondTxid), toHex(bond.txid));
  assert.equal(read.bondVout, 0);
  assert.ok(schnorr.verify(read.signature, read.advertId, read.nodePubkey), 'signed by the node');
  assert.ok(bondPresigStands({ presig: read.advert.slashPresig, bond: { txid: bond.txid, vout: 0, value: built.bondSats, script: bond.outputs[0].script }, advert: a, networkId: NETWORK_ID_REGTEST, tweakPoint,
    verify: (s, m, k) => schnorr.verify(s, m, k) }), 'the one signature a reader checks');
  assert.equal(funding.outputs[1].value, update.outputs[0].value + built.fees.presig - 330n, 'all that carrier held is the marker and its fee');
  assert.equal(built.censusKey, toHex(censusKey));
});

test('a network that reads template 3 only never falls back: no key read, no bond, refused by name (ruling #1065)', async () => {
  const seed = new Uint8Array(32).fill(9), w = walletOf(seed), nodeSecret = new Uint8Array(32).fill(3);
  const common = { wallet: w, nodeSecret, coins: [{ txid: 'aa'.repeat(32), vout: 0, sats: 2_000_000 }], tip: 156900, operatorId: 'op', roles: ['verify'], endpoint: 'wss://x.example', payoutPubkey: new Uint8Array(32).fill(1) };
  assert.throws(() => buildBond({ ...common, network: 'mainnet' }), /^Error: no census key read yet$/);
  assert.throws(() => buildBond({ ...common, network: 'mainnet', censusKey: null }), /no census key read yet/);
  assert.ok(buildBond({ ...common }).bondSats > 0n, 'testnet4 keeps template 2 where no key stands');
  assert.equal(bondNetworkOf({ network: 'mainnet' }), 'mainnet');
  assert.equal(bondNetworkOf({}), NETWORK);
  assert.deepEqual(['mainnet', 'testnet4', 'regtest'].map(readsTemplate3Only), [true, false, false]);
  const { addBondFromWallet } = await import('../../arena-node/src/add-bond-wallet.js');
  assert.deepEqual(await addBondFromWallet({ cli: () => { throw new Error('nothing is read'); }, network: 'mainnet', addSats: 100000 }), { ok: false, why: 'no census key read yet' }, 'nor from a bond wallet');
});

test('with no census key a bond stays template 2, and the seat that says so answers none', async () => {
  assert.equal(await censusKeyOfNode({ reach: { port: 1 } }, async () => ({ ok: false })), null, 'a network with no census key answers 404');
  assert.equal(await censusKeyOfNode({}), null);
  assert.equal(await censusKeyOfNode({ reach: { port: 1 } }, async () => { throw new Error('down'); }), null);
  const k = new Uint8Array(32).fill(5);
  assert.equal(toHex(await censusKeyOfNode({ reach: { port: 1 } }, async () => ({ ok: true, json: async () => ({ keys: [{ publicKey: '11'.repeat(32) }, { publicKey: toHex(k) }] }) }))), toHex(k), 'the newest');
});

test('the advertisement names the hash of the machine or provider the owner gave, nothing when none (kanban #1093 part 4)', async () => {
  const { advertFor } = await import('../src/bond.js');
  const { hostGroupOf, encodeAdvert, decodeAdvert } = await import('../../arena-protocol/src/advert.js');
  const base = { nodeKey: new Uint8Array(32).fill(1), operatorId: 'op-x', roles: ['custody'], endpoint: 'wss://n.example/x', payoutPubkey: new Uint8Array(32).fill(3),
    maturity: 160000, softwareHash: new Uint8Array(32).fill(2), nowMs: 1_800_000_000_000 };
  const a = advertFor({ ...base, hostGroup: '  Hetzner ' });
  assert.deepEqual(a.hostGroup, hostGroupOf('hetzner'), 'trimmed and case-folded: two nodes named "Hetzner" and "hetzner" share a group');
  assert.deepEqual(decodeAdvert(encodeAdvert(a)).hostGroup, a.hostGroup, 'through the bytes');
  assert.equal('hostGroup' in advertFor({ ...base, hostGroup: '   ' }), false);
  assert.equal('hostGroup' in advertFor(base), false);
});
