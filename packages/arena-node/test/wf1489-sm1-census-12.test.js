// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1 census-12 (state machine, reorg across a publication height): the tally checks a proposal's publication block
// ONLY while nothing of its phase has been read (followReorgs kind 'published'). From its first read block on, it holds the count
// to `readHash` alone. The reorg check runs at the START of a pass; the census read and the first block reads of the phase come
// later in the same pass (after every earlier proposal's reads, and a cold census derivation takes minutes). A reorg that lands
// in that window - replacing the publication block with one that does not hold the deposit - is never seen: the census is read
// on the new branch, the phase's blocks are read on the new branch, `readHash` is the new branch's, and every later check
// answers 'same'. The proposal is counted, PASSED and made live here, on a chain that holds no deposit for it, while a seat that
// first looked after the reorg orphans it: two seats, two live configs. Safe behaviour: a proposal whose publication block is not
// on this seat's chain is ORPHANED and counts for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const H = (b) => new Uint8Array(32).fill(b);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31);
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }];
const NET = H(0x4e);
const NEW = H(0x22);

test('wf1489 sm1 census-12: a reorg of the publication block between the reorg check and the first read is never seen', async () => {
  // regtest DESIGN (review 1, voting 6, cooldown 1): published at 100 in block a100, voting 101-106, activation 108
  const publishedAt = 100, activationHeight = 108;
  const p = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: NEW, config: Uint8Array.of(2), class: CLASS.DESIGN, activationHeight, proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  // the chain: one block hash per height on branch 'a' (where the deposit confirmed at 100) or branch 'b' (from 100 up: no deposit)
  const ch = { tip: 100, branch: 'a' };
  const hashOf = (h, br = ch.branch) => (h < 100 ? `0${h}`.padStart(64, '0') : `${br}${h}`.padStart(64, br === 'a' ? 'a' : 'b'));
  const record = { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: toHex(NET),
    parent: toHex(p.parent), configHash: toHex(NEW), class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt, depositSats: '1000',
    votingFrom: 101, votingUntil: 107, activationHeight, repeal: false, depositTxid: toHex(p.depositTxid), blockHash: hashOf(100, 'a'), state: 'COUNTING' };
  const storeOf = () => { const rows = new Map([[record.id, JSON.stringify(record)]]);
    return { rows, read: () => [...rows.values()].map((j) => JSON.parse(j)), write: (list) => { for (const x of list) rows.set(x.id, JSON.stringify(x)); } }; };
  const yes = encodeVote({ proposalId: idBytes, choice: CHOICE.YES, signature: schnorr.sign(voteMessage(idBytes, CHOICE.YES), A.secret) });
  const seatOf = (store, onCensus = async () => {}) => createBallotTally({
    proposals: createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 1n, verify, store }),
    tipHeight: async () => ch.tip,
    // the census at the publication height, as main.js chainCensusKept: keyed by the hash at that height NOW - a reorg that
    // landed just before this read derives the new branch's census, consistently, and keeps it (#1841's check passes)
    censusAt: async () => { await onCensus(); return CENSUS; },
    verify,
    votesAt: async (h) => (h === 102 ? [{ payload: yes, height: h, txid: 'v' }] : []),     // the voter's YES, re-mined on branch b
    blockHashAt: async (h) => (h <= ch.tip ? hashOf(h) : null),
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });

  // SEAT 1: its pass at tip 101 runs the reorg check (publication a100: same), then reads the census - and the chain moves to
  // branch b (a 2-block reorg at 100-101 that drops the deposit) just before that read
  const s1 = storeOf();
  const seat1 = seatOf(s1, async () => { if (ch.branch === 'a') { ch.branch = 'b'; } });
  await seat1.pass();                                                     // tip 100: review
  ch.tip = 101; await seat1.pass();                                       // the reorg lands mid-pass
  assert.equal(ch.branch, 'b', 'the reorg happened during the pass');
  for (const t of [102, 104, 106, 107, 109]) { ch.tip = t; await seat1.pass(); }

  // SEAT 2: the same proposal kept, its first look at the chain after the reorg
  const s2 = storeOf();
  const seat2 = seatOf(s2);
  for (const t of [102, 104, 106, 107, 109]) { ch.tip = t; await seat2.pass(); }

  const st1 = JSON.parse(s1.rows.get(record.id)).state, st2 = JSON.parse(s2.rows.get(record.id)).state;
  const net = toHex(NET);
  console.log(`  chain at 100 now ${hashOf(100).slice(-8)}, publication block ${record.blockHash.slice(-8)} | seat 1: ${st1}, live ${seat1.live(net).configHash.slice(0, 8)} | seat 2: ${st2}, live ${seat2.live(net).configHash.slice(0, 8)}`);
  assert.equal(st2, 'ORPHANED', 'control: a seat that looked after the reorg orphans it');
  assert.equal(st1, 'ORPHANED', 'seat 1 must orphan a proposal whose publication block left its chain, not count it');
  assert.equal(seat1.live(net).configHash, seat2.live(net).configHash, 'both seats must run the same config');
});
