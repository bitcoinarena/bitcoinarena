// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 v1-refute-3 skeptic 2 (reload path): the fix refuses an off-curve website key (frontendPk) at encode and at DECODE.
// A seat that took such an entry on the build before the fix still holds its bytes in `entries` after the upgrade and restart.
// Round.entriesOf decodes every stored row with no guard, so one such row makes every read of its round throw: the settlement's
// entriesOnRecord / attestedPlan, seatedEntriesOf, and the one-session-key check every NEW honest entry into that round passes.
// Before the fix the round at least took entries and failed only at the settlement tool; after it the round is still never settled
// (the poisoned entry is neither left out nor voided) and it is closed to honest joins as well. playersOf already skips such a row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { encodeEntryContract, encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { onCurveX } from '../../arena-protocol/src/guardian-payout.js';   // 2.0: onCurveX lives here (no point.js)
import { taggedHash } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const START = 1790600000000;
const ROUND = {
  networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1,
  gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(START) - 60000n, randomnessRule: 'bitcoin-block-hash', startTimeMs: BigInt(START), entryCloseMs: BigInt(START) + 60000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
  donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: 4920,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [b32(9)],
};
const R = new Uint8Array(roundId(ROUND));
const entryOf = (n, extra = {}) => ({
  roundId: R, playerPubkey: b32(n), sessionPubkey: b32(n + 1), stakeCommitment: b32(4), stakeMsat: 2000000n, feeMsat: 100000n, donationMsat: 0n,
  joinTick: 0, worldSecret: b32(5), vssSharesRef: b32(6), stakePoint: new Uint8Array(33).fill(7), feePreimage: b32(8),
  stakeLockOutpoint: { txid: b32(n + 2), outIdx: 0n }, feeLockOutpoint: { txid: b32(n + 2), outIdx: 1n }, claimKeyAttestationRef: b32(10), ...extra,
});
const SITE = (() => { const k = new Uint8Array(33).fill(0x5e); k[0] = 2; while (!onCurveX(k.subarray(1))) k[32]++; return k; })();

test('#1489 reload: one entry with an off-curve website key, stored by the build before the fix, does not stop every read of its round', () => {
  const round = new Round(openStore(), () => 1790600000000);
  round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(R, encodeRoundContract(ROUND), 0);
  const honest = encodeEntryContract(entryOf(0x20));
  // the bytes the pre-fix build encoded and stored: frontendPk written last (no items), 0x02 || 0xff*32 - what that build took at /entry
  const legacy = encodeEntryContract(entryOf(0x40, { frontendPk: SITE }));
  legacy.fill(0xff, legacy.length - 32);
  const put = (bytes, ms) => round.db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)')
    .run(taggedHash('test/entry', bytes), R, bytes, ms);
  put(honest, 1); put(legacy, 2);
  assert.equal(round.playersOf(R).joined, 1, 'playersOf skips the row it cannot read');
  let got = null; let threw = null;
  try { got = round.entriesOf(R); } catch (e) { threw = e.message; }
  if (threw) console.log(`  FACTS: entriesOf threw for the whole round after the upgrade: ${threw}`);
  assert.equal(threw, null, 'one stored pre-fix entry makes entriesOf throw: the round is never settled and takes no new entry');
  assert.equal(got.length, 1, 'the honest entry is the round\'s');
});
