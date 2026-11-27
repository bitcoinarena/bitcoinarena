// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3328 the promotion's end (owner 2026-11-22: one week from the first daily round 2026-11-23 - the last daily round 2026-11-29, the end
// 2026-11-30 00:00Z): the public round names it, no daily round is made after it, no "no daily round" alert after it; unset: as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { world, at, DAY } from './server-helpers.mjs';

const END = '2026-11-30T00:00:00Z';

test('#3328 the public round names the promotion end; unset it is null', async () => {
  const w = world({ start: '2026-11-23T01:00:00Z', cfg: { promoEnd: END } });
  await w.opr.tick();
  const r = w.opr.publicRound(w.opr.currentRound());
  assert.deepEqual(r.promo, { firstDay: '2026-11-23', endMs: at(END) });
  const v = world({ start: '2026-11-23T01:00:00Z' });
  await v.opr.tick();
  assert.equal(v.opr.publicRound(v.opr.currentRound()).promo, null);
});

test('#3328 the daily rounds run 23 to 29 Nov and none is made on 30 Nov or later, nor alerted', async () => {
  const w = world({ start: '2026-11-29T00:05:00Z', cfg: { promoEnd: END, alertAfterMs: 15 * 60000 } });
  await w.opr.tick();
  assert.ok(w.opr.roundRow('2026-11-29'), 'the last daily round is made');
  for (const t of ['2026-11-30T00:00:00Z', '2026-11-30T00:30:00Z', '2026-12-01T03:00:00Z']) { w.clock.set(at(t)); await w.opr.tick(); }
  assert.equal(w.opr.roundRow('2026-11-30'), undefined);
  assert.equal(w.opr.roundRow('2026-12-01'), undefined);
  assert.equal(w.alerts.some((a) => /no daily round/.test(a)), false, w.alerts.join('\n'));
});

test('#3328 a date-only end works too, a bad one is refused at start, and a test round after the end is allowed again', async () => {
  const w = world({ start: '2026-11-30T02:00:00Z', cfg: { promoEnd: '2026-11-30' } });
  await w.opr.tick();
  assert.equal(w.opr.roundRow('2026-11-30'), undefined);
  const t = w.opr.testRound({ minutes: 30, chartDay: '2026-11-28' });
  assert.equal(t.ok, true, t.why);
  assert.throws(() => world({ cfg: { promoEnd: 'next week' } }), /promoEnd/);
  const before = world({ start: '2026-11-25T02:00:00Z', cfg: { promoEnd: END } });
  await before.opr.tick();
  assert.equal(before.opr.testRound({ startMs: at('2026-11-25T02:00:00Z') + DAY, minutes: 30, chartDay: '2026-11-24' }).ok, false);
});
