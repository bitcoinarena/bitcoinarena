// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r2 census-2 (the #1564 hole, still open in the funding / fee / leaderboard vote): ballot-tally.js checks each vote
// once and drops junk, but funding-book.js voteRound stores EVERY vote output under a proposal's id prefix in
// funding_vote_blocks (junk signatures included, no bound) and countOf re-runs fundingTally - one BIP-340 check per stored vote
// per voting bond - on every call. GET /funding (public, no auth) calls list() -> voteView -> countOf for every open vote, so a
// stranger who fills the vote's blocks with junk under a public proposal id makes every GET /funding cost
// (junk votes x census) signature checks on the seat's event loop, again and again, and the rows grow for good.
// SAFE: a junk vote (signed by no bond of the census) is not kept, or is checked once - a read of the funding list does not
// verify it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook } from '../src/funding-book.js';
import { encodeFundingProposal, fundingProposalId, encodeFundingSignal, fundingSignalId, FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { CHOICE } from '../../arena-protocol/src/ballot.js';
import { toHex } from '../../arena-protocol/src/hash.js';

let verifies = 0;
const verify = (s, m, k) => { verifies++; try { return schnorr.verify(s, m, k); } catch { return false; } };
const sk = (n) => { const b = new Uint8Array(32); b[0] = 3; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const P1 = { networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 100, amountSats: 1000n, lnurl: 'dev@bitcoin-arena.io', purpose: 'passes its signal' };
const ID1 = fundingProposalId(P1);
const bond = (n, sats) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(sats), height: 50, maturity: 100000 });
/** A junk 77-byte vote under ID1's prefix: random-looking bytes as its signature. */
const junk = (i) => {
  const payload = new Uint8Array(77);
  payload.set([0x41, 0x52, 0x4e, 0x56], 0); payload.set(ID1.subarray(0, 8), 4); payload[12] = CHOICE.YES;
  for (let j = 0; j < 64; j++) payload[13 + j] = (i * 31 + j * 7 + 1) & 0xff;
  payload[13] = 0x11; payload[45] = 0x22;
  return { payload, txid: i.toString(16).padStart(64, '0') };
};

test('wf1489 r2 census-2: junk votes under a funding proposal prefix are not re-verified on every GET /funding', async () => {
  const chain = { tip: 100, blocks: new Map(), bonds: Array.from({ length: 10 }, (_, i) => bond(10 + i, 5000)) };
  const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
  const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h <= chain.tip ? at(h).hash : null),
    votesAt: async (h) => at(h).votes.map((v) => ({ ...v, height: h })), censusAt: async () => chain.bonds.map((b) => ({ ...b })) };
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip,
    isBonded: () => true, activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain });
  await b.add('proposal', hexOf(encodeFundingProposal(P1), ID1, 1));
  const s = { proposalId: ID1, node: pk(2), atHeight: 100 };
  await b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2));
  chain.tip = 101; await b.decide();
  chain.tip = 101 + FUNDING_SCHEDULES.short.decideDepth - 1; await b.decide();
  const JUNK = 400;
  for (let i = 0; i < JUNK; i++) at(101).votes.push(junk(i));
  chain.tip = 103;
  await b.voteRound();
  const view = b.list(103).find((x) => x.id === toHex(ID1)).vote;
  assert.equal(view.state, 'voting');
  verifies = 0;
  const READS = 5;
  const t0 = Date.now();
  for (let i = 0; i < READS; i++) b.list(103);                         // what GET /funding runs, once per request
  const ms = Date.now() - t0;
  console.log(`  ${JUNK} junk votes in one block, ${chain.bonds.length} voting bonds: ${READS} reads of the funding list ran ${verifies} signature checks in ${ms} ms`
    + ` (${(ms / READS).toFixed(0)} ms per GET /funding)`);
  assert.ok(verifies <= 2 * chain.bonds.length,
    `${READS} reads of the funding list re-verified the stored junk ${verifies} times (${verifies / READS} per GET /funding)`);
});
