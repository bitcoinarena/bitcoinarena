// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1479 (feedback #007): "one player stands with rock, paper and scissors and plays only the winner" - the fix refuses a
// second entry of the same SESSION key. Variant: three entries under three fresh keys (session and player), all lockless before the close (a
// lockless entry takes no seat of a paying round, #1437, so the seat count lets all three in). After the entry close the honest player's reveal is
// public (GET /reveals); within the lock grace (ENTRY_CLOSE_GRACE_MS, #1260) the attacker hands the locks of the one entry whose move beats it,
// and reveals only that one. Expected if the effect is closed: that late lock is refused, or the attacker's entry does not win.
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
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { ENTRY_CLOSE_GRACE_MS } from '../src/round.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const BEATS = { [ROCK]: PAPER, [PAPER]: SCISSORS, [SCISSORS]: ROCK };
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));

test('#1479 variant: three lockless entries under three keys, the winner locked in the grace after the honest reveal is public', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: ENTRY_CLOSE_GRACE_MS }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const hs = salt();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: hs }, noMarks: true });
    const att = {};
    for (const move of [ROCK, PAPER, SCISSORS]) {
      const who = mk(10 + move), s = salt();
      att[move] = { who, s, p: await lockAndPlay(w, who, { hidden: { move, salt: s }, noMarks: true, only: [] }) };
    }
    skipTo(Number(w.c.entryCloseMs) + 500);
    // the honest player reveals at once
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(honest.eid)}`, { method: 'POST', body: JSON.stringify({ move: ROCK, salt: toHex(hs) }) });
    // the attacker reads it
    const seen = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/reveals?round=${toHex(w.rid)}`)).json();
    const theirs = (seen.reveals || []).find((r) => (r.entry || r.entryId) === toHex(honest.eid));
    const hm = theirs ? Number(theirs.move) : ROCK;
    const win = att[BEATS[hm]];
    skipTo(Number(w.c.entryCloseMs) + 2000);
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(win.p.entry.feePreimage) }, amountMsat: win.p.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(win.who.key), expiration: win.p.fields.expiration };
    const locks = [];
    for (const d of w.nodes) {
      const base = `http://127.0.0.1:${d.port}`;
      const st = await fetch(`${base}/lock?entry=${toHex(win.p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(win.p.fields)) });
      const sw = (await st.text()).slice(0, 200);
      const fe = await fetch(`${base}/fee-lock?entry=${toHex(win.p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      locks.push({ stake: st.status, sw, fee: fe.status, fw: (await fe.text()).slice(0, 200) });
    }
    for (const d of w.nodes) await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(win.p.eid)}`, { method: 'POST', body: JSON.stringify({ move: BEATS[hm], salt: toHex(win.s) }) });
    await closeRound(w);
    const settled = await untilSettled(w);
    const got = { honest: results(w, honest.eid), attacker: results(w, win.p.eid) };
    console.log('  FACTS (refute 63-1):', JSON.stringify({ honestPublicMove: theirs ? theirs.move : null, locks, state: settled.state, results: got }));
    const late = locks.every((l) => l.stake === 201 || l.stake === 200);
    const attackerWon = got.attacker.some((per) => per.some((x) => x.startsWith('DELIVERED')));
    assert.ok(!(late && attackerWon), `the attacker stood with three moves and locked only the winner after the honest reveal: ${JSON.stringify({ locks, got })}`);
  } finally { await w.close(); }
});
