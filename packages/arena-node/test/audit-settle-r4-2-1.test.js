// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// audit-2026-11-19-r4 settle r2 finding 1: a replayed game's player posts his consented name record (POST /name, inside the 15 s join
// grace, before the entry close - the door answers 201) to SOME of the round's seats only. Those seats book his entry to his identity, the
// others to the bare round key, and nothing ever carries the record between seats for a replayed game (verify.js carryNames runs only in
// the head-to-head close, #1851/#2659). The seats then sign two different season accounts of the same settled round, no account reaches the
// threshold, and mergeSignedSeasonAccounts leaves the whole round out: every other player's win in it is gone from the leaderboard payout
// and the board badge (sibling of #2835, which was the lockless-entry way to the same exclusion).
// Safe behaviour: two honest seats holding the same settled round sign ONE account of it, so the round counts.
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
import { encodeLobbyName, lobbyNameId } from '../../arena-protocol/src/lobby-name.js';
import { matchProofId } from '../../arena-protocol/src/match.js';
import { mergeSignedSeasonAccounts, seasonRoundsFromJson } from '../../arena-protocol/src/season.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED, NEXTBLOCK_GAME_ID } from './plugins/hosted.js';

const STAKE = 100000n, FEE = 2000n, DONATION = 2000n, NET = STAKE - FEE - DONATION;
const SECRETS = [b32(0x31), b32(0x32)];
const SEATS = SECRETS.map((s) => schnorr.getPublicKey(s));
const GRIEFER_SECRET = b32(0x41), GRIEFER_ID_SECRET = b32(0x42), HONEST_SECRET = b32(0x43);
const GRIEFER = schnorr.getPublicKey(GRIEFER_SECRET), GRIEFER_ID = schnorr.getPublicKey(GRIEFER_ID_SECRET), HONEST = schnorr.getPublicKey(HONEST_SECRET);
const NOW = Date.UTC(2026, 10, 10);

// one seat's store of the same settled paid round: the honest player won (DELIVERED), the griefer lost (FAILED)
function seatStore(seat) {
  const store = openStore(':memory:');
  store.prepare('INSERT INTO identity (one, secret, pubkey) VALUES (0, ?, ?)').run(SECRETS[seat], SEATS[seat]);   // this seat's node key
  const round = new Round(store, () => NOW, { plugins: HOSTED });
  assert.equal(toHex(round.pubkey), toHex(SEATS[seat]));
  const db = round.db;
  const contract = { ...contractFor(SEATS, 3000n, ['wss://r.example']), gameId: NEXTBLOCK_GAME_ID, stakeMsat: STAKE, startTimeMs: BigInt(NOW - 3600000), censusHeight: 900001 };
  const rid = roundId(contract);
  db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(contract), 1);
  round.recordSignerNodes(rid, SEATS);
  const players = [{ key: HONEST, outcome: 'DELIVERED', score: 500 }, { key: GRIEFER, outcome: 'FAILED', score: 200 }];
  players.forEach((p, i) => {
    const e = { roundId: rid, playerPubkey: p.key, sessionPubkey: b32(0x60 + i), stakeCommitment: b32(0x70 + i), stakeMsat: STAKE,
      feeMsat: FEE, donationMsat: DONATION, joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(0x80 + i),
      stakePoint: Uint8Array.from([2, ...b32(0x90 + i)]), feePreimage: b32(0x11), stakeLockOutpoint: { txid: b32(0xa0 + i), outIdx: 0n },
      feeLockOutpoint: { txid: b32(0x12), outIdx: 0n }, claimKeyAttestationRef: b32(0) };
    const eid = entryId(e);
    db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(eid, rid, encodeEntryContract(e), 1 + i);
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
  round.putLockSettlement({ roundId: rid, txid: 'ab'.repeat(32), message: b32(1), signature: new Uint8Array(64), state: 'ACCEPTED', why: '' });
  round.putLockSettlementMoves({ roundId: rid, txid: 'ab'.repeat(32), claims: [`${toHex(b32(0xa1))}:0`], payouts: 1 });
  round.putLockSettlementShares(rid, [{ pubkey: HONEST, msat: 90000n }]);
  return { round, rid };
}

// what POST /name (server.js:10064) stores once both signatures verify, inside the join grace: the griefer's round key over the record,
// and his identity's consent over (round, round key)
function nameTakenAtDoor(round, rid) {
  const rec = { roundId: rid, playerPubkey: GRIEFER, identityPubkey: GRIEFER_ID, name: '', atMs: BigInt(NOW - 3600000) };
  const bytes = encodeLobbyName(rec);
  const sig = schnorr.sign(lobbyNameId(rec), GRIEFER_SECRET);
  const identitySig = schnorr.sign(matchProofId({ roundId: rid, entryId: GRIEFER, identityKey: GRIEFER_ID }), GRIEFER_ID_SECRET);
  assert.ok(schnorr.verify(sig, lobbyNameId(rec), GRIEFER), 'the record verifies as the door checks it');
  assert.ok(round.putLobbyName({ roundId: rid, playerPubkey: GRIEFER, record: bytes, signature: sig, atMs: rec.atMs, identitySig }));
}

const answerOf = (round, rid, s) => {
  const rounds = seasonRounds(round, { games: new Set([toHex(NEXTBLOCK_GAME_ID)]), fromMs: NOW - 7 * 86400000, toMs: NOW });
  return seasonRoundsFromJson(signedSeasonRoundsJson(round, rounds, (d) => schnorr.sign(d, SECRETS[s])).filter((j) => j.roundId === toHex(rid)));
};

const mergeTwo = (withNameAtSeat0) => {
  const a = seatStore(0), b = seatStore(1);
  assert.equal(toHex(a.rid), toHex(b.rid));
  if (withNameAtSeat0) nameTakenAtDoor(a.round, a.rid);   // the griefer posted his name to seat 0 only
  const answers = new Map([['seat-0', answerOf(a.round, a.rid, 0)], ['seat-1', answerOf(b.round, b.rid, 1)]]);
  return mergeSignedSeasonAccounts(answers, { seatsOf: () => ({ ok: true, seats: SEATS.map(toHex), needed: 2 }), verify: (s, m, k) => schnorr.verify(s, m, k) });
};

test('settle r4-2-1: control - two seats of a settled round sign one account and it counts', () => {
  const m = mergeTwo(false);
  assert.equal(m.rounds.length, 1);
});

test('settle r4-2-1: a name record posted to one seat only must not drop the honest winner\'s settled round from the season', () => {
  const m = mergeTwo(true);
  assert.equal(m.rounds.length, 1, `the settled round counts for the honest winner; excluded: ${JSON.stringify(m.excluded.map((x) => x.why))}`);
});
