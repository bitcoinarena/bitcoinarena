// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 6 (gossip): POST /final-sig KEEPS A COMMITTEE SEAT'S FINAL FOR ANY MADE-UP ENTRY AND RUN. takeFinalSig checks the round,
// the committee key, the signature and the time - but not that the entry is one of the round's entries, nor that the run is the run this seat
// holds (runId: null). final_sigs is keyed (round, entry, run, signer), so ONE seat of the committee signs FINAL over as many invented
// (entry, run) pairs as it likes and every honest seat of the round writes each into its store; GET /served (and the item purchase, which reads
// finalSigsBetween) then reads and schnorr-verifies every one of them on every request.
// Safe behaviour: a FINAL about an entry the round does not hold is not kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { assumeAssigned } from './assignment.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { serve } from '../src/server.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const contract = () => ({
  networkId: b32(0x4e), configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 6, gameVerifySlots: 7, settlementSlots: 7, gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH,
  startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT',
  federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: idOfDonationSet(TEST_DONATION_SET_REGTEST.recipients),
  censusHeight: 900000, censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash', stakeMsat: 100000n, bondMinSats: 50000n,
  blockTicks: BLOCK_TICKS, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
  rankNumerator: 3, rankDenominator: 4, nodes: [b32(4)],
});

test('one committee seat cannot fill an honest seat\'s final_sigs with FINALs over entries the round never held', async () => {
  const store = openStore(':memory:');
  const r = new Round(store, () => Date.now(), { plugins: HOSTED });
  const rid = r.open(contract());
  const evil = b32(0x61);
  const honest = [b32(0x62), b32(0x63), b32(0x64)].map((s) => schnorr.getPublicKey(s));
  assumeAssigned(r, rid, [schnorr.getPublicKey(evil), ...honest]);
  // one real entry, so the round is a round with players
  const session = ed25519.utils.randomSecretKey();
  r.enter({ roundId: rid, playerPubkey: b32(5), sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: b32(7),
    stakeMsat: 100000n, feeMsat: entryFeeMsat(100000n), donationMsat: 0n, joinTick: 0, worldSecret: b32(0x5e), vssSharesRef: new Uint8Array(32),
    stakePoint: new Uint8Array(33), feePreimage: new Uint8Array(32), stakeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n },
    feeLockOutpoint: { txid: new Uint8Array(32), outIdx: 0n }, claimKeyAttestationRef: new Uint8Array(32) });
  const seat = await serve(store, { port: 0, plugins: HOSTED });
  try {
    const N = 400;
    let kept = 0;
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      const entry = new Uint8Array(randomBytes(32)), run = new Uint8Array(randomBytes(32));
      const bytes = signFinalSig({ roundId: rid, entryId: entry, runId: run, signerPubkey: schnorr.getPublicKey(evil), signedAtMs: BigInt(Date.now()) },
        (d) => schnorr.sign(d, evil));
      const res = await fetch(`http://127.0.0.1:${seat.port}/final-sig?round=${toHex(rid)}&entry=${toHex(entry)}`, { method: 'POST', body: bytes });
      await res.text();
      if (res.status === 201) kept++;
    }
    const rows = store.prepare('SELECT COUNT(*) AS n FROM final_sigs WHERE round_id = ?').get(rid).n;
    const s0 = Date.now();
    const served = await (await fetch(`http://127.0.0.1:${seat.port}/served?to=${Date.now() + 60000}`)).json();
    console.log(`made-up FINALs posted ${N} in ${Date.now() - t0} ms: kept ${kept}, final_sigs rows ${rows}; GET /served took ${Date.now() - s0} ms over them (nodes ${JSON.stringify(served.nodes)})`);
    assert.equal(kept, 0, `the seat kept ${kept} FINAL signatures over entries its round does not hold`);
  } finally { await seat.close(); }
});
