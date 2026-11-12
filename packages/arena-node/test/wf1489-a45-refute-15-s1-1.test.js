// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute #1816 (1): ONE PUBLISHED SIGNED RESULT OF A COMMITTEE SEAT MINTS 2^32+ DISTINCT 'SLASH PROOFS'.
// slashOursWhy checks round, committee, evidence fields and signature - but bondTxid, bondVout and transcriptHash of the proof
// are free. A stranger holding one honest seat's signed result (public: players and relays get it) varies bondVout and each
// proof has its own id, so all are kept until RELAY_MOST is full and honest transcripts / proofs are refused 507.
// (was) kanban #1489 round 6 (gossip): THE #1532 RELAY CAP IS SHARED WITH PUT /slash, WHICH STILL TAKES A STRANGER'S MADE-UP PROOFS - BYPASS OF #1532.
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
import { encodeSlashProof, joinSlashEvidence, encodeFraudProof, fraudProofHash } from '../../arena-protocol/src/slash.js';
import { encodePlayerResult, resultId, joinSignedResult } from '../../arena-protocol/src/result.js';
import { transcriptBytesHash } from '../../arena-protocol/src/posting.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { assumeAssigned } from './assignment.js';
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


test('one honest signed result cannot be re-wrapped into many slash proofs that fill the relay store', async () => {
  const store = openStore(':memory:');
  const r = new Round(store, () => Date.now(), { plugins: HOSTED });
  const rid = r.open(contract());
  const honestSk = b32(0x62);
  const honestPk = schnorr.getPublicKey(honestSk);
  assumeAssigned(r, rid, [honestPk, schnorr.getPublicKey(b32(0x63)), schnorr.getPublicKey(b32(0x64))]);
  const session = ed25519.utils.randomSecretKey();
  r.enter({ roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: b32(7),
    stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
    stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) });
  // the honest seat's one real signed result, as it is published to the player and the relays
  const res0 = { roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 1, transcriptHash: b32(2), simCoreHash: TRUCK_CORE_HASH, nodePubkey: honestPk };
  const signed = joinSignedResult(encodePlayerResult(res0), schnorr.sign(resultId(res0), honestSk));
  const wrap = (vout, th = res0.transcriptHash) => {
    const p = { roundId: rid, playerPubkey: res0.playerPubkey, nodePubkey: honestPk, transcriptHash: th, signedResultId: resultId(res0), bondTxid: b32(5), bondVout: vout };
    return fpOf(joinSlashEvidence(encodeSlashProof(p), signed));
  };
  const seat = await serve(store, { port: 0, plugins: HOSTED });
  try {
    let kept = 0, full = 0, other = '';
    for (let i = 0; i < 400; i++) {
      const j = i % 2 ? wrap(i) : wrap(0, new Uint8Array(randomBytes(32)));
      const res = await fetch(`http://127.0.0.1:${seat.port}/slash/${j.id}`, { method: 'PUT', body: j.bytes });
      const t = await res.text();
      if (res.status === 201) kept++; else if (res.status === 507) full++; else other = `${res.status} ${t}`;
    }
    console.log(`one honest signed result re-wrapped 400 times (bondVout / transcriptHash varied): ${kept} kept, ${full} refused as full ${other}`);
    assert.ok(kept <= 1, `the seat kept ${kept} distinct slash proofs built from ONE signed result of an honest committee seat (and ${full} PUTs met a full relay store)`);
  } finally { await seat.close(); }
});
