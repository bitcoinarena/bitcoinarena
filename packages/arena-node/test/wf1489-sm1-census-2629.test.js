// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1 census-1 (state machine, order / two seats at once): a bound twin (#2607 - the same body re-signed on the same
// deposit) is "taken at any time", and "the one already decided stands for the group, so a twin posted after the outcome never
// moves it". That holds at ONE seat. Seats decide a proposal each on its own pass (every 10 s, a seat restarting or catching up
// later), and a twin reaches each seat when it is posted there or pulled (every 10 min). Votes under the twin's id can sit in
// the voting blocks before any seat holds the twin (its id is known to whoever signed it). A seat that decided BEFORE the twin
// arrived never counts those votes (decided once, the twin not counted); a seat that took the twin before ITS decision counts
// them. The two seats write different outcomes for one proposal, both final, and disagree on the live config from its
// activation on: every round under one config is served by one half and refused (409) by the other.
// Safe behaviour: one proposal, one outcome at every seat that holds its twins.
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
function seat({ chain, bound = true, tip, votes = new Map() }) {
  let tally = null;
  const proposals = createProposals({ confirmedTx: async (txid, block) => { const t = chain.get(txid); return t && t.block === block ? { raw: t.raw, height: t.height } : null; },
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, scheduleFor: () => SCHEDULES.regtest, repealScheduleFor: () => REPEAL_SCHEDULES.regtest,
    historyFor: (net, h) => tally.historyAt(net, h), censusAt: async () => CENSUS, store: { read: () => [], write: () => {} }, bindHeightFor: () => (bound ? 0 : 1e9) });
  tally = createBallotTally({ proposals, tipHeight: async () => tip.at, votesAt: async (h) => (votes.get(h) || []).map((v) => ({ ...v, height: h })), censusAt: async () => CENSUS, verify, genesisFor: () => GENESIS });
  return { proposals, tally, liveAt: (h) => toHex(tally.historyAt(toHex(NET), h).at(-1).configHash) };
}
const vote = (i, id, choice, seq, txid) => ({ payload: encodeVote({ proposalId: fromHex(id), choice, seq, signature: schnorr.sign(voteMessage(fromHex(id), choice, seq), sk(i)) }), txid });

test('wf1489-sm1-census-1: a twin that reaches one seat after its decision and another before it - two outcomes for one proposal', async () => {
  const { chain, signed } = deposit(true);
  const tip = { at: 200 };
  const votes = new Map();
  const s1 = seat({ chain, tip, votes });
  const s2 = seat({ chain, tip, votes });
  const A = signed(11), B = signed(12);
  const a1 = await s1.proposals.add(A); assert.equal(a1.status, 201, a1.why);
  const a2 = await s2.proposals.add(A); assert.equal(a2.status, 201, a2.why);
  // B's id, signed but posted nowhere yet: bonds 1 (50) and 2 (30) vote YES under it in the voting phase (201-206)
  const bb = fromHex(B.proposal); const bId = toHex(proposalId({ ...decodeConfigProposalBody(bb.subarray(0, bb.length - 64)), signature: bb.slice(bb.length - 64) }));
  votes.set(202, [vote(1, bId, CHOICE.YES, 1, 'c1'.repeat(32)), vote(2, bId, CHOICE.YES, 1, 'c2'.repeat(32))]);
  tip.at = 215;
  // seat 1's pass at this tip runs first: the phase is read, A decided (no vote under any twin it holds)
  for (let i = 0; i < 3; i++) await s1.tally.pass();
  // B is posted (to both, or pulled): seat 2 takes it before its own pass at the same tip
  const b1 = await s1.proposals.add(B); assert.equal(b1.status, 201, b1.why);
  const b2 = await s2.proposals.add(B); assert.equal(b2.status, 201, b2.why);
  for (let i = 0; i < 3; i++) { await s1.tally.pass(); await s2.tally.pass(); }
  const st = (s) => { const rows = s.tally.list(); const r = rows.find((x) => x.id === s.proposals.twinOf(a1.id)); return { stands: r.id.slice(0, 8), phase: r.phase, passed: r.tally && r.tally.passed, yes: r.tally && r.tally.yesSats }; };
  const o1 = st(s1), o2 = st(s2);
  console.log('  seat 1:', JSON.stringify(o1), ' seat 2:', JSON.stringify(o2), ' live at 215:', s1.liveAt(215).slice(0, 8), s2.liveAt(215).slice(0, 8));
  assert.equal(o1.passed, o2.passed, 'both seats hold A and B; one proposal must have one outcome');
  assert.equal(s1.liveAt(215), s2.liveAt(215), 'and one live config');
});
