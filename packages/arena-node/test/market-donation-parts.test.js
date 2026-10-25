// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET'S DONATION, ORDER BY ORDER (kanban #580, 2026-10-22: "change the protocol so we can get the player hash for each market
// order"): a market pays its donation once per recipient per round, out of every filled order's fee. The settlement's donation payout names
// its parts (lock-settlement.js), the seat keeps them with the row and serves them (GET /donations), the dev client records each order's
// player and share of the output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { donationRecord } from '../../arena-donor/src/donor.js';

const hex = (n) => String(n).repeat(64).slice(0, 64);
const RECIPIENT = '02' + 'cd'.repeat(32);

test('the seat keeps a market donation\'s parts with its row and serves them; an older row names none', () => {
  const round = new Round(openStore());
  const parts = [{ entryId: hex('a'), playerPubkey: hex('1'), feeMsat: '100000' }, { entryId: hex('b'), playerPubkey: hex('2'), feeMsat: '300000' }];
  round.putDonationOutputs([
    { outpoint: { txid: Buffer.from(hex('f'), 'hex'), outIdx: 3n }, entryId: Buffer.from(hex('9'), 'hex'), roundId: Buffer.from(hex('7'), 'hex'), federationId: Buffer.from(hex('3'), 'hex'),
      recipientPk: Buffer.from(RECIPIENT, 'hex'), amountMsat: 4000n, contractId: 'settlement:3', parts },
    { outpoint: { txid: Buffer.from(hex('e'), 'hex'), outIdx: 0n }, entryId: Buffer.from(hex('8'), 'hex'), roundId: Buffer.from(hex('7'), 'hex'), federationId: Buffer.from(hex('3'), 'hex'),
      recipientPk: Buffer.from(RECIPIENT, 'hex'), amountMsat: 1000n, contractId: 'settlement:0' }]);
  const rows = round.donationsFor(RECIPIENT, 0);
  const market = rows.find((r) => r.contractId === 'settlement:3'), older = rows.find((r) => r.contractId === 'settlement:0');
  assert.deepEqual(market.parts, parts);
  assert.equal(older.parts, undefined);
  // the dev client's record: each order's player and its share of this output, by the fee it paid
  const rec = donationRecord(market, { usd: 1, eur: 1, priceAtMs: 0 });
  assert.deepEqual(rec.parts, [{ entryId: hex('a'), playerKey: hex('1'), msat: '1000' }, { entryId: hex('b'), playerKey: hex('2'), msat: '3000' }]);
  assert.equal(rec.playerKey, null, 'two orders: no one player for the whole output');
  const one = donationRecord({ ...market, amountMsat: '221', parts: [parts[0]] }, { usd: 1, eur: 1, priceAtMs: 0 });
  assert.deepEqual([one.playerKey, one.parts[0].msat], [hex('1'), '221'], 'one order alone is the row\'s player');
});
