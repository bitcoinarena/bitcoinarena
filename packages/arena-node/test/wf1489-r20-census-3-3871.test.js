// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r20 census-3 (P3 later overwrites earlier, P11-like hidden input; bypass of #1608 / #2432 through the #2629 twin recount):
// a bound proposal's twin (the same body re-signed by the proposer over the same deposit, ruling #2591 (c)) is taken AT ANY TIME, and
// since #2629 taking it undecides the group's decided outcome and recounts it over every twin - also long after the activation height.
// Votes under the twin's id were in the voting blocks all along, but no seat could count them: only the proposer knew that id. So the
// proposer votes NO in the open under A (the proposal FAILS, genesis stays live past the activation), and YES with a higher seq under a
// twin B he keeps to himself. After the activation he posts B: every seat (POST /proposal or the peer pull) recounts, the proposal PASSES,
// and its config becomes live retroactively from the activation height, under rounds the seats already served on genesis. The proposer
// alone picks the outcome after the fact (either way: the same trick flips a PASSED proposal to FAILED).
// SAFE: once a proposal's outcome is decided and its activation height is past, a twin posted afterwards does not change which config
// was live at a height already passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { proposalId, decodeConfigProposalBody, encodeConfigProposalBody, proposalBodyId, encodeVote, voteMessage, CHOICE, CLASS, SCHEDULES, REPEAL_SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
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
function seat({ chain, bound = true, tip, votes = new Map(), during = null }) {
  let tally = null;
  const proposals = createProposals({ confirmedTx: async (txid, block) => { const t = chain.get(txid); return t && t.block === block ? { raw: t.raw, height: t.height } : null; },
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, scheduleFor: () => SCHEDULES.regtest, repealScheduleFor: () => REPEAL_SCHEDULES.regtest,
    historyFor: (net, h) => tally.historyAt(net, h), censusAt: async () => CENSUS, store: { read: () => [], write: () => {} }, bindHeightFor: () => (bound ? 0 : 1e9),
    // this seat's node key is bond 2's (30 of the 50 left after the proposer's): its own sighting in time is the #2700 majority
    seenSigner: { pubkey: schnorr.getPublicKey(sk(2)), sign: (m) => schnorr.sign(m, sk(2)) } });
  // the tally's census read: the first one awaits `during` (a POST /proposal or peer pull landing while the pass waits on the chain)
  tally = createBallotTally({ proposals, tipHeight: async () => tip.at, votesAt: async (h) => (votes.get(h) || []).map((v) => ({ ...v, height: h })),
    censusAt: async () => { if (during.fn) { const f = during.fn; during.fn = null; await f(proposals); } return CENSUS; }, verify, genesisFor: () => GENESIS });
  return { proposals, tally, liveAt: (h) => toHex(tally.historyAt(toHex(NET), h).at(-1).configHash) };
}
const vote = (i, id, choice, seq, txid) => ({ payload: encodeVote({ proposalId: fromHex(id), choice, seq, signature: schnorr.sign(voteMessage(fromHex(id), choice, seq), sk(i)) }), txid });

test('r20 census-3: a twin posted after the activation does not rewrite which config was live at a passed height', async () => {
  const { chain, signed } = deposit(true);
  const tip = { at: 200 };
  const votes = new Map();
  const A = signed(11), B = signed(12);
  const bb = fromHex(B.proposal); const bId = toHex(proposalId({ ...decodeConfigProposalBody(bb.subarray(0, bb.length - 64)), signature: bb.slice(bb.length - 64) }));
  const s = seat({ chain, tip, votes, during: { fn: null } });
  const a = await s.proposals.add(A); assert.equal(a.status, 201, a.why);
  // the proposer's bond (50 of 100): NO seq 1 under A in the open, YES seq 2 under the twin B nobody holds
  votes.set(202, [vote(1, a.id, CHOICE.NO, 1, 'c1'.repeat(32))]);
  votes.set(203, [vote(1, bId, CHOICE.YES, 2, 'c2'.repeat(32))]);
  tip.at = 215;
  for (let i = 0; i < 3; i++) await s.tally.pass();
  const before = s.liveAt(210);
  const rowA = s.tally.list().find((x) => x.id === a.id);
  console.log(`  FACTS: at tip 215 (activation 208) A is ${rowA.phase} passed=${rowA.tally && rowA.tally.passed}; live at 210: ${before.slice(0, 8)} (genesis ${toHex(GENESIS.configHash).slice(0, 8)}, X ${toHex(configHashOf(X)).slice(0, 8)})`);
  assert.equal(before, toHex(GENESIS.configHash), 'the setup: A failed and genesis was live at 210');
  tip.at = 230;
  const b = await s.proposals.add(B);
  for (let i = 0; i < 3; i++) await s.tally.pass();
  const after = s.liveAt(210);
  const rowB = s.tally.list().find((x) => x.id === s.proposals.twinOf(a.id));
  console.log(`  FACTS: B posted at tip 230 -> ${b.status}; group now ${rowB.phase} passed=${rowB.tally && rowB.tally.passed}; live at 210 now ${after.slice(0, 8)}`);
  assert.equal(after, before, `the proposer's twin, shown 22 blocks after the activation, rewrote the config live at 210 from ${before.slice(0, 8)} to ${after.slice(0, 8)}`);
});
