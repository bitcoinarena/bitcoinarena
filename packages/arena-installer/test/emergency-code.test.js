// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S EMERGENCY CODE (spec §23A.5a, protocol 17): the same 24 words give the same code, the code gives back the key the bond
// advert names, and the advert carries that key only when every seat reads it (ARENA_EMERGENCY_ADVERT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { emergencyOf, newSeed } from '../src/seed.js';
import { advertFor, EMERGENCY_IN_ADVERT } from '../src/bond.js';
import { parseEmergencyCode, emergencySecret } from '../../arena-protocol/src/emergency.js';
import { encodeAdvert, decodeAdvert } from '../../arena-protocol/src/advert.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('the emergency code is the seed\'s, reads back to the key the advert names, and is not the owner key', () => {
  const { seed } = newSeed();
  const a = emergencyOf(seed); const b = emergencyOf(seed);
  assert.deepEqual(a, b, 'the same words, the same code');
  assert.match(a.code, /^ARN-(\w{4}-){6}\w{4}$/);
  assert.equal(toHex(schnorr.getPublicKey(emergencySecret(parseEmergencyCode(a.code)))), a.pubkey, 'the code typed elsewhere signs as the advert\'s key');
  assert.notEqual(emergencyOf(newSeed().seed).code, a.code);
});

test('the bond advert names the emergency key when asked, and decodes back with it; off by default until the seats read protocol 17', () => {
  assert.equal(EMERGENCY_IN_ADVERT, process.env.ARENA_EMERGENCY_ADVERT !== '0', 'on unless ARENA_EMERGENCY_ADVERT=0 (every seat reads it since protocol 17)');
  const { seed } = newSeed();
  const base = { nodeKey: new Uint8Array(32).fill(1), operatorId: 'op', roles: ['verify'], endpoint: 'https://n.example', payoutPubkey: new Uint8Array(32).fill(2),
    maturity: 160000, softwareHash: new Uint8Array(32), nowMs: 1788700000000 };
  const without = advertFor(base);
  assert.equal('emergencyPubkey' in without, false);
  const pub = fromHex(emergencyOf(seed).pubkey);
  const withKey = advertFor({ ...base, emergencyPubkey: pub });
  const back = decodeAdvert(encodeAdvert(withKey));
  assert.equal(toHex(back.emergencyPubkey), toHex(pub));
  assert.equal(encodeAdvert(withKey).length, encodeAdvert(without).length + 33);
});
