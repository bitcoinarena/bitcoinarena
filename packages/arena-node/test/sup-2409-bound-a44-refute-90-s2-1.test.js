// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536: every deposit here is BOUND (#2125, regtest and mainnet from block 0: it commits to its proposer and body) and votes carry a seq.
// kanban #1489 fix-refute audit44, item 90 (kanban #1842 / #2188), skeptic 2: the late door's grace is still a seat-local tip
// test, so any seat that learns of a repeal after its own grace closes refuses it for good - one seat counts it and goes live on
// the old config, the other keeps the replaced one. Three roads past the grace, none of them the 10-min pull of #2188:
//   1. a seat that RESUMES after a restart / upgrade of more than the grace (mainnet: 7 blocks, about 70 minutes);
//   2. a bonded proposer (one seat's operator) who posts his repeal to ONE seat in its last grace block;
//   3. the RETRY path: a 503 ("ask again shortly", P undecided here) that turns into a 422 by the time it is asked again.
// Each must FAIL on 631a406b5.
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
const tx = (fill, outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(fill), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const secret = new Uint8Array(32).fill(1); const proposer = schnorr.getPublicKey(secret);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e); const NETHEX = toHex(NET);
const CENSUS = [{ pubkey: proposer, outpoint: 'aa:0', bondSats: 50000000n }];
const X = Uint8Array.of(1, 2, 3);

function proposal(chain, { fill, parent, config, activationHeight, height }) {
  const want = depositOutputsExpected(1000, SET);
  let raw; const mk = (extra) => tx(fill, [...want.outputs.map((o) => ({ sats: o.sats, script: o.script })), ...extra]);
  const p = { networkId: NET, parent, configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight, proposer,
    depositTxid: null };
  raw = mk([{ sats: 0, script: depositCommitmentScript(p) }]); p.depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  const signature = schnorr.sign(proposalBodyId(p), secret);
  const block = toHex(new Uint8Array(32).fill(fill));
  chain.deposits.set(toHex(Uint8Array.from(p.depositTxid).reverse()), { raw, height, block });
  return { idBytes: proposalId({ ...p, signature }), id: toHex(proposalId({ ...p, signature })), body: { proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), blockHash: block } };
}
const voteFor = (idBytes, choice, height, txid) => ({ payload: encodeVote({ proposalId: idBytes, choice, seq: SEQ(), signature: schnorr.sign(voteMessage(idBytes, choice, SEQ.last), secret) }), height, txid });

/** One seat with its OWN tip (seats see blocks at different moments), wired as server.js wires them. */
function seat(chain, { mainnet = false } = {}) {
  const me = { tip: chain.tip, rpcDown: false };
  let tally = null;
  const proposals = createProposals({ bindHeightFor: () => 0,
    confirmedTx: async (txid, block) => { const d = chain.deposits.get(txid); return d && d.block === block ? { raw: d.raw, height: d.height } : null; },
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify,
    scheduleFor: () => (mainnet ? SCHEDULES.mainnet : SCHEDULES.regtest), repealScheduleFor: () => (mainnet ? REPEAL_SCHEDULES.mainnet : REPEAL_SCHEDULES.regtest),
    historyFor: (net, h) => (tally ? tally.historyAt(net, h) : null), censusAt: async () => CENSUS, store: { read: () => [], write: () => {} } });
  tally = createBallotTally({ proposals, tipHeight: async () => me.tip, votesAt: async (h) => chain.votes.get(h) || [], censusAt: async () => CENSUS, verify,
    blockHashAt: async (h) => { if (me.rpcDown) throw new Error('bitcoind did not answer'); if (h > me.tip) return null; const d = [...chain.deposits.values()].find((x) => x.height === h); return d ? d.block : toHex(le(h, 32)); },
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  return { me, proposals, tally };
}
const view = (r) => (r ? { repeal: !!r.repeal, votingFrom: r.votingFrom, votingUntil: r.votingUntil } : null);

test('s2-1 RESUME: a seat back from a 70-minute restart (7 mainnet blocks) refuses the honest repeal every other seat counts, for good', async () => {
  const chain = { tip: 1000, deposits: new Map(), votes: new Map() };
  // P: genesis -> X, published 1000 (mainnet DESIGN: voting 2008-3448, cooldown to 5464), activates 5464
  const P = proposal(chain, { fill: 41, parent: BALLOT_GENESIS.configHash, config: X, activationHeight: 5464, height: 1000 });
  // R: X -> genesis bytes, a repeal (27A.7.6: review 0, voting 720), published 5500, activates 6300
  const R = proposal(chain, { fill: 42, parent: configHashOf(X), config: BALLOT_GENESIS.config, activationHeight: 6300, height: 5500 });
  const s1 = seat(chain, { mainnet: true }), s2 = seat(chain, { mainnet: true });
  for (const s of [s1, s2]) {
    assert.equal((await s.proposals.add(P.body)).status, 201);
    assert.equal(s.proposals.decide(P.id, { passed: true, decidedAt: 3460, anchor: null }), true);
  }
  // R posted to seat 1 at its block; seat 2 is down for an upgrade from 5500 and back at 5507 - its first pull then
  s1.me.tip = 5500;
  const at1 = await s1.proposals.add(R.body);
  assert.equal(at1.status, 201, at1.why);
  s2.me.tip = 5507;
  const took = await s2.proposals.pull(s1.proposals.list());
  const at2 = await s2.proposals.add(R.body);              // and POSTed again by hand: the same answer
  console.log('  seat 1:', at1.status, JSON.stringify(view(at1)), ' seat 2 back at 5507: pulled', took, '- POST', at2.status, at2.why);
  assert.deepEqual(view(s2.proposals.list().find((x) => x.id === R.id)), view(at1), 'both seats keep the repeal on one schedule');
});
