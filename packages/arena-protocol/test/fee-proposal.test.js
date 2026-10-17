// ONE PROPOSAL CHANGES FEES FROM THREE AREAS AT ONCE (kanban #462, agreed 2026-10-17, comment 3079): game node fee 4 -> 3.5 %, market
// reserve 0.2 -> 0.3 %, round donation 4 -> 4.5 % with the protocol developers' approval. It passes its signal and its bond-weighted
// vote; before its activation height a round and a market settle on the old fees, after it on the new ones, to the msat. The same
// proposal without the developers' majority is refused whole - neither the node fee nor the market reserve moves - and a market
// donation of 0 or a round total above 10 % is refused at submission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '../../arena-node/node_modules/@noble/curves/secp256k1.js';
import { FEES, FEES_TODAY, feeProposalId, encodeFeeProposal, decodeFeeProposal, feeProposalStands, feeProposalOutcome, feeApprovalId, feesAt,
  roundSplitBps, marketBps, devMajority } from '../src/fee-proposal.js';
import { signalOutcome, votePeriodOf, fundingTally, FUNDING_SCHEDULES } from '../src/funding.js';
import { encodeVote, voteMessage, CHOICE } from '../src/ballot.js';
import { roundSplit } from '../src/reserves.js';
import { bookLedger, bookSettlement } from '../src/book-ledger.js';
import { YES, NO } from '../src/order-book.js';
import { bookLockSettlement } from '../src/lock-settlement.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../src/test-donation-set-keys-regtest.js';
import { entryFeeMsat } from '../src/fee.js';
import { toHex } from '../src/hash.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 3; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const S = FUNDING_SCHEDULES.spec;
const PUBLISHED = 157000;
const ACTIVATION = PUBLISHED + S.signal + S.vote + S.decideDepth + 100;
const P = { networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: PUBLISHED, activationHeight: ACTIVATION,
  changes: [{ fee: 'roundNodeBps', value: 350 }, { fee: 'marketReserveBps', value: 30 }, { fee: 'roundDonationBps', value: 450 }],
  purpose: 'Cheaper rounds for players, more for the developers and the reserves of a market' };
const ID = feeProposalId(P);
const DEVS = [11, 12, 13];                                      // the protocol developers' keys
const approve = (n, yes = true) => { const approval = { proposalId: ID, dev: pk(n), approve: yes }; return { approval, signature: schnorr.sign(feeApprovalId(approval), sk(n)) }; };

// THE SIGNAL: 3 of 10 active nodes signal (30 % >= 15 %); THE VOTE: two bonds of three say YES (66 % of all, 100 % of YES + NO)
const ACTIVE = Array.from({ length: 10 }, (_, i) => toHex(pk(40 + i)));
const signal = signalOutcome({ proposal: P, signals: [0, 1, 2].map((i) => ({ node: ACTIVE[i], atHeight: PUBLISHED + 5 })), active: ACTIVE, tip: PUBLISHED + S.signal });
const period = votePeriodOf({ proposal: P, signal });
const census = [21, 22, 23].map((n) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: 50000n }));
const vote = (n) => ({ payload: encodeVote({ proposalId: ID, choice: CHOICE.YES, signature: schnorr.sign(voteMessage(ID, CHOICE.YES), sk(n)) }), height: period.from + 3, txid: 'aa'.repeat(32) });
const tally = fundingTally({ proposalId: ID, census, votes: [vote(21), vote(22)], from: period.from, until: period.until, verify });

