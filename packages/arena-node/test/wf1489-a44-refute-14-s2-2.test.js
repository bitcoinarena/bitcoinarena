// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1633 (audit44 item 14), skeptic 2, failure 2: TWO PASSES AT ONCE, NO REORG AT ALL - one RPC error.
// funding-book.js voteRound, after #2139 (90a7bc523). Fixtures copied from wf1489-a44-refute-14-s1-1.
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
// Two voteRound passes overlap (server.js setInterval 120 s, no guard; a getblock that answers slowly). The slow pass reads on;
// one getblockhash of block 101 fails in its check after the read loop (#2139: "no answer: the rows this pass wrote are not held
// unchecked") and it drops every row from -1 up - while the other pass, whose rows all checked, is between its last-block ask
// and its count. That pass decides from `held` read before the await but counts what the store holds now: nothing. The vote is
// written FAILED, 0 bonds, anchored to block 106, which never moves: no reorg, no attacker, just one slow RPC and one error.

test('wf1489-a44-refute-14-s2-2: overlapping vote passes and one RPC error - the outcome is written on an emptied row set', async () => {
  const chain = { tip: 111, blocks: new Map(), byHash: new Map() };
  const put = (h, votes) => { const hash = `00${String(h).padStart(6, '0')}`.padEnd(64, 'f'); chain.blocks.set(h, hash); chain.byHash.set(hash, votes || []); };
  for (let h = 0; h <= 130; h++) put(h, []);
  put(102, [vote(11, CHOICE.YES)]);                  // the only chain: bond 11 (7000 of 10000) YES at 102
  let release = null, gate = null, armed = false, released = false, failOnce = false, lastAsks = 0;
  const tick = () => new Promise((r) => setImmediate(r));
  const voteChain = { tipHeight: async () => chain.tip,
    blockHashAt: async (h) => {
      await tick();
      if (failOnce && h === 101) { failOnce = false; throw new Error('RPC: work queue depth exceeded'); }
      const x = h > chain.tip ? null : chain.blocks.get(h);
      // the fast pass asks block 106 a third time just before it counts: the slow pass's getblock answers now
      if (released === false && gate && h === 106 && ++lastAsks === 3) { released = true; failOnce = true; release(); for (let i = 0; i < 40; i++) await tick(); }
      return x;
    },
    votesAt: async (h, hash) => {
      if (armed && h === 102) { armed = false; gate = new Promise((r) => { release = r; }); await gate; }   // a slow getblock
      return (chain.byHash.get(hash || chain.blocks.get(h)) || []).map((v) => ({ ...v, height: h }));
    },
    censusAt: async () => [bond(10, 3000), bond(11, 7000)] };
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip,
    isBonded: () => true, activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain, log: (m) => console.log('  LOG', m) });
  await b.add('proposal', hexOf(encodeFundingProposal(P1), ID1, 1));
  const s = { proposalId: ID1, node: pk(2), atHeight: 100 };
  await b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2));
  const t = chain.tip; chain.tip = 101; await b.decide(); chain.tip = 101 + FUNDING_SCHEDULES.short.decideDepth - 1;
  assert.equal((await b.decide())[0].state, 'passed'); chain.tip = t;
  armed = true;
  const slow = b.voteRound();                         // tick N: its getblock of 102 is slow
  for (let i = 0; i < 200 && !gate; i++) await tick();
  assert.ok(gate, 'the slow pass is inside block 102');
  await b.voteRound();                                // tick N+1, while N still runs
  await slow;
  for (let i = 0; i < 4; i++) await b.voteRound();
  chain.tip = 113;
  for (let i = 0; i < 4; i++) await b.voteRound();
  const v = b.list(113).find((x) => x.id === toHex(ID1)).vote;
  console.log('  VOTE:', JSON.stringify({ lastAsks, released, state: v.state, yesSats: v.count && String(v.count.yesSats), noSats: v.count && String(v.count.noSats) }));
  // THE CHAIN (never reorged) HOLDS bond 11's YES at 102: YES 7000 of 10000 - passed at every seat
  assert.equal(v.state, 'passed', `the count must be this chain's (it is ${v.state}, yes ${v.count && v.count.yesSats}, no ${v.count && v.count.noSats})`);
  assert.equal(String(v.count.yesSats), '7000');
});
