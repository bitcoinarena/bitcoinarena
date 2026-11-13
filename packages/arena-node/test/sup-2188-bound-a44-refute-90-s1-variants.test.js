// kanban #1489 fix-refute audit44, item 90 (kanban #1842): variants that should hold on 90d57151a (passing = the fix holds there).
import { test } from 'node:test';
// Adapted to 1.9 by #2536: every deposit here is BOUND (#2125, regtest and mainnet from block 0: it commits to its proposer and body) and votes carry a seq.
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

test('variant A: P orphaned at a seat when R arrives (read on genesis, ordinary) - restored and decided, the tally pass reschedules R as the repeal', async () => {
  const P = proposal({ fill: 21, height: 200, parent: GENESIS.configHash, config: X, activationHeight: 208 });
  const R = proposal({ fill: 22, height: 220, parent: configHashOf(X), config: G, activationHeight: 230 });
  const t = { tip: 200 }; const s = seat(t);
  const p = await s.proposals.add(P); assert.equal(p.status, 201, p.why);
  assert.equal(s.proposals.orphan(p.id, { at: 205 }), true);
  t.tip = 220;
  const r = await s.proposals.add(R); assert.equal(r.status, 201, r.why);
  console.log('  R kept while P orphaned:', JSON.stringify(view(r)));
  assert.equal(s.proposals.restore(p.id, { at: 220 }), true);
  assert.equal(s.proposals.reschedule(r.id, { at: 220 }), 'pending', 'P undecided: R not counted');
  assert.equal(s.proposals.decide(p.id, { passed: true, decidedAt: 220, anchor: null }), true);
  assert.equal(s.proposals.reschedule(r.id, { at: 221 }), 'moved');
  const now = s.proposals.list().find((x) => x.id === r.id);
  assert.deepEqual(view(now), { repeal: true, votingFrom: 220, votingUntil: 226 });
  assert.equal(s.proposals.reschedule(r.id, { at: 222 }), 'same', 'stable once right');
});

test('variant B: a lying peer lists R with publishedAt 0 to be checked first - the tally pass still puts R on the repeal window', async () => {
  const P = proposal({ fill: 23, height: 200, parent: GENESIS.configHash, config: X, activationHeight: 208 });
  const R = proposal({ fill: 24, height: 220, parent: configHashOf(X), config: G, activationHeight: 230 });
  const t = { tip: 200 }; const s = seat(t);       // a tip low enough to take both (the only way both can be pulled at all)
  const lie = [{ ...R, id: 'x', publishedAt: 0 }, { ...P, id: 'y', publishedAt: 999 }];
  const took = await s.proposals.pull(lie);
  const r = s.proposals.list().find((x) => x.publishedAt === 220), p = s.proposals.list().find((x) => x.publishedAt === 200);
  console.log('  after the lying pull:', JSON.stringify({ took, r: view(r) }));
  assert.ok(p && r);
  assert.equal(s.proposals.reschedule(r.id, { at: 200 }), 'pending');
  assert.equal(s.proposals.decide(p.id, { passed: true, decidedAt: 207, anchor: null }), true);
  assert.equal(s.proposals.reschedule(r.id, { at: 221 }), 'moved');
  assert.deepEqual(view(s.proposals.list().find((x) => x.id === r.id)), { repeal: true, votingFrom: 220, votingUntil: 226 });
});

test('variant C: R decided on the wrong (ordinary) window while P was orphaned is taken back and counted on the repeal window', async () => {
  const P = proposal({ fill: 25, height: 200, parent: GENESIS.configHash, config: X, activationHeight: 208 });
  const R = proposal({ fill: 26, height: 220, parent: configHashOf(X), config: G, activationHeight: 230 });
  const t = { tip: 200 }; const s = seat(t);
  const p = await s.proposals.add(P); assert.equal(p.status, 201, p.why);
  assert.equal(s.proposals.orphan(p.id, { at: 205 }), true);
  t.tip = 220;
  const r = await s.proposals.add(R); assert.equal(r.status, 201, r.why); assert.equal(r.repeal, false);
  assert.equal(s.proposals.decide(r.id, { passed: true, decidedAt: 229, anchor: null }), true);
  assert.equal(s.proposals.restore(p.id, { at: 230 }), true);
  assert.equal(s.proposals.decide(p.id, { passed: true, decidedAt: 230, anchor: null }), true);
  assert.equal(s.proposals.reschedule(r.id, { at: 231 }), 'moved');
  const now = s.proposals.list().find((x) => x.id === r.id);
  assert.equal(now.state, 'COUNTING');
  assert.deepEqual(view(now), { repeal: true, votingFrom: 220, votingUntil: 226 });
});

test('variant D: R arrives while P is still COUNTING - 503, never kept on a guessed window', async () => {
  const P = proposal({ fill: 27, height: 200, parent: GENESIS.configHash, config: X, activationHeight: 208 });
  const R = proposal({ fill: 28, height: 220, parent: configHashOf(X), config: G, activationHeight: 230 });
  const t = { tip: 200 }; const s = seat(t);
  const p = await s.proposals.add(P); assert.equal(p.status, 201, p.why);
  t.tip = 220;
  const r = await s.proposals.add(R);
  assert.equal(r.status, 503, r.why);
});

test('honest: a seat that held and decided P takes R as the repeal at its block, and the tally pass leaves it alone', async () => {
  const P = proposal({ fill: 29, height: 200, parent: GENESIS.configHash, config: X, activationHeight: 208 });
  const R = proposal({ fill: 30, height: 220, parent: configHashOf(X), config: G, activationHeight: 230 });
  const t = { tip: 200 }; const s = seat(t);
  const p = await s.proposals.add(P); assert.equal(p.status, 201, p.why);
  assert.equal(s.proposals.decide(p.id, { passed: true, decidedAt: 207, anchor: null }), true);
  t.tip = 220;
  const r = await s.proposals.add(R); assert.equal(r.status, 201, r.why);
  assert.deepEqual(view(r), { repeal: true, votingFrom: 220, votingUntil: 226 });
  assert.equal(s.proposals.reschedule(r.id, { at: 220 }), 'same');
  assert.equal(s.proposals.reschedule(p.id, { at: 220 }), 'same', 'a decided honest P is not moved');
  t.tip = 221;
  const out = await s.tally.pass();
  assert.notEqual(out.skipped, true);
  assert.deepEqual(view(s.proposals.list().find((x) => x.id === r.id)), { repeal: true, votingFrom: 220, votingUntil: 226 });
  assert.equal(s.proposals.list().find((x) => x.id === p.id).state, 'PASSED');
});
