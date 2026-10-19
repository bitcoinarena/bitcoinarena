// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE RULES A ROUND IS SETTLED UNDER, NAMED IN ITS CONTRACT (§6, kanban #314; 2026.0.3): four rule hashes, the disconnect rule, the claim
// window and each role's bond floor, in a 148-byte tail before the creator's key; a contract naming none keeps its bytes and id. A seat
// runs only the rules its build has; the draw weighs and admits by the role's own floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRoundContract, decodeRoundContract, roundId, RULES_MARKER } from '../src/contracts.js';
import { buildRules, rulesStand, roleFloorSats, RULE_HASHES, ruleHash, RULE_TEXTS } from '../src/rules.js';
import { selectCommittee } from '../src/sortition.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId } from '../src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 3,
};
const RULES = buildRules({ claimWindowDays: 3, bondMinGameVerifySats: 50000n, bondMinSettlementSats: 200000n });

test('a v3 contract names its rules in a 148-byte tail before the creator\'s key; every tail combination reads back; none named keeps the id', () => {
  const plain = encodeRoundContract(round);
  const named = encodeRoundContract({ ...round, rules: RULES });
  assert.deepEqual(named.subarray(0, plain.length), plain); assert.equal(named[plain.length], RULES_MARKER); assert.equal(named.length, plain.length + 148);
  assert.notDeepEqual(roundId({ ...round, rules: RULES }), roundId(round), 'the rules are in the id');
  const creator = b32(0x0c);
  for (const more of [{}, { startDeadlineTicks: 100 }, { seriesId: b32(0x5e), roundIndex: 7 }, { startDeadlineTicks: 100, seriesId: b32(0x5e), roundIndex: 7 }])
    for (const withCreator of [false, true]) {
      const c = { ...round, ...more, rules: RULES, ...(withCreator ? { creatorPubkey: creator } : {}) };
      const back = decodeRoundContract(encodeRoundContract(c));
      assert.deepEqual(back.rules, RULES, JSON.stringify(Object.keys(more)));
      if (withCreator) assert.deepEqual(back.creatorPubkey, creator);
      for (const [k, v] of Object.entries(more)) assert.deepEqual(back[k], v);
    }
  assert.throws(() => encodeRoundContract({ ...round, protocolVersion: 2, rules: RULES }), /from protocol version 3/);
});

test('a seat runs the rules its build has; another rule, an unknown disconnect rule or a floor under bond_min is refused', () => {
  assert.equal(rulesStand(round).ok, true, 'naming none: bound by config, as before');
  assert.equal(rulesStand({ ...round, rules: RULES }).ok, true);
  const other = { ...RULES, finality: ruleHash(RULE_TEXTS.finality + ' (edited)') };
  assert.match(rulesStand({ ...round, rules: other }).why, /names a finality rule this build does not run/);
  assert.match(rulesStand({ ...round, rules: { ...RULES, disconnect: 9 } }).why, /disconnect rule 9/);
  assert.match(rulesStand({ ...round, rules: { ...RULES, bondMinSettlementSats: 1n } }).why, /under its bond_min/);
  assert.equal(RULE_HASHES.equivocation.length, 32);
});

test('the draw admits by the role\'s own floor; a v2+ round\'s one draw for both roles takes the higher of the two', () => {
  const entry = (n, bondSats) => ({ pubkey: b32(0x10 + n), txid: b32(0x30 + n), vout: 0, bondSats, roles: ['game', 'settlement'], hostedGames: [NEXTBLOCK_GAME_ID] });
  const entries = [entry(1, 100000n), entry(2, 250000n), ...[3, 4, 5, 6, 7, 8, 9, 10].map((n) => entry(n, 300000n))];
  const c = { ...round, gameVerifySlots: 2, settlementSlots: 2, rules: RULES };
  assert.equal(roleFloorSats(c, 'settlement'), 200000n); assert.equal(roleFloorSats(c, 'game'), 50000n); assert.equal(roleFloorSats(round, 'settlement'), 50000n);
  const drawn = selectCommittee({ entries, contract: c, role: 'settlement', committeeSeed: b32(0x77), count: 10 });
  assert.equal(drawn.some((e) => e.pubkey[0] === 0x11), false, 'a 100,000 sat bond drawn under the 200,000 settlement floor');
  assert.equal(drawn.some((e) => e.pubkey[0] === 0x12), true, 'a 250,000 sat bond above both floors left out');
  assert.equal(drawn.length, 9);
  // a contract naming no rules admits every bond at its bond_min, as before
  assert.equal(selectCommittee({ entries, contract: { ...round, gameVerifySlots: 2, settlementSlots: 2 }, role: 'settlement', committeeSeed: b32(0x77), count: 10 }).length, 10);
});
