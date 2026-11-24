// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Audit gossip r2 (a7-2-1): the #2982 identity proof binds a key to a nonce, not to an address. A seat whose address sorts before an honest
// seat's answers GET /season-rounds under the honest seat's key and relays GET /identity?nonce= to that seat: the honest seat's own
// signature over the asker's fresh nonce comes back, both addresses "prove" the key, the first in address order is kept - the liar's
// rounds stand in for the honest seat's and its vote is dropped (the #2982 effect, through its fix).
// A real node on an in-memory store; its rows written as the doors and the settlement write them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { serve, identityProofDigest } from '../src/server.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { seasonRounds } from '../src/season-read.js';
import { runId } from '../src/verdict.js';
import { contractFor, b32, opts } from './window-fixture.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { encodePlayerResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { encodeLobbyName } from '../../arena-protocol/src/lobby-name.js';
import { displayNameFromKey } from '../../arena-protocol/src/display-name.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
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
    if (p.record) round.putLobbyName({ roundId: rid, playerPubkey: p.key, signature: new Uint8Array(64), identitySig: new Uint8Array(64), atMs: 5, held: 2 /* held by f + 1 seats (kanban #3054) */,
      record: encodeLobbyName({ roundId: rid, playerPubkey: p.key, identityPubkey: p.record.identity, name: p.record.name || '', atMs: 5 }) });
  });
  if (settlement) {
    round.putLockSettlement({ roundId: rid, txid: 'ab'.repeat(32), message: b32(1), signature: new Uint8Array(64), state: settlement.state, why: '' });
    round.putLockSettlementMoves({ roundId: rid, txid: 'ab'.repeat(32), claims: settlement.claims || [], payouts: 1 });
    round.putLockSettlementShares(rid, settlement.shares || []);
  }
  return toHex(rid);
}

/** The season's rounds: a paid round settled, a free one later, a paid one not settled, one too old, one of another game. */
function seed(round, nowMs) {
  const [P1, P2, P3, P4, P5] = [0x51, 0x52, 0x53, 0x54, 0x55].map(b32);
  // 1 - PAID, ACCEPTED: P1 (identity I1, "alice") delivered and was paid its lock back and 90000 of P2's; P2's lock claimed
  writeRound(round, 1, [
    { key: P1, outcome: 'DELIVERED', score: 500, lock: true, record: { identity: I1, name: 'alice' } },
    { key: P2, outcome: 'FAILED', score: 200, lock: true },
  ], { startMs: nowMs - 2 * HOUR, settlement: { state: 'ACCEPTED', claims: [`${toHex(b32(0xa1))}:0`], shares: [{ pubkey: P1, msat: 90000n }] } });
  // 2 - FREE, later: P3 is I1 again under a new round key, renamed; P4's run has one FINAL signature of two - not FINAL
  writeRound(round, 2, [
    { key: P3, outcome: 'DELIVERED', score: 300, record: { identity: I1, name: 'alice2' } },
    { key: P4, outcome: 'DELIVERED', score: 900, finals: 1 },
  ], { stakeMsat: 0n, startMs: nowMs - HOUR });
  // 3 - PAID, its settlement still SUBMITTING: nothing of it is signed as paid yet
  writeRound(round, 3, [{ key: P5, outcome: 'DELIVERED', score: 999, lock: true }],
    { startMs: nowMs - 3 * HOUR, settlement: { state: 'SUBMITTING', shares: [] } });
  // 4 - FREE, ten days ago: outside a week, inside a fortnight
  writeRound(round, 4, [{ key: P5, outcome: 'DELIVERED', score: 50 }], { stakeMsat: 0n, startMs: nowMs - 10 * 24 * HOUR });
  // 5 - another game's round in the window
  writeRound(round, 5, [{ key: P5, outcome: 'DELIVERED', score: 7000 }], { stakeMsat: 0n, startMs: nowMs - HOUR, gameId: b32(0x77) });
  return { P1, P2, P3, P4, P5 };
}

