// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2248: the #1816 fix's own test (wf1489-r6-gossip-4, overwritten by #1817's in the merge), restored with an honest write #1824 accepts.
// kanban #1489 round 6 (gossip): THE #1532 RELAY CAP IS SHARED WITH PUT /slash, WHICH STILL TAKES A STRANGER'S MADE-UP PROOFS - BYPASS OF #1532.
// #1532 bounded the relay store (RELAY_MOST over PUT /transcript and PUT /slash together) and made PUT /transcript keep only the
// transcript of an entry the seat holds. PUT /slash/<id> checks only that the proof hashes to the id and that the bytes beside it decode
// as a player result whose id the proof names - no signature, no round the seat holds, no committee key, no bond. A stranger PUTs
// self-made "slash proofs" (about 400 bytes each, a fresh random field each time) until the shared cap is reached; from then on every
// honest transcript of a run the seat holds is refused 507, so the seat stops being a publication relay for real runs.
// Safe behaviour: a stranger's proofs about rounds the seat does not hold are not kept, so they cannot use up the room real transcripts need.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { encodeSlashProof, slashProofId, joinSlashEvidence, encodeFraudProof, fraudProofHash } from '../../arena-protocol/src/slash.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../arena-protocol/src/result.js';
import { transcriptBytesHash } from '../../arena-protocol/src/posting.js';
import { encodeTranscript } from '../../arena-protocol/src/transcript.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { HOSTED } from './plugins/hosted.js';

// 2.0 (kanban #1489 port): PUT /slash takes the 5A.3B fraud proof (encodeFraudProof) under H(fraud_proof)
const fpOf = (evidence) => { const b = encodeFraudProof({ evidence }); return { id: toHex(fraudProofHash(b)), bytes: b }; };
const RELAY_MOST = 64 * 1024;   // the cap, small for the test (ARENA_RELAY_MOST); the live default is 256 MiB: the same ~650k PUTs fill it
process.env.ARENA_RELAY_MOST = String(RELAY_MOST);
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

function junkProof() {
  const r = { roundId: new Uint8Array(randomBytes(32)), playerPubkey: b32(1), outcome: 'DELIVERED', score: 1, transcriptHash: b32(2), simCoreHash: b32(3), nodePubkey: b32(4) };
  const signed = joinSignedResult(encodePlayerResult(r), new Uint8Array(64));
  const p = { roundId: r.roundId, playerPubkey: r.playerPubkey, nodePubkey: r.nodePubkey, transcriptHash: r.transcriptHash, signedResultId: resultId(r), bondTxid: b32(5), bondVout: 0 };
  return fpOf(joinSlashEvidence(encodeSlashProof(p), signed));
}

test('a stranger\'s made-up slash proofs cannot fill the relay store and shut out a held entry\'s transcript', async () => {
  const store = openStore(':memory:');
  const r = new Round(store, () => Date.now(), { plugins: HOSTED });
  const rid = r.open(contract());
  const session = ed25519.utils.randomSecretKey();
  const eid = r.enter({ roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: b32(7),
    stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
    stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) });
  const seat = await serve(store, { port: 0, plugins: HOSTED });
  try {
    let kept = 0, full = 0;
    for (let i = 0; i < 400; i++) {
      const j = junkProof();
      const res = await fetch(`http://127.0.0.1:${seat.port}/slash/${j.id}`, { method: 'PUT', body: j.bytes });
      await res.text();
      if (res.status === 201) kept++; else if (res.status === 507) full++;
    }
    // the honest relay write after it: the transcript of a held entry, which PUT /transcript keeps (kanban #2248: the #1816 test's
    // honest write was a made-up 65-byte reveal record, which #1824 rightly refuses since it opens no commitment)
    const record = encodeTranscript({ roundId: rid, entryId: eid, batches: [], marks: [] });
    const res = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(record))}`, { method: 'PUT', body: record });
    const why = await res.text();
    console.log(`stranger's made-up slash proofs: ${kept} kept, ${full} refused as full; then a held entry's record: ${res.status} ${why}`);
    assert.equal(kept, 0, `the seat kept ${kept} slash proofs about rounds it does not hold, from a stranger`);
    assert.equal(res.status, 201, 'the held entry\'s record was refused after the stranger filled the relay store');
  } finally { await seat.close(); }
});
