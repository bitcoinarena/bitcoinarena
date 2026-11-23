// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// audit-2026-11-22b settle round 1, finding 1 (gap in the #3054 fix): a replayed-game player signs TWO name records for his round key, each with
// its own identity's consent (identity A, and identity B a little newer), and posts A to 3 of the 7 seats and B to the other 4, both inside the
// 15 s join grace (POST /name answers 201 at each). Each record is then held by at least f + 1 = 3 seats, so verify.js carryNames marks each
// seat's own record held (2), and does NOT carry the other one, because "this seat holds another record of that player with its identity's
// consent" (consentedIdentityOf). 3 seats book the griefer's entry to identity A, 4 seats to identity B: two signed season accounts, neither at
// the threshold of 5, and mergeSignedSeasonAccounts leaves the whole round out for every player in it - exactly #3054's effect.
// Safe behaviour: after the carry pass the 7 honest seats sign ONE account of the settled round, so the honest winner's round counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Verifier } from '../src/verify.js';
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

const N = 7, NEEDED = 5;
const STAKE = 100000n, FEE = 2000n, DONATION = 2000n, NET = STAKE - FEE - DONATION;
const SECRETS = Array.from({ length: N }, (_, i) => b32(0x31 + i));
const SEATS = SECRETS.map((s) => schnorr.getPublicKey(s));
const URL_OF = (i) => `http://seat${i}`;
const GRIEFER_SECRET = b32(0x51), ID_A_SECRET = b32(0x52), ID_B_SECRET = b32(0x53), HONEST_SECRET = b32(0x54);
const GRIEFER = schnorr.getPublicKey(GRIEFER_SECRET), ID_A = schnorr.getPublicKey(ID_A_SECRET), ID_B = schnorr.getPublicKey(ID_B_SECRET);
const HONEST = schnorr.getPublicKey(HONEST_SECRET);
const NOW = Date.UTC(2026, 10, 10);

function seatStore(seat) {
  const store = openStore(':memory:');
  store.prepare('INSERT INTO identity (one, secret, pubkey) VALUES (0, ?, ?)').run(SECRETS[seat], SEATS[seat]);
  const round = new Round(store, () => NOW, { plugins: HOSTED });
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
    for (let s = 0; s < N; s++) {
      const r = { roundId: rid, playerPubkey: p.key, outcome: p.outcome, score: p.score, transcriptHash: b32(0xb0 + i), simCoreHash: contract.simCoreHash, nodePubkey: SEATS[s] };
      run = runId(r);
      db.prepare('INSERT INTO results (round_id, entry_id, node_pubkey, result_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(rid, eid, SEATS[s], resultId(r), joinSignedResult(encodePlayerResult(r), schnorr.sign(resultId(r), SECRETS[s])), 2);
    }
    for (let s = 0; s < N; s++)
      db.prepare('INSERT INTO final_sigs (round_id, entry_id, run_id, signer_pubkey, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)').run(rid, eid, run, SEATS[s], new Uint8Array(1), 3);
    round.putStakeLock({ entryId: eid, roundId: rid, outpoint: { txid: b32(0xa0 + i), outIdx: 0 }, fields: { amountMsat: String(NET) }, contractId: 'c' });
  });
  round.putLockSettlement({ roundId: rid, txid: 'ab'.repeat(32), message: b32(1), signature: new Uint8Array(64), state: 'ACCEPTED', why: '' });
  round.putLockSettlementMoves({ roundId: rid, txid: 'ab'.repeat(32), claims: [`${toHex(b32(0xa1))}:0`], payouts: 1 });
  round.putLockSettlementShares(rid, [{ pubkey: HONEST, msat: 90000n }]);
  return { round, rid };
}

