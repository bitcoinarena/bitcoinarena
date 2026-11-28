// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 wf1489-r20-settle-2 / kanban #3882 (RULED 2026-11-28): the series publisher's fee back (§5A.5: "Only the first confirmed publication is
// reimbursed") was paid AGAIN in every late loser's second settlement of round 0: settlement.js lateMessage handed lateLockSettlement the same
// signerNodesFor(rid, contract) the round's own settlement used (publisherFor names the publisher for every round-0 build), and feeSettlement paid
// `signerNodes.publisher` off the top of the late fee lock's nodes' part. From LATE_NO_PUBLISHER_VERSION a late settlement never names the publisher
// (lateMessage drops it before it builds - modelled here - and lateLockSettlement refuses one it is handed); the round's own settlement and one that
// replaces it still pay it once; an older round is built as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publisherPayoutMsat } from '../src/publisher-payout.js';
import { lockSettlement, lateLockSettlement } from '../src/lock-settlement.js';
import { DELIVERED, FAILED } from '../src/payout.js';
import { entryFeeMsat } from '../src/fee.js';
import { toHex } from '../src/hash.js';
import { LATE_NO_PUBLISHER_VERSION } from '../src/constants.js';
import { ROUND_SPLIT_BPS, RESERVES_NODE_FEE_BPS } from '../src/reserves.js';
import { TEST_FEDERATION_ID } from '../src/test-federation.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => secp256k1.getPublicKey(new Uint8Array(32).fill(n), true);
const N = (n) => { const k = new Uint8Array(32); k[0] = 0xa0 + n; k[31] = n; return k; };
const key33 = (_p, n) => secp256k1.getPublicKey(new Uint8Array(32).fill(n), true);   // real points: the gift keys are checked on the curve
const GIFTS = { recipients: { network: [{ recipientPk: key33(0x02, 0xa1), shareBps: 10000, label: 'dev' }], game: [{ recipientPk: key33(0x02, 0xc4), shareBps: 10000, label: 'game dev' }] },
  reserveKey: key33(0x02, 0xe5), split: ROUND_SPLIT_BPS };
const sum = (s, kind) => s.payouts.filter((p) => p.kind === kind).reduce((t, p) => t + p.msat, 0n);

// one series' round 0: W wins, L loses in the round's own settlement; LATE is a late loser. `protocolVersion` undefined: the oldest rules (fee 4 %, no gifts)
function world(protocolVersion) {
  const STAKE = 4000000n;
  const modern = protocolVersion !== undefined;
  const FEE = modern ? entryFeeMsat(STAKE, 1000) : entryFeeMsat(STAKE);
  const e = (n, outcome, score) => ({ entryId: b32(0x30 + n), pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score });
  const W = e(1, DELIVERED, 5), L = e(2, FAILED, 0), LATE = e(3, FAILED, 0);
  const locks = new Map([W, L].map((x, i) => [toHex(x.pubkey), { outpoint: { txid: b32(0x40 + i), outIdx: BigInt(i) }, amountMsat: STAKE - FEE, refundPk: refund(i + 1) }]));
  const feeLocks = new Map([W, L].map((x, i) => [toHex(x.pubkey), { outpoint: { txid: b32(0x80 + i), outIdx: BigInt(i) }, amountMsat: FEE, preimage: b32(0xf0 + i) }]));
  const nodes = [N(1), N(2)];
  const contract = {
    networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(1),
    startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
    federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusHeight: 900000, censusRoot: b32(2),
    committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 9000,
    exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
    ...(modern ? { protocolVersion } : {}),
  };
  const fees = { ppm: 0n, baseMsat: 1000n };
  const extra = modern ? { feeBps: RESERVES_NODE_FEE_BPS, gifts: GIFTS } : {};
  // what arena-node server.js signerNodesFor hands BOTH builds of a series' round 0 (publisherFor: round index 0, a proven publication)
  const publisher = { payoutPk: refund(0x77), msat: publisherPayoutMsat(60n) };
  const signerNodes = { gameVerify: nodes, settlement: nodes, publisher };
  const roundId = b32(0x5f);
  const build = () => lockSettlement({ roundId, entries: [W, L], minScore: 1, locks, feeLocks, fees, contract, signerNodes, ...extra });
  const first = build();
  assert.equal(first.ok, true, first.why);
  const late = (sn) => lateLockSettlement({ roundId, entryId: LATE.entryId, entry: LATE,
    lock: { outpoint: { txid: b32(0x50), outIdx: 0n }, amountMsat: STAKE - FEE, refundPk: refund(9) },
    feeLock: { outpoint: { txid: b32(0x90), outIdx: 0n }, amountMsat: FEE, preimage: b32(0xfa) },
    shares: first.stakeShares, winnerLocks: new Map([[toHex(W.pubkey), { refundPk: refund(1) }]]), fees, signerNodes: sn, contract, ...extra });
  const { publisher: _dropped, ...withoutPublisher } = signerNodes;   // what settlement.js lateMessage builds with from the gate on (kanban #3882)
  return { first, publisher, signerNodes, withoutPublisher, late, build };
}

