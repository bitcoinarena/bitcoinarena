// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BOND OF THE ANCESTOR NETWORK, CARRIED INTO THIS ONE BY ITS OPERATOR (§27A.8.3, spec 0A.9the owner
// 2026-10-08). testnet4's seven bonds were posted by the BLWP network: they pay the BLWP bond marker's dust and commit to
// an advertisement under the BLWP advert tag, in the layout of before hosted_games. After every tag is ARENA/v1, so
// the census found none of them. Now it finds them by the ancestor's marker and reads them by the ancestor's layout and
// id (ancestor.js), and counts one only once its operator published a re-affirmation (reaffirm.js): "ARN" 'F'
// network_id[0:8] and the bond's node key's signature over this network and this bond. An advertisement update then
// names its hosted games. A bond nobody re-affirmed is named, not counted; one already spent is not a bond.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from '../../arena-protocol/src/genesis-ids.js';
import { PROTOCOL_VERSION, bondMarker } from '../../arena-protocol/src/constants.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { advertId, joinSignedAdvert } from '../../arena-protocol/src/advert.js';
import { ancestorMarker, ancestorAdvertId, decodeAncestorAdvert } from '../../arena-protocol/src/ancestor.js';
import {
  reaffirmationMessage, reaffirmationPayload, readReaffirmationPayload, REAFFIRM_BYTES,
} from '../../arena-protocol/src/reaffirm.js';
import { deriveCensus } from '../../arena-protocol/src/census.js';
import { chainOf as minedChain } from '../../arena-protocol/tools/chainview.js';
import {
  bondTransaction, advertUpdateTransaction, encodeAncestorAdvert, reaffirmationTransaction,
} from '../../arena-protocol/tools/bond.js';
import { BOND, keyFor, bondFor } from './curve.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secretOf = (n) => b32(n);                       // curve.js keyFor(n) is the key of the secret n repeated
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const OLD = 0x21;                                     // the operator whose bond the BLWP network posted
const NEW = 0x22;                                     // an operator who bonded on this network
const STRANGER = 0x23;

const advertFor = (n, over = {}) => ({
  nodePubkey: keyFor(n), operatorId: 'operator', protocolVersions: [PROTOCOL_VERSION],
  hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify', 'settlement'], endpoint: `wss://node${n}.example/`, region: 'eu-west',
  capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: new Uint8Array(32), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [],
  guardianCapable: false, guardianEndpoint: '', timestamp: 1788700000000n, ...over,
});

// THE BLWP-ERA BOND: the ancestor's marker, the ancestor's layout, committed to by the ancestor's id, signed under it
const OLD_ADVERT = advertFor(OLD, { hostedGames: [] });
const OLD_BODY = encodeAncestorAdvert(OLD_ADVERT);
const OLD_ID = ancestorAdvertId(OLD_BODY);
const OLD_BOND_TX = bondTransaction(OLD_ADVERT, {
  commitment: OLD_ID, body: joinSignedAdvert(OLD_BODY, schnorr.sign(OLD_ID, secretOf(OLD))),
  markerProgram: ancestorMarker('regtest'), outputKey: bondFor(keyFor(OLD)), previousTxid: b32(0xa1), value: 100000,
});
const OLD_TXID = parseTransaction(OLD_BOND_TX).txid;
// AND ONE OF THIS NETWORK, as posts them
const NEW_ADVERT = advertFor(NEW);
const NEW_BOND_TX = bondTransaction(NEW_ADVERT, {
  signature: schnorr.sign(advertId(NEW_ADVERT), secretOf(NEW)), outputKey: bondFor(keyFor(NEW)), previousTxid: b32(0xa2), value: 100000,
});
const NEW_TXID = parseTransaction(NEW_BOND_TX).txid;
const byTxid = new Map([[toHex(OLD_TXID), OLD_BOND_TX], [toHex(NEW_TXID), NEW_BOND_TX]]);
const resolve = (e) => { const tx = byTxid.get(toHex(e.txid)); return tx ? { transaction: tx } : null; };

