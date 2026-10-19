// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ADVERTISEMENT UPDATE REPLACES A BOND'S ADVERTISEMENT, NOT THE BOND (§5A.2; 2026-09-28, the
// advertisement-update letter: "Node 1 must resolve to 027acbea, not the old 034d69fa").
//
// An update names the bond's outpoint, carries the new body signed by the bond's node key, and pays the marker. The
// newest valid one at or below the census height wins; one by another key, unsigned, above the census height or older
// than its bond is not applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { advertId } from '../../arena-protocol/src/advert.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import {
  advertUpdatePayload, readAdvertUpdatePayload, readAdvertUpdate, checkAgainstBond, newestUpdates, ADVERT_UPDATE_BYTES,
} from '../../arena-protocol/src/advert-update.js';
import { advertUpdateTransaction, bondTransaction } from '../../arena-protocol/tools/bond.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const SECRET = b32(0x41);
const NODE = schnorr.getPublicKey(SECRET);
const OTHER = b32(0x42);
const FED = b32(0x33);
const OLD_KEY = Uint8Array.from([0x03, ...b32(0x4d)]);
const NEW_KEY = Uint8Array.from([0x02, ...b32(0x7a)]);

const advert = (guardianKey, timestamp = 1788700000000n, nodePubkey = NODE) => ({
  nodePubkey, operatorId: '2of2', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'verify', 'settlement'],
  endpoint: 'wss://node-1.example/', region: 'eu-west', capacityClass: 1, softwareHash: b32(2),
  settlementCapabilities: 0, lightningCapabilities: 0, bondTxid: new Uint8Array(32), bondVout: 0,
  bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [{ federationId: FED, guardianKey }],
  guardianCapable: true, guardianEndpoint: 'wss://node-1.example/guardian', timestamp,
});
const signed = (a, secret = SECRET) => schnorr.sign(advertId(a), secret);
const BOND_ADVERT = advert(OLD_KEY);
const BOND_TX = bondTransaction(BOND_ADVERT, { value: 50000, signature: signed(BOND_ADVERT) });
const BOND_TXID = parseTransaction(BOND_TX).txid;
const BOND = { txid: BOND_TXID, vout: 0, nodePubkey: NODE };
const update = (a, { secret = SECRET, bondTxid = BOND_TXID, bondVout = 0, previousTxid = b32(0xac) } = {}) =>
  advertUpdateTransaction(a, { bondTxid, bondVout, signature: signed(a, secret), previousTxid });

test('the payload is 72 bytes, "ARN" A, the bond outpoint and the advertisement id, and reads back', () => {
  const p = advertUpdatePayload({ bondTxid: b32(9), bondVout: 3, advertIdBytes: b32(8) });
  assert.equal(p.length, ADVERT_UPDATE_BYTES);
  assert.deepEqual([...p.subarray(0, 4)], [0x41, 0x52, 0x4e, 0x41]);
  const r = readAdvertUpdatePayload(p);
  assert.deepEqual([r.bondTxid, r.bondVout, r.advertId], [b32(9), 3, b32(8)]);
  assert.equal(readAdvertUpdatePayload(p.subarray(0, 36)), null, 'a series or round payload is not an update');
});

test('an update of the bond, signed by its node key, reads as the new advertisement', async () => {
  const a = advert(NEW_KEY, 1790000000000n);
  const read = readAdvertUpdate(update(a));
  assert.equal(read.ok, true, read.why);
  const got = await checkAgainstBond(read, BOND, verify);
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(got.advert.guardianOf[0].guardianKey, NEW_KEY);
  // and a bond transaction is not an update
  assert.equal(readAdvertUpdate(BOND_TX).ok, false);
});

test('another key, an unsigned update, another bond or no signature check: not applied, by name', async () => {
  const a = advert(NEW_KEY, 1790000000000n);
  const byOther = readAdvertUpdate(update(a, { secret: OTHER }));
  assert.match((await checkAgainstBond(byOther, BOND, verify)).why, /not signed by the bond's node key/);
  const otherNode = advert(NEW_KEY, 1790000000000n, schnorr.getPublicKey(OTHER));
  const foreign = readAdvertUpdate(update(otherNode, { secret: OTHER }));
  assert.match((await checkAgainstBond(foreign, BOND, verify)).why, /node key is not the bond's/);
  assert.match((await checkAgainstBond(readAdvertUpdate(update(a, { bondVout: 1 })), BOND, verify)).why, /another bond/);
  assert.match((await checkAgainstBond(readAdvertUpdate(update(a)), BOND, undefined)).why, /no signature check/);
});

test('the newest valid update at or below the census height wins; a later, an older-than-bond or a forged one does not', () => {
  const first = advert(Uint8Array.from([0x02, ...b32(0x11)]), 1790000000000n);
  const second = advert(NEW_KEY, 1790000001000n);
  const tooLate = advert(Uint8Array.from([0x02, ...b32(0x22)]), 1790000002000n);
  const forged = advert(Uint8Array.from([0x02, ...b32(0x44)]), 1790000003000n);
  const view = { firstHeight: 100, blocks: [
    { transactions: [BOND_TX] },                                                        // 100: the bond
    { transactions: [update(first, { previousTxid: b32(1) })] },                        // 101
    { transactions: [update(forged, { secret: OTHER, previousTxid: b32(2) })] },        // 102: not the node's
    { transactions: [update(second, { previousTxid: b32(3) })] },                       // 103: the newest valid
    { transactions: [update(tooLate, { previousTxid: b32(4) })] },                      // 104: above the census
  ] };
  const entries = [{ txid: BOND_TXID, vout: 0, pubkey: NODE, height: 100 }];
  const got = newestUpdates(view, entries, { atHeight: 103, verify }).get(`${Array.from(BOND_TXID).join(',')}:0`);
  assert.equal(got.height, 103);
  assert.deepEqual(got.advert.guardianOf[0].guardianKey, NEW_KEY);
  // an update below the bond's own height is not an update of it
  const early = newestUpdates(view, [{ ...entries[0], height: 104 }], { atHeight: 103, verify });
  assert.equal(early.size, 0);
  // and with no signature check nothing is applied
  assert.equal(newestUpdates(view, entries, { atHeight: 103 }).size, 0);
});
