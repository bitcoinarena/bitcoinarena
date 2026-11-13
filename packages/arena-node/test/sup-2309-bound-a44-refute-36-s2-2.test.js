// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536: every deposit here is BOUND (#2125, regtest and mainnet from block 0: it commits to its proposer and body) and votes carry a seq.
// kanban #1489 state-machine audit (census area), finding 3: a proposal's schedule (repeal or not, its voting window) is fixed
// ONCE at intake from the history THIS seat has decided at that moment (proposals.js add -> historyFor -> ballot-tally historyAt).
// A seat that has not yet heard of an earlier proposal (posted to one seat; the peer pull runs every 10 min) reads a repeal as an
// ordinary proposal, keeps another voting window, never checks the record again - and the two seats count different votes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE, SCHEDULES, REPEAL_SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript, BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// a bound vote carries a seq (#2125): each vote here one higher than the last
const SEQ = () => (SEQ.last = (SEQ.last || 0) + 1); SEQ.last = 0;
const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const secret = new Uint8Array(32).fill(1); const proposer = schnorr.getPublicKey(secret);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const CENSUS = [{ pubkey: proposer, outpoint: 'aa:0', bondSats: 50000000n }];

/** A proposal with its deposit transaction, published in block `block` at `height`. */
function proposal({ parent, config, activationHeight, sats, height, block }) {
  const want = depositOutputsExpected(sats, SET);
  let raw; const mk = (extra) => tx([...want.outputs.map((o) => ({ sats: o.sats, script: o.script })), ...extra]);
  const p = { networkId: NET, parent, configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight, proposer,
    depositTxid: null };
  raw = mk([{ sats: 0, script: depositCommitmentScript(p) }]); p.depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  const signature = schnorr.sign(proposalBodyId(p), secret);
  return { p, idBytes: proposalId({ ...p, signature }), raw, height, block, hex: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])),
    txidDisplay: toHex(Uint8Array.from(p.depositTxid).reverse()) };
}
const voteFor = (idBytes, choice, height, txid) => ({ payload: encodeVote({ proposalId: idBytes, choice, seq: SEQ(), signature: schnorr.sign(voteMessage(idBytes, choice, SEQ.last), secret) }), height, txid });

/** One seat: proposals.js + ballot-tally.js over one shared fake chain, wired as server.js wires them (regtest schedules). */
function seat(chain, store = { read: () => [], write: () => {} }) {
  let tallyRef = null;
  const proposals = createProposals({ bindHeightFor: () => 0,
    confirmedTx: async (txid, block) => { const d = chain.deposits.get(txid); return d && d.block === block ? { raw: d.raw, height: d.height } : null; },
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify,
    scheduleFor: () => SCHEDULES.regtest, repealScheduleFor: () => REPEAL_SCHEDULES.regtest,
    historyFor: (net, height) => (tallyRef ? tallyRef.historyAt(net, height) : null),
    censusAt: async () => CENSUS, store });
  tallyRef = createBallotTally({ proposals, tipHeight: async () => chain.tip, votesAt: async (h) => chain.votes.get(h) || [], censusAt: async () => CENSUS, verify,
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  return { proposals, tally: tallyRef };
}
const C1 = Uint8Array.of(1, 2, 3);
const setup = () => {
  const chain = { tip: 200, deposits: new Map(), votes: new Map() };
  const P = proposal({ parent: BALLOT_GENESIS.configHash, config: C1, activationHeight: 208, sats: 1000, height: 200, block: 'b2'.repeat(32) });
  const R = proposal({ parent: configHashOf(C1), config: BALLOT_GENESIS.config, activationHeight: 220, sats: 999, height: 212, block: 'c2'.repeat(32) });
  for (const x of [P, R]) chain.deposits.set(x.txidDisplay, { raw: x.raw, height: x.height, block: x.block });
  chain.votes.set(201, [voteFor(P.idBytes, CHOICE.YES, 201, 'p1')]);
  chain.votes.set(212, [voteFor(R.idBytes, CHOICE.YES, 212, 'r1')]);
  return { chain, P, R };
};
const out = (r) => r ? ({ repeal: r.repeal, votingFrom: r.votingFrom, votingUntil: r.votingUntil, passed: r.decided ? r.decided.passed : null }) : null;

test('wf1489-a44-refute-36-s2-2: a seat that (re)joins with an empty store after P voted can never learn P - the repeal is ordinary there and the live config differs', async () => {
  const { chain, P, R } = setup();
  const Y = seat(chain);
  assert.equal((await Y.proposals.add({ proposal: P.hex, blockHash: P.block })).status, 201);
  for (const t of [201, 207, 208, 210]) { chain.tip = t; await Y.tally.pass(); }
  // Z: a seat restored from a fresh store (reinstall / new disk / a new census member) joins at 210 and runs the peer pull
  const Z = seat(chain);
  const pulled = await Z.proposals.pull(Y.proposals.list());
  await Z.tally.pass();
  const liveY210 = Y.tally.live(toHex(NET)).configHash, liveZ210 = Z.tally.live(toHex(NET)).configHash;
  chain.tip = 212; await Y.tally.pass(); await Z.tally.pass();
  const atY = await Y.proposals.add({ proposal: R.hex, blockHash: R.block });
  const atZ = await Z.proposals.add({ proposal: R.hex, blockHash: R.block });
  for (const t of [213, 214, 218, 219, 221]) { chain.tip = t; await Y.tally.pass(); await Z.tally.pass(); }
  const id = toHex(R.idBytes);
  const ry = out(Y.proposals.list().find((r) => r.id === id)), rz = out(Z.proposals.list().find((r) => r.id === id));
  console.log('  pulled P', pulled, ' live@210 Y', liveY210.slice(0, 16), ' Z', liveZ210.slice(0, 16), ' R@Y', atY.status, JSON.stringify(ry), ' R@Z', atZ.status, JSON.stringify(rz));
  assert.equal(pulled, 1, 'a seat that joins later takes the passed proposal from its peers');
  assert.equal(liveZ210, liveY210, 'both seats run the same config at 210');
  assert.deepEqual(rz, ry, 'one repeal, one schedule at both seats');
});