const reaffirm = ({ signer = OLD, networkId = NETWORK_ID_REGTEST, bondTxid = OLD_TXID, bondVout = 0, previousTxid = b32(0xb1) } = {}) =>
  reaffirmationTransaction({ networkId, previousTxid,
    signature: schnorr.sign(reaffirmationMessage({ networkId, bondTxid, bondVout }), secretOf(signer)) });
const UPDATED = advertFor(OLD, { hostedGames: [NEXTBLOCK_GAME_ID], timestamp: 1790000000000n });
const UPDATE_TX = advertUpdateTransaction(UPDATED, { bondTxid: OLD_TXID, bondVout: 0, signature: schnorr.sign(advertId(UPDATED), secretOf(OLD)) });

const HEIGHT = 900000;
const view = (at, tip = HEIGHT + 5, from = HEIGHT - 30) => {
  const blocks = [];
  for (let h = from; h <= tip; h++) blocks.push({ transactions: at[h] || [] });
  return minedChain(blocks, from);
};
const contract = { gameId: NEXTBLOCK_GAME_ID, bondMinSats: 50000n, protocolVersion: PROTOCOL_VERSION,
  censusHeight: HEIGHT, censusConfirmations: 6, networkId: NETWORK_ID_REGTEST };
const BONDS = { [HEIGHT - 25]: [OLD_BOND_TX], [HEIGHT - 20]: [NEW_BOND_TX] };
const derive = (extra = {}, over = {}) => deriveCensus(view({ ...BONDS, ...extra }), { contract, resolve, bond: BOND, verifyUpdate: verify, ...over });
const counted = (out) => out.entries.map((e) => toHex(e.pubkey)).sort();
const why = (out, n) => (out.excluded.find((e) => toHex(e.pubkey || new Uint8Array(32)) === toHex(keyFor(n))) || {});

test('the payload: 76 bytes, "ARN" F, the network id\'s first 8 bytes and the signature; the message names network and bond', () => {
  const sig = new Uint8Array(64).fill(7);
  const p = reaffirmationPayload({ networkId: NETWORK_ID_TESTNET4, signature: sig });
  assert.equal(p.length, REAFFIRM_BYTES);
  assert.equal(REAFFIRM_BYTES, 76);
  assert.deepEqual([...p.subarray(0, 4)], [0x41, 0x52, 0x4e, 0x46]);
  const r = readReaffirmationPayload(p);
  assert.deepEqual([toHex(r.networkPrefix), toHex(r.signature)], [toHex(NETWORK_ID_TESTNET4.subarray(0, 8)), toHex(sig)]);
  assert.equal(readReaffirmationPayload(p.subarray(0, 72)), null);
  const m = (o) => toHex(reaffirmationMessage({ networkId: NETWORK_ID_REGTEST, bondTxid: OLD_TXID, bondVout: 0, ...o }));
  assert.notEqual(m({}), m({ bondVout: 1 }), 'the message does not name the bond output');
  assert.notEqual(m({}), m({ networkId: NETWORK_ID_TESTNET4 }), 'the message does not name the network');
  assert.notEqual(m({}), m({ bondTxid: NEW_TXID }));
  // and the transaction reads back: this network's marker dust, and the payload as one OP_RETURN push
  const tx = parseTransaction(reaffirm());
  assert.ok(tx.outputs.some((o) => toHex(o.script) === '5120' + toHex(bondMarker('regtest'))));
});

test('the ancestor\'s advertisement layout reads back exactly, and its id is the ancestor\'s tag over the body', () => {
  const read = decodeAncestorAdvert(OLD_BODY);
  assert.equal(read.endpoint, OLD_ADVERT.endpoint);
  assert.deepEqual(read.hostedGames, []);
  assert.equal(OLD_BODY.length, encodeAncestorAdvert({ ...OLD_ADVERT, hostedGames: [NEXTBLOCK_GAME_ID] }).length);
  assert.notEqual(toHex(OLD_ID), toHex(advertId(OLD_ADVERT)), 'the ancestor id is today\'s');
  assert.notEqual(toHex(ancestorMarker('regtest')), toHex(bondMarker('regtest')), 'the ancestor marker is today\'s');
});

