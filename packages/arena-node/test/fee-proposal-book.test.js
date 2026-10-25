// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A FEE PROPOSAL AS A SEAT KEEPS AND DECIDES IT: kept as a funding proposal is (refused at submission when its set
// breaks a limit), given the same signal and the same bond-weighted vote, then decided whole - with the protocol developers' majority
// for a donation it changes - and from its activation height on the seat's settlement inputs are the new fees: a version-11 round's
// node fee and website share, and the market rates of an Up/Down version that pays the protocol reserve (v13; v2 keeps its terms).
// The short schedule (a 1-block signal, a 6-block vote) keeps the chain small.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';
import { LockSettlement } from '../src/settlement.js';
import { marketRates } from '../src/order-batch.js';
import { encodeFundingSignal, fundingSignalId, FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { encodeFeeProposal, feeProposalId, encodeFeeApproval, feeApprovalId, FEES_TODAY, roundSplitBps } from '../../arena-protocol/src/fee-proposal.js';
import { encodeVote, voteMessage, CHOICE } from '../../arena-protocol/src/ballot.js';
import { RESERVES_VERSION } from '../../arena-protocol/src/constants.js';
import { reservesEntryExpected } from '../../arena-protocol/src/reserves.js';
import { MANIFEST_V13 } from '../../btc-updown/plugin/btc-updown-v13.js';
import { MANIFEST_V2 } from '../../btc-updown/plugin/btc-updown-v2.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 5; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const S = FUNDING_SCHEDULES.short;
const ACTIVATION = 100 + S.signal + S.vote + S.decideDepth + 10;          // 123
const FP = { networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 100, activationHeight: ACTIVATION,
  changes: [{ fee: 'roundNodeBps', value: 350 }, { fee: 'marketReserveBps', value: 30 }, { fee: 'roundDonationBps', value: 450 }], purpose: 'three areas at once' };
const ID = feeProposalId(FP);
const DEVS = [30, 31, 32];
const bond = (n, sats) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(sats), height: 50, maturity: 100000 });
const vote = (n) => ({ payload: encodeVote({ proposalId: ID, choice: CHOICE.YES, signature: schnorr.sign(voteMessage(ID, CHOICE.YES), sk(n)) }), txid: 'aa'.repeat(32) });
const approval = (n, approve = true) => { const a = { proposalId: ID, dev: pk(n), approve }; return hexOf(encodeFeeApproval(a), feeApprovalId(a), n); };

function world() {
  const chain = { tip: 100, blocks: new Map(), bonds: [bond(10, 3000), bond(11, 7000)] };
  const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
  const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h <= chain.tip ? at(h).hash : null),
    votesAt: async (h) => at(h).votes.map((v) => ({ ...v, height: h })), censusAt: async () => chain.bonds.map((b) => ({ ...b })) };
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: S, tip: async () => chain.tip, isBonded: () => true,
    activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain, devKeysOf: async () => DEVS.map((n) => toHex(pk(n))) });
  return { b, chain, at };
}
// kept, signalled by the one active node, voted YES by both bonds, decided 6 deep
async function throughTheVote(w, approvals = []) {
  const kept = await w.b.add('fee', hexOf(encodeFeeProposal(FP), ID, 1));
  assert.equal(kept.ok, true, kept.why);
  for (const h of approvals) assert.equal((await w.b.add('fee-approval', h)).ok, true);
  const s = { proposalId: ID, node: pk(2), atHeight: 100 };
  assert.equal((await w.b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2))).ok, true);
  w.chain.tip = 101;
  assert.deepEqual((await w.b.decide()).map((x) => x.state), ['passed']);
  w.at(101).votes.push(vote(10), vote(11));
  w.chain.tip = 101 + S.vote + S.decideDepth - 1;
  const [v] = await w.b.voteRound();
  assert.equal(v.passed, true);
  return w.b.decideFees();
}
const v11 = (censusHeight) => ({ protocolVersion: RESERVES_VERSION, stakeMsat: 1000000n, censusHeight });

