// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2590 (attacker audit of the ballot binding #2562), finding 1: ONE PROPOSER UNDOES HIS PASSED PROPOSAL AFTER ITS VOTE.
// A bound deposit commits to proposalCommitment(body) - the body with deposit_txid zeroed, WITHOUT the proposer's signature - while
// proposal_id = H(body || signature). So the proposer can sign the same body again (BIP-340 aux randomness: new bytes, new id) and the
// twin passes depositOf. Since #2562 a bound proposal is taken at any time (no #1608 tip check), and a deposit backing two kept
// proposals backs none (#1840: counts() false, not live). So after his proposal passed and activated, the proposer posts a twin
// and every seat that takes it (the peer pull carries it to all) drops the config the vote made live - a repeal nobody voted on,
// at a moment of his choosing (mid-series: rounds created under it are refused). Before #2562 the tip check refused the twin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createProposals } from '../src/proposals.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, CLASS, SCHEDULES, REPEAL_SCHEDULES, configHashOf } from '../../arena-protocol/src/ballot.js';
import { depositOutputsExpected, depositCommitmentScript } from '../../arena-protocol/src/ballot-chain.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const le = (n, bytes) => Uint8Array.from({ length: bytes }, (_, i) => Number((BigInt(n) >> BigInt(8 * i)) & 0xffn));
const tx = (fill, outs) => Uint8Array.from([...le(2, 4), 1, ...new Uint8Array(32).fill(fill), ...le(0, 4), 0, ...le(0xffffffff, 4),
  outs.length, ...outs.flatMap((o) => [...le(o.sats, 8), o.script.length, ...o.script]), ...le(0, 4)]);
const secret = new Uint8Array(32).fill(1); const proposer = schnorr.getPublicKey(secret);
const pk = (i) => Uint8Array.from([0x02, ...schnorr.getPublicKey(new Uint8Array(32).fill(i))]);
const SET = [{ recipientPk: pk(2), shareBps: 6000, label: 'a' }, { recipientPk: pk(3), shareBps: 4000, label: 'b' }];
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const NET = new Uint8Array(32).fill(0x4e);
const G = Uint8Array.of(7, 7, 7), X = Uint8Array.of(1, 2, 3);
const GENESIS = { configHash: configHashOf(G), config: G };
const chain = new Map();
const BLOCK = '20'.repeat(32);

// one bound deposit at 200 for P: G -> X (regtest 1 / 6 / 1, activation 208); `aux` picks the signature, the body is the same
const body = { networkId: NET, parent: GENESIS.configHash, configHash: configHashOf(X), config: X, class: CLASS.DESIGN, activationHeight: 208, proposer };
const raw = tx(9, [...depositOutputsExpected(1000, SET).outputs.map((o) => ({ sats: o.sats, script: o.script })), { sats: 0, script: depositCommitmentScript(body) }]);
const depositTxid = Uint8Array.from(parseTransaction(raw).txid);
chain.set(toHex(Uint8Array.from(depositTxid).reverse()), { raw, height: 200, block: BLOCK });
const signed = (aux) => { const p = { ...body, depositTxid };
  return { proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...schnorr.sign(proposalBodyId(p), secret, new Uint8Array(32).fill(aux))])), blockHash: BLOCK }; };

test('#2590-1: a twin of a passed bound proposal (same body, a new signature) posted after its vote does not void it', async () => {
  let tally = null;
  const proposals = createProposals({ confirmedTx: async (txid, block) => { const t = chain.get(txid); return t && t.block === block ? { raw: t.raw, height: t.height } : null; },
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, scheduleFor: () => SCHEDULES.regtest, repealScheduleFor: () => REPEAL_SCHEDULES.regtest,
    historyFor: (net, h) => tally.historyAt(net, h), censusAt: async () => [{ pubkey: proposer }], store: { read: () => [], write: () => {} }, bindHeightFor: () => 0 });
  tally = createBallotTally({ proposals, tipHeight: async () => 300, votesAt: async () => [], censusAt: async () => [], verify, genesisFor: () => GENESIS });
  const a = await proposals.add(signed(1)); assert.equal(a.status, 201, a.why);
  assert.equal(proposals.decide(a.id, { passed: true, decidedAt: 207, anchor: null }), true);       // the vote passed it
  const liveAt = (h) => toHex(tally.historyAt(toHex(NET), h).at(-1).configHash);
  assert.equal(liveAt(300), toHex(configHashOf(X)), 'X is live after its activation');
  const twin = signed(2);
  assert.notEqual(twin.proposal, signed(1).proposal, 'another signature over the same body');
  const b = await proposals.add(twin);                                   // tip 300: long after its voting phase (201-207)
  console.log('  the twin posted at tip 300:', JSON.stringify({ status: b.status, why: b.why || null, aCounts: proposals.counts(a.id) }));
  assert.equal(proposals.counts(a.id), true, 'the passed proposal still counts');
  assert.equal(liveAt(300), toHex(configHashOf(X)), 'X stays live: no proposer undoes a vote');
  // kanban #2607 (ruling #2591 (c)): the twin is the same proposal - taken (no tip check), and it changes nothing the vote decided
  assert.equal(b.status, 201, b.why);
});

test('#2590-1: a twin posted before the voting phase is the same proposal: one of the two counts (kanban #2607, was #1840)', async () => {
  let tally = null;
  const proposals = createProposals({ confirmedTx: async (txid, block) => { const t = chain.get(txid); return t && t.block === block ? { raw: t.raw, height: t.height } : null; },
    recipientsFor: () => SET, lowestBondMinSatsFor: () => 100000n, verify, scheduleFor: () => SCHEDULES.regtest, repealScheduleFor: () => REPEAL_SCHEDULES.regtest,
    historyFor: (net, h) => tally.historyAt(net, h), censusAt: async () => [{ pubkey: proposer }], store: { read: () => [], write: () => {} }, bindHeightFor: () => 0 });
  tally = createBallotTally({ proposals, tipHeight: async () => 200, votesAt: async () => [], censusAt: async () => [], verify, genesisFor: () => GENESIS });
  const a = await proposals.add(signed(3)); assert.equal(a.status, 201, a.why);
  const b = await proposals.add(signed(4)); assert.equal(b.status, 201, b.why);
  assert.equal([proposals.counts(a.id), proposals.counts(b.id)].filter(Boolean).length, 1);
});
