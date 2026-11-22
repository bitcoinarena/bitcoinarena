// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2879 feedback #109 (1): two entries of one round key in one paid round - the key's settlement share is booked once per entry.
// GET /season (feature 1): one game's board across its rounds, from what this node holds - a result counts once
// FINAL here (the committee's threshold of verified results AND of FINAL signatures), an amount once the round's settlement
// is ACCEPTED (the lock it did not claim back, plus the share it paid), a player under its identity, not its round key.
// A real node on an in-memory store; its rows written as the doors and the settlement write them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { seasonRounds } from '../src/season-read.js';
import { runId } from '../src/verdict.js';
import { contractFor, b32, opts } from './window-fixture.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { encodeLobbyName } from '../../arena-protocol/src/lobby-name.js';
import { displayNameFromKey } from '../../arena-protocol/src/display-name.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { seasonRoundsToJson, seasonRoundsFromJson, seasonContractOf, seasonAccountOf } from '../../arena-protocol/src/season.js';
import { HOSTED, NEXTBLOCK_GAME_ID } from './plugins/hosted.js';

const STAKE = 100000n, FEE = 2000n, DONATION = 2000n, NET = STAKE - FEE - DONATION;
const HOUR = 3600000;
const DAY_MS = 24 * HOUR;
// THE ROUND'S COMMITTEE: two seats whose keys this test holds (gameVerifySlots 2 - a threshold of 2)
const SECRETS = [b32(0x31), b32(0x32)];
const SEATS = SECRETS.map((s) => schnorr.getPublicKey(s));
const I1 = b32(0xe1);                 // one player's identity, named by its lobby records in two rounds

/** One round written as a seat holds it; each player `{ key, outcome, score, sigs, finals, lock, record }`. */
function writeRound(round, n, players, { stakeMsat = STAKE, startMs, gameId = NEXTBLOCK_GAME_ID, settlement = null } = {}) {
  const db = round.db;
  const contract = { ...contractFor(SEATS, 3000n, ['wss://r.example']), gameId, stakeMsat, startTimeMs: BigInt(startMs), censusHeight: 900000 + n };
  const rid = roundId(contract);
  db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(contract), 1);
  round.recordSignerNodes(rid, SEATS);
  players.forEach((p, i) => {
    const e = { roundId: rid, playerPubkey: p.key, sessionPubkey: b32(0x60 + i), stakeCommitment: b32(0x70 + i), stakeMsat,
      feeMsat: stakeMsat ? FEE : 0n, donationMsat: stakeMsat ? DONATION : 0n, joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(0x80 + i),
      stakePoint: Uint8Array.from([2, ...b32(0x90 + i)]), feePreimage: b32(0), stakeLockOutpoint: { txid: b32(0xa0 + i), outIdx: 0n },
      feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) };
    const eid = entryId(e);
    db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(eid, rid, encodeEntryContract(e), 1 + i);
    // THE SEATS' SIGNED RESULTS: `sigs` of them, each verified by the door
    let run = null;
    for (let s = 0; s < (p.sigs ?? 2); s++) {
      const r = { roundId: rid, playerPubkey: p.key, outcome: p.outcome, score: p.score, transcriptHash: b32(0xb0 + i),
        simCoreHash: contract.simCoreHash, nodePubkey: SEATS[s] };
      run = runId(r);
      db.prepare('INSERT INTO results (round_id, entry_id, node_pubkey, result_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rid, eid, SEATS[s], resultId(r), joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), SECRETS[s])), 2);
    }
    // AND THEIR FINAL SIGNATURES, as final_sigs keeps the ones that counted on arrival
    for (let s = 0; s < (p.finals ?? 2) && run; s++)
      db.prepare('INSERT INTO final_sigs (round_id, entry_id, run_id, signer_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rid, eid, run, SEATS[s], new Uint8Array(1), 3);
    if (p.lock) round.putStakeLock({ entryId: eid, roundId: rid, outpoint: { txid: b32(0xa0 + i), outIdx: 0 }, fields: { amountMsat: String(NET) }, contractId: 'c' });
    if (p.record) round.putLobbyName({ roundId: rid, playerPubkey: p.key, signature: new Uint8Array(64), identitySig: new Uint8Array(64), atMs: 5,
      record: encodeLobbyName({ roundId: rid, playerPubkey: p.key, identityPubkey: p.record.identity, name: p.record.name || '', atMs: 5 }) });
  });
  if (settlement) {
    round.putLockSettlement({ roundId: rid, txid: 'ab'.repeat(32), message: b32(1), signature: new Uint8Array(64), state: settlement.state, why: '' });
    round.putLockSettlementMoves({ roundId: rid, txid: 'ab'.repeat(32), claims: settlement.claims || [], payouts: 1 });
    round.putLockSettlementShares(rid, settlement.shares || []);
  }
  return toHex(rid);
}


test('#109 one round key with two winning entries in one paid round: the settlement share is booked once, not once per entry', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts }); const round = d.round;
  try {
  const K = b32(0x5b), now = Date.now();
  writeRound(round, 1, [
    { key: K, outcome: 'DELIVERED', score: 500, lock: true },
    { key: K, outcome: 'DELIVERED', score: 400, lock: true },
    { key: b32(0x5c), outcome: 'FAILED', score: 100, lock: true },
  ], { startMs: now - HOUR, settlement: { state: 'ACCEPTED', claims: [`${toHex(b32(0xa2))}:0`], shares: [{ pubkey: K, msat: 90000n }] } });
  const rows = seasonRounds(round, { games: new Set([toHex(NEXTBLOCK_GAME_ID)]), fromMs: now - 2 * HOUR, toMs: now + HOUR });
  const mine = rows[0].entries.filter((e) => e.player === toHex(K));
  const booked = mine.reduce((t, e) => t + BigInt(e.payoutMsat || 0n), 0n);
  console.log('  FACTS #109:', JSON.stringify({ entries: mine.length, booked: String(booked), paidForReal: String(2n * NET + 90000n) }));
  assert.equal(booked, 2n * NET + 90000n, 'the key was paid its two locks back and one share of 90000');
  } finally { await d.close(); }
});
