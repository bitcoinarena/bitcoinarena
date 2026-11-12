// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2248 (a45 refute of #1816, 3): THE SAME RULE AT THE RE-RUN DOOR, AND THE BOND MUST BE THE ACCUSED NODE'S ADVERTISED ONE.
// One honest re-run signer's signed re-run cannot be re-wrapped into many proofs either. With the census's adverts read, a proof
// naming another bond (or another transcript) is refused, the honest proof is kept once, sent again it is 200, and a held entry's
// transcript still goes in. A proof about a player who is no entry of the round is refused.
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

test('the re-run door keeps one proof per signed re-run, and only with the advertised bond', async () => {
  const { store, rid, eid, honestSk, honestPk } = heldRound();
  const res0 = { roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 1, transcriptHash: b32(2), simCoreHash: TRUCK_CORE_HASH, nodePubkey: honestPk };
  const x = { contradictedRunId: b32(8), signedAtMs: Date.now(), result: res0 };
  const signedRerun = joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), honestSk));
  const BOND = { txid: b32(0x77), vout: 3 };
  const wrap = (txid, vout, th = res0.transcriptHash) => {
    const p = { roundId: rid, playerPubkey: res0.playerPubkey, nodePubkey: honestPk, transcriptHash: th, signedResultId: rerunResultId(x), bondTxid: txid, bondVout: vout };
    return { id: toHex(slashProofId(p)), bytes: joinRerunSlashEvidence(encodeSlashProof(p), signedRerun) };
  };
  const advertsFor = () => new Map([[toHex(honestPk), { nodePubkey: honestPk, bondTxid: BOND.txid, bondVout: BOND.vout }]]);
  const seat = await serve(store, { port: 0, plugins: HOSTED, advertsFor });
  const put = async (j) => { const res = await fetch(`http://127.0.0.1:${seat.port}/slash/${j.id}`, { method: 'PUT', body: j.bytes }); return [res.status, await res.text()]; };
  try {
    const counts = {};
    for (let i = 0; i < 150; i++) {
      const j = i % 3 === 0 ? wrap(BOND.txid, i + 10) : i % 3 === 1 ? wrap(new Uint8Array(randomBytes(32)), BOND.vout) : wrap(BOND.txid, BOND.vout, new Uint8Array(randomBytes(32)));
      const [s] = await put(j); counts[s] = (counts[s] || 0) + 1;
    }
    console.log(`a signed re-run re-wrapped 150 times with a wrong bond or transcript: ${JSON.stringify(counts)}`);
    assert.deepEqual(Object.keys(counts), ['422'], 'a re-wrapped proof with a bond the node did not advertise, or another transcript, was not refused');
    const honest = wrap(BOND.txid, BOND.vout);
    const first = await put(honest), again = await put(honest);
    console.log(`the honest re-run proof: ${first.join(' ')}; again: ${again.join(' ')}`);
    assert.equal(first[0], 201, 'the honest re-run proof was not kept');
    assert.equal(again[0], 200, 'the honest re-run proof sent again was not answered as already kept');
    const got = await fetch(`http://127.0.0.1:${seat.port}/slash/${honest.id}`);
    assert.equal(got.status, 200);
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), honest.bytes);
    const t = encodeTranscript({ roundId: rid, entryId: eid, batches: [], marks: [] });
    const tr = await fetch(`http://127.0.0.1:${seat.port}/transcript/${toHex(transcriptBytesHash(t))}`, { method: 'PUT', body: t });
    const twhy = await tr.text();
    console.log(`then a held entry's transcript: ${tr.status} ${twhy}`);
    assert.equal(tr.status, 201, `a held entry's transcript was refused: ${twhy}`);
  } finally { await seat.close(); }
});

test('a proof about a player who is no entry of the round is not kept', async () => {
  const { store, rid, honestSk, honestPk } = heldRound();
  const res0 = { roundId: rid, playerPubkey: b32(9), outcome: 'DELIVERED', score: 1, transcriptHash: b32(2), simCoreHash: TRUCK_CORE_HASH, nodePubkey: honestPk };
  const signed = joinSignedResult(encodePlayerResult(res0), schnorr.sign(resultId(res0), honestSk));
  const p = { roundId: rid, playerPubkey: res0.playerPubkey, nodePubkey: honestPk, transcriptHash: res0.transcriptHash, signedResultId: resultId(res0), bondTxid: b32(5), bondVout: 0 };
  const seat = await serve(store, { port: 0, plugins: HOSTED });
  try {
    const res = await fetch(`http://127.0.0.1:${seat.port}/slash/${toHex(slashProofId(p))}`, { method: 'PUT', body: joinSlashEvidence(encodeSlashProof(p), signed) });
    const why = await res.text();
    console.log(`a proof about a player with no entry: ${res.status} ${why}`);
    assert.equal(res.status, 422);
  } finally { await seat.close(); }
});
