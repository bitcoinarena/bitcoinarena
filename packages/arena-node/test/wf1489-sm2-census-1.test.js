// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
import { depositOutputsExpected, BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

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
  const raw = tx(want.outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const p = { networkId: NET, parent, configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight, proposer,
    depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const signature = schnorr.sign(proposalBodyId(p), secret);
  return { p, idBytes: proposalId({ ...p, signature }), raw, height, block, hex: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])),
    txidDisplay: toHex(Uint8Array.from(p.depositTxid).reverse()) };
}
const voteFor = (idBytes, choice, height, txid) => ({ payload: encodeVote({ proposalId: idBytes, choice, signature: schnorr.sign(voteMessage(idBytes, choice), secret) }), height, txid });

/** One seat: proposals.js + ballot-tally.js over one shared fake chain, wired as server.js wires them (regtest schedules). */
function seat(chain) {
  let tallyRef = null;
  const proposals = createProposals({
    confirmedTx: async (txid, block) => { const d = chain.deposits.get(txid); return d && d.block === block ? { raw: d.raw, height: d.height } : null; },
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify,
    scheduleFor: () => SCHEDULES.regtest, repealScheduleFor: () => REPEAL_SCHEDULES.regtest,
    historyFor: (net, height) => (tallyRef ? tallyRef.historyAt(net, height) : null),
    censusAt: async () => CENSUS, store: { read: () => [], write: () => {} } });
  tallyRef = createBallotTally({ proposals, tipHeight: async () => chain.tip, votesAt: async (h) => chain.votes.get(h) || [], censusAt: async () => CENSUS, verify,
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  return { proposals, tally: tallyRef };
}

test('wf1489-sm2-census-1: a repeal taken by a seat that has not yet heard of the proposal it repeals gets another voting window there, for good', async () => {
  const chain = { tip: 200, deposits: new Map(), votes: new Map() };
  // P: genesis -> C1, published at 200, activates at 208; the bond votes YES at 201
  const P = proposal({ parent: BALLOT_GENESIS.configHash, config: Uint8Array.of(1, 2, 3), activationHeight: 208, sats: 1000, height: 200, block: 'b2'.repeat(32) });
  // R: C1 -> back to the genesis bytes (a repeal, 27A.7.6), published at 212, activates at 220 (stands under either schedule)
  const R = proposal({ parent: configHashOf(Uint8Array.of(1, 2, 3)), config: BALLOT_GENESIS.config, activationHeight: 220, sats: 999, height: 212, block: 'c2'.repeat(32) });
  for (const x of [P, R]) chain.deposits.set(x.txidDisplay, { raw: x.raw, height: x.height, block: x.block });
  chain.votes.set(201, [voteFor(P.idBytes, CHOICE.YES, 201, 'p1')]);
  chain.votes.set(212, [voteFor(R.idBytes, CHOICE.YES, 212, 'r1')]);     // the first block of the repeal's voting phase
  const Y = seat(chain), X = seat(chain);
  // P IS POSTED TO SEAT Y ONLY (X pulls it later): Y counts it, it passes and activates at 208
  assert.equal((await Y.proposals.add({ proposal: P.hex, blockHash: P.block })).status, 201);
  for (const t of [201, 207, 208, 212]) { chain.tip = t; await Y.tally.pass(); await X.tally.pass(); }
  assert.equal(Y.tally.live(toHex(NET)).configHash, toHex(configHashOf(Uint8Array.of(1, 2, 3))), 'C1 live at Y');
  // R IS POSTED TO BOTH SEATS
  const atY = await Y.proposals.add({ proposal: R.hex, blockHash: R.block });
  const atX = await X.proposals.add({ proposal: R.hex, blockHash: R.block });
  // X's peer pull then brings P (as server.js pullProposals does): X now holds P and counts it
  assert.equal(await X.proposals.pull(Y.proposals.list()), 1);
  for (const t of [213, 214, 218, 219, 221]) { chain.tip = t; await Y.tally.pass(); await X.tally.pass(); }
  const ry = Y.proposals.list().find((r) => r.id === toHex(R.idBytes)), rx = X.proposals.list().find((r) => r.id === toHex(R.idBytes));
  const out = (r) => ({ repeal: r.repeal, votingFrom: r.votingFrom, votingUntil: r.votingUntil, passed: r.decided ? r.decided.passed : null });
  console.log('  R AT Y:', JSON.stringify({ status: atY.status, ...out(ry) }), '  R AT X:', JSON.stringify({ status: atX.status, ...out(rx) }));
  console.log('  LIVE AT 221: Y', Y.tally.live(toHex(NET)).configHash.slice(0, 16), ' X', X.tally.live(toHex(NET)).configHash.slice(0, 16));
  // ONE PROPOSAL, ONE SCHEDULE AT EVERY SEAT (27A.7.6: "the tally is a pure function of chain state")
  assert.deepEqual(out(rx), out(ry), 'both seats keep the repeal with the same schedule and decide it the same way');
  assert.equal(X.tally.live(toHex(NET)).configHash, Y.tally.live(toHex(NET)).configHash, 'both seats run the same config at 221');
});
