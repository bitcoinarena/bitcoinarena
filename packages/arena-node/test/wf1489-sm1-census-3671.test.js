// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1 census (release audit #2 2026.1.9.30, #3604; state machine, concurrency inside one seat): the #3605 class on
// the #2700 path. The tally takes proposals.list() once at the top of its loop and, for each record, reads isLate(p) from that
// snapshot. A kept-late bound proposal P whose sightings majority is completed by the peer pull (proposals.vouch) WHILE the same
// pass awaits the chain for an earlier proposal Q (its census at publication) is still "late" in the snapshot: at
// tip >= activation - 1 the pass decides P FAILED "no census majority signed ..." although the record it decides already holds
// that majority (late.agreed). Decided once, never counted again. A seat whose vouch landed just before its pass counts P and
// decides PASSED: one proposal, two final outcomes, two live configs from 208.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals, seenMessage, isLate } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { proposalId, decodeConfigProposalBody, encodeConfigProposalBody, proposalBodyId, encodeVote, voteMessage, CHOICE, CLASS, SCHEDULES, REPEAL_SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (fill, outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(fill), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const secret = new Uint8Array(32).fill(1); const proposer = schnorr.getPublicKey(secret);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const G = Uint8Array.of(7, 7, 7), X = Uint8Array.of(1, 2, 3), Y = Uint8Array.of(4, 5, 6);
const GENESIS = { configHash: configHashOf(G), config: G };
const sk = (i) => (i === 1 ? secret : new Uint8Array(32).fill(0x30 + i));
const CENSUS = [1, 2, 3].map((i) => ({ pubkey: schnorr.getPublicKey(sk(i)), outpoint: `${String(i).repeat(64)}:0`, bondSats: [0, 50, 30, 20][i] }));
const chain = new Map();
// a bound deposit at `height` for G -> `cfg`, activating at `act` (regtest 1 / 6 / 1)
function deposit(fill, height, block, cfg, act) {
  const body = { networkId: NET, parent: GENESIS.configHash, configHash: configHashOf(cfg), config: cfg, class: CLASS.DESIGN, activationHeight: act, proposer };
  const outs = depositOutputsExpected(1000, SET).outputs.map((o) => ({ sats: o.sats, script: o.script }));
  const raw = tx(fill, [...outs, { sats: 0, script: depositCommitmentScript(body) }]);
  const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  chain.set(toHex(Uint8Array.from(depositTxid).reverse()), { raw, height, block });
  const p = { ...body, depositTxid };
  return { proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret, new Uint8Array(32).fill(fill))])), blockHash: block };
}
const idOf = (r) => { const b = fromHex(r.proposal); return toHex(proposalId({ ...decodeConfigProposalBody(b.subarray(0, b.length - 64)), signature: b.slice(b.length - 64) })); };
const Q = deposit(8, 199, '19'.repeat(32), Y, 207);      // voting 200-205
const P = deposit(9, 200, '20'.repeat(32), X, 208);      // voting 201-206
const sighting = (id, i, at) => ({ by: toHex(schnorr.getPublicKey(sk(i))), at, sig: toHex(schnorr.sign(seenMessage(id, at), sk(i))) });

function seat({ tip, votes, during }) {
  let tally = null;
  const proposals = createProposals({ confirmedTx: async (txid, block) => { const t = chain.get(txid); return t && t.block === block ? { raw: t.raw, height: t.height } : null; },
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, scheduleFor: () => SCHEDULES.regtest, repealScheduleFor: () => REPEAL_SCHEDULES.regtest,
    historyFor: (net, h) => tally.historyAt(net, h), censusAt: async () => CENSUS, store: { read: () => [], write: () => {} }, bindHeightFor: () => 0,
    // this seat's node key is bond 3's: 20 of the 50 left after the proposer's - its own sighting is no majority
    seenSigner: { pubkey: schnorr.getPublicKey(sk(3)), sign: (m) => schnorr.sign(m, sk(3)) } });
  tally = createBallotTally({ proposals, tipHeight: async () => tip.at, votesAt: async (h) => (votes.get(h) || []).map((v) => ({ ...v, height: h })),
    censusAt: async () => { if (during.fn) { const f = during.fn; during.fn = null; await f(proposals); } return CENSUS; }, verify, genesisFor: () => GENESIS });
  return { proposals, tally, liveAt: (h) => toHex(tally.historyAt(toHex(NET), h).at(-1).configHash) };
}
const vote = (i, id, choice, seq, txid) => ({ payload: encodeVote({ proposalId: fromHex(id), choice, seq, signature: schnorr.sign(voteMessage(fromHex(id), choice, seq), sk(i)) }), txid });

test('wf1489-sm1-census-3604-1: a sightings majority completed while the pass awaits another proposal is decided FAILED from the stale snapshot', async () => {
  const pId = idOf(P), qId = idOf(Q);
  const votes = new Map([[202, [vote(1, pId, CHOICE.YES, 1, 'c1'.repeat(32)), vote(2, pId, CHOICE.YES, 1, 'c2'.repeat(32))]]]);
  const t1 = { at: 199 }, t2 = { at: 199 };
  const d1 = { fn: null }, d2 = { fn: null };
  const s1 = seat({ tip: t1, votes, during: d1 }), s2 = seat({ tip: t2, votes, during: d2 });
  for (const [s, t] of [[s1, t1], [s2, t2]]) {
    t.at = 199; const q = await s.proposals.add(Q); assert.equal(q.status, 201, q.why);
    t.at = 200; const p = await s.proposals.add(P); assert.equal(p.status, 201, p.why);
    await s.proposals.vouch(qId, { sightings: [sighting(qId, 2, 199)] });      // Q: bonds 2 + 3 = 50 of 50, counted
    assert.equal(isLate(s.proposals.list().find((x) => x.id === qId)), false, 'Q counted');
    assert.equal(isLate(s.proposals.list().find((x) => x.id === pId)), true, 'P kept late (20 of 50)');
    t.at = 207;
  }
  // seat 2: the peer pull brings bond 2's sighting of P before its pass; seat 1: while its pass awaits Q's census
  assert.equal(await s2.proposals.vouch(pId, { sightings: [sighting(pId, 2, 201)] }), true);
  let agreed1 = null;
  d1.fn = async (proposals) => { agreed1 = await proposals.vouch(pId, { sightings: [sighting(pId, 2, 201)] }); };
  await s1.tally.pass(); await s2.tally.pass();
  assert.equal(agreed1, true, 'seat 1 held the majority before its decision');
  t1.at = 215; t2.at = 215;
  for (let i = 0; i < 3; i++) { await s1.tally.pass(); await s2.tally.pass(); }
  const st = (s) => { const r = s.tally.list().find((x) => x.id === pId); return { phase: r.phase, passed: r.tally && r.tally.passed, late: isLate(r), why: r.tally && r.tally.why }; };
  const o1 = st(s1), o2 = st(s2);
  console.log('  seat 1:', JSON.stringify(o1), '\n  seat 2:', JSON.stringify(o2), '\n  live at 215:', s1.liveAt(215).slice(0, 8), s2.liveAt(215).slice(0, 8));
  assert.equal(o1.passed, o2.passed, 'both seats held the sightings majority before deciding P: one proposal, one outcome');
  assert.equal(s1.liveAt(215), s2.liveAt(215), 'and one live config');
});
