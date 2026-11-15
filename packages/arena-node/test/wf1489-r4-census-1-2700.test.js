// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r4 census-1: A PROPOSAL SHOWN TO A MINORITY OF SEATS IN ITS LAST VOTING BLOCK GOES LIVE THERE AND NOWHERE ELSE.
// #2432 (decided 2026-11-14 "a text counts only if a seat majority held it before voting ended") is applied only at a seat that first
// holds the proposal AFTER its voting ended (kept LATE until a census majority's sightings). A seat that holds it one block before the
// end counts it at once, on its own sighting alone. So a bonded proposer (35 % here, above DESIGN's 30 % turnout) commits a deposit,
// votes YES with his own bond, and POSTs the text (POST /proposal is open to anyone) to seat A only, at tip votingUntil-1. Seat A
// counts and passes it and makes the new config live; every other seat pulls it a block later, keeps it LATE, holds only A's sighting
// (a minority of the census weight) and never counts it. Two configs live on one network: A refuses every round the others create
// under the old config after the activation height, and they refuse A's (configServesRound) - by the proposer's choice of seats.
// SAFE: one seat's in-time sighting alone does not make a proposal count there either - every seat reaches the same outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE, SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript, BALLOT_GENESIS, configServesRound } from '../../arena-protocol/src/ballot-chain.js';
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
// seat A is H2's (30 of the 65 non-proposer weight: a minority); seat B is H1's (35 of 65)
const CENSUS = [{ pubkey: ATTACKER.pubkey, outpoint: 'aa:0', bondSats: 35000000n }, { pubkey: H1.pubkey, outpoint: 'bb:0', bondSats: 35000000n },
  { pubkey: H2.pubkey, outpoint: 'cc:0', bondSats: 30000000n }];
const DEP_HEIGHT = 200;
const BLOCK = 'dd'.repeat(32);

function chain() {
  const want = depositOutputsExpected(1000, SET);
  const config = Uint8Array.of(9, 9, 9);
  const body0 = { networkId: NET, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight: DEP_HEIGHT + 8, proposer: ATTACKER.pubkey };
  const raw = tx([...want.outputs.map((o) => ({ sats: o.sats, script: o.script })), { sats: 0, script: depositCommitmentScript(body0) }]);
  const p = { ...body0, depositTxid: Uint8Array.from(parseTransaction(raw).txid) };
  const signature = schnorr.sign(proposalBodyId(p), ATTACKER.secret);
  const idBytes = proposalId({ ...p, signature });
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature]));
  const txid = toHex(Uint8Array.from(p.depositTxid).reverse());
  // the proposer's own bound YES at 202, inside voting 201..206
  const votes = new Map([[202, [{ payload: encodeVote({ proposalId: idBytes, choice: CHOICE.YES, seq: 1, signature: schnorr.sign(voteMessage(idBytes, CHOICE.YES, 1), ATTACKER.secret) }), height: 202, txid: 'a1' }]]]);
  return { raw, txid, hex, votes, idBytes };
}

function seat(c, signer, tipRef) {
  let tally = null;
  const proposals = createProposals({ bindHeightFor: () => 0, confirmedTx: async (t, b) => (t === c.txid && b === BLOCK ? { raw: c.raw, height: DEP_HEIGHT } : null),
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
    historyFor: (net, h) => tally.historyAt(net, h), censusAt: async () => CENSUS, store: { read: () => [], write: () => {} },
    tipHeight: async () => tipRef.tip, seenSigner: { pubkey: signer.pubkey, sign: (m) => schnorr.sign(m, signer.secret) } });
  tally = createBallotTally({ proposals, tipHeight: async () => tipRef.tip, votesAt: async (h) => c.votes.get(h) || [], censusAt: async () => CENSUS, verify,
    decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
  return { proposals, tally };
}

test('a proposal posted to one minority seat in its last voting block does not go live there while every other seat keeps the old config', async () => {
  const c = chain();
  const tipA = { tip: 206 }, tipB = { tip: 206 };
  const A = seat(c, H2, tipA), B = seat(c, H1, tipB);
  await A.tally.pass(); await B.tally.pass();
  // THE PROPOSER POSTS TO SEAT A ONLY, at its last voting block (206; voting ends at 207)
  const got = await A.proposals.add({ proposal: c.hex, blockHash: BLOCK });
  assert.equal(got.status, 201);
  // ONE BLOCK LATER every seat moves on; B pulls A's listing (records with A's signed sighting) - the honest peer pull
  tipA.tip = 210; tipB.tip = 210;
  await B.proposals.pull(A.proposals.list());
  for (let i = 0; i < 3; i++) { await A.tally.pass(); await B.tally.pass(); }
  const id = toHex(c.idBytes);
  const atA = configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 209, history: A.tally.spans(NETHEX) });
  const atB = configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 209, history: B.tally.spans(NETHEX) });
  const listedA = A.tally.list().find((x) => x.id === id), listedB = B.tally.list().find((x) => x.id === id);
  console.log('  SEAT A (in time):', JSON.stringify({ counts: A.proposals.counts(id), phase: listedA && listedA.phase, passed: !!(listedA && listedA.tally && listedA.tally.passed), servesGenesisRoundAt209: atA.ok }));
  console.log('  SEAT B (pulled):', JSON.stringify({ counts: B.proposals.counts(id), phase: listedB && listedB.phase, servesGenesisRoundAt209: atB.ok }));
  assert.equal(A.proposals.counts(id), B.proposals.counts(id), 'the two seats on one chain must agree whether the proposal counts');
  assert.equal(atA.ok, atB.ok, 'the two seats on one chain must serve the same config at 209');
});
