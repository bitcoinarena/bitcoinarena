// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (markets): A SCALAR MARKET'S ORDER BOOK (§0A.7e) HANDS OUT STAKE SECRETS BY THE POOL'S RULE.
// The book settlement (#bookPlan -> book-ledger.js bookSettlement) claims EVERY FILLED order's lock whole and opens each claimed lock's
// stake secret from the seats' shares (settlement.js message -> stakeSecrets.open -> each seat's mayRelease). An unfilled order's lock
// comes back whole and its secret must stay sealed. stake-secret.js mayRelease answers a scalar round by the pari-mutuel scalar table
// BEFORE it looks at the book: a filled order the pool table calls "won" gets no share (its lock can never be claimed, the settlement
// never forms, every filled lock waits for expiry), and an unfilled order the pool table calls "lost" has its secret handed out.
// Harness as scalar-settle.test.js (a real store, the market round written in, a value held as POST /outcome holds it), plus a real
// OrderBook over the same store holding one certified batch (as certify stores it) and StakeSecrets wired as server.js wires it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { VALUE_HELD_OUTCOME } from '../src/game-market.js';
import { StakeSecrets } from '../src/stake-secret.js';
import { OrderBook } from '../src/order-batch.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { encodeRoundContract, roundId, encodeEntryContract, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { encodeValueAttestation, valueAttestationBodyId } from '../../arena-protocol/src/scalar.js';
import { bookSettlement } from '../../arena-protocol/src/book-ledger.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { SCALAR_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { testAttestedGame, attestorSignValue } from './plugins/sign.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const TERMS = { nodeFeeBps: 100, donationBps: 50, question: 'BTC/USD at 18:00 UTC, in points of a 0..100 index?', resolveAfterCloseMs: 600000n,
  deadlineAfterResolveMs: 3600000n, sourceRule: 'the index as three exchanges print it at the resolution time' };
