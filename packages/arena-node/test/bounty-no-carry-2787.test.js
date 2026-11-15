// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2787 (the owner 2026-11-15: "wenn der Pot voll ist, ist er voll"): once a season's pot is used up there is no bounty at all - nothing carries
// over to the next season, Season 2 included. The faucet answers noBounty and never records such a report as waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openBountySeason, SEASON_MS, NO_CARRY_FROM_SEASON } from '../src/bounty-season.js';

const K = (n) => String(n).repeat(64).slice(0, 64);
const rep = (n, pubkey = K(1)) => ({ id: String(n).padStart(64, '0'), pubkey });

test('#2787 past a season\'s pot (Season 2 and later): no bounty, not waiting', () => {
  assert.equal(NO_CARRY_FROM_SEASON, 2);
  const s = openBountySeason(':memory:', { startMs: 0, potSats: 3000 });
  let n = 0;
  // Season 2: 25 % without a human proof, so a critical is 2,500; the second one does not fit: no bounty, not waiting
  const a = rep(++n); const pa = s.plan(a, { level: 'critical', nowMs: 10 }); assert.equal(pa.fits, true); s.commit(a, pa, { nowMs: 10 });
  const b = rep(++n); const pb = s.plan(b, { level: 'critical', nowMs: 11 });
  assert.equal(pb.season, 2); assert.equal(pb.waits, false); assert.equal(pb.noBounty, true);
  assert.match(pb.why, /^Season 2's pot is used up \(500 sat left, this report is 2500\): no bounty$/);
  // Season 3: past the pot no bounty, no waiting
  const t3 = SEASON_MS + 10;
  const c = rep(++n); const pc = s.plan(c, { level: 'critical', nowMs: t3 }); assert.equal(pc.season, 3); assert.equal(pc.fits, true); s.commit(c, pc, { nowMs: t3 });
  const d = rep(++n); const pd = s.plan(d, { level: 'critical', nowMs: t3 + 1 });
  assert.equal(pd.ok, true); assert.equal(pd.fits, false); assert.equal(pd.waits, false); assert.equal(pd.noBounty, true);
  assert.match(pd.why, /^Season 3's pot is used up \(500 sat left, this report is 2500\): no bounty$/);
  // one that still fits is approved as before
  const e = rep(++n); const pe = s.plan(e, { level: 'low', nowMs: t3 + 2 }); assert.equal(pe.fits, true);
  // Season 4 too
  const f = rep(++n); s.commit(f, s.plan(f, { level: 'critical', nowMs: 2 * SEASON_MS + 1 }), { nowMs: 2 * SEASON_MS + 1 });
  assert.equal(s.plan(rep(++n), { level: 'critical', nowMs: 2 * SEASON_MS + 2 }).noBounty, true);
});

test('#2787 faucet: a no-bounty plan is answered noBounty and noted on the report, never kept waiting', () => {
  const src = readFileSync(new URL('../tools/faucet.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(p\.noBounty\) \{ FEEDBACK\.remark\(r\.id, p\.why, \{ by \}\); return send\(200, \{ ok: false, noBounty: true/);
  assert.match(src, /if \(p\.waits \|\| p\.noBounty\) \{ if \(p\.waits && p\.season !== a\.season\) S2\.wait\(/);
  assert.match(src, /usedUp: p\.season >= NO_CARRY_FROM_SEASON && p\.leftSats < Math\.floor\(LEVEL_SATS\.useful \/ 4\), nextSeasonMs: seasonEndMs\(p\.season, S2_START_MS\)/);
});
