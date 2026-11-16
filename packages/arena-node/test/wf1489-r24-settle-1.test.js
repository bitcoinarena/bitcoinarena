// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// wf1489 r24 settle-1: a stranger's lockless entry (POST /entry stores it under the lockless cap and relays it to every seat) in a
// paid, ACCEPTED round makes every seat refuse to sign its season account - the round drops out of every leaderboard payout and board badge.
// Safe behaviour: an entry that never locked a stake is not part of the round's money; the seat still signs the account of the settled round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { seasonRounds, signedSeasonRoundsJson } from '../src/season-read.js';
import { runId } from '../src/verdict.js';
import { contractFor, b32 } from './window-fixture.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED, NEXTBLOCK_GAME_ID } from './plugins/hosted.js';

const STAKE = 100000n, FEE = 2000n, DONATION = 2000n, NET = STAKE - FEE - DONATION;
const SECRETS = [b32(0x31), b32(0x32)];
const SEATS = SECRETS.map((s) => schnorr.getPublicKey(s));

function writeRound(round, players, { startMs, settlement }) {
  const db = round.db;
  const contract = { ...contractFor(SEATS, 3000n, ['wss://r.example']), gameId: NEXTBLOCK_GAME_ID, stakeMsat: STAKE, startTimeMs: BigInt(startMs), censusHeight: 900001 };
  const rid = roundId(contract);
  db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(contract), 1);
  round.recordSignerNodes(rid, SEATS);
  players.forEach((p, i) => {
    const e = { roundId: rid, playerPubkey: p.key, sessionPubkey: b32(0x60 + i), stakeCommitment: b32(0x70 + i), stakeMsat: STAKE,
      feeMsat: FEE, donationMsat: DONATION, joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(0x80 + i),
      stakePoint: Uint8Array.from([2, ...b32(0x90 + i)]), feePreimage: b32(0x11), stakeLockOutpoint: { txid: b32(0xa0 + i), outIdx: 0n },
      feeLockOutpoint: { txid: b32(0x12), outIdx: 0n }, claimKeyAttestationRef: b32(0) };
    const eid = entryId(e);
    db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(eid, rid, encodeEntryContract(e), 1 + i);
    if (!p.played) return;                          // the stranger's entry: never locked, never played
    let run = null;
    for (let s = 0; s < 2; s++) {
      const r = { roundId: rid, playerPubkey: p.key, outcome: p.outcome, score: p.score, transcriptHash: b32(0xb0 + i), simCoreHash: contract.simCoreHash, nodePubkey: SEATS[s] };
      run = runId(r);
      db.prepare('INSERT INTO results (round_id, entry_id, node_pubkey, result_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rid, eid, SEATS[s], resultId(r), joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), SECRETS[s])), 2);
    }
    for (let s = 0; s < 2; s++)
      db.prepare('INSERT INTO final_sigs (round_id, entry_id, run_id, signer_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)').run(rid, eid, run, SEATS[s], new Uint8Array(1), 3);
    round.putStakeLock({ entryId: eid, roundId: rid, outpoint: { txid: b32(0xa0 + i), outIdx: 0 }, fields: { amountMsat: String(NET) }, contractId: 'c' });
  });
  round.putLockSettlement({ roundId: rid, txid: 'ab'.repeat(32), message: b32(1), signature: new Uint8Array(64), state: settlement.state, why: '' });
  round.putLockSettlementMoves({ roundId: rid, txid: 'ab'.repeat(32), claims: settlement.claims, payouts: 1 });
  round.putLockSettlementShares(rid, settlement.shares);
  return toHex(rid);
}

const seedRound = (round, now, withStranger) => {
  const [P1, P2, X] = [0x51, 0x52, 0x5f].map(b32);
  const players = [
    { key: P1, outcome: 'DELIVERED', score: 500, played: true },
    { key: P2, outcome: 'FAILED', score: 200, played: true },
  ];
  if (withStranger) players.push({ key: X, played: false });
  return writeRound(round, players, { startMs: now - 3600000,
    settlement: { state: 'ACCEPTED', claims: [`${toHex(b32(0xa1))}:0`], shares: [{ pubkey: P1, msat: 90000n }] } });
};

const signedOf = (withStranger) => {
  const now = Date.UTC(2026, 10, 10);
  const round = new Round(openStore(':memory:'), () => now, { plugins: HOSTED });

  const rid = seedRound(round, now, withStranger);
  const rounds = seasonRounds(round, { games: new Set([toHex(NEXTBLOCK_GAME_ID)]), fromMs: now - 7 * 86400000, toMs: now });
  const json = signedSeasonRoundsJson(round, rounds, (d) => schnorr.sign(d, SECRETS[0]));
  return json.find((j) => j.roundId === rid);
};

test('r24-settle-1: control - the settled paid round is signed by the seat', () => {
  assert.equal(signedOf(false).sigs.length, 1);
});

test('r24-settle-1: a stranger\'s lockless entry does not stop the seat signing the settled round\'s season account', () => {
  const j = signedOf(true);
  assert.ok(j, 'the round is read');
  assert.equal(j.sigs.length, 1, `the seat signs the settled round despite one stranger entry with no lock (entries: ${JSON.stringify(j.entries.map((e) => [e.player.slice(0, 8), e.payoutMsat]))})`);
});
