// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NO PLAYER-NODE CONFLICT GATE AT THE SEAT (§5A.13, RULED 2026-10-14): a player declares no operator, so a
// signer node is never kept out of a settlement, and no round is voided, by what a conflict lookup would say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as curve from '../src/curve.js';
import { LockSettlement } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { servingAfterConflicts } from '../../arena-protocol/src/operator-conflict.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x5f);
const COMMITTEE = [1, 2, 3, 4, 5, 6, 7].map((n) => b32(0xb0 + n));
const CONTRACT = encodeRoundContract({ networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 2 });

const seat = (conflictsFor) => {
  const round = new Round(openStore(':memory:'));
  round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: CONTRACT } : null);
  return new LockSettlement(round, { curve, conflictsFor, port: { settle: async () => ({}), fees: async () => ({ ppm: 0n, baseMsat: 0n }) },
    dkg: { signerNodeFor: () => ({ ok: true, pool: { groupPublicKey: new Uint8Array(33).fill(2) } }) } });
};

test('a seat settles whatever a conflict lookup says: no conflicted refusal, no ENTRY_VOID', async () => {
  let asked = 0;
  const said = (bad, selfOp = null) => () => { asked++; return { self: selfOp,
    serving: servingAfterConflicts({ committee: COMMITTEE, conflicted: new Set(bad.map((i) => toHex(COMMITTEE[i]))) }) }; };
  for (const c of [said([0], 'ee'.repeat(32)), said([0, 1, 2]), said([0, 1]), null]) {
    const plan = await seat(c).planOf(RID);
    assert.doesNotMatch(String(plan.why), /conflicted|ENTRY_VOID/);
  }
  assert.equal(asked, 0, 'the lookup is not consulted at all');
});
