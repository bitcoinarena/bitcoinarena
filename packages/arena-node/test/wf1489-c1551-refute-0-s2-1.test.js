// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 #1551 refute 0, skeptic 2 (honest path): A LOCK THE DOOR TOOK BEFORE THE CLOSE MUST SEAT ITS ENTRY.
// df616e824 (round.js seatedEntriesOf) seats a paying head-to-head entry only on a stake lock whose verified_ms is before the entry close. But
// verified_ms is written when the federation has answered (putStakeLock after verifyStakeLock), not when the door took the request: a lock
// alone takes 2.2-2.7 s at a live seat (#1485 note), and the live handout lead is only 2 s. So an honest page that hands its handout 2.05 s
// before the close and its locks right after gets 201 at every door (now < close there), while its row is written after the close - and the
// player is then not seated: VOID, played against nobody, the opponent left alone. Before df616e824 the same lock seated it.
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

test('#1551 refute-0 s2-1: an honest lock taken at the door before the head-to-head close, verified by the federation just after it, seats its entry', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    // player B: handout and entry in time, its page now hands both locks 1.8 s before the close (live: handout lead 2 s, a lock 2.2-2.7 s)
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true, only: [] });
    const close = Number(w.c.entryCloseMs);
    skipTo(close - 1800);
    // THE FEDERATION ANSWERS 2.3 s LATER: every door has checked its clock (all four requests are waiting on the federation), then the answer comes
    const status = w.port.status.bind(w.port);
    let waiting = 0, release;
    const answered = new Promise((r) => { release = r; });
    const timer = setTimeout(() => release(), 3000);
    w.port.status = async (o) => {
      waiting += 1;
      if (waiting === 2 * w.nodes.length) { skipTo(close - 1800 + 2300); release(); }
      await answered;
      return status(o);
    };
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(b.entry.feePreimage) }, amountMsat: b.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(mk(2).key), expiration: b.fields.expiration };
    const doors = await Promise.all(w.nodes.map(async (d) => {
      const base = `http://127.0.0.1:${d.port}`;
      const [s, f] = await Promise.all([
        fetch(`${base}/lock?entry=${toHex(b.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(b.fields)) }),
        fetch(`${base}/fee-lock?entry=${toHex(b.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) }),
      ]);
      return { stake: s.status, stakeSaid: (await s.text()).slice(0, 120), fee: f.status, feeSaid: (await f.text()).slice(0, 120) };
    }));
    clearTimeout(timer);
    w.port.status = status;
    skipTo(Math.max(testNow(), close + 500));
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(a.eid)}`, { method: 'POST', body: JSON.stringify({ move: ROCK, salt: toHex(sa) }) });
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(b.eid)}`, { method: 'POST', body: JSON.stringify({ move: PAPER, salt: toHex(sb) }) });
    const seated = w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).length);
    const verified = w.nodes.map((d) => { const l = d.round.stakeLock(b.eid); return l ? l.verifiedMs - close : null; });
    await closeRound(w);
    const got = { a: results(w, a.eid), b: results(w, b.eid) };
    console.log('  FACTS (#1551 refute-0 s2-1):', JSON.stringify({ doors, seated, verifiedAfterCloseMs: verified, got }));
    for (const x of doors) assert.equal(x.stake, 201, `the door refused a lock handed before the close: ${JSON.stringify(doors)}`);
    for (const x of seated) assert.equal(x, 2, `a lock every door took (201) before the close does not seat its entry - its row was written when the federation answered, after the close: ${JSON.stringify({ seated, verified, got })}`);
    for (const per of got.b) assert.ok(!per.some((s) => s.startsWith('VOID')), `the honest player, locked at the door before the close, was signed VOID: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
