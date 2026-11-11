// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4 census-1: A PROPOSAL REVEALED AFTER ITS OWN VOTING PHASE (and after its activation height) is kept and counted.
// Its publication height is its deposit's confirmation height, not the height the network first saw it. The deposit
// transaction commits to nothing of the proposal, so a bonded proposer can confirm a deposit, vote YES on chain with his own
// bond (the vote names only proposal_id[0:8] - nobody else can know what it is), and post the proposal only after the
// voting phase and the activation height are behind. Every seat then counts a phase no honest bond could vote NO in, passes
// it, and makes the new config live RETROACTIVELY: the rounds created since the activation height under the old config,
// which the seat served until now, are refused mid-flight (configServesRound).
// SAFE: a proposal first posted once its voting phase has begun on this seat's chain is not taken (or not counted), and a
// round the seat served under the live config is never refused later because of a proposal nobody could see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, BALLOT_GENESIS, configServesRound } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const ATTACKER = key(0x51), H1 = key(0x52), H2 = key(0x53);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const NET = new Uint8Array(32).fill(0x4e), NETHEX = toHex(NET);
// the attacker's bond is 35 % of the census: alone above DESIGN's 30 % turnout; the two honest bonds hold 65 % and would vote NO
const CENSUS = [{ pubkey: ATTACKER.pubkey, outpoint: 'aa:0', bondSats: 35000000n }, { pubkey: H1.pubkey, outpoint: 'bb:0', bondSats: 35000000n },
  { pubkey: H2.pubkey, outpoint: 'cc:0', bondSats: 30000000n }];

test('a proposal first posted after its voting phase and activation is not counted, and rounds served under the live config stay served', async () => {
  const DEP_HEIGHT = 200;
  const want = depositOutputsExpected(1000, SET);
  const raw = tx(want.outputs.map((o) => ({ sats: o.sats, script: o.script })));
  const config = Uint8Array.of(9, 9, 9);
  const p = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN,
    activationHeight: DEP_HEIGHT + 8, proposer: ATTACKER.pubkey, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const signature = schnorr.sign(proposalBodyId(p), ATTACKER.secret);
  const idBytes = proposalId({ ...p, signature });
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature]));
  const txid = toHex(Uint8Array.from(p.depositTxid).reverse());
  const BLOCK = 'dd'.repeat(32);
  // THE CHAIN: the deposit at 200, the attacker's own YES at 202 (inside 201..206), the tip far past activation (208)
  const votes = new Map([[202, [{ payload: encodeVote({ proposalId: idBytes, choice: CHOICE.YES, signature: schnorr.sign(voteMessage(idBytes, CHOICE.YES), ATTACKER.secret) }), height: 202, txid: 'a1' }]]]);
  let tip = 250;
  let tally = null;
  const proposals = createProposals({ confirmedTx: async (t, b) => (t === txid && b === BLOCK ? { raw, height: DEP_HEIGHT } : null),
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
    historyFor: (net, h) => tally.historyAt(net, h), censusAt: async () => CENSUS, store: { read: () => [], write: () => {} } });
  tally = createBallotTally({ proposals, tipHeight: async () => tip, votesAt: async (h) => votes.get(h) || [], censusAt: async () => CENSUS, verify,
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  // BEFORE THE REVEAL: the seat serves rounds created at 220 under the genesis config (live, nothing proposed)
  await tally.pass();
  const before = configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 220, history: tally.spans(NETHEX) });
  assert.equal(before.ok, true);
  // THE REVEAL at tip 250: voting ended at 206, activation was 208
  const got = await proposals.add({ proposal: hex, blockHash: BLOCK });
  await tally.pass(); await tally.pass();
  const listed = tally.list()[0];
  const after = configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 220, history: tally.spans(NETHEX) });
  console.log('  REVEALED LATE:', JSON.stringify({ addStatus: got.status, publishedAt: got.publishedAt, votingFrom: got.votingFrom, votingUntil: got.votingUntil,
    activation: got.activationHeight, tip, phase: listed && listed.phase, tally: listed && listed.tally && { yes: listed.tally.yesSats, turnout: listed.tally.turnoutPct, passed: listed.tally.passed },
    live: tally.live(NETHEX).configHash.slice(0, 16), liveSince: tally.live(NETHEX).since, roundAt220OnGenesis: after }));
  assert.ok(!(listed && listed.tally && listed.tally.passed), 'a proposal nobody could see during its voting phase must not pass on the proposer\'s own vote');
  assert.equal(after.ok, true, 'a round created at 220 under the config live then is still served');
});
