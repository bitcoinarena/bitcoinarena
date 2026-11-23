// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3249 #3256 with the real simulation and level check (src/sim, src/level-check.mjs): the server's score is runLog's; the post's level hash
// is the level check's; a run cannot be submitted faster than it lasts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as sim from '../src/sim/index.js';
import { checkLevel } from '../src/level-check.mjs';
import { createOpr } from '../server/opr-service.mjs';
import { decodeRoundPost } from '../server/opr-chain.mjs';
import { fakeLnd, fakeChain, keypair } from './server-helpers.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/candles-30d.json', import.meta.url)));

test('#3249 the real sim: a bot run is scored as runLog scores it; a shifted press changes the replay, never a claimed score', async () => {
  const day = fx.days[fx.days.length - 1];
  let t = Date.parse('2026-11-22T10:00:00Z');
  const lnd = fakeLnd(), chain = fakeChain();
  const opr = createOpr({ now: () => t, sim: { GAME_VERSION: sim.GAME_VERSION, buildLevel: sim.buildLevel, runLog: sim.runLog }, fetchCandles: async () => day.candles,
    checkLevel, invoices: lnd, chain, log: () => {}, cfg: { showTest: true, adminSha: createHash('sha256').update('x').digest('hex') } });
  const made = opr.testRound({ minutes: 30, chartDay: day.day });
  assert.equal(made.ok, true, made.why);
  await opr.tick(); await opr.tick(); chain.confirm(); await opr.tick();
  const r = opr.roundRow(made.round.id);
  const c = checkLevel(day.candles, r.id);
  assert.equal(r.level_hash, c.levelHash);
  assert.equal(decodeRoundPost(Buffer.from(chain.posts[0].hex, 'hex')).levelHash, c.levelHash);
  const L = sim.buildLevel(day.candles, c.seed);
  const cfg = { ...sim.BOT_CONFIGS[0] };
  const { log } = sim.recordLog(L, (w) => sim.botInput(w, cfg));
  const want = sim.runLog(L, log);
  const p = keypair();
  const s = await opr.startAttempt(p.pk, { round: r.id }); lnd.pay(s.invoice);
  const a = await opr.checkAttempt(p.pk, s.attempt);
  assert.deepEqual(a.level.seed, c.seed);
  t += 2000;
  assert.match(opr.submit(p.pk, { attempt: s.attempt, token: a.token, log }).why || '', /faster than the run's game time/);
  const s2 = await opr.startAttempt(p.pk, { round: r.id }); lnd.pay(s2.invoice);
  const a2 = await opr.checkAttempt(p.pk, s2.attempt);
  t += Math.ceil(want.steps / 60) * 1000 + 500;
  const ok = opr.submit(p.pk, { attempt: s2.attempt, token: a2.token, log, score: { total: 1e9 } });
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.score.total, want.total); assert.equal(ok.score.steps, want.steps); assert.equal(ok.score.deaths, want.deaths);
  // the same presses one step later: whatever it scores, it is the replay's score
  const shifted = { v: log.v, presses: log.presses.map(([d, u]) => [d + 1, u + 1]) };
  const s3 = await opr.startAttempt(p.pk, { round: r.id }); lnd.pay(s3.invoice);
  const a3 = await opr.checkAttempt(p.pk, s3.attempt);
  t += 200000;
  const sh = opr.submit(p.pk, { attempt: s3.attempt, token: a3.token, log: shifted });
  assert.equal(sh.ok, true); assert.equal(sh.score.total, sim.runLog(L, shifted).total);
  assert.equal(opr.boardOf(r.id)[0].total, Math.max(want.total, sh.score.total));
});
