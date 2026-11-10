// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1336 (§27A.8.5 RULED 2026-11-07, #1301): "reserves follow the guardians, so a reserve output carries the network_id it was paid under,
// and guardian code releases it only for a proposal ratified by that network's census; ... A client MUST ask (never follow automatically) when
// the certificate's re-affirmed weight is under 66 % of the ancestor census". Measured: a successor at 34 % cannot pay out the ancestor's
// reserves, and a client asks before following it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveRowsOfNetwork } from '../src/reserve-payout.js';
import { successorNeedsAsking, SUCCESSOR_FOLLOW_BPS } from '../../arena-protocol/src/reaffirm.js';

const ANCESTOR = 'aa'.repeat(32), SUCCESSOR = 'bb'.repeat(32);
const ZERO = '00'.repeat(32);
const rounds = { ['01'.repeat(32)]: ANCESTOR, ['02'.repeat(32)]: ANCESTOR, ['03'.repeat(32)]: SUCCESSOR };
const rows = [
  { outpoint: 'a:0', roundId: '01'.repeat(32), amountMsat: 2_000_000n },   // paid under the ancestor
  { outpoint: 'a:1', roundId: '02'.repeat(32), amountMsat: 3_000_000n },   // paid under the ancestor
  { outpoint: 'b:0', roundId: '03'.repeat(32), amountMsat: 1_000_000n },   // paid under the successor, after the fork
  { outpoint: 'c:1', roundId: ZERO, amountMsat: 500_000n },                // a payout's change, made by this seat's own network
  { outpoint: 'd:0', roundId: '04'.repeat(32), amountMsat: 9_000_000n },   // a round this seat cannot read
];
const net = (rid) => rounds[rid] || null;
const sum = (rs) => rs.reduce((a, r) => a + r.amountMsat, 0n);

test('#1336 a successor at 34 % cannot pay out the ancestor\'s reserves, and a client asks before following it', () => {
  const atSuccessor = reserveRowsOfNetwork(rows, SUCCESSOR, net);
  const atAncestor = reserveRowsOfNetwork(rows, ANCESTOR, net);
  const ask34 = successorNeedsAsking({ reaffirmedSats: 34_000_000n, ancestorSats: 100_000_000n });
  const ask66 = successorNeedsAsking({ reaffirmedSats: 66_000_000n, ancestorSats: 100_000_000n });
  const ask65 = successorNeedsAsking({ reaffirmedSats: 65_990_000n, ancestorSats: 100_000_000n });
  const unread = successorNeedsAsking({ reaffirmedSats: 90n, ancestorSats: 0n });
  console.log('  MEASURED #1336:', JSON.stringify({ successorSpends: atSuccessor.filter((r) => !r.unknown).map((r) => r.outpoint), successorMsat: String(sum(atSuccessor.filter((r) => !r.unknown))),
    ancestorSpends: atAncestor.filter((r) => !r.unknown).map((r) => r.outpoint), ancestorMsat: String(sum(atAncestor.filter((r) => !r.unknown))), ask34: [ask34.ask, ask34.bps], ask66: [ask66.ask, ask66.bps], ask65: ask65.ask, unread: unread.ask }));
  // a row of a round this seat cannot read is kept as unknown (kanban #1409): never picked by this seat, never another network's
  const known = (rs) => rs.filter((r) => !r.unknown).map((r) => r.outpoint);
  assert.deepEqual(known(atSuccessor), ['b:0', 'c:1'], 'the successor spent the ancestor\'s reserve rows');
  assert.deepEqual(known(atAncestor), ['a:0', 'a:1', 'c:1'], 'the ancestor never stops: it still pays its own');
  assert.deepEqual([atSuccessor, atAncestor].map((rs) => rs.filter((r) => r.unknown).map((r) => r.outpoint)), [['d:0'], ['d:0']], 'a row of an unreadable round is unknown, not dropped');
  assert.deepEqual(reserveRowsOfNetwork(rows, null, net), [], 'a seat with no network id spends nothing');
  assert.equal(SUCCESSOR_FOLLOW_BPS, 6600);
  assert.deepEqual([ask34.ask, ask34.bps], [true, 3400]);
  assert.deepEqual([ask66.ask, ask66.bps], [false, 6600]);
  assert.equal(ask65.ask, true); assert.equal(unread.ask, true);
});