const MARKET = testAttestedGame({ name: 'index-at-18-wf1489', outcomes: ['LONG', 'SHORT'], marketTerms: TERMS, scalar: { low: 0n, high: 100n, unit: 'points' },
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

test('wf1489-sm1-market-1: a scalar book hands a stake secret out exactly for the locks its settlement claims (the filled orders)', () => {
  const M = { ...BASE, protocolVersion: SCALAR_VERSION, gameId: MARKET.registration.gameId, startTimeMs: S - 900000n, entryCloseMs: S, stakeMsat: STAKE };
  const rid = roundId(M);
  const clock = { ms: Number(RESOLVE_AT) + 1000 };
  const round = new Round(openStore(':memory:'), () => clock.ms, { plugins: [MARKET.registration] });
  round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(M), 1);

  // THREE ORDERS: A buys LONG at 0.60, B buys SHORT at 0.45 (they cross and fill), C buys LONG at 0.10 (rests, never fills)
  const orders = [['A', 0, 60000], ['B', 1, 45000], ['C', 0, 10000]].map(([name, pick, limitPrice], i) => {
    const entryId = b32(0x30 + i);
    const playerPubkey = schnorr.getPublicKey(b32(0x70 + i));
    const bytes = encodeEntryContract({ roundId: rid, playerPubkey, sessionPubkey: b32(0x60 + i), stakeCommitment: b32(0x61), stakeMsat: STAKE, feeMsat: 0n,
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(0), stakePoint: new Uint8Array(33), feePreimage: b32(0x62),
      stakeLockOutpoint: { txid: b32(0x50 + i), outIdx: 0n }, feeLockOutpoint: { txid: b32(0x58 + i), outIdx: 0n }, claimKeyAttestationRef: b32(0x63),
      pick, limitPrice, orderExpiryMs: 0n });
    return { name, entryId, bytes, entry: decodeEntryContract(bytes) };
  });
  const byId = (eid) => orders.find((o) => toHex(o.entryId) === toHex(eid));
  const CLAIM = new Uint8Array(33).fill(2);
  const view = Object.assign(Object.create(round), {
    entry: (eid) => { const o = byId(eid); return o ? o.bytes : null; },
    entriesOf: () => orders.map((o) => ({ entryId: o.entryId, entry: o.entry })),
    stakeSeen: () => ({ paidMsat: STAKE, seenMs: 1 }),
    stakeLock: (eid) => { const o = byId(eid); return o ? { outpoint: `${toHex(b32(0x50 + eid[0] - 0x30))}:0`, verifiedMs: 1,
      fields: lockFieldsToJson({ paymentImage: { kind: 'hash', bytes: b32(9) }, amountMsat: STAKE, claimPk: CLAIM, refundPk: refundKeyOf(o.entry.playerPubkey), expiration: 1000 }) } : null; },
    feeLock: () => null,
    lockSettlement: () => null,
    fedLockSettlementsOf: () => [],
  });

  // THE CERTIFIED BOOK as a seat holds it after POST /batch-certificate: one batch carrying the three orders
  const orderBook = new OrderBook(view, { plugins: view.plugins });
  const record = { k: '3576400000', orders: orders.map((o) => toHex(o.entryId)).sort(), cancels: [], sells: [], leader: '00'.repeat(32), leaderSig: '00'.repeat(64) };
  round.db.prepare('INSERT INTO market_batches (round_id, k, batch_id, record, own_sig, certificate, stored_ms) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(Buffer.from(rid), Number(record.k), 'ab'.repeat(32), JSON.stringify(record), null, '[]', clock.ms);
  assert.equal(orderBook.isBook(rid), true);
  const L = orderBook.ledger(rid);
  assert.equal(L.ok, true, L.why);

  // THE VALUE: 20 of 0..100 points, held at the resolution time; final after the objection window
  const body = { roundId: rid, value: 20n, observedAtMs: RESOLVE_AT };
  const a = { ...body, signatures: [A0, A2].map((x) => attestorSignValue(x, body)) };
  round.putOutcomeAttestation({ bodyId: valueAttestationBodyId(a), roundId: rid, outcome: VALUE_HELD_OUTCOME, observedAtMs: a.observedAtMs, bytes: encodeValueAttestation(a), receivedMs: clock.ms });
  clock.ms += 600001;

  // WHAT THE BOOK SETTLEMENT CLAIMS (the function #bookPlan runs on this ledger): every filled order's lock, whole
  const table = bookSettlement({ positions: L.positions, outcome: undefined, scalar: { value: 20n, bounds: { low: 0n, high: 100n } } });
  const claimed = new Set(table.claimed.map((r) => r.entry));
  const standing = Object.fromEntries(orders.map((o) => [o.name, orderBook.standing(rid, o.entryId)]));

  // THE SHARE DOOR, wired as server.js wires it (bookStanding: orderBook.standing)
  const secrets = new StakeSecrets(view, { curve: null, random: () => new Uint8Array(32), bookStanding: (r, e) => orderBook.standing(r, e) });
  const may = Object.fromEntries(orders.map((o) => [o.name, secrets.mayRelease(rid, o.entryId)]));
  const facts = Object.fromEntries(orders.map((o) => [o.name, { filled: standing[o.name].filled, claimedBySettlement: claimed.has(toHex(o.entryId)),
    shareReleased: may[o.name].ok, why: may[o.name].ok ? may[o.name].outcome : may[o.name].why }]));
  console.log('  FACTS:', JSON.stringify(facts));
  assert.equal(standing.A.filled && standing.B.filled && !standing.C.filled, true, 'A and B cross and fill, C rests');
  assert.deepEqual([...claimed].sort(), [toHex(orders[0].entryId), toHex(orders[1].entryId)].sort(), 'the book claims A and B whole, not C');
  // THE INVARIANT: a share is released exactly for a lock the settlement claims
  for (const o of orders)
    assert.equal(may[o.name].ok, claimed.has(toHex(o.entryId)),
      `order ${o.name} (${facts[o.name].filled ? 'filled, its lock claimed' : 'unfilled, its lock comes back whole'}): mayRelease said ${facts[o.name].why}`);
});
