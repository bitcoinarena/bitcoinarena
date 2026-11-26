// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit census a8-1-1: the ballot tally's vote cache (ballot-tally.js votesByHeight) keeps EVERY vote-shaped OP_RETURN output of every
// block read for an open voting phase, for as long as that phase is open - junk under no proposal's prefix, junk no bond signed, all of it.
// #1564 / #2671 bounded the signature checks of junk votes; nothing bounds what is held. A stranger (no bond, no key) puts vote-shaped
// 80-byte OP_RETURN outputs ("ARN" 'K' + any 76 bytes with a valid choice byte) into the blocks of a proposal's voting phase (mainnet 1,440
// blocks; on testnet4 a stranger can mine min-difficulty blocks himself), and every seat that counts the ballot holds each of them in memory
// until the phase ends - and after a restart reads them all back again from the phase's first block.
// SAFE: a vote that no open proposal keeps (keepVote 'other' / 'junk') is not held after the pass that read it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, CLASS } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

const H = (b) => new Uint8Array(32).fill(b);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31);
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 1000000n }];

function kept(publishedAt = 100) {
  const p = { networkId: H(0x4e), parent: BALLOT_GENESIS.configHash, configHash: H(0x22), config: Uint8Array.of(2), class: CLASS.DESIGN,
    activationHeight: publishedAt + 3000, proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  return { idBytes, record: { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: toHex(H(0x4e)),
    parent: toHex(p.parent), configHash: toHex(p.configHash), class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt, depositSats: '1000',
    votingFrom: publishedAt + 1, votingUntil: publishedAt + 1441, activationHeight: p.activationHeight, repeal: false } };
}

/** A stranger's vote-shaped output: "ARN" 'K', a prefix of no proposal, YES, seq, key prefix, 64 junk bytes - decodeVote takes it. */
function strangerVote(i, height) {
  const payload = new Uint8Array(80);
  payload.set([0x41, 0x52, 0x4e, 0x4b], 0);
  payload.set([0xde, 0xad, (i >> 8) & 0xff, i & 0xff], 4);
  payload[8] = 1;                                  // YES
  for (let j = 9; j < 80; j++) payload[j] = (i * 31 + j * 7 + height) & 0xff;
  return { payload, height, txid: (height * 100000 + i).toString(16).padStart(64, '0') };
}

test('audit census a8-1-1: vote outputs no open proposal keeps are not held by the tally after the pass that read them', async () => {
  const { record } = kept();
  const PER_BLOCK = 2000, BLOCKS = 40;
  const refs = [];
  const held = new Map([[record.id, record]]);
  const proposals = { list: () => [...held.values()], decide: () => true, bound: () => true, keyed: () => true };
  const t = createBallotTally({ proposals, tipHeight: async () => 101 + BLOCKS, censusAt: async () => CENSUS,
    votesAt: async (h) => { const out = []; for (let i = 0; i < PER_BLOCK; i++) { const v = strangerVote(i, h); refs.push(new WeakRef(v.payload)); out.push(v); } return out; },
    verify: () => false, decideDepthFor: () => 1, minDecideDepthFor: () => 1, genesisFor: () => BALLOT_GENESIS });
  const before = process.memoryUsage();
  await t.pass();
  for (let i = 0; i < 4; i++) { gc(); await new Promise((r) => setImmediate(r)); }
  const after = process.memoryUsage();
  const alive = refs.filter((r) => r.deref() !== undefined).length;
  const row = t.list().find((x) => x.id === record.id);
  console.log(`  ${refs.length} stranger vote outputs over ${BLOCKS} blocks of an open phase (${row && row.phase}); still held after the pass and gc: ${alive}; `
    + `heap ${(before.heapUsed / 1e6).toFixed(1)} -> ${(after.heapUsed / 1e6).toFixed(1)} MB, arrayBuffers ${(before.arrayBuffers / 1e6).toFixed(1)} -> ${(after.arrayBuffers / 1e6).toFixed(1)} MB`);
  assert.equal(row && row.phase, 'voting', 'the proposal is still in its voting phase');
  assert.ok(alive <= PER_BLOCK, `the tally still holds ${alive} of ${refs.length} vote outputs that no proposal keeps (votesByHeight): `
    + 'a stranger\'s vote-shaped outputs stay in every counting seat\'s memory for the whole voting phase');
});

// THE SAME TALLY AS BEFORE (kanban #3728): two proposals voting in the same blocks, the second one's census not readable on the first
// pass, junk under both prefixes (over the per-block hold for an unsorted count too) - each block is still read once while every count
// can take it from the cache, every honest vote counts, and the outcome is the one a seat that held every output would write.
test('audit census a8-1-1: with two proposals sharing their blocks every honest vote counts and the held cache is only kept votes', async () => {
  const { encodeVote, voteMessage, CHOICE } = await import('../../arena-protocol/src/ballot.js');
  const B = key(0x32), C = key(0x33);
  const census = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50n }, { pubkey: B.pubkey, outpoint: 'bb:0', bondSats: 30n }, { pubkey: C.pubkey, outpoint: 'cc:0', bondSats: 20n }];
  const mk = (cfg, publishedAt) => {
    const p = { networkId: H(0x4e), parent: BALLOT_GENESIS.configHash, configHash: H(cfg), config: Uint8Array.of(cfg), class: CLASS.DESIGN,
      activationHeight: publishedAt + 8, proposer: A.pubkey, depositTxid: H(cfg) };
    const signature = schnorr.sign(proposalBodyId(p), A.secret);
    const idBytes = proposalId({ ...p, signature });
    return { idBytes, record: { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: toHex(H(0x4e)),
      parent: toHex(p.parent), configHash: toHex(p.configHash), class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt, depositSats: '1000',
      votingFrom: publishedAt + 1, votingUntil: publishedAt + 7, activationHeight: p.activationHeight, repeal: false } };
  };
  const P = mk(0x22, 100), Q = mk(0x23, 101);                  // P votes 101-106, Q 102-107
  const v = (who, id, choice, h) => ({ payload: encodeVote({ proposalId: id, choice, signature: schnorr.sign(voteMessage(id, choice), who.secret) }), height: h, txid: `${h}${choice}` });
  const junk = (id, h, n) => Array.from({ length: n }, (_, i) => { const x = v(A, id, CHOICE.NO, h); x.payload = Uint8Array.from(x.payload); x.payload[x.payload.length - 1] ^= 1; x.txid = `j${h}-${i}`; return x; });
  const blocks = new Map([
    [102, [v(A, P.idBytes, CHOICE.YES, 102), v(B, Q.idBytes, CHOICE.YES, 102), ...junk(Q.idBytes, 102, 200), ...junk(P.idBytes, 102, 5)]],
    [103, [v(C, Q.idBytes, CHOICE.NO, 103), v(B, P.idBytes, CHOICE.NO, 103)]],
    [105, [v(A, Q.idBytes, CHOICE.YES, 105), ...junk(Q.idBytes, 105, 3)]],
    [106, [v(C, P.idBytes, CHOICE.YES, 106)]],
    [107, [v(C, Q.idBytes, CHOICE.YES, 107), v(A, P.idBytes, CHOICE.NO, 107)]],   // after P's phase: not P's
  ]);
  const held = new Map([[P.record.id, P.record], [Q.record.id, Q.record]]);
  const proposals = { list: () => [...held.values()], decide: (id, outcome) => { const r = held.get(id); if (r.decided) return false; held.set(id, { ...r, decided: outcome }); return true; } };
  const reads = []; let qCensus = 0;
  const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
  const t = createBallotTally({ proposals, tipHeight: async () => tipNow, votesAt: async (h) => { reads.push(h); return blocks.get(h) || []; },
    censusAt: async (_n, at) => (at === 101 && qCensus++ === 0 ? null : census), verify, decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  let tipNow = 104; await t.pass(); await t.pass();
  tipNow = 110; await t.pass(); await t.pass();
  const got = Object.fromEntries([...held.values()].map((r) => [r.id, [r.decided.yesSats, r.decided.noSats, r.decided.passed]]));
  assert.deepEqual(got[P.record.id], ['70', '30', true], 'P: A yes 50 + C yes 20, B no 30');
  assert.deepEqual(got[Q.record.id], ['100', '0', true], 'Q: B yes 30, A yes 50, C no at 103 then yes at 107 (its last vote)');
  assert.equal(reads.filter((h) => h === 102).length, 2, 'the over-full block read again by the count it was too full to hold for');
  assert.equal(new Set(reads.filter((h) => h !== 102)).size, reads.filter((h) => h !== 102).length, 'every block but the over-full one read once');
});