test('#3882 new-version round (wf1489-r20-settle-2): the fee back is paid once by round 0\'s own settlement; the late loser\'s settlement pays the seats', () => {
  const w = world(LATE_NO_PUBLISHER_VERSION);
  const paidFirst = sum(w.first, 'publisher');
  const late = w.late(w.withoutPublisher);
  assert.equal(late.ok, true, late.why);
  const paidLate = sum(late, 'publisher'), nodesLate = sum(late, 'signer node');
  // the same late lock with the publisher line (as the old rule built it): what the seats would lose
  const asBefore = world(LATE_NO_PUBLISHER_VERSION);
  console.log(`  FACTS (#3882): owed ${w.publisher.msat} msat once; round 0 paid ${paidFirst}; the late settlement paid the publisher ${paidLate}, the seats ${nodesLate}`);
  assert.equal(paidFirst, w.publisher.msat, 'round 0\'s own settlement pays the fee back');
  assert.equal(paidLate, 0n, 'the late settlement pays no publisher');
  assert.ok(nodesLate >= w.publisher.msat, `the late fee lock's nodes' part goes whole to the seats (${nodesLate})`);
  assert.ok(asBefore.first.ok);
});

test('#3882 new-version round: a late settlement handed a publisher is refused', () => {
  const w = world(LATE_NO_PUBLISHER_VERSION);
  const late = w.late(w.signerNodes);
  assert.equal(late.ok, false);
  assert.match(late.why, /never pays the series publisher/);
});

test('#3882 new-version round: a settlement replacing round 0\'s own still pays the publisher, exactly once', () => {
  const w = world(LATE_NO_PUBLISHER_VERSION);
  const again = w.build();
  assert.equal(again.ok, true, again.why);
  assert.equal(sum(again, 'publisher'), w.publisher.msat);
  assert.equal(again.payouts.filter((p) => p.kind === 'publisher').length, 1);
});

test('#3882 old-version rounds: the late settlement is built as today, the publisher line as before', () => {
  for (const v of [undefined, LATE_NO_PUBLISHER_VERSION - 1]) {
    const w = world(v);
    const late = w.late(w.signerNodes);
    assert.equal(late.ok, true, `${v}: ${late.why}`);
    assert.equal(sum(late, 'publisher'), w.publisher.msat, `version ${v}`);
  }
});

test('#3882 a round other than round 0 (no publisher named): its late settlement is the same under the gate', () => {
  const a = world(LATE_NO_PUBLISHER_VERSION), b = world(LATE_NO_PUBLISHER_VERSION - 1);
  const la = a.late(a.withoutPublisher), lb = b.late(b.withoutPublisher);
  assert.equal(la.ok, true, la.why); assert.equal(lb.ok, true, lb.why);
  assert.deepEqual(la.payouts.map((p) => `${p.kind}:${p.msat}`), lb.payouts.map((p) => `${p.kind}:${p.msat}`));
});
