// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 a44 refute 86 (kanban #1836 fix facd00cc5, checked on 90d57151a): the txid tie of inForceOf is not the census's.
// Two of the node's outputs confirmed in ONE block with no update (two Add to bond in one block, or an added output beside a re-bond):
// census.js newestPerNode breaks the tie by the larger txid in the byte order parseTransaction computes (internal order); inForceOf
// compares bitcoind's DISPLAY hex (bondsOf records carry `txid` as bitcoind prints it - byte-reversed). Whenever the two orders differ,
// the seat builds its next post on the body the census does not count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newestPerNode } from '../../arena-protocol/src/census.js';
import { inForceOf } from '../src/add-bond-wallet.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x01);
const base = { nodePubkey: NODE, operatorId: 'op-seat7', protocolVersions: [19], roles: ['game', 'verify'], endpoint: 'wss://seat7.invalid',
  guardianOf: [], guardianCapable: false, guardianEndpoint: '', hostedGames: [], timestamp: 1n };
const OUT_BODY = { ...base, serving: false, timestamp: 5n };
const IN_BODY = { ...base, timestamp: 4n };
// display hex: A '11..11' is larger than B '00..00ff'; internal order: B 'ff00..00' is larger than A
const A = { txid: '11'.repeat(32), vout: 0, height: 300, sats: 50000, advert: IN_BODY, bondAdvert: IN_BODY };
const B = { txid: '00'.repeat(31) + 'ff', vout: 0, height: 300, sats: 32000, advert: OUT_BODY, bondAdvert: OUT_BODY };
const internal = (h) => Uint8Array.from(Buffer.from(h, 'hex')).reverse();

test('wf1489-a44-refute-86-s1-2: two own bodies at one height - inForceOf and the census pick different outputs', () => {
  const eligible = [A, B].map((b) => ({ txid: internal(b.txid), vout: b.vout, height: b.height, pubkey: NODE, advert: b.bondAdvert }));
  const d = newestPerNode(eligible, new Map()).get(`${toHex(NODE)}|op-seat7`);
  const census = d.own.advert;
  const seat = inForceOf([A, B]).advert;
  console.log(`  MEASURED: census in force serving=${census.serving !== false}; inForceOf serving=${seat.serving !== false}`);
  assert.ok(census.serving === seat.serving, `inForceOf reads serving=${seat.serving !== false} where the census reads serving=${census.serving !== false}`);
});
