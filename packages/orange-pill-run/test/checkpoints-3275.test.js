// kanban #3275 (owner 2026-11-22: "Die Checkpoints so gestalten, dass man nicht direkt danach sterben kann, z.B. direkt
// vor einem Feind oder direkt vor einem Abgrund"): on opr-3 every checkpoint is a safe spot and a respawn has a grace.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { buildLevel, newWorld, stepWorld, runLog, botInput, BOT_CONFIGS, checkpointSafe, hazardList, GAME_VERSION, VERSIONS, RESPAWN_GRACE, SAFE_STEPS, T, TILE } from "../src/sim/index.js";
import { checkLevel, seedFor } from "../src/level-check.mjs";

const fx = (n) => JSON.parse(fs.readFileSync(new URL("./fixtures/" + n, import.meta.url)));
const days = fx("candles-30d.json").days, old = fx("levels-old-3275.json").days, day = fx("prototype-day.json");
const levels = days.map((d) => { const c = checkLevel(d.candles, "opr-" + d.day); return { day: d.day, candles: d.candles, seed: c.seed, L: buildLevel(d.candles, c.seed) }; });

// a respawn at checkpoint i in a world that ran `pre` steps with the bot first, then `steps` steps with no input
function respawnAt(L, i, pre, { grace = true, steps = SAFE_STEPS } = {}) {
  const W = newWorld(L), cfg = { ...BOT_CONFIGS[1] };
  while (!W.done && W.f < pre) stepWorld(W, botInput(W, cfg));
  // a death as world.js respawn() leaves it: no sprint, no power, no wallet
  W.done = false; W.p.cp = i; W.p.dying = 1; W.p.boost = 0; W.p.shield = false; for (const k in W.p.pw) W.p.pw[k] = 0; const hits = W.stats.hits;
  stepWorld(W, { jump: false });
  const c = L.checkpoints[i];
  assert.equal(W.p.x, c.x * T); assert.equal(W.p.hurtT, RESPAWN_GRACE);
  if (!grace) W.p.hurtT = 0;
  let lived = 0; while (lived < steps && !W.done && W.p.dying === 0 && W.stats.hits === hits) { stepWorld(W, { jump: false }); lived++; }
  return { lived: W.done ? steps : lived, W };
}

test("#3275 opr-3 is the game version; it keeps opr-2's speeds and score and adds the safe checkpoints", () => {
  assert.equal(GAME_VERSION, "opr-3");
  const { safeCp, ...rest } = VERSIONS["opr-3"];
  assert.equal(safeCp, true); assert.deepEqual(rest, VERSIONS["opr-2"]);
  assert.ok(RESPAWN_GRACE >= 60); assert.equal(SAFE_STEPS, 90);
});

test("#3275 on the 30 fixture days every checkpoint is safe: solid ground, 1.5 s with no input free of gaps, rugs, spikes and every enemy and hazard", () => {
  let n = 0;
  for (const { day: d, L } of levels) {
    const hz = hazardList(L);
    assert.ok(L.checkpoints.length >= 5, d + " has " + L.checkpoints.length + " checkpoints");
    L.checkpoints.forEach((c, i) => {
      assert.ok(checkpointSafe(L, c.x, c.row, hz), d + " checkpoint " + i + " at " + c.x);
      if (i) { assert.ok(c.x > L.checkpoints[i - 1].x, d + " in order"); assert.ok([TILE.CG, TILE.CR, TILE.PLAT].includes(L.t[c.row * L.w + c.x]), d + " stands on the chart"); }
      n++;
    });
  }
  // the same for other seeds (a level check that needed more tries)
  for (const d of days.slice(0, 10)) for (const seed of [1, -77, seedFor(d.candles, "x", 3)]) { const L = buildLevel(d.candles, seed), hz = hazardList(L);
    for (const c of L.checkpoints) assert.ok(checkpointSafe(L, c.x, c.row, hz), d.day + " seed " + seed + " at " + c.x); }
  console.log("# checkpoints checked on the 30 days:", n);
});

test("#3275 a respawn at every checkpoint with no input lives at least 90 steps, also with the grace taken away, whatever ran before", () => {
  for (const { day: d, L } of levels) L.checkpoints.forEach((c, i) => {
    for (const pre of [0, 700, 2400]) {
      assert.ok(respawnAt(L, i, pre).lived >= 90, d + " cp " + i + " after " + pre);
      assert.ok(respawnAt(L, i, pre, { grace: false }).lived >= 90, d + " cp " + i + " after " + pre + " without the grace");
    }
  });
});

test("#3275 the opr-2 checkpoints were not safe (the owner's report): the same days on opr-2 have deadly ones", () => {
  let bad = 0;
  for (const { candles, seed } of levels) { const L2 = buildLevel(candles, seed, "opr-2"), hz = hazardList(L2);
    L2.checkpoints.forEach((c, i) => { if (i && !checkpointSafe(L2, c.x, c.row, hz)) bad++; }); }
  assert.ok(bad > 100, "unsafe opr-2 checkpoints: " + bad);
});

