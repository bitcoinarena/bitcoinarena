// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER'S EMERGENCY KEY (spec §23A.5a, protocol 17): the code from the 24 words, the advert that names its key, the signed leave
// request, and the two cases - a node with no guardian role leaves at once, a guardian in time departs, a late guardian is slashed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { emergencyCodeBytes, emergencyCodeText, parseEmergencyCode, emergencySecret, encodeEmergencyDeparture, decodeEmergencyDeparture,
  signEmergencyDeparture, emergencyDepartureStands, emergencyDepartureEffect, EMERGENCY_FRESH_BLOCKS } from '../src/emergency.js';
import { encodeAdvert, decodeAdvert, advertId, EMERGENCY_MARKER } from '../src/advert.js';
import { guardianSlashStands } from '../src/federation-slash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const seed = b32(7);
const codeBytes = emergencyCodeBytes(seed);
const secret = emergencySecret(codeBytes);
const pub = schnorr.getPublicKey(secret);
const sign = (digest) => schnorr.sign(digest, secret);
const verify = (sig, digest, key) => { try { return schnorr.verify(sig, digest, key); } catch { return false; } };
const advert = (more = {}) => ({
  nodePubkey: b32(1), operatorId: 'op', protocolVersions: [17], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement', 'verify'],
  endpoint: 'https://node.example', region: 'eu-west', capacityClass: 1, softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: b32(0), bondVout: 0, bondScriptTemplateVersion: 1, payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
  guardianCapable: false, guardianEndpoint: '', ...more });

