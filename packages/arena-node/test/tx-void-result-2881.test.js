// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2881 (feedback #103): GET /tx of an order whose round ended VOID with no settlement reads refunded, not pending for good.
// kanban #2872 (ruled 2026-11-16, §23.2 VOID "forfeit at once"; feedback #101): a head-to-head round nobody was played against is signed VOID
// for every entry, and its settlement claims nothing - the player's stake and fee locks waited 144 blocks for their expiry. They come back now.

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
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { resultFinality } from '../src/finality.js';
const untilFinal = async (w, eids) => { for (const stop = Date.now() + 40000; Date.now() < stop; await new Promise((r) => setTimeout(r, 250)))
  if (w.nodes.every((d) => eids.every((e) => resultFinality(d.round, w.rid, e).state === 'FINAL'))) return true; return false; };

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const GRACE = 60000;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));

const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });
  return r.status;
}));
const seated = (w) => w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).map(({ entryId }) => toHex(entryId).slice(0, 8)).sort());

test('#2881 GET /tx: a final-VOID head-to-head entry with no settlement reads refunded', { timeout: 120000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], unenteredGraceMs: GRACE }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const base = (d) => `http://127.0.0.1:${d.port}`;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const s1 = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: s1 }, noMarks: true });
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, s1);
    await closeRound(w);
    const fin = await untilFinal(w, [a.eid]);
    const outcomes = w.nodes.map((d) => { const r = d.round.results(w.rid, a.eid).find((x) => toHex(x.nodePubkey) === toHex(d.round.pubkey)); return r ? 'signed' : 'none'; });
    const tx = await (await fetch(`${base(w.nodes[0])}/tx?id=${toHex(a.eid)}`)).json();
    console.log('  FACTS #2881:', JSON.stringify({ final: fin, result: tx.result }));
    assert.equal(tx.result && tx.result.state, 'refunded', JSON.stringify(tx.result));
    const st = await fetch(`${base(w.nodes[0])}/forfeit?round=${toHex(w.rid)}&entry=${toHex(a.eid)}`);
    const stWhy = st.status === 200 ? 'signed' : (await st.text()).slice(0, 240);
    const fe = await fetch(`${base(w.nodes[0])}/forfeit?round=${toHex(w.rid)}&entry=${toHex(a.eid)}&lock=fee`);
    const feWhy = fe.status === 200 ? 'signed' : (await fe.text()).slice(0, 240);
    const settledAt0 = (await (await fetch(`${base(w.nodes[0])}/lock-settlement?round=${toHex(w.rid)}`)).text()).slice(0, 80);
    console.log('  FACTS #2872:', JSON.stringify({ final: fin, results: outcomes, stake: [st.status, stWhy], fee: [fe.status, feWhy], settlementAt0: settledAt0 }));
    assert.equal(st.status, 200, `a final-VOID head-to-head stake waits for its expiry: ${stWhy}`);
    assert.equal(fe.status, 200, `a final-VOID head-to-head fee lock waits for its expiry: ${feWhy}`);
  } finally { await w.close(); }
});

