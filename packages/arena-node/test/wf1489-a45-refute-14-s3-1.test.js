// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 a45 refute 14, skeptic 3 (fix #1823 + #2255 + #2335, db569f7ce): THE HONEST PATH, A SECOND WAY THE SAME HOLE OPENS.
// #2255 keeps a 2-of-2 seat waiting for a peer's real lock only when the check failed with "the federation could not be asked". A real lock
// whose check failed HERE for another transient reason is still the peer's fault under the #1823 gate (answers 1 < threshold 2), so the seat
// goes on without it. The stock tool's status mode asks the guardians twice - block_count, then stored_at (blocks_left) - two consensus
// reads, not one: a block between them gives block_count + blocks_left = expiration - 1, and verifyStakeLock answers "that contract's
// expiration is not the one the federation holds". Before #1823 that answer was a wait and the next pass pulled the lock; now a 2-of-2 seat
// drops the player's real lock for good. Scenario as s1-1: player a's locks reached seat B only; at the close seat A pulls them from B's
// GET /order-locks while its status read straddles a block for ~3 s. SAFE: seat A ends up holding a's stake lock.
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
      // block_count read, then a block, then stored_at: blocks_left is one less than at block_count
      port.status = async (op) => { const st = await realStatus(op); if (failing && st && st.stored) { failed++; return { ...st, stored: { ...st.stored, blocksLeft: st.stored.blocksLeft - 1 } }; } return st; };
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

test('#1489 a45-14-s3 control: seat A pulls the lock from seat B at the close and signs both players', async () => {
  const got = await play({ hiccup: false });
  console.log('  FACTS (a45-14-s3 control):', JSON.stringify(got));
  assert.equal(got.before.aLockAtA, false, 'the setup did not keep the lock from seat A');
  assert.ok(got.aLockAtAEnd, `control: seat A never pulled the lock: ${JSON.stringify(got)}`);
});

test('#1489 a45-14-s3: a 2-of-2 seat whose status read straddles a block still waits for the one peer\'s real lock', async () => {
  const got = await play({ hiccup: true });
  console.log('  FACTS (a45-14-s3 straddle):', JSON.stringify(got));
  assert.equal(got.before.aLockAtA, false, 'the setup did not keep the lock from seat A');
  assert.ok(got.failed > 0, 'the straddled status read never hit seat A');
  assert.ok(got.aLockAtAEnd, `seat A went on without player a's stake lock (expiration mismatch counted as the peer's fault: answers 1 < threshold 2): ${JSON.stringify(got)}`);
});
