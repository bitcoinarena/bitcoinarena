// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #3680 (audit #1489 r1-play-1), RULED on #3704 (2026-11-25, (b)): from protocol 2026.0.34 a run is timed by the ROUND clock from its join
// tick - tick t is due at start_time + t x tick_ms; the start window and the door's walk-away open at start_time + join_tick x tick_ms, never at
// the moment a seat saw the stake held. A mark more than MARK_LAG_TICKS + the start deadline behind it is not receipted (free rounds too); a
// stake seen only after join_tick + start_deadline makes the entry ENTRY_VOID at that seat. Rounds below 34 keep today's rule (#2826/#3568).
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
import { MARK_LAG_TICKS } from '../src/round.js';
import { startDeadlineOf } from '../../arena-protocol/src/first-mark.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const START = 60500n;
const contract = (v, stake) => ({ ...(v ? { protocolVersion: v } : {}),
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: START, entryCloseMs: START + 45000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: stake, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [b32(4)],
});
const session = ed25519.utils.randomSecretKey();
const sign = (c) => joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), session));
const words = (n, from) => Array.from({ length: n }, (_, i) => [65536, from + i, 0, 0, 0]);

// lockMs: when the seat sees the stake held (null: a free round, no stake); then a first mark at tick 0 at firstMs, a mark at markTick at
// markMs (all after the start). Answers what each step did.
function play({ v, lockMs, firstMs, markTick, markMs }) {
  let now = 1234;
  const r = new Round(openStore(), () => now, { plugins: HOSTED });
  const stake = lockMs === null ? 0n : 100000n;
  const c = contract(v, stake);
  const rid = r.open(c);
  assumeAssigned(r, rid, c.nodes);
  const eid = r.enter({ roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: b32(7),
    stakeMsat: stake, feeMsat: v >= 27 ? entryFeeMsat(stake, 1000) : entryFeeMsat(stake), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
    stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) });
  r.entryCloseGraceMs = 15000n;
  if (lockMs !== null) { now = Number(START) + lockMs; r.putStakeSeen({ entryId: eid, paidMsat: 100000n, atMs: now }); }
  const out = { deadline: startDeadlineOf(c), void: null, first: null, mark: null, behind: null };
  const v0 = r.entryVoid(eid); out.void = v0 ? v0.evidenceKind : null;
  now = Number(START) + firstMs;
  const m0 = { roundId: rid, entryId: eid, tick: 0, stateHash: b32(0x01), inputChainHash: GENESIS, previousHash: NO_PREVIOUS };
  try { out.first = r.checkpoint(sign(m0)) instanceof Uint8Array; } catch (e) { out.first = e.message; }
  if (out.first !== true) return out;
  now = Number(START) + markMs;
  const b1 = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: words(markTick, 0), liquidations: [] };
  r.batch(encodeInputBatch(b1));
  const m = { roundId: rid, entryId: eid, tick: markTick, stateHash: b32(0x02), inputChainHash: batchId(b1), previousHash: checkpointId(m0) };
  out.behind = Number(ticksForMs(BigInt(now) - START).ticks) - markTick;
  try { out.mark = r.checkpoint(sign(m)) instanceof Uint8Array; } catch (e) { out.mark = e.message; }
  console.log(`  v${v ?? 1} ${JSON.stringify(out)}`);
  return out;
}

test('#3680 v34: a tick-0 entry whose stake is seen 44 s after the start is ENTRY_VOID and receipts nothing', () => {
  const o = play({ v: 34, lockMs: 44000, firstMs: 44500, markTick: 900, markMs: 64400 });
  assert.equal(o.void, 'late-stake');
  assert.notEqual(o.first, true, 'its first mark is not receipted');
});

test('#3680 v34: a stake seen in time - the run is counted on the round clock, a mark exactly at the bound is receipted, one past it is not', () => {
  const ok = play({ v: 34, lockMs: 5000, firstMs: 5500, markTick: 900, markMs: msAt(900) });
  assert.equal(ok.void, null);
  const bound = MARK_LAG_TICKS + ok.deadline;
  // the mark at tick 900 at round tick 900 + bound: exactly at the bound
  const at = play({ v: 34, lockMs: 5000, firstMs: 5500, markTick: 900, markMs: msAt(900 + bound) });
  assert.equal(at.behind, bound); assert.equal(at.mark, true, `a mark ${bound} ticks behind the round is receipted`);
  const past = play({ v: 34, lockMs: 5000, firstMs: 5500, markTick: 900, markMs: msAt(900 + bound + 2) });
  assert.ok(past.behind > bound); assert.notEqual(past.mark, true, 'a mark past MARK_LAG_TICKS + the start deadline is not receipted');
});

test('#3680 v34: a free round keeps the same round-clock lag bound', () => {
  const probe = play({ v: 34, lockMs: null, firstMs: 500, markTick: 900, markMs: msAt(900) });
  const bound = MARK_LAG_TICKS + probe.deadline;
  const past = play({ v: 34, lockMs: null, firstMs: 500, markTick: 900, markMs: msAt(900 + bound + 2) });
  assert.notEqual(past.mark, true, 'a free run more than the bound behind the round is not receipted');
  const at = play({ v: 34, lockMs: null, firstMs: 500, markTick: 900, markMs: msAt(900 + bound) });
  assert.equal(at.mark, true);
});

test('#3680 an old-version round keeps today\'s rule: the 44 s lock is no Void, its first mark is receipted (#3568 clock)', () => {
  const o = play({ v: null, lockMs: 44000, firstMs: 44500, markTick: 900, markMs: 64400 });
  assert.equal(o.void, null);
  assert.equal(o.first, true);
});

// the first whole ms at which the round clock reads tick `t` (60 ticks a second: 50/3 ms a tick)
function msAt(t) { let ms = Math.floor((t * 50) / 3); while (Number(ticksForMs(BigInt(ms)).ticks) < t) ms++; return ms; }
