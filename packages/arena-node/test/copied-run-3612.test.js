// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// §13D COPIED RUN (kanban #3612, spec ruling #3615 2026-11-24; feedback #445). In a shared-world round a player who joins later
// and replays an earlier joiner's inputs (relative to each join tick) drives the same run to the same score. Ruled: entry B (later
// joinTick) forfeits - FORFEIT, score 0 - when its change list ((tick - joinTick, word) for every tick whose word differs from the
// tick before; #3663) shares a common prefix of at least 32 changes with entry A's; equal joinTick: neither; the earlier entry is
// never touched; shared-world configs at protocol 34 or later only; bound into the Entry Contract. Two honest players holding
// throttle from their join are 1 change each and never match.
//
// A two-entry round on a real seat store (Round: the door) and the seat's Verifier (copiedRunOf: the one function the close, the
// re-run and the objection door ask), the canonical transcripts handed over as the store would (§13C). Before the rule: no
// `copiedRunOf`, the copy closed as its own run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Verifier } from '../src/verify.js';
import { HOSTED, NEXTBLOCK_GAME_ID } from './plugins/hosted.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, TRUCK_SHARED_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { MIN_ENTRY_WINDOW_MS, COPIED_RUN_VERSION, DISJOINT_RULES_VERSION } from '../../arena-protocol/src/constants.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { entryId, encodeEntryContract, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { encodeTranscript, transcriptHash, GENESIS } from '../../arena-protocol/src/transcript.js';
import { COPIED_RUN_RULE_HASH, COPIED_RUN_MIN_CHANGES } from '../../arena-protocol/src/copied-run.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1788700000000;
const contractOf = ({ shared = true, version = COPIED_RUN_VERSION } = {}) => ({
  networkId: NETWORK_ID_REGTEST, configHash: shared ? TRUCK_SHARED_CONFIG_HASH : TRUCK_V3_CONFIG_HASH, censusConfirmations: 6,
  gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  committeeTimeMs: BigInt(NOW), randomnessRule: 'bitcoin-block-hash',
  startTimeMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS, entryCloseMs: BigInt(NOW) + MIN_ENTRY_WINDOW_MS + 200000n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS,
  exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4,
  nodes: [b32(8), b32(9)], protocolVersion: version,
});
const entryOf = (rid, n, joinTick, { rule = true } = {}) => ({
  roundId: rid, playerPubkey: b32(0x40 + n), sessionPubkey: b32(0x50 + n), stakeCommitment: b32(0x60 + n),
  stakeMsat: 0n, feeMsat: entryFeeMsat(0n), donationMsat: 0n, joinTick,
  worldSecret: new Uint8Array(32), vssSharesRef: new Uint8Array(32), stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32),
  stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32),
  ...(rule ? { copiedRunRule: COPIED_RUN_RULE_HASH } : {}),
});

// A's run: 5 idle ticks, then a new word every tick (throttle 1000 + t), a release to idle every 10th - so every tick from 5 on
// is one change (a release is a change too) and A's first k changes end at relative tick 5 + k
const IDLE = [0, 0, 0, 0, 0];
const A_ROWS = Array.from({ length: 200 }, (_, t) => (t < 5 || t % 10 === 0 ? IDLE : [1000 + t, 0, 0, 0, 0]));
/** The relative tick after A's first `k` changes. */
const afterChanges = (k) => 5 + k;
const deviate = (rows, from) => rows.map((r, t) => (t < from ? r : [-(2000 + t), 7, 0, 0, 0]));

/** A seat with a round and its entries, each entry's canonical transcript its rows from its join tick. */
function seat(contract, runs) {
  const round = new Round(openStore(':memory:'), () => NOW + 1000, { plugins: HOSTED });
  const rid = round.open(contract);
  const held = new Map();
  const ids = runs.map(({ joinTick, rows, n, rule }) => {
    const e = entryOf(rid, n, joinTick, { rule });
    round.enter(e);
    const eid = entryId(e);
    const t = { roundId: rid, entryId: eid, marks: [],
      batches: [{ roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: joinTick, ticks: rows, liquidations: [], loads: [] }] };
    held.set(toHex(eid), { roundId: rid, entryId: eid, bytes: encodeTranscript(t), hash: transcriptHash(t) });
    return eid;
  });
  round.canonicalTranscript = (r, eid) => { const t = held.get(toHex(eid)); if (!t) throw new Error('no checkpoints for that entry'); return t; };
  const verifier = new Verifier(round, { plugins: HOSTED });
  return { rid, ids, round, verifier, copyOf: (eid) => verifier.copiedRunOf(rid, eid) };
}
const twoEntry = (bRows, { bJoin = 50, contract = contractOf() } = {}) =>
  seat(contract, [{ n: 1, joinTick: 0, rows: A_ROWS }, { n: 2, joinTick: bJoin, rows: bRows }]);

test('#3612 (a) an exact copy by a later joiner: B forfeits by §13D, naming A; A is never touched', () => {
  const s = twoEntry(A_ROWS);
  const copy = s.copyOf(s.ids[1]);
  assert.ok(copy, 'the copy was not found');
  assert.equal(copy.of, toHex(s.ids[0]));
  assert.ok(copy.changes >= COPIED_RUN_MIN_CHANGES);
  assert.equal(s.copyOf(s.ids[0]), null, 'the earlier entry was touched');
});

test('#3612 (b) a prefix copy (B stops early after 40 changes) and a copy that plays on after A ends: both forfeit', () => {
  const early = twoEntry(A_ROWS.slice(0, afterChanges(40)));
  assert.equal(early.copyOf(early.ids[1])?.changes, 40);
  const longer = twoEntry([...A_ROWS, ...Array.from({ length: 50 }, (_, t) => [9 + t, 1, 0, 0, 0])]);
  assert.ok(longer.copyOf(longer.ids[1]), 'a copy that plays on after A was not found');
});

