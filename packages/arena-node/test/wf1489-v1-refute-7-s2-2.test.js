// kanban #1865 (after #1670, #1489 v1-refute-7 skeptic 2): a decided record kept before this start is held as stored while its
// proposer is not checked - its outcome stays live - and is orphaned only when the census positively leaves the proposer out.
// A reorg that takes it off its outcome before the check hides it like an open record: nothing is counted or restored unchecked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const H = (b) => new Uint8Array(32).fill(b);
const A = { secret: H(0x31), pubkey: schnorr.getPublicKey(H(0x31)) };
const NET = H(0x4e), net = toHex(NET);
const NEW_CONFIG = Uint8Array.of(2), NEW_HASH = configHashOf(NEW_CONFIG);

function passedRecord() {
  const p = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: NEW_HASH, config: NEW_CONFIG, class: CLASS.DESIGN, activationHeight: 108,
    proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  return { id: toHex(proposalId({ ...p, signature })), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: net,
    parent: toHex(p.parent), configHash: toHex(NEW_HASH), class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt: 100, depositSats: '1000',
    votingFrom: 101, votingUntil: 107, activationHeight: 108, repeal: false, depositTxid: toHex(H(0x77)), blockHash: 'bb'.repeat(32), state: 'PASSED',
    decided: { passed: true, yesSats: '1', noSats: '0', abstainSats: '0', totalSats: '1', turnoutPct: 100, approvalPct: 100, decidedAt: 107, census: 1, anchor: { height: 107, hash: 'ee'.repeat(32) } } };
}
const seat = (censusAt, writes = []) => createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 100000n,
  verify, schedule: SCHEDULES.regtest, censusAt, store: { read: () => [passedRecord()], write: (l) => writes.push(l) } });
const settle = () => new Promise((r) => setImmediate(r));

test('unreadable census: PASSED held as stored, nothing written; a later census without the proposer orphans it (unbonded)', async () => {
  let census = null; const writes = [];
  const s = seat(async () => census, writes);
  await settle(); await s.recheck();
  assert.equal(s.list()[0].state, 'PASSED');
  assert.equal(s.unchecked(net), 1);
  assert.equal(s.openUnchecked(net, 1e9), 0);
  assert.equal(writes.length, 0);
  census = [{ pubkey: H(0x55) }];
  await s.recheck();
  const r = s.list()[0];
  assert.equal(r.state, 'ORPHANED'); assert.equal(r.orphaned.unbonded, true); assert.equal(r.orphaned.was, 'PASSED');
  assert.equal(s.unchecked(net), 0);
  assert.equal(s.restore(r.id), false);
});

test('a reorg below its anchor before the check: written COUNTING, hidden (not counted, not restorable) until the census says bonded', async () => {
  let census = null; const writes = [];
  const s = seat(async () => census, writes);
  const id = s.list()[0].id;
  assert.equal(s.undecide(id), true);
  assert.equal(writes.at(-1)[0].state, 'COUNTING');
  assert.equal(s.list()[0].state, 'ORPHANED'); assert.equal(s.list()[0].orphaned.unchecked, true);
  assert.equal(s.restore(id), false);
  assert.equal(s.openUnchecked(net, 200), 1);
  census = [{ pubkey: A.pubkey }];
  await s.recheck();
  assert.equal(s.list()[0].state, 'COUNTING');
  assert.equal(s.unchecked(net), 0);
});

test('orphaned by a reorg before the check: the tally cannot restore it unchecked; bonded, it is restorable again', async () => {
  let census = null;
  const s = seat(async () => census);
  const id = s.list()[0].id;
  assert.equal(s.orphan(id, { at: 150 }), true);
  assert.equal(s.restore(id), false);
  census = [{ pubkey: A.pubkey }];
  await s.recheck();
  assert.equal(s.list()[0].state, 'ORPHANED');
  assert.equal(s.restore(id), true);
  assert.equal(s.list()[0].state, 'COUNTING');
});
