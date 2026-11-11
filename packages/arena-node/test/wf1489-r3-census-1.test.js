// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 3 (census/ballot): a stranger who knows a public proposal id fills blocks of its voting phase with vote outputs
// carrying that id's 8-byte prefix and junk signatures. Every seat's ballot tally verifies each such vote against EVERY bond of the
// census, and re-runs the whole tally - every vote of the phase read so far - on each new block that holds a vote. The safe behaviour:
// a (vote, bond) pair is checked at most once over the phase; work grows with the votes, never with votes x blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const H = (b) => new Uint8Array(32).fill(b);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31), B = key(0x32), C = key(0x33);
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }, { pubkey: B.pubkey, outpoint: 'bb:0', bondSats: 30000000n },
  { pubkey: C.pubkey, outpoint: 'cc:0', bondSats: 20000000n }];

function kept(publishedAt = 100) {
  const net = H(0x4e), review = 1, voting = 6, cooldown = 1;
  const activationHeight = publishedAt + review + voting + cooldown;
  const p = { networkId: net, parent: BALLOT_GENESIS.configHash, configHash: H(0x22), config: Uint8Array.of(2), class: CLASS.DESIGN, activationHeight, proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  return { idBytes, record: { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: toHex(net),
    parent: toHex(p.parent), configHash: toHex(p.configHash), class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt,
    depositSats: '1000', votingFrom: publishedAt + review, votingUntil: publishedAt + review + voting, activationHeight, repeal: false } };
}

test('#1489 r3 census-1: junk votes with a proposal\'s public prefix are verified again on every later block of the phase', async () => {
  const { idBytes, record } = kept();
  const held = new Map([[record.id, record]]);
  const proposals = { list: () => [...held.values()], decide: (id, o) => { const h = held.get(id); if (!h || h.decided) return false; held.set(id, { ...h, decided: o }); return true; } };
  // block 101: 300 junk votes (the stranger's: prefix of the public id, 64 random bytes); 102..106: one honest vote each
  const JUNK = 300;
  const junk = Array.from({ length: JUNK }, (_, i) => {
    const sig = new Uint8Array(64); for (let j = 0; j < 64; j++) sig[j] = (i * 31 + j * 7 + 1) & 0xff;
    return { payload: encodeVote({ proposalId: idBytes, choice: CHOICE.YES, signature: sig }), height: 101, txid: `j${String(i).padStart(4, '0')}` };
  });
  const honest = (who, h, choice) => ({ payload: encodeVote({ proposalId: idBytes, choice, signature: schnorr.sign(voteMessage(idBytes, choice), who.secret) }), height: h, txid: `h${h}` });
  const votes = new Map([[101, junk], [102, [honest(A, 102, CHOICE.YES)]], [103, [honest(B, 103, CHOICE.NO)]], [104, [honest(C, 104, CHOICE.YES)]],
    [105, [honest(B, 105, CHOICE.YES)]], [106, [honest(C, 106, CHOICE.NO)]]]);
  let verifies = 0;
  const verify = (s, m, k) => { verifies++; try { return schnorr.verify(s, m, k); } catch { return false; } };
  let tip = 100;
  const t = createBallotTally({ proposals, tipHeight: async () => tip, votesAt: async (h) => votes.get(h) || [], censusAt: async () => CENSUS, verify,
    decideDepthFor: () => 1, minDecideDepthFor: () => 1, genesisFor: () => BALLOT_GENESIS });
  for (tip = 100; tip <= 106; tip++) await t.pass();          // one pass per block, as a seat runs it
  const done = t.list()[0];
  const allVotes = JUNK + 5;
  const once = allVotes * CENSUS.length;                     // every (vote, bond) pair checked once
  console.log(`  verify calls: ${verifies} for ${allVotes} votes x ${CENSUS.length} bonds (once each: ${once}); outcome ${done.tally && done.tally.passed}`);
  assert.ok(done.tally, 'the proposal was counted');
  assert.ok(verifies <= once, `the junk votes were verified ${verifies} times - ${Math.round(verifies / once)}x the ${once} pairs there are: each later block of the phase pays them again`);
});
