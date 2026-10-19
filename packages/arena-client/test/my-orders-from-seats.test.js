// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// MY ORDERS, FROM THE SEATS (2026-10-17: "When I reload the page my open orders are gone and still no closed
// orders"; "Have the open orders from the nodes not from local storage"): of a round's entries as its seats hold them, the orders whose
// player key is one this wallet makes for that round, read back with their side, limit, expiry, stake and the key's order index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { myOrdersFromEntries } from '../../btc-updown/page/market.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const base = {
  roundId: b32(9), sessionPubkey: b32(2), stakeCommitment: b32(3), stakeMsat: 61000n, feeMsat: 610n, donationMsat: 0n,
  joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(4), stakePoint: new Uint8Array(33).fill(2), feePreimage: b32(5),
  stakeLockOutpoint: { txid: b32(6), outIdx: 0n }, feeLockOutpoint: { txid: b32(7), outIdx: 1n }, claimKeyAttestationRef: b32(8),
};
const seat = (e) => ({ idHex: toHex(entryId(e)), bytes: encodeEntryContract(e) });
const MINE0 = b32(0xa0), MINE1 = b32(0xa1), THEIRS = b32(0xb0);
const keys = new Map([[toHex(MINE0), 0], [toHex(MINE1), 1]]);

test('only this wallet\'s orders are read back - side, limit, expiry, stake and the key\'s order index', () => {
  const up = { ...base, playerPubkey: MINE0, pick: 0, limitPrice: 60000, orderExpiryMs: 0n };
  const down = { ...base, playerPubkey: MINE1, pick: 1, limitPrice: 55000, orderExpiryMs: 1792265100000n, stakeMsat: 50000n };
  const other = { ...base, playerPubkey: THEIRS, pick: 1, limitPrice: 60000, orderExpiryMs: 0n };
  const got = myOrdersFromEntries({ entries: [seat(up), seat(other), seat(down)], keys });
  assert.deepEqual(got, [
    { entryIdHex: toHex(entryId(up)), orderIndex: 0, pick: 0, limitPrice: 60000, orderExpiryMs: '0', stakeMsat: '61000' },
    { entryIdHex: toHex(entryId(down)), orderIndex: 1, pick: 1, limitPrice: 55000, orderExpiryMs: '1792265100000', stakeMsat: '50000' },
  ]);
});

test('a plain pick (no order), bytes that do not decode, or bytes under another entry\'s id are not read back', () => {
  const pick = { ...base, playerPubkey: MINE0, pick: 0 };
  const order = { ...base, playerPubkey: MINE0, pick: 1, limitPrice: 40000, orderExpiryMs: 0n };
  const wrongId = { idHex: 'ff'.repeat(32), bytes: encodeEntryContract(order) };
  assert.deepEqual(myOrdersFromEntries({ entries: [seat(pick), { idHex: '00', bytes: new Uint8Array([1, 2, 3]) }, wrongId], keys }), []);
  assert.deepEqual(myOrdersFromEntries({ entries: [], keys }), []);
});
