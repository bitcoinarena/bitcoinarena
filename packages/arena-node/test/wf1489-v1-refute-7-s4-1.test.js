// kanban #1489 v1-refute-7 skeptic 4 (after #1670 f70433f6e, #1865 9c3a6cf50): a restart while the chain is on ANOTHER branch below
// a bonded proposal's publication block. The start-up proposer check (proposals.js recheck) reads censusAt(net, publishedAt) on
// whatever branch is the tip now - not on the branch the record was published on (r.blockHash). A reorg that took out the
// publication block AND the proposer's fresh bond makes that census leave the proposer out, and recheck writes the record
// ORPHANED with `unbonded` - for good: when the original branch wins back, restore() is refused (unbonded) and re-posting from
// the same block answers 200 "already" with the orphan. Without the restart (the same reorg seen in session) the record is
// orphaned plainly and comes back with its block. Honest proposal, honest bond: lost on this seat only because it restarted.
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

function record(state) {
  const publishedAt = 100, activationHeight = 108;
  const p = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: NEW_HASH, config: NEW_CONFIG, class: CLASS.DESIGN, activationHeight,
    proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const id = toHex(proposalId({ ...p, signature }));
  const r = { id, proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: net, parent: toHex(p.parent),
    configHash: toHex(NEW_HASH), class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt, depositSats: '1000', votingFrom: 101, votingUntil: 107,
    activationHeight, repeal: false, depositTxid: toHex(H(0x77)), blockHash: ORIG, state };
  if (state === 'PASSED') r.decided = { passed: true, yesSats: '50000000', noSats: '0', abstainSats: '0', totalSats: '50000000', turnoutPct: 100, approvalPct: 100, decidedAt: 107, census: 1, anchor: { height: 106, hash: ORIG } };
  if (state === 'ORPHANED') r.orphaned = { at: 120, why: 'its publication block left this chain', was: 'COUNTING' };   // orphaned in an earlier session
  return r;
}

// the chain: on the original branch the proposer's bond (confirmed at 99) is in the census at 100; on the other branch neither the
// bond nor the publication block is there. The census is keyed by the block hash at the height, as main.js chainCensusKept keys it.
function seat(state, branch) {
  const censusAt = async (n, h) => (branch.now === 'orig' ? [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }] : []);
  const blockHashAt = async (h) => (h <= 150 ? (branch.now === 'orig' ? ORIG : OTHER) : null);
  let stored = [record(state)];
  const proposals = createProposals({ confirmedTx: async () => null, recipientsFor: () => null, lowestBondMinSatsFor: () => 100000n, verify,
    schedule: SCHEDULES.regtest, censusAt, store: { read: () => stored, write: (l) => { stored = l; } } });
  const tally = createBallotTally({ proposals, tipHeight: async () => 150, votesAt: async () => [], censusAt, verify, blockHashAt,
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  return { proposals, tally };
}
const settle = () => new Promise((r) => setImmediate(r));

for (const state of ['COUNTING', 'PASSED', 'ORPHANED']) {
  test(`control (${state}): the same reorg and its return seen in session - the record comes back with its block`, async () => {
    const branch = { now: 'orig' };
    const { proposals, tally } = seat(state, branch);
    await settle(); await tally.pass();
    branch.now = 'other'; await tally.pass();
    assert.equal(stateOf(proposals.list()[0]), 'ORPHANED');
    branch.now = 'orig'; await tally.pass();
    // back and counted again (with no votes in this harness the count may decide at once): anything but ORPHANED
    assert.notEqual(stateOf(proposals.list()[0]), 'ORPHANED');
  });

  test(`a ${state} record of a bonded proposer, seat restarted while the chain was on another branch: never comes back when its block does`, async () => {
    const branch = { now: 'other' };                               // the seat starts while the other branch is the tip
    const { proposals, tally } = seat(state, branch);
    await settle(); await tally.pass();
    const mid = proposals.list()[0];
    console.log('  on the other branch after restart:', stateOf(mid), JSON.stringify(mid.orphaned || {}).slice(0, 160));
    branch.now = 'orig';                                           // the original branch wins back: block, bond and census are there again
    await tally.pass(); await tally.pass();
    const after = proposals.list()[0];
    const again = await proposals.add({ proposal: after.proposal, blockHash: ORIG });
    console.log('  original branch back:', stateOf(after), after.orphaned && after.orphaned.unbonded ? 'unbonded' : '', '| re-post from its block:', again.status, again.state);
    assert.notEqual(stateOf(after), 'ORPHANED', 'the bonded proposal is not counted again when its publication block is back');
  });
}
