// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 / #1682 skeptic 2: the census the bounty trusts names each node's ADVERT endpoint, and a real advert is ws:// or wss://
// (round-2of2.mjs: `ws://host:port` or ARENA_WSS_<port>; measured 2026-11-12 on a live seat's GET /roles: 22 of 25 entries wss://). seatBaseOf
// drops every non-http(s) scheme, so those nodes have no witness endpoint and no honest node of such a committee can pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { nodeBountyCheck } from '../src/node-bounty-check.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const DAY = 24 * 3600 * 1000, NOW = 20000 * DAY + 5000;
const SECRET = new Uint8Array(32).fill(0x51), NODE = toHex(schnorr.getPublicKey(SECRET)), RID = toHex(new Uint8Array(32).fill(0x77));
const fin = toHex(signFinalSig({ roundId: fromHex(RID), entryId: new Uint8Array(32).fill(2), runId: new Uint8Array(32).fill(3), signerPubkey: fromHex(NODE), signedAtMs: BigInt(NOW - 1000) }, (d) => schnorr.sign(d, SECRET)));
const A = 'a1'.repeat(32), B = 'b1'.repeat(32), D = 'd1'.repeat(32);
const TRUSTED = 'https://trusted.example';

test('#1682 s2-1: an honest committee whose census adverts are wss:// (as every live seat advertises) passes', async () => {
  // each node's door at https://host/path, its advert wss://host/path - the same seat
  // kanban #2015, #2049: three census nodes OTHER than the node (A, B, D), and the trusted seat holds the round too
  const doors = { [NODE]: 'https://seat.example/t3-5', [A]: 'https://seat.example/guardian-6', [B]: 'https://other.example/t3-2', [D]: 'https://third.example/t3-1' };
  const roles = Object.entries(doors).map(([node, d]) => ({ node, endpoint: d.replace(/^https:/, 'wss:'), bondSats: '5000000' }));
  const fetchJson = async (url) => {
    if (url.endsWith('/owner')) return { node: 'dd'.repeat(32), claimed: false };
    if (url.endsWith('/roles')) return url.startsWith(TRUSTED) ? { nodes: roles } : { nodes: [] };
    if (url.startsWith('ws')) throw new Error('fetch cannot ask a ws:// url');
    if (url.startsWith(`${TRUSTED}/`)) return { node: 'f0'.repeat(32), held: [{ roundId: RID, committee: [NODE, A, B, D], finals: [fin] }] };
    const who = Object.entries(doors).find(([, d]) => url.startsWith(`${d}/`));
    if (!who) throw new Error('no such seat');
    return { node: who[0], held: [{ roundId: RID, committee: [NODE, A, B, D], finals: [fin] }] };
  };
  const r = await nodeBountyCheck({ node: NODE, seats: Object.values(doors), fetchJson, nowMs: NOW, censusSeats: [TRUSTED] });
  console.log('  MEASURED s2-1:', JSON.stringify(r.checks.map((c) => [c.key, c.ok, c.says])));
  assert.equal(r.passes, true, 'an honest bonded node with a real, signed, 3-held round passes');
});
