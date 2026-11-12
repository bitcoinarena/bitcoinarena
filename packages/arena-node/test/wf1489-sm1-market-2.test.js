// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (markets): A SCALAR POOL'S STAKE-SHARE DOOR COUNTS ENTRIES ITS SETTLEMENT DOES NOT (#1436 left it out).
// A round of a scalar market that took orders and plain picks and ended a POOL (no certified batch holds an order, §0A.7b): the
// settlement (#attestedPlan) tables the plain picks only - an order is no entry of that round, its stake comes back (wrongType). The
// share door (stake-secret.js mayRelease) tables EVERY entry whose stake it saw, orders too (the scalar branch skips the kind filter
// #1436 put into forfeit.js and the settlement). A plain pick the settlement claims (paid less than its stake) can be "won" in the
// door's table: its share is never handed out, its P never opens, the settlement never forms, and every claimed lock waits for expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { VALUE_HELD_OUTCOME } from '../src/game-market.js';
import { StakeSecrets } from '../src/stake-secret.js';
import { OrderBook } from '../src/order-batch.js';
import { LockSettlement } from '../src/settlement.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { encodeRoundContract, roundId, encodeEntryContract, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { encodeValueAttestation, valueAttestationBodyId } from '../../arena-protocol/src/scalar.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { SCALAR_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { testAttestedGame, attestorSignValue } from './plugins/sign.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const TERMS = { nodeFeeBps: 100, donationBps: 50, question: 'BTC/USD at 18:00 UTC, in points of a 0..100 index?', resolveAfterCloseMs: 600000n,
  deadlineAfterResolveMs: 3600000n, sourceRule: 'the index as three exchanges print it at the resolution time' };
const MARKET = testAttestedGame({ name: 'index-at-18-wf1489-2', outcomes: ['LONG', 'SHORT'], marketTerms: TERMS, scalar: { low: 0n, high: 100n, unit: 'points' },
  requiredProtocolVersion: SCALAR_VERSION });
const [A0, , A2] = MARKET.attestors;
const BASE = {
  networkId: b32(0x4e), configHash: new Uint8Array(32), censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, simCoreHash: new Uint8Array(32),
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
  stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 964900, censusRoot: b32(2), committeeTimeMs: 500n,
  randomnessRule: 'bitcoin-block-hash', bondMinSats: 100000n, blockTicks: 9000, exposureReference: 12451840, corridorHalfWidth: 3014656,
  spawnFreeRadius: 1441792, timeFloor: 16384, timeCeil: 98304, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [],
};
const S = 1788200000000n;
const STAKE = 1_000_000n;
const RESOLVE_AT = S + TERMS.resolveAfterCloseMs;


