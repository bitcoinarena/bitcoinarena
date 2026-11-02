// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT THE ROUND OWES, AS F. Seats do not sign this table: what a seat signs is its SettlementAck (settlement-ack.js, §5A.3, kanban #1035),
// so the signing and counting that stood here, with no callers, went with that ruling.
import { computePayoutTable, payoutTableId, encodePayoutTable } from '../../arena-protocol/src/payout.js';

/**
 * WHAT THIS NODE SAYS THE ROUND OWES, computed from its own inputs.
 *
 * `entries` carry the core's outcome word, the score and the stake - the same
 * three §20 calls Membership and FinalResults - and the floor comes off the
 * contract rather than a literal, and the payout rule off the round's game (plugins.js payoutRuleOfRound):
 * `payoutShares` its top split, or null for §18A's curve.
 */
export function tableFor({ roundId, entries, minScore, payoutShares = null }) {
  const computed = computePayoutTable({ roundId, entries, minScore, payoutShares });
  const table = computed.table;
  const id = payoutTableId({ roundId, table });
  return { table, tableId: id, bytes: encodePayoutTable({ roundId, table }), computed };
}
