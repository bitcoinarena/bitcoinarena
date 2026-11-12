// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1 refute of #1544 skeptic 2, variant 1: THE LATE FEE LOCK CARRIED IN BY A PEER SEAT (takeEntryParts).
// f626bf026 refuses a late lock at each seat's own door, but membersKnown -> takeEntryParts takes a peer's /order-locks with no close check.
// One seat that takes the late fee lock (a seat run by the griefer, or one on a build before #1733 with its 15 s grace) is enough: every honest
// seat carries the lock from it at the close, the waiting stake becomes seen there, and the griefer is played after he read the honest move.
// (original header follows)
// #1544 stops playing a stake lock that waits for its fee lock - but the fee lock door still takes a fee lock new to a seat until entry close
// + ENTRY_CLOSE_GRACE_MS (15 s), and reveals open at entry close and are public (GET /reveals). So the griefer hands only his stake lock, waits
// for the honest player's reveal, and hands his fee lock only when his committed move wins: then his stake is seen, he is played and wins.
// When it would lose he hands nothing and is VOID (stake back). The free option #1544 closed is still there.
// SAFE: a fee lock that arrives after the entry close (after any reveal can be public) does not make a waiting stake played - or is refused.
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
import { ENTRY_CLOSE_GRACE_MS } from '../src/round.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x70 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) =>
  (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

test('a late fee lock one peer seat took is not carried by the honest seats into a played (winning) stake', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: ENTRY_CLOSE_GRACE_MS }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sg = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: PAPER, salt: sa }, noMarks: true });
    // the griefer: entry everywhere, stake lock handed at every seat, fee lock held back (it is in the federation)
    const g = await lockAndPlay(w, mk(2), { hidden: { move: SCISSORS, salt: sg }, noMarks: true, only: [] });
    for (const d of w.nodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(g.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(g.fields)) });
      assert.equal(r.status, 201, await r.text());
    }
    skipTo(Number(w.c.entryCloseMs) + 500);
    // the honest player reveals at once, as the page does
    await reveal(w, a, PAPER, sa);
    // the griefer reads the honest move from the public door
    const pub = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/reveals?round=${toHex(w.rid)}`)).json();
    const theirs = pub.reveals.find((r) => r.entry === toHex(a.eid));
    assert.ok(theirs, 'the honest reveal is public');
    const wins = (SCISSORS - theirs.move + 3) % 3 === 1;
    assert.ok(wins, 'scissors beats paper: the griefer now chooses to take part');
    skipTo(Number(w.c.entryCloseMs) + 2000);   // inside the 15 s grace
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(g.entry.feePreimage) }, amountMsat: g.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(mk(2).key), expiration: g.fields.expiration };
    const feeAns = [];
    // the griefer's seat (or a seat on an older build) has no #1733 door: it takes the fee lock; the honest seat refuses it at its own door
    w.nodes[0].round.entryCloseGraceMs = null;
    for (const d of w.nodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/fee-lock?entry=${toHex(g.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      feeAns.push(`${r.status} ${(await r.text()).slice(0, 100)}`);
    }
    const seenG = w.nodes.map((d) => !!d.round.stakeSeen(g.eid));
    assert.match(feeAns[1], /^409 /, 'the honest seat refuses the late fee lock at its own door');
    await reveal(w, g, SCISSORS, sg);
    await closeRound(w);
    const got = { a: results(w, a.eid), g: results(w, g.eid) };
    console.log('  FACTS (refute-54-s2-1):', JSON.stringify({ feeAns, seenG, results: got }));
    const seenAfter = w.nodes.map((d) => !!d.round.stakeSeen(g.eid));
    console.log('  seen after the close:', JSON.stringify(seenAfter));
    // the honest seat must not play him: its own results for the griefer are VOID (or none), and it holds no fee lock it refused
    const gWon = got.g[1].some((x) => !x.startsWith('VOID')) || seenAfter[1];
    assert.ok(!gWon, `the griefer handed his fee lock after the honest move was public (${JSON.stringify(feeAns)}), was seated as stake seen ` +
      `(${JSON.stringify(seenG)}) and played: griefer ${JSON.stringify(got.g)}, honest ${JSON.stringify(got.a)} - had it lost he would have handed nothing and been VOID`);
  } finally { await w.close(); }
});