test('the emergency code: from the 24 words, written ARN-…, read back with any case, spaces and I/L/O, a typo refused', () => {
  const text = emergencyCodeText(codeBytes);
  assert.match(text, /^ARN-([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.deepEqual(parseEmergencyCode(text), codeBytes);
  assert.deepEqual(parseEmergencyCode(text.toLowerCase().replace(/-/g, ' ')), codeBytes, 'case and spaces');
  assert.deepEqual(emergencyCodeBytes(seed), codeBytes, 'the same 24 words, the same code');
  assert.notDeepEqual(emergencyCodeBytes(b32(8)), codeBytes, 'other words, another code');
  const chars = text.replace(/^ARN-/, '').replace(/-/g, '');
  const typo = chars.slice(0, 5) + (chars[5] === 'A' ? 'B' : 'A') + chars.slice(6);
  assert.throws(() => parseEmergencyCode(typo), /mistyped/);
  const withO = chars.replace(/0/g, 'O');
  assert.deepEqual(parseEmergencyCode(withO), codeBytes, 'O read as 0');
  assert.notDeepEqual(secret, seed, 'the key is not the seed');
});

test('the advert names the emergency key: it round-trips with and without the declared scalars and serving, and old adverts keep their bytes', () => {
  const old = advert();
  const withKey = advert({ emergencyPubkey: pub });
  assert.deepEqual(decodeAdvert(encodeAdvert(withKey)), withKey);
  assert.equal(encodeAdvert(withKey).length, encodeAdvert(old).length + 33);
  assert.equal(encodeAdvert(withKey)[encodeAdvert(old).length], EMERGENCY_MARKER);
  for (const more of [{ declares: { bondMinSats: 50000n, proposalDepositSats: 500n } }, { serving: false },
    { declares: { bondMinSats: 50000n, proposalDepositSats: 500n }, serving: false }]) {
    assert.deepEqual(decodeAdvert(encodeAdvert(advert({ ...more, emergencyPubkey: pub }))), advert({ ...more, emergencyPubkey: pub }));
    assert.deepEqual(decodeAdvert(encodeAdvert(advert(more))), advert(more), 'without the key, as before');
  }
  assert.notEqual(Buffer.from(advertId(withKey)).toString('hex'), Buffer.from(advertId(old)).toString('hex'), 'the key is under the advert id');
});

test('a leave request stands only signed by the key the node\'s advert names, and not from ahead of the tip', () => {
  const req = signEmergencyDeparture({ nodePubkey: b32(1), emergencyPubkey: pub, postedAt: 1000 }, sign);
  assert.deepEqual(decodeEmergencyDeparture(encodeEmergencyDeparture(req)), { nodePubkey: b32(1), emergencyPubkey: pub, postedAt: 1000 });
  assert.deepEqual(emergencyDepartureStands(req, { advert: advert({ emergencyPubkey: pub }), tip: 1005, verify }), { ok: true, nodePubkey: b32(1), postedAt: 1000 });
  assert.match(emergencyDepartureStands(req, { advert: advert(), tip: 1005, verify }).why, /names no emergency key/);
  assert.match(emergencyDepartureStands(req, { advert: advert({ emergencyPubkey: b32(9) }), tip: 1005, verify }).why, /another emergency key/);
  assert.match(emergencyDepartureStands(req, { advert: advert({ emergencyPubkey: pub }), tip: 999, verify }).why, /ahead of the tip/);
  const other = schnorr.utils.randomSecretKey();
  const forged = signEmergencyDeparture({ nodePubkey: b32(1), emergencyPubkey: pub, postedAt: 1000 }, (d) => schnorr.sign(d, other));
  assert.match(emergencyDepartureStands(forged, { advert: advert({ emergencyPubkey: pub }), tip: 1005, verify }).why, /not signed by the node's emergency key/);
  assert.match(emergencyDepartureStands(req, { advert: null, tip: 1005, verify }).why, /not in the census/);
  // TAKEN ONLY FRESH: posted_at is the signer's word - a request dated back more than EMERGENCY_FRESH_BLOCKS is refused on taking
  assert.equal(emergencyDepartureStands(req, { advert: advert({ emergencyPubkey: pub }), tip: 1000 + EMERGENCY_FRESH_BLOCKS, verify, fresh: true }).ok, true);
  assert.match(emergencyDepartureStands(req, { advert: advert({ emergencyPubkey: pub }), tip: 1001 + EMERGENCY_FRESH_BLOCKS, verify, fresh: true }).why, /taken only fresh/);
});

test('the two cases: no guardian role leaves at once with its bond; a guardian in time departs, a late guardian is abandonment and slashed', () => {
  const stands = { ok: true, nodePubkey: b32(1), postedAt: 1000 };
  // no guardian role: out at once, bond untouched
  assert.deepEqual([emergencyDepartureEffect(stands, { guardian: false, abandonBlocks: 288 }).leaves, emergencyDepartureEffect(stands, { guardian: false, abandonBlocks: 288 }).slash], [true, false]);
  // a guardian last seen at 800: 288 blocks (mainnet) -> in time until 1087
  const inTime = emergencyDepartureEffect(stands, { guardian: true, lastSeenHeight: 800, abandonBlocks: 288 });
  assert.deepEqual([inTime.departed, inTime.slash], [true, false]);
  const late = emergencyDepartureEffect({ ...stands, postedAt: 1088 }, { guardian: true, lastSeenHeight: 800, abandonBlocks: 288 });
  assert.deepEqual([late.departed, late.slash], [false, true]);
  assert.deepEqual(emergencyDepartureEffect({ ...stands, postedAt: 1087 }, { guardian: true, lastSeenHeight: 800, abandonBlocks: 288 }).slash, false, 'the last block in time');
  // the slash decision on an abandonment proof
  const peer = new Uint8Array(33).fill(2);
  const proof = { ok: true, peerKey: peer, sinceHeight: 800, signers: 7 };
  assert.deepEqual([guardianSlashStands({ proof, emergency: stands, abandonBlocks: 288 }).slash, guardianSlashStands({ proof, emergency: stands, abandonBlocks: 288 }).kind], [false, 'DEPARTED']);
  assert.deepEqual([guardianSlashStands({ proof, emergency: { ...stands, postedAt: 1088 }, abandonBlocks: 288 }).slash, guardianSlashStands({ proof, emergency: { ...stands, postedAt: 1088 }, abandonBlocks: 288 }).kind], [true, 'ABANDONED'], 'late: not softened');
  assert.equal(guardianSlashStands({ proof }).slash, true, 'no request: abandonment, as before');
  assert.equal(guardianSlashStands({ proof, emergency: { ok: false, why: 'unsigned' }, abandonBlocks: 288 }).slash, true, 'a request that does not stand changes nothing');
  assert.throws(() => guardianSlashStands({ proof, emergency: stands }), /abandon_blocks/);
});