test('kept, signalled, voted and accepted with 2 of 3 protocol developers: before its height today\'s fees, from it the new ones - in the round and market settlement inputs', async () => {
  const w = world();
  const [d] = await throughTheVote(w, [approval(30), approval(31)]);
  assert.equal(d.accepted, true, d.why);
  assert.equal(d.activationHeight, ACTIVATION);
  assert.deepEqual(w.b.feesAt(ACTIVATION - 1), FEES_TODAY);
  const after = w.b.feesAt(ACTIVATION);
  assert.deepEqual([after.roundNodeBps, after.roundDonationBps, after.roundReserveBps, after.marketReserveBps], [350, 450, 200, 30]);
  // THE SEAT'S SETTLEMENT INPUTS: a version-11 round of each census height, the order book's market rates
  const seat = { feesFor: (c) => w.b.feesAt(Number(c.censusHeight)) };
  assert.deepEqual(LockSettlement.prototype.roundFees.call(seat, v11(ACTIVATION - 1)), { websitePct: 10, feeBps: 400 });
  assert.deepEqual(LockSettlement.prototype.roundFees.call(seat, v11(ACTIVATION)), { websitePct: 10, feeBps: 350 });
  assert.deepEqual(LockSettlement.prototype.roundFees.call(seat, { protocolVersion: 3, stakeMsat: 1000000n, censusHeight: ACTIVATION }), { websitePct: 10 }, 'an older round keeps its own node fee');
  assert.deepEqual(marketRates(MANIFEST_V13, w.b.feesAt(ACTIVATION - 1)), { feeBps: 100, nodeBps: 40, donationBps: 60, reserveBps: 20, websitePct: 10 });
  assert.deepEqual(marketRates(MANIFEST_V13, w.b.feesAt(ACTIVATION)), { feeBps: 110, nodeBps: 40, donationBps: 70, reserveBps: 30, websitePct: 10 });
  assert.deepEqual(marketRates(MANIFEST_V2, w.b.feesAt(ACTIVATION)), { feeBps: 100, nodeBps: 50, donationBps: 50, reserveBps: 0, websitePct: 10 }, 'v2 pays no reserve: its own terms');
  // an entry to a version-11 round of that height must pay the new split, and the old one is refused by name
  const split = roundSplitBps(after);
  const key = Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x77)]);
  const entry = { stakeMsat: 1000000n, feeMsat: 40000n, donationMsat: 60000n, reserveOutpoint: { txid: new Uint8Array(32).fill(1), outIdx: 0n } };
  assert.match(reservesEntryExpected({ entry, recipients: null, reserveKey: key, split }).why, /node fee is 35000 msat \(3\.5 %\), not 40000/);
  // and GET /fees' list shows it decided
  const [row] = w.b.feeList(ACTIVATION);
  assert.deepEqual([row.needsDevs, row.devs.length, row.decision.accepted, row.changes.map((c) => `${c.fee} ${c.from}->${c.to}`).join(', ')],
    [true, 2, true, 'roundNodeBps 400->350, roundDonationBps 400->450, marketReserveBps 20->30']);
});

test('without the protocol developers\' majority the seat refuses it whole; refused at submission when its set breaks a limit', async () => {
  const w = world();
  const [d] = await throughTheVote(w, [approval(30), approval(31, false)]);
  assert.equal(d.accepted, false);
  assert.match(d.why, /1 of 3 protocol developers approve it/);
  const now = w.b.feesAt(ACTIVATION + 100);
  assert.deepEqual([now.roundNodeBps, now.marketReserveBps, now.roundDonationBps], [400, 20, 400], 'not even its valid parts');
  // at submission
  const bad = { ...FP, changes: [{ fee: 'marketDonationBps', value: 0 }] };
  const r = await w.b.add('fee', hexOf(encodeFeeProposal(bad), feeProposalId(bad), 1));
  assert.deepEqual([r.ok, r.status], [false, 422]);
  assert.match(r.why, /marketDonationBps is 0/);
  const over = { ...FP, changes: [{ fee: 'roundNodeBps', value: 600 }, { fee: 'roundDonationBps', value: 300 }, { fee: 'roundReserveBps', value: 200 }] };
  assert.match((await w.b.add('fee', hexOf(encodeFeeProposal(over), feeProposalId(over), 1))).why, /above the 1000 bps/);
  // an approval of a proposal this seat does not hold
  const stray = { proposalId: new Uint8Array(32).fill(9), dev: pk(30), approve: true };
  assert.equal((await w.b.add('fee-approval', hexOf(encodeFeeApproval(stray), feeApprovalId(stray), 30))).status, 404);
});
