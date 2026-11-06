// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// RE-SENDS AND RETRIES BY STATE, NOT BY TIMERS AND TEXT (kanban #1186, the 2026-11-06 state-machine audit):
//  - a re-send the guardians took, then a crash before it was recorded: FUNDING carried no txid, and the next pass submitted it again;
//  - `expired` read "not stored" as spent: a contract no landed transaction made never expired and was never re-sent;
//  - retryUnsettled asked only rounds closed in the last 24 h, its tries in memory: a round past the window was never asked again;
//  - the settle sweep's long wait was decided by a regex over the English refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WinningsSend } from '../src/winnings-send.js';
import { SEND, sendMove } from '../src/send-state.js';
import { LockSettlement } from '../src/settlement.js';
import { openStore, CLOSED } from '../src/store.js';
import { Round } from '../src/round.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const RID = b32(0x86);
const ENTRY = b32(0x16);
const B = 'b0'.repeat(32), R = 'c1'.repeat(32);
const H0 = '0a'.repeat(32), H1 = '1b'.repeat(32);

/** A store of one winner's sends as round.js keeps them: markSend a compare-and-set through send-state.js. */
function sends(rows, settled = { state: 'ACCEPTED', txid: B }) {
  return {
    now: () => 1,
    lateEntryId: null,
    sendAttemptsOf: () => rows.map((r) => ({ ...r })),
    sendPlansOf: () => { const m = new Map(); for (const r of rows) m.set(toHex(r.entryId), r); return [...m.values()].map((r) => ({ ...r })); },
    markSend({ entryId, attempt, state, why, txid = null, outIdx = null, preimage = null }) {
      const r = rows.find((x) => toHex(x.entryId) === toHex(entryId) && x.attempt === attempt);
      if (!r || !sendMove(r.state, state).ok) return false;
      Object.assign(r, { state, why, txid: txid ?? r.txid, outIdx: outIdx ?? r.outIdx, preimage: preimage ?? r.preimage });
      return true;
    },
    putWinnings() {},
    lockSettlement: () => settled,
  };
}
const row = (attempt, state, extra = {}) => ({ entryId: ENTRY, roundId: RID, attempt, state, address: 'w@x', invoice: `inv${attempt}`, paymentHash: attempt ? H1 : H0,
  invoiceMsat: 1000n, payoutMsat: 1000n, owedMsat: 1000n, gatewayUrl: `http://gw${attempt}`, gatewayPk: '03' + 'dd'.repeat(32), expiration: 900n, txid: null, outIdx: null, preimage: null, why: '', ...extra });
const BUILT = { txid: B, claimPk: Uint8Array.from([2, ...b32(5)]), named: false, plan: { payouts: [{ sent: { paymentHash: H0 } }] } };

function sender(rows, stored, { crashOnSubmit = false } = {}) {
  const submitted = [];
  const port = {
    status: async (o) => { const k = `${toHex(o.txid)}:${o.outIdx}`; return { blockCount: 1000, stored: stored.has(k) ? { contractId: 'c', blocksLeft: stored.get(k) } : null }; },
    settle: async ({ signature }) => {
      if (!signature) return { txid: R, message: '00'.repeat(32) };
      submitted.push(R);
      // THE GUARDIANS TAKE IT: attempt 0's expired contract refunded into attempt 1's
      stored.delete(`${B}:0`); stored.set(`${R}:0`, 100);
      if (crashOnSubmit) throw new Error('the seat died before it recorded the answer');
      return { txid: R, message: '00'.repeat(32), accepted: true };
    },
    send: async () => ({ sent: false, why: 'the gateway is down' }),
  };
  const ws = new WinningsSend({ round: sends(rows), port, curve: {}, random: () => b32(1), peersFor: () => [], fetcher: async () => ({ ok: true }) });
  ws.sign = async () => ({ ok: true, signature: new Uint8Array(64).fill(9) });
  ws.offerResend = async () => [];
  return { ws, submitted };
}

test('a re-send taken by the guardians, then a crash before it was recorded: the next pass asks the federation and submits nothing again', async () => {
  const rows = [row(0, SEND.SENDING, { txid: B, outIdx: 0 }), row(1, SEND.PLANNED)];
  const stored = new Map([[`${B}:0`, 0]]);   // attempt 0's contract, expired unpaid
  const crash = sender(rows, stored, { crashOnSubmit: true });
  await assert.rejects(crash.ws.sendAll(RID, BUILT), /died/);
  assert.equal(rows[1].state, SEND.FUNDING);
  assert.equal(rows[1].txid, R, 'FUNDING carries the re-send\'s txid before the guardians are handed it');
  // the seat comes back: the same rows, the same federation
  const again = sender(rows, stored);
  await again.ws.sendAll(RID, BUILT);
  assert.equal(again.submitted.length, 0, 'the old source submitted the re-send a second time');
  assert.equal(rows[1].state, SEND.SENDING);
});

test('a FUNDING re-send whose input is still held never went in: it is submitted again', async () => {
  const rows = [row(0, SEND.SENDING, { txid: B, outIdx: 0 }), row(1, SEND.FUNDING, { txid: R, outIdx: 0 })];
  const stored = new Map([[`${B}:0`, 0]]);
  const { ws, submitted } = sender(rows, stored);
  await ws.sendAll(RID, BUILT);
  assert.equal(submitted.length, 1);
  assert.equal(rows[1].state, SEND.SENDING);
});

