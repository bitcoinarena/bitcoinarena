// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a45 refute #1816 / #2248, skeptic 2 (2): A STRANGER SQUATS THE ONE SLOT WHILE THE CENSUS IS NOT READ YET.
// #2248 keeps one relayed proof per accused signed result, first come, forever; the bond is checked only when advertsFor
// answers a Map. Right after a seat restarts its census view is not read yet (VIEW_NOT_YET, kanban #745) and advertsFor
// is null, so a stranger holding a committee seat's published signed result PUTs a proof naming a made-up bond: kept 201.
// Once the census is read, the honest filer's real proof (the advertised bond, slashHolds would hold) is refused 409 and
// GET /slash/<honest id> is 404 on this relay for good - the one proof that slashes is never relayed here.
// Safe behaviour: a proof the seat could not check the bond of does not lock out the proof with the advertised bond.
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
for (const door of ['result', 'rerun']) test(`a ${door} proof kept before the census was read does not lock out the honest proof`, async () => {
  const { store, rid, honestSk, honestPk } = heldRound();
  const BOND = { txid: b32(0x77), vout: 3 };
  const res0 = { roundId: rid, playerPubkey: b32(5), outcome: 'DELIVERED', score: 1, transcriptHash: b32(2), simCoreHash: TRUCK_CORE_HASH, nodePubkey: honestPk };
  const x = { contradictedRunId: b32(8), signedAtMs: Date.now(), result: res0 };
  const evidence = door === 'result'
    ? joinSignedResult(encodePlayerResult(res0), schnorr.sign(resultId(res0), honestSk))
    : joinSignedRerun(encodeRerunResult(x), schnorr.sign(rerunResultId(x), honestSk));
  const sid = door === 'result' ? resultId(res0) : rerunResultId(x);
  const wrap = (txid, vout) => {
    const p = { roundId: rid, playerPubkey: b32(5), nodePubkey: honestPk, transcriptHash: res0.transcriptHash, signedResultId: sid, bondTxid: txid, bondVout: vout };
    return { id: toHex(slashProofId(p)), bytes: (door === 'result' ? joinSlashEvidence : joinRerunSlashEvidence)(encodeSlashProof(p), evidence) };
  };
  let censusRead = false;   // the seat just restarted: its census view is not read yet
  const advertsFor = () => (censusRead ? new Map([[toHex(honestPk), { nodePubkey: honestPk, bondTxid: BOND.txid, bondVout: BOND.vout }]]) : null);
  const seat = await serve(store, { port: 0, plugins: HOSTED, advertsFor });
  const put = async (j) => { const res = await fetch(`http://127.0.0.1:${seat.port}/slash/${j.id}`, { method: 'PUT', body: j.bytes }); return [res.status, await res.text()]; };
  try {
    const squat = await put(wrap(new Uint8Array(32), 0xffffffff));
    censusRead = true;
    const honest = wrap(BOND.txid, BOND.vout);
    const h = await put(honest);
    const got = await fetch(`http://127.0.0.1:${seat.port}/slash/${honest.id}`); await got.arrayBuffer();
    console.log(`${door} door: the stranger's wrong-bond proof before the census was read: ${squat.join(' ')}; the honest proof after: ${h.join(' ')}; GET honest id: ${got.status}`);
    assert.ok(h[0] === 201 || h[0] === 200, `the honest proof (advertised bond) was refused: ${h.join(' ')} - a stranger's wrong-bond proof kept while the census was unread holds the slot`);
    assert.equal(got.status, 200, 'this relay does not serve the honest slash proof');
  } finally { await seat.close(); }
});
