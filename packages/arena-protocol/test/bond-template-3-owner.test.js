// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NO HOT KEY REACHES A BOND (kanban #1093 part 1, ruling #1103, 2026-11-03): template 3's path A and the hold's return are the owner key's
// (§23A.5a, from the 24 words, off the node); the internal key is unspendable; the advertisement names owner_pubkey, template 3 only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAdvert, decodeAdvert } from '../src/advert.js';
import { bond3TapTree, bond3OutputKey, bond3OutputKeyMatches, holdTapTree, returnLeaf, recoveryLeaf, slashStartLeaf, tapLeafHash, HOLD_INTERNAL_KEY } from '../src/bond-script.js';
import { taggedHash } from '../src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x11), OWNER = b32(0x22), CENSUS = b32(0x33);
const tweakPoint = (internalKey, tweak) => { const outputKey = taggedHash('TestTweak', Uint8Array.from([...internalKey, ...tweak])); return { outputKey, parity: outputKey[31] & 1 }; };
const has = (script, key) => { for (let i = 0; i + 32 <= script.length; i++) if (key.every((b, k) => script[i + k] === b)) return true; return false; };

const advert = (over = {}) => ({
  nodePubkey: NODE, operatorId: 'op', protocolVersions: [22], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement', 'verify'],
  endpoint: 'wss://seat.example.com/n1', region: 'eu-west', capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: b32(0), bondVout: 0, bondScriptTemplateVersion: 3, bondMaturityHeight: 900, censusKey: CENSUS, ownerPubkey: OWNER,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n, guardianCapable: false, guardianEndpoint: '', ...over,
});

test('path A is the owner key\'s, path B the node key and the census key; the internal key is unspendable', () => {
  const t = bond3TapTree({ nodeKey: NODE, ownerKey: OWNER, censusKey: CENSUS, bondMaturity: 900 });
  assert.deepEqual(t.internalKey, HOLD_INTERNAL_KEY, 'NUMS: no key path, so no cooperative door for the node key');
  assert.deepEqual(t.recovery, tapLeafHash(recoveryLeaf(OWNER, 900)));
  assert.deepEqual(t.slash, tapLeafHash(slashStartLeaf(NODE, CENSUS)));
  assert.ok(!has(recoveryLeaf(OWNER, 900), NODE), 'the node key is nowhere on path A');
  assert.throws(() => bond3TapTree({ nodeKey: NODE, censusKey: CENSUS, bondMaturity: 900 }), /owner key/);
});

test('another owner key is another output: a reader rebuilds the bond only with the owner key the advertisement names', () => {
  const built = bond3OutputKey({ nodeKey: NODE, ownerKey: OWNER, censusKey: CENSUS, bondMaturity: 900 }, { tweakPoint });
  assert.equal(built.ok, true);
  assert.equal(bond3OutputKeyMatches(built.outputKey, { nodeKey: NODE, ownerKey: OWNER, censusKey: CENSUS, bondMaturity: 900 }, { tweakPoint }).ok, true);
  const other = bond3OutputKeyMatches(built.outputKey, { nodeKey: NODE, ownerKey: b32(0x44), censusKey: CENSUS, bondMaturity: 900 }, { tweakPoint });
  assert.equal(other.ok, false); assert.match(other.why, /owner key/);
});

test('the hold\'s return is the owner key\'s, never the node key\'s', () => {
  const leaf = returnLeaf({ ownerKey: OWNER, bondMaturity: 900, returnBlocks: 36 });
  assert.ok(has(leaf, OWNER)); assert.ok(!has(leaf, NODE));
  const hold = holdTapTree({ ownerKey: OWNER, censusKey: CENSUS, panelA: [], panelB: [], bondMaturity: 900, holdBlocks: 1, returnBlocks: 108, fallbackBlocks: 72 });   // testnet4's clocks since #1317
  assert.ok(has(hold.scripts.return, OWNER)); assert.ok(!has(hold.scripts.return, NODE)); assert.ok(!has(hold.scripts.fallback, NODE));
  assert.throws(() => returnLeaf({ nodeKey: NODE, bondMaturity: 900, returnBlocks: 36 }), /owner key/);
});

test('owner_pubkey: in every template-3 advertisement, through encode and decode; in no other; the emergency key, if named, is the same', () => {
  const a = advert();
  assert.deepEqual(decodeAdvert(encodeAdvert(a)), a);
  assert.throws(() => encodeAdvert(advert({ ownerPubkey: undefined })), /owner_pubkey/);
  assert.throws(() => encodeAdvert(advert({ bondScriptTemplateVersion: 2, censusKey: undefined })), /only template 3/);
  assert.throws(() => encodeAdvert(advert({ emergencyPubkey: b32(0x55) })), /emergency key is its owner key/);
  const same = advert({ emergencyPubkey: OWNER });
  assert.deepEqual(decodeAdvert(encodeAdvert(same)).ownerPubkey, OWNER);
});
