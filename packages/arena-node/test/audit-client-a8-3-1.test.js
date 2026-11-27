// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUDIT client a8-3-1 (gap in #3694, the one-box-many-paths class of #3350/#3574/#3575-#3577/#3588/#3593 at another door):
// postHandout counts every URL of the link that answered 201 as one of the `needed` seats. The #3694 pre-lock recheck
// (h2hLockRecheck) is postHandout again, so one box named in the join link under two paths (http://box/a, http://box/b)
// that answers 201 to any POST /handout meets the threshold on its own, while every honest seat of the round answers
// 409 "table is full". The page then locks the stake and fee on a full head-to-head table, every seat refuses the entry,
// and the lock's fee parts are spent - the exact #3694 loss. SAFE: one host counts as one seat (seat-identity.js seatsOf),
// so the recheck refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, rand, secretScalar } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { feldmanGroup } from '../src/curve.js';
import * as join from '../../arena-client/src/join.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';

// the page's curve, as every Arena page loads it (arena-curve.js, window.ARENA_CURVE): what a seat proves at GET /identity is checked with it
globalThis.ARENA_CURVE = pageCurve;

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x30 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));

// the box: takes every handout at any path, says the entry stays open for an hour, proves no identity
function box() {
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST' && /\/handout$/.test(req.url)) { res.writeHead(201, { 'x-entry-close-in-ms': '3600000' }); res.end('taken'); return; }
      res.writeHead(404); res.end('no');
    });
  });
  return new Promise((ok) => s.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${s.address().port}`, seen, close: () => new Promise((r) => s.close(r)) })));
}

test('a8-3-1: one box under two link paths passes the #3694 pre-lock recheck on a table every honest seat calls full', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000, h2hHandoutLeadMs: 100 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const b = await box();
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const honest = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
    const needed = w.needed || 2;
    // the join link: the round's seats, and the box under as many paths as the threshold
    const nodes = [...honest, ...Array.from({ length: needed }, (_, i) => `${b.url}/s${i}`)];
    const e = rand(32);
    const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: b32(0x3d),
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed, curve: feldmanGroup });
    assert.equal(dealt.ok, true, dealt.why);
    const stake = { body: encodeHandout(dealt.handout), handout: { needed } };
    const put = await join.postHandout(stake, nodes, { needed });
    assert.equal(put.ok, true, `the handout was refused while the table was empty: ${put.refused}`);
    // the funding runs; two other players take both seats of the table
    await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: salt() }, noMarks: true });
    await lockAndPlay(w, mk(2), { hidden: { move: SCISSORS, salt: salt() }, noMarks: true });
    const honestNow = await Promise.all(honest.map(async (n) => { const r = await fetch(`${n}/handout`, { method: 'POST', body: stake.body }); return `${r.status} ${(await r.text()).slice(0, 80)}`; }));
    for (const s of honestNow) assert.match(s, /^409 .*table is full/, 'the precondition: every honest seat refuses that handout now');
    // the page's pre-lock check, as index.html:4813 asks it with named.nodes (the link's list)
    const why = await join.h2hLockRecheck({ stake, nodes, needed, put, entryCloseMs: w.c.entryCloseMs, leadMs: 0 });
    console.log('a8-3-1 FACTS:', JSON.stringify({ needed, honestNow, boxSaw: b.seen.length, preLock: why }));
    assert.ok(why, 'the pre-lock check let the lock go on a table every honest seat calls full: two paths of one box counted as the two seats needed');
  } finally { await b.close(); await w.close(); }
});
