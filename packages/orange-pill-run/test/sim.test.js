// kanban #3246: the simulation is deterministic and the same log gives the same score everywhere.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { buildLevel, newWorld, stepWorld, scoreOf, runLog, recordLog, validateLog, botInput, BOT_CONFIGS, GAME_VERSION, MAX_STEPS, TIME_LIMIT, sinRad, hypotD, sqrtD } from "../src/sim/index.js";

const fx = (n) => JSON.parse(fs.readFileSync(new URL("./fixtures/" + n, import.meta.url)));
const day = fx("prototype-day.json"), rec = fx("log-prototype-bot.json");
const L = buildLevel(day.candles, rec.seed);

test("a recorded log replayed twice gives the identical score, steps, time and deaths", () => {
  const a = runLog(L, rec.log), b = runLog(L, rec.log);
  assert.deepEqual(a, b);
  for (const k of ["total", "steps", "deaths", "timeS", "finished", "clean"]) assert.deepEqual(a[k], rec.result[k], k);
  assert.deepEqual(a.parts, rec.result.parts);
  assert.equal(a.finished, true);
});

test("the level object is not changed by a run (one L serves many runs)", () => {
  const before = JSON.stringify({ t: [...L.t], coins: L.coins, items: L.items, enemies: L.enemies });
  runLog(L, rec.log);
  assert.equal(JSON.stringify({ t: [...L.t], coins: L.coins, items: L.items, enemies: L.enemies }), before);
});

test("the same log in a second process gives the same result", () => {
  const code = `import("${new URL("../src/sim/index.js", import.meta.url).href}").then((s) => { const fs = require("fs");
    const day = JSON.parse(fs.readFileSync(process.argv[1])), rec = JSON.parse(fs.readFileSync(process.argv[2]));
    process.stdout.write(JSON.stringify(s.runLog(s.buildLevel(day.candles, rec.seed), rec.log))); });`;
  const out = execFileSync(process.execPath, ["-e", code, new URL("./fixtures/prototype-day.json", import.meta.url).pathname, new URL("./fixtures/log-prototype-bot.json", import.meta.url).pathname], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), runLog(L, rec.log));
});

test("runLog equals stepping the world by hand with the same presses", () => {
  const W = newWorld(L), ps = rec.log.presses;
  while (!W.done) { const s = W.f; stepWorld(W, { jump: ps.some(([d, u]) => d <= s && s < u) }); }
  const r = runLog(L, rec.log);
  assert.equal(scoreOf(W).total, r.total); assert.equal(W.f, r.steps);
});

test("presses that start after the flag or the time limit are cut", () => {
  const base = runLog(L, rec.log);
  const late = { v: GAME_VERSION, presses: [...rec.log.presses, [base.steps + 5, base.steps + 20], [base.steps + 100, base.steps + 400]] };
  const r = runLog(L, late);
  assert.equal(r.total, base.total); assert.equal(r.steps, base.steps); assert.equal(r.cutPresses, 2);
  // a log whose only press starts after the time limit: the run ends at 180 s game time, the press does nothing
  const idle = runLog(L, { v: GAME_VERSION, presses: [] });
  const after = runLog(L, { v: GAME_VERSION, presses: [[MAX_STEPS + 10, MAX_STEPS + 50]] });
  assert.deepEqual({ ...after, cutPresses: 0 }, { ...idle, cutPresses: 0 });
  assert.equal(after.cutPresses, 1);
  assert.ok(idle.timeS >= TIME_LIMIT && idle.timeS < TIME_LIMIT + 1, "ends at the limit: " + idle.timeS);
  assert.ok(idle.steps <= MAX_STEPS);
  assert.equal(idle.finished, false);
});

test("malformed logs and other versions are refused", () => {
  const bad = [null, {}, { v: "opr-0", presses: [] }, { v: GAME_VERSION }, { v: GAME_VERSION, presses: [[5, 5]] }, { v: GAME_VERSION, presses: [[5, 9], [9, 12]] },
    { v: GAME_VERSION, presses: [[9, 12], [1, 3]] }, { v: GAME_VERSION, presses: [[1.5, 3]] }, { v: GAME_VERSION, presses: [[-1, 3]] }, { v: GAME_VERSION, presses: [["1", 3]] }, { v: GAME_VERSION, presses: [[1, 2, 3]] }];
  for (const b of bad) { assert.ok(validateLog(b), JSON.stringify(b)); assert.throws(() => runLog(L, b), TypeError); }
  assert.equal(validateLog(rec.log), null);
});

test("the bot's recorded log replays to the bot's own run for every config and a second seed", () => {
  for (const seed of [rec.seed, 12345, -987654321]) {
    const Ls = buildLevel(day.candles, seed);
    for (const c of BOT_CONFIGS) { const cfg = { ...c }, { log, W } = recordLog(Ls, (w) => botInput(w, cfg)); const r = runLog(Ls, log);
      assert.equal(r.total, scoreOf(W).total); assert.equal(r.steps, W.f); assert.equal(r.deaths, W.stats.hits); }
  }
});

test("buildLevel is pure: same candles and seed give the same level, another seed another one", () => {
  const a = buildLevel(day.candles, 7), b = buildLevel(day.candles, 7), c = buildLevel(day.candles, 8);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual([...a.t], [...b.t]);
  assert.notEqual(JSON.stringify([...a.t]) + JSON.stringify(a.enemies), JSON.stringify([...c.t]) + JSON.stringify(c.enemies));
});

test("trig tables match Math within the drawing tolerance", () => {
  let worst = 0;
  for (let x = -50; x <= 400; x += 0.0137) worst = Math.max(worst, Math.abs(sinRad(x) - Math.sin(x)));
  assert.ok(worst < 0.002, "sin error " + worst);
  for (const [dx, dy] of [[0, 0], [3, 4], [1e-6, 2e-6], [149.9, -0.01], [-300, 299], [0.3, 0.4], [1234.5, 6789.1]]) {
    const h = hypotD(dx, dy), m = Math.hypot(dx, dy);
    assert.ok(Math.abs(h - m) <= 1e-12 * Math.max(1, m), dx + "," + dy + ": " + h + " vs " + m);
  }
  assert.equal(sqrtD(0), 0); assert.equal(sqrtD(-1), 0); assert.equal(sqrtD(16), 4);
});

test("the simulation sources use no engine-dependent or impure calls", () => {
  const dir = new URL("../src/sim/", import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(new URL(f, dir), "utf8").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(src, /Math\.(random|sin|cos|tan|hypot|sqrt|atan2?|exp|log|pow|cbrt)\b|\bDate\b|performance\.|document\.|window\.|\*\*/, f);
  }
});
