// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute 96 s1, kanban #2199 (fix #1850, sm3-h2h-2): variants of the late head-to-head lock.
// 1. boundary: a lock new to a seat at exactly the entry close (and with the relay mark) is refused.
// 2. one colluding seat: a seat that takes the attacker's lock after the reveal (its own door skipped) serves it on GET /order-locks; does the
//    honest seat's membersKnown pull (takeEntryParts) seat it with no clock check, so the attacker is signed DELIVERED at the honest seat?
// 3. honest path: a lock handed 400 ms before the close is still taken at both seats.
// Ported to 1.9 by #2536: v2 (two seats) is #2483's case - a 2-of-2 seat takes one committee seat's signed word that it took the lock before
// the close, so a colluding seat that lies about its time carries the late lock (kept here as todo: needs a ruling). With three seats the
// other seats can reach the threshold themselves, and one seat's word no longer carries a late lock (kanban #2199 fix): v2-3.
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

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const ownOf = (d, w, eid) => d.round.results(w.rid, eid).filter((r) => toHex(decodePlayerResult(splitSignedResult(r.bytes).body).nodePubkey) === toHex(d.round.pubkey))
  .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }).join();
const postLock = (d, eid, fields, headers = {}) => fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)), headers })
  .then(async (r) => `${r.status} ${(await r.text()).slice(0, 70)}`);

test('#1489 a44-96 v1: a head-to-head lock new to a seat at exactly the entry close, or with the relay mark, is refused', { timeout: 110000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: new Uint8Array(randomBytes(32)) }, noMarks: true });
    const x = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: new Uint8Array(randomBytes(32)) }, noMarks: true, feeFirst: true, only: [] });
    skipTo(Number(w.c.entryCloseMs));
    const atClose = await postLock(w.nodes[0], x.eid, x.fields);
    const relayMarked = await postLock(w.nodes[1], x.eid, x.fields, { 'x-arena-relayed': '1' });
    console.log('  FACTS a44-96 v1:', JSON.stringify({ atClose, relayMarked }));
    assert.ok(!atClose.startsWith('201'), `a lock at exactly the close was taken: ${atClose}`);
    assert.ok(!relayMarked.startsWith('201'), `a relay-marked lock at the close was taken: ${relayMarked}`);
  } finally { await w.close(); }
});

