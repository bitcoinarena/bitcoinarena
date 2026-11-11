// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET'S RETURN DOOR COUNTS ONLY THE ENTRIES ITS SETTLEMENT COUNTS (kanban #1436, state machine audit 8 R2): forfeit.js #marketRefund read
// every entry of the round - also ones whose stake this seat never saw, and orders in a round that ended a pool - while the settlement
// (settlement.js #attestedPlan) and the stake-share door (stake-secret.js) count only stake-seen plain picks. One lockless entry naming the
// outcome, posted at no cost, made the door say "not refunded" while the settlement said "nobody picked the outcome: nothing is claimed" and
// never turned ACCEPTED: every stake and fee lock waited for its expiry. A scalar market had the same flaw (all LONG plus one lockless SHORT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32 as b32w, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { attestorSign, attestorSignValue, testAttestedGame } from './plugins/sign.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { MARKET } from './plugins/market/index.js';
import { VALUE_HELD_OUTCOME } from '../src/game-market.js';
import { LockSettlement } from '../src/settlement.js';
import { Forfeit } from '../src/forfeit.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { encodeValueAttestation, valueAttestationBodyId } from '../../arena-protocol/src/scalar.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { SCALAR_VERSION } from '../../arena-protocol/src/constants.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const STAKE = 1_000_000n;

// ---- a plain market, end to end on two seats (the audit's probe) ----
const ROUND = { gameId: MARKET.registration.gameId, simCoreHash: b32w(0), configHash: b32w(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
const [A0, , A2] = MARKET.attestors;
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32w(0x40 + n), worldSecret: b32w(0) });
const signedBy = (body, by) => ({ ...body, signatures: by.map((a) => attestorSign(a, body)) });
const post = async (d, rid, a) => { const r = await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`, { method: 'POST', body: encodeAttestation(a) }); return r.status; };
const outcome = async (d, rid) => (await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`)).json();
const back = (d, rid, eid, kind = 'stake') => fetch(`http://127.0.0.1:${d.port}/forfeit?round=${toHex(rid)}&entry=${toHex(eid)}${kind === 'fee' ? '&lock=fee' : ''}`)
  .then(async (r) => (r.status === 200 ? '200' : `${r.status} ${(await r.text()).slice(0, 160)}`));

test('nobody who staked picked the outcome, one lockless entry did: every stake and fee comes back at once', async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000, serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    const played = [await lockAndPlay(w, player(0), { noMarks: true, pick: 0 }), await lockAndPlay(w, player(1), { noMarks: true, pick: 1 })];
    // the griefer: an entry picking 2 at both seats, no lock handed anywhere
    const free = await lockAndPlay(w, player(9), { noMarks: true, pick: 2, only: [] });
    await closeRound(w);
    const at = w.c.entryCloseMs + 1n;
    await Promise.all(w.nodes.map((d) => post(d, w.rid, signedBy({ roundId: w.rid, outcome: 2, observedAtMs: at }, [A0, A2]))));
    skipTo(Number((await outcome(w.a, w.rid)).finalAtMs) + 100);
    await wait(3000);
    const table = (await outcome(w.a, w.rid)).table;
    const stakes = await Promise.all(played.map((e) => back(w.a, w.rid, e.eid)));
    const fees = await Promise.all(played.map((e) => back(w.a, w.rid, e.eid, 'fee')));
    console.log('  FACTS (#1436 pool):', JSON.stringify({ stakeSeenFree: w.a.round.stakeSeen(free.eid), refunded: table && table.refunded, why: table && table.why, stakes, fees }));
    assert.equal(w.a.round.stakeSeen(free.eid), null);
    assert.equal(table && table.refunded, true, 'the seat\'s own table counts the lockless pick');
    assert.deepEqual(stakes, ['200', '200'], 'a lockless pick of the outcome kept the staked picks from coming back at once');
    assert.deepEqual(fees, ['200', '200'], 'a lockless pick of the outcome kept the fees from coming back at once');
  } finally { await w.close(); }
});

// ---- a scalar market, on one seat's store (as scalar-settle.test.js) ----
const b32 = (n) => new Uint8Array(32).fill(n);
const TERMS = { nodeFeeBps: 100, donationBps: 50, question: 'BTC/USD at 18:00 UTC, in points of a 0..100 index?', resolveAfterCloseMs: 600000n,
  deadlineAfterResolveMs: 3600000n, sourceRule: 'the index as three exchanges print it at the resolution time' };
