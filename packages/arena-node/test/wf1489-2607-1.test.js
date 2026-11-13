// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2607, ruling #2591 (c): A BOUND PROPOSAL'S IDENTITY IS ITS DEPOSIT'S COMMITMENT (proposer key + body hash). A twin - the same
// body re-signed on the same deposit, another proposal_id - is the SAME proposal: votes under any twin id count for it, the seq rule
// of #2125 (highest seq wins, equal seq with a different choice = ABSTAIN) runs across all twins, #1840 no longer voids the deposit
// for twins, and the seat-local tip check #2590 added for twins is gone. A different body on one deposit (only possible unbound, where
// the deposit commits to nothing) stays void (#1840).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, encodeVote, voteMessage, CHOICE, CLASS, SCHEDULES, REPEAL_SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (fill, outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(fill), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const secret = new Uint8Array(32).fill(1); const proposer = schnorr.getPublicKey(secret);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const G = Uint8Array.of(7, 7, 7), X = Uint8Array.of(1, 2, 3);
const GENESIS = { configHash: configHashOf(G), config: G };
const BLOCK = '20'.repeat(32);
// three voting bonds (50 / 30 / 20), the proposer the first
const sk = (i) => (i === 1 ? secret : new Uint8Array(32).fill(0x30 + i));
const CENSUS = [1, 2, 3].map((i) => ({ pubkey: schnorr.getPublicKey(sk(i)), outpoint: `${String(i).repeat(64)}:0`, bondSats: [0, 50, 30, 20][i] }));

// one deposit at 200 for P: G -> X (regtest 1 / 6 / 1: voting 201-206, activation 208); `aux` picks the signature, the body is the same
function deposit(bound) {
  const chain = new Map();
  const body = { networkId: NET, parent: GENESIS.configHash, configHash: configHashOf(X), config: X, class: CLASS.DESIGN, activationHeight: 208, proposer };
  const outs = depositOutputsExpected(1000, SET).outputs.map((o) => ({ sats: o.sats, script: o.script }));
  const raw = tx(9, bound ? [...outs, { sats: 0, script: depositCommitmentScript(body) }] : outs);
  const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  chain.set(toHex(Uint8Array.from(depositTxid).reverse()), { raw, height: 200, block: BLOCK });
  const signed = (aux, edit = {}) => { const p = { ...body, ...edit, depositTxid };
    return { proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret, new Uint8Array(32).fill(aux))])), blockHash: BLOCK }; };
  return { chain, signed };
}
function seat({ chain, bound = true, tip, votes = new Map() }) {
  let tally = null;
  const proposals = createProposals({ confirmedTx: async (txid, block) => { const t = chain.get(txid); return t && t.block === block ? { raw: t.raw, height: t.height } : null; },
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, scheduleFor: () => SCHEDULES.regtest, repealScheduleFor: () => REPEAL_SCHEDULES.regtest,
    historyFor: (net, h) => tally.historyAt(net, h), censusAt: async () => CENSUS, store: { read: () => [], write: () => {} }, bindHeightFor: () => (bound ? 0 : 1e9) });
  tally = createBallotTally({ proposals, tipHeight: async () => tip.at, votesAt: async (h) => (votes.get(h) || []).map((v) => ({ ...v, height: h })), censusAt: async () => CENSUS, verify, genesisFor: () => GENESIS });
  return { proposals, tally, liveAt: (h) => toHex(tally.historyAt(toHex(NET), h).at(-1).configHash) };
}
const vote = (i, id, choice, seq, txid) => ({ payload: encodeVote({ proposalId: fromHex(id), choice, seq, signature: schnorr.sign(voteMessage(fromHex(id), choice, seq), sk(i)) }), txid });

