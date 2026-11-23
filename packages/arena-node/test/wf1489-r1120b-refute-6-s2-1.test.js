// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Refute #3148 (kanban #1489 r1120b-refute-6-s2): the byte cap counts a set's body only when it is a string
// (`typeof d.body === 'string' ? d.body.length / 2 : 0`), but the decode reads fromHex(String(d.body)). A peer's GET /network
// answer is JSON, and String(['<hex>']) is '<hex>': a body sent as a one-element array counts 0 bytes and decodes in full.
// The same 64 sets of ~1770 key recipients that #3148 measured at 33 s pass the cap again.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { checkNetworkPackage, networkPackageId, NETWORK_PACKAGE_MAX_ITEMS } from '../src/network-check.js';
import { ASK_MS } from '../src/core-sandbox.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeDonationSetBody, donationSetBodyId } from '../../arena-protocol/src/authority.js';
import { onCurveX } from '../../arena-protocol/src/point.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { inviteForGuardians } from '../src/invite.js';

const verifyNet = (sig, msg, pub) => { try { return ed25519.verify(sig, msg, pub); } catch { return false; } };

test('refute #3148: donation set bodies sent as one-element arrays do not slip past the byte cap', () => {
  const N = Math.floor((65535 - 5) / 37);
  const keys = [];
  for (let i = 1; keys.length < N; i++) {
    const x = new Uint8Array(32); x[28] = (i >>> 24) & 255; x[29] = (i >>> 16) & 255; x[30] = (i >>> 8) & 255; x[31] = i & 255;
    if (onCurveX(x)) { const k = new Uint8Array(33); k[0] = 2; k.set(x, 1); keys.push(k); }
  }
  const recipients = keys.map((k, i) => ({ recipientPk: k, shareBps: i === 0 ? 10000 : 0, label: '' }));
  const mine = ed25519.utils.randomSecretKey ? ed25519.utils.randomSecretKey() : ed25519.utils.randomPrivateKey();
  const sets = [], setIds = [];
  for (let i = 0; i < NETWORK_PACKAGE_MAX_ITEMS; i++) {
    const set = { networkId: NETWORK_ID_REGTEST, serial: BigInt(1000 + i), validFrom: 0, recipients };
    const id = donationSetBodyId(set);
    sets.push({ body: [toHex(encodeDonationSetBody(set))], signature: toHex(ed25519.sign(id, mine)) });
    setIds.push(toHex(id));
  }
  const manifest = { chain: 'bitcoin-regtest', networkId: toHex(NETWORK_ID_REGTEST), federationId: toHex(TEST_FEDERATION_ID), donationSets: setIds, rotations: [], series: [] };
  // as it arrives from a peer: JSON on the wire
  const pkg = JSON.parse(JSON.stringify({ format: 'arena-network/v1', title: 'x', id: networkPackageId(manifest), manifest,
    invite: inviteForGuardians(TEST_FEDERATION_ID, [{ url: 'ws://127.0.0.1:1/', peer: 0 }]), donationSets: sets, rotations: [], series: [] }));
  const bytes = Buffer.byteLength(JSON.stringify(pkg));
  const t0 = Date.now();
  const v = checkNetworkPackage(pkg, { verify: verifyNet, seatChain: 'bitcoin-regtest' });
  const held = Date.now() - t0;
  console.log(`array-body package ${bytes} bytes: held ${held} ms; ok=${v.ok} ${String(v.why || '').slice(0, 120)}`);
  assert.equal(v.ok, false);
  assert.ok(held <= ASK_MS, `checking one ${Math.round(bytes / 1024)} kB network package held the seat's thread ${held} ms (ASK_MS ${ASK_MS})`);
});
