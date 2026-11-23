// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Refute #3051 (kanban #1489): the cap of 64 rotations/sets/series and the verify memo bound the Ed25519 work, but not the
// per-set recipient work. A donation set body carries up to 65535 bytes of entries: ~1770 key recipients, each a 33-byte
// point that donationSetStands checks with a BigInt modular square root (point.js onCurveX). checkNetworkPackage runs that
// stands check several times per set (decode, body id, authorityAt's signature id, stands, signature id again), none memoized.
// 64 such sets (signed by a junk key, all well-formed) - an ~8.5 MB package, under PEER_PACKAGE_BYTES - hold the thread far
// past ASK_MS, before any series is even added (each series re-runs stands over every set twice more).
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

test('refute #3051: 64 junk donation sets of ~1770 key recipients each do not hold the seat\'s thread past ASK_MS', () => {
  const N = Math.floor((65535 - 5) / 37);          // recipients that fit one set body's u16 entries length
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
    sets.push({ body: toHex(encodeDonationSetBody(set)), signature: toHex(ed25519.sign(id, mine)) });
    setIds.push(toHex(id));
  }
  const manifest = { chain: 'bitcoin-regtest', networkId: toHex(NETWORK_ID_REGTEST), federationId: toHex(TEST_FEDERATION_ID), donationSets: setIds, rotations: [], series: [] };
  const pkg = { format: 'arena-network/v1', title: 'x', id: networkPackageId(manifest), manifest,
    invite: inviteForGuardians(TEST_FEDERATION_ID, [{ url: 'ws://127.0.0.1:1/', peer: 0 }]), donationSets: sets, rotations: [], series: [] };
  const bytes = Buffer.byteLength(JSON.stringify(pkg));
  const t0 = Date.now();
  const v = checkNetworkPackage(pkg, { verify: verifyNet, seatChain: 'bitcoin-regtest' });
  const held = Date.now() - t0;
  console.log(`network package ${bytes} bytes (${sets.length} sets x ${N} recipients): checkNetworkPackage held the thread ${held} ms; ok=${v.ok} ${String(v.why || '').slice(0, 120)}`);
  assert.equal(v.ok, false);
  assert.ok(held <= ASK_MS, `checking one ${Math.round(bytes / 1024)} kB network package held the seat's thread ${held} ms (ASK_MS ${ASK_MS})`);
});
