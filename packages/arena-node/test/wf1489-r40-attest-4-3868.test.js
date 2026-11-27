// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { assumeAssigned } from './assignment.js';
import { encodeInputBatch, batchId } from '../../arena-protocol/src/batch.js';
import * as SIGNED from '../../arena-protocol/src/batch.js';
import { GENESIS, decodeTranscript } from '../../arena-protocol/src/transcript.js';
import { encodeCheckpoint, checkpointId, NO_PREVIOUS, joinSigned } from '../../arena-protocol/src/checkpoint.js';
import { encodeCheckpointReceipt, receiptId, joinSignedReceipt } from '../../arena-protocol/src/receipt.js';
import { priceSampleId, centsToTapeUnits } from '../../arena-protocol/src/price-sample.js';
import { receiptsNeeded } from '../../arena-protocol/src/genesis.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const session = ed25519.utils.randomSecretKey();
const peers = [1, 2, 3, 4, 5, 6].map((n) => b32(0x40 + n));
const peerKeys = peers.map((sk) => schnorr.getPublicKey(sk));

function rig() {
  const r = new Round(openStore(), () => 1234, { plugins: HOSTED });
  const nodes = [...peerKeys, r.identity.pubkey];
  const c = {
    networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID,
    simCoreHash: TRUCK_CORE_HASH, startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20,
    slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'],
    donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n,
    randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: BLOCK_TICKS, exposureReference: 1000,
    corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes,
  };
  const rid = r.open(c);
  assumeAssigned(r, rid, nodes);
  // THIS SEAT RUNS THE COMMITTEE'S FEED: a bare price is refused, only an attested one is taken (§11)
  r.pricesRequired = () => true;
  const eid = r.enter({ roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: b32(7),
    stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
    stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) });
  return { r, rid, eid, need: receiptsNeeded(7) };
}
const words = (n) => Array.from({ length: n }, () => [65536, 0, 0, 0, 0]);
const markOf = (c) => joinSigned(encodeCheckpoint(c), ed25519.sign(checkpointId(c), session));
const receiptFrom = (sk, id, ms) => {
  const x = { checkpointId: id, nodePubkey: schnorr.getPublicKey(sk), receivedAtMs: ms };
  return joinSignedReceipt(encodeCheckpointReceipt(x), schnorr.sign(receiptId(x), sk));
};


// wf1489 r40-attest-4 (gap in #3302): A REFUSED BATCH'S ATTESTATIONS ARE RE-VERIFIED ON EVERY RE-SEND. #3302 skips the price check only
// for a batch the seat already HOLDS (`seen`). A player's own signed frame whose attestations all stand but whose LAST one is junk is
// refused by checkBatchPrices after every BIP-340 check of the others - and, never held, it is checked in full again on each copy. One
// signed 64 kB frame (about 90 attested samples of the round's committee - public in any held batch - plus one junk), sent again and
// again on /play, holds the seat's one thread ~600 signature checks a copy.
// Safe: re-sending a frame the seat already refused costs about what a junk frame costs.
test('wf1489 r40-attest-4: a re-sent refused batch is not price-checked again', () => {
  const { r, rid, eid } = rig();
  const { joinSignedBatch } = SIGNED;
  const samples = []; const attests = [];
  const N = 88;
  for (let i = 0; i < N; i++) {
    const t = i * 30, cents = 8297193 + i;
    const id = priceSampleId({ roundId: rid, tick: t, priceCents: cents });
    const sigs = peers.map((sk, j) => [peerKeys[j], schnorr.sign(id, sk)]);
    sigs.push([r.identity.pubkey, schnorr.sign(id, r.identity.secret)]);
    samples.push([t, centsToTapeUnits(cents)]); attests.push([t, 0, cents, sigs]);
  }
  // the last attestation (highest tick, checked last) is junk
  const tj = N * 30, cj = 8297193;
  samples.push([tj, centsToTapeUnits(cj)]);
  attests.push([tj, 0, cj, [...peerKeys, r.identity.pubkey].map((k) => [k, new Uint8Array(64).fill(3)])]);
  const b = { roundId: rid, entryId: eid, previousHash: GENESIS, firstTick: 0, ticks: words(1), liquidations: [], samples, attests };
  const bytes = encodeInputBatch(b);
  const frame = joinSignedBatch(bytes, ed25519.sign(batchId(b), session));
  let why = null; try { r.signedBatch(frame); } catch (e) { why = e.message; }
  assert.match(String(why), /not attested/, 'setup: the frame is refused at its last attestation');
  const junk = joinSignedBatch(bytes, new Uint8Array(64).fill(1));
  const time = (f, n) => { const t0 = performance.now(); for (let k = 0; k < n; k++) { try { r.signedBatch(f); } catch { /* refused */ } } return (performance.now() - t0) / n; };
  time(frame, 3); time(junk, 3);
  const resendMs = time(frame, 20), junkMs = time(junk, 20);
  console.log('  FACTS:', JSON.stringify({ why, bytes: frame.length, attests: attests.length, sigsEach: 7, resendMs: resendMs.toFixed(2), junkMs: junkMs.toFixed(2), ratio: (resendMs / junkMs).toFixed(1) }));
  assert.ok(resendMs < 3 * junkMs + 2, `each re-send of the refused batch held the thread ${resendMs.toFixed(1)} ms, a junk frame of the same size ${junkMs.toFixed(1)} ms`);
});