test('#2607-1: a twin of a passed bound proposal posted after its vote is taken, and the proposal stays passed and live', async () => {
  const { chain, signed } = deposit(true);
  const tip = { at: 300 };
  const { proposals, liveAt } = seat({ chain, tip });
  const a = await proposals.add(signed(1)); assert.equal(a.status, 201, a.why);
  assert.equal(proposals.decide(a.id, { passed: true, decidedAt: 207, anchor: null }), true);
  assert.equal(liveAt(300), toHex(configHashOf(X)));
  const b = await proposals.add(signed(2));                                // tip 300, long after its voting (201-206)
  console.log('  the twin at tip 300:', JSON.stringify({ status: b.status, why: b.why || null, aCounts: proposals.counts(a.id) }));
  assert.equal(b.status, 201, `a twin is the same proposal, taken at any time (no #2590 tip check): ${b.why}`);
  assert.equal(proposals.counts(a.id), true, 'the decided twin stands for both');
  assert.equal(proposals.counts(b.id), false, 'the twin is not counted twice');
  assert.equal(proposals.twinOf(b.id), a.id);
  assert.equal(liveAt(300), toHex(configHashOf(X)), 'X stays live');
});

test('#2607-1: votes under either twin id count for the one proposal, the seq rule across both', async () => {
  const { chain, signed } = deposit(true);
  const tip = { at: 200 };
  const votes = new Map();
  const { proposals, tally, liveAt } = seat({ chain, tip, votes });
  const a = await proposals.add(signed(3)); assert.equal(a.status, 201, a.why);
  const b = await proposals.add(signed(4)); assert.equal(b.status, 201, b.why);
  assert.notEqual(a.id, b.id);
  // bond 1 (50): YES seq 1 under A, NO seq 2 under B -> NO; bond 2 (30): YES seq 4 under A, NO seq 4 under B -> ABSTAIN;
  // bond 3 (20): YES seq 1 under B, YES seq 1 under A (the same choice) -> YES
  votes.set(201, [vote(1, a.id, CHOICE.YES, 1, 'a1'.repeat(32)), vote(2, a.id, CHOICE.YES, 4, 'a2'.repeat(32))]);
  votes.set(202, [vote(1, b.id, CHOICE.NO, 2, 'b1'.repeat(32)), vote(2, b.id, CHOICE.NO, 4, 'b2'.repeat(32)), vote(3, b.id, CHOICE.YES, 1, 'b3'.repeat(32))]);
  votes.set(203, [vote(3, a.id, CHOICE.YES, 1, 'a3'.repeat(32))]);
  tip.at = 220;
  for (let i = 0; i < 3; i++) await tally.pass();
  const rows = tally.list();
  const ra = rows.find((r) => r.id === a.id), rb = rows.find((r) => r.id === b.id);
  const stands = ra.tally ? ra : rb;
  console.log('  the twins:', JSON.stringify({ a: [ra.phase, !!ra.tally], b: [rb.phase, !!rb.tally], tally: stands.tally && { yes: stands.tally.yesSats, no: stands.tally.noSats, abstain: stands.tally.abstainSats, passed: stands.tally.passed } }));
  assert.ok(stands.tally, 'one twin was counted (not both void)');
  assert.deepEqual([stands.tally.yesSats, stands.tally.noSats, stands.tally.abstainSats], ['20', '50', '30']);
  assert.equal(stands.tally.passed, false);
  assert.equal(ra.phase, rb.phase, 'both twins show the one phase');
  assert.equal(ra.phase, 'failed');
  assert.equal(liveAt(220), toHex(configHashOf(G)));
});

test('#2607-1: unbound, two signatures over one deposit still void it (#1840 unchanged where the deposit commits to nothing)', async () => {
  const { chain, signed } = deposit(false);
  const { proposals } = seat({ chain, bound: false, tip: { at: 200 } });
  const a = await proposals.add(signed(5)); assert.equal(a.status, 201, a.why);
  const b = await proposals.add(signed(6, { activationHeight: 209 })); assert.equal(b.status, 201, b.why);   // a different body
  assert.equal(proposals.counts(a.id), false); assert.equal(proposals.counts(b.id), false);
});
