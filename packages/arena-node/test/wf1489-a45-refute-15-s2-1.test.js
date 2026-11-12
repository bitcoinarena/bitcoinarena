// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute #1816 / #2248, skeptic 2 (1): ONE COMMITTEE SEAT FILLS EVERY RELAY WITH PROOFS AGAINST ITSELF.
// #2248 keeps one relayed proof per (round, accused node, player, signed result id). The accused node's own key makes as many
// signed results as it likes: a re-run result with a fresh signedAtMs (or contradictedRunId) each time is a new rerunResultId
// for the SAME result body (not a double-sign of a player result), and a player result about a made-up transcript hash is
// not slashable by replay (slashHolds: 'not the canonical one'). Each passes slashOursWhy (round held, on the committee,
// player an entry, its own signature, transcriptHash = the evidence's, its own advertised bond), so all are kept until
// RELAY_MOST is full and every honest transcript of a held entry is refused 507.
// Safe behaviour: one accused (round, node, player) cannot take more than a bounded share of the relay store; honest
// transcripts still go in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { encodeSlashProof, joinSlashEvidence, joinRerunSlashEvidence, encodeFraudProof, fraudProofHash } from '../../arena-protocol/src/slash.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../arena-protocol/src/result.js';
import { encodeRerunResult, rerunResultId, joinSignedRerun } from '../../arena-protocol/src/rerun.js';
import { encodeTranscript } from '../../arena-protocol/src/transcript.js';
import { transcriptBytesHash } from '../../arena-protocol/src/posting.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { assumeAssigned } from './assignment.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { HOSTED } from './plugins/hosted.js';

process.env.ARENA_RELAY_MOST = String(64 * 1024);
const { serve } = await import('../src/server.js');

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [b32(4)],
});

function heldRound() {
  const store = openStore(':memory:');
  const r = new Round(store, () => Date.now(), { plugins: HOSTED });
  const rid = r.open(contract());
  const honestSk = b32(0x62);
  const honestPk = schnorr.getPublicKey(honestSk);
  assumeAssigned(r, rid, [honestPk, schnorr.getPublicKey(b32(0x63)), schnorr.getPublicKey(b32(0x64))]);
  const session = ed25519.utils.randomSecretKey();
  const eid = r.enter({ roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: b32(7),
    stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
    stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) });
  return { store, rid, eid, honestSk, honestPk };
}
const advertsOf = (pk, BOND) => () => new Map([[toHex(pk), { nodePubkey: pk, bondTxid: BOND.txid, bondVout: BOND.vout }]]);

// 2.0 (kanban #1489 port): PUT /slash takes the 5A.3B fraud proof (encodeFraudProof) under H(fraud_proof)
const fpOf = (evidence) => { const b = encodeFraudProof({ evidence }); return { id: toHex(fraudProofHash(b)), bytes: b }; };

test('one committee seat cannot fill the relay with re-run proofs against itself (fresh signedAtMs each)', async () => {
  const { store, rid, eid, honestSk: seatSk, honestPk: seatPk } = heldRound();
  const BOND = { txid: b32(0x77), vout: 3 };
  const res0 = { roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 1, transcriptHash: b32(2), simCoreHash: TRUCK_CORE_HASH, nodePubkey: seatPk };
  const seat = await serve(store, { port: 0, plugins: HOSTED, advertsFor: advertsOf(seatPk, BOND) });
  try {
    const counts = {};
    for (let i = 0; i < 400; i++) {
      const x = { contradictedRunId: b32(8), signedAtMs: 1_700_000_000_000 + i, result: res0 };
      const sr = joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), seatSk));
      const p = { roundId: rid, playerPubkey: b32(5), nodePubkey: seatPk, transcriptHash: res0.transcriptHash, signedResultId: rerunResultId(x), bondTxid: BOND.txid, bondVout: BOND.vout };
      const j = fpOf(joinRerunSlashEvidence(encodeSlashProof(p), sr)); const res = await fetch(`http://127.0.0.1:${seat.port}/slash/${j.id}`, { method: 'PUT', body: j.bytes });
      await res.text(); counts[res.status] = (counts[res.status] || 0) + 1;
    }
    const t = encodeTranscript({ roundId: rid, entryId: eid, batches: [], marks: [] });
    const tr = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(t))}`, { method: 'PUT', body: t });
    const twhy = await tr.text();
    console.log(`one seat's 400 self-signed re-runs (same result, fresh signedAtMs): ${JSON.stringify(counts)}; then a held entry's transcript: ${tr.status} ${twhy}`);
    assert.ok((counts[201] || 0) <= 1, `the relay kept ${counts[201]} proofs about ONE (round, node, player) - each a re-signing of the same re-run`);
    assert.equal(tr.status, 201, `a held entry's transcript was refused after one seat's self-made re-run proofs: ${twhy}`);
  } finally { await seat.close(); }
});

test('one committee seat cannot fill the relay with result proofs against itself (made-up transcript hash each)', async () => {
  const { store, rid, eid, honestSk: seatSk, honestPk: seatPk } = heldRound();
  const BOND = { txid: b32(0x77), vout: 3 };
  const seat = await serve(store, { port: 0, plugins: HOSTED, advertsFor: advertsOf(seatPk, BOND) });
  try {
    const counts = {};
    for (let i = 0; i < 400; i++) {
      const r0 = { roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 1, transcriptHash: new Uint8Array(randomBytes(32)), simCoreHash: TRUCK_CORE_HASH, nodePubkey: seatPk };
      const signed = joinSignedResult(encodePlayerResult(r0), schnorr.sign(resultId(r0), seatSk));
      const p = { roundId: rid, playerPubkey: b32(5), nodePubkey: seatPk, transcriptHash: r0.transcriptHash, signedResultId: resultId(r0), bondTxid: BOND.txid, bondVout: BOND.vout };
      const j = fpOf(joinSlashEvidence(encodeSlashProof(p), signed)); const res = await fetch(`http://127.0.0.1:${seat.port}/slash/${j.id}`, { method: 'PUT', body: j.bytes });
      await res.text(); counts[res.status] = (counts[res.status] || 0) + 1;
    }
    const t = encodeTranscript({ roundId: rid, entryId: eid, batches: [], marks: [] });
    const tr = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(t))}`, { method: 'PUT', body: t });
    const twhy = await tr.text();
    console.log(`one seat's 400 self-signed results about made-up transcripts: ${JSON.stringify(counts)}; then a held entry's transcript: ${tr.status} ${twhy}`);
    assert.ok((counts[201] || 0) <= 1, `the relay kept ${counts[201]} proofs about ONE (round, node, player), none about the canonical transcript`);
    assert.equal(tr.status, 201, `a held entry's transcript was refused after one seat's self-made result proofs: ${twhy}`);
  } finally { await seat.close(); }
});
