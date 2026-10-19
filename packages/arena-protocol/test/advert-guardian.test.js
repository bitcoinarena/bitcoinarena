// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CENSUS ADVERT SAYS A NODE IS A GUARDIAN (spec §5A.1 v4.6.4: `guardian_capable`, `guardian_endpoint`; §23A.2: one
// node is one guardian, drawn by sortition over the guardian-capable census - RULED 2026-09-26 22:54).
//
// RED BY DESIGN at the commit that adds it (2026-09-27): advert.js encodes neither field, so an advert cannot say its
// node is a guardian or where a phone opens it, and §23A.2's sortition has nothing to draw from. Making it pass moves
// every advertId (the fixtures, the vectors and the page bundle follow) - its own agreed slice, not this one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAdvert, decodeAdvert, advertId } from '../src/advert.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);

// an advert as the tools build it today (regtest-bond.mjs postBond), and node 1's own guardian endpoint (GET /guardian)
const advert = () => ({
  nodePubkey: b32(1), operatorId: '2of2', protocolVersions: [1], hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement', 'verify'],   // the order the encoder writes
  endpoint: 'wss://seat.example.com/guardian-1', region: 'eu-west', capacityClass: 1,
  softwareHash: b32(2), settlementCapabilities: 0, lightningCapabilities: 0,
  bondTxid: b32(0), bondVout: 0, bondScriptTemplateVersion: 1,
  payoutPubkey: b32(3), guardianOf: [], timestamp: 1788700000000n,
  guardianCapable: true,
  guardianEndpoint: 'wss://seat.example.com/guardian-1/guardian',
});

test('an advert carries guardian_capable and guardian_endpoint through encode and decode', () => {
  const a = advert();
  assert.deepEqual(decodeAdvert(encodeAdvert(a)), a);
});

test('guardian_capable and guardian_endpoint are under the advert id, so under the node signature', () => {
  const a = advert();
  const notCapable = { ...a, guardianCapable: false, guardianEndpoint: '' };   // not capable names no endpoint
  const elsewhere = { ...a, guardianEndpoint: 'wss://seat.example.com/guardian-2/guardian' };
  const id = Buffer.from(advertId(a)).toString('hex');
  assert.notEqual(Buffer.from(advertId(notCapable)).toString('hex'), id, 'guardian_capable is not in the id');
  assert.notEqual(Buffer.from(advertId(elsewhere)).toString('hex'), id, 'guardian_endpoint is not in the id');
});
