// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r20 census-2 (P1, port gap of #3571): the 1.9 tree (interim-2026.1.9.17, c168830d5) does not carry PR #33 (merge 07992adfd on
// main). A round's creator names bond_min at the floor in force and per-role floors (contract.rules, rulesStand asks only >= bond_min)
// that only the creator's own bond reaches. meetsCensusMinimum counts keys at bond_min, selectCommittee admits keys at the role floor:
// the census minimum is met by honest nodes that can never be drawn and the committee is the creator's key alone.
// SAFE: either the census minimum counts keys at the role floor (and refuses), or the draw refuses a committee below it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRules, rulesStand } from '../src/rules.js';
import { drawCommittee } from '../src/sortition.js';
import { meetsCensusMinimum } from '../src/census.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId } from '../src/donation.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const GAME = b32(0x5a);
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: GAME, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  stakeMsat: 100000n, bondMinSats: 50000n, nodes: [], protocolVersion: 36,
};
const entry = (n, bondSats) => ({ pubkey: b32(0x10 + n), txid: b32(0x30 + n), vout: 0, bondSats, height: 1, roles: ['game', 'settlement'], hostedGames: [GAME], spent: false });

test('r20 census-2: a creator-named role floor does not turn ten undrawable honest nodes into a census for a committee of the creator alone', () => {
  const entries = [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => entry(n, 50000n)), entry(0x40, 5_000_000n)];
  const c = { ...round, rules: buildRules({ claimWindowDays: 1, bondMinGameVerifySats: 5_000_000n, bondMinSettlementSats: 5_000_000n }) };
  assert.equal(rulesStand(c).ok, true, 'the seat takes the contract (POST /round rulesStand)');
  const min = meetsCensusMinimum(entries, c, 'settlement');
  let drawn = null, threw = null;
  try { drawn = drawCommittee({ entries, contract: c, role: 'settlement', committeeSeed: b32(0x77) }); } catch (e) { threw = e; }
  const keys = drawn ? drawn.map((e) => e.pubkey[0].toString(16)) : null;
  console.log(`  FACTS: census minimum ok=${min.ok} have=${min.have}; settlement draw ${threw ? `refused: ${threw.message}` : `= [${keys.join(', ')}]`}`);
  assert.ok(!min.ok || threw, `the census minimum was met by ${min.have} keys at bond_min while the settlement draw seated only [${keys}] - the creator's own key`);
});

// SPEC RULING 2026-11-27 (comment 11812): gated by the round's protocol version. A round below 36 keeps today's count at bond_min, so an
// old and a new seat judge it alike; the same round at 36 is refused (above).
test('r20 census-2: the same round at protocol 35 keeps the old count (bond_min): census minimum met by 11, the draw = [50]', () => {
  const entries = [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => entry(n, 50000n)), entry(0x40, 5_000_000n)];
  const c = { ...round, protocolVersion: 35, rules: buildRules({ claimWindowDays: 1, bondMinGameVerifySats: 5_000_000n, bondMinSettlementSats: 5_000_000n }) };
  const min = meetsCensusMinimum(entries, c, 'settlement');
  const keys = drawCommittee({ entries, contract: c, role: 'settlement', committeeSeed: b32(0x77) }).map((e) => e.pubkey[0].toString(16));
  console.log(`  FACTS: v35 census minimum ok=${min.ok} have=${min.have}; settlement draw = [${keys.join(', ')}]`);
  assert.deepEqual([min.ok, min.have, keys], [true, 11, ['50']]);
});
