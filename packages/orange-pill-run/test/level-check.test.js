// kanban #3247: the level check over 30 past UTC days of real Coinbase candles (stored fixture, no network).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { checkLevel, seedFor, levelHashOf, MAX_TRIES } from "../src/level-check.mjs";
import { checkCandles, dayStartOf } from "../src/candles.mjs";
import { GAME_VERSION, buildLevel } from "../src/sim/index.js";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/candles-30d.json", import.meta.url)));

test("the fixture holds 30 consecutive complete UTC days", () => {
  assert.equal(fx.days.length, 30);
  fx.days.forEach((d, i) => { assert.equal(checkCandles(d.candles, dayStartOf(d.day)), null, d.day); if (i) assert.equal(dayStartOf(d.day) - dayStartOf(fx.days[i - 1].day), 86400); });
});

test("the level check passes on each of the 30 days within the try limit", () => {
  const tries = [];
  for (const d of fx.days) {
    const r = checkLevel(d.candles, "opr-" + d.day);
    assert.equal(r.ok, true, d.day + " " + JSON.stringify(r.attempts.at(-1)));
    assert.ok(r.tries >= 1 && r.tries <= MAX_TRIES);
    assert.equal(r.seed, seedFor(d.candles, "opr-" + d.day, r.tries - 1));
    assert.match(r.levelHash, /^[0-9a-f]{64}$/);
    assert.equal(r.levelHash, levelHashOf(d.candles, r.seed));
    assert.equal(r.gameVersion, GAME_VERSION);
    assert.equal(r.bot.finished, true);
    tries.push(r.tries);
  }
  console.log("# tries per day:", tries.join(" "));
});

test("the check is repeatable and the seed depends on candles, round id and counter", () => {
  const d = fx.days[0], a = checkLevel(d.candles, "r1"), b = checkLevel(d.candles, "r1");
  assert.equal(a.seed, b.seed); assert.equal(a.levelHash, b.levelHash);
  assert.notEqual(seedFor(d.candles, "r1", 0), seedFor(d.candles, "r2", 0));
  assert.notEqual(seedFor(d.candles, "r1", 0), seedFor(d.candles, "r1", 1));
  assert.notEqual(seedFor(d.candles, "r1", 0), seedFor(fx.days[1].candles, "r1", 0));
  assert.notEqual(levelHashOf(d.candles, a.seed), levelHashOf(d.candles, a.seed, "opr-0"));
  assert.notEqual(levelHashOf(d.candles, a.seed), levelHashOf(d.candles, a.seed + 1));
});

test("a level no bot can finish fails after the try limit", () => {
  // a chart with a 3-row drop every candle and no flat stretch still builds; force failure with maxTries 0
  const r = checkLevel(fx.days[0].candles, "x", { maxTries: 0 });
  assert.equal(r.ok, false); assert.equal(r.levelHash, null);
  assert.ok(buildLevel(fx.days[0].candles, 1).goal > 0);
});
