// GET /season (kanban #362 feature 1): one game's board across its rounds, from what this node holds - a result counts once
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
import { HOSTED, NEXTBLOCK_GAME_ID } from './plugins/hosted.js';

const STAKE = 100000n, FEE = 2000n, DONATION = 2000n, NET = STAKE - FEE - DONATION;
const HOUR = 3600000;
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
    if (p.record) round.putLobbyName({ roundId: rid, playerPubkey: p.key, signature: new Uint8Array(64), atMs: 5,
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

test('GET /season: FINAL results, the settlement\'s amounts, one row per identity, ordered by net', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const { P2, P5 } = seed(d.round, Date.now());
    const ask = async (q) => fetch(`http://127.0.0.1:${d.port}/season${q}`);
    const r = await ask('?game=nextblock');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /max-age=30/);
    const j = await r.json();
    assert.deepEqual(j.game, { name: 'nextblock', ids: [toHex(NEXTBLOCK_GAME_ID)] });
    assert.equal(j.days, 7);
    assert.equal(j.toMs - j.fromMs, 7 * 24 * HOUR);
    assert.equal(j.rounds, 2, 'the settled paid round and the free one');
    assert.deepEqual(j.rows.map((x) => [x.rank, x.player, x.name, x.rounds, x.wins, x.netMsat, x.paidMsat, x.bestScore]), [
      // I1: 96000 back + 90000 of P2's against 100000 staked (a win by rank and by payout), then a free round's sole FINAL top
      [1, toHex(I1), 'alice2', 2, 2, String(NET + 90000n - STAKE), String(NET + 90000n), 500],
      [2, toHex(P2), displayNameFromKey(P2), 1, 0, String(-STAKE), '0', 200],
    ]);
    assert.ok(!j.rows.some((x) => x.player === toHex(P5)), 'an unsettled round, an old one, another game\'s: none of them');
    assert.ok(j.leftOut >= 2, 'the entry short of FINAL and the unsettled one are left out, and counted');
    assert.ok(Array.isArray(j.unchecked) && j.unchecked.length === 2);
    // the game by its id is the same season; a fortnight takes the old round in
    const byId = await (await ask(`?game=${toHex(NEXTBLOCK_GAME_ID)}&days=7`)).json();
    assert.deepEqual(byId.rows, j.rows);
    const two = await (await ask('?game=nextblock&days=14')).json();
    assert.equal(two.rounds, 3);
    assert.ok(two.rows.some((x) => x.player === toHex(P5) && x.wins === 1));
    // refused by name
    assert.equal((await ask('')).status, 400);
    assert.equal((await ask('?game=nosuchgame')).status, 404);
    for (const days of ['0', '91', '1.5', 'x']) assert.equal((await ask(`?game=nextblock&days=${days}`)).status, 400, days);
  } finally { await d.close(); }
});

test('seasonRounds: no amount for an entry until it is FINAL and settled; the payout is the lock it did not claim plus the share', () => {
  const now = Date.UTC(2026, 9, 14);
  const round = new Round(openStore(':memory:'), () => now, { plugins: HOSTED });
  const { P1, P2, P4, P5 } = seed(round, now);
  const read = seasonRounds(round, { games: new Set([toHex(NEXTBLOCK_GAME_ID)]), fromMs: now - 7 * 24 * HOUR, toMs: now });
  const flat = read.flatMap((r) => r.entries.map((e) => [e.player, e.outcome, e.score, e.payoutMsat === null ? null : String(e.payoutMsat)]));
  const of = (k) => flat.find((x) => x[0] === toHex(k));
  assert.equal(read.length, 3, 'the old round and the other game\'s are not read');
  assert.deepEqual(flat.find((x) => x[0] === toHex(I1) && x[2] === 500), [toHex(I1), 'DELIVERED', 500, String(NET + 90000n)], 'P1 under I1');
  assert.deepEqual(of(P2), [toHex(P2), 'FAILED', 200, '0']);
  assert.deepEqual(of(P4), [toHex(P4), null, null, null], 'one FINAL signature of two: no result, no amount');
  assert.deepEqual(of(P5), [toHex(P5), 'DELIVERED', 999, null], 'FINAL, and its settlement not ACCEPTED: no amount');
  assert.ok(!flat.some((x) => x[0] === toHex(P1)), 'a round key with an identity is never its own row');
  // A MARKET'S PICKS: no result read, the amount from the settlement alone; a free market is not on a season at all
  const market = seasonRounds(round, { games: new Set([toHex(NEXTBLOCK_GAME_ID)]), fromMs: now - 7 * 24 * HOUR, toMs: now, isMarket: () => true });
  assert.deepEqual(market.map((r) => r.entries.map((e) => [e.player, e.outcome, e.score, e.payoutMsat === null ? null : String(e.payoutMsat)])
    .sort()).sort((x, y) => y.length - x.length), [
    [[toHex(P2), null, null, '0'], [toHex(I1), null, null, String(NET + 90000n)]],      // in key order: 52.. before e1..
    [[toHex(P5), null, null, null]],
  ]);
});
