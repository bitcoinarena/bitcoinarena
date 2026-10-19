// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BOND MATURES AT ITS OWN HEIGHT (spec 5A.3B: "`bond_maturity` is an absolute locktime, reference 30 days
// after the bond confirms"). Template 1 put genesis' 100 in every recovery leaf - a height, so on testnet4 path A of
// every bond was spendable the block it confirmed. Template 2 carries `bond_maturity_height` in the advertisement and the
// same height in the leaf; the census counts it only at confirmation + the network's offset or later. Measured here on
// the real curve: the key rebuilds with the body's height and with no other; the census counts a bond at confirmation +
// offset, excludes one a block short by name, and still counts template 1 where it is read; template 1 is refused on
// mainnet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  bondOutputKey, bondInternalKey, bondMaturityOf, maturityStands, maturityHeightFor,
  BOND_MATURITY_OFFSET, BOND_TEMPLATE_V2,
} from '../../arena-protocol/src/bond-script.js';
import { genesisFor } from '../../arena-protocol/src/genesis.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { bondTransaction } from '../../arena-protocol/tools/bond.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { bondKeyMatches, recognizeBond } from '../../arena-protocol/src/chain.js';
import { resolveCensus } from '../../arena-protocol/src/census.js';
import { encodeAdvert, decodeAdvert, advertId } from '../../arena-protocol/src/advert.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { tweakPoint, combine } from '../src/curve.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const g = genesisFor('regtest');
const BOND = { arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: g.bondMaturity, tweakPoint, combine };
const CONFIRMED = 900000;
const OFFSET = BOND_MATURITY_OFFSET.regtest;

const bodyFor = (nodeKey, over = {}) => ({
  nodePubkey: nodeKey, operatorId: 'operator', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'],
  endpoint: 'ws://node', region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32),
  bondVout: 0, bondScriptTemplateVersion: BOND_TEMPLATE_V2, bondMaturityHeight: CONFIRMED + OFFSET,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n, ...over,
});
const keyAt = (nodeKey, maturity) => bondOutputKey({
  nodeKey, arbitrationKeys: g.arbitrationKeys, arbitrationK: g.arbitrationK, bondMaturity: maturity,
  internalKey: bondInternalKey({ nodeKey, arbitrationKeys: g.arbitrationKeys }, { combine }).internalKey,
}, { tweakPoint, combine }).outputKey;
const node = () => schnorr.getPublicKey(schnorr.utils.randomSecretKey());

test('the offsets are the spec table: ~30 days on mainnet, ~1 day on testnet4, 100 blocks on regtest', () => {
  assert.deepEqual({ ...BOND_MATURITY_OFFSET }, { mainnet: 4320, testnet4: 144, regtest: 100 });
  assert.equal(maturityHeightFor(156000, 'testnet4'), 156000 + 1 + 6 + 144, 'the next block, its slack, the offset');
  assert.equal(maturityHeightFor(156000, 'testnet4', { slackBlocks: 0 }), 156145);
});

test('a template-2 body carries its height on the wire; a template-1 body is byte for byte what it was', () => {
  const k = node();
  const v2 = bodyFor(k);
  const back = decodeAdvert(encodeAdvert(v2));
  assert.equal(back.bondScriptTemplateVersion, 2);
  assert.equal(back.bondMaturityHeight, CONFIRMED + OFFSET);
  assert.deepEqual(advertId(back), advertId(v2));
  const v1 = bodyFor(k, { bondScriptTemplateVersion: 1, bondMaturityHeight: undefined });
  delete v1.bondMaturityHeight;
  assert.equal(encodeAdvert(v2).length, encodeAdvert(v1).length + 4, 'four bytes, only for template 2');
  assert.equal('bondMaturityHeight' in decodeAdvert(encodeAdvert(v1)), false);
  assert.throws(() => encodeAdvert({ ...v1, bondMaturityHeight: 5 }), /template 1 carries no bond_maturity_height/);
  assert.throws(() => encodeAdvert({ ...v2, bondMaturityHeight: undefined }), /bond_maturity_height as a block height/);
  assert.throws(() => encodeAdvert({ ...v2, bondMaturityHeight: 500000000 }), /bond_maturity_height as a block height/,
    'a CLTV of 500 000 000 or more is a time, not a height');
});

test('the key rebuilds with the body\'s height and with no other: a wrong maturity height does not rebuild the bond key', () => {
  const k = node();
  const tx = parseTransaction(bondTransaction(bodyFor(k), { outputKey: keyAt(k, CONFIRMED + OFFSET) }));
  const seen = bondKeyMatches(tx.outputs[0].script, bodyFor(k), BOND);
  assert.equal(seen.ok, true, seen.why);
  for (const lie of [CONFIRMED + OFFSET + 1, CONFIRMED + OFFSET - 1, g.bondMaturity]) {
    const wrong = bondKeyMatches(tx.outputs[0].script, bodyFor(k, { bondMaturityHeight: lie }), BOND);
    assert.equal(wrong.ok, false, `a body naming ${lie} rebuilt the key of a leaf at ${CONFIRMED + OFFSET}`);
    assert.match(wrong.why, /not the taproot tweak of the keys and maturity it declares/);
  }
  // and a template-1 body over a template-2 leaf rebuilds genesis' 100, which is not the leaf either
  const asV1 = { ...bodyFor(k), bondScriptTemplateVersion: 1 }; delete asV1.bondMaturityHeight;
  assert.match(bondKeyMatches(tx.outputs[0].script, asV1, BOND).why, /not the taproot tweak/);
  assert.match(bondKeyMatches(tx.outputs[0].script, bodyFor(k, { bondScriptTemplateVersion: 3 }), BOND).why,
    /names bond script template 3, and this code reads templates 1 and 2/);
});