// the griefer's two records, each signed by his round key and consented by its own identity, as POST /name takes them inside the join grace
function recordOf(rid, idKey, idSecret, atMs) {
  const rec = { roundId: rid, playerPubkey: GRIEFER, identityPubkey: idKey, name: '', atMs };
  const bytes = encodeLobbyName(rec);
  const sig = schnorr.sign(lobbyNameId(rec), GRIEFER_SECRET);
  const identitySig = schnorr.sign(matchProofId({ roundId: rid, entryId: GRIEFER, identityKey: idKey }), idSecret);
  return { rec, bytes, sig, identitySig, wire: { record: toHex(bytes), sig: toHex(sig), identitySig: toHex(identitySig) } };
}

const answerOf = (round, rid, s) => {
  const rounds = seasonRounds(round, { games: new Set([toHex(NEXTBLOCK_GAME_ID)]), fromMs: NOW - 7 * 86400000, toMs: NOW });
  return seasonRoundsFromJson(signedSeasonRoundsJson(round, rounds, (d) => schnorr.sign(d, SECRETS[s])).filter((j) => j.roundId === toHex(rid)));
};

async function play(split) {
  const seats = SEATS.map((_, i) => seatStore(i));
  const rid = seats[0].rid;
  const A = recordOf(rid, ID_A, ID_A_SECRET, 1000n), B = recordOf(rid, ID_B, ID_B_SECRET, 1500n);
  // which record each seat's door took: with `split`, A at seats 0-2 and B at seats 3-6; else A at every seat (the honest page)
  const heldBy = seats.map((_, i) => (split && i >= 3 ? B : A));
  seats.forEach((s, i) => assert.ok(s.round.putLobbyName({ roundId: rid, playerPubkey: GRIEFER, record: heldBy[i].bytes, signature: heldBy[i].sig,
    atMs: heldBy[i].rec.atMs, identitySig: heldBy[i].identitySig })));
  // every seat's carry pass (verify.js carryNames, run in settleRound after the runs are kept), reading its six peers' GET /names
  const was = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const i = SEATS.findIndex((_, j) => String(u).startsWith(`${URL_OF(j)}/`));
    return new Response(JSON.stringify({ names: i >= 0 ? [heldBy[i].wire] : [] }), { status: 200 });
  };
  try {
    for (let i = 0; i < N; i++) {
      const v = Object.create(Verifier.prototype);
      v.round = seats[i].round;
      v.peersOf = () => SEATS.map((_, j) => j).filter((j) => j !== i).map(URL_OF);
      await v.carryNames(rid);
    }
  } finally { globalThis.fetch = was; }
  const answers = new Map(seats.map((s, i) => [`seat-${i}`, answerOf(s.round, s.rid, i)]));
  const booked = seats.map((s) => { const r = seasonRounds(s.round, { games: new Set([toHex(NEXTBLOCK_GAME_ID)]), fromMs: NOW - 7 * 86400000, toMs: NOW })[0];
    return r.entries.find((e) => e.roundKey === toHex(GRIEFER)).player; });
  const m = mergeSignedSeasonAccounts(answers, { seatsOf: () => ({ ok: true, seats: SEATS.map(toHex), needed: NEEDED }), verify: (s, msg, k) => schnorr.verify(s, msg, k) });
  return { m, booked };
}

test('settle a6-1-1: control - one record at every seat, the 7 seats sign one account and the round counts', async () => {
  const { m } = await play(false);
  assert.equal(m.rounds.length, 1, JSON.stringify(m.excluded.map((x) => x.why)));
});

test('settle a6-1-1: two consented records of one round key, each held by f + 1 seats, must not split the season account of the round', async () => {
  const { m, booked } = await play(true);
  assert.equal(new Set(booked).size, 1, `every seat books the griefer's entry to one player after the carry pass; booked: ${JSON.stringify(booked.map((b) => b.slice(0, 8)))}`);
  assert.equal(m.rounds.length, 1, `the settled round counts for the honest winner; excluded: ${JSON.stringify(m.excluded.map((x) => x.why))}`);
});
