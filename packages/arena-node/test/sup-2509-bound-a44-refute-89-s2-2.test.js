// kanban #1840 re-check, skeptic 2 (#1489 fix-refute, audit44 item 89): the RESUME path. Two seats keep A. The proposer's own second
// proposal B over the same deposit reaches seat 2 during voting (contest evidence, kept) while seat 1 is down (a restart, a deploy).
// Seat 1 comes back from its store with its tip past votingUntil and pulls seat 2: B is refused 422 (late), so seat 1 counts A for
// good while seat 2 counts nothing. Whether A backs the live config depends on whether a seat was up at the right block.
// Adapted to 1.9 by #2536 (kanban #2509): the card's helper (_common89s2.mjs) read the deposit unbound. 1.9 reads deposits BOUND on every
// live network (#2125 / #2012 (c), #2607): the deposit commits to its proposer and H(proposal), so a second body over it is refused at
// every seat, and the same body re-signed (a twin) is the same proposal, taken at any time. The same restart on the bound reading, both ways.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const secretA = new Uint8Array(32).fill(1); const proposerA = schnorr.getPublicKey(secretA);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const BLOCK = 'bb'.repeat(32);
const body = (activationHeight, config) => ({ networkId: NET, parent: new Uint8Array(32).fill(0x10), configHash: configHashOf(config), config,
  class: CLASS.DESIGN, activationHeight, proposer: proposerA });
// the deposit commits to A's body: activation 208, config 1 2 3
const raw = tx([...depositOutputsExpected(1000, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })), { sats: 0, script: depositCommitmentScript(body(208, Uint8Array.of(1, 2, 3))) }]);
const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
const txidDisplay = toHex(Uint8Array.from(depositTxid).reverse());
const proposal = (activationHeight, config) => {
  const p = { ...body(activationHeight, config), depositTxid };
  return toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secretA)]));   // fresh aux bytes: a twin is another id
};
const seat = (tip, kept = null) => createProposals({ bindHeightFor: () => 0,
  confirmedTx: async (txid, block) => (block === BLOCK && txid === txidDisplay ? { raw, height: 200 } : null),
  recipientsFor: (net, height) => (net === toHex(NET) && height === 200 ? SET : null), lowestBondMinSatsFor: () => 100000n, verify,
  schedule: SCHEDULES.regtest, censusAt: async () => [{ pubkey: proposerA }],
  store: { read: () => (kept ? kept.rows : []), write: (l) => { if (kept) kept.rows = JSON.parse(JSON.stringify(l)); } }, tipHeight: async () => tip.h });
const ids = (s) => s.list().map((p) => p.id.slice(0, 16)).sort();
const countedIds = (s) => s.list().filter((p) => s.counts(p.id)).map((p) => p.id.slice(0, 16)).sort();

for (const [name, second] of [['a second body (activation 209)', () => proposal(209, Uint8Array.of(1, 2, 3))], ['a twin (the same body re-signed)', () => proposal(208, Uint8Array.of(1, 2, 3))]]) {
  test(`#2509 (1.9, bound) #1840 refute s2-2, ${name}: a seat that restarts after the voting phase counts what the other seat counts`, async () => {
    const A = proposal(208, Uint8Array.of(1, 2, 3));
    const B = second();
    const t1 = { h: 200 }, t2 = { h: 200 };
    const disk1 = { rows: [] };
    const s1 = seat(t1, disk1), s2 = seat(t2);
    assert.equal((await s1.add({ proposal: A, blockHash: BLOCK })).status, 201);
    assert.equal((await s2.pull(s1.list())), 1);
    // seat 1 goes down at 203 (its store holds what it kept); B reaches seat 2 at 204
    t2.h = 204;
    const b2 = await s2.add({ proposal: B, blockHash: BLOCK });
    console.log(`  B at seat 2: ${b2.status} ${b2.why || ''}`);
    // seat 1 comes back at 210 from its store, the same chain and wiring
    const back = seat({ h: 210 }, disk1);
    assert.deepEqual(ids(back), ids(s1), 'seat 1 read A back from its store');
    await back.pull(s2.list());
    console.log('  after the restart and pull:', JSON.stringify({ seat1: ids(back), seat2: ids(s2), counted1: countedIds(back), counted2: countedIds(s2) }));
    assert.deepEqual(countedIds(back), countedIds(s2), 'two seats count the same proposals for one deposit');
    assert.equal(countedIds(back).length, 1, 'the deposit backs one counted proposal');
  });
}
