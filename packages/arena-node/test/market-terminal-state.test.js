// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET ROUND'S TERMINAL STATE (kanban #1151): VOID flipped back to ATTESTED after the deadline. A market with no outcome by its
// deadline is VOID and its stakes go back at once by the return door; a valid attestation or source result withheld until then
// and handed in late turned it ATTESTED again, and once its window passed the settlement claimed the locks already returned.
// Now a round's state is one enum (attested.js MARKET_STATE) moved by one transition (marketTransition), persisted per round
// (store.js market_states, compare-and-set) before any door acts on it; FINAL and VOID never change; nothing is taken after the
// deadline; what comes after a terminal state is kept as evidence only. The state survives a restart, and a store made before
// the table reads its old rounds' evidence once.
// Harness: a real store (openStore + Round), on disk where a restart is measured, for a market on a game (as
// game-market-settle.test.js). The scenario itself, through the doors of two seats, is market-void-late.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { gameMarkets, marketVoidOf, marketStateOf } from '../src/game-market.js';
import { LockSettlement } from '../src/settlement.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { decodeManifest, gameIdOf, SOURCE_KIND, GAME_MARKET_REFUND } from '../../arena-protocol/src/manifest.js';
import { roundResultId, encodeRoundResult, frontOf } from '../../arena-protocol/src/round-result.js';
import { marketTransition, MARKET_STATE } from '../../arena-protocol/src/attested.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { GAME_MARKET_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { MANIFEST_V2_HEX as NEXTBLOCK_V2_HEX } from '../../nextblock/plugin/nextblock-v2.js';
import { testAttestedGame } from './plugins/sign.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const seats = [1, 2, 3, 4, 5, 6, 7].map((n) => { const sk = b32(n + 40); return { sk, pk: schnorr.getPublicKey(sk), url: `http://seat${n}.example` }; });
const verify = (sig, msg, pk) => { try { return schnorr.verify(sig, msg, pk); } catch { return false; } };

// A MARKET ON A TICK TOCK ROUND (feature 6), as game-market-settle.test.js has it: deadline entry close + 600 s + 1 h
const TICK_TOCK_ID = gameIdOf(decodeManifest(fromHex(NEXTBLOCK_V2_HEX)));
const MARKET = testAttestedGame({ name: 'tick-tock-fronts', outcomes: ['BULLS', 'BEARS'],
  marketTerms: { nodeFeeBps: 100, donationBps: 50, question: 'Which front wins this Tick Tock round?', resolveAfterCloseMs: 600000n,
    deadlineAfterResolveMs: 3600000n, sourceRule: 'the source round\'s RoundResult (§13), signed by 5 of its 7 seats' },
  gameSource: { sourceGameId: TICK_TOCK_ID, sourceKind: SOURCE_KIND.ROUND_RESULT, mapping: [0, 1, GAME_MARKET_REFUND] },
  requiredProtocolVersion: GAME_MARKET_VERSION });
const BASE = {
  networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: b32(0x67), simCoreHash: b32(1),
  startTimeMs: 0n, entryCloseMs: 0n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
  slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0),
  censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 0n, bondMinSats: 100000n,
  blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656, spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304,
  minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [],
};
const S = 1788200000000n;
const SOURCE = { ...BASE, protocolVersion: 2, gameId: TICK_TOCK_ID, startTimeMs: S, entryCloseMs: S + 45000n, nodes: seats.map((s) => s.pk) };
const SOURCE_ID = roundId(SOURCE);
const STAKE = 1_000_000n;
const M = { ...BASE, protocolVersion: GAME_MARKET_VERSION, gameId: MARKET.registration.gameId, simCoreHash: new Uint8Array(32),
  configHash: new Uint8Array(32), startTimeMs: S - 900000n, entryCloseMs: S - 60000n, sourceRoundId: SOURCE_ID, stakeMsat: STAKE };
const RID = roundId(M);
const AFTER_END = Number(S) + 200000;
const DEADLINE = Number(M.entryCloseMs) + 600000 + 3600000;
const WINDOW = 600000;
const BULLS = [8297000, 8298000], BEARS = [8298000, 8297000];
const signedBy = (openCents, closeCents, keys) => {
  const id = roundResultId({ roundId: SOURCE_ID, openCents, closeCents });
  return { openCents, closeCents, sigs: keys.map((s) => ({ key: toHex(s.pk), signature: toHex(schnorr.sign(id, s.sk)) })) };
};
const drawFor = () => (id, role) => (role === 'settlement' && toHex(id) === toHex(SOURCE_ID)
  ? { ok: true, committee: seats.map((s) => ({ pubkey: s.pk, advert: { endpoint: s.url.replace('http:', 'ws:') } })) } : { ok: false, why: 'not drawn' });