test('a BLWP bond nobody re-affirmed is found and named, not counted; this network\'s bond counts', () => {
  const out = derive();
  assert.equal(out.ok, true, out.why);
  assert.deepEqual(counted(out), [toHex(keyFor(NEW))]);
  const named = why(out, OLD);
  console.log('  FACTS (no re-affirmation):', JSON.stringify({ counted: out.entries.length, excluded: named.step, why: named.why }));
  assert.equal(named.step, 'reaffirm');
  assert.match(named.why, /ancestor network that its operator has not re-affirmed for this network/);
});

test('re-affirmed by its operator, the BLWP bond counts under ARENA/v1/BOND_MARKER\'s network, with the ancestor\'s advertisement until an update', () => {
  const out = derive({ [HEIGHT - 5]: [reaffirm()] });
  assert.equal(out.ok, true, out.why);
  assert.deepEqual(counted(out), [toHex(keyFor(OLD)), toHex(keyFor(NEW))].sort());
  const e = out.entries.find((x) => toHex(x.pubkey) === toHex(keyFor(OLD)));
  assert.equal(e.ancestor, true);
  assert.equal(e.reaffirmedBy.height, HEIGHT - 5);
  assert.equal(toHex(e.advertId), toHex(OLD_ID));
  assert.deepEqual(e.hostedGames, [], 'an ancestor advertisement hosts no game');
  // the update names its games: nextblock, and today's id
  const both = derive({ [HEIGHT - 5]: [reaffirm()], [HEIGHT - 4]: [UPDATE_TX] });
  const u = both.entries.find((x) => toHex(x.pubkey) === toHex(keyFor(OLD)));
  console.log('  FACTS (re-affirmed + updated):', JSON.stringify({ counted: both.entries.length, reaffirmedAt: u.reaffirmedBy.height,
    updatedAt: u.updatedBy.height, hosts: u.hostedGames.map((g) => toHex(g).slice(0, 16)), advertId: toHex(u.advertId).slice(0, 16) }));
  assert.deepEqual(u.hostedGames.map(toHex), [toHex(NEXTBLOCK_GAME_ID)]);
  assert.equal(toHex(u.advertId), toHex(advertId(UPDATED)));
  assert.notEqual(toHex(both.root), toHex(out.root), 'the update did not reach the root');
});

test('refused: signed by another key, for another network, above the census height, with no signature check, or spent', () => {
  const by = (extra, over) => why(derive(extra, over), OLD);
  assert.equal(by({ [HEIGHT - 5]: [reaffirm({ signer: STRANGER })] }).step, 'reaffirm', 'a stranger re-affirmed someone else\'s bond');
  assert.equal(by({ [HEIGHT - 5]: [reaffirm({ networkId: NETWORK_ID_TESTNET4 })] }).step, 'reaffirm', 'testnet4\'s re-affirmation carried a regtest bond');
  assert.equal(by({ [HEIGHT - 5]: [reaffirm({ bondVout: 1 })] }).step, 'reaffirm', 'a re-affirmation of another output carried this one');
  assert.equal(by({ [HEIGHT + 2]: [reaffirm()] }).step, 'reaffirm', 'a re-affirmation above the census height counted');
  const unchecked = by({ [HEIGHT - 5]: [reaffirm()] }, { verifyUpdate: undefined });
  assert.equal(unchecked.step, 'reaffirm');
  assert.match(unchecked.why, /no signature check was given/);
  // A SPENT BOND IS NOT A BOND, re-affirmed or not: a transaction spending the BLWP bond's output
  const spend = new Uint8Array([1, 0, 0, 0, 1, ...OLD_TXID, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff,
    1, ...new Array(8).fill(0), 1, 0x6a, 0, 0, 0, 0]);
  const spent = by({ [HEIGHT - 6]: [spend], [HEIGHT - 5]: [reaffirm()] });
  assert.equal(spent.step, 'scan');
  assert.match(spent.why, /already spent/);
});
