// kanban #2032 (after #1670, #1865, #1489): a kept record's proposer is judged only on the branch of its own publication block.
// (1) given the block reader at createProposals (server.js), a restart on another branch writes no `unbonded` at all, and an
//     open record waits as a plain orphan (no history held up: openUnchecked 0); its block back, it is counted again.
// (2) a proposer that is NOT bonded on its own branch stays unbonded: re-reading on its own block never clears that verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals, stateOf } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const H = (b) => new Uint8Array(32).fill(b);
const A = { secret: H(0x31), pubkey: schnorr.getPublicKey(H(0x31)) };
const NET = H(0x4e), net = toHex(NET);
const NEW_CONFIG = Uint8Array.of(2), NEW_HASH = configHashOf(NEW_CONFIG);
const ORIG = 'bb'.repeat(32), OTHER = 'cc'.repeat(32);

function record() {
  const p = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: NEW_HASH, config: NEW_CONFIG, class: CLASS.DESIGN, activationHeight: 108,
    proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  return { id: toHex(proposalId({ ...p, signature })), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: net,
    parent: toHex(p.parent), configHash: toHex(NEW_HASH), class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt: 100, depositSats: '1000',
    votingFrom: 101, votingUntil: 107, activationHeight: 108, repeal: false, depositTxid: toHex(H(0x77)), blockHash: ORIG, state: 'COUNTING' };
}
const settle = () => new Promise((r) => setImmediate(r));

function seat(branch, { bondedOnOrig = true, readerAtCreate = true, stored = [record()] } = {}) {
  const censusAt = async () => (branch.now === 'orig' && bondedOnOrig ? [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }] : []);
  const blockHashAt = async (h) => (h <= 150 ? (branch.now === 'orig' ? ORIG : OTHER) : null);
  const box = { stored };
  const proposals = createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 100000n, verify,
    schedule: SCHEDULES.regtest, censusAt, ...(readerAtCreate ? { blockHashAt } : {}), store: { read: () => box.stored, write: (l) => { box.stored = l; } } });
  const tally = createBallotTally({ proposals, tipHeight: async () => 150, votesAt: async () => [], censusAt, verify, blockHashAt,
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  return { proposals, tally, box };
}

test('reader at create: a restart on another branch writes no unbonded, holds no history up, and the record is back with its block', async () => {
  const branch = { now: 'other' };
  const { proposals, tally, box } = seat(branch);
  await settle(); await tally.pass(); await tally.pass();
  assert.equal(stateOf(proposals.list()[0]), 'ORPHANED');
  assert.ok(!box.stored[0].orphaned.unbonded, 'no unbonded verdict read on another branch');
  assert.equal(proposals.openUnchecked(net, 1000), 0, 'it holds no history up while its block is away');
  branch.now = 'orig'; await tally.pass();
  assert.notEqual(stateOf(proposals.list()[0]), 'ORPHANED');
});

test('a proposer not bonded on its own branch stays unbonded, its block on the chain or not', async () => {
  for (const readerAtCreate of [true, false]) {
    const branch = { now: 'orig' };
    const { proposals, tally, box } = seat(branch, { bondedOnOrig: false, readerAtCreate });
    await settle(); await tally.pass(); await tally.pass();
    const r = proposals.list()[0];
    assert.equal(stateOf(r), 'ORPHANED');
    assert.ok(r.orphaned.unbonded, 'unbonded on its own block');
    assert.equal(proposals.toReview(), 0, 'settled for good on its own block');
    branch.now = 'other'; await tally.pass(); branch.now = 'orig'; await tally.pass();
    assert.equal(stateOf(proposals.list()[0]), 'ORPHANED');
    assert.ok(box.stored[0].orphaned.unbonded);
  }
});

test('a record an earlier build wrote unbonded on another branch is cleared once its own branch shows the bond', async () => {
  const branch = { now: 'orig' };
  const bad = { ...record(), state: 'ORPHANED', orphaned: { at: 120, why: 'the proposer holds no active bond (kanban #1670)', was: 'COUNTING', unbonded: true } };
  const { proposals, tally, box } = seat(branch, { stored: [bad] });
  await settle(); await tally.pass(); await tally.pass();
  assert.notEqual(stateOf(proposals.list()[0]), 'ORPHANED');
  assert.ok(!(box.stored[0].orphaned && box.stored[0].orphaned.unbonded));
});
