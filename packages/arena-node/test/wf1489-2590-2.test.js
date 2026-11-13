// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2590 finding 2: the world of funding-vote-book.test.js (the short schedule: a 1-block signal, a 6-block vote).
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
const proposal = (n, purpose) => ({ networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 100, amountSats: 1000n, lnurl: 'dev@bitcoin-arena.io', purpose });
const P1 = proposal(1, 'passes its signal'), P2 = proposal(1, 'fails its signal');
const ID1 = fundingProposalId(P1);
// seasoned (confirmed 50 blocks before the proposal, D1) and locked a year past the vote (full weight, D2)
const bond = (n, sats) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(sats), height: 50, maturity: 100000 });
const vote = (n, choice, txid = 'aa'.repeat(32)) => ({ payload: encodeVote({ proposalId: ID1, choice, signature: schnorr.sign(voteMessage(ID1, choice), sk(n)) }), txid });

function world(extra = {}) {
  const chain = { tip: 100, blocks: new Map(), bonds: [bond(10, 3000), bond(11, 7000)], censusAsked: [] };
  const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
  const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h <= chain.tip ? at(h).hash : null),
    votesAt: async (h) => at(h).votes.map((v) => ({ ...v, height: h })), censusAt: async (net, h) => { chain.censusAsked.push(h); return chain.bonds.map((b) => ({ ...b })); } };
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip,
    isBonded: () => true, activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain, ...extra });
  return { b, chain, at };
}
async function signalled({ b, chain }) {
  await b.add('proposal', hexOf(encodeFundingProposal(P1), ID1, 1));
  await b.add('proposal', hexOf(encodeFundingProposal(P2), fundingProposalId(P2), 1));
  const s = { proposalId: ID1, node: pk(2), atHeight: 100 };
  await b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2));
  chain.tip = 101; await b.decide();                                    // the end seen (kanban #1279: decided decideDepth deep)
  chain.tip = 101 + FUNDING_SCHEDULES.short.decideDepth - 1;
  const d = await b.decide();
  assert.deepEqual(d.map((x) => x.state).sort(), ['failed', 'passed']);
}

// kanban #2590 (attacker audit of the ballot binding), finding 2: A FUNDING ITEM'S AUTHOR CHOOSES WHETHER IT IS VOTED BOUND.
// #2576 binds a funding / fee / leaderboard vote when the proposal's publishedHeight is at or above BALLOT_BIND_HEIGHT - but
// publishedHeight is the author's own field (only "not above tip + 1" is checked). Posted after the gate with publishedHeight one
// below it, the whole vote runs past the gate under the OLD reading (77-byte votes, last by height): the #1490 hole the binding closed
// is open again for his proposal. A bond 11 that voted YES, then replaced it by RBF with NO (mined at 104), is turned back to YES
// by anyone who mines the replaced YES bytes later (105): the vote door signs what boundOf says, and boundOf says "not bound".
const seqVote = (n, choice, seq, txid) => ({ payload: encodeVote({ proposalId: ID1, choice, seq, signature: schnorr.sign(voteMessage(ID1, choice, seq), sk(n)) }), txid });
test('#2590-2: a funding proposal dated below the gate is still voted bound when its vote runs past the gate', async () => {
  const GATE = 103;                                   // P1 says publishedHeight 100; its vote is [101, 107) - blocks 103..106 are past the gate
  const w = world({ bindHeightFor: () => GATE }); await signalled(w);
  const bound = w.b.boundOf(toHex(ID1));
  // what the operator vote door signs for this proposal (server.js /operator/vote asks boundOf): bond 10 YES; bond 11 YES, replaced by NO
  if (bound) {
    w.at(103).votes.push(seqVote(10, CHOICE.YES, 1, 'a1'.repeat(32)));
    w.at(104).votes.push(seqVote(11, CHOICE.NO, 2, 'a2'.repeat(32)));
    w.at(105).votes.push(seqVote(11, CHOICE.YES, 1, 'a3'.repeat(32)));        // the replaced YES, mined later by a stranger
  } else {
    w.at(103).votes.push(vote(10, CHOICE.YES, 'a1'.repeat(32)));
    w.at(104).votes.push(vote(11, CHOICE.NO, 'a2'.repeat(32)));
    w.at(105).votes.push(vote(11, CHOICE.YES, 'a3'.repeat(32)));               // the replaced YES, mined later by a stranger
  }
  w.chain.tip = 111;
  let d = null; for (let i = 0; i < 4 && !d; i++) [d] = await w.b.voteRound();
  console.log('  dated below the gate:', JSON.stringify({ bound, passed: d.passed, yes: d.yesSats, no: d.noSats }));
  assert.equal(bound, true, 'a vote with blocks past the gate is read bound, whatever height its author wrote');
  assert.deepEqual([d.yesSats, d.noSats, d.passed], ['3000', '7000', false], 'bond 11\'s NO stands');
});

test('#2590-2: a vote that ended before the gate keeps the old reading (#2580 unchanged)', async () => {
  const w = world({ bindHeightFor: () => 107 }); await signalled(w);
  assert.equal(w.b.boundOf(toHex(ID1)), false, 'its vote [101, 107) ends before 107');
  const v = world({ bindHeightFor: () => 106 }); await signalled(v);
  assert.equal(v.b.boundOf(toHex(ID1)), true, 'its last voting block 106 is at the gate');
});