test('#1489 a44-96 v2: one seat that took a late head-to-head lock hands it to the honest seat by GET /order-locks, and the attacker wins there', { timeout: 110000, todo: 'kanban #2199: in a 2-of-2 round #2483 takes one seat\'s signed word for the lock time - a ruling must weigh it against this' }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sy = new Uint8Array(randomBytes(32)), sx = new Uint8Array(randomBytes(32));
    const y = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sy }, noMarks: true });
    const x = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sx }, noMarks: true, feeFirst: true, only: [] });
    skipTo(Number(w.c.entryCloseMs) + 120);
    await Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(y.eid)}`, { method: 'POST', body: JSON.stringify({ move: ROCK, salt: toHex(sy) }) })));
    skipTo(Number(w.c.entryCloseMs) + 1000);
    // the colluding seat 0: its own door skipped (its clock and its reveal count lie for this one post)
    const bad = w.nodes[0].round, realNow = bad.now, realReveals = bad.revealsOf.bind(bad);
    bad.now = () => Number(w.c.entryCloseMs) - 500; bad.revealsOf = () => [];
    let atBad;
    try { atBad = await postLock(w.nodes[0], x.eid, x.fields); } finally { bad.now = realNow; bad.revealsOf = realReveals; }
    const atHonestDoor = await postLock(w.nodes[1], x.eid, x.fields);
    skipTo(Number(w.c.entryCloseMs) + 4000);
    await Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(x.eid)}`, { method: 'POST', body: JSON.stringify({ move: PAPER, salt: toHex(sx) }) })));
    await closeRound(w);
    const settled = await untilSettled(w, 15000);
    const honest = w.nodes[1];
    const got = { atBad, atHonestDoor, honestHoldsLock: !!honest.round.stakeLock(x.eid), honestSeated: honest.round.seatedEntriesOf(w.rid, w.c.stakeMsat).length,
      xAtHonest: ownOf(honest, w, x.eid), yAtHonest: ownOf(honest, w, y.eid), settlement: settled && settled.state };
    console.log('  FACTS a44-96 v2:', JSON.stringify(got));
    assert.ok(atBad.startsWith('201'), `setup: the colluding seat did not take the lock: ${atBad}`);
    assert.ok(!atHonestDoor.startsWith('201'), `the honest door took a late lock: ${atHonestDoor}`);
    assert.ok(!got.honestHoldsLock, `the honest seat pulled a lock one seat took after the reveal: ${JSON.stringify(got)}`);
    assert.ok(!got.xAtHonest.includes('DELIVERED'), `the honest seat signed the late-locked attacker the winner: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});

test('#2199 (1.9, three seats): one colluding seat that took a late head-to-head lock does not hand it to the honest seats', { timeout: 110000 }, async () => {
  const w = await lockRound({ n: 3, serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sy = new Uint8Array(randomBytes(32)), sx = new Uint8Array(randomBytes(32));
    const y = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sy }, noMarks: true });
    const x = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sx }, noMarks: true, feeFirst: true, only: [] });
    skipTo(Number(w.c.entryCloseMs) + 120);
    await Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(y.eid)}`, { method: 'POST', body: JSON.stringify({ move: ROCK, salt: toHex(sy) }) })));
    skipTo(Number(w.c.entryCloseMs) + 1000);
    // the colluding seat 0: its own door skipped (its clock and its reveal count lie for this one post)
    const bad = w.nodes[0].round, realNow = bad.now, realReveals = bad.revealsOf.bind(bad);
    bad.now = () => Number(w.c.entryCloseMs) - 500; bad.revealsOf = () => [];
    let atBad;
    try { atBad = await postLock(w.nodes[0], x.eid, x.fields); } finally { bad.now = realNow; bad.revealsOf = realReveals; }
    const atHonestDoor = await postLock(w.nodes[1], x.eid, x.fields);
    await postLock(w.nodes[2], x.eid, x.fields);
    skipTo(Number(w.c.entryCloseMs) + 4000);
    await Promise.all(w.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(x.eid)}`, { method: 'POST', body: JSON.stringify({ move: PAPER, salt: toHex(sx) }) })));
    await closeRound(w);
    const settled = await untilSettled(w, 15000);
    const honest = w.nodes.slice(1);
    const got = { atBad, atHonestDoor, honestHoldsLock: honest.some((d) => !!d.round.stakeLock(x.eid)), honestSeated: honest.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).length),
      xAtHonest: honest.map((d) => ownOf(d, w, x.eid)).join('|'), yAtHonest: honest.map((d) => ownOf(d, w, y.eid)).join('|'), settlement: settled && settled.state };
    console.log('  FACTS #2199 three seats:', JSON.stringify(got));
    assert.ok(atBad.startsWith('201'), `setup: the colluding seat did not take the lock: ${atBad}`);
    assert.ok(!atHonestDoor.startsWith('201'), `the honest door took a late lock: ${atHonestDoor}`);
    assert.ok(!got.honestHoldsLock, `the honest seat pulled a lock one seat took after the reveal: ${JSON.stringify(got)}`);
    assert.ok(!got.xAtHonest.includes('DELIVERED'), `the honest seat signed the late-locked attacker the winner: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});

test('#1489 a44-96 v3: an honest lock 400 ms before the close is taken at both seats (the honest path)', { timeout: 110000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: new Uint8Array(randomBytes(32)) }, noMarks: true });
    const x = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: new Uint8Array(randomBytes(32)) }, noMarks: true, feeFirst: true, only: [] });
    skipTo(Number(w.c.entryCloseMs) - 400);
    const answers = await Promise.all(w.nodes.map((d) => postLock(d, x.eid, x.fields)));
    const seated = w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).length);
    console.log('  FACTS a44-96 v3:', JSON.stringify({ answers, seated }));
    assert.ok(answers.every((a) => a.startsWith('201')), `an honest lock before the close was refused: ${JSON.stringify(answers)}`);
    assert.deepEqual(seated, [2, 2]);
  } finally { await w.close(); }
});
