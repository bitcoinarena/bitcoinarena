// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A BOT'S ENTRY (kanban #581, 2026-10-22: "The bots are also marked as bots, so they are excluded from the leaderboard. There is a
// flag in the API and protocol to mark them as bots"): the bot mark rides last of all, its marker alone, in the entry's signed bytes; an
// entry without it keeps exactly its bytes and its id; anything else after the entry is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeEntryContract, decodeEntryContract, entryId, BOT_MARKER, ORDER_MARKER } from '../src/contracts.js';
import { toHex } from '../src/hash.js';

const z = (n, f = 0) => new Uint8Array(n).fill(f);
const order = () => ({ roundId: z(32, 1), playerPubkey: z(32, 2), sessionPubkey: z(32, 3), stakeCommitment: z(32, 4), stakeMsat: 99000n, feeMsat: 1000n,
  donationMsat: 600n, joinTick: 0, worldSecret: z(32), vssSharesRef: z(32), stakePoint: z(33), feePreimage: z(32),
  stakeLockOutpoint: { txid: z(32, 5), outIdx: 0n }, feeLockOutpoint: { txid: z(32, 5), outIdx: 1n }, claimKeyAttestationRef: z(32, 6),
  donationOutpoints: [], pick: 0, limitPrice: 50000, orderExpiryMs: 0n });

test('a bot\'s market order carries the bot mark, last of all; it round-trips; without it the bytes and the id are as before', () => {
  const plain = order();
  const before = encodeEntryContract(plain);
  assert.equal(before.includes(ORDER_MARKER), true);
  const bot = { ...plain, bot: true };
  const bytes = encodeEntryContract(bot);
  assert.deepEqual([bytes.length, bytes[bytes.length - 1]], [before.length + 1, BOT_MARKER]);
  assert.equal(decodeEntryContract(bytes).bot, true);
  assert.equal(decodeEntryContract(before).bot, undefined);
  assert.deepEqual(encodeEntryContract(decodeEntryContract(before)), before);
  assert.deepEqual(encodeEntryContract({ ...plain, bot: false }), before, 'false is no mark');
  assert.notEqual(Buffer.from(entryId(bot)).toString('hex'), Buffer.from(entryId(plain)).toString('hex'), 'signed in: no seat can add or drop it');
  // with the reserve lock before it
  const both = { ...plain, reserveOutpoint: { txid: z(32, 5), outIdx: 4n }, bot: true };
  const d = decodeEntryContract(encodeEntryContract(both));
  assert.deepEqual([d.reserveOutpoint.outIdx, d.bot], [4n, true]);
  assert.throws(() => encodeEntryContract({ ...plain, bot: 'yes' }), /a bot's \(true\) or not/);
  assert.throws(() => decodeEntryContract(Uint8Array.from([...bytes, 0x01])), /trailing|after the entry/);
  assert.throws(() => decodeEntryContract(Uint8Array.from([...before, 0x99])), /neither its federation, its operator, its website, its items, its reserve lock nor the bot mark/);
});

test('the bot mark ends any entry: none of donation outputs, a pick without an order, a move commitment - each round-trips (kanban #581: the decoder read the mark as a list)', () => {
  const plain = order();
  delete plain.donationOutpoints; delete plain.pick; delete plain.limitPrice; delete plain.orderExpiryMs;
  for (const [name, e] of [['no donation outputs, no pick', plain], ['a pick, no order', { ...plain, pick: 1 }], ['a move commitment', { ...plain, commit: new Uint8Array(32).fill(0x5e) }],
    ['donation outputs and a pick, no order', { ...plain, donationOutpoints: [{ txid: z(32, 7), outIdx: 2n }], pick: 0 }]]) {
    const back = decodeEntryContract(encodeEntryContract({ ...e, bot: true }));
    assert.equal(back.bot, true, name);
    assert.equal(back.pick, e.pick, name);
    assert.equal(back.limitPrice, undefined, name);
    assert.equal(toHex(encodeEntryContract(back)), toHex(encodeEntryContract({ ...e, bot: true })), `${name}: the same bytes back`);
  }
});
