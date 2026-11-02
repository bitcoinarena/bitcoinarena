// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 5A.3 ROW 3: A PAYOUT TABLE THAT IS NOT F OF ITS PUBLISHED INPUTS.
//
// Refused by name since the ruling of 2026-11-02 (kanban #1035, #1040): nodes sign no table, so these
// bytes name nobody. The table's own hashes are what the row will stand on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import {
  computePayoutTable, encodePayoutTable, decodePayoutTable, payoutTableId,
} from '../src/payout.js';
import {
  slashHoldsOnTable, payoutInputsId,
} from '../src/slash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x11);
const ROUND = b32(0x01);
const BOND = b32(0x55);
const committee = [NODE, b32(0x22), b32(0x23), b32(0x24), b32(0x25), b32(0x26), b32(0x27)];

// Two winners, two losers: a pool that actually divides and rows that are not
// all zero, so a tampered amount has something to be wrong against.
const entries = [
  { pubkey: b32(0xa1), outcome: 'DELIVERED', score: 900, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n },
  { pubkey: b32(0xa2), outcome: 'DELIVERED', score: 500, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n },
  { pubkey: b32(0xa3), outcome: 'FAILED', score: 0, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n },
  { pubkey: b32(0xa4), outcome: 'FORFEIT', score: 0, stakeMsat: 100000n, feeMsat: 0n, donationMsat: 0n },
];
// THE FLOOR IS THE ROUND'S, not this test's. It was an argument until the
// contract was read here, and whoever writes a proof would otherwise pick the
// floor F is recomputed at - a different floor is a different honest table.
const MIN = 100;
const contract = { minScore: MIN };

const honest = () => computePayoutTable({ roundId: ROUND, entries, minScore: MIN });
const tableOf = (rows) => encodePayoutTable({ roundId: ROUND, table: rows });
const inputs = () => payoutInputsId({ roundId: ROUND, entries, minScore: MIN });

const proofFor = (bytes, over = {}) => ({
  roundId: ROUND, playerPubkey: b32(0xa1), nodePubkey: NODE,
  transcriptHash: inputs(), signedResultId: payoutTableId(decodePayoutTable(bytes)),
  bondTxid: BOND, bondVout: 3, ...over,
});
const advert = { nodePubkey: NODE, bondTxid: BOND, bondVout: 3 };

// WHAT SLASHED BEFORE THE RULING, BYTE FOR BYTE: one millisatoshi off, the inputs bound, no signature of the accused anywhere.
test('an unsigned table that is not F slashes nobody: refused by name', () => {
  const wrong = tableOf(honest().table.map((r, i) => (i === 0 ? { ...r, amountMsat: r.amountMsat - 1n } : r)));
  const no = slashHoldsOnTable({ proof: proofFor(wrong), signedTable: wrong, advert, committee, entries, contract });
  assert.equal(no.slashed, false);
  assert.equal(no.bond, undefined);
  assert.match(no.why, /refused: row 3 stands on a SettlementAck/);
});

// TWO HONEST NODES HANDED THE SAME ENTRIES IN ANOTHER ORDER NAME THE SAME TABLE, or `F` being deterministic buys nothing.
test('the same table in another order is the same table', () => {
  const rows = [...honest().table].reverse();
  assert.equal(toHex(payoutTableId({ roundId: ROUND, table: rows })),
               toHex(payoutTableId({ roundId: ROUND, table: honest().table })));
});

test('the round is inside the table, so a signature cannot cross rounds', () => {
  const here = payoutTableId({ roundId: ROUND, table: honest().table });
  const there = payoutTableId({ roundId: b32(0x02), table: honest().table });
  assert.notEqual(toHex(here), toHex(there));
});

test('the table survives the round trip and a changed row changes its hash', () => {
  const t = { roundId: ROUND, table: honest().table };
  const back = decodePayoutTable(encodePayoutTable(t));
  assert.equal(toHex(back.roundId), toHex(ROUND));
  assert.equal(back.table.length, t.table.length);
  assert.equal(toHex(payoutTableId(back)), toHex(payoutTableId(t)));

  const longer = new Uint8Array(encodePayoutTable(t).length + 1);
  longer.set(encodePayoutTable(t));
  assert.throws(() => decodePayoutTable(longer), /trailing bytes/);
});

test('every input is inside the hash a proof binds to', () => {
  const was = toHex(inputs());
  assert.notEqual(toHex(payoutInputsId({ roundId: b32(0x02), entries, minScore: MIN })), was);
  assert.notEqual(toHex(payoutInputsId({ roundId: ROUND, entries, minScore: MIN + 1 })), was);
  for (const [field, value] of [['outcome', 'FAILED'], ['score', 901], ['stakeMsat', 1n],
                                ['pubkey', b32(0xb1)]]) {
    const moved = entries.map((e, i) => (i === 0 ? { ...e, [field]: value } : e));
    assert.notEqual(toHex(payoutInputsId({ roundId: ROUND, entries: moved, minScore: MIN })),
      was, field);
  }
  // and the order of the entries is not one of them
  assert.equal(toHex(payoutInputsId({ roundId: ROUND, entries: [...entries].reverse(), minScore: MIN })),
    was, 'two nodes publishing the same membership must bind to the same bytes');
});
