// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 r2 census-1 (bypass of #1564): a stranger who knows a public proposal id fills ONE block of its voting phase with
// junk vote outputs under its id prefix. #1564 stopped re-verifying junk on every later block, but each junk vote is still
// checked once against EVERY bond of the census (keepVote), synchronously, with no bound per block or per pass. A testnet4
// block holds ~10,000 such 77-byte OP_RETURN outputs; with a census of 20 bonds that is 200,000 BIP-340 checks on the seat's
// event loop for one block - every seat that keeps the proposal stalls (rounds, seating, settlement), for a few sats of fees.
// SAFE: the work one block of votes can cost a seat is bounded (votes per block / per pass capped, or bonds identified
// without trying every census key), so a block of junk costs at most a small multiple of the census size in signature checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createBallotTally } from '../src/ballot-tally.js';
import { encodeConfigProposalBody, proposalBodyId, proposalId, CLASS, CHOICE, encodeVote, voteMessage } from '../../arena-protocol/src/ballot.js';
import { BALLOT_GENESIS } from '../../arena-protocol/src/ballot-chain.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const H = (b) => new Uint8Array(32).fill(b);
const key = (b) => { const secret = new Uint8Array(32).fill(b); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
const A = key(0x31);
const BONDS = Array.from({ length: 20 }, (_, i) => key(0x40 + i));
const CENSUS = BONDS.map((k, i) => ({ pubkey: k.pubkey, outpoint: `${i}:0`, bondSats: 1000000n }));
CENSUS[0] = { pubkey: A.pubkey, outpoint: 'aa:0', bondSats: 1000000n };

function kept(publishedAt = 100) {
  const p = { networkId: H(0x4e), parent: BALLOT_GENESIS.configHash, configHash: H(0x22), config: Uint8Array.of(2), class: CLASS.DESIGN,
    activationHeight: publishedAt + 8, proposer: A.pubkey, depositTxid: H(0x77) };
  const signature = schnorr.sign(proposalBodyId(p), A.secret);
  const idBytes = proposalId({ ...p, signature });
  return { idBytes, record: { id: toHex(idBytes), proposal: toHex(Uint8Array.from([...encodeConfigProposalBody(p), ...signature])), networkId: toHex(H(0x4e)),
    parent: toHex(p.parent), configHash: toHex(p.configHash), class: 'DESIGN', proposer: toHex(A.pubkey), publishedAt, depositSats: '1000',
    votingFrom: publishedAt + 1, votingUntil: publishedAt + 7, activationHeight: p.activationHeight, repeal: false } };
}
/** A junk 77-byte vote: "ARN" 'V', the proposal's 8-byte prefix, YES, 64 random bytes as its signature. */
function junkVote(idBytes, i, height) {
  const payload = new Uint8Array(77);
  payload.set([0x41, 0x52, 0x4e, 0x56], 0); payload.set(idBytes.subarray(0, 8), 4); payload[12] = CHOICE.YES;
  const sig = new Uint8Array(64); for (let j = 0; j < 64; j++) sig[j] = (i * 31 + j * 7 + 1) & 0xff; sig[0] = 0x11; sig[32] = 0x22;
  payload.set(sig, 13);
  return { payload, height, txid: i.toString(16).padStart(64, '0') };
}

test('wf1489 r2 census-1: one block of junk votes under a proposal prefix costs a bounded number of signature checks', async () => {
  const { idBytes, record } = kept();
  const JUNK = 5000;
  const junk = Array.from({ length: JUNK }, (_, i) => junkVote(idBytes, i, 101));
  let verifies = 0;
  const countingVerify = () => { verifies++; return false; };
  const held = new Map([[record.id, record]]);
  // kanban #2671 (ruled 2026-11-14): a proposal published at or above its network's BALLOT_KEY_HEIGHT is keyed (proposals.keyed) - this one is
  const proposals = { list: () => [...held.values()], decide: () => true, keyed: () => true };
  let tip = 101;
  const t = createBallotTally({ proposals, tipHeight: async () => tip, votesAt: async (h) => (h === 101 ? junk : []), censusAt: async () => CENSUS,
    verify: countingVerify, decideDepthFor: () => 1, minDecideDepthFor: () => 1, genesisFor: () => BALLOT_GENESIS });
  await t.pass();
  // the real cost of one junk vote at this census: |census| real BIP-340 checks
  const t0 = process.hrtime.bigint();
  const realSample = 20;
  for (let i = 0; i < realSample; i++) { const v = junkVote(idBytes, i, 101); for (const b of CENSUS) { try { schnorr.verify(v.payload.subarray(13), H(i), b.pubkey); } catch { /* junk */ } } }
  const msPerJunkVote = Number(process.hrtime.bigint() - t0) / 1e6 / realSample;
  console.log(`  ${JUNK} junk votes in one block, census of ${CENSUS.length}: ${verifies} signature checks in one pass; real cost ${msPerJunkVote.toFixed(2)} ms per junk vote`
    + ` -> ${(msPerJunkVote * 10000 / 1000).toFixed(1)} s of event loop for a 10,000-vote testnet4 block`);
  assert.ok(verifies <= 4 * CENSUS.length + 1024,
    `one block of ${JUNK} junk votes cost ${verifies} signature checks on the event loop (no bound per block or per pass)`);
});

// kanban #2671: junk in the KEYED format, each naming a real census key, costs exactly one check - and an honest keyed vote still counts
test('#2671: a keyed vote is checked once against the bond it names; junk naming a census key costs one check, an honest vote counts', async () => {
  const { idBytes, record } = kept();
  const JUNK = 2000;
  const junk = Array.from({ length: JUNK }, (_, i) => {
    const sig = new Uint8Array(64); for (let j = 0; j < 64; j++) sig[j] = (i * 13 + j * 5 + 3) & 0xff;
    return { payload: encodeVote({ proposalId: idBytes, choice: CHOICE.YES, seq: 1, signature: sig, bondKey: BONDS[1 + (i % 19)].pubkey }), height: 101, txid: i.toString(16).padStart(64, '0') };
  });
  const honest = { payload: encodeVote({ proposalId: idBytes, choice: CHOICE.YES, seq: 1, signature: schnorr.sign(voteMessage(idBytes, CHOICE.YES, 1), A.secret), bondKey: A.pubkey }),
    height: 102, txid: 'ff'.repeat(32) };
  let verifies = 0;
  const verify = (s, m, k) => { verifies++; try { return schnorr.verify(s, m, k); } catch { return false; } };
  const held = new Map([[record.id, record]]);
  const proposals = { list: () => [...held.values()], decide: () => true, bound: () => true, keyed: () => true };
  const t = createBallotTally({ proposals, tipHeight: async () => 102, votesAt: async (h) => (h === 101 ? junk : h === 102 ? [honest] : []), censusAt: async () => CENSUS,
    verify, decideDepthFor: () => 1, minDecideDepthFor: () => 1, genesisFor: () => BALLOT_GENESIS });
  await t.pass();
  console.log(`  ${JUNK} keyed junk votes + 1 honest: ${verifies} signature checks`);
  assert.ok(verifies <= JUNK + 2, `keyed votes cost ${verifies} checks for ${JUNK + 1} votes: more than one each`);
  const row = t.list().find((x) => x.id === record.id);
  console.log(`  running tally: ${JSON.stringify(row && row.tally)}`);
  assert.ok(row && row.tally && String(row.tally.yesSats) === '1000000', `the honest keyed YES of the named bond counts: ${JSON.stringify(row && row.tally)}`);
});
