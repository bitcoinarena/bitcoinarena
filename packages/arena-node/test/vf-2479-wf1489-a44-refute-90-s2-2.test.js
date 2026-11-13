// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2479 (#2536): the card's test as 1.9 reads it - the same adaptation as sup-2409-bound-a44-refute-90-s2-2 (that file).
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

test('s2-2 ONE SEAT, LAST GRACE BLOCK: a bonded proposer posts his repeal to seat 1 only at its last grace block - seat 1 goes live on the old config, seat 2 never holds it', async () => {
  const chain = { tip: 200, deposits: new Map(), votes: new Map() };
  const P = proposal(chain, { fill: 51, parent: BALLOT_GENESIS.configHash, config: X, activationHeight: 208, height: 200 });
  const R = proposal(chain, { fill: 52, parent: configHashOf(X), config: BALLOT_GENESIS.config, activationHeight: 230, height: 220 });
  chain.votes.set(201, [voteFor(P.idBytes, CHOICE.YES, 201, 'p1')]);
  chain.votes.set(224, [voteFor(R.idBytes, CHOICE.YES, 224, 'r1')]);      // his own YES, in R's voting (220-225)
  const s1 = seat(chain), s2 = seat(chain);
  for (const s of [s1, s2]) assert.equal((await s.proposals.add(P.body)).status, 201);
  for (const t of [201, 206, 208, 215, 220, 222]) { s1.me.tip = s2.me.tip = t; await s1.tally.pass(); await s2.tally.pass(); }
  assert.equal(s1.tally.live(NETHEX).configHash, toHex(configHashOf(X)));
  // regtest's door for a repeal published at 220: max(220, 221) + min(6, 3) = 224, so 223 is the last block it is taken in
  s1.me.tip = s2.me.tip = 223;
  const at1 = await s1.proposals.add(R.body);
  assert.equal(at1.status, 201, at1.why);
  // seat 2's next pull, a block later
  s1.me.tip = s2.me.tip = 224;
  const took = await s2.proposals.pull(s1.proposals.list());
  for (const t of [224, 225, 226, 230, 231]) { s1.me.tip = s2.me.tip = t; await s1.tally.pass(); await s2.tally.pass(); }
  console.log('  states: seat 1', JSON.stringify(s1.proposals.list().map((x) => x.state)), ' seat 2', JSON.stringify(s2.proposals.list().map((x) => x.state)));
  const l1 = s1.tally.live(NETHEX).configHash, l2 = s2.tally.live(NETHEX).configHash;
  console.log('  pulled at 224:', took, ' live at 231: seat 1', l1.slice(0, 16), ' seat 2', l2.slice(0, 16));
  assert.equal(l2, l1, 'both seats run the same config at 231');
});
