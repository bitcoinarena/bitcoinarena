// kanban #1489 fix-refute audit44, item 90 (kanban #1842, "a repeal is kept on the same schedule at every seat, whatever order a
// seat learned the proposals in"). On 90d57151a the fix's own two tests are marked todo (kanban #2012) and both fail: #1608
// Adapted to 1.9 by #2536: every deposit here is BOUND (#2125, regtest and mainnet from block 0: it commits to its proposer and body) and votes carry a seq. The test of the card's own grace door (s1-2: refused after its grace) is the #1608 tip check the binding ruling replaced (a bound proposal is taken at any time), and is dropped.
// refuses a proposal once the seat's tip reaches its first voting block. A repeal's review is 0 (27A.7.6), so its door is open
// for exactly the block it is published in: an honest repeal posted to ONE seat and pulled by its peers one block later (the
// peer pull runs on a timer, not per block) is refused there for good. Seat 1 keeps and counts R, seat 2 never holds it - the
// same split the fix was made for (two seats, two different ballots for one proposal), in its strongest form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, REPEAL_SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (fill, outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(fill), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const secret = new Uint8Array(32).fill(1); const proposer = schnorr.getPublicKey(secret);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const G = Uint8Array.of(7, 7, 7), X = Uint8Array.of(1, 2, 3);
const GENESIS = { configHash: configHashOf(G), config: G };
const chain = new Map();             // txid (display) -> { raw, height }
const BLOCK = { 200: '20'.repeat(32), 220: '22'.repeat(32) };
function proposal({ fill, height, parent, config, activationHeight }) {
  const want = depositOutputsExpected(1000, SET);
  const body0 = { networkId: NET, parent, configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight, proposer };
  const raw = ((mk) => mk([{ sats: 0, script: depositCommitmentScript(body0) }]))((extra) => tx(fill, [...want.outputs.map((o) => ({ sats: o.sats, script: o.script })), ...extra]));
  const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  chain.set(toHex(Uint8Array.from(depositTxid).reverse()), { raw, height, block: BLOCK[height] });
  const p = { networkId: NET, parent, configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight, proposer, depositTxid };
  return { proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)])), blockHash: BLOCK[height] };
}
// a seat whose chain tip the test moves (the fix's own helper pins it at 300, which #1608 refuses everything at)
function seat(tipRef) {
  let tally = null;
  const proposals = createProposals({ bindHeightFor: () => 0, confirmedTx: async (txid, block) => { const t = chain.get(txid); return t && t.block === block ? { raw: t.raw, height: t.height } : null; },
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, scheduleFor: () => SCHEDULES.regtest, repealScheduleFor: () => REPEAL_SCHEDULES.regtest,
    historyFor: (net, h) => tally.historyAt(net, h), censusAt: async () => [{ pubkey: proposer }], store: { read: () => [], write: () => {} } });
  tally = createBallotTally({ proposals, tipHeight: async () => tipRef.tip, votesAt: async () => [], censusAt: async () => [], verify, genesisFor: () => GENESIS });
  return { proposals, tally };
}
const view = (r) => (r ? { repeal: !!r.repeal, votingFrom: r.votingFrom, votingUntil: r.votingUntil } : null);

test('a44-refute-90-s1-1: an honest repeal pulled by a peer one block after its publication is kept there on the same schedule', async () => {
  const P = proposal({ fill: 11, height: 200, parent: GENESIS.configHash, config: X, activationHeight: 208 });
  const R = proposal({ fill: 12, height: 220, parent: configHashOf(X), config: G, activationHeight: 230 });
  const t1 = { tip: 200 }, t2 = { tip: 200 };
  const s1 = seat(t1), s2 = seat(t2);
  // both seats hold P in its review and decide it PASSED (their own tallies)
  const p1 = await s1.proposals.add(P); assert.equal(p1.status, 201, p1.why);
  const p2 = await s2.proposals.add(P); assert.equal(p2.status, 201, p2.why);
  assert.equal(s1.proposals.decide(p1.id, { passed: true, decidedAt: 207, anchor: null }), true);
  assert.equal(s2.proposals.decide(p2.id, { passed: true, decidedAt: 207, anchor: null }), true);
  // R is posted to seat 1 in its own block
  t1.tip = 220; t2.tip = 220;
  const r1 = await s1.proposals.add(R); assert.equal(r1.status, 201, r1.why); assert.equal(r1.repeal, true);
  // seat 2's next peer pull runs once the next block is in
  t2.tip = 221;
  const took = await s2.proposals.pull(s1.proposals.list());
  const r2 = s2.proposals.list().find((p) => p.id === r1.id);
  const direct = r2 ? null : await s2.proposals.add(R);
  console.log('  R at each seat:', JSON.stringify({ took, seat1: view(r1), seat2: view(r2), seat2Post: direct && { status: direct.status, why: direct.why } }));
  assert.ok(r2, 'seat 2 keeps the repeal seat 1 keeps (one proposal, one ballot at every seat)');
  assert.deepEqual(view(r2), view(r1));
});

// THE GRACE IS BOUNDED (kanban #2188): #1608 still holds - past half of the voting phase (regtest repeal: 220 + 1 + 3) a proposal
// first shown to a seat is refused, and one shown only after its voting and activation is refused as before.