test('template 1 is read on regtest and testnet4 and refused on mainnet', () => {
  const v1 = { bondScriptTemplateVersion: 1 };
  assert.deepEqual(bondMaturityOf(v1, { genesisMaturity: 100, network: 'regtest' }), { ok: true, maturity: 100 });
  assert.deepEqual(bondMaturityOf(v1, { genesisMaturity: 100, network: 'testnet4' }), { ok: true, maturity: 100 });
  assert.match(bondMaturityOf(v1, { genesisMaturity: 100, network: 'mainnet' }).why, /template 1 is not read on mainnet/);
  assert.deepEqual(bondMaturityOf({ bondScriptTemplateVersion: 2, bondMaturityHeight: 156151 }, { network: 'mainnet' }),
    { ok: true, maturity: 156151 });
});

test('on testnet4 the maturity is the confirmation plus 144, and one block short is refused by name', () => {
  const v2 = (h) => ({ bondScriptTemplateVersion: 2, bondMaturityHeight: h });
  assert.equal(maturityStands(v2(156000 + 144), 156000, 'testnet4').ok, true);
  assert.equal(maturityStands(v2(156000 + 500), 156000, 'testnet4').ok, true, 'later is the node\'s own choice');
  assert.equal(maturityStands(v2(156143), 156000, 'testnet4').why,
    'that bond matures at height 156143, 1 block(s) short of its confirmation 156000 plus 144');
  assert.equal(maturityStands(v2(160320 - 1), 156000, 'mainnet').ok, false);
  assert.equal(maturityStands(v2(156000 + 4320), 156000, 'mainnet').ok, true);
  assert.match(maturityStands(v2(156144), undefined, 'testnet4').why, /no confirmation height is known/);
  assert.equal(maturityStands({ bondScriptTemplateVersion: 1 }, 156000, 'testnet4').ok, true, 'template 1 is not measured here');
});

test('the census counts a template-2 bond at confirmation + offset, excludes one a block short by name, and still counts template 1', () => {
  const contract = { bondMinSats: 50000n, protocolVersion: 1, networkId: NETWORK_ID_REGTEST };
  const at = (k, body, outputKey, height = CONFIRMED) => {
    const transaction = bondTransaction(body, { outputKey, previousTxid: b32(k[0]) });
    return { tx: transaction, entry: { txid: parseTransaction(transaction).txid, vout: 0, pubkey: k, bondSats: 60000n, height,
      hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game'], spent: false } };
  };
  const ripe = node(), short = node(), old = node(), later = node();
  const v1Body = bodyFor(old, { bondScriptTemplateVersion: 1 }); delete v1Body.bondMaturityHeight;
  const bonds = [
    at(ripe, bodyFor(ripe), keyAt(ripe, CONFIRMED + OFFSET)),
    at(short, bodyFor(short, { bondMaturityHeight: CONFIRMED + OFFSET - 1 }), keyAt(short, CONFIRMED + OFFSET - 1)),
    at(old, v1Body, keyAt(old, g.bondMaturity)),
    at(later, bodyFor(later, { bondMaturityHeight: CONFIRMED + 2 * OFFSET }), keyAt(later, CONFIRMED + 2 * OFFSET)),
  ];
  const byTxid = new Map(bonds.map((b) => [toHex(b.entry.txid), b.tx]));
  const seen = resolveCensus(bonds.map((b) => b.entry), { contract, bond: BOND, resolve: (e) => ({ transaction: byTxid.get(toHex(e.txid)) }) });
  assert.equal(seen.ok, true, seen.why);
  const counted = seen.eligible.map((e) => toHex(e.pubkey)).sort();
  assert.deepEqual(counted, [ripe, old, later].map(toHex).sort(), `excluded: ${seen.excluded.map((e) => e.why).join(' | ')}`);
  assert.equal(seen.excluded.length, 1);
  assert.deepEqual(seen.excluded[0].pubkey, short);
  assert.equal(seen.excluded[0].why, `that bond matures at height ${CONFIRMED + OFFSET - 1}, 1 block(s) short of its confirmation ${CONFIRMED} plus ${OFFSET}`);

  // THE SAME BOND, CONFIRMED ONE BLOCK LATER THAN ITS NODE PLANNED FOR, IS SHORT TOO: the height is the chain's, not the plan's
  const late = at(ripe, bodyFor(ripe), keyAt(ripe, CONFIRMED + OFFSET), CONFIRMED + 1);
  const again = resolveCensus([late.entry], { contract, bond: BOND, resolve: () => ({ transaction: late.tx }) });
  assert.equal(again.eligible.length, 0);
  assert.match(again.excluded[0].why, /1 block\(s\) short of its confirmation 900001 plus 100/);
});

test('the player\'s door rebuilds a template-2 key and refuses a mainnet template 1', () => {
  const k = node();
  const tx = parseTransaction(bondTransaction(bodyFor(k), { outputKey: keyAt(k, CONFIRMED + OFFSET) }));
  assert.equal(recognizeBond(tx, 0, bodyFor(k), { bond: BOND }).ok, true);
  const v1 = bodyFor(k, { bondScriptTemplateVersion: 1 }); delete v1.bondMaturityHeight;
  const tx1 = parseTransaction(bondTransaction(v1, { outputKey: keyAt(k, g.bondMaturity) }));
  assert.equal(recognizeBond(tx1, 0, v1, { bond: BOND }).ok, true, 'regtest still reads template 1');
  assert.match(bondKeyMatches(tx1.outputs[0].script, v1, { ...BOND, network: 'mainnet' }).why, /template 1 is not read on mainnet/);
});
