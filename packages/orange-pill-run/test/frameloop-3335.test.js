// kanban #3335 (owner 2026-11-22: "Das Spiel ruckelt auf dem MacBook Pro M5"): the screen moves every frame by the time the frame took,
// at 120 Hz and at 60 Hz; the simulation and its result are the same as without drawing in between.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildLevel, newWorld, stepWorld, botInput, BOT_CONFIGS, STEP, MAX_STEPS, runLog, GAME_VERSION } from "../src/sim/index.js";
import { makeClock, snapMovers, drawBetween, TELEPORT } from "../client/src/frameloop.js";

const fx = (n) => JSON.parse(fs.readFileSync(new URL("./fixtures/" + n, import.meta.url)));
const day = fx("prototype-day.json"), rec = fx("log-prototype-bot-" + GAME_VERSION + ".json");
const L = buildLevel(day.candles, rec.seed);

// a runner at constant speed through the loop of main.js; returns the x each frame shows
function shown(hz, frames, { interp, jitterMs = 0, speed = 1 }) {
  const W = { f: 0, p: { x: 0, y: 0 }, L: { enemies: [], clouds: [], items: [], coins: [] }, bills: [] };
  const clock = makeClock(STEP); let prev = null, now = 1000; clock.reset(now);
  const xs = [];
  for (let i = 0; i < frames; i++) {
    now += 1000 / hz + (jitterMs ? ((i * 7919) % 11 - 5) / 5 * jitterMs : 0);
    clock.advance(now, speed, false, () => true, () => { prev = snapMovers(W); W.p.x += 2.88; W.f++; });
    xs.push(interp ? drawBetween(W, prev, clock.alpha(), () => W.p.x) : W.p.x);
  }
  return xs;
}
function judder(xs) {     // frames whose movement is under half or over 1.5 x the median
  const d = xs.slice(10).map((x, i, a) => (i ? x - a[i - 1] : null)).slice(1), m = [...d].sort((a, b) => a - b)[d.length >> 1];
  return d.filter((v) => v < .5 * m || v > 1.5 * m).length / d.length;
}

test("at 120 Hz the old loop shows a still frame every other frame, the new one moves every frame by the same step", () => {
  assert.ok(judder(shown(120, 600, { interp: false })) > .4);
  const xs = shown(120, 600, { interp: true }), d = xs.slice(11).map((x, i) => x - xs[10 + i]);
  for (const v of d) assert.ok(Math.abs(v - 1.44) < 1e-6, "moved " + v);
});

test("at 60 Hz with a jittery frame clock (+-1 ms) the old loop shows 0/2-step pairs, the new one none", () => {
  assert.ok(judder(shown(60, 600, { interp: false, jitterMs: 1 })) > .05);
  assert.equal(judder(shown(60, 600, { interp: true, jitterMs: 1 })), 0);
  assert.equal(judder(shown(144, 600, { interp: true, jitterMs: .5 })), 0);
  assert.equal(judder(shown(120, 600, { interp: true, speed: 2 })), 0);   // the replay at 2x
});

test("the clock: at most 0.1 s per frame, nothing while paused, alpha the unspent part of a step", () => {
  const c = makeClock(STEP); let n = 0; c.reset(0);
  assert.equal(c.advance(5000, 1, false, () => true, () => n++), 6);      // a tab back after 5 s: 0.1 s at most
  assert.equal(c.advance(6000, 1, true, () => true, () => n++), 0);
  assert.ok(Math.abs(c.alpha() - (.1 / STEP - 6)) < 1e-9);
  c.advance(6000 + 1000 / 120, 1, false, () => false, () => n++);          // the run is over: no step, alpha at most 1
  assert.ok(c.alpha() <= 1); assert.equal(n, 6);
});

test("drawing in between puts every number back: the bot's run is the same world as without it, step for step", () => {
  const cfgA = { ...BOT_CONFIGS[0] }, cfgB = { ...BOT_CONFIGS[0] }, A = newWorld(L), B = newWorld(L);
  let prev = null, draws = 0, alphaK = 0;
  while (!A.done && A.f < MAX_STEPS) {
    stepWorld(A, botInput(A, cfgA));
    prev = snapMovers(B); stepWorld(B, botInput(B, cfgB));
    for (const a of [0, .25, .5, .999]) drawBetween(B, prev, a, (fr) => { draws++; alphaK += fr - B.f; B.p.x; });
    if (B.f % 97 === 0) assert.equal(JSON.stringify(B, (k, v) => (v instanceof Map ? [...v] : v)), JSON.stringify(A, (k, v) => (v instanceof Map ? [...v] : v)), "at step " + B.f);
  }
  assert.ok(draws > 1000 && alphaK < 0);
  assert.equal(JSON.stringify(B, (k, v) => (v instanceof Map ? [...v] : v)), JSON.stringify(A, (k, v) => (v instanceof Map ? [...v] : v)));
  const r = runLog(L, rec.log); for (const k of ["total", "steps", "deaths", "timeS", "finished"]) assert.deepEqual(r[k], rec.result[k], k);
});

test("between two steps the runner is drawn in between, a respawn jump is never drawn across, and a throwing draw still restores", () => {
  const W = newWorld(L); const prev = snapMovers(W);
  W.p.x += 3; W.p.y += TELEPORT + 10;
  const seen = drawBetween(W, prev, .5, () => [W.p.x, W.p.y]);
  assert.deepEqual(seen, [prev.get(W.p)[0] + 1.5, prev.get(W.p)[1] + TELEPORT + 10]);
  const x = W.p.x;
  assert.throws(() => drawBetween(W, prev, .5, () => { throw new Error("x"); }));
  assert.equal(W.p.x, x);
});
