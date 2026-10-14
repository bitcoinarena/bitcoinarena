// PLAYER-NODE SEPARATION AT THE SEAT (§5A.13, kanban #309): a signer node whose operator plays the round takes no part in its
// settlement, and a committee its conflicted nodes leave under 5 of 7 settles nothing (ENTRY_VOID: each lock returns at expiry).
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
const conflicts = (bad, selfOp = null) => () => ({ self: selfOp,
  serving: servingAfterConflicts({ committee: COMMITTEE, conflicted: new Set(bad.map((i) => toHex(COMMITTEE[i]))) }) });

test('a conflicted signer node plans no settlement; 3 conflicted of 7 void the round; 2 of 7 settle on', async () => {
  const self = await seat(conflicts([0], 'ee'.repeat(32))).planOf(RID);
  assert.equal(self.ok, false); assert.match(self.why, /this signer node is conflicted, its operator eeeeeeee.*no part in the settlement/);
  const three = await seat(conflicts([0, 1, 2])).planOf(RID);
  assert.equal(three.ok, false); assert.match(three.why, /4 serve, under the threshold of 5: the round's entries are ENTRY_VOID/);
  const two = await seat(conflicts([0, 1])).planOf(RID);
  assert.doesNotMatch(String(two.why), /conflicted|ENTRY_VOID/, 'past the gate: what refuses it now is the round\'s own business');
  const none = await seat(null).planOf(RID);
  assert.doesNotMatch(String(none.why), /conflicted|ENTRY_VOID/);
  console.log('  self:', self.why, '\n  three:', three.why, '\n  two:', two.why);
});
