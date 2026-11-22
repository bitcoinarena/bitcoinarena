// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3249 #3256 with the real simulation and level check (src/sim, src/level-check.mjs): the server's score is runLog's; the post's level hash
// is the level check's; a run cannot be submitted faster than it lasts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    checkLevel, invoices: lnd, chain, log: () => {}, cfg: { showTest: true, entrySats: 100, adminSha: createHash('sha256').update('x').digest('hex') } });
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

test('#3271 a round opened on opr-1 keeps opr-1 after the service moved to opr-2: level check, replay and score are opr-1; a new round is opr-2', async () => {
  assert.equal(sim.GAME_VERSION, 'opr-2');
  const day = fx.days[fx.days.length - 2];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opr3271-')), dbPath = dir + '/opr.sqlite';
  let t = Date.parse('2026-11-22T10:00:00Z');
  const lnd = fakeLnd(), chain = fakeChain();
  const realSim = { GAME_VERSION: sim.GAME_VERSION, buildLevel: sim.buildLevel, runLog: sim.runLog };
  const mk = (s) => createOpr({ dbPath, now: () => t, sim: s, fetchCandles: async () => day.candles, checkLevel, invoices: lnd, chain, log: () => {},
    cfg: { showTest: true, entrySats: 100, adminSha: createHash('sha256').update('x').digest('hex') } });
  // before the deploy: the service ran opr-1 (the same code, its version pinned to opr-1)
  const old = mk({ ...realSim, GAME_VERSION: 'opr-1' });
  const made = old.testRound({ minutes: 60, chartDay: day.day });
  assert.equal(made.ok, true, made.why);
  await old.tick(); await old.tick(); chain.confirm(); await old.tick();
  assert.equal(old.roundRow(made.round.id).game_version, 'opr-1');
  old.close();
  // after the deploy: opr-2
  const opr = mk(realSim);
  const r = opr.roundRow(made.round.id);
  assert.equal(r.state, 'ready'); assert.equal(r.game_version, 'opr-1');
  const c1 = checkLevel(day.candles, r.id, { version: 'opr-1' });
  assert.equal(r.level_hash, c1.levelHash); assert.equal(c1.gameVersion, 'opr-1');
  const L1 = sim.buildLevel(day.candles, c1.seed, 'opr-1'), cfg = { ...sim.BOT_CONFIGS[0] };
  const { log } = sim.recordLog(L1, (w) => sim.botInput(w, { ...cfg }));
  assert.equal(log.v, 'opr-1');
  const want = sim.runLog(L1, log);
  const p = keypair();
  const s = await opr.startAttempt(p.pk, { round: r.id }); lnd.pay(s.invoice);
  const a = await opr.checkAttempt(p.pk, s.attempt);
  assert.equal(a.level.gameVersion, 'opr-1');
  t += Math.ceil(want.steps / 60) * 1000 + 500;
  const ok = opr.submit(p.pk, { attempt: s.attempt, token: a.token, log });
  assert.equal(ok.ok, true, ok.why);
  assert.deepEqual({ total: ok.score.total, parts: ok.score.parts, steps: ok.score.steps }, { total: want.total, parts: want.parts, steps: want.steps });
  // the same presses scored as opr-2 would differ: the round's own version decided
  const L2 = sim.buildLevel(day.candles, c1.seed, 'opr-2');
  assert.notDeepEqual(sim.runLog(L2, { ...log, v: 'opr-2' }).parts, want.parts);
  // an opr-2 log on the opr-1 round is refused
  const s2 = await opr.startAttempt(p.pk, { round: r.id }); lnd.pay(s2.invoice);
  const a2 = await opr.checkAttempt(p.pk, s2.attempt);
  t += 200000;
  assert.match(opr.submit(p.pk, { attempt: s2.attempt, token: a2.token, log: { ...log, v: 'opr-2' } }).why || '', /wrong game version: the round plays opr-1/);
  // a round opened now is opr-2, checked on opr-2
  t = Date.parse('2026-11-22T12:00:00Z');
  const made2 = opr.testRound({ minutes: 30, chartDay: day.day });
  assert.equal(made2.ok, true, made2.why);
  await opr.tick(); await opr.tick(); chain.confirm(); await opr.tick();
  const r2 = opr.roundRow(made2.round.id);
  assert.equal(r2.game_version, 'opr-2');
  assert.equal(r2.level_hash, checkLevel(day.candles, r2.id).levelHash);
  opr.close();
});
