// kanban #1489 state-machine audit round 3, area census, finding 3.
// A proposal's schedule (repeal or not: its voting window) is fixed ONCE at intake from historyFor(net, publishedAt) - the history
// built from the proposals THIS seat already holds and has decided (proposals.js 99-111, ballot-tally.js historyAt) - and never
// re-checked. The peer pull walks a peer's list NEWEST FIRST (proposals.list sorts by publication, descending). So a seat that
// pulls a network's proposals for the first time (a new seat, or one that missed a proposal posted to a single seat) takes the
// repeal R before the proposal P it repeals: P is not held yet, so nothing is pending and the history is the genesis alone, R
// reads as an ordinary proposal and is kept on the ordinary schedule. Every other seat keeps it as a repeal (27A.7.6, review 0).
// The two keep different voting windows for one proposal - they count different blocks and can decide it differently, for good.
// RULED 2026-11-12 (kanban #2012 (c), built #2562): bound deposits commit H(proposal), so a seat takes a proposal at any time (tip 300 here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, REPEAL_SCHEDULES, MIN_DECIDE_DEPTHS, configHashOf } from '../../arena-protocol/src/ballot.js';
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
  // BOUND (kanban #2562): the deposit commits to its proposer and the proposal's bytes
  const body = { networkId: NET, parent, configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight, proposer };
  const raw = tx(fill, [...want.outputs.map((o) => ({ sats: o.sats, script: o.script })), { sats: 0, script: depositCommitmentScript(body) }]);
  const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  chain.set(toHex(Uint8Array.from(depositTxid).reverse()), { raw, height, block: BLOCK[height] });
  const p = { ...body, depositTxid };
  return { proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret)])), blockHash: BLOCK[height] };
}
function seat() {
  let tally = null;
  const proposals = createProposals({ confirmedTx: async (txid, block) => { const t = chain.get(txid); return t && t.block === block ? { raw: t.raw, height: t.height } : null; },
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, scheduleFor: () => SCHEDULES.regtest, repealScheduleFor: () => REPEAL_SCHEDULES.regtest,
    historyFor: (net, h) => tally.historyAt(net, h), censusAt: async () => [{ pubkey: proposer }], store: { read: () => [], write: () => {} }, bindHeightFor: () => 0 });   // regtest's gate (kanban #2562)
  // 2.0: the tally runs the #1196 depth rule; a regtest network decides at depth 1 (MIN_DECIDE_DEPTHS.regtest), as the schedule these proposals use
  tally = createBallotTally({ proposals, tipHeight: async () => 300, votesAt: async () => [], censusAt: async () => [], verify, genesisFor: () => GENESIS,
    minDecideDepthFor: () => MIN_DECIDE_DEPTHS.regtest });
  return proposals;
}

test('#1489 sm3-census-3: a seat that pulls a repeal before the proposal it repeals keeps it on the ordinary schedule, the others as a repeal', async () => {
  // P: G -> X, published at 200, activation 208 (regtest 1 / 6 / 1); R: X -> G again (a repeal), published at 220, activation 230
  const P = proposal({ fill: 1, height: 200, parent: GENESIS.configHash, config: X, activationHeight: 208 });
  const R = proposal({ fill: 2, height: 220, parent: configHashOf(X), config: G, activationHeight: 230 });
  // seat 1 held P through its vote: passed; then R is posted to it
  const s1 = seat();
  const p1 = await s1.add(P); assert.equal(p1.status, 201, p1.why);
  assert.equal(s1.decide(p1.id, { passed: true, decidedAt: 207, anchor: null }), true);
  const r1 = await s1.add(R); assert.equal(r1.status, 201, r1.why);
  // seat 2 is new: its first pull from seat 1 (server.js pullProposals) walks seat 1's list, newest first
  const s2 = seat();
  const took = await s2.pull(s1.list());
  const r2 = s2.list().find((p) => p.id === r1.id);
  const view = (r) => (r ? { repeal: r.repeal, votingFrom: r.votingFrom, votingUntil: r.votingUntil } : null);
  console.log('  R at each seat:', JSON.stringify({ took, seat1: view(r1), seat2: view(r2) }));
  // kanban #1842: never kept on another schedule - R waits (503) until seat 2 has decided P itself, then is taken as a repeal
  if (r2) assert.deepEqual(view(r2), view(r1), 'one proposal, one schedule at every seat');
  const p2 = s2.list().find((p) => p.id === p1.id); assert.ok(p2, 'seat 2 keeps P');
  assert.equal(s2.decide(p1.id, { passed: true, decidedAt: 207, anchor: null }), true);   // its own tally decides P
  await s2.pull(s1.list());
  const r2b = s2.list().find((p) => p.id === r1.id);
  assert.ok(r2b, 'seat 2 keeps R once P is decided there');
  assert.deepEqual(view(r2b), view(r1), 'one proposal, one schedule at every seat');
});

test('#1842: a repeal posted to a seat before the proposal it repeals is rescheduled when that proposal is decided there', async () => {
  const P = proposal({ fill: 3, height: 200, parent: GENESIS.configHash, config: X, activationHeight: 208 });
  const R = proposal({ fill: 4, height: 220, parent: configHashOf(X), config: G, activationHeight: 230 });
  const s1 = seat();
  const p1 = await s1.add(P); assert.equal(p1.status, 201, p1.why);
  assert.equal(s1.decide(p1.id, { passed: true, decidedAt: 207, anchor: null }), true);
  const r1 = await s1.add(R); assert.equal(r1.status, 201, r1.why);
  assert.equal(r1.repeal, true);
  // seat 3 is posted R first (it never heard of P): read on the genesis history, an ordinary schedule for now
  const s3 = seat();
  const r3 = await s3.add(R); assert.equal(r3.status, 201, r3.why);
  assert.equal(r3.repeal, false);
  const p3 = await s3.add(P); assert.equal(p3.status, 201, p3.why);
  assert.equal(s3.decide(p3.id, { passed: true, decidedAt: 207, anchor: null }), true);
  // merged in #1489 onto #1631: the schedule is read again by the tally's next pass (proposals.reschedule, asked before anything of R is counted),
  // not at decide() - that pass is the one asked here
  assert.equal(s3.reschedule(r1.id, { at: 300 }), 'moved');
  const now = s3.list().find((p) => p.id === r1.id);
  assert.deepEqual({ repeal: now.repeal, votingFrom: now.votingFrom, votingUntil: now.votingUntil },
    { repeal: r1.repeal, votingFrom: r1.votingFrom, votingUntil: r1.votingUntil }, 'rescheduled as the repeal it is');
  assert.equal(now.state, 'COUNTING');
});
