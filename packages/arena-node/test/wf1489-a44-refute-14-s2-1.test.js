// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1633 (audit44 item 14), skeptic 2, failure 1: TWO PASSES AT ONCE.
// funding-book.js voteRound, after #2139 (90a7bc523).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';
import { encodeFundingProposal, fundingProposalId, encodeFundingSignal, fundingSignalId, FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { encodeVote, voteMessage, CHOICE } from '../../arena-protocol/src/ballot.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 3; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const P1 = { networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 100, amountSats: 1000n, lnurl: 'dev@bitcoin-arena.io', purpose: 'passes its signal' };
const ID1 = fundingProposalId(P1);
const bond = (n, sats) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(sats), height: 50, maturity: 100000 });
const vote = (n, choice) => ({ payload: encodeVote({ proposalId: ID1, choice, signature: schnorr.sign(voteMessage(ID1, choice), sk(n)) }), txid: 'aa'.repeat(32) });
// server.js runs decide -> voteRound -> decideFees -> payouts every 120 s with setInterval and no guard; funding-book voteRound
// has no `running` flag (ballot-tally pass has one). A pass that outlives 120 s (bitcoind holds cs_main through a reorg, a
// stalled RPC, a slow payout chain) overlaps the next. The #2139 check after the read loop holds only the rows ONE pass wrote
// against ITS OWN `decided`: a slow pass that asked block 102's hash on branch A before a reorg writes A's row (INSERT OR
// REPLACE) after the other pass checked its rows, and drops rows 102 up while that pass counts - the outcome is written on A's NO
// or on a row set with blocks missing (its decide reads `held` from before the await, countOf reads the store). The slow
// pass then finds the moved row but drops no outcome (its own `decided` was null), and the anchor (B's last block) never moves.

test('wf1489-a44-refute-14-s2-1: two overlapping vote passes - the slow one writes the abandoned branch\'s block into the other\'s count', async () => {
  const chain = { tip: 111, branch: 0, blocks: new Map(), byHash: new Map() };
  const put = (h, votes) => { const hash = `${String(chain.branch).padStart(2, '0')}${String(h).padStart(6, '0')}`.padEnd(64, 'f'); chain.blocks.set(h, hash); chain.byHash.set(hash, votes || []); };
  for (let h = 0; h <= 130; h++) put(h, []);
  const fork = (at, votes) => { chain.branch++; for (let h = at; h <= 130; h++) put(h, votes.get(h)); };
  put(102, [vote(11, CHOICE.NO)]);                   // BRANCH A: bond 11 (7000 of 10000) NO at 102
  const A102 = chain.blocks.get(102);
  let release = null, gate = null, armed = false, forked = false, lastAsks = 0;
  const tick = () => new Promise((r) => setImmediate(r));
  const voteChain = { tipHeight: async () => chain.tip,
    blockHashAt: async (h) => {
      await tick();
      const x = h > chain.tip ? null : chain.blocks.get(h);
      // the fast pass asks the last voting block (106) a third time just before it counts: the slow pass's read lands now
      if (forked && h === 106 && ++lastAsks === 3 && release) { release(); for (let i = 0; i < 20; i++) await tick(); }
      return x;
    },
    votesAt: async (h, hash) => {
      // the SLOW pass: block 102's votes asked by A's hash, answered only later (a stalled RPC)
      if (armed && h === 102 && hash === A102) { armed = false; gate = new Promise((r) => { release = r; }); await gate; }
      return (chain.byHash.get(hash || chain.blocks.get(h)) || []).map((v) => ({ ...v, height: h }));
    },
    censusAt: async () => [bond(10, 3000), bond(11, 7000)] };
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip,
    isBonded: () => true, activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain, log: (m) => console.log("  LOG", m) });
  await b.add('proposal', hexOf(encodeFundingProposal(P1), ID1, 1));
  const s = { proposalId: ID1, node: pk(2), atHeight: 100 };
  await b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2));
  const t = chain.tip; chain.tip = 101; await b.decide(); chain.tip = 101 + FUNDING_SCHEDULES.short.decideDepth - 1;
  assert.equal((await b.decide())[0].state, 'passed'); chain.tip = t;
  armed = true;
  const slow = b.voteRound();                         // the 120 s tick N: stalls in block 102's votes on branch A
  for (let i = 0; i < 200 && !gate; i++) await tick();
  assert.ok(gate, 'the slow pass is inside block 102 on branch A');
  fork(102, new Map([[102, [vote(11, CHOICE.YES)]]])); forked = true;  // a stranger's branch B: bond 11's YES at 102
  await b.voteRound();                                // tick N+1, while N still runs
  await slow;
  for (let i = 0; i < 4; i++) await b.voteRound();
  chain.tip = 113;
  for (let i = 0; i < 4; i++) await b.voteRound();
  const v = b.list(113).find((x) => x.id === toHex(ID1)).vote;
  console.log('  VOTE:', JSON.stringify({ lastAsks, state: v.state, yesSats: v.count && String(v.count.yesSats), noSats: v.count && String(v.count.noSats) }));
  // THIS CHAIN (branch B) HOLDS bond 11's YES at 102: YES 7000 of 10000, NO 0 - passed at every seat that read the phase once.
  // Here the outcome is written while the slow pass holds A's row 102 (NO) or has just dropped rows 102-106 (nothing counted):
  // FAILED, anchored to B's block 106, which never moves - this seat refuses the tranches every other seat pays
  assert.equal(v.state, 'passed', `the count must be this chain's (it is ${v.state}, yes ${v.count && v.count.yesSats}, no ${v.count && v.count.noSats})`);
  assert.equal(String(v.count.yesSats), '7000');
});
