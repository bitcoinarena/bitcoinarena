// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2344 (#1489 a45 refute s2 of #2248): THE ACCUSED SEAT SQUATS ITS OWN SLOT FIRST.
// A relay keeps one proof per (round, accused node, player, door). The accused node can sign another result (or re-sign its re-run)
// and PUT a proof about it before anyone files the honest one. That squat must not lock out the proof about the evidence this seat
// holds (the result the node published).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { BLOCK_TICKS } from '../../nextblock/src/rules/gate.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId as idOfDonationSet } from '../../arena-protocol/src/donation.js';
import { encodeSlashProof, slashProofId, joinSlashEvidence, joinRerunSlashEvidence } from '../../arena-protocol/src/slash.js';
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

for (const door of ['result', 'rerun']) test(`a ${door} proof about the published evidence takes the slot from the accused node's own squat`, async () => {
  const { store, rid, eid, honestSk: seatSk, honestPk: seatPk } = heldRound();
  const BOND = { txid: b32(0x77), vout: 3 };
  const advertsFor = () => new Map([[toHex(seatPk), { nodePubkey: seatPk, bondTxid: BOND.txid, bondVout: BOND.vout }]]);
  const seat = await serve(store, { port: 0, plugins: HOSTED, advertsFor });
  const r = new Round(store, () => Date.now(), { plugins: HOSTED });
  const res0 = { roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 1, transcriptHash: b32(2), simCoreHash: TRUCK_CORE_HASH, nodePubkey: seatPk };
  const make = (i) => {
    if (door === 'result') {
      const body = { ...res0, score: 1 + i };
      return { ev: joinSignedResult(encodePlayerResult(body), schnorr.sign(resultId(body), seatSk)), sid: resultId(body) };
    }
    const x = { contradictedRunId: b32(8), signedAtMs: 1_700_000_000_000 + i, result: res0 };
    return { ev: joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), seatSk)), sid: rerunResultId(x) };
  };
  const wrap = ({ ev, sid }) => {
    const p = { roundId: rid, playerPubkey: b32(5), nodePubkey: seatPk, transcriptHash: res0.transcriptHash, signedResultId: sid, bondTxid: BOND.txid, bondVout: BOND.vout };
    return { id: toHex(slashProofId(p)), bytes: (door === 'result' ? joinSlashEvidence : joinRerunSlashEvidence)(encodeSlashProof(p), ev) };
  };
  const put = async (j) => { const res = await fetch(`http://127.0.0.1:${seat.port}/slash/${j.id}`, { method: 'PUT', body: j.bytes }); return [res.status, await res.text()]; };
  try {
    const squat = await put(wrap(make(1)));
    const published = make(2);
    if (door === 'result') r.putResult(rid, eid, seatPk, published.sid, published.ev); else r.putRerun(rid, eid, seatPk, published.ev);
    const honest = wrap(published);
    const h = await put(honest);
    const again = await put(wrap(make(3)));
    const got = await fetch(`http://127.0.0.1:${seat.port}/slash/${honest.id}`); await got.arrayBuffer();
    console.log(`${door} door: the accused's own squat ${squat.join(' ')}; the proof about its published evidence ${h.join(' ')}; another squat after ${again.join(' ')}; GET honest ${got.status}`);
    assert.equal(squat[0], 201);
    assert.equal(h[0], 201, `the proof about the published evidence was refused: ${h.join(' ')}`);
    assert.equal(again[0], 409, 'a proof holding no better than the kept one took the slot');
    assert.equal(got.status, 200);
  } finally { await seat.close(); }
});
