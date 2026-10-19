// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN ENTRY NAMES ITS RESERVE LOCK (protocol 11, §27A.9.2, kanban #397 slice 3): after its own marker, last of all; an entry without one
// keeps exactly its bytes and its id; with items before it both round-trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeEntryContract, decodeEntryContract, entryId, RESERVE_ENTRY_MARKER } from '../src/contracts.js';

const z = (n, f = 0) => new Uint8Array(n).fill(f);
const base = () => ({ roundId: z(32, 1), playerPubkey: z(32, 2), sessionPubkey: z(32, 3), stakeCommitment: z(32, 4), stakeMsat: 90000n, feeMsat: 4000n,
  donationMsat: 4000n, joinTick: 0, worldSecret: z(32), vssSharesRef: z(32), stakePoint: z(33), feePreimage: z(32),
  stakeLockOutpoint: { txid: z(32, 5), outIdx: 0n }, feeLockOutpoint: { txid: z(32, 5), outIdx: 1n }, claimKeyAttestationRef: z(32, 6),
  donationOutpoints: [{ txid: z(32, 5), outIdx: 2n }] });

test('the reserve outpoint round-trips, last of all, alone or after items; without it the bytes are unchanged', () => {
  const plain = base();
  const before = encodeEntryContract(plain);
  const withReserve = { ...plain, reserveOutpoint: { txid: z(32, 5), outIdx: 4n } };
  const bytes = encodeEntryContract(withReserve);
  assert.equal(bytes[before.length], RESERVE_ENTRY_MARKER);
  assert.deepEqual(decodeEntryContract(bytes).reserveOutpoint, { txid: z(32, 5), outIdx: 4n });
  assert.deepEqual(encodeEntryContract(decodeEntryContract(before)), before, 'no reserve: the same bytes as before');
  assert.notEqual(Buffer.from(entryId(withReserve)).toString('hex'), Buffer.from(entryId(plain)).toString('hex'));
  const both = { ...withReserve, items: [{ itemId: 'large-truck', purchaseId: z(32, 7), ownerSig: z(64, 8) }] };
  const d = decodeEntryContract(encodeEntryContract(both));
  assert.equal(d.items[0].itemId, 'large-truck'); assert.equal(d.reserveOutpoint.outIdx, 4n);
});
