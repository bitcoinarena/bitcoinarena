// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1822 (#1489 #1551 refute 0, skeptic 3), the fast variant: the attacker reads the reveals 0.1 s after the close, when its seats'
// federation reads would still come back within H2H_DOOR_TIME_KEPT_MS and keep the door time. No seat serves a paying head-to-head round's
// reveals before the close + H2H_REVEAL_HOLD_MS, so he sees nothing and has to decide blind; served from then on.
// The s3-1 notes:
// bf5edcd18 (#1805) keeps the time POST /lock / POST /fee-lock read BEFORE asking the federation as the lock's verified_ms / seen_ms, and
// seatedEntriesOf (#1783) seats a head-to-head entry on that time. But the federation is asked only afterwards (verifyStakeLock: port.status of
// the outpoint the entry names) - live 2.2-2.7 s later, longer when the seat's read lane is busy. The entry names its lock's outpoint, i.e. a
// transaction the attacker built but has not submitted. So: hand both locks at every door 0.5 s before the close (door time < close, the
// federation holds nothing yet), read the opponent's revealed move after the close, and submit the lock transaction only when the committed move
// wins. The seats' federation reads land after that and find the lock: 201, verified_ms = the door's time, seated, paid. When it loses, the
// attacker submits nothing: the lock is refused (409), the round has one seated player and is VOID - the free option #1551 closed, reopened.
// Before #1805 (df616e824) verified_ms was the answer time (after the close) and such a lock seated nobody.
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

test('#1822 s3-2: no reveal of a paying head-to-head round is served while a lock handed before the close may still keep its door time', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    // the attacker: handout and entry in time, committed to PAPER; its lock transactions built (the entry names their outpoints), not submitted
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true, only: [] });
    const close = Number(w.c.entryCloseMs);
    const held = new Set([opKey(b.entry.stakeLockOutpoint), opKey(b.entry.feeLockOutpoint)]);
    let submitted = false;
    const status = w.port.status.bind(w.port);
    let waiting = 0, release;
    const answered = new Promise((r) => { release = r; });
    const timer = setTimeout(() => release(), 4000);
    let sawRock = null, heldSaid = null;
    // THE SEATS' FEDERATION READS LAND 2.5 s AFTER THEIR DOORS: by then the close passed, A revealed, and B decides
    w.port.status = async (o) => {
      if (!held.has(opKey(o))) return status(o);
      waiting += 1;
      if (waiting === 2 * w.nodes.length) {
        skipTo(close + 100);
        for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(a.eid)}`, { method: 'POST', body: JSON.stringify({ move: ROCK, salt: toHex(sa) }) });
        const rv = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/reveals?round=${toHex(w.rid)}`)).json();
        sawRock = rv.reveals.some((r) => r.entry === toHex(a.eid) && r.move === ROCK);
        heldSaid = rv;
        submitted = sawRock;   // PAPER beats ROCK: only now is the lock transaction submitted
        release();
      }
      await answered;
      const s = await status(o);
      return submitted ? s : { ...s, stored: null };
    };
    skipTo(close - 500);
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
    skipTo(Math.max(testNow(), close + 2500));
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(b.eid)}`, { method: 'POST', body: JSON.stringify({ move: PAPER, salt: toHex(sb) }) });
    const seated = w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).length);
    const verified = w.nodes.map((d) => { const l = d.round.stakeLock(b.eid); return l ? l.verifiedMs - close : null; });
    await closeRound(w);
    const got = { a: results(w, a.eid), b: results(w, b.eid) };
    const after = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/reveals?round=${toHex(w.rid)}`)).json();
    console.log('  FACTS (#1822 s3-2):', JSON.stringify({ sawRock, heldSaid, submitted, doors, seated, verifiedRelToCloseMs: verified, got, after: after.reveals.length }));
    assert.equal(sawRock, false, `a seat served the opponent's move 0.1 s after the close: ${JSON.stringify(heldSaid)}`);
    assert.equal(heldSaid.heldUntilMs, close + 1750, 'the held answer says until when');
    assert.ok(after.reveals.some((r) => r.entry === toHex(a.eid) && r.move === ROCK), 'the reveals are served once the hold is over');
    for (const x of seated) assert.equal(x, 1, `a lock never put on the federation seats its entry: ${JSON.stringify({ doors, seated, verified, got })}`);
    for (const per of got.b) assert.ok(!per.some((s) => s.startsWith('DELIVERED')), `the attacker, locked only once the revealed move let it win, is paid: ${JSON.stringify(got)}`);
    for (const per of got.a) assert.ok(!per.some((s) => s.startsWith('FAILED')), `the honest ROCK lost to a lock made after its reveal: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
