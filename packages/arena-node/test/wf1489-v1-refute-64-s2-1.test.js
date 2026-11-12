// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute 2 of #1485 (feedback #010), after 8289312b6: the seat's guard reads the time of the HANDOUT only. On the page the handout runs
// BESIDE the funding ("the handout run while the player pays; the lock waits for both", index.html `funding`: the wallet, the exchange/reissue, a
// deposit invoice when the wallet is short) and the lock starts only once both are done. The time between the seat's 201 and the lock is the funding's,
// not bounded by anything the seat checks. With the page guard bypassed (it reads the player's own Date.now(); a slow clock - the premise 8289312b6
// itself says this seat guard "stands alone" for), a handout taken outside the kept lead, then funding + lock longer than that lead, leaves a made lock
// and an entry every seat refuses after the close - feedback #010 again.
// Scaled to the fixture's window: lead 0.9 s (kept 1.35 s), handout ~1.4 s before the close, funding + lock 1.84 s (live: kept 4.05 s,
// funding 2.8 s + lock 2.7 s = 5.5 s, the same 1.36x).
//
// kanban #1892 (the fix): the order goes as the page sends it - the handout through arena-client postHandout, the funding, then the page's check right
// before the lock (arena-client h2hLockRefusal), and the lock and the entry only if it lets them. The player's clock here runs slow: this process's
// Date.now() lags the seats' (test-clock) by every earlier skip, so the old Date.now() check would let every lock through. The seats' 201 says how long they
// still take entries (x-entry-close-in-ms), and the check reads that. What must never happen is the harm of feedback #010: a lock made (here: the
// entry sent after the check let it) and the entry refused. The handout alone locks nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { postHandout, h2hLockRefusal, seatClockAheadMs } from '../../arena-client/src/join.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const mk = (n) => ({ name: `p${n}`, key: b32(0x60 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0], session: ed25519.utils.randomSecretKey() });

test('#1489 refute 2 #1485: a head-to-head handout the seat takes must not be followed by a made lock and a refused entry when the funding beside it runs past the lead', async () => {
  const LEAD = 900, KEPT = Math.ceil(LEAD * 3 / 2), FUNDING_AND_LOCK = 1840;
  const PAGE_LEAD = KEPT;   // the page's ARENA_H2H_LEAD_MS (4 s live, the seat keeps 4.05 s), scaled as the seat's
  const w = await lockRound({ stakeMsat: 0n, serveOpts: { plugins: [NEXTBLOCK, RPS], h2hHandoutLeadMs: LEAD }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const realFetch = globalThis.fetch;
  const close = Number(w.c.entryCloseMs);
  // one order as the page makes it: the handout by postHandout, then `funding` ms of funding, then the check before the lock, then lock + entry
  const order = async (who, funding) => {
    const seen = [];
    let put = null, refusal = null, moved = false;
    globalThis.fetch = async (url, init) => {
      const u = String(url), path = new URL(u).pathname;
      if (init && init.method === 'POST' && path === '/handout') {
        // the page's own client posts it and keeps what the seat said
        put = await postHandout({ body: init.body }, [u.replace(/\/handout$/, '')], { fetcher: realFetch, needed: 1 });
        seen.push(`/handout ${put.ok ? 201 : 409}`);
        return put.ok ? new Response(new Uint8Array(32), { status: 201 }) : new Response(put.refused.join('; '), { status: 409 });
      }
      if (!moved && init && init.method === 'POST' && path === '/entry') {
        moved = true;
        // the funding beside the handout, then the lock: both clocks move on by it - the seats' (test-clock) and the player's, which stays as slow as it was
        skipTo(testNow() + funding);
        refusal = h2hLockRefusal({ put, entryCloseMs: close, leadMs: PAGE_LEAD, now: Date.now() + funding });
        if (refusal) throw new Error(`no lock: ${refusal}`);
      }
      const r = await realFetch(url, init);
      if (init && init.method === 'POST') seen.push(`${path} ${r.status}`);
      return r;
    };
    let got;
    try { await lockAndPlay(w, who, { session: who.session, hidden: { move: 1, salt: new Uint8Array(randomBytes(32)) }, noMarks: true, only: [], feeLock: false }); got = 'taken'; }
    catch (e) { got = String(e.message).split('\n').join(' ').slice(0, 300); }
    finally { globalThis.fetch = realFetch; }
    return { seen, got, refusal, put };
  };
  try {
    // the refute's order: a handout taken outside the kept lead, the funding past it (a timely order with the check: arena-client
    // wf1489-v1-refute-64-s2-2; the fixture's 1.5 s window has room for one handout outside the kept lead only)
    skipTo(Math.max(close - KEPT - 50, Number(w.c.committeeTimeMs) + 20));
    const leftAtHandout = close - testNow();
    assert.ok(leftAtHandout > KEPT, `outside the kept lead (${leftAtHandout} ms left)`);
    const late = await order(mk(1), FUNDING_AND_LOCK);
    const ownClockLeft = close - (Date.now() + FUNDING_AND_LOCK);   // what the old page check read at the lock: the player's clock, slow by every skip
    console.log('  FACTS (#1489 refute 2 #1485, #1892):', JSON.stringify({ leftAtHandout, kept: KEPT, fundingAndLock: FUNDING_AND_LOCK, ownClockLeft,
      seatAheadMs: seatClockAheadMs(late.put, close), late: { seen: late.seen, got: late.got } }));
    assert.ok(ownClockLeft > PAGE_LEAD, 'the player clock here must be slow, or this measures nothing the old check missed');
    assert.ok(late.seen.some((s) => /^\/handout 201/.test(s)), 'the seat took the handout (outside its kept lead)');
    // feedback #010's harm: a lock let through by the page and the entry refused after the close
    const refusedEntry = late.seen.some((s) => /^\/entry 4/.test(s));
    assert.ok(late.got === 'taken' || (!refusedEntry && late.refusal),
      `the seat took the handout ${leftAtHandout} ms before the close (kept lead ${KEPT} ms), the funding and lock took ${FUNDING_AND_LOCK} ms and the entry was refused: ${late.got}`);
    assert.ok(!late.seen.some((s) => /^\/entry /.test(s)), 'nothing was sent after the check refused the lock');
    assert.equal(w.nodes[0].round.entriesOf(w.rid).length, 0, 'no entry stands, and none was refused');
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
