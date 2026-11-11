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
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
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

test('#1489 sm1-entry-2 a stake lock refused for the last seat of a head-to-head round comes back before its expiry', { timeout: 120000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], unenteredGraceMs: GRACE }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const base = (d) => `http://127.0.0.1:${d.port}`;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the third player's entry lands while one seat looks free (the door counts only lock-backed entries)
    const c = await lockAndPlay(w, mk(3), { hidden: { move: ROCK, salt: salt() }, noMarks: true, only: [] });
    // the two others lock first and are seated
    await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: salt() }, noMarks: true });
    await lockAndPlay(w, mk(2), { hidden: { move: SCISSORS, salt: salt() }, noMarks: true });
    // now the third player's lock (its money is in the federation): refused at every seat
    const lockAns = [];
    for (const d of w.nodes) {
      const r = await fetch(`${base(d)}/lock?entry=${toHex(c.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(c.fields)) });
      lockAns.push([r.status, (await r.text()).slice(0, 100)]);
    }
    for (const [s] of lockAns) assert.equal(s, 409, 'the precondition: the lock for a third seat is refused');
    // the entries closed and the grace passed: the return doors are open for a lock that entered nothing
    skipTo(Number(w.c.entryCloseMs) + GRACE + 1000);
    const refused = [];
    for (const d of w.nodes) {
      const r = await fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST',
        body: JSON.stringify({ outpoint: `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}`, fields: lockFieldsToJson(c.fields) }) });
      refused.push([r.status, (await r.text()).slice(0, 120)]);
    }
    const fe = await fetch(`${base(w.nodes[0])}/forfeit?round=${toHex(w.rid)}&entry=${toHex(c.eid)}`);
    const feWhy = fe.status === 200 ? 'signed' : (await fe.text()).slice(0, 120);
    const fh = await fetch(`${base(w.nodes[0])}/forfeit?round=${toHex(w.rid)}&entry=${toHex(c.entry.vssSharesRef)}`);
    const fhWhy = fh.status === 200 ? 'signed' : (await fh.text()).slice(0, 120);
    console.log('  FACTS sm1-entry-2:', JSON.stringify({ lock: lockAns, refusedLock: refused, forfeitByEntry: [fe.status, feWhy], forfeitByHandout: [fh.status, fhWhy] }));
    assert.ok(fe.status === 200 || fh.status === 200,
      `the refused lock has no return before its expiry: /refused-lock ${JSON.stringify(refused[0])}, forfeit by entry ${fe.status} (${feWhy}), by handout ${fh.status} (${fhWhy})`);
  } finally { await w.close(); }
});