test('#3612 (c) copy-then-deviate: 32 shared changes forfeit, 31 do not', () => {
  const at32 = twoEntry(deviate(A_ROWS, afterChanges(32)));
  assert.equal(at32.copyOf(at32.ids[1])?.changes, 32);
  const at31 = twoEntry(deviate(A_ROWS, afterChanges(31)));
  assert.equal(at31.copyOf(at31.ids[1]), null, 'under 32 changes was decided');
});

test('#3612 (d) idle stretches add no change; a first change at another tick breaks the match; two idle runs are never hit', () => {
  // B presses at relative tick 0, A first at 5: their first changes differ
  const s = twoEntry([[1, 0, 0, 0, 0], ...A_ROWS.slice(1)]);
  assert.equal(s.copyOf(s.ids[1]), null, 'a tick non-idle in one run only did not break the match');
  const idleRuns = seat(contractOf(), [{ n: 1, joinTick: 0, rows: Array(300).fill(IDLE) }, { n: 2, joinTick: 50, rows: Array(300).fill(IDLE) }]);
  assert.equal(idleRuns.copyOf(idleRuns.ids[1]), null, 'two idle runs were hit');
});

test('#3612 (h) two honest players holding throttle from their join for 300 ticks (1 change each) do NOT match; with a release at the same tick, 2 changes, still not', () => {
  const HOLD = [65536, 0, 0, 0, 0];
  const held = seat(contractOf(), [{ n: 1, joinTick: 0, rows: Array(300).fill(HOLD) }, { n: 2, joinTick: 50, rows: Array(300).fill(HOLD) }]);
  assert.equal(held.copyOf(held.ids[1]), null, 'a held throttle was ruled a copy');
  const released = (rows) => rows.map((r, t) => (t >= 120 ? IDLE : r));
  const two = seat(contractOf(), [{ n: 1, joinTick: 0, rows: released(Array(300).fill(HOLD)) }, { n: 2, joinTick: 50, rows: released(Array(300).fill(HOLD)) }]);
  assert.equal(two.copyOf(two.ids[1]), null);
  // and a real copy of a driven run (steering every few ticks) still forfeits
  const driven = Array.from({ length: 400 }, (_, t) => [65536, ((t / 4) | 0) % 3 === 0 ? 0 : (((t / 4) | 0) % 2 ? 20000 : -20000), 0, 0, 0]);
  const copied = seat(contractOf(), [{ n: 1, joinTick: 0, rows: driven }, { n: 2, joinTick: 50, rows: driven }]);
  assert.ok(copied.copyOf(copied.ids[1])?.changes >= COPIED_RUN_MIN_CHANGES, 'a copy of a driven run was not found');
});

test('#3612 (e) equal joinTick: neither forfeits', () => {
  const s = twoEntry(A_ROWS, { bJoin: 0 });
  assert.equal(s.copyOf(s.ids[0]), null);
  assert.equal(s.copyOf(s.ids[1]), null);
});

test('#3612 (f) a per-player world (protocol 34) and a shared world below protocol 34 are untouched: an exact copy closes as its run', () => {
  const per = seat(contractOf({ shared: false }), [{ n: 1, joinTick: 0, rows: A_ROWS, rule: false }, { n: 2, joinTick: 50, rows: A_ROWS, rule: false }]);
  assert.equal(per.copyOf(per.ids[1]), null, 'a per-player world was ruled');
  const old = seat(contractOf({ version: DISJOINT_RULES_VERSION }), [{ n: 1, joinTick: 0, rows: A_ROWS, rule: false }, { n: 2, joinTick: 50, rows: A_ROWS, rule: false }]);
  assert.equal(old.copyOf(old.ids[1]), null, 'a round of protocol 33 was ruled');
});

test('#3612 (g) the rule is bound into the Entry Contract: a shared-world entry at 34 must name it, any other entry must not; old entries keep their bytes', () => {
  const round = new Round(openStore(':memory:'), () => NOW + 1000, { plugins: HOSTED });
  const rid = round.open(contractOf());
  assert.throws(() => round.enter(entryOf(rid, 3, 0, { rule: false })), /names the copied-run rule \(§13D\) by its hash, and that one names none/);
  assert.throws(() => round.enter({ ...entryOf(rid, 3, 0), copiedRunRule: b32(1) }), /names another/);
  assert.ok(round.enter(entryOf(rid, 3, 0)));
  const old = new Round(openStore(':memory:'), () => NOW + 1000, { plugins: HOSTED });
  const ridOld = old.open(contractOf({ version: DISJOINT_RULES_VERSION }));
  assert.throws(() => old.enter(entryOf(ridOld, 4, 0)), /its round does not run it/);
  assert.ok(old.enter(entryOf(ridOld, 4, 0, { rule: false })));
  // the field round-trips, and an entry without it is byte for byte what it was (no marker written)
  const withRule = entryOf(rid, 5, 0), without = entryOf(rid, 5, 0, { rule: false });
  assert.equal(toHex(decodeEntryContract(encodeEntryContract(withRule)).copiedRunRule), toHex(COPIED_RUN_RULE_HASH));
  assert.equal(encodeEntryContract(withRule).length, encodeEntryContract(without).length + 33);
  assert.equal(decodeEntryContract(encodeEntryContract(without)).copiedRunRule, undefined);
  assert.equal(decodeEntryContract(encodeEntryContract({ ...withRule, bot: true })).bot, true);
});
