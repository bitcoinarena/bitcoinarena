// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3613 (feedback #449): sameLog compared a hash over every raw press, while runLog stops at the run's end. A copied log with two presses
// appended after the end (or a last release moved past it) replayed to the same score with a new hash, and the duplicate-run check missed it.
// The hash (and the bot signals) now read only what the replay used: presses that start before the end, each released at the end at most.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as sim from '../src/sim/index.js';
import { checkLevel } from '../src/level-check.mjs';
import { createOpr } from '../server/opr-service.mjs';
import { fakeLnd, fakeChain, keypair } from './server-helpers.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/candles-30d.json', import.meta.url)));
// #3718: pinned to opr-5, the version it was written on (copy 2 assumes the bot's last press runs to the end, as it does on opr-5's run;
// on opr-6 this day's last press ends before the flag, so moving its release is another input, not a copy)
const V = 'opr-5';

test('#3613 a copied log with presses after the run\'s end is flagged sameLog (the later runs; the earlier one counts it as copied, #3580)', async () => {
  const day = fx.days[fx.days.length - 1];
  let t = Date.parse('2026-11-22T10:00:00Z');
  const lnd = fakeLnd(), chain = fakeChain();
  const opr = createOpr({ now: () => t, sim: { GAME_VERSION: V, buildLevel: sim.buildLevel, runLog: sim.runLog }, fetchCandles: async () => day.candles,
    checkLevel, invoices: lnd, chain, log: () => {}, cfg: { showTest: true, entrySats: 100, adminSha: createHash('sha256').update('x').digest('hex') } });
  const made = opr.testRound({ minutes: 60, chartDay: day.day });
  assert.equal(made.ok, true, made.why);
  await opr.tick(); await opr.tick(); chain.confirm(); await opr.tick();
  const r = opr.roundRow(made.round.id);
  assert.equal(r.game_version, V);
  const L = sim.buildLevel(day.candles, checkLevel(day.candles, r.id, { version: V }).seed, V);
  const { log } = sim.recordLog(L, (w) => sim.botInput(w, { ...sim.BOT_CONFIGS[0] }));
  const want = sim.runLog(L, log), end = want.steps;
  const last = log.presses[log.presses.length - 1];
  const copies = [
    { v: log.v, presses: [...log.presses, [end + 3, end + 9], [end + 20, end + 31]] },                // two presses after the end
    { v: log.v, presses: [...log.presses.slice(0, -1), [last[0], Math.max(last[1], end) + 7]] },     // the last release moved past the end
  ];
  for (const c of copies) assert.equal(sim.runLog(L, c).total, want.total, 'the copy replays to the same score');
  const play = async (p, l) => { const s = await opr.startAttempt(p.pk, { round: r.id }); lnd.pay(s.invoice); const a = await opr.checkAttempt(p.pk, s.attempt);
    t += Math.ceil(end / 60) * 1000 + 2000; const x = opr.submit(p.pk, { attempt: s.attempt, token: a.token, log: l }); assert.equal(x.ok, true, x.why); return s.attempt; };
  const victim = keypair(), ids = [await play(victim, log)];
  for (const c of copies) ids.push(await play(keypair(), c));
  const flags = ids.map((id) => JSON.parse(opr.db.prepare('SELECT flags FROM attempts WHERE id = ?').get(id).flags));
  console.log('#3613 MEASURED sameLog (victim, copy+2 presses, copy last release moved):', JSON.stringify(flags.map((f) => !!f.sameLog)));
  assert.deepEqual(flags.map((f) => !!f.sameLog), [false, true, true]);   // #3580: an identical or near copy flags the later run only
  assert.equal(flags[0].copied, 2, 'the earlier run counts both copies');
});
