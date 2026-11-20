// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit r4 hosting-2: checkNetworkPackage (network-check.js) has no bound on a package's rotations and donation sets, never stops at a
// failed line, and checks EVERY carried rotation's signature once for itself and again inside authorityAt for EVERY carried donation set:
// S x R Ed25519 verifies on the seat's own thread. A network package is signed by nobody: any seat the network auto-update reads
// (networkSeats(): its peers, the census seats) answers GET /network?network=<id> with the held package's federation id and R junk
// rotations plus S junk sets (all of the network, valid_from 0, signatures by a key of its own - well-formed, so each verify runs whole).
// autoUpdateSweep -> takeNetwork -> checkOnSeat runs it every ARENA_AUTO_UPDATE_MS (10 min), and the owner page's install does too.
// Here 120 rotations and 120 sets (a package of ~70 kB) already hold the thread for seconds; a 16 MB package (PEER_PACKAGE_BYTES) carries
// ~25,000 of each: ~625 M verifies, the seat frozen for hours.
// Safe behaviour: checking one network package holds the seat's thread no longer than ASK_MS (2 s).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { checkNetworkPackage, networkPackageId } from '../src/network-check.js';
import { ASK_MS } from '../src/core-sandbox.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeAuthorityRotation, encodeDonationSetBody, authorityRotationId, donationSetBodyId } from '../../arena-protocol/src/authority.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { inviteForGuardians } from '../src/invite.js';

// the seat's own verifier (server.js verifyNet)
const verifyNet = (sig, msg, pub) => { try { return ed25519.verify(sig, msg, pub); } catch { return false; } };

test('audit r4 hosting-2: one network package of junk rotations and sets does not hold the seat\'s thread past ASK_MS', () => {
  const R = 120, S = 120;
  const mine = ed25519.utils.randomSecretKey ? ed25519.utils.randomSecretKey() : ed25519.utils.randomPrivateKey();
  const rotations = [], sets = [], rotIds = [], setIds = [];
  for (let i = 0; i < R; i++) {
    const rot = { networkId: NETWORK_ID_REGTEST, serial: BigInt(i + 1), newAuthority: new Uint8Array(32).fill(i % 250 + 1), validFrom: 0 };
    const id = authorityRotationId(rot);
    rotations.push({ body: toHex(encodeAuthorityRotation(rot)), signature: toHex(ed25519.sign(id, mine)) });
    rotIds.push(toHex(id));
  }
  for (let i = 0; i < S; i++) {
    const set = { networkId: NETWORK_ID_REGTEST, serial: BigInt(1000 + i), validFrom: 1000000, recipients: TEST_DONATION_SET_REGTEST.recipients };
    const id = donationSetBodyId(set);
    sets.push({ body: toHex(encodeDonationSetBody(set)), signature: toHex(ed25519.sign(id, mine)) });
    setIds.push(toHex(id));
  }
  const manifest = { chain: 'bitcoin-regtest', networkId: toHex(NETWORK_ID_REGTEST), federationId: toHex(TEST_FEDERATION_ID), donationSets: setIds, rotations: rotIds, series: [] };
  const pkg = { format: 'arena-network/v1', title: 'x', id: networkPackageId(manifest), manifest,
    invite: inviteForGuardians(TEST_FEDERATION_ID, [{ url: 'ws://127.0.0.1:1/', peer: 0 }]), donationSets: sets, rotations, series: [] };
  const bytes = Buffer.byteLength(JSON.stringify(pkg));
  const t0 = Date.now();
  const v = checkNetworkPackage(pkg, { verify: verifyNet, seatChain: 'bitcoin-regtest' });
  const held = Date.now() - t0;
  console.log(`network package ${bytes} bytes (${R} rotations, ${S} sets): checkNetworkPackage held the thread ${held} ms; ok=${v.ok} ${String(v.why || '').slice(0, 120)}`);
  assert.equal(v.ok, false);
  assert.ok(held <= ASK_MS, `checking one ${Math.round(bytes / 1024)} kB network package held the seat's thread ${held} ms (ASK_MS ${ASK_MS})`);
});
