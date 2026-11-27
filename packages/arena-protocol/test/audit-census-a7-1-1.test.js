// 1.9 port (kanban #3855) of PR #33's test (2.0 #3571): rounds here name protocol 36, the version the rule is gated on.
// Audit census a7-1-1: a round's per-role bond floor (contract.rules, §6) is not what the census minimum counts.
// meetsCensusMinimum counts node keys at the round's bond_min; selectCommittee admits only keys at the ROLE's floor, which the
// round's creator names (rulesStand only asks floor >= bond_min). A creator names bond_min at the floor in force (every honest node
// counts toward census_min_nodes) and a role floor only their own big bonds reach: the census minimum is met by nodes that can never
// be drawn, and the committee is their keys alone (here one key - the #2850 symptom, through the role floor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRules, rulesStand } from '../src/rules.js';
import { selectCommittee, drawCommittee } from '../src/sortition.js';
import { meetsCensusMinimum } from '../src/census.js';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../src/test-donation-sets.js';
import { donationSetId } from '../src/donation.js';
import { CENSUS_ROLE_FLOOR_VERSION } from '../src/constants.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NEXTBLOCK_GAME_ID = b32(0x5a); // 1.9 has no packages/nextblock: any game id the entries host
const round = {
  networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2),
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: CENSUS_ROLE_FLOOR_VERSION, // 1.9 (kanban #3855): the rule holds from protocol 36
};
const entry = (n, bondSats) => ({ pubkey: b32(0x10 + n), txid: b32(0x30 + n), vout: 0, bondSats, height: 1, roles: ['game', 'settlement'], hostedGames: [NEXTBLOCK_GAME_ID], spent: false });

test('a creator-named role floor does not let a census of nodes that can never be drawn meet census_min_nodes', () => {
  // ten honest nodes at the floor in force, one creator node with a large bond
  const entries = [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => entry(n, 50000n)), entry(0x40, 5_000_000n)];
  const c = { ...round, rules: buildRules({ claimWindowDays: 1, bondMinGameVerifySats: 5_000_000n, bondMinSettlementSats: 5_000_000n }) };
  assert.equal(rulesStand(c).ok, true, 'the seat takes the contract (POST /round rulesStand)');
  const min = meetsCensusMinimum(entries, c, 'settlement');
  let drawn = null, threw = null;
  try { drawn = drawCommittee({ entries, contract: c, role: 'settlement', committeeSeed: b32(0x77) }); } catch (e) { threw = e; }
  const keys = drawn ? drawn.map((e) => e.pubkey[0].toString(16)) : null;
  console.log(`  FACTS: census minimum ok=${min.ok} have=${min.have}; settlement draw ${threw ? `refused: ${threw.message}` : `= [${keys.join(', ')}]`}`);
  // SAFE: either the census minimum counts keys at the role's floor (and refuses), or the draw refuses a committee below it
  assert.ok(!min.ok || threw, `the census minimum was met by ${min.have} keys at bond_min while the settlement draw seated only [${keys}] - the creator's own key(s)`);
});

// Mainnet's shape (7 slots, threshold 5, census_min_nodes 10, genesis.js): five creator nodes over a role floor they alone reach
// were counted with the ten honest nodes at bond_min - fifteen, so a mainnet census minimum of ten was met and the drawn committees
// were the creator's five keys. No mainnet network id exists yet, so this asks what the minimum counts: the keys the draw can admit.
// (On regtest and testnet4, census_min_nodes is 2: five keys at a floor is a census there, as it is when bond_min itself is raised.)
const MAINNET_CENSUS_MIN_NODES = 10;
test('seven slots, threshold five: five creator nodes over a role floor they alone reach are counted as five, not fifteen - under mainnet\'s census_min_nodes', () => {
  const entries = [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => entry(n, 50000n)), ...[0x41, 0x42, 0x43, 0x44, 0x45].map((n) => entry(n, 5_000_000n))];
  const c = { ...round, rules: buildRules({ claimWindowDays: 1, bondMinGameVerifySats: 5_000_000n, bondMinSettlementSats: 5_000_000n }) };
  assert.equal(rulesStand(c).ok, true);
  for (const role of ['game', 'settlement']) {
    const drawn = drawCommittee({ entries, contract: c, role, committeeSeed: b32(0x55) }).map((e) => e.pubkey[0]);
    const { have } = meetsCensusMinimum(entries, c, role);
    console.log(`  FACTS: ${role} census minimum have=${have}; drawn=${JSON.stringify(drawn)} (honest keys are 0x11..0x1a)`);
    assert.ok(drawn.every((k) => k >= 0x50), 'the draw admits only the keys at the role floor');
    assert.equal(have, 5, `${role}: the census minimum counted ${have} keys, the draw can admit 5 - fifteen met mainnet's ${MAINNET_CENSUS_MIN_NODES}`);
    assert.ok(have < MAINNET_CENSUS_MIN_NODES);
  }
});

test('a role floor is counted as a raised bond_min is: the census minimum answers the same', () => {
  const entries = [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => entry(n, 50000n)), ...[0x41, 0x42, 0x43].map((n) => entry(n, 5_000_000n))];
  const byRule = { ...round, rules: buildRules({ claimWindowDays: 1, bondMinGameVerifySats: 5_000_000n, bondMinSettlementSats: 5_000_000n }) };
  const byFloor = { ...round, bondMinSats: 5_000_000n };
  for (const role of ['game', 'settlement'])
    assert.deepEqual(meetsCensusMinimum(entries, byRule, role), meetsCensusMinimum(entries, byFloor, role), role);
});

test('one draw for both roles (v2 onward): each role\'s minimum counts at the higher of the two floors, as the draw admits', () => {
  // the game/verify floor high, the settlement floor at bond_min: the one draw takes only keys at the game/verify floor
  const entries = [...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => entry(n, 50000n)), entry(0x40, 5_000_000n)];
  const c = { ...round, rules: buildRules({ claimWindowDays: 1, bondMinGameVerifySats: 5_000_000n, bondMinSettlementSats: 50000n }) };
  assert.equal(rulesStand(c).ok, true);
  assert.equal(meetsCensusMinimum(entries, c, 'settlement').have, 1);
  assert.throws(() => drawCommittee({ entries, contract: c, role: 'settlement', committeeSeed: b32(0x77) }), /needing 2/);
  // and honest nodes at the floors still make a census
  const ok = { ...round, rules: buildRules({ claimWindowDays: 1, bondMinGameVerifySats: 50000n, bondMinSettlementSats: 50000n }) };
  assert.equal(meetsCensusMinimum(entries, ok, 'settlement').have, 11);
  assert.equal(drawCommittee({ entries, contract: ok, role: 'settlement', committeeSeed: b32(0x77) }).length > 1, true);
});
