// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CLAIMS ON A HALTED FEDERATION'S ESCROW (spec §23A.5 liquidation, kanban #1093 part 8): every note at face, paid when it is
// claimed, in the order claimed; the window runs liquidation_claim_blocks from the halt (3 months on mainnet); only after it the rest
// goes to the protocol reserves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleClaims, liquidationSchedule, REGTEST_CLOCKS, MAINNET_CLOCKS, TESTNET_CLOCKS } from '../src/federation-slash.js';

const clocks = REGTEST_CLOCKS;             // halt 1000: claims open at 1010 (the liquidation), close at 1100; the rest splits from 1101
const signed = (c) => !c.forged;
const claim = (nonce, sat, height, extra = {}) => ({ nonce, amountMsat: BigInt(sat) * 1000n, height, ...extra });
const base = { haltHeight: 1000, clocks, noteSigned: signed };

test('every valid note at face value; the refused named; the remainder waits for the window to close', () => {
  const r = settleClaims({ ...base, escrowMsat: 1_000_000n, atHeight: 1010, spentNonces: ['bb'],
    claims: [claim('aa', 100, 1005), claim('bb', 50, 1005), claim('cc', 30, 1006, { forged: true }), claim('aa', 100, 1007), claim('dd', 20, 1101)] });
  assert.deepEqual(r.paid.map((p) => [p.nonce, p.msat]), [['aa', 100000n]]);
  assert.deepEqual(r.refused.map((x) => x.nonce), ['bb', 'cc', 'aa', 'dd']);
  assert.match(r.refused[0].why, /spent set/);
  assert.match(r.refused[1].why, /federation's signature/);
  assert.match(r.refused[2].why, /claimed before/);
  assert.match(r.refused[3].why, /after the claim window closed at 1100/);
  assert.deepEqual([r.short, r.remainderMsat, r.split], [false, 900000n, null], 'no split while a player may still claim');
  assert.equal(settleClaims({ ...base, escrowMsat: 1_000_000n, atHeight: 1100, spentNonces: [], claims: [claim('aa', 100, 1005)] }).split, null, 'not at the last block of the window either');
  const later = settleClaims({ ...base, escrowMsat: 1_000_000n, atHeight: 1101, spentNonces: [], claims: [claim('aa', 100, 1005)] });
  assert.deepEqual(later.split, { reserves: 900000n }, 'the 900 000 msat left go to the protocol reserves');
});

test('a claim is paid when it is made: a later claim never takes from an earlier one, even if the escrow runs short', () => {
  const first = settleClaims({ ...base, escrowMsat: 150_000n, atHeight: 1012, spentNonces: null, claims: [claim('aa', 100, 1011)] });
  assert.deepEqual(first.paid.map((p) => [p.nonce, p.msat]), [['aa', 100000n]], 'paid at face the block it was made, nobody waits');
  const r = settleClaims({ ...base, escrowMsat: 150_000n, atHeight: 1100, spentNonces: null,
    claims: [claim('aa', 100, 1011), claim('bb', 100, 1013), claim('cc', 50, 1090)] });
  assert.deepEqual(r.paid.map((p) => [p.nonce, p.msat]), [['aa', 100000n], ['bb', 50000n], ['cc', 0n]], 'in the order made, each at face while it lasts');
  assert.deepEqual([r.proRata, r.rate, r.short, r.shortMsat, r.spentSetPublished, r.remainderMsat], [false, 1, true, 100000n, false, 0n]);
});

test('the window: 3 months from the halt on mainnet (12,960), a twentieth on testnet4 (648), regtest its own (100)', () => {
  assert.deepEqual([MAINNET_CLOCKS.liquidationClaimBlocks, TESTNET_CLOCKS.liquidationClaimBlocks, REGTEST_CLOCKS.liquidationClaimBlocks], [12960, 648, 100]);
  const w = liquidationSchedule({ haltHeight: 900000 });
  assert.deepEqual([w.claimWindowOpens, w.claimWindowCloses, w.lateClaimsUntil, w.remainderSplitsAt], [900288, 912960, 912960, 912961]);
  assert.equal(liquidationSchedule({ haltHeight: 1, clocks: { abandonBlocks: 10, claimBlocks: 10, drainBlocks: 100 } }).ok, false, 'clocks without the window are refused, not guessed');
});
