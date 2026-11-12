// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute-13 (#1608): the tip check makes a seat's ballot depend on WHEN it heard of a proposal. A proposal
// posted to one seat in the last block before its voting (the documented single-seat post, #1152) is taken there; every other
// seat hears it only through the peer pull (30 s after start, then every 10 min), after its voting began, and refuses it.
// The proposal passes at seat A and nowhere else: two seats go live on different configs, and a round created after the
// activation under the new config is served at A and refused at B (and the other way round for the genesis config).
// SAFE: seats that read the same chain agree on the live config.
// TODO, NOT A PASS (kanban #2135, #2197, spec question #2012): which seat heard of an off-chain proposal before its voting is not
// chain state, and no rule on this seat's own reads closes both this split and #1608. Taking a peer's word that it held the
// proposal in time (the pull) lets one bonded seat reopen #1608 (post late to its own seat, claim an early sighting); a quorum
// of such claims splits again at its own edge and refuses a one-seat network; an on-chain commitment in the deposit is a new
// shared protocol rule (and the deposit cannot name proposal_id, which hashes deposit_txid). This test waits for the ruling.
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


test('two seats on the same chain go live on the same config, whatever block each first heard of the proposal in', { todo: 'kanban #2012 (spec question): which seats knew an off-chain proposal before its voting is not chain state - waiting for the ruling (#2135, #2197)' }, async () => {
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
  const votes = new Map([[202, [{ payload: encodeVote({ proposalId: idBytes, choice: CHOICE.YES, signature: schnorr.sign(voteMessage(idBytes, CHOICE.YES), ATTACKER.secret) }), height: 202, txid: 'a1' }]]]);
  let tip = DEP_HEIGHT;
  const seat = () => {
    let tally = null;
    const proposals = createProposals({ confirmedTx: async (t, b) => (t === txid && b === BLOCK ? { raw, height: DEP_HEIGHT } : null),
      recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest,
      historyFor: (net, h) => tally.historyAt(net, h), censusAt: async () => CENSUS, store: { read: () => [], write: () => {} } });
    tally = createBallotTally({ proposals, tipHeight: async () => tip, votesAt: async (h) => votes.get(h) || [], censusAt: async () => CENSUS, verify,
      decideDepthFor: () => 1, minDecideDepthFor: () => 1 });
    return { proposals, tally };
  };
  const A = seat(), B = seat();
  await A.tally.pass(); await B.tally.pass();
  // posted to seat A in the deposit's own block (tip 200, voting from 201)
  const atA = await A.proposals.add({ proposal: hex, blockHash: BLOCK });
  // the next block, then seat B's peer pull from A
  tip = DEP_HEIGHT + 1;
  const tookB = await B.proposals.pull(A.proposals.list());
  tip = 250;
  for (let i = 0; i < 3; i++) { await A.tally.pass(); await B.tally.pass(); }
  const liveA = A.tally.live(NETHEX).configHash, liveB = B.tally.live(NETHEX).configHash;
  const r230A = configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 230, history: A.tally.spans(NETHEX) });
  const r230B = configServesRound({ configHash: BALLOT_GENESIS.configHash, height: 230, history: B.tally.spans(NETHEX) });
  console.log('  SPLIT:', JSON.stringify({ addAtA: atA.status, tookByPullAtB: tookB, liveA: liveA.slice(0, 16), liveB: liveB.slice(0, 16),
    roundAt230Genesis: { A: r230A.ok, B: r230B.ok } }));
  assert.equal(atA.status, 201);
  assert.equal(liveA, liveB, 'two seats reading the same chain must agree on the live config');
  assert.equal(r230A.ok, r230B.ok, 'a round is served at every seat or at none');
});
