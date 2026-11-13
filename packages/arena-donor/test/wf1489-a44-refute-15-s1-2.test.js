// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit44 refute of #1618: the same unbounded /donations read lives on in the developer's donor (arena-donor
// gatherDonations + redeemAll). #1618 bounded only the page's collectZaps: one seat listing 20,000 made-up outpoints under the dev's
// key still makes the donor send 20,000 federation Refund calls a pass. Safe: a bounded number of rows per seat and calls per pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatherDonations, redeemAll } from '../src/donor.js';

test('one seat listing 20,000 made-up donation rows does not make the donor send 20,000 federation Refund calls', async () => {
  const F = 'fe'.repeat(32);
  const key = '02' + '11'.repeat(32);
  const rows = Array.from({ length: 20000 }, (_, i) => ({ outpoint: `${i.toString(16).padStart(64, '0')}:0`, federationId: F, amountMsat: '1000', verifiedMs: i }));
  const fetcher = async (u) => new Response(JSON.stringify({ donations: u.startsWith('https://evil.example') ? rows : [] }), { status: 200 });
  const got = await gatherDonations({ recipientPkHex: key, seats: ['https://evil.example', 'https://honest.example'], fetcher });
  let refunds = 0;
  const client = { refund: async () => { refunds++; return JSON.stringify({ accepted: false, stored_before: null }); } };
  await redeemAll({ client, donations: got.byFederation.get(F) || [], recipientPkHex: key, secretHex: '22'.repeat(32) });
  assert.ok(got.total <= 1000 && refunds <= 1000, `one seat's list gave ${got.total} rows and drove ${refunds} Refund calls in one pass`);
});
