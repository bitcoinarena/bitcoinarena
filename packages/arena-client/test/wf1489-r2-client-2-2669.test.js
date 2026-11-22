// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2669, #1489 round 2 (client): fetchDonationSet (every paid join, every market order) reads each answering seat's GET /donation-rotations
// and checks EVERY distinct rotation it lists against the network's recovery key (verifyEd25519), with no bound on how many one seat lists.
// One seat of the round (it also serves the set's bytes, so its answer is kept) listing 20,000 made-up rotations - well-formed bodies,
// junk signatures - makes the page run 20,000 Ed25519 checks before the join may lock, on each join.
// Safe: what one seat's rotations list costs the page is bounded (the network has a handful of rotations, ever).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchDonationSet } from '../src/donation-pay.js';
import { encodeAuthorityRotation } from '../../arena-protocol/src/authority.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('one seat listing 20,000 made-up rotations does not cost the join 20,000 signature checks', async () => {
  const round = { id: new Uint8Array(32).fill(9), donationSetId: new Uint8Array(32).fill(4), networkId: NETWORK_ID_REGTEST, censusHeight: 100 };
  const keys = { authority: new Uint8Array(32).fill(1), recovery: new Uint8Array(32).fill(2) };
  const junk = Array.from({ length: 20000 }, (_, i) => ({
    body: toHex(encodeAuthorityRotation({ networkId: NETWORK_ID_REGTEST, serial: BigInt(i + 1), newAuthority: new Uint8Array(32).fill(3), validFrom: 1 })),
    signature: '11'.repeat(64),
  }));
  const nodes = [0, 1, 2, 3, 4, 5, 6].map((i) => `http://seat${i}`);
  const fetcher = async (url) => {
    const u = new URL(url);
    const evil = u.hostname === 'seat6';
    if (u.pathname === '/donation-rotations') return new Response(JSON.stringify({ rotations: evil ? junk : [] }), { status: 200 });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  };
  let checks = 0;
  const verifyEd25519 = async () => { checks++; return false; };
  await fetchDonationSet({ round, nodes, fetcher, verifyEd25519, keys });
  assert.ok(checks <= 256, `one seat's rotations list cost the join ${checks} signature checks`);
});
