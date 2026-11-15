// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2784 pot (the owner 2026-11-15): the Season 2 pot counted each approval's stored amount - the old 50 % for code-only - after those reports
// were paid at 25 %: 11,750 used where 4,875 was paid and 1,000 is still payable. The pot now counts what was paid for an approval, else what it
// pays now under the current rule (never above its stored amount).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openBountySeason } from '../src/bounty-season.js';
import { openFeedbackStore } from '../src/feedback-store.js';

const K = (n) => String(n).repeat(64).slice(0, 64);
const rep = (n) => ({ id: String(n).padStart(64, '0'), pubkey: K(1) });
// an approval as Season 2 stored it before #2784: code-only at half the level
const OLD_HALF = { useful: 250, low: 500, medium: 1000, high: 2500 };
const old = (level) => ({ season: 2, level, codeOnly: true, followUp: false, baseSats: OLD_HALF[level], bonusPct: 0, sats: OLD_HALF[level], flags: {} });

test('#2784 the pot: paid amounts plus the current rule, not the stored 50 % approvals (the live Season 2 rows: 5,875 used, 94,125 left)', () => {
  // the 13 approved Season 2 reports of 2026-11-15: ten paid at 25 %, three not paid
  const paidRows = ['useful', 'low', 'useful', 'low', 'medium', 'useful', 'medium', 'high', 'medium', 'high'];
  const unpaid = ['low', 'low', 'medium'];
  const paid = new Map();
  const s = openBountySeason(':memory:', { startMs: 0, paidOf: (id) => (paid.has(id) ? paid.get(id) : null) });
  let n = 0;
  for (const lv of paidRows) { const r = rep(++n); s.commit(r, old(lv), { nowMs: 10 }); paid.set(r.id, OLD_HALF[lv] / 2); }
  for (const lv of unpaid) s.commit(rep(++n), old(lv), { nowMs: 10 });
  const p = s.pot(2);
  assert.equal(p.usedSats, 5475, 'paid 4,875 (at 25 %) + payable 600 (15 %, the owner 2026-11-15)');
  assert.equal(p.leftSats, 94525);
  // without the payment record the current rule alone gives the same here, and a full approval still counts in full
  const s2 = openBountySeason(':memory:', { startMs: 0 });
  s2.commit(rep(1), old('high'), { nowMs: 10 });
  s2.commit(rep(2), { season: 2, level: 'high', codeOnly: false, followUp: false, baseSats: 5000, bonusPct: 20, sats: 6000, flags: { x: true } }, { nowMs: 10 });
  assert.equal(s2.pot(2).usedSats, 750 + 6000);
});

test('#2784 the report store says what was paid, and the faucet hands it to the pot', async () => {
  const f = openFeedbackStore();
  assert.equal(f.paidSatsOf('nope'), null);
  const src = readFileSync(new URL('../tools/faucet.mjs', import.meta.url), 'utf8');
  assert.match(src, /paidOf: \(id\) => FEEDBACK\.paidSatsOf\(id\)/);
});

test('#2784 a pot per season (Season 2 120,000) and the draw prize as its own figure', async () => {
  const s = openBountySeason(':memory:', { startMs: 0, pots: { 2: 120000 }, drawPrizes: { 2: 50000 } });
  const p2 = s.pot(2); assert.deepEqual([p2.potSats, p2.leftSats, p2.drawPrizeSats], [120000, 120000, 50000]);
  const p3 = s.pot(3); assert.deepEqual([p3.potSats, p3.drawPrizeSats], [100000, null], 'Season 3 unchanged');
  const src = readFileSync(new URL('../tools/faucet.mjs', import.meta.url), 'utf8');
  assert.match(src, /pots: seasonFigures\(env\.FAUCET_BOUNTY_POTS\), drawPrizes: seasonFigures\(env\.FAUCET_BOUNTY_DRAW_PRIZES\)/);
  assert.match(src, /drawPrizeSats: p\.drawPrizeSats/);
});