test("#3275 the grace: for RESPAWN_GRACE steps after a respawn an enemy on the runner does no harm; without it the same enemy kills", () => {
  const { L } = levels[0];
  const put = (grace) => { const W = newWorld(L); W.p.cp = 1; W.p.dying = 1; stepWorld(W, { jump: false }); if (!grace) W.p.hurtT = 0;
    const c = L.checkpoints[1]; W.L.enemies.push({ x: c.x * T + 8, row: c.row, x0: c.x * T + 8, dir: 0, span: 0 });
    for (let s = 0; s < 20; s++) stepWorld(W, { jump: false }); return W.stats.hits; };
  assert.equal(put(true), 0); assert.equal(put(false), 1);
});

test("#3275 opr-3 respawn: the bills in flight are gone and the bears are back at their place; opr-2 leaves both as they were", () => {
  const { candles, seed } = levels.find(({ L }) => L.enemies.some((e) => e.kind === "bear"));
  for (const [v, cleared] of [["opr-3", true], ["opr-2", false]]) {
    const L = buildLevel(candles, seed, v), W = newWorld(L), bear = W.L.enemies.find((e) => e.kind === "bear");
    W.bills.push({ x: 900, y: 200, vx: -1.7, t: 0 }); bear.x = bear.x0 - 50; bear.charging = true; W.p.buffer = 5;
    W.p.dying = 1; stepWorld(W, { jump: false });
    assert.equal(W.bills.length === 0, cleared, v); assert.equal(bear.x === bear.x0 && !bear.charging, cleared, v); assert.equal(W.p.buffer === 0, cleared, v);
  }
});

test("#3275 opr-3 keeps the layout and the enemies: the same tiles, coins and items as opr-2; a hazard on a checkpoint's stretch moves at most 18 columns, a handful are taken out", () => {
  let n2 = 0, n3 = 0, moved = 0, taken = 0;
  const same = (a, b) => { const { x0, x, minX, row, ...ra } = a, { x0: y0, x: y, minX: mb, row: r2, ...rb } = b; return JSON.stringify(ra) === JSON.stringify(rb); };
  for (const { day: d, candles, seed } of levels) {
    const L2 = buildLevel(candles, seed, "opr-2"), L3 = buildLevel(candles, seed, "opr-3");
    assert.deepEqual([...L3.t], [...L2.t]); assert.deepEqual(L3.coins, L2.coins); assert.deepEqual(L3.items, L2.items); assert.equal(L3.goal, L2.goal);
    // the hazards keep their order; each one of opr-3 is one of opr-2, in place or shifted by whole columns
    for (const [a2, a3] of [[L2.enemies, L3.enemies], [L2.clouds, L3.clouds]]) { let i = 0, mv = 0;
      for (const e of a3) { while (i < a2.length && !same(a2[i], e)) i++; assert.ok(i < a2.length, d + " " + JSON.stringify(e));
        const dx = e.x0 - a2[i].x0; assert.ok(dx % T === 0 && Math.abs(dx) <= 18 * T, d + " shift " + dx); if (dx) mv++; i++; }
      moved += mv; }
    taken += L3.taken;
    assert.equal(L2.enemies.length + L2.clouds.length - L3.enemies.length - L3.clouds.length, L3.taken, d);
    n2 += L2.enemies.length + L2.clouds.length; n3 += L3.enemies.length + L3.clouds.length;
  }
  console.log("# enemies and clouds on the 30 days: opr-2", n2, "opr-3", n3, "moved", moved, "taken out", taken);
  assert.ok(taken <= 10, "taken out " + taken);
});

test("#3275 old rounds unchanged: opr-1 and opr-2 levels hash as before on the 30 days, the opr-2 log scores as recorded", () => {
  const h = (L) => createHash("sha256").update(JSON.stringify({ ...L, t: [...L.t], colMeta: [...L.colMeta] })).digest("hex");
  assert.equal(old.length, 30);
  old.forEach((o, i) => { assert.equal(o.day, days[i].day);
    for (const v of ["opr-1", "opr-2"]) assert.equal(h(buildLevel(days[i].candles, o.seed, v)), o[v], o.day + " " + v); });
  const rec2 = fx("log-prototype-bot-opr-2.json"), r = runLog(buildLevel(day.candles, rec2.seed, "opr-2"), rec2.log);
  assert.deepEqual(r, { ...rec2.result, cutPresses: 0 });
});

test("#3275 the bots' deaths soon after a respawn: far fewer on opr-3 than on opr-2, the level check still 30/30", () => {
  // q: deaths within 60 steps of a respawn; still: of those, the ones with no jump since the respawn (the stretch itself)
  const quick = (v) => { let q = 0, still = 0;
    for (const { candles, seed } of levels) { const L = buildLevel(candles, seed, v);
      for (const b of BOT_CONFIGS) { const cfg = { ...b }, W = newWorld(L); let resp = -1e9, was = false, jumped = false;
        while (!W.done) { const h = W.stats.hits, inp = botInput(W, cfg); if (inp.jump) jumped = true; stepWorld(W, inp);
          if (W.stats.hits > h && W.f - resp <= 60) { q++; if (!jumped) still++; }
          if (was && W.p.dying === 0) { resp = W.f; jumped = false; } was = W.p.dying > 0; } } }
    return { q, still }; };
  const q2 = quick("opr-2"), q3 = quick("opr-3");
  console.log("# bot deaths within 60 steps of a respawn: opr-2", q2.q, "(" + q2.still + " without a jump) opr-3", q3.q, "(" + q3.still + " without a jump)");
  assert.equal(q3.still, 0); assert.ok(q3.q <= 2); assert.ok(q2.q > 10);
});
