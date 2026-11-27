// kanban #3251 (owner 2026-11-22: "Die Labels kommen oft vor der Figur und man sieht dann nicht, was vor einem ist"): no floating text
// box - popup or first-sight hint - lies in the 6 columns ahead of the runner at his height; popups are gone within 0.8 s.
import test from "node:test";
import assert from "node:assert/strict";
import { layoutPops, layoutHint, hintAge, layoutTimers, aheadZone, overlaps, POP_LIFE, HINT_LIFE } from "../client/src/labels.js";

let seed = 3251; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

test("popups sit above and behind the runner, never in the ahead zone, gone after 0.8 s", () => {
  for (let k = 0; k < 20000; k++) {
    const small = rnd() < .5, zoom = .85 + rnd() * 1.6, col = 24 * zoom, cssW = small ? 360 + rnd() * 60 : 600 + rnd() * 1200;
    const runner = { x: rnd() * cssW * .6, w: 16 * zoom, top: 100 + rnd() * 500 }; runner.bottom = runner.top + 22 * zoom;
    const n = 1 + Math.floor(rnd() * 4), pops = [];
    for (let i = 0; i < n; i++) pops.push({ text: "t" + i, w: 20 + rnd() * 200, age: Math.floor(rnd() * 80) });
    const zone = aheadZone(runner, col), out = layoutPops(pops, runner, col, small);
    assert.equal(out.length, pops.filter((p) => p.age < POP_LIFE).length);
    for (const r of out) {
      assert.ok(!overlaps(r, zone), JSON.stringify({ r, zone }));
      assert.ok(r.y1 <= runner.top, "above his head");
      assert.ok(r.x1 <= runner.x + runner.w / 2 || r.y1 <= runner.top - col, "behind him, or a column above his head");
    }
  }
  assert.equal(POP_LIFE / 60 <= 0.8, true);
});

test("popups do not stack on each other", () => {
  const runner = { x: 200, w: 16, top: 300, bottom: 322 };
  const out = layoutPops([{ text: "MOON BOOTS!", w: 90, age: 3 }, { text: "+10 stomp", w: 70, age: 1 }], runner, 24, true);
  assert.equal(out.length, 2); assert.ok(!overlaps(out[0], out[1]));
});

test("the hint box sits at the HUD band's edge and waits while the runner is up there", () => {
  const r = layoutHint(160, 375, 150, { x: 60, w: 16, top: 400, bottom: 422 }, 24);
  assert.ok(r && r.y0 === 154 && r.y1 === 182);
  assert.equal(layoutHint(160, 375, 150, { x: 60, w: 16, top: 160, bottom: 182 }, 24), null);
});

test("hints: once per kind a run, one at a time", () => {
  const seen = { next: 0 }; let on = 0;
  for (let f = 0; f < 3000; f++) { const ages = ["shit", "bear", "spike"].map((k) => hintAge(seen, k, f, true)).filter((a) => a >= 0); assert.ok(ages.length <= 1); on += ages.length; }
  assert.equal(on, 3 * (HINT_LIFE - 1));   // each from the step after it was scheduled
  assert.equal(hintAge(seen, "shit", 5000, true), -1);
});

test("power-up timers take the pill row's free room, short where it is tight", () => {
  const out = layoutTimers([{ x: 250, y: 10, end: 385 }], [{ full: "🌙 MOON BOOTS 10 s", short: "🌙 10 s", wFull: 140, wShort: 50 }, { full: "💎 DIAMOND HANDS 8 s", short: "💎 8 s", wFull: 150, wShort: 40 }], 18, 5);
  assert.deepEqual(out.map((r) => r && r.text), ["🌙 10 s", "💎 8 s"]);
  assert.equal(layoutTimers([{ x: 300, y: 10, end: 330 }], [{ full: "a", short: "b", wFull: 100, wShort: 60 }], 18, 5)[0], null);
});