function seatStore(path = ':memory:', at = AFTER_END) {
  const clock = { ms: at };
  const round = new Round(openStore(path), () => clock.ms, { plugins: [MARKET.registration] });
  for (const c of [SOURCE, M]) round.db.prepare('INSERT OR IGNORE INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(roundId(c), encodeRoundContract(c), 1);
  return { round, clock, markets: gameMarkets({ round, plugins: round.plugins, committeeFor: drawFor(), verify, now: () => clock.ms }) };
}
// FOUR PICKS (two each side) whose locks the settlement would claim; the store's own settlement rows (none) under it
const PICKS = [[0, 1n], [1, 2n], [0, 3n], [1, 2n]];
function withEntries(round) {
  const entries = PICKS.map(([pick, units], i) => ({ entryId: b32(0x30 + i), entry: { roundId: RID, playerPubkey: schnorr.getPublicKey(b32(0x70 + i)), stakeMsat: units * STAKE, feeMsat: 0n, donationMsat: 0n, pick, feePreimage: new Uint8Array(32) } }));
  const CLAIM = new Uint8Array(33).fill(2);
  const view = Object.assign(Object.create(round), {
    entriesOf: () => entries,
    stakeSeen: () => ({ paidMsat: STAKE, seenMs: 1 }),
    stakeLock: (eid) => { const e = entries.find((x) => toHex(x.entryId) === toHex(eid)); return { outpoint: `${toHex(b32(0x50 + eid[0] - 0x30))}:0`,
      fields: lockFieldsToJson({ paymentImage: { kind: 'hash', bytes: b32(9) }, amountMsat: e.entry.stakeMsat, claimPk: CLAIM, refundPk: refundKeyOf(e.entry.playerPubkey), expiration: 1000 }) }; },
    feeLock: () => null,
    lockSettlement: () => null,
    fedLockSettlementsOf: () => [],
  });
  const settlement = new LockSettlement(view, { dkg: { signerNodeFor: () => ({ ok: true, pool: { groupPublicKey: CLAIM } }) },
    port: { settle: async () => ({}), fees: async () => ({ ppm: 0n, baseMsat: 0n }) } });
  return { view, settlement };
}
const stateOf = (round, nowMs) => marketStateOf(round, RID, { contract: M, manifest: MARKET.registration.manifest, nowMs });
// A SOURCE RESULT AS A PRE-#1151 SEAT HELD IT LATE: written straight into game_outcomes at `receivedMs`
const heldLate = (round, [o, c], outcome, receivedMs) => {
  const x = { roundId: SOURCE_ID, openCents: o, closeCents: c, front: frontOf(o, c) };
  round.putGameOutcome({ roundId: RID, resultId: roundResultId(x), sourceRoundId: SOURCE_ID, outcome, result: encodeRoundResult(x), sigs: [], source: encodeRoundContract(SOURCE), observedMs: AFTER_END, receivedMs });
};

test('#1151 a terminal state never changes: a late row (as a pre-fix seat held it) is evidence only; a contradiction or a refund after FINAL changes nothing', async () => {
  // VOID, THEN A ROW RECEIVED AFTER THE DEADLINE (an old store's): still VOID - the row counts as evidence only
  { const { round, clock } = seatStore();
    clock.ms = DEADLINE + 1;
    assert.equal(stateOf(round, clock.ms).state, MARKET_STATE.VOID);
    heldLate(round, BULLS, 0, DEADLINE + 5000);
    clock.ms = DEADLINE + 5000 + WINDOW + 1;
    const s = stateOf(round, clock.ms);
    assert.deepEqual([s.state, s.reason], [MARKET_STATE.VOID, 'deadline']);
    // THE STORE ITSELF REFUSES A WRITE TO A TERMINAL ROW
    assert.throws(() => round.db.prepare("UPDATE market_states SET state = 'FINAL' WHERE round_id = ?").run(Buffer.from(RID)), /a terminal market state is never changed/);
    assert.throws(() => round.db.prepare('DELETE FROM market_states WHERE round_id = ?').run(Buffer.from(RID)), /a terminal market state is never deleted/);
    assert.equal(round.casMarketState(RID, 'VOID', { state: 'FINAL', outcome: 0 }), false); }

  // FINAL, THEN A CONTRADICTION AND A REFUND: the settlement still plans the FINAL outcome, nothing is voided mid-settlement
  { const { round, clock, markets } = seatStore();
    const { view, settlement } = withEntries(round);
    assert.equal((await markets.hold(RID, signedBy(...BULLS, seats.slice(0, 5)))).held, true);
    assert.equal(stateOf(round, clock.ms).state, MARKET_STATE.ATTESTED);
    clock.ms += WINDOW + 1;
    const plan = await settlement.planOf(RID);
    assert.equal(plan.ok, true, plan.why);
    assert.equal(round.marketState(RID).state, MARKET_STATE.FINAL, 'the plan was made before FINAL was persisted');
    const bears = await markets.hold(RID, signedBy(...BEARS, seats.slice(2)));
    const flat = await markets.hold(RID, signedBy(8297000, 8297000, seats.slice(1, 6)));
    const s = stateOf(round, clock.ms);
    const replan = await settlement.planOf(RID);
    const door = marketVoidOf(view, RID, { contract: M, manifest: MARKET.registration.manifest, nowMs: clock.ms });
    console.log(`  #1151 AFTER FINAL: BEARS held=${bears.held} evidenceOnly=${!!bears.evidenceOnly}, FLAT held=${flat.held} evidenceOnly=${!!flat.evidenceOnly} | state ${s.state} outcome ${s.outcome}, plan ${replan.ok}, door ${door.voided ? 'open' : 'shut'}`);
    assert.deepEqual([bears.held, bears.evidenceOnly, flat.held, flat.evidenceOnly], [true, true, true, true]);
    assert.deepEqual([s.state, s.outcome], [MARKET_STATE.FINAL, 0]);
    assert.equal(replan.ok, true, 'a contradiction after FINAL stopped the settlement');
    assert.equal(door.voided, false, 'a contradiction after FINAL opened the return door'); }

  // INSIDE THE WINDOW A CONTRADICTION STILL VOIDS (ATTESTED is not terminal), and a VOID it reached stays
  { const { round, clock, markets } = seatStore();
    await markets.hold(RID, signedBy(...BULLS, seats.slice(0, 5)));
    clock.ms += 1000;
    await markets.hold(RID, signedBy(...BEARS, seats.slice(2)));
    const s = stateOf(round, clock.ms);
    assert.deepEqual([s.state, s.reason], [MARKET_STATE.VOID, 'dispute']);
    clock.ms += 10 * WINDOW;
    assert.equal(stateOf(round, clock.ms).state, MARKET_STATE.VOID); }
});

test('#1151 the one transition: every edge, and nothing out of a terminal state', () => {
  const h = (outcome, receivedMs) => ({ outcome, receivedMs, observedAtMs: 1n });
  const T = (prev, held, nowMs, o = {}) => marketTransition(prev, held, { deadlineMs: 10000, windowMs: 600, nowMs, ...o }).state;
  assert.equal(T(null, [], 9999), 'OPEN');
  assert.equal(T(null, [], 10000), 'VOID');                                  // OPEN -> VOID at the deadline
  assert.equal(T(null, [h(1, 9000)], 9100), 'ATTESTED');                     // OPEN -> ATTESTED
  assert.equal(T(null, [h(1, 9000)], 9600), 'FINAL');                        // ATTESTED -> FINAL after the window (even past the deadline)
  assert.equal(T(null, [h(1, 9000), h(2, 9500)], 9550), 'VOID');             // a contradiction inside the window
  assert.equal(T(null, [h(1, 9000), h(2, 9600)], 9700), 'FINAL');            // one at the window's end: evidence only
  assert.equal(T(null, [h(1, 10000)], 20000), 'VOID');                       // received at the deadline: never counts
  assert.equal(T(null, [h(1, 9000)], 9100, { voids: [{ receivedMs: 9050, why: 'FLAT' }] }), 'VOID');   // a refund inside the window
  assert.equal(T(null, [h(1, 9000)], 9700, { voids: [{ receivedMs: 9650, why: 'FLAT' }] }), 'FINAL');  // after it: evidence only
  assert.equal(T(null, [], 1, { voids: [{ receivedMs: 0, why: 'FLAT' }] }), 'VOID');                 // a game VOID at once
  assert.equal(T(null, [], 10 ** 12, { deadlineMs: null }), 'OPEN');         // no terms: no deadline
  for (const prev of [{ state: 'VOID', reason: 'deadline' }, { state: 'FINAL', outcome: 1 }])
    assert.equal(T(prev, [h(2, 1), h(1, 2)], 10 ** 12, { voids: [{ receivedMs: 0 }] }), prev.state, `${prev.state} changed`);
  const att = marketTransition(null, [h(1, 9000)], { deadlineMs: 10000, windowMs: 600, nowMs: 9100 });
  assert.equal(T(att, [h(1, 9000), h(2, 9200)], 9300), 'VOID');              // from a persisted ATTESTED
  assert.equal(T(att, [h(1, 9000)], 9600), 'FINAL');
});

test('#1151 a seat that restarts keeps the state, and a store made before the table reads its old rounds once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'h1151-'));
  try {
    const path = join(dir, 'seat.sqlite');
    // VOID AT THE DEADLINE, PERSISTED; THE SEAT STOPS
    { const { round, clock } = seatStore(path, DEADLINE + 1);
      assert.equal(stateOf(round, clock.ms).state, MARKET_STATE.VOID);
      round.db.close(); }
    // IT STARTS AGAIN ON A CLOCK SET BACK (inside the deadline): the stored VOID stands, and a result it now takes is evidence only
    { const { round, clock, markets } = seatStore(path, DEADLINE - 1000);
      assert.deepEqual(round.marketState(RID).state, MARKET_STATE.VOID, 'the state did not survive the restart');
      const got = await markets.hold(RID, signedBy(...BULLS, seats.slice(0, 5)));
      clock.ms += WINDOW + 1;
      const s = stateOf(round, clock.ms);
      console.log(`  #1151 RESTART: stored ${round.marketState(RID).state}; a result inside the clock's deadline held=${!!got.held} evidenceOnly=${!!got.evidenceOnly}; state ${s.state}`);
      assert.deepEqual([got.held, got.evidenceOnly, s.state], [true, true, MARKET_STATE.VOID]);
      round.db.close(); }

    // A STORE FROM BEFORE #1151: the old seat held a result after the deadline and nobody read a state - read once now: VOID
    { const old = seatStore(join(dir, 'old.sqlite'), DEADLINE + 5000);
      old.round.db.exec('DROP TRIGGER market_states_terminal_update; DROP TRIGGER market_states_terminal_delete; DROP TABLE market_states');
      heldLate(old.round, BULLS, 0, DEADLINE + 4000);
      old.round.db.close(); }
    { const { round, clock } = seatStore(join(dir, 'old.sqlite'), DEADLINE + 5000 + WINDOW);
      const s = stateOf(round, clock.ms);
      assert.deepEqual([s.state, s.reason, round.marketState(RID).state], [MARKET_STATE.VOID, 'deadline', MARKET_STATE.VOID]);
      round.db.close(); }
    // ...AND ONE WHOSE SETTLEMENT WENT IN on that late result: FINAL on it, so the return door never hands back a spent lock
    { const old = seatStore(join(dir, 'settled.sqlite'), DEADLINE + 5000);
      old.round.db.exec('DROP TRIGGER market_states_terminal_update; DROP TRIGGER market_states_terminal_delete; DROP TABLE market_states');
      heldLate(old.round, BULLS, 0, DEADLINE + 4000);
      old.round.db.close(); }
    { const { round, clock } = seatStore(join(dir, 'settled.sqlite'), DEADLINE + 5000 + WINDOW);
      const view = Object.assign(Object.create(round), { lockSettlement: () => ({ state: 'ACCEPTED' }), fedLockSettlementsOf: () => [] });
      const s = stateOf(view, clock.ms);
      console.log(`  #1151 MIGRATION: unsettled old round -> VOID (deadline); settled old round -> ${s.state} outcome ${s.outcome} (${s.reason})`);
      assert.deepEqual([s.state, s.outcome, s.reason], [MARKET_STATE.FINAL, 0, 'settled']);
      assert.equal(marketVoidOf(view, RID, { contract: M, manifest: MARKET.registration.manifest, nowMs: clock.ms }).voided, false);
      round.db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

