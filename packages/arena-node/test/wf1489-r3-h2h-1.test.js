// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 3, head-to-head: A LOCK HANDED AFTER A HEAD-TO-HEAD CLOSE, ONCE THE OPPONENT'S MOVE IS PUBLIC, MUST NOT SEAT ITS ENTRY.
// The attacker enters a paying Rock Paper Scissors round before the close (entry with its commitment at every seat) but hands no lock. From the
// close on the honest player's reveal is public (GET /reveals). Inside the 15 s lock grace (#1260, ENTRY_CLOSE_GRACE_MS, live on every seat)
// the attacker reads it: when its committed move wins it hands its locks and reveals, and is seated and paid; when it loses it hands nothing and
// the round, one seated player short, is VOID (the honest player's winning round undone, the attacker risks nothing). Safe: the late lock is
// refused at every seat, and the attacker is never played.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));

test('#1489 r3 h2h-1: a stake lock handed after the head-to-head close, once the opponent\'s move is public, does not seat the entry', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sp = salt(), so = salt();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sp }, noMarks: true });
    // the attacker: entry (and its commitment to PAPER) at every seat before the close, no lock anywhere yet
    const attacker = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: so }, noMarks: true, only: [] });
    // from the close + H2H_REVEAL_HOLD_MS (1750 ms) on a seat serves the reveals (kanban #1822): the attacker reads them then
    skipTo(Number(w.c.entryCloseMs) + 1800);
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(honest.eid)}`, { method: 'POST', body: JSON.stringify({ move: ROCK, salt: toHex(sp) }) });
    // the attacker reads the honest move off a seat - ROCK: its PAPER wins, so now it locks
    const seen = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/reveals?round=${toHex(w.rid)}`)).json();
    assert.equal(seen.reveals.find((r) => r.entry === toHex(honest.eid)).move, ROCK);
    skipTo(Number(w.c.entryCloseMs) + 2000);
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(attacker.entry.feePreimage) }, amountMsat: attacker.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(mk(2).key), expiration: attacker.fields.expiration };
    const late = [];
    for (const d of w.nodes) {
      const base = `http://127.0.0.1:${d.port}`;
      const s = await fetch(`${base}/lock?entry=${toHex(attacker.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(attacker.fields)) });
      const f = await fetch(`${base}/fee-lock?entry=${toHex(attacker.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      late.push({ stake: s.status, stakeWhy: (await s.text()).slice(0, 160), fee: f.status });
    }
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(attacker.eid)}`, { method: 'POST', body: JSON.stringify({ move: PAPER, salt: toHex(so) }) });
    await closeRound(w);
    const got = { honest: results(w, honest.eid), attacker: results(w, attacker.eid) };
    console.log('  FACTS (#1489 r3 h2h-1):', JSON.stringify({ late, got }));
    for (const x of late) assert.notEqual(x.stake, 201, `a stake lock new to a seat was taken after the head-to-head close, with the opponent's move public: ${JSON.stringify(late)}`);
    for (const per of got.attacker) assert.ok(!per.includes('DELIVERED 2'), `the late-locked attacker won the round: ${JSON.stringify(got)}`);
    for (const per of got.honest) assert.ok(!per.includes('FAILED 0'), `the honest player lost to a lock handed after the close: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
