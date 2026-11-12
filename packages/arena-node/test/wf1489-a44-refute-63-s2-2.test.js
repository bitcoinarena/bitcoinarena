// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44-refute-63 skeptic 2 (reload path): a seat whose store predates the hash column (#1749) restarts on f684ec656.
// Its census rows are marked LEGACY and take the first hash found - the original #1749 attack, unchanged: a census read on a
// branch the chain has since left (bond 11 withdrawn by the reorg while the seat ran the old build or was down) is pinned to the
// replacing block and counted for good, while a seat that reads the census now counts without bond 11. A legacy census can be
// derived again from the chain at any time (censusAt is historical); adopting a hash it was never checked against is not needed.
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
const chain = { tip: 100, branch: 1, blocks: new Map() };
const at = (h) => chain.blocks.get(h) || (chain.blocks.set(h, { hash: `${h}`.padStart(64, '0'), votes: [] }), chain.blocks.get(h));
const censusOfBranch = () => (chain.branch === 1 ? [bond(10, 3000), bond(11, 7000)] : [bond(10, 3000)]);
const voteChain = { tipHeight: async () => chain.tip, blockHashAt: async (h) => (h <= chain.tip ? at(h).hash : null),
  votesAt: async (h) => at(h).votes.map((v) => ({ ...v, height: h })), censusAt: async () => censusOfBranch().map((b) => ({ ...b })) };
const seat = (db) => createFundingBook({ db, verify, schedule: FUNDING_SCHEDULES.short, tip: async () => chain.tip,
  isBonded: () => true, activeAt: async (end) => ({ ok: true, nodes: [toHex(pk(2))], fromHeight: end - 432 }), voteChain });
async function signalled(b) {
  await b.add('proposal', hexOf(encodeFundingProposal(P1), ID1, 1));
  const s = { proposalId: ID1, node: pk(2), atHeight: 100 };
  await b.add('signal', hexOf(encodeFundingSignal(s), fundingSignalId(s), 2));
}

test('a44-refute-63 s2: a pre-#1749 census of an abandoned branch is adopted by the replacing block on restart', async () => {
  // the old store: the census table without the hash column, holding branch 1's census at 101 (bond 11 in it)
  const dbA = openStore(':memory:');
  dbA.exec('CREATE TABLE funding_vote_census (proposal TEXT PRIMARY KEY, height INTEGER NOT NULL, census TEXT NOT NULL)');
  const census1 = JSON.stringify(censusOfBranch().map((b) => ({ pubkey: toHex(b.pubkey), outpoint: b.outpoint, bondSats: String(b.bondSats), height: b.height, maturity: b.maturity })));
  dbA.prepare('INSERT INTO funding_vote_census VALUES (?, 101, ?)').run(toHex(ID1), census1);
  // the reorg over 101 happened before the restart: bond 11 withdrawn in the new 101
  chain.branch = 2; for (let h = 101; h <= 106; h++) chain.blocks.set(h, { hash: `${h}`.padStart(62, '0') + 'ee', votes: [] });
  const A = seat(dbA), B = seat(openStore(':memory:'));
  await signalled(A); await signalled(B);
  chain.tip = 101; await A.decide(); await B.decide();
  chain.tip = 106;
  assert.equal((await A.decide())[0].state, 'passed'); assert.equal((await B.decide())[0].state, 'passed');
  at(102).votes.push(vote(10, CHOICE.NO)); at(103).votes.push(vote(11, CHOICE.YES));
  chain.tip = 111;
  for (let i = 0; i < 4; i++) { await A.voteRound(); await B.voteRound(); }
  const outcome = (b) => b.list(111).find((x) => x.id === toHex(ID1)).vote;
  const a = outcome(A), bb = outcome(B);
  assert.equal(bb.state, 'failed', 'on the chain as it is bond 11 is gone: only the NO counts');
  assert.deepEqual([a.state, a.count.totalSats, a.bondsInCensus], [bb.state, bb.count.totalSats, bb.bondsInCensus],
    'a legacy census, never checked against any block, must be read again, not pinned to the first hash found');
});
