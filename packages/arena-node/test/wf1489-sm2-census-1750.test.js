// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit round 2 (census area), finding 5: the funding vote's outcome is held to the hash of its last
// voting block (funding_vote_outcomes.last_hash), and reopened only `if (onChain && decided.lastHash && onChain !== decided.lastHash)`.
// The hash is read with voteChain.blockHashAt - server.js hands it ballot.blockHashAt, which answers null on ANY RPC error (a full
// work queue, a timeout). A read that failed in the deciding pass writes the outcome with last_hash NULL, and from then on no reorg
// of the counted block ever reopens it: this seat keeps PASSED while every other seat counts the new chain's votes.
// Fixtures copied from funding-vote-book.test.js.
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

test('wf1489 sm2 census-5: an RPC error in the deciding pass writes the vote with no anchor, and a reorg of its counted block never reopens it', async () => {
  const chain = { tip: 100, blocks: new Map(), rpcDown: new Set() };
  const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
  // ballot.blockHashAt as main.js builds it: `try { getblockhash } catch { return null }` - an RPC error reads as null
  const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (chain.rpcDown.has(h) || h > chain.tip ? null : at(h).hash),
    votesAt: async (h) => at(h).votes.map((v) => ({ ...v, height: h })), censusAt: async () => [bond(10, 3000), bond(11, 7000)] };
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip,
    isBonded: () => true, activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain });
  await b.add('proposal', hexOf(encodeFundingProposal(P1), ID1, 1));
  const s = { proposalId: ID1, node: pk(2), atHeight: 100 };
  await b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2));
  chain.tip = 101; await b.decide();
  chain.tip = 101 + FUNDING_SCHEDULES.short.decideDepth - 1;
  assert.equal((await b.decide())[0].state, 'passed');
  at(101).votes.push(vote(10, CHOICE.YES)); at(106).votes.push(vote(11, CHOICE.YES));
  chain.tip = 110;
  for (let i = 0; i < 3; i++) await b.voteRound();
  // the deciding pass: getblockhash for the last voting block (106) fails this once (bitcoind's work queue full)
  chain.tip = 111; chain.rpcDown.add(106);
  const [d] = await b.voteRound();
  chain.rpcDown.clear();
  // kanban #1750: the pass whose anchor read failed decides nothing (before the fix it wrote PASSED with last_hash NULL)
  assert.ok(!d || d.lastHash, `a vote decided with no anchor: ${JSON.stringify(d && { passed: d.passed, lastHash: d.lastHash })}`);
  // a reorg replaces block 106: bond 11 votes NO there - every seat that reads this chain counts YES 3000, NO 7000: failed
  chain.blocks.set(106, { hash: 'ff'.repeat(32), votes: [vote(11, CHOICE.NO)] });
  chain.tip = 112;
  for (let i = 0; i < 3; i++) await b.voteRound();
  const v = b.list(112).find((x) => x.id === toHex(ID1)).vote;
  assert.equal(v.state, 'failed', `the counted last block was reorged away: the vote must be counted again (it stays ${v.state}, yes ${v.count.yesSats})`);
});

test('kanban #1750: a vote a store already holds with no anchor (written before the fix) is counted again, and follows a reorg', async () => {
  const chain = { tip: 100, blocks: new Map() };
  const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
  const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h > chain.tip ? null : at(h).hash),
    votesAt: async (h) => at(h).votes.map((v) => ({ ...v, height: h })), censusAt: async () => [bond(10, 3000), bond(11, 7000)] };
  const db = openStore(':memory:');
  const b = createFundingBook({ db, verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip,
    isBonded: () => true, activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain });
  await b.add('proposal', hexOf(encodeFundingProposal(P1), ID1, 1));
  const s = { proposalId: ID1, node: pk(2), atHeight: 100 };
  await b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2));
  chain.tip = 101; await b.decide();
  chain.tip = 101 + FUNDING_SCHEDULES.short.decideDepth - 1;
  assert.equal((await b.decide())[0].state, 'passed');
  at(101).votes.push(vote(10, CHOICE.YES)); at(106).votes.push(vote(11, CHOICE.YES));
  chain.tip = 111;
  for (let i = 0; i < 4; i++) await b.voteRound();
  assert.equal(b.list(111).find((x) => x.id === toHex(ID1)).vote.state, 'passed');
  // the state an older build left: the outcome and the counted last block held with no hash
  db.prepare('UPDATE funding_vote_outcomes SET last_hash = NULL').run();
  db.prepare('UPDATE funding_vote_blocks SET hash = NULL WHERE height = 106').run();
  chain.blocks.set(106, { hash: 'ff'.repeat(32), votes: [vote(11, CHOICE.NO)] });
  chain.tip = 112;
  for (let i = 0; i < 3; i++) await b.voteRound();
  const v = b.list(112).find((x) => x.id === toHex(ID1)).vote;
  assert.equal(v.state, 'failed', `an unanchored outcome must be counted again on this chain (it stays ${v.state})`);
  assert.equal(db.prepare('SELECT last_hash FROM funding_vote_outcomes').get().last_hash, 'ff'.repeat(32));
});