async function season(relay, { mirror = false } = {}) {
  const key = (n) => toHex(schnorr.getPublicKey(b32(n)));
  const base = (x) => `http://127.0.0.1:9/seat-${x}`;
  const peers = ['0', 'a', 'b', 'c'].map(base);   // seat-0 is the attacker: its address sorts before A's
  const X = toHex(b32(0x5a)), F = toHex(b32(0x5f));
  const answers = new Map();
  const honestProof = (nonceHex) => new Response(JSON.stringify({ node: key(0xa1), nonce: nonceHex,
    sig: toHex(schnorr.sign(identityProofDigest(fromHex(nonceHex)), b32(0xa1))) }), { status: 200 });
  const seasonFetch = async (u) => {
    const proof = /^(.*)\/identity\?nonce=([0-9a-f]{64})$/.exec(u);
    // A proves its own key; the attacker's box forwards the same ask to A (a plain reverse proxy of one path) and hands A's answer back
    if (proof && (proof[1] === base('a') || (relay && proof[1] === base('0')))) return honestProof(proof[2]);
    if (proof) return new Response('no', { status: 404 });
    const at = peers.find((p) => u.startsWith(`${p}/`));
    const a = answers.get(at);
    if (!a) throw new Error('no answer');
    return new Response(JSON.stringify(a), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, peers, seasonFetch, ...opts });
  try {
    const now = Date.now();
    seed(d.round, now);
    const game = toHex(NEXTBLOCK_GAME_ID);
    const mine = await (await fetch(`http://127.0.0.1:${d.port}/season-rounds?game=nextblock`)).json();
    mine.rounds = mine.rounds.map((r) => ({ ...r, sigs: [] }));
    // a round A, B and C hold and this seat does not: three seats agree on it, so it counts
    const extra = { roundId: 'ee'.repeat(32), gameId: game, startMs: String(now - HOUR), void: false,
      entries: [{ player: X, name: 'bob', stakeMsat: '0', payoutMsat: '0', outcome: 'DELIVERED', score: 42 }] };
    const forged = { roundId: 'ff'.repeat(32), gameId: game, startMs: String(now - HOUR), void: false,
      entries: [{ player: F, name: 'mallory', stakeMsat: '1000', payoutMsat: '1000000000', outcome: 'DELIVERED', score: 9999 }] };
    const of = (n, rounds) => ({ node: key(n), rounds });
    // kanban #3585: a round only A and B hold - two seats, under the three it takes; one seat at two addresses must not make it three
    const P = toHex(b32(0x5b));
    const pair = { roundId: 'dd'.repeat(32), gameId: game, startMs: String(now - HOUR), void: false,
      entries: [{ player: P, name: 'pat', stakeMsat: '0', payoutMsat: '0', outcome: 'DELIVERED', score: 7 }] };
    answers.set(base('0'), mirror ? of(0xa1, [...mine.rounds, extra, pair]) : of(0xa1, [forged]));   // the attacker (or A's own mirror), under A's key
    answers.set(base('a'), of(0xa1, [...mine.rounds, extra, pair]));
    answers.set(base('b'), of(0xa2, [...mine.rounds, extra, pair]));
    answers.set(base('c'), of(0xa3, [...mine.rounds, extra]));
    const j = await (await fetch(`http://127.0.0.1:${d.port}/season?game=nextblock&scope=network`)).json();
    assert.equal(j.scope, 'network');
    assert.deepEqual(j.rows.filter((x) => x.player === X).map((x) => [x.name, x.rounds]), [['bob', 1]],
      'the round A, B and C agree on counts: the relayed proof must not let the attacker\'s answer replace honest A\'s');
    assert.deepEqual(j.rows.filter((x) => x.player === P), [], 'a round two seats hold stays off: one seat at two addresses counts once');
    assert.deepEqual(j.rows.filter((x) => x.player === F), [], 'the forged round, one voice, stays off');
  } finally { await d.close(); }
}

// control: the attacker's claim without a relayed proof is the #2982 case - A keeps its place, and the round counts (passes on BASE)
test('audit gossip a7-2-1 control: an unproven claim of A\'s key leaves A\'s vote', async () => { await season(false); });
// the finding: the same seat relays A's /identity?nonce= answer - fails on BASE
test('audit gossip a7-2-1: a seat relaying an honest seat\'s /identity proof does not take that seat\'s place in the network season', async () => { await season(true); });
// kanban #3585: one seat at two addresses that hand in the same account - a mirror of A, both proving A's key - still counts once (the #2982 rule)
test('audit gossip a7-2-1 mirror: two addresses proving one key with one account count once', async () => { await season(true, { mirror: true }); });
