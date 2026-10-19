// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SIGNER NODE'S SIGNED LOBBY LISTING (M3.3-34): one canonical encoding, every field
// in the signed id, and nothing that is not a listing encodes as one.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeLobbyListing, lobbyListingId } from '../src/lobby-listing.js';
import { TAG } from '../src/constants.js';
import { toHex } from '../src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const base = { roundId: b32(1), nodePubkey: b32(2), nowMs: 1789200000000, phase: 'open', assignedHere: true, joined: 2, playing: 1 };

test('every field of a listing is in what the signer node signs', () => {
  const id = toHex(lobbyListingId(base));
  assert.equal(toHex(lobbyListingId({ ...base })), id);
  assert.equal(encodeLobbyListing(base).length, 32 + 32 + 8 + 1 + 1 + 4 + 4);
  const changed = [
    { roundId: b32(9) }, { nodePubkey: b32(9) }, { nowMs: base.nowMs + 1 }, { phase: 'pending' },
    { assignedHere: false }, { joined: 3 }, { playing: 2 },
  ];
  for (const c of changed) assert.notEqual(toHex(lobbyListingId({ ...base, ...c })), id, `${Object.keys(c)[0]} is not signed`);
  assert.equal(Object.values(TAG).filter((t) => t === TAG.lobbyListing).length, 1);
});

test('what is not a listing does not encode as one', () => {
  assert.throws(() => encodeLobbyListing({ ...base, phase: 'closed' }), /pending or open/);
  assert.throws(() => encodeLobbyListing({ ...base, roundId: b32(1).subarray(1) }), /32-byte round id/);
  assert.throws(() => encodeLobbyListing({ ...base, nodePubkey: null }), /32-byte node key/);
  assert.throws(() => encodeLobbyListing({ ...base, joined: -1 }), /joined is a whole count/);
  assert.throws(() => encodeLobbyListing({ ...base, playing: 1.5 }), /playing is a whole count/);
});
