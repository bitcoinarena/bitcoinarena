// Audit opr a7-1-4: gap in the #3355 fix. The network budget (refusedLogNetBytes per IPv6 /48 or IPv4 /24 and round) bounds REFUSED logs only.
// A scored run keeps its whole log as sent, and logRefusal lets it carry up to logPressesMost (6,000) presses: the sim replays the run and
// scores any well-formed tapping log, so a run that taps every other step (5,399 presses) is scored and stored at ~60 KB. One /48 holds 65,536 /64s (10 attempts each, fresh free keys): the shared disk fills again, now through scored runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as sim from '../src/sim/index.js';
import { checkLevel } from '../src/level-check.mjs';
import { createOpr, DEFAULTS } from '../server/opr-service.mjs';
import { keypair } from './server-helpers.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/candles-30d.json', import.meta.url)));

test('the logs a round keeps from one IPv6 /48 stay within the #3355 network budget, scored runs included', async () => {
  const day = fx.days[fx.days.length - 1];
  let t = Date.parse('2026-11-22T10:00:00Z');
  const opr = createOpr({ now: () => t, sim: { GAME_VERSION: sim.GAME_VERSION, buildLevel: sim.buildLevel, runLog: sim.runLog }, fetchCandles: async () => day.candles,
    checkLevel, chain: null, log: () => {}, cfg: { showTest: true, entrySats: 0, daily: false } });
  const made = opr.testRound({ minutes: 60, chartDay: day.day });
  assert.equal(made.ok, true, made.why);
  await opr.tick(); await opr.tick(); await opr.tick();
  const r = opr.roundRow(made.round.id);
  assert.equal(r.state, 'ready');
  const c = checkLevel(day.candles, r.id);
  const L = sim.buildLevel(day.candles, c.seed);
  const { log, W } = sim.recordLog(L, (w) => sim.botInput(w, { ...sim.BOT_CONFIGS[0] }));
  const real = sim.runLog(L, log);
  // a run that taps every other step from the start to maxSteps: every press is a real input (replayed, scored), 5,399 presses, ~60 KB
  const pad = [];
  for (let st = 0; st + 1 <= DEFAULTS.maxSteps && pad.length < DEFAULTS.logPressesMost; st += 2) pad.push([st, st + 1]);
  const big = { v: log.v, presses: pad };
  const bigRun = sim.runLog(L, big);
  assert.ok(Number.isFinite(bigRun.total) && bigRun.steps > 0, 'the tapping run replays and scores');
  const N = 40, open = [];
  for (let i = 0; i < N; i++) {
    const kp = keypair(), ip = `2001:db8:77:${(i + 1).toString(16)}::1`;   // one /48, a /64 each
    const s = await opr.startAttempt(kp.pk, { round: r.id, ip }); assert.equal(s.ok, true, s.why);
    open.push({ kp, s, ip });
  }
  t += Math.ceil(bigRun.steps / 60) * 1000 + 2000;
  for (const { kp, s, ip } of open) { const out = opr.submit(kp.pk, { attempt: s.attempt, token: s.token, log: big }, { ip }); assert.equal(out.ok, true, out.why); }
  const kept = opr.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(log)), 0) AS bytes FROM attempts WHERE round = ? AND state = 'scored'").get(r.id);
  console.log(`one /48, ${N} fresh keys: ${kept.n} runs kept, ${kept.bytes} bytes of logs (${Math.round(kept.bytes / kept.n)} each, ${big.presses.length} presses, run ${bigRun.steps} steps, score ${bigRun.total}; the bot's real run is ${JSON.stringify(log).length} bytes)`);
  assert.ok(kept.bytes <= DEFAULTS.refusedLogNetBytes, `one /48 stored ${kept.bytes} bytes of logs in one round through ${N} scored runs (budget ${DEFAULTS.refusedLogNetBytes}); 65,536 /64s x 10 attempts reach ~${Math.round(kept.bytes / N * 655360 / 1e9)} GB`);
});
