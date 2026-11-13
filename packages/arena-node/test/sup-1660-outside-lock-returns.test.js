// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm1-find-entry 2 (state machine audit, entry): THE PLAYER WHO LOSES THE RACE FOR THE LAST SEAT HAS NO WAY BACK BUT EXPIRY.
// A paying head-to-head round (Rock Paper Scissors, 2 players) takes entries at the door before any lock (kanban #1437) and seats only
// lock-backed ones; the lock that would seat a third player is refused at /lock ("already seats"). Two honest players who both saw one seat
// free and both locked (the on-demand pairing, two tabs, a reload) reach exactly this: the slower one's entry stands at every seat, his
// money is in the federation, and his /lock is refused. Then:
//  - GET /forfeit for his entry refuses: "this signer node verified no stake lock for that entry";
//  - POST /refused-lock - the return door for a lock that entered nothing (open once the entries closed) - refuses too:
//    "that player entered the round at this signer node: the stake is settled with the round" - but the round never settles it.
// His stake waits for the lock's expiry (144 blocks live, about a day), on a lock every seat refused.
// Invariant: a lock every seat refused for an entry they hold has a return path before its expiry (the refused-lock door or the forfeit).
// Adapted to 1.9 by #2536: 1.9 refuses no valid lock as "full" (#1588): /lock keeps every lock, the seats are the `players` lock-backed
// entries with the lowest entry ids (#2538), and an entry left outside is VOID with its lock returned at settlement (#1582). The race of the
// card is the same - three players lock for two seats - and the invariant is asked of the one left outside: its lock comes back before expiry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const GRACE = 60000;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));

test('#1660 (1.9): the player left outside the two seats of a head-to-head round gets his lock back before its expiry', { timeout: 120000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], unenteredGraceMs: GRACE }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const base = (d) => `http://127.0.0.1:${d.port}`;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the third player's entry lands while one seat looks free (the door counts only lock-backed entries); the two others lock first
    const ps = [];
    { const s = salt(); ps.push({ move: ROCK, s, p: await lockAndPlay(w, mk(3), { hidden: { move: ROCK, salt: s }, noMarks: true, only: [] }) }); }
    for (const [n, move] of [[1, ROCK], [2, SCISSORS]]) { const s = salt(); ps.push({ move, s, p: await lockAndPlay(w, mk(n), { hidden: { move, salt: s }, noMarks: true }) }); }
    // now the third player's lock (its money is in the federation): kept at every seat (#1588), not refused as full
    const lockAns = [];
    for (const d of w.nodes) {
      const r = await fetch(`${base(d)}/lock?entry=${toHex(ps[0].p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(ps[0].p.fields)) });
      lockAns.push(`${r.status} ${(await r.text()).slice(0, 60)}`);
    }
    const seated = new Set(w.nodes[0].round.seatedEntriesOf(w.rid, w.c.stakeMsat).map(({ entryId }) => toHex(entryId)));
    const out = ps.filter((x) => !seated.has(toHex(x.p.eid)));
    assert.equal(out.length, 1, 'three locks for two seats leave one player outside');
    const third = out[0].p;
    const heldAt = w.nodes.map((d) => !!d.round.stakeLock(third.eid));
    skipTo(Number(w.c.entryCloseMs) + 2500);
    for (const x of ps) await Promise.all(w.nodes.map((d) => fetch(`${base(d)}/reveal?entry=${toHex(x.p.eid)}`, { method: 'POST', body: JSON.stringify({ move: x.move, salt: toHex(x.s) }) })));
    await closeRound(w);
    const settled = await untilSettled(w, 30000);
    // both seats' own settlement ACCEPTED (the forfeit is signed by both; each judges on its own record)
    for (const stop = Date.now() + 30000; Date.now() < stop; await new Promise((r) => setTimeout(r, 250)))
      if (w.nodes.every((d) => { const x = d.round.lockSettlement(w.rid); return x && x.state === 'ACCEPTED'; })) break;
    const states = w.nodes.map((d) => { const x = d.round.lockSettlement(w.rid); return x ? x.state : null; });
    const fe = await fetch(`${base(w.nodes[0])}/forfeit?round=${toHex(w.rid)}&entry=${toHex(third.eid)}`);
    const feWhy = fe.status === 200 ? 'signed' : (await fe.text()).slice(0, 160);
    const claimed = settled && settled.claims ? settled.claims : null;
    console.log('  FACTS #1660:', JSON.stringify({ lockAns, seated: [...seated].map((x) => x.slice(0, 16)), outside: toHex(third.eid).slice(0, 16), heldAt, settlement: settled && settled.state, states, forfeit: [fe.status, feWhy] }));
    assert.deepEqual(heldAt, [true, true], 'the lock of the player left outside is kept (not refused as full)');
    assert.equal(fe.status, 200, `the lock of the player left outside has no return before its expiry: forfeit ${fe.status} (${feWhy})`);
  } finally { await w.close(); }
});
