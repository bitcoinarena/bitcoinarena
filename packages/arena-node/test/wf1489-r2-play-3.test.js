// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SECTION 13B: THE PLAYER WHO SIGNED TWO WORLDS AT ONE TICK.
//
// "A player who publishes two different checkpoints for the same
// (round_id, player_pubkey, tick), or two chains that diverge at any tick,
// forfeits the entry... The two conflicting signed checkpoints are a complete,
// portable proof; no replay is needed. Nodes MUST publish such a proof when
// they hold one."
//
// The node already REFUSED the second mark and then threw it away, which
// destroyed the only thing that shows what the player did. It is kept now, and
// the proof is checkable by anyone holding the two records - no node asked, no
// transcript replayed, no committee needed. That is why this is the one part of
// the no-quorum rule a single node can hold up on its own.
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';

import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { serve } from '../src/server.js';
import {
  encodeCheckpoint, decodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned,
  splitSigned, provesEquivocation, SIGNED_CHECKPOINT_BYTES,
} from '../../arena-protocol/src/checkpoint.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { encodeInputBatch } from '../../arena-protocol/src/batch.js';
import {
  encodeCheckpointReceipt, decodeCheckpointReceipt, receiptId, joinSignedReceipt,
  splitSignedReceipt,
} from '../../arena-protocol/src/receipt.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { decodeEntryContract } from '../../arena-protocol/src/contracts.js';

// The node fee is 27A.7's 2% of the stake, and the door checks it now
// (M3.3 item 20) - so a fixture carries the RULE rather than a number.
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
// THE CORE'S OWN RUN LENGTH: `Round.open` refuses a contract naming another, and this fixture still said
// 9000, so every test here died in `played()` before a mark was ever offered (712bad8c, same fault).
import { BLOCK_TICKS as RUN_TICKS } from '../../nextblock/src/rules/gate.js';
import { HOSTED } from './plugins/hosted.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const sessionPubkey = ed25519.getPublicKey(session);
const verify = (s, m, k) => { try { return ed25519.verify(s, m, k); } catch { return false; } };

const contract = (nodes) => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
  stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: RUN_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes,
});
const entryFor = (rid) => ({
  roundId: rid, playerPubkey: b32(5), sessionPubkey,
  stakeCommitment: b32(7), stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
});
const signedBy = (c, key = session) =>
  joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), key));

/** A round with one mark at tick 60, and the pieces to conflict with it. */
function played() {
  const round = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const c = contract([b32(4)]);
  const rid = round.open(c);
  const eid = round.enter(entryFor(rid));
  // THE INPUTS FIRST, as a client sends them: a node refuses a checkpoint at a
  // tick whose inputs it does not hold, and every mark here is at 240 or less.
  round.batch(encodeInputBatch({
    roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0,
    ticks: Array.from({ length: 400 }, (_, i) => [65536, i, 0, 0, 0]), liquidations: [],
  }));
  const mark = {
    roundId: rid, entryId: eid, tick: 60, stateHash: b32(0x11),
    inputChainHash: GENESIS, previousHash: NO_PREVIOUS,
  };
  round.checkpoint(signedBy(mark));
  return { round, rid, eid, mark };
}


// kanban #1489 round 2 (play path): A PLAYER'S REFUSED MARKS ARE KEPT WITHOUT BOUND. Every signed mark that does not
// follow the head (or goes back in time) is kept in offered_marks as 13B evidence - one row per distinct mark id, no cap
// per entry, no age limit - plus an evidence_blocks row each. The player holds its own session key, so on a free round
// (stake 0, nothing to lose) one /play socket writes as many rows as it sends frames, at every seat of the round; and
// Round.equivocation() (GET /equivocation, the first-mark door's secondFirstMark, every close) reads them all back.
// Safe: the refused marks kept per entry are bounded - a fork needs one pair, not thousands.
test('#1489-r2-play-3: a player cannot grow offered_marks without bound with marks that follow nothing', () => {
  const { round, rid, eid } = played();
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const m = { roundId: rid, entryId: eid, tick: 61 + (i % 150), stateHash: b32(0x33), inputChainHash: GENESIS,
      previousHash: Uint8Array.from({ length: 32 }, (_, j) => (j < 4 ? (i >> (8 * j)) & 0xff : 0x77)) };
    try { round.checkpoint(signedBy(m)); } catch { /* refused - and kept */ }
  }
  const rows = round.db.prepare('SELECT COUNT(*) n FROM offered_marks WHERE entry_id = ?').get(eid).n;
  const ev = round.db.prepare('SELECT COUNT(*) n FROM evidence_blocks WHERE entry_id = ?').get(eid).n;
  const t0 = process.hrtime.bigint();
  round.equivocation(rid, eid);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log('  FACTS:', JSON.stringify({ sent: N, offeredMarksKept: rows, evidenceRows: ev, equivocationReadMs: Math.round(ms) }));
  assert.ok(rows <= 256, `one player kept ${rows} refused marks for one entry - no bound`);
});
