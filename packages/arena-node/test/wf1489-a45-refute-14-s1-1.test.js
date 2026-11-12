// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a45 refute 14 (fix #1823, 212afb75a): THE HONEST PATH - A 2-OF-2 SEAT NO LONGER WAITS FOR A REAL LOCK IT COULD NOT YET CHECK.
// #1823 waits for a lock that failed verification only while `answers.length >= roundThreshold(slots)`. The answers come from the OTHER seats
// (verifier.peersOf excludes this one), so in a 2-of-2 head-to-head round (threshold 2, one peer) answers.length is at most 1: the seat never
// waits for a lock, whatever the reason it failed. Before #1823 a lock the one peer verified, which this seat failed to check for a moment
// ("the federation could not be asked"), was waited for and pulled on the next pass. Now the seat goes on at once WITHOUT the player's lock.
// Scenario: player a's locks reached seat B only (the relay to seat A did not get through); at the close seat A pulls them from B's
// GET /order-locks while its federation call fails for ~3 s, then answers again. SAFE: seat A ends up holding a's stake lock and signs both players.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0xd0 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) =>
  (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

async function play({ hiccup }) {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const realFetch = globalThis.fetch;
  const port = w.slot.port, realStatus = port.status.bind(port);
  const [seatA, seatB] = w.nodes;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the relay never gets a lock through to seat A (seat A was unreachable for its lock doors); the player posted them at seat B only
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (opts && opts.method === 'POST' && opts.headers && opts.headers['x-arena-relayed'] && (u.startsWith(`http://127.0.0.1:${seatA.port}/lock?`) || u.startsWith(`http://127.0.0.1:${seatA.port}/fee-lock?`)))
        throw new Error('connect ECONNREFUSED (seat A unreachable)');
      return realFetch(url, opts);
    };
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true, only: [1], lockFirst: false });
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true });
    const before = { aLockAtA: !!seatA.round.stakeLock(a.eid), aLockAtB: !!seatB.round.stakeLock(a.eid) };
    let failing = false, failed = 0;
    if (hiccup) {
      port.status = async (op) => { if (failing) { failed++; throw new Error('federation timeout'); } return realStatus(op); };
    }
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, sa); await reveal(w, b, PAPER, sb);
    if (hiccup) { failing = true; setTimeout(() => { failing = false; }, 3000).unref(); }
    await Promise.race([closeRound(w, { window: false }), sleep(20000)]);
    for (let i = 0; i < 60 && !(seatA.round.hasResult(w.rid, a.eid, seatA.round.pubkey) && seatA.round.hasResult(w.rid, b.eid, seatA.round.pubkey)); i++) await sleep(250);
    return { before, failed, aLockAtAEnd: !!seatA.round.stakeLock(a.eid),
      signedA: { a: seatA.round.hasResult(w.rid, a.eid, seatA.round.pubkey), b: seatA.round.hasResult(w.rid, b.eid, seatA.round.pubkey) },
      signedB: { a: seatB.round.hasResult(w.rid, a.eid, seatB.round.pubkey), b: seatB.round.hasResult(w.rid, b.eid, seatB.round.pubkey) } };
  } finally { port.status = realStatus; globalThis.fetch = realFetch; await w.close(); }
}

test('#1489 a45-14 control: seat A pulls the lock from seat B at the close and signs both players', { todo: 'kanban #2561 (spec ruling #2116): v1 #1916 takes a late lock only on a threshold of seats, so a 2-of-2 seat never pulls the one peer lock; the certified lock set replaces both rules' }, async () => {
  const got = await play({ hiccup: false });
  console.log('  FACTS (a45-14 control):', JSON.stringify(got));
  assert.equal(got.before.aLockAtA, false, 'the setup did not keep the lock from seat A');
  assert.ok(got.aLockAtAEnd, `control: seat A never pulled the lock: ${JSON.stringify(got)}`);
});

test('#1489 a45-14: a 2-of-2 seat whose federation call fails for a moment still waits for the one peer\'s real lock', { todo: 'kanban #2561 (spec ruling #2116): v1 #1916 takes a late lock only on a threshold of seats, so a 2-of-2 seat never pulls the one peer lock; the certified lock set replaces both rules' }, async () => {
  const got = await play({ hiccup: true });
  console.log('  FACTS (a45-14 hiccup):', JSON.stringify(got));
  assert.equal(got.before.aLockAtA, false, 'the setup did not keep the lock from seat A');
  assert.ok(got.failed > 0, 'the federation hiccup never hit seat A');
  assert.ok(got.aLockAtAEnd, `seat A went on without player a's stake lock (no wait in a 2-of-2: answers ${1} < threshold 2): ${JSON.stringify(got)}`);
});
