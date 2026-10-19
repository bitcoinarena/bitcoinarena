// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET ROUND'S LOCKS OUTLIVE ITS WHOLE LIFE (2026-10-09: "drop the fixed 144 blocks. Size expiry from
// the round end plus the void deadline plus the objection window plus a margin. Seats check that size; the page computes it").
//
// A lock expires back to its player at a block height, and nobody can claim it after: a lock that expires before its round
// is settled hands a loser its stake back. The fixed 144 blocks (§23.1) were a day on testnet4 and 24 minutes on the demo's
// 10 s regtest chain - shorter than one Up/Down window, its void deadline and its objection window together. So a market
// round names its own `stake_expiry_blocks`: enough blocks, at the FASTEST its chain can make them, to cover everything from
// its committee time (the earliest an entry can lock) to the latest it can be settled - window end, resolution delay, void
// deadline, objection window - and a margin. The page locks for exactly the round's number (page-lock.js, as before); every
// seat checks the round's number at its door and every lock against it. A game round keeps the ruled 144.
import { STAKE_EXPIRY_BLOCKS } from './constants.js';
import { NETWORK_ID_REGTEST, NETWORK_ID_TESTNET4 } from './genesis-ids.js';
import { OBJECTION_WINDOW_MS } from './constants.js';

const lxHex = (b) => Array.from(b || [], (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * THE FASTEST A CHAIN MAKES BLOCKS, per network: the demo's regtest chain is mined every 10 s; testnet4's are 10 min on
 * average but come in bursts at minimum difficulty (its 20-minute rule) - taken as one a minute, so a span sized by it
 * outlasts the time it was sized for. A network not named here has no market rounds.
 */
export const FASTEST_BLOCK_MS = Object.freeze({ [lxHex(NETWORK_ID_REGTEST)]: 10000n, [lxHex(NETWORK_ID_TESTNET4)]: 60000n });
export const LOCK_EXPIRY_MARGIN_MS = 30n * 60n * 1000n;

export const fastestBlockMsOf = (networkId) => FASTEST_BLOCK_MS[lxHex(networkId)] ?? null;

/** The latest a market round can be settled: its entry close, its resolution delay, its void deadline, its objection window. */
export function marketSettledByMs(contract, terms) {
  const objection = typeof contract.objectionWindowMs === 'bigint' ? contract.objectionWindowMs : OBJECTION_WINDOW_MS;
  return contract.entryCloseMs + terms.resolveAfterCloseMs + terms.deadlineAfterResolveMs + objection;
}

/** The blocks a market round's locks must last: from its committee time to its settled-by time and the margin. */
export function marketExpiryBlocks(contract, terms) {
  const blockMs = fastestBlockMsOf(contract.networkId);
  if (!blockMs) return { ok: false, why: 'that round\'s network names no fastest block time: it holds no market round' };
  const spanMs = marketSettledByMs(contract, terms) - contract.committeeTimeMs + LOCK_EXPIRY_MARGIN_MS;
  if (spanMs <= 0n) return { ok: false, why: 'that round is settled before its committee time' };
  return { ok: true, blocks: Number((spanMs + blockMs - 1n) / blockMs), spanMs, blockMs };
}

/**
 * DOES THE ROUND NAME THE RIGHT LOCK SPAN? A market with terms (an attested manifest naming `marketTerms`): at least
 * `marketExpiryBlocks`; any other round: the ruled 144. `manifest` is the round's game's, as the seat hosts it or the page
 * pinned it; none - the ruled 144.
 */
export function stakeExpiryFits(contract, { manifest = null } = {}) {
  const terms = manifest && manifest.resultType === 2 && manifest.marketTerms ? manifest.marketTerms : null;
  if (!terms) {
    if (contract.stakeExpiryBlocks !== STAKE_EXPIRY_BLOCKS)
      return { ok: false, why: `that round names stake_expiry_blocks ${contract.stakeExpiryBlocks} where §23.1 rules ${STAKE_EXPIRY_BLOCKS}` };
    return { ok: true, blocks: STAKE_EXPIRY_BLOCKS };
  }
  const need = marketExpiryBlocks(contract, terms);
  if (!need.ok) return need;
  if (!Number.isInteger(contract.stakeExpiryBlocks) || contract.stakeExpiryBlocks < need.blocks)
    return { ok: false, why: `that market round names stake_expiry_blocks ${contract.stakeExpiryBlocks}, and its locks must last ${need.blocks} blocks `
      + `(committee time to window end + void deadline + objection window + 30 min, at ${need.blockMs} ms a block)` };
  return { ok: true, blocks: contract.stakeExpiryBlocks, need: need.blocks };
}
