// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit (markets): A ROUND IS SETTLED AS A POOL WHILE A BATCH HOLDING ORDERS IS STILL UNDECIDED AT THE SEAT.
// §0A.7b (#1411/#1417): a two-outcome round is a book iff a threshold-certified batch holds an order. A batch k carrying orders that this
// seat SIGNED is pending here (BATCH SIGNED): it can still be certified - its signatures are held by the seats that signed it, and the next
// leader that hears a threshold of them certifies it (order-batch.js #decide). #bookPlan refuses while any batch is pending ("batch k of the
// book is not decided at this seat"), the return door and the share door refuse an order in it - but the POOL path does not look:
// settlement.js #attestedPlan asks isBook() (false: no certificate yet) and plans the pool over the plain picks, and stake-secret.js
// mayRelease hands out a losing plain pick's share. Reachable in production: 5 of 7 seats sign k, two of them go down before the certificate
// is handed out; the leader's own signature plus the three up signers' are 4 (< 5), the two non-signers' declines are 2 (< 3): k stays
// pending at the five up seats, which still make a threshold for the pool's settlement. Once the two seats are back, k is certified and the
// round is a book: the plain picks the pool claimed (and whose secrets were handed out) are, by the book's rule, not entries of the round -
// their locks "come back at once" - and the orders' fills are settled by a second, book settlement. Harness as wf1489-sm1-market-2 (a real
// store, a real OrderBook, LockSettlement and StakeSecrets as server.js wires them); the four other up seats answer GET /book-certificates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { StakeSecrets } from '../src/stake-secret.js';
import { OrderBook } from '../src/order-batch.js';
import { LockSettlement } from '../src/settlement.js';
import { Round } from '../src/round.js';
import { openStore } from '../src/store.js';
import { encodeRoundContract, roundId, encodeEntryContract, decodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { encodeAttestation, attestationBodyId } from '../../arena-protocol/src/attested.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { SCALAR_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { testAttestedGame, attestorSign } from './plugins/sign.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const TERMS = { nodeFeeBps: 100, donationBps: 50, question: 'BTC above 100k at 18:00 UTC?', resolveAfterCloseMs: 600000n,
  deadlineAfterResolveMs: 3600000n, sourceRule: 'three exchanges at the resolution time' };
const MARKET = testAttestedGame({ name: 'yes-no-wf1489-3', outcomes: ['YES', 'NO'], marketTerms: TERMS });
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

test('wf1489-sm1-market-3: no pool settlement and no losing pick\'s share while a batch holding orders is undecided at this seat', async () => {
  const M = { ...BASE, protocolVersion: SCALAR_VERSION, gameId: MARKET.registration.gameId, startTimeMs: S - 900000n, entryCloseMs: S, stakeMsat: STAKE };
  const rid = roundId(M);
  const clock = { ms: Number(RESOLVE_AT) + 1000 };
  const round = new Round(openStore(':memory:'), () => clock.ms, { plugins: [MARKET.registration] });
  round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(M), 1);
  // PY a plain YES pick, PN a plain NO pick; OY an order on YES at 60c, ON an order on NO at 40c - all four locked
  const list = [['PY', 0, null], ['PN', 1, null], ['OY', 0, 60000], ['ON', 1, 40000]].map(([name, pick, limitPrice], i) => {
    const entryId = b32(0x30 + i);
    const playerPubkey = schnorr.getPublicKey(b32(0x70 + i));
    const bytes = encodeEntryContract({ roundId: rid, playerPubkey, sessionPubkey: b32(0x60 + i), stakeCommitment: b32(0x61), stakeMsat: STAKE, feeMsat: 0n,
      donationMsat: 0n, joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(0), stakePoint: new Uint8Array(33), feePreimage: b32(0x62),
      stakeLockOutpoint: { txid: b32(0x50 + i), outIdx: 0n }, feeLockOutpoint: { txid: b32(0x58 + i), outIdx: 0n }, claimKeyAttestationRef: b32(0x63),
      pick, ...(limitPrice ? { limitPrice, orderExpiryMs: 0n } : {}) });
    return { name, entryId, bytes, entry: decodeEntryContract(bytes) };
  });
  const by = Object.fromEntries(list.map((o) => [o.name, o]));
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

  // BATCH k WITH BOTH ORDERS, SIGNED HERE (as accept -> #store writes it: the record, this seat's signature, no certificate yet)
  const k = Number(S / 500n) - 2;
  const record = { k: String(k), orders: [toHex(by.OY.entryId), toHex(by.ON.entryId)].sort(), cancels: [], sells: [], leader: toHex(b32(0x11)), leaderSig: 'aa'.repeat(64) };
  round.db.prepare('INSERT INTO market_batches (round_id, k, batch_id, record, own_sig, certificate, stored_ms) VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .run(Buffer.from(rid), k, 'bb'.repeat(32), JSON.stringify(record), 'cc'.repeat(64), Number(S) - 900);
  for (const o of record.orders) round.db.prepare('INSERT INTO market_orders (order_id, round_id, body, received_ms, batch) VALUES (?, ?, \'\', ?, ?)').run(o, Buffer.from(rid), Number(S) - 2000, k);

  // THE FOUR OTHER UP SEATS: three signed k too (it is pending there), one did not (it holds nothing)
  const peers = ['http://s1', 'http://s2', 'http://s3', 'http://s4'];
  const fetcher = async (url) => {
    const pend = /s[123]\//.test(url) ? [String(k)] : [];
    return new Response(JSON.stringify({ certificates: [], pending: pend }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const orderBook = new OrderBook(view, { plugins: view.plugins, peersFor: () => peers, fetcher });
  const pendingHere = orderBook.pending(rid);

  // THE OUTCOME: YES, final after the objection window
  const body = { roundId: rid, outcome: 0, observedAtMs: RESOLVE_AT };
  const a = { ...body, signatures: [A0, A2].map((x) => attestorSign(x, body)) };
  round.putOutcomeAttestation({ bodyId: attestationBodyId(a), roundId: rid, outcome: 0, observedAtMs: a.observedAtMs, bytes: encodeAttestation(a), receivedMs: clock.ms });
  clock.ms += 600001;

  const settlement = new LockSettlement(view, { dkg: { signerNodeFor: () => ({ ok: true, pool: { groupPublicKey: CLAIM } }) },
    port: { settle: async () => ({}), fees: async () => ({ ppm: 0n, baseMsat: 0n }) }, orderBook });
  const plan = await settlement.planOf(rid);
  const secrets = new StakeSecrets(view, { curve: null, random: () => new Uint8Array(32), bookStanding: (r, e) => orderBook.standing(r, e) });
  const lostPick = secrets.mayRelease(rid, by.PN.entryId);

  // ... AND ONCE THE TWO SEATS ARE BACK, k IS CERTIFIED: the round is a book
  round.db.prepare('UPDATE market_batches SET certificate = ? WHERE round_id = ? AND k = ?').run(JSON.stringify([]), Buffer.from(rid), k);
  const after = { isBook: orderBook.isBook(rid), pickStanding: orderBook.standing(rid, by.PN.entryId), share: secrets.mayRelease(rid, by.PN.entryId) };

  const facts = { pendingHere, isBookWhilePending: false, plan: plan.ok ? `pool plan claiming ${plan.plan.claims.filter((c) => c.kind === 'stake').length} stake lock(s)` : plan.why,
    lostPickShare: lostPick.ok ? lostPick.outcome : lostPick.why,
    afterCertified: { isBook: after.isBook, PN: after.pickStanding.wrongType || 'entry', share: after.share.ok ? after.share.outcome : after.share.why } };
  console.log('  FACTS:', JSON.stringify(facts));
  assert.deepEqual(pendingHere, [k], 'the harness holds batch k pending here');
  assert.equal(after.isBook, true, 'once k is certified the round is a book');
  assert.equal(plan.ok, false, `a pool settlement was planned while batch ${k}, holding orders, is undecided at this seat (${facts.plan}); once it is certified the round is a book and PN "${facts.afterCertified.PN}"`);
  assert.equal(lostPick.ok, false, `the losing plain pick's stake share was handed out (${facts.lostPickShare}) while batch ${k} is undecided; once certified the book says: ${facts.afterCertified.share}`);
});
