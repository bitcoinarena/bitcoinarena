// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHERE A ROUND'S SETTLEMENT STANDS AT THIS SIGNER NODE, in one federation or in several (2026.0.3 step 6, kanban #348): a round
// that takes any federation keeps one row per federation (fed_lock_settlements) and none in lock_settlements, so a reader of the
// state asks here - ACCEPTED once every federation's transaction is (round.js settlementState). A round store without it (a
// test's stub) answers from its one row, as before.
export function stateOf(round, roundIdBytes) {
  if (round && typeof round.settlementState === 'function') return round.settlementState(roundIdBytes);
  const s = round && typeof round.lockSettlement === 'function' ? round.lockSettlement(roundIdBytes) : null;
  return s ? s.state : null;
}
