// kanban #3547 (owner 2026-11-23 ~21:30Z: "Mach die nächste Runde 20 % schwerer"): opr-5 = opr-4 with about 20 % more enemies and
// 20 % more gaps (rug pits and spikes) placed by the same rules; the speeds, the score and the safe checkpoints (#3275) stay.
// Older versions build, hash and replay as before.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { buildLevel, runLog, checkpointSafe, gapCount, newWorld, stepWorld, botInput, BOT_CONFIGS, resultOf, GAME_VERSION, VERSIONS } from "../src/sim/index.js";
import { checkLevel, seedFor } from "../src/level-check.mjs";
import { validateLog } from "../src/sim/replay.js";

const fx = (n) => JSON.parse(fs.readFileSync(new URL("./fixtures/" + n, import.meta.url)));
const days = fx("candles-30d.json").days, pinned = fx("levels-opr4-3547.json").days, day = fx("prototype-day.json");
const hash = (L) => createHash("sha256").update(JSON.stringify({ ...L, t: [...L.t], colMeta: [...L.colMeta] })).digest("hex");

test("#3547 opr-5 is the game version: opr-4's rules plus more: 0.2", () => {
  assert.ok(["opr-5", "opr-6"].includes(GAME_VERSION));   // #3718: opr-6 = opr-5 plus minJ (jump-tap-3718 pins it)
  const { more, ...r5 } = VERSIONS["opr-5"];
  assert.equal(more, 0.2); assert.deepEqual(r5, VERSIONS["opr-4"]);
});

test("#3547 opr-3 and opr-4 levels hash as before opr-5 on the 30 days; the opr-3/opr-4 logs replay as recorded", () => {
  assert.equal(pinned.length, 30);
  pinned.forEach((o, i) => { assert.equal(o.day, days[i].day); assert.equal(o.seed, seedFor(days[i].candles, "opr-" + o.day, 0));
    for (const v of ["opr-3", "opr-4"]) assert.equal(hash(buildLevel(days[i].candles, o.seed, v)), o[v], o.day + " " + v); });
  for (const v of ["opr-3", "opr-4", "opr-5"]) { const rec = fx("log-prototype-bot-" + v + ".json"), L = buildLevel(day.candles, rec.seed, v);
    assert.equal(rec.log.v, v); assert.equal(validateLog(rec.log, v), null);
    assert.deepEqual(runLog(L, rec.log), { ...rec.result, cutPresses: 0 }, v); }
  // a log of one version is refused on another (the round's version decides, #3391)
  assert.equal(validateLog(fx("log-prototype-bot-opr-4.json").log, "opr-5"), "wrong game version");
});

test("#3547 the 30 days: about 20 % more enemies and gaps on opr-5, the level check 30/30, every checkpoint safe, more bot deaths", () => {
  const tot = { "opr-4": { enemies: 0, gaps: 0, deaths: 0, tries: 0 }, "opr-5": { enemies: 0, gaps: 0, deaths: 0, tries: 0 } };
  for (const d of days) for (const v of ["opr-4", "opr-5"]) {
    const c = checkLevel(d.candles, "opr-" + d.day, { version: v });
    assert.ok(c.ok, d.day + " " + v); assert.equal(c.gameVersion, v);
    const L = buildLevel(d.candles, c.seed, v), t = tot[v];
    t.enemies += L.enemies.length; t.gaps += gapCount(L); t.tries += c.tries;
    L.checkpoints.slice(1).forEach((cp) => assert.ok(checkpointSafe(L, cp.x, cp.row), d.day + " " + v + " checkpoint " + cp.x));
    for (const b of BOT_CONFIGS) { const cfg = { ...b }, W = newWorld(L); while (!W.done) stepWorld(W, botInput(W, cfg)); t.deaths += resultOf(W).deaths; }
  }
  const [a, b] = [tot["opr-4"], tot["opr-5"]], pct = (x, y) => Math.round((y / x - 1) * 1000) / 10;
  console.log("# 30 days opr-4", JSON.stringify(a), "opr-5", JSON.stringify(b), "enemies +" + pct(a.enemies, b.enemies) + " %, gaps +" + pct(a.gaps, b.gaps) + " %, both +" + pct(a.enemies + a.gaps, b.enemies + b.gaps) + " %, bot deaths +" + pct(a.deaths, b.deaths) + " %");
  for (const k of ["enemies", "gaps"]) { const p = pct(a[k], b[k]); assert.ok(p >= 15 && p <= 30, k + " +" + p + " %"); }
  const p = pct(a.enemies + a.gaps, b.enemies + b.gaps); assert.ok(p >= 18 && p <= 22, "both +" + p + " %");
  assert.ok(b.deaths > a.deaths);
});

test("#3547 opr-5 adds to opr-4's level on the same seed: more enemies and gaps, the same items, goal and par time", () => {
  let e4 = 0, e5 = 0, g4 = 0, g5 = 0;
  for (const d of days) { const seed = seedFor(d.candles, "x", 0), L4 = buildLevel(d.candles, seed, "opr-4"), L5 = buildLevel(d.candles, seed, "opr-5");
    assert.ok(L5.more.foes + L5.more.rugs + L5.more.spikes > 0, d.day); assert.equal(L4.more, undefined);
    e4 += L4.enemies.length; e5 += L5.enemies.length; g4 += gapCount(L4); g5 += gapCount(L5);
    assert.deepEqual(L5.items, L4.items); assert.equal(L5.goal, L4.goal); assert.equal(L5.parTime, L4.parTime); }
  assert.ok(e5 > e4 * 1.15 && g5 > g4 * 1.15, [e4, e5, g4, g5].join(" "));
});
