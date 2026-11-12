// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 #1551 refute 0, skeptic 4, honest path: AN HONEST LOCK HANDED 2 s BEFORE THE CLOSE, ANSWERED 1.3 s AFTER IT, SEATS NOBODY.
// 6634c213c keeps the door time only when the federation answers by close + 1250 ms; a busy read lane (#605: up to 107 s) makes an honest
// lock handed at the handout lead late, and the honest winner is VOID.
// (s4-1 notes follow)
// 6634c213c (#1822) keeps a head-to-head lock's door time when the federation answer that found it comes back by close + 1250 ms, and relies on
// no seat serving GET /reveals before close + 1750 ms. But the honest page posts its reveal to EVERY seat of the committee right at the close
// (arena-client head-to-head.js revealMove), so the operator of any one committee seat holds the honest move from close + 0 in its own store,
// hold or not. Attacker = that seat's operator (or anyone it tells): hand both locks at every door 0.5 s before the close with the lock
// transactions built and held back, read the opponent's move off the colluding seat at close + 50 ms, submit only when the committed move wins.
// The honest seats' federation reads come back at close + 600 ms (< 1250): door time kept, seated, paid. Losing: nothing submitted, VOID.
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
const opKey = (o) => `${toHex(o.txid)}:${o.outIdx}`;


test('#1551 refute-0 s4-2: one committee seat sees the honest reveal at the close; a lock submitted then still keeps its door time at the honest seats', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true, only: [] });
    const close = Number(w.c.entryCloseMs);
    const held = new Set([opKey(b.entry.stakeLockOutpoint), opKey(b.entry.feeLockOutpoint)]);
    let submitted = false;
    const status = w.port.status.bind(w.port);
    let waiting = 0, release;
    const answered = new Promise((r) => { release = r; });
    const timer = setTimeout(() => release(), 4000);
    let sawRock = null, heldAtHonest = null;
    const colluder = w.nodes[w.nodes.length - 1];
    w.port.status = async (o) => {
      if (!held.has(opKey(o))) return status(o);
      waiting += 1;
      if (waiting === 2 * w.nodes.length) {
        submitted = true;   // honest: on the federation all along
        skipTo(close + 1300);   // a busy read lane: the federation answers 1.3 s after the close
        release();
      }
      await answered;
      const s = await status(o);
      return submitted ? s : { ...s, stored: null };
    };
    skipTo(close - 2000);
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(b.entry.feePreimage) }, amountMsat: b.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(mk(2).key), expiration: b.fields.expiration };
    const doors = await Promise.all(w.nodes.map(async (d) => {
      const base = `http://127.0.0.1:${d.port}`;
      const [s, f] = await Promise.all([
        fetch(`${base}/lock?entry=${toHex(b.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(b.fields)) }),
        fetch(`${base}/fee-lock?entry=${toHex(b.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) }),
      ]);
      return { stake: s.status, fee: f.status };
    }));
    clearTimeout(timer);
    w.port.status = status;
    skipTo(Math.max(testNow(), close + 2500));
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(a.eid)}`, { method: 'POST', body: JSON.stringify({ move: ROCK, salt: toHex(sa) }) });
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(b.eid)}`, { method: 'POST', body: JSON.stringify({ move: PAPER, salt: toHex(sb) }) });
    const seated = w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).length);
    const verified = w.nodes.map((d) => { const l = d.round.stakeLock(b.eid); return l ? l.verifiedMs - close : null; });
    await closeRound(w);
    const got = { a: results(w, a.eid), b: results(w, b.eid) };
    console.log('  FACTS (#1551 refute-0 s4-2):', JSON.stringify({ sawRock, heldAtHonest, submitted, doors, seated, verifiedRelToCloseMs: verified, got }));
    for (const x of seated) assert.equal(x, 2, `an honest lock handed 2 s before the close seats nobody: ${JSON.stringify({ doors, seated, verified, got })}`);
    for (const per of got.b) assert.ok(per.some((s) => s.startsWith('DELIVERED')), `the honest PAPER, locked before the close, is not paid: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
