// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// audit play a7-1-1 (gap in #2826): the lag bound of round.checkpoint is measured from the run's first mark's ARRIVAL at the seat,
// a time the player chooses inside the 900-tick start deadline. Safe behaviour: a staked run's mark more than MARK_LAG_TICKS behind
// the round's clock, counted from when the run could start (stake held), is not receipted - whenever the first mark was sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { assumeAssigned } from './assignment.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { encodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned } from '../../arena-protocol/src/checkpoint.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { ticksForMs } from '../../arena-protocol/src/tick.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const START = 60500n;
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: START, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [b32(4)],
});
const session = ed25519.utils.randomSecretKey();
const sign = (c) => joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), session));


// A STAKED RUN WHOSE CLIENT HOLDS ITS FIRST MARK BACK: the stake is held at the round's start (the window opens there), the
// client plays nothing it sends for `holdMs` - inside the 900-tick start deadline, so it is no late start and no walk-away - and
// then plays from tick 0 at the honest pace less MARK_LAG_TICKS. #2826 starts the seat's lag clock at the first mark's ARRIVAL,
// which the client chose, so the hold-back is added to the 600 ticks the fix allows.
function play(holdMs, laterMs, markTick) {
  let now = 1234;
  const r = new Round(openStore(), () => now, { plugins: HOSTED });
  const c = contract();
  const rid = r.open(c);
  assumeAssigned(r, rid, c.nodes);
  const eid = r.enter({ roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: b32(7),
    stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
    stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) });
  // THE STAKE HELD AT THE ROUND'S START: the start window (and the door's walk-away clock) open here
  now = Number(START);
  r.putStakeSeen({ entryId: eid, paidMsat: 100000n, atMs: Number(START) });
  const words = (n, from) => Array.from({ length: n }, (_, i) => [65536, from + i, 0, 0, 0]);
  // THE FIRST MARK AT TICK 0, SENT `holdMs` AFTER THE STAKE WAS HELD (still inside the 900-tick = 15 s start deadline)
  now = Number(START) + holdMs;
  const m0 = { roundId: rid, entryId: eid, tick: 0, stateHash: b32(0x01), inputChainHash: GENESIS, previousHash: NO_PREVIOUS };
  const first = r.checkpoint(sign(m0));
  assert.ok(first instanceof Uint8Array, 'the on-time first mark is receipted');
  // `laterMs` after that, the inputs 0 .. markTick-1 and the mark at markTick
  now = Number(START) + holdMs + laterMs;
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: words(markTick, 0), liquidations: [] };
  r.batch(encodeInputBatch(b1));
  const m = { roundId: rid, entryId: eid, tick: markTick, stateHash: b32(0x02), inputChainHash: batchId(b1), previousHash: checkpointId(m0) };
  let receipt = null; let why = null;
  try { receipt = r.checkpoint(sign(m)); } catch (e) { why = e.message; }
  const roundTick = Number(ticksForMs(BigInt(now) - START).ticks);
  console.log(`round tick ${roundTick}; mark at ${markTick} is ${roundTick - markTick} ticks behind the round (stake held at its start); receipted: ${receipt instanceof Uint8Array}${why ? ` (${why})` : ''}`);
  return { receipt, behind: roundTick - markTick };
}

test('a first mark held back inside the start deadline does not widen the #2826 lag bound (mark ~1470 ticks behind the round is refused)', () => {
  // first mark 14.5 s after the stake was held, the mark at tick 600 19.9 s after that: 34.4 s of round, 2064 round ticks
  const { receipt, behind } = play(14500, 19900, 600);
  assert.ok(behind > 1400);
  assert.ok(!(receipt instanceof Uint8Array), `the mark at tick 600 was receipted ${behind} ticks behind the round's clock (MARK_LAG_TICKS is 600)`);
});

test('control: an honest client that starts at once and is a few seconds late is still receipted', () => {
  const { receipt } = play(500, 19900, 900);
  assert.ok(receipt instanceof Uint8Array);
});
