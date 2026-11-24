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

// RULING (2026-11-24, kanban #3582): a full network budget never refuses an attempt - an IPv4 /24 is shared by honest players. A scored run always
// keeps its log; the room it needs comes from that network's oldest kept logs of refused runs.

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/candles-30d.json', import.meta.url)));

test('one network\'s scored runs always keep their logs and are never refused; the room comes from its oldest refused logs (#3582 ruling)', async () => {
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
  const { log } = sim.recordLog(L, (w) => sim.botInput(w, { ...sim.BOT_CONFIGS[0] }));
  // a run that taps every other step from the start to maxSteps: every press is a real input (replayed, scored), ~60 KB
  const pad = [];
  for (let st = 0; st + 1 <= DEFAULTS.maxSteps && pad.length < DEFAULTS.logPressesMost; st += 2) pad.push([st, st + 1]);
  const big = { v: log.v, presses: pad };
  const bigRun = sim.runLog(L, big);
  assert.ok(Number.isFinite(bigRun.total) && bigRun.steps > 0, 'the tapping run replays and scores');
  const size = JSON.stringify(big).length, budget = DEFAULTS.refusedLogNetBytes;
  let n = 0;
  const open = async () => { n++; const kp = keypair(), ip = `198.51.100.${n}`;   // one IPv4 /24, an address each
    const s = await opr.startAttempt(kp.pk, { round: r.id, ip }); assert.equal(s.ok, true, `attempt ${n} from the /24: ${s.why}`); return { kp, s, ip }; };
  // refused runs first: sent at once, faster than the run's game time - refused, their logs kept for review while the network's budget holds
  const R = Math.floor(budget / size) - 2, refused = [];
  for (let i = 0; i < R; i++) { const o = await open(); const out = opr.submit(o.kp.pk, { attempt: o.s.attempt, token: o.s.token, log: big }, { ip: o.ip });
    assert.equal(out.ok, false, 'sent faster than its game time'); refused.push(o.s.attempt); t += 10; }
  const logOf = (id) => opr.db.prepare('SELECT log FROM attempts WHERE id = ?').get(id).log;
  assert.equal(refused.filter((id) => logOf(id) != null).length, R, 'the refused logs are kept within the budget');
  // then 40 scored runs from the same /24: none refused, every one keeps its log
  const S = 40, runs = [];
  for (let i = 0; i < S; i++) runs.push(await open());
  t += Math.ceil(bigRun.steps / 60) * 1000 + 2000;
  const keptAfter = [];
  for (const { kp, s, ip } of runs) {
    const out = opr.submit(kp.pk, { attempt: s.attempt, token: s.token, log: big }, { ip }); assert.equal(out.ok, true, out.why);
    keptAfter.push(refused.map((id) => logOf(id) != null));
  }
  const scored = opr.db.prepare("SELECT COUNT(*) AS n, SUM(log IS NOT NULL) AS logs, COALESCE(SUM(LENGTH(log)), 0) AS bytes FROM attempts WHERE round = ? AND state = 'scored'").get(r.id);
  console.log(`one /24: ${R} refused logs then ${S} scored runs of ${size} bytes - scored ${scored.n}, with log ${scored.logs}, ${scored.bytes} bytes (budget ${budget}); refused logs left after each scored run: ${keptAfter.map((k) => k.filter(Boolean).length).join(',')}`);
  assert.equal(scored.n, S); assert.equal(scored.logs, S, 'every scored run keeps its log');
  // the oldest refused logs go first: after the first scored run only the oldest was dropped, and at every step the kept ones are the newest
  for (const k of keptAfter) { const first = k.indexOf(true); assert.ok(first < 0 || k.slice(first).every(Boolean), 'refused logs are dropped oldest first'); }
  assert.ok(keptAfter[2].filter(Boolean).length < R, 'a scored run past the budget takes room from the refused logs');
  assert.equal(keptAfter[S - 1].filter(Boolean).length, 0, 'in the end no refused log of that network is left');
  // the network can still open attempts with its budget long used up
  const more = await open(); assert.equal(more.s.ok, true);
});
