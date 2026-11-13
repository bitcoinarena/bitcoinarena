// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 skeptic 2 (round c) on #1598 at 8bdb004d5: ONE HONEST SEAT WHOSE CLOCK RUNS FAST LEAKS THE MOVE; A STRANGER LOCKS AT THE OTHERS.
// No seat is the attacker's. The page (arena-client revealMove, #2006) asks EACH seat GET /time and posts the reveal to it once that seat's
// clock is 250 ms past the close. One seat of three (honest, its clock 3 s fast - NTP off) gets the reveal ~2.75 s before the real close,
// takes it (by its own clock it is after the close) and serves it on the public GET /reveals. The attacker - rock, paper, scissors under three
// fresh session keys, fee locks only - reads it there and hands only the winner's stake lock to the two other seats, whose clocks are right:
// still more than H2H_LOCK_LEAD_MS (1000, the live value) before their close, no reveal held there, no early-sent move there (h2hEarlyOut is
// per seat), so both doors pass and write it (no peer is asked: the late-read door runs only when the door would refuse). Two of three is the
// round's threshold, so the fast seat pulls the lock at the close (takeEntryParts). Safe: the honest player is not beaten by a lock chosen
// after his move was public.
// kanban #2536 (re-check on 1.9 acbc1948c): #1598 is closed by the certified lock set (protocol 28, #2561, ruling #2116 (b)); rounds
// below 28 keep the old rules byte for byte by that ruling. The test is adapted to a protocol-28 round and its page
// (revealWhenCertified, as index.html calls it); the attack is the same - seat 2 runs 3 s fast, a stranger watches its GET /reveals and
// locks only the winner at the other seats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { revealWhenCertified } from '../../arena-client/src/head-to-head.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, protocolVersion: LOCK_SET_VERSION };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const BEATS = { [ROCK]: PAPER, [PAPER]: SCISSORS, [SCISSORS]: ROCK };
const mk = (n) => ({ name: `p${n}`, key: b32(0x90 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const revealTo = (w, played, move, s) => Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

test('#1598 refute c s2-1: one honest seat 3 s fast takes and serves the honest reveal early; a stranger locks only the winner at the other seats', { timeout: 170000 }, async () => {
  const w = await lockRound({ n: 3, serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000, h2hLockLeadMs: 1000, closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const hs = salt();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: hs }, noMarks: true });
    const moves = {};
    for (const move of [ROCK, PAPER, SCISSORS]) {
      const s = salt();
      moves[move] = { played: await lockAndPlay(w, mk(2 + move), { hidden: { move, salt: s }, noMarks: true, only: [], feeFirst: true }), salt: s };
    }
    // SEAT 2's clock runs 3 s fast (honest, NTP off): its round clock, the one its doors and GET /time read
    const FAST = 3000, fast = w.nodes[2], base = fast.round.now.bind(fast.round);
    fast.round.now = () => base() + FAST;
    const close = Number(w.c.entryCloseMs);
    // the honest page: its own clock right; it calls reveal at its close + 120 ms - but asks each seat first; here it starts 2.9 s before
    skipTo(close - 2900);
    const page = revealWhenCertified({ roundIdHex: toHex(w.rid), entryIdHex: toHex(honest.eid), move: ROCK, salt: hs, nodes: w.nodes.map((d) => `http://127.0.0.1:${d.port}`),
      committee: w.nodes.map((d) => toHex(d.round.pubkey)), verify: (sg, m, k) => schnorr.verify(sg, m, k), entryCloseMs: close, now: testNow });
    // the attacker (no seat) watches the fast seat's public GET /reveals
    let seenMove = null, seenAt = null;
    const watch = async (n) => {
      for (let i = 0; i < n && seenMove === null; i++) {
        const j = await (await fetch(`http://127.0.0.1:${fast.port}/reveals?round=${toHex(w.rid)}`)).json();
        const x = (j.reveals || []).find((r) => r.entry === toHex(honest.eid));
        if (x) { seenMove = x.move; seenAt = testNow() - close; } else await wait(20);
      }
    };
    await watch(100);
    const seenBeforeClose = seenMove !== null && seenAt < 0;   // seenAt: ms after the real close (the watch runs ~3 s of real time)
    // nothing served before the close: the attacker waits for the close and reads the move once it is out
    if (!seenBeforeClose) { skipTo(close + 400); await watch(300); }
    assert.notEqual(seenMove, null, 'the honest move was never served, even after the certificate');
    const winner = BEATS[seenMove], p = moves[winner].played;
    const answers = await Promise.all([0, 1].map(async (i) => { const r = await fetch(`http://127.0.0.1:${w.nodes[i].port}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) });
      return { seat: i, at: testNow() - close, status: r.status, said: (await r.text()).slice(0, 160) }; }));
    const said = await page;
    const seats = said.seats || [];
    skipTo(close + 400);
    await revealTo(w, p, winner, moves[winner].salt);
    await closeRound(w);
    await untilSettled(w, 20000).catch(() => {});
    const got = { attacker: results(w, p.eid), honest: results(w, honest.eid) };
    console.log('  FACTS (#1598 refute c s2-1):', JSON.stringify({ seenBeforeClose, certified: !!said.certified, seenMove, seenAtMsBeforeClose: seenAt, winner, answers, page: seats.map((s) => s.status), heldAt: w.nodes.map((d) => !!d.round.stakeLock(p.eid)), results: got }));
    assert.equal(seenBeforeClose, false, 'the fast seat served the honest move before the close');
    assert.ok(!got.attacker.some((per) => per.includes('DELIVERED 2')), `a stake lock chosen from a reveal one fast seat served won: ${JSON.stringify({ answers, got })}`);
  } finally { await w.close(); }
});
