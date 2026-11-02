// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// 5A.3 ROW 4: REFUSED BY NAME (RULED 2026-11-02, kanban #1035, #1040). "The settlement record" has no signature of the accused, and a
// FROST signature names nobody, so these bytes prove nothing against anybody.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHex } from '../src/hash.js';
import { SETTLEMENT_THRESHOLD } from '../src/payout.js';
import { CLAIM, RETURN } from '../src/lock-action.js';
import {
  encodeSettlementRecord, decodeSettlementRecord, settlementRecordId, slashHoldsOnSettlement,
} from '../src/slash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NODE = b32(0x11);
const ROUND = b32(0x01);
const ENTRY = b32(0x02);
const BOND = b32(0x55);
const committee = [NODE, b32(0x22), b32(0x23), b32(0x24), b32(0x25), b32(0x26), b32(0x27)];
const advert = { nodePubkey: NODE, bondTxid: BOND, bondVout: 3 };

/** A loser settled with everything 23.2 asks for. */
const lawful = (over = {}) => ({
  roundId: ROUND, entryId: ENTRY, nodePubkey: NODE, action: CLAIM,
  outcome: 'FAILED', qualifies: false, state: 'FINAL',
  shares: SETTLEMENT_THRESHOLD, signatures: SETTLEMENT_THRESHOLD, ...over,
});

// WHAT SLASHED BEFORE THE RULING, BYTE FOR BYTE: a record anybody can write, a count short, no signature of the accused.
test('an unsigned record slashes nobody: refused by name', () => {
  const bytes = encodeSettlementRecord(lawful({ signatures: 4 }));
  const proof = {
    roundId: ROUND, playerPubkey: new Uint8Array(32), nodePubkey: NODE, transcriptHash: ENTRY,
    signedResultId: settlementRecordId(decodeSettlementRecord(bytes)), bondTxid: BOND, bondVout: 3,
  };
  const no = slashHoldsOnSettlement({ proof, signedRecord: bytes, advert, committee });
  assert.equal(no.slashed, false);
  assert.equal(no.bond, undefined);
  assert.match(no.why, /refused: row 4/);
});

test('the record survives the round trip and every field is inside its id', () => {
  const r = lawful();
  const back = decodeSettlementRecord(encodeSettlementRecord(r));
  assert.deepEqual(back, r);
  assert.equal(toHex(settlementRecordId(back)), toHex(settlementRecordId(r)));

  const was = toHex(settlementRecordId(r));
  for (const over of [{ roundId: b32(9) }, { entryId: b32(9) }, { nodePubkey: b32(9) },
                      { action: RETURN }, { outcome: 'FORFEIT' }, { qualifies: true },
                      { state: 'SUSPENDED' }, { shares: 4 }, { signatures: 4 }])
    assert.notEqual(toHex(settlementRecordId(lawful(over))), was, JSON.stringify(over));

  const longer = new Uint8Array(encodeSettlementRecord(r).length + 1);
  longer.set(encodeSettlementRecord(r));
  assert.throws(() => decodeSettlementRecord(longer), /trailing bytes/);
});
