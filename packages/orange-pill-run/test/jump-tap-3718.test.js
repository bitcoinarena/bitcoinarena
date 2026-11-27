// kanban #3718 (feedback #473, owner 2026-11-25 "klingt wie ein echtes Problem"): on desktop a normal click (60-120 ms) never got the
// miner over the first candle; only a ~450 ms hold did. opr-6 = opr-5 plus minJ: every jump rises at least minJ steps before a
// let-go cuts it, so a short click jumps as high as a finger's tap; a longer hold still jumps higher. A round keeps its version:
// opr-5 levels and logs replay under opr-5 as recorded.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildLevel, runLog, newWorld, stepWorld, botInput, BOT_CONFIGS, resultOf, GAME_VERSION, VERSIONS, T, ROWS, C0, isSolid } from "../src/sim/index.js";
import { checkLevel, seedFor } from "../src/level-check.mjs";
import { validateLog } from "../src/sim/replay.js";

const fx = (n) => JSON.parse(fs.readFileSync(new URL("./fixtures/" + n, import.meta.url)));
const days = fx("candles-30d.json").days, day = fx("prototype-day.json");
const surf = (L, cx) => { for (let r = 0; r < ROWS; r++) if (isSolid(L.t[r * L.w + cx])) return r; return -1; };
const TAP = 5;   // a 90 ms click = 5 simulation steps of 16.7 ms (the page holds a press for at least one step)

// the stuck player: runs into the first candle with no input, stands at its face, then clicks `steps` long, 3 times 40 steps apart;
// true when the miner stands on top of the first candle
function clearsFirstCandle(L, steps) {
  const W = newWorld(L), top = surf(L, C0) * T; let still = 0, lx = -1;
  while (still < 10 && W.f < 600) { stepWorld(W, { jump: false }); still = W.p.x === lx ? still + 1 : 0; lx = W.p.x; }
  assert.ok(W.p.x < C0 * T && W.stats.hits === 0, "the miner stands at the first candle's face");
  const s0 = W.f;
  while (W.f < s0 + 120) { stepWorld(W, { jump: (W.f - s0) % 40 < steps }); if (W.p.ground && W.p.x >= C0 * T - 8 && W.p.y + 22 <= top + 1) return true; }
  return false;
}

test("#3718 opr-6 is the game version: opr-5's rules plus minJ 9", () => {
  assert.equal(GAME_VERSION, "opr-6");
  const { minJ, ...r6 } = VERSIONS["opr-6"];
  assert.equal(minJ, 9); assert.deepEqual(r6, VERSIONS["opr-5"]);
  for (const v of ["opr-1", "opr-2", "opr-3", "opr-4", "opr-5"]) assert.equal(VERSIONS[v].minJ, undefined, v);
});

test("#3718 a 90 ms click clears the first candle on the 30 real days on opr-6 (on opr-5 it did not); a 450 ms hold clears it on both", () => {
  const n = { "opr-5": { tap: 0, click1: 0, hold: 0 }, "opr-6": { tap: 0, click1: 0, hold: 0 } };
  for (const d of days) { const seed = seedFor(d.candles, "opr-" + d.day, 0);
    for (const v of ["opr-5", "opr-6"]) { const L = buildLevel(d.candles, seed, v);
      assert.ok(12 - surf(L, C0) >= 2, d.day + " the first candle is a step up");
      if (clearsFirstCandle(L, TAP)) n[v].tap++;
      if (clearsFirstCandle(L, 1)) n[v].click1++;
      if (clearsFirstCandle(L, 27)) n[v].hold++; } }
  console.log("# 30 days, first candle cleared from a standstill: " + JSON.stringify(n));
  assert.equal(n["opr-6"].tap, 30); assert.equal(n["opr-6"].click1, 30); assert.equal(n["opr-6"].hold, 30);
  assert.ok(n["opr-5"].tap <= 2, "opr-5 90 ms clicks: " + n["opr-5"].tap); assert.equal(n["opr-5"].hold, 30);
});

test("#3718 a hold still jumps higher than a click on opr-6 (the jump height stays variable)", () => {
  const L = buildLevel(day.candles, fx("log-prototype-bot-opr-5.json").seed, "opr-6");
  const peak = (steps) => { const W = newWorld(L); while (!W.p.ground) stepWorld(W, { jump: false }); const y0 = W.p.y; let min = y0;
    for (let i = 0; i < 70; i++) { stepWorld(W, { jump: i < steps }); min = Math.min(min, W.p.y); } return y0 - min; };
  const click = peak(1), tap = peak(TAP), hold = peak(27);
  console.log("# opr-6 jump height (world units): 1-step click " + click + ", 90 ms " + tap + ", 450 ms " + hold);
  assert.equal(click, tap); assert.ok(tap >= 3 * T, "a click clears 3 tiles: " + tap); assert.ok(hold > tap + 12, "a hold is higher: " + hold);
});

test("#3718 old rounds keep their version: the opr-2..opr-5 logs replay as recorded, an opr-5 log is refused under opr-6; the opr-6 log replays", () => {
  for (const v of ["opr-2", "opr-3", "opr-4", "opr-5", "opr-6"]) { const rec = fx("log-prototype-bot-" + v + ".json"), L = buildLevel(day.candles, rec.seed, v);
    assert.equal(rec.log.v, v); assert.equal(validateLog(rec.log, v), null);
    assert.deepEqual(runLog(L, rec.log), { ...rec.result, cutPresses: 0 }, v); }
  assert.equal(validateLog(fx("log-prototype-bot-opr-5.json").log, "opr-6"), "wrong game version");
  assert.equal(validateLog(fx("log-prototype-bot-opr-6.json").log, "opr-5"), "wrong game version");
  // an opr-5 log replayed on its own opr-5 level is untouched by minJ; the same presses on the opr-6 level are another run
  const r5 = fx("log-prototype-bot-opr-5.json"), L6 = buildLevel(day.candles, r5.seed, "opr-6");
  assert.throws(() => runLog(L6, r5.log), /wrong game version/);
});

test("#3718 the opr-6 level is opr-5's level (only the jump differs); the level check passes the 30 days; bot deaths", () => {
  const strip = (L) => JSON.stringify({ ...L, version: null, t: [...L.t], colMeta: [...L.colMeta] });
  const tot = { "opr-5": { deaths: 0, fin: 0 }, "opr-6": { deaths: 0, fin: 0 } };
  for (const d of days) { const c5 = checkLevel(d.candles, "opr-" + d.day, { version: "opr-5" }), c6 = checkLevel(d.candles, "opr-" + d.day, { version: "opr-6" });
    assert.ok(c6.ok, d.day); assert.equal(c6.gameVersion, "opr-6");
    const seed = seedFor(d.candles, "x", 0); assert.equal(strip(buildLevel(d.candles, seed, "opr-6")), strip(buildLevel(d.candles, seed, "opr-5")), d.day);
    for (const [v, c] of [["opr-5", c5], ["opr-6", c6]]) { const L = buildLevel(d.candles, c.seed, v);
      for (const b of BOT_CONFIGS) { const cfg = { ...b }, W = newWorld(L); while (!W.done) stepWorld(W, botInput(W, cfg)); const r = resultOf(W); tot[v].deaths += r.deaths; if (r.finished) tot[v].fin++; } } }
  console.log("# 30 days x 3 bots: " + JSON.stringify(tot));
});