// a round of 1,000,000 msat gross; a market of two 10,000-sat orders, Up wins, its book cleared at the fee set's whole market rate
const GROSS = 1_000_000n;
function settleMarket(fees) {
  const rate = marketBps(fees), total = rate.nodeBps + rate.donationBps;
  const STAKE = 10_000_000n, feeMsat = entryFeeMsat(STAKE, total), id = (s) => s.padStart(64, '0');
  const L = bookLedger({ batches: [{ k: 1, cutoffMs: 1000n, orders: [{ id: id('a'), outcome: YES, price: 50000n, stakeMsat: STAKE, feeMsat, expiryMs: 0n },
    { id: id('b'), outcome: NO, price: 50000n, stakeMsat: STAKE, feeMsat, expiryMs: 0n }] }], feeBps: total });
  const table = bookSettlement({ positions: L.positions, outcome: YES });
  const player = { a: new Uint8Array(32).fill(0xa1), b: new Uint8Array(32).fill(0xb1) };
  const op = (n) => ({ txid: new Uint8Array(32).fill(n), outIdx: BigInt(n) });
  const s = bookLockSettlement({ roundId: new Uint8Array(32).fill(1), table, fees: { ppm: 0n, baseMsat: 0n }, contract: { nodes: [new Uint8Array(32).fill(0x11)] },
    entries: ['a', 'b'].map((x) => ({ entryId: id(x), pubkey: player[x] })),
    locks: new Map(['a', 'b'].map((x, i) => [toHex(player[x]), { outpoint: op(1 + i), amountMsat: STAKE - feeMsat, refundPk: new Uint8Array([2, ...player[x]]) }])),
    feeLocks: new Map(['a', 'b'].map((x, i) => [toHex(player[x]), { outpoint: op(5 + i), amountMsat: feeMsat, preimage: new Uint8Array(32).fill(9) }])),
    ...rate, reserveKey: Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x77)]), donation: { recipients: TEST_DONATION_SET_KEYS_REGTEST.recipients } });
  assert.equal(s.ok, true, s.why);
  const sum = (kind) => s.payouts.filter((p) => p.kind === kind).reduce((t, p) => t + p.msat, 0n);
  return { stakes: 2n * STAKE, nodes: sum('signer node'), donation: sum('donation key'), reserve: sum('reserve') };
}
const pctOf = (part, whole) => Number((part * 1000000n) / whole) / 10000;   // in %, 4 decimals

test('one proposal, three fees from three areas: accepted with the protocol developers\' majority; before its height the old fees, after it the new ones, to the msat', () => {
  // the record round-trips, its changes in code order
  assert.deepEqual(decodeFeeProposal(encodeFeeProposal(P)).changes.map((c) => c.fee), ['roundNodeBps', 'roundDonationBps', 'marketReserveBps']);
  assert.equal(signal.state, 'passed');
  assert.equal(tally.passed, true);
  const out = feeProposalOutcome({ proposal: P, signal, tally, approvals: [approve(11), approve(12)], devKeys: DEVS.map((n) => toHex(pk(n))), verify });
  assert.equal(out.accepted, true, out.why);
  assert.equal(out.activationHeight, ACTIVATION);
  const accepted = [out];

  // 1. BEFORE ITS ACTIVATION HEIGHT: today's fees - a round 4 / 4 / 2 %, a market 0.4 / 0.4 / 0.2 %
  const before = feesAt({ height: ACTIVATION - 1, accepted });
  assert.deepEqual(before, FEES_TODAY);
  const r0 = roundSplit(GROSS, { split: roundSplitBps(before) });
  assert.deepEqual([r0.nodesMsat, r0.protocolDevsMsat + r0.gameDevsMsat, r0.reservesMsat], [40000n, 40000n, 20000n]);
  const m0 = settleMarket(before);
  assert.deepEqual([pctOf(m0.nodes, m0.stakes), pctOf(m0.donation, m0.stakes), pctOf(m0.reserve, m0.stakes)], [0.4, 0.4, 0.2]);
  assert.deepEqual([m0.nodes, m0.donation, m0.reserve], [80000n, 80000n, 40000n]);

  // 2. FROM ITS ACTIVATION HEIGHT ON: a round 3.5 / 4.5 / 2 %, a market 0.4 / 0.4 / 0.3 %
  const after = feesAt({ height: ACTIVATION, accepted });
  assert.deepEqual([after.roundNodeBps, after.roundDonationBps, after.roundReserveBps, after.marketNodeBps, after.marketDonationBps, after.marketReserveBps], [350, 450, 200, 40, 40, 30]);
  const r1 = roundSplit(GROSS, { split: roundSplitBps(after) });
  assert.deepEqual([r1.nodesMsat, r1.protocolDevsMsat, r1.gameDevsMsat, r1.reservesMsat, r1.netMsat], [35000n, 22500n, 22500n, 20000n, 900000n]);
  const m1 = settleMarket(after);
  assert.deepEqual([m1.nodes, m1.donation, m1.reserve], [80000n, 80000n, 60000n]);
  assert.deepEqual([pctOf(m1.nodes, m1.stakes), pctOf(m1.donation, m1.stakes), pctOf(m1.reserve, m1.stakes)], [0.4, 0.4, 0.3]);
  // everything else stays as it was
  for (const k of Object.keys(FEES)) if (!['roundNodeBps', 'roundDonationBps', 'marketReserveBps'].includes(k)) assert.equal(after[k], FEES_TODAY[k], k);
});

