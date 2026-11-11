// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE ON A PROTOCOL-27 ROUND (kanban #1486, ruled 2026-11-11): the developers' 4 % and the reserves' 2 % ride in the fee lock beside
// the nodes' 4 % - the entry's fee is the whole 10 %, its donation 0, and the lock transaction pays no donation or reserve output. The stake
// lock holds the same 90 % as before; what leaves the wallet at the lock is the same 100 sat, now all of it in locks that come back whole
// to a refused or void entry. Below 27 the page is today's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { feeBpsForRound, roundPaysReserves, roundGiftsInFee } from '../src/join.js';
import { lockAmountMsat, entryBreakdown, donationKeyShares, donationCostMsat } from '../src/page-lock.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { giftsEntryExpected } from '../../arena-protocol/src/reserves.js';

const key = (prefix, fill) => Uint8Array.of(prefix, ...new Uint8Array(32).fill(fill));
const DEVS = [{ recipientPk: key(0x02, 0xa1), shareBps: 6667, label: 'dev a' }, { recipientPk: key(0x03, 0xb2), shareBps: 3333, label: 'dev b' }];
const b32 = (n) => new Uint8Array(32).fill(n);
// a round as the page holds it: the decoded contract (the gate's fee table reads its id)
const round = (protocolVersion) => ({
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, gameId: b32(9), simCoreHash: b32(1),
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: b32(0x33), stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
  committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [b32(1), b32(2)], protocolVersion });

test('a protocol-27 game round: fee 10 %, nothing donated beside it, the lock holds the same 90 %', () => {
  const v27 = round(27);
  assert.equal(roundPaysReserves(v27), true);
  assert.equal(roundGiftsInFee(v27), true);
  assert.equal(roundGiftsInFee(round(20)), false);
  assert.deepEqual([feeBpsForRound(v27), feeBpsForRound(round(20))], [1000, 400]);
  assert.equal(lockAmountMsat(v27), 90000n);
  assert.equal(lockAmountMsat(round(20), 6000n), 90000n, 'today\'s lock: 100 less the 4 % fee and the 6 % donation');
  const b = entryBreakdown(v27);
  assert.deepEqual([b.stakeMsat, b.feeMsat, b.donationMsat, b.lockMsat], [100000n, 10000n, 0n, 90000n]);
  // the entry the page builds from these is the one the seats' door takes
  assert.equal(giftsEntryExpected({ entry: { stakeMsat: b.stakeMsat, feeMsat: b.feeMsat, donationMsat: 0n } }).ok, true);
  // no donation output and no reserve output in the lock transaction
  assert.deepEqual(donationKeyShares(0n, { network: DEVS, game: DEVS }), []);
  assert.equal(donationCostMsat(0n, { network: DEVS, game: DEVS }), 0n);
});

test('the page\'s fee-lock gate on protocol 27 mints the whole 10 % lock, as the seats\' gate does', () => {
  const v27 = round(27);
  const g = feeLockPays({ contract: v27, fees: { ppm: 1000n, baseMsat: 0n }, feeBps: feeBpsForRound(v27) });
  assert.equal(g.pays, true, g.why);
  assert.equal(g.lockMsat, 10000n);
});