test('wf1489-sm1-market-2: a scalar pool releases a stake share exactly for the locks its settlement claims, an order in it counted by neither', async () => {
  const M = { ...BASE, protocolVersion: SCALAR_VERSION, gameId: MARKET.registration.gameId, startTimeMs: S - 900000n, entryCloseMs: S, stakeMsat: STAKE };
  const rid = roundId(M);
  const clock = { ms: Number(RESOLVE_AT) + 1000 };
  const round = new Round(openStore(':memory:'), () => clock.ms, { plugins: [MARKET.registration] });
  round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(M), 1);
  // L a plain LONG pick of 1 unit, H a plain SHORT pick of 1 unit, O an order on SHORT of 3 units (locked, never in a certified batch)
  const list = [['L', 0, 1n, null], ['H', 1, 1n, null], ['O', 1, 3n, 60000]].map(([name, pick, units, limitPrice], i) => {
    const entryId = b32(0x30 + i);
    const playerPubkey = schnorr.getPublicKey(b32(0x70 + i));
    const bytes = encodeEntryContract({ roundId: rid, playerPubkey, sessionPubkey: b32(0x60 + i), stakeCommitment: b32(0x61), stakeMsat: units * STAKE, feeMsat: 0n,
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(0), stakePoint: new Uint8Array(33), feePreimage: b32(0x62),
      stakeLockOutpoint: { txid: b32(0x50 + i), outIdx: 0n }, feeLockOutpoint: { txid: b32(0x58 + i), outIdx: 0n }, claimKeyAttestationRef: b32(0x63),
      pick, ...(limitPrice ? { limitPrice, orderExpiryMs: 0n } : {}) });
    return { name, entryId, bytes, entry: decodeEntryContract(bytes) };
  });
  const byId = (eid) => list.find((o) => toHex(o.entryId) === toHex(eid));
  const CLAIM = new Uint8Array(33).fill(2);
  const view = Object.assign(Object.create(round), {
    entry: (eid) => { const o = byId(eid); return o ? o.bytes : null; },
    entriesOf: () => list.map((o) => ({ entryId: o.entryId, entry: o.entry })),
    stakeSeen: () => ({ paidMsat: STAKE, seenMs: 1 }),
    stakeLock: (eid) => { const o = byId(eid); return o ? { outpoint: `${toHex(b32(0x50 + eid[0] - 0x30))}:0`, verifiedMs: 1,
      fields: lockFieldsToJson({ paymentImage: { kind: 'hash', bytes: b32(9) }, amountMsat: o.entry.stakeMsat, claimPk: CLAIM, refundPk: refundKeyOf(o.entry.playerPubkey), expiration: 1000 }) } : null; },
    feeLock: () => null,
    lockSettlement: () => null,
    fedLockSettlementsOf: () => [],
  });
  const orderBook = new OrderBook(view, { plugins: view.plugins });
  assert.equal(orderBook.isBook(rid), false, 'no certified batch holds an order: the round is a pool');

  // THE VALUE: 40 of 0..100 points; final after the objection window
  const body = { roundId: rid, value: 40n, observedAtMs: RESOLVE_AT };
  const a = { ...body, signatures: [A0, A2].map((x) => attestorSignValue(x, body)) };
  round.putOutcomeAttestation({ bodyId: valueAttestationBodyId(a), roundId: rid, outcome: VALUE_HELD_OUTCOME, observedAtMs: a.observedAtMs, bytes: encodeValueAttestation(a), receivedMs: clock.ms });
  clock.ms += 600001;

  // THE SETTLEMENT as the seat builds it (isBook is false here, so #attestedPlan builds the pool's plan; the book's read of the other seats is left out - no peers in this harness)
  const settlement = new LockSettlement(view, { dkg: { signerNodeFor: () => ({ ok: true, pool: { groupPublicKey: CLAIM } }) },
    port: { settle: async () => ({}), fees: async () => ({ ppm: 0n, baseMsat: 0n }) } });
  const plan = await settlement.planOf(rid);
  assert.equal(plan.ok, true, plan.why);
  const claimedKeys = new Set(plan.plan.claims.filter((c) => c.kind === 'stake').map((c) => toHex(c.pubkey)));
  const claimed = (o) => claimedKeys.has(toHex(o.entry.playerPubkey));

  // THE SHARE DOOR as server.js wires it
  const secrets = new StakeSecrets(view, { curve: null, random: () => new Uint8Array(32), bookStanding: (r, e) => orderBook.standing(r, e) });
  const may = Object.fromEntries(list.map((o) => [o.name, secrets.mayRelease(rid, o.entryId)]));
  const facts = Object.fromEntries(list.map((o) => [o.name, { claimedBySettlement: claimed(o), shareReleased: may[o.name].ok, why: may[o.name].ok ? may[o.name].outcome : may[o.name].why }]));
  console.log('  FACTS:', JSON.stringify(facts));
  assert.equal(claimed(list[0]), true, 'L (LONG, paid 0.8 of its 1 unit by the pool of L and H) is claimed');
  for (const o of list)
    assert.equal(may[o.name].ok, claimed(o), `${o.name}: the settlement ${claimed(o) ? 'claims' : 'does not claim'} its lock, and mayRelease said ${facts[o.name].why}`);
});