test('the same proposal without the protocol developers\' majority is refused whole: neither the node fee nor the market reserve moves', () => {
  const devKeys = DEVS.map((n) => toHex(pk(n)));
  for (const approvals of [[], [approve(11)], [approve(11), approve(12, false), approve(13, false)], [approve(11), { ...approve(12), signature: new Uint8Array(64) }]]) {
    const out = feeProposalOutcome({ proposal: P, signal, tally, approvals, devKeys, verify });
    assert.equal(out.accepted, false);
    assert.match(out.why, /roundDonationBps.*protocol developers/);
    const now = feesAt({ height: ACTIVATION + 10, accepted: [out] });
    assert.deepEqual([now.roundNodeBps, now.marketReserveBps, now.roundDonationBps], [400, 20, 400], 'not even its valid parts apply');
  }
  // a proposal that touches no donation needs no developer
  const noDonation = { ...P, changes: [{ fee: 'roundNodeBps', value: 350 }, { fee: 'marketReserveBps', value: 30 }] };
  assert.equal(devMajority({ proposalId: feeProposalId(noDonation), approvals: [], devKeys, verify }).majority, false);
  assert.equal(feeProposalOutcome({ proposal: noDonation, signal, tally, approvals: [], devKeys, verify }).accepted, true);
});

test('refused at submission: a market donation of 0, a round total above 10 %, any fee outside its limit, an activation before the vote ends', () => {
  const at = (changes, more = {}) => feeProposalStands({ ...P, changes, ...more });
  assert.match(at([{ fee: 'marketDonationBps', value: 0 }]).why, /marketDonationBps is 0, outside its limit 10\.\.100/);
  assert.match(at([{ fee: 'roundNodeBps', value: 600 }, { fee: 'roundDonationBps', value: 300 }, { fee: 'roundReserveBps', value: 200 }]).why, /1100 bps, above the 1000 bps \(10 %\)/);
  assert.match(at([{ fee: 'roundDonationBps', value: 0 }]).why, /roundDonationBps is 0/);
  assert.match(at([{ fee: 'itemDevsPct', value: 30 }]).why, /come to 90 %, not 100 %/);
  assert.match(at([{ fee: 'marketNodeBps', value: 100 }, { fee: 'marketDonationBps', value: 100 }, { fee: 'marketReserveBps', value: 50 }]).why, /250 bps, above the 200 bps \(2 %\)/);
  assert.match(at([{ fee: 'websitePct', value: 41 }]).why, /websitePct is 41/);
  assert.throws(() => encodeFeeProposal({ ...P, changes: [{ fee: 'slashToPlayersBps', value: 1 }] }), /no proposal changes "slashToPlayersBps"/);
  assert.match(at(P.changes, { activationHeight: PUBLISHED + 10 }).why, /at the earliest, after its signal and its vote/);
  assert.equal(at(P.changes).ok, true);
});
