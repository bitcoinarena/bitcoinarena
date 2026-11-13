// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 fix-refute (audit44 item 34, kanban #1635), skeptic 2: the outcome a recount holds in force is kept in MEMORY
// (ballot-tally.js heldOutcome) and dropped only in the counting loop of a pass. An orphan move (SM-B15: "ORPHANED holds nothing")
// in a pass whose loop stops at an RPC error before it reaches the proposal leaves the stale hold in memory; when the publication
// block comes back (restore -> COUNTING), the running seat puts the old outcome in force again while a seat restarted at the
// same moment (record: undecided.outcome stripped at the orphan) does not - two seats on one chain, two live configs.
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
const A = key(0x31), B = key(0x32), C = key(0x33);
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }, { pubkey: B.pubkey, outpoint: 'bb:0', bondSats: 30000000n },
  { pubkey: C.pubkey, outpoint: 'cc:0', bondSats: 20000000n }];
const vote = (who, idBytes, choice, height, txid) => ({ payload: encodeVote({ proposalId: idBytes, choice, signature: schnorr.sign(voteMessage(idBytes, choice), who.secret) }), height, txid });
function kept({ net = H(0x4e), parent = BALLOT_GENESIS.configHash, configHash = H(0x22), config = Uint8Array.of(2), cls = CLASS.DESIGN, publishedAt = 100,
  review = 1, voting = 6, cooldown = 1, repeal = false, deposit = 0x77 } = {}) {
  const activationHeight = publishedAt + review + voting + cooldown;
  const p = { networkId: net, parent, configHash, config, class: cls, activationHeight, proposer: A.pubkey, depositTxid: H(deposit) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  return { idBytes, record: { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: toHex(net),
    parent: toHex(parent), configHash: toHex(configHash), class: Object.keys(CLASS).find((k) => CLASS[k] === cls), proposer: toHex(A.pubkey), publishedAt,
    depositSats: '1000', votingFrom: publishedAt + review, votingUntil: publishedAt + review + voting, activationHeight, repeal, depositTxid: toHex(H(deposit)) } };
}
function forkable(votesByHeight, top = 120) {
  const c = { tip: 0, blocks: new Map(), byHash: new Map(), branch: 0, failVotes: 0 };
  const put = (h, votes) => { const hash = `${String(c.branch).padStart(2, '0')}${String(h).padStart(6, '0')}`.padEnd(64, 'f'); c.blocks.set(h, hash); c.byHash.set(hash, votes || []); };
  for (let h = 0; h <= top; h++) put(h, votesByHeight.get(h));
  c.fork = (at, votes) => { c.branch++; for (let h = at; h <= top; h++) put(h, votes.get(h)); };
  c.snapshot = () => new Map(c.blocks);
  c.revert = (snap) => { c.blocks = new Map(snap); };              // the first branch wins back: its hashes and its votes again
  c.tipHeight = async () => c.tip;
  c.blockHashAt = async (h) => (h <= c.tip ? c.blocks.get(h) : null);
  c.votesAt = async (h, hash) => { if (c.failVotes > 0) { c.failVotes--; throw new Error('bitcoind: -28 loading block index'); } return c.byHash.get(hash || c.blocks.get(h)) || []; };
  c.censusAt = async () => CENSUS;
  return c;
}

test('wf1489-a44-refute-34-s2-1: an orphan in a pass cut short by an RPC error leaves the held outcome in memory; restored, it is in force again (running seat != restarted seat)', async () => {
  const NET = toHex(H(0x4e));
  // X: a repeal on the mainnet schedule (as the #1635 test), published at 100, live from 820
  const X = kept({ review: 0, voting: 720, cooldown: 0, configHash: H(0x24), deposit: 0x77 });
  // Z: another proposal published earlier, still voting (sorted before X in the counting loop)
  const Z = kept({ publishedAt: 90, review: 1, voting: 2000, cooldown: 1, configHash: H(0x25), deposit: 0x78 });
  const ch = forkable(new Map([[100, [vote(A, X.idBytes, CHOICE.YES, 100, 'a1')]]]), 900);
  let rows = [{ ...Z.record, blockHash: ch.blocks.get(90), state: 'COUNTING' }, { ...X.record, blockHash: ch.blocks.get(100), state: 'COUNTING' }];
  const disk = { read: () => rows.map((r) => ({ ...r })), write: (l) => { rows = l.map((r) => ({ ...r })); } };
  const open = () => createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 100000n, verify, store: disk });
  const mk = (proposals) => createBallotTally({ proposals, tipHeight: ch.tipHeight, votesAt: ch.votesAt, censusAt: ch.censusAt, blockHashAt: ch.blockHashAt, verify,
    decideDepthFor: () => 6, minDecideDepthFor: () => 1 });
  const xOf = (p) => p.list().find((r) => r.id === X.record.id);
  const p1 = open(); const t = mk(p1);
  ch.tip = 822;
  for (let i = 0; i < 60 && !xOf(p1).decided; i++) await t.pass();
  await t.pass();
  assert.equal(xOf(p1).state, 'PASSED');
  assert.equal(t.live(NET).configHash, toHex(H(0x24)), 'X live from 820');
  const original = ch.snapshot();
  // 1. a reorg below X's anchor: undecided, held in force (the #1635 fix)
  ch.fork(819, new Map()); await t.pass();
  assert.equal(xOf(p1).state, 'COUNTING');
  assert.equal(t.live(NET).configHash, toHex(H(0x24)), 'held while recounting');
  // 2. a deeper reorg takes X's publication block away; the same pass's loop stops at an RPC error on Z's first block
  ch.fork(95, new Map()); ch.failVotes = 1;
  await assert.rejects(() => t.pass());
  assert.equal(xOf(p1).state, 'ORPHANED');
  assert.equal(t.live(NET).configHash, toHex(BALLOT_GENESIS.configHash), 'orphaned: nothing held (SM-B15)');
  // 3. the first branch comes back: X's publication block is on the chain again -> restored, COUNTING, counted again
  ch.revert(original); await t.pass();
  assert.equal(xOf(p1).state, 'COUNTING', 'restored');
  // a seat restarted right now, on the same store and chain
  const t2 = mk(open()); await t2.pass();
  const running = t.live(NET).configHash.slice(0, 8), restarted = t2.live(NET).configHash.slice(0, 8);
  console.log('  AFTER THE RESTORE: running seat live', running, '| restarted seat live', restarted, '| record undecided', JSON.stringify(xOf(p1).undecided && Object.keys(xOf(p1).undecided)));
  assert.equal(running, restarted, 'one chain, one store: the running seat and a restarted seat name the same live config');
  assert.equal(running, toHex(BALLOT_GENESIS.configHash).slice(0, 8), 'SM-B15: an orphan holds nothing, so a restored proposal holds nothing until it is decided again');
});
