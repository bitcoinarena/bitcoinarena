// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1249 (audit 2 #1204 SETTLEMENT-1): a round's row made ACCEPTED on another seat's landed transaction - read from the history by recordSubmit, the
// kept pass or recover - kept the moves of this seat's own txid, so what the round "moved" here was a transaction that never landed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';

const RID = new Uint8Array(32).fill(0x5e), b = new Uint8Array(4).fill(1);
const TA = 'aa'.repeat(32), TB = 'bb'.repeat(32);

test('#1249 a row written ACCEPTED on a txid of the history carries that txid\'s moves; ACCEPTED on the moves\' own txid leaves them', () => {
  const round = new Round(openStore(':memory:'));
  round.db.exec('PRAGMA foreign_keys = OFF');   // the round is this test's stub, not a row
  // this seat signed T_B and kept its moves; seat A's T_A is in the history too (taken, or read back)
  round.putSettlementTxid({ roundId: RID, txid: TB, message: b, claims: ['41:0', '42:0'], payouts: 3 });
  round.putSettlementTxid({ roundId: RID, txid: TA, message: b, claims: ['41:0', '43:0'], payouts: 2 });
  round.putLockSettlementMoves({ roundId: RID, txid: TB, claims: ['41:0', '42:0'], payouts: 3 });
  round.putLockSettlement({ roundId: RID, txid: TB, message: b, signature: b, state: 'SUBMITTING', why: '' });
  // T_A landed: the row is made ACCEPTED on it
  round.putLockSettlement({ roundId: RID, txid: TA, message: b, signature: b, state: 'ACCEPTED', why: 'in, from the history' });
  const m = round.lockSettlementMoves(RID);
  console.log('  MEASURED #1249:', JSON.stringify({ row: round.lockSettlement(RID).txid.slice(0, 4), moves: m.txid.slice(0, 4), claims: m.claims, payouts: m.payouts }));
  assert.equal(m.txid, TA, 'the moves stayed at the txid that never landed');
  assert.deepEqual(m.claims, ['41:0', '43:0']); assert.equal(m.payouts, 2);
  // a row ACCEPTED on its own moves' txid is left as kept
  const own = new Round(openStore(':memory:'));
  own.db.exec('PRAGMA foreign_keys = OFF');
  own.putLockSettlementMoves({ roundId: RID, txid: TB, claims: ['41:0'], payouts: 1 });
  own.putLockSettlement({ roundId: RID, txid: TB, message: b, signature: b, state: 'ACCEPTED', why: '' });
  assert.deepEqual(own.lockSettlementMoves(RID).claims, ['41:0']);
});

// KANBAN #1275 (audit 4 #1257 fixesB-4): the settle path's keepMoves wrote its own txid's moves after recover() had made the row ACCEPTED on the landed
// txid (undoing #1249), and rows made ACCEPTED before #1249 were never repaired. Now keepMoves leaves a row final on another txid, and the store's
// ACCEPTED rows are put right once at open.
test('#1275 keepMoves leaves the moves of a row ACCEPTED on another txid; a row made ACCEPTED before #1249 is repaired when the store opens', async () => {
  const { LockSettlement } = await import('../src/settlement.js');
  const db = openStore(':memory:');
  const round = new Round(db);
  round.db.exec('PRAGMA foreign_keys = OFF');
  round.putSettlementTxid({ roundId: RID, txid: TB, message: b, claims: ['41:0', '42:0'], payouts: 3 });
  round.putSettlementTxid({ roundId: RID, txid: TA, message: b, claims: ['41:0', '43:0'], payouts: 2 });
  round.putLockSettlement({ roundId: RID, txid: TB, message: b, signature: b, state: 'SUBMITTING', why: '' });
  round.putLockSettlement({ roundId: RID, txid: TA, message: b, signature: b, state: 'ACCEPTED', why: 'recover: in, from the history' });
  // the settle pass that gathered on T_B for seconds now keeps its moves, as #settleOnce does before #putRow
  const ls = new LockSettlement(round, {});
  const out = (n) => ({ outpoint: { txid: new Uint8Array(32).fill(n), outIdx: 0n } });
  ls.keepMoves(RID, { txid: TB, message: b, claims: [out(0x41), out(0x42)], plan: { payouts: [{}, {}, {}], stakeShares: [] } });
  const afterSettlePass = round.lockSettlementMoves(RID);
  // a store from before #1249: an ACCEPTED row on T_A whose moves are T_B's, the history holding T_A
  db.prepare('UPDATE lock_settlement_moves SET txid = ?, claims = ?, payouts = ? WHERE round_id = ?').run(TB, JSON.stringify(['41:0', '42:0']), 3, Buffer.from(RID));
  const before = round.lockSettlementMoves(RID);
  const reopened = new Round(db);
  const repaired = reopened.lockSettlementMoves(RID);
  console.log('  FACTS #1275:', JSON.stringify({ row: round.lockSettlement(RID).txid.slice(0, 4), movesAfterSettlePass: afterSettlePass.txid.slice(0, 4),
    oldStore: before.txid.slice(0, 4), afterOpen: [repaired.txid.slice(0, 4), repaired.claims, repaired.payouts] }));
  assert.equal(afterSettlePass.txid, TA, 'the settle pass wrote its own txid\'s moves over the ACCEPTED row\'s');
  assert.equal(before.txid, TB, 'the fixture: an old store\'s ACCEPTED row with another txid\'s moves');
  assert.deepEqual([repaired.txid, repaired.claims, repaired.payouts], [TA, ['41:0', '43:0'], 2], 'the old row was not repaired at open');
});