test('"not stored" is GONE only for a contract that was made; one no landed transaction made is NEVER, never "spent"', async () => {
  // attempt 0 of a settlement not ACCEPTED here: its contract was never made
  const notLanded = new WinningsSend({ round: sends([row(0, SEND.SENDING)], { state: 'SUBMITTING', txid: B }), port: { status: async () => ({ blockCount: 1000, stored: null }) },
    curve: {}, random: () => b32(1), peersFor: () => [], fetcher: async () => ({}) });
  const ex = await notLanded.expired(RID, row(0, SEND.SENDING), BUILT);
  assert.notEqual(ex.spent, true, `the old source read it as spent: ${ex.why}`);
  assert.equal(ex.never, true);
  // the same contract with its settlement ACCEPTED here: it was made, and is gone (claimed or refunded)
  const landed = new WinningsSend({ round: sends([row(0, SEND.SENDING)]), port: { status: async () => ({ blockCount: 1000, stored: null }) },
    curve: {}, random: () => b32(1), peersFor: () => [], fetcher: async () => ({}) });
  assert.equal((await landed.expired(RID, row(0, SEND.SENDING), BUILT)).spent, true);
  // a re-send whose input is still held: NEVER
  const rows = [row(0, SEND.SENDING, { txid: B, outIdx: 0 }), row(1, SEND.SENDING, { txid: R, outIdx: 0 })];
  const { ws } = sender(rows, new Map([[`${B}:0`, 0]]));
  assert.equal((await ws.contractFate(RID, rows[1], BUILT)).fate, 'NEVER');
});

const CONTRACT = encodeRoundContract({ networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 2 });
const NOW = 2_000_000_000_000, DAY = 86400000;

function unsettledSeat(db, tipAt) {
  const round = new Round(db);
  round.signerNodes = () => [round.pubkey];
  const asked = [];
  const ls = new LockSettlement(round, { now: () => NOW, port: {}, turnClock: { tip: async () => tipAt.tip, beaconHeight: async () => 0 } });
  ls.turn = async () => ({ mine: true, place: 0 });
  ls.settle = async (r) => { asked.push(toHex(r)); return { ok: false, why: 'peers refused' }; };
  return { ls, asked, round };
}

test('a closed lock round older than a day is still asked; its tries survive a restart; past its locks\' expiry it is EXPIRED and never asked again', async () => {
  const db = openStore(':memory:');
  db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms, closed_ms) VALUES (?, ?, ?, ?, ?)').run(RID, CONTRACT, CLOSED, NOW - 3 * DAY - 1, NOW - 3 * DAY);
  db.prepare('INSERT INTO stake_locks (entry_id, round_id, outpoint, fields, contract_id, verified_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ENTRY, RID, `${B}:1`, JSON.stringify({ expiration: 1000 }), 'c', NOW - 3 * DAY);
  const tip = { tip: 900 };
  const a = unsettledSeat(db, tip);
  await a.ls.retryUnsettled();
  assert.deepEqual(a.asked, [toHex(RID)], 'the old source asked only the last 24 h: this round, closed 3 days ago, was never asked again');
  assert.deepEqual([a.round.settleRetry(RID).state, a.round.settleRetry(RID).tries], ['WAITING', 1]);
  // a restart: the tries are on disk, not in memory
  const b = unsettledSeat(db, tip);
  await b.ls.retryUnsettled();
  assert.equal(b.round.settleRetry(RID).tries, 2);
  // every lock past its expiration: EXPIRED, final, and the store leaves it out of the next pass
  tip.tip = 1006;
  const c = unsettledSeat(db, tip);
  const said = await c.ls.retryUnsettled();
  assert.deepEqual(c.asked, []);
  assert.equal(c.round.settleRetry(RID).state, 'EXPIRED');
  assert.deepEqual(said.map((x) => x.state), ['EXPIRED']);
  assert.deepEqual(c.round.closedLockRoundsUnsettled(0, NOW), []);
});

test('a retry row moves by one transition function: SETTLED and EXPIRED are final; waits by height', async () => {
  const { retryStep, retryBlocks, RETRY } = await import('../src/settle-retry.js');
  assert.equal(retryStep(null, RETRY.WAITING).ok, true);
  assert.equal(retryStep(RETRY.WAITING, RETRY.SETTLED).ok, true);
  for (const to of Object.values(RETRY)) { assert.equal(retryStep(RETRY.SETTLED, to).ok, false); assert.equal(retryStep(RETRY.EXPIRED, to).ok, false); }
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(retryBlocks), [0, 0, 1, 2, 4, 8, 12]);
});

test('the sweep\'s long wait is decided by the refusal\'s code: a round that joined nobody says NO_ASKER, whatever its text', async () => {
  const { refusedForGood, REFUSAL } = await import('../src/settle-backoff.js');
  const round = new Round(openStore(':memory:'));
  round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: CONTRACT } : null);
  const ls = new LockSettlement(round, { port: {} });
  const t = await ls.turn(RID);
  assert.equal(t.code, REFUSAL.NO_ASKER, `the old source said only "${t.why}"`);
  assert.equal(refusedForGood({ ok: false, code: t.code, why: 'reworded' }), true);
});