const SCALAR = testAttestedGame({ name: 'index-at-18', outcomes: ['LONG', 'SHORT'], marketTerms: TERMS, scalar: { low: 0n, high: 100n, unit: 'points' },
  requiredProtocolVersion: SCALAR_VERSION });
const BASE = {
  networkId: b32(0x4e), configHash: new Uint8Array(32), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: new Uint8Array(32),
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', bondMinSats: 100000n, blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656,
  spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [],
};
const S = 1788200000000n;
const RESOLVE_AT = S + TERMS.resolveAfterCloseMs;

test('a scalar market staked on LONG only, plus one lockless SHORT entry: the return door hands every fee back at once, as the settlement does', async () => {
  const M = { ...BASE, protocolVersion: SCALAR_VERSION, gameId: SCALAR.registration.gameId, startTimeMs: S - 900000n, entryCloseMs: S, stakeMsat: STAKE };
  const rid = roundId(M);
  const clock = { ms: Number(RESOLVE_AT) + 1000 };
  const round = new Round(openStore(':memory:'), () => clock.ms, { plugins: [SCALAR.registration] });
  round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(M), 1);
  const [V0, , V2] = SCALAR.attestors;
  const body = { roundId: rid, value: 80n, observedAtMs: RESOLVE_AT };
  const a = { ...body, signatures: [V0, V2].map((x) => attestorSignValue(x, body)) };
  round.putOutcomeAttestation({ bodyId: valueAttestationBodyId(a), roundId: rid, outcome: VALUE_HELD_OUTCOME, observedAtMs: a.observedAtMs, bytes: encodeValueAttestation(a), receivedMs: clock.ms });
  clock.ms += 600001;
  // LONG 3 and 1 units, staked; SHORT 2 units with no lock seen here
  const picks = [[0, 3n, true], [0, 1n, true], [1, 2n, false]];
  const entries = picks.map(([pick, units], i) => ({ entryId: b32(0x30 + i),
    entry: { roundId: rid, playerPubkey: schnorr.getPublicKey(b32(0x70 + i)), stakeMsat: units * STAKE, feeMsat: 0n, donationMsat: 0n, pick, feePreimage: new Uint8Array(32) } }));
  const seen = new Set(entries.filter((_, i) => picks[i][2]).map((e) => toHex(e.entryId)));
  const CLAIM = new Uint8Array(33).fill(2);
  const lockOf = (eid) => { const e = entries.find((x) => toHex(x.entryId) === toHex(eid)); if (!seen.has(toHex(eid))) return null;
    return { outpoint: `${toHex(b32(0x50 + eid[0] - 0x30))}:0`,
      fields: lockFieldsToJson({ paymentImage: { kind: 'hash', bytes: b32(9) }, amountMsat: e.entry.stakeMsat, claimPk: CLAIM, refundPk: refundKeyOf(e.entry.playerPubkey), expiration: 1000 }) }; };
  const view = Object.assign(Object.create(round), {
    entriesOf: () => entries,
    stakeSeen: (eid) => (seen.has(toHex(eid)) ? { paidMsat: STAKE, seenMs: 1 } : null),
    stakeLock: lockOf, feeLock: lockOf, lockSettlement: () => null, fedLockSettlementsOf: () => [],
  });
  // the settlement's view holds no fee locks (as scalar-settle.test.js: a market's fee locks need a donation target this seat does not name)
  const settlement = new LockSettlement(Object.assign(Object.create(view), { feeLock: () => null }), { dkg: { signerNodeFor: () => ({ ok: true, pool: { groupPublicKey: CLAIM } }) },
    port: { settle: async () => ({}), fees: async () => ({ ppm: 0n, baseMsat: 0n }) } });
  const plan = await settlement.planOf(rid);
  const refusedClaimKey = { signerNodeFor: () => ({ ok: false, why: 'no claim-key share in this test' }) };
  const door = await new Forfeit(view, { dkg: refusedClaimKey }).message(rid, entries[0].entryId, 'fee');
  console.log('  FACTS (#1436 scalar):', JSON.stringify({ plan: plan.why && plan.why.slice(0, 120), door: door.why && door.why.slice(0, 120) }));
  assert.equal(plan.ok, false);
  assert.match(plan.why, /only the LONG side staked/);
  // refunded: the door goes on to sign the return, and stops only at this test's missing claim-key share
  assert.match(door.why, /holds no share of the round's claim key/);
});
