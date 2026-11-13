// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #1489 a45 refute s3 of #1816/#2248/#2344: ONE SLOT PER PLAYER, BUT A PLAYER HAS MORE THAN ONE ENTRY.
// ffedbfcd6 keys the relay's one-proof slot on (round, accused node, player, door). A player enters a round more than once (one entry
// per SESSION key, #1479; a new session key for every entry), and verify.js files one proof per accused node per ENTRY. The accused
// node publishes a result for each of the player's two entries (both held here, both rank 1). Its proof about entry 1 - its own squat,
// or the honest proof about entry 1 - takes the slot, and the honest proof about entry 2 ranks no better, so it is refused 409 and
// never kept: the relay serves no proof against the second contradicted result. verify.js publishes once and never retries.
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
// the 1.9.17 merge brought the slash share's per-node caps (kanban #1917, #2055: RELAY_SLASH_RESERVE / 16 per accused and round, / 32 per
// accused) - at this test's small pool under one proof's bytes; the slots under test are what bound a node here
process.env.ARENA_RELAY_SLASH_ACCUSED_MOST = String(8 * 1024);
process.env.ARENA_RELAY_SLASH_NODE_MOST = String(8 * 1024);
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
  const enter = () => r.enter({ roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()), stakeCommitment: b32(7),
    stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
    stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) });
  const e1 = enter(), e2 = enter();
  return { store, rid, e1, e2, honestSk, honestPk };
}

// 2.0 (kanban #1489 port): PUT /slash takes the 5A.3B fraud proof (encodeFraudProof) under H(fraud_proof)
const fpOf = (evidence) => { const b = encodeFraudProof({ evidence }); return { id: toHex(fraudProofHash(b)), bytes: b }; };

for (const door of ['result', 'rerun']) test(`${door} door: the proof about the player's SECOND entry is kept beside the one about the first`, async () => {
  const { store, rid, e1, e2, honestSk: seatSk, honestPk: seatPk } = heldRound();
  assert.notEqual(toHex(e1), toHex(e2), 'the player holds two entries in the round');
  const BOND = { txid: b32(0x77), vout: 3 };
  const advertsFor = () => new Map([[toHex(seatPk), { nodePubkey: seatPk, bondTxid: BOND.txid, bondVout: BOND.vout }]]);
  const seat = await serve(store, { port: 0, plugins: HOSTED, advertsFor });
  const r = new Round(store, () => Date.now(), { plugins: HOSTED });
  const make = (eid, th) => {
    const res0 = { roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 1, transcriptHash: th, simCoreHash: TRUCK_CORE_HASH, nodePubkey: seatPk };
    if (door === 'result') {
      const ev = joinSignedResult(encodePlayerResult(res0), schnorr.sign(resultId(res0), seatSk));
      r.putResult(rid, eid, seatPk, resultId(res0), ev);
      return { ev, sid: resultId(res0), th };
    }
    const x = { contradictedRunId: b32(8), signedAtMs: Date.now(), result: res0 };
    const ev = joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), seatSk));
    r.putRerun(rid, eid, seatPk, ev);
    return { ev, sid: rerunResultId(x), th };
  };
  const wrap = ({ ev, sid, th }) => {
    const p = { roundId: rid, playerPubkey: b32(5), nodePubkey: seatPk, transcriptHash: th, signedResultId: sid, bondTxid: BOND.txid, bondVout: BOND.vout };
    return fpOf((door === 'result' ? joinSlashEvidence : joinRerunSlashEvidence)(encodeSlashProof(p), ev));
  };
  const put = async (j) => { const res = await fetch(`http://127.0.0.1:${seat.port}/slash/${j.id}`, { method: 'PUT', body: j.bytes }); return [res.status, await res.text()]; };
  try {
    const first = wrap(make(e1, b32(0x21)));     // the accused node's published evidence about entry 1
    const second = wrap(make(e2, b32(0x22)));    // and about entry 2: a different signed result, a different transcript
    const a = await put(first);
    const b = await put(second);
    const g1 = await fetch(`http://127.0.0.1:${seat.port}/slash/${first.id}`); await g1.arrayBuffer();
    const g2 = await fetch(`http://127.0.0.1:${seat.port}/slash/${second.id}`); await g2.arrayBuffer();
    console.log(`${door} door: proof about entry 1 ${a.join(' ')}; proof about entry 2 ${b.join(' ')}; GET 1 ${g1.status}, GET 2 ${g2.status}`);
    assert.equal(a[0], 201);
    assert.equal(b[0], 201, `the proof about the player's second entry was refused: ${b.join(' ')}`);
    assert.equal(g2.status, 200, 'the relay serves no proof about the second entry');
  } finally { await seat.close(); }
});
