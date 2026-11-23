// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3387 (owner playtest 2026-11-23, round 6: "2 haben den Run nicht abgeschlossen. Man muss am Ende immer ein paar Sekunden warten, das ist ungut"):
// opr-4 puts the flag 2 columns after the last candle (opr-3: 18 columns and a 3-step wall, 2.6 s with nothing to do); opr-3 rounds build and
// replay as before. A run is sent until the service answers and again after a reload; the same run sent twice is answered as taken.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildLevel, newWorld, stepWorld, botInput, BOT_CONFIGS, runLog, GAME_VERSION, T, MAX_STEPS } from "../src/sim/index.js";
import { checkLevel } from "../src/level-check.mjs";
import { createEntry } from "../client/src/entry.js";
import { world, openRound, paidAttempt, keypair, logOf } from "./server-helpers.mjs";

const fx = (n) => JSON.parse(fs.readFileSync(new URL("./fixtures/" + n, import.meta.url), "utf8"));
const days = fx("candles-30d.json");
const dayList = Array.isArray(days) ? days : Object.values(days.days || days);
const candlesOf = (d) => (Array.isArray(d) ? d : d.candles);

// the steps of a bot run from the end of the chart to the flag
function runOut(L) {
  const W = newWorld(L), cfg = { ...BOT_CONFIGS[0] }; let crossed = null;
  while (!W.done && W.f < MAX_STEPS) { stepWorld(W, { jump: !!botInput(W, cfg).jump }); if (crossed == null && W.p.x >= L.chartEnd * T) crossed = W.f; }
  return { finished: W.stats.finished, after: crossed == null ? null : W.f - crossed };
}

test("#3387 opr-4 is the game version: the flag 2 columns after the chart, no wall; opr-3 keeps its 18 columns and the wall", () => {
  assert.ok(["opr-4", "opr-5"].includes(GAME_VERSION));   // #3547: opr-5 keeps opr-4's run-out
  const c = candlesOf(dayList[0]);
  const L3 = buildLevel(c, 7, "opr-3"), L4 = buildLevel(c, 7, "opr-4");
  assert.equal(L3.goal, L3.chartEnd + 18); assert.equal(L4.goal, L4.chartEnd + 2);
  const wall = (L) => [10, 11, 12].map((k) => L.t[11 * L.w + L.chartEnd + k]);
  assert.deepEqual(wall(L3), [2, 2, 2]); assert.deepEqual(wall(L4), [0, 0, 0]);
  // everything before the end of the chart is opr-3's: tiles, coins, items, enemies, clouds, checkpoints
  for (let y = 0; y < 14; y++) for (let x = 0; x < L3.chartEnd; x++) assert.equal(L4.t[y * L4.w + x], L3.t[y * L3.w + x]);
  assert.deepEqual(L4.checkpoints, L3.checkpoints);
  assert.deepEqual(L4.coins, L3.coins); assert.deepEqual(L4.items, L3.items); assert.deepEqual(L4.clouds, L3.clouds);
  assert.equal(L4.enemies.length, L3.enemies.length);
});

test("#3387 the 30 days on opr-4: the level check passes, the checkpoints are opr-3's, the bot reaches the flag within 0.5 s of the chart's end", () => {
  let n = 0, worst = 0, worst3 = Infinity;
  for (const d of dayList) {
    const c = candlesOf(d);
    const k = checkLevel(c, "r3387-" + n, { version: "opr-4" });
    assert.ok(k.ok, "level check day " + n);
    const L4 = buildLevel(c, k.seed, "opr-4"), L3 = buildLevel(c, k.seed, "opr-3");
    assert.deepEqual(L4.checkpoints, L3.checkpoints, "checkpoints day " + n);
    const r4 = runOut(L4), r3 = runOut(L3);
    if (r4.finished) worst = Math.max(worst, r4.after);
    if (r3.finished) worst3 = Math.min(worst3, r3.after);
    n++;
  }
  console.log("# days", n, "opr-4 steps chart end -> flag (most)", worst, "opr-3 (least)", worst3);
  assert.equal(n, 30); assert.ok(worst <= 30, "opr-4 run-out " + worst + " steps"); assert.ok(worst3 >= 90);
});

