// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HIJACK DEFENCES AS A SEAT KEEPS THEM (§27A.9.52026-10-17 "Take D1-D6 as proposed"): a passed vote pays only
// after its 2-week delay (6 blocks on the short schedule), and a NO in that window - or a YES turned NO - cancels the payment (D5); a
// large payment goes in 4 tranches, each re-counted and cancellable; the signal counts only active nodes with a seasoned bond (D6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { createFundingBook, trancheIdOf } from '../src/funding-book.js';
import { encodeFundingProposal, fundingProposalId, encodeFundingSignal, fundingSignalId, FUNDING_SCHEDULES } from '../../arena-protocol/src/funding.js';
import { encodeVote, voteMessage, CHOICE } from '../../arena-protocol/src/ballot.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => schnorr.verify(s, m, k);
const sk = (n) => { const b = new Uint8Array(32); b[0] = 4; b[31] = n; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const P = { networkId: new Uint8Array(32).fill(7), author: pk(42), publishedHeight: 100, amountSats: 1000n, lnurl: 'anyone@example.org', purpose: 'A faucet' };
const ID = fundingProposalId(P), IDH = toHex(ID);
const bond = (n, sats) => ({ pubkey: pk(n), outpoint: `${n.toString(16).padStart(2, '0').repeat(32)}:0`, bondSats: BigInt(sats), height: 50, maturity: 100000 });
const vote = (n, choice) => ({ payload: encodeVote({ proposalId: ID, choice, signature: schnorr.sign(voteMessage(ID, choice), sk(n)) }), txid: 'aa'.repeat(32) });

function world({ seasoned = [2] } = {}) {
  const chain = { tip: 100, blocks: new Map(), bonds: [bond(10, 3000), bond(11, 7000)] };
  const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
  const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h <= chain.tip ? at(h).hash : null),
    votesAt: async (h) => at(h).votes.map((v) => ({ ...v, height: h })), censusAt: async () => chain.bonds.map((b) => ({ ...b })) };
  const b = createFundingBook({ db: openStore(':memory:'), verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip, isBonded: () => true,
    activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2)), toHex(pk(3))], fromHeight: end - 432 }), voteChain,
    seasonedNodes: async () => seasoned.map((n) => toHex(pk(n))) });
  return { b, chain, at };
}
async function passedVote(w) {
  await w.b.add('proposal', hexOf(encodeFundingProposal(P), ID, 42));
  const s = { proposalId: ID, node: pk(2), atHeight: 100 };
  await w.b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2));
  w.chain.tip = 101; const [d] = await w.b.decide();
  w.at(101).votes.push(vote(10, CHOICE.YES), vote(11, CHOICE.YES));
  return d;
}
const roundTo = async (w, tip) => { w.chain.tip = tip; for (let i = 0; i < 4; i++) await w.b.voteRound(); };

test('D6: a signal from an active node without a seasoned bond does not count; with one it does', async () => {
  const fresh = world({ seasoned: [3] });
  assert.equal((await passedVote(fresh)).state, 'failed', 'node 2 is active but not seasoned: 0 of 1 seasoned active node');
  const ok = world({ seasoned: [2, 3] });
  const d = await passedVote(ok);
  assert.deepEqual([d.state, d.supporters, d.active], ['passed', 1, 2]);
});

test('D5: nothing is paid before the delay; then one payment', async () => {
  const w = world(); await passedVote(w);
  await roundTo(w, 111);
  assert.equal(w.b.list(111)[0].vote.state, 'passed');
  assert.deepEqual(w.b.payments({ tip: 111, reservesSatsOf: () => 1_000_000n }), [], 'decided at 111: still in the delay');
  await roundTo(w, 116);
  assert.deepEqual(w.b.payments({ tip: 116 }), [], 'due at 112, payable once 6 deep (117)');
  await roundTo(w, 117);
  const [p] = w.b.payments({ tip: 117 });
  assert.deepEqual([p.id, p.k, p.of, p.amountSats, p.lnurl, p.decidableAt], [IDH, 0, 1, 1000n, 'anyone@example.org', 117]);
});

test('D5 veto: a YES turned NO inside the delay cancels the payment for good', async () => {
  const w = world(); await passedVote(w);
  await roundTo(w, 111);
  w.b.payments({ tip: 111, reservesSatsOf: () => 1_000_000n });
  w.at(112).votes.push(vote(11, CHOICE.NO));                       // bond 11 (70 %) turns to NO in the delay window, in its due block
  await roundTo(w, 117);
  assert.deepEqual(w.b.payments({ tip: 117 }), []);
  const listed = w.b.list(117)[0];
  assert.match(listed.cancelled, /payment 1 of 1 cancelled at its due block 112: YES 30 % of YES \+ NO/);
  assert.deepEqual(w.b.payments({ tip: 200 }), [], 'and it stays cancelled');
});

test('D5 tranches: more than 1 % of the reserves goes in 4 tranches; a NO after the second cancels the third and fourth', async () => {
  const w = world(); await passedVote(w);
  await roundTo(w, 111);
  assert.deepEqual(w.b.payments({ tip: 111, reservesSatsOf: () => 50_000n }), [], 'the tranche count is fixed at the first ask: 1000 > 1 % of 50000');
  await roundTo(w, 123);
  const two = w.b.payments({ tip: 123 });
  assert.deepEqual(two.map((t) => [t.k, t.of, t.amountSats, t.dueAt]), [[0, 4, 250n, 112], [1, 4, 250n, 118]]);
  assert.deepEqual(two.map((t) => t.id), [trancheIdOf(IDH, 0, 4), trancheIdOf(IDH, 1, 4)]);
  w.at(124).votes.push(vote(11, CHOICE.NO));                       // a new block after the second tranche, the third's due block
  await roundTo(w, 140);
  const after = w.b.payments({ tip: 140 });
  assert.deepEqual(after.map((t) => t.k), [0, 1], 'the paid tranches stay listed (their records stand); 3 and 4 are cancelled');
  assert.match(w.b.list(140)[0].cancelled, /payment 3 of 4 cancelled at its due block 124/);
});
