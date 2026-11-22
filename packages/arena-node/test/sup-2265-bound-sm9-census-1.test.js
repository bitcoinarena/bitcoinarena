// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit round 9 (census), finding 1: A PROPOSAL A SEAT FIRST HEARS OF AFTER ITS OWN ACTIVATION HEIGHT
// (a late answer). proposals.js add takes a proposal at any time - nothing compares the tip with its voting phase or its activation.
// The body is not on chain (only its deposit and the votes' 8-byte id prefix are), so a seat knows a proposal only once somebody
// POSTs it or the peer pull (every 10 min) carries it. A proposal whose body reaches a seat only after its activation (withheld by
// its proposer and the bonds voting for it, or a seat that was away) is decided in that seat's next pass - the whole phase is
// already deep - and its config is live retroactively from its activation height: ballot-tally spans changes UNDER rounds this seat
// already served. A round created at a census height after the activation, naming the config live then (genesis), was served
// (POST /round 202, listing, entries, locks); the next pass refuses it (configRefusal / offerRefusal) mid-flight, and two seats
// holding the proposal at different times answer that round differently. Real proposals.js add (deposit, census, history) and
// ballot-tally.js with the production wiring (historyFor = the tally's historyAt).
// Adapted to 1.9 by #2536: the deposit is BOUND (#2125, regtest and mainnet from block 0) - it commits to the proposer and the body, so the
// body is fixed on chain at the deposit's height and the proposal is taken at any time; the card's own door (refused at its activation,
// its second test) is the #1608 tip check the binding ruling replaced, and is not kept. What must hold is the first test's invariant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, encodeVote, voteMessage, CLASS, CHOICE, SCHEDULES, REPEAL_SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript, BALLOT_GENESIS, configServesRound } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

// a bound vote carries a seq (#2125): each vote here one higher than the last
const SEQ = () => (SEQ.last = (SEQ.last || 0) + 1); SEQ.last = 0;
const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(7), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 10000, label: 'a' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31), B = key(0x32), C = key(0x33);
const CENSUS = [{ pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 50000000n }, { pubkey: B.pubkey, outpoint: 'bb:0', bondSats: 30000000n },
  { pubkey: C.pubkey, outpoint: 'cc:0', bondSats: 20000000n }];
const NETB = new Uint8Array(32).fill(0x4e), NET = toHex(NETB);
const hashAt = (h) => `00${String(h).padStart(6, '0')}`.padEnd(64, 'f');
const vote = (who, idBytes, choice, height, txid) => ({ payload: encodeVote({ proposalId: idBytes, choice, seq: SEQ(), signature: schnorr.sign(voteMessage(idBytes, choice, SEQ.last), who.secret) }), height, txid });

test('wf1489-sm9-census-1: a proposal first posted after its activation does not change the config of rounds this seat already served', { todo: 'kanban #2265 open on 1.9 bound reading: needs a ruling (a bound proposal is taken at any time, #2125)' }, async () => {
  const PUB = 200;
  const S = SCHEDULES.regtest[CLASS.DESIGN] || SCHEDULES.regtest.DESIGN;
  const activation = PUB + S.review + S.voting + S.cooldown;
  const config = Uint8Array.of(9, 9, 9);
  const body = { networkId: NETB, parent: BALLOT_GENESIS.configHash, configHash: configHashOf(config), config, class: CLASS.DESIGN, activationHeight: activation,
    proposer: A.pubkey };
  // BOUND (#2125): the deposit commits to the proposer and the body
  const raw = tx([...depositOutputsExpected(1, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })), { sats: 0, script: depositCommitmentScript(body) }]);
  const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
  const display = toHex(Uint8Array.from(depositTxid).reverse());
  const p = { ...body, depositTxid };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  const hex = toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature]));
  // the bonds A and B voted YES inside the voting phase, on chain, while no seat held the body
  const votes = new Map([[PUB + S.review, [vote(A, idBytes, CHOICE.YES, PUB + S.review, 'a1'), vote(B, idBytes, CHOICE.YES, PUB + S.review, 'b1')]]]);
  const chain = { tip: PUB };
  const rows = new Map();
  let tally = null;
  const proposals = createProposals({ bindHeightFor: () => 0, confirmedTx: async (txid, block) => (block === hashAt(PUB) && txid === display && chain.tip >= PUB ? { raw, height: PUB } : null),
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, schedule: SCHEDULES.regtest, repealSchedule: REPEAL_SCHEDULES.regtest,
    historyFor: (net, h) => (tally ? tally.historyAt(net, h) : null), censusAt: async () => CENSUS,
    store: { read: () => [...rows.values()].map((j) => JSON.parse(j)), write: (list) => { for (const x of list) rows.set(x.id, JSON.stringify(x)); } } });
  tally = createBallotTally({ proposals, tipHeight: async () => chain.tip, votesAt: async (h) => votes.get(h) || [], censusAt: async () => CENSUS,
    blockHashAt: async (h) => (h <= chain.tip ? hashAt(h) : null), verify, decideDepthFor: () => 6, minDecideDepthFor: () => 1 });
  // the seat runs on, holding no proposal: a round created at census height activation + 2 names the genesis config and is served
  for (chain.tip = PUB; chain.tip <= activation + 20; chain.tip++) await tally.pass();
  const ROUND_CENSUS = activation + 2;
  const serve = () => configServesRound({ configHash: BALLOT_GENESIS.configHash, height: ROUND_CENSUS, history: tally.spans(NET) });
  const before = serve();
  // ... and only now, 20 blocks after its activation, the proposal's body reaches this seat
  const got = await proposals.add({ proposal: hex, blockHash: hashAt(PUB) });
  await tally.pass();
  const after = serve();
  const st = proposals.list().find((x) => x.id === toHex(idBytes));
  console.log('  wf1489-sm9-census-1:', JSON.stringify({ activation, tip: chain.tip, posted: got.status, state: st && st.state, decidedAt: st && st.decided && st.decided.decidedAt,
    live: tally.live(NET).configHash.slice(0, 8), roundAt: ROUND_CENSUS, servedBefore: before.ok, servedAfter: after.ok, why: after.why }));
  assert.equal(got.status, 201, `the bound proposal was not taken: ${got.why}`);
  assert.equal(before.ok, true, 'the round was served under the genesis config');
  assert.equal(after.ok, before.ok, `a round created at census ${ROUND_CENSUS} and served under the config live then keeps that answer; a late proposal does not refuse it retroactively`);
});