test("#3387 an opr-3 log still replays on its round's level as it did", () => {
  const day = fx("prototype-day.json"), rec = fx("log-prototype-bot-opr-3.json");
  const r = runLog(buildLevel(day.candles, rec.seed, "opr-3"), rec.log);
  assert.deepEqual({ total: r.total, steps: r.steps, deaths: r.deaths }, { total: rec.result.total, steps: rec.result.steps, deaths: rec.result.deaths });
});

const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const run = { attempt: "a1", token: "t1", round: "2026-11-23", log: { v: "opr-4", presses: [[5, 9]] }, client: {}, player: "pk1" };

test("#3387 a run is sent again while the service does not answer, and kept until it does", async () => {
  let t = 1000; const posts = []; const answers = [{ ok: false, status: 0 }, { ok: false, status: 502 }, { ok: true, status: 200, score: { total: 5 } }];
  const store = memStore();
  const e = createEntry({ api: { post: async (p, b) => { posts.push([p, b.attempt]); return answers.shift(); } }, store, now: () => t, sleep: async (ms) => { t += ms; } });
  const tries = [];
  const r = await e.submit({ ...run, deadlineMs: t + 600000 }, { onRetry: (n) => tries.push(n) });
  assert.equal(r.ok, true); assert.equal(posts.length, 3); assert.deepEqual(tries, [1, 2]);
  assert.deepEqual(JSON.parse(store.getItem("opr.unsent")), []);
  // a refusal is an answer: not sent again
  const e2 = createEntry({ api: { post: async () => { posts.push(1); return { ok: false, status: 409, why: "that token was used already" }; } }, store, now: () => t, sleep: async (ms) => { t += ms; } });
  posts.length = 0; assert.equal((await e2.submit({ ...run, deadlineMs: t + 600000 })).ok, false); assert.equal(posts.length, 1);
});

test("#3387 a run the page could not send is sent after a reload, by the same key, while its attempt is in time", async () => {
  let t = 1000; const store = memStore(); let up = false; const posts = [];
  const api = { post: async (p, b) => { posts.push(b.attempt); return up ? { ok: true, status: 200 } : { ok: false, status: 0 }; } };
  const e = createEntry({ api, store, now: () => t, sleep: async (ms) => { t += ms; } });
  // the tab closes while the first send hangs: the run stays kept
  const kept = e.submit({ ...run, deadlineMs: t + 600000 });
  await new Promise((ok) => setImmediate(ok));
  assert.equal(JSON.parse(store.getItem("opr.unsent"))[0].attempt, "a1");
  await kept;   // (the fake clock ran the retries out to the deadline; a real tab would have been closed)
  store.setItem("opr.unsent", JSON.stringify([{ ...run, deadlineMs: t + 600000 }, { ...run, attempt: "a2", token: "t2", player: "other", deadlineMs: t + 600000 }, { ...run, attempt: "a3", token: "t3", deadlineMs: t - 1 }]));
  up = true; posts.length = 0;
  const reloaded = createEntry({ api, store, now: () => t, sleep: async (ms) => { t += ms; } });
  const out = await reloaded.resendUnsent("pk1");
  assert.deepEqual(out.map((x) => [x.attempt, x.r.ok]), [["a1", true]]);   // another key's run is not sent, a run past its deadline is dropped
  assert.deepEqual(posts, ["a1"]);
  assert.deepEqual(JSON.parse(store.getItem("opr.unsent")).map((u) => u.attempt), ["a2"]);
});

test("#3387 the service answers the same run sent twice as taken; other presses on a used token are still refused", async () => {
  const w = world({ start: "2026-11-23T01:00:00Z" }); const r = await openRound(w); const p = keypair();
  const a = await paidAttempt(w, p.pk, r.id); w.clock.add(60000);
  const first = w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(6) });
  assert.equal(first.ok, true);
  const again = w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(6) });
  assert.equal(again.ok, true); assert.equal(again.again, true); assert.deepEqual(again.score, first.score);
  assert.equal(w.opr.submit(p.pk, { attempt: a.attempt, token: a.token, log: logOf(7) }).why, "that token was used already");
  assert.equal(w.opr.submit(keypair().pk, { attempt: a.attempt, token: a.token, log: logOf(6) }).why, "that token is not yours");
  assert.deepEqual(w.opr.boardOf(r.id).map((x) => x.total), [first.score.total]);
});
