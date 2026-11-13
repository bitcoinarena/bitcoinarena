// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2202 (#1598 refute d s3-1, the #2126 reveal cap leaks the move to a fast-lying seat).
// Adapted to 1.9 by #2536: the card's test drove the 2.0 line's revealMove, which timed the reveal by the seats' GET /time (#2006 / #2124 /
// #2126); 1.9's revealMove posts at once and has no such cap. 1.9 answers #1598 with protocol 28's certified lock set (kanban #2561, ruling
// #2116 (b)): the page reveals with revealWhenCertified, only once a threshold certificate of the locked entries stands, and only those
// entries play. The same attack on that rule (_h2h-p28-leak.mjs): the partner seat lies on /time and its round clock runs ahead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leakRun } from './_h2h-p28-leak.mjs';

test('#2202 (1.9, protocol 28) two seats, the partner fast like the browser, the page started at the lead before the round end (12 s before the real close): no move goes out before the close', { timeout: 170000 }, async () => {
  const f = await leakRun({ n: 2, keyBase: 0xc0, partnerTime: (close, now) => now + 30000, partnerSkewMs: 0, pageSkewMs: 30000, pageStartAt: (close) => close - 12000 });
  console.log('  FACTS (#2202):', JSON.stringify(f));
  assert.ok(f.sent.every((x) => x.at >= 0), `the page sent its move before the seats' close: ${JSON.stringify(f.sent)}`);
  const honestSeats = f.results.attacker.slice(0, -1);
  assert.ok(honestSeats.every((x) => !x.includes('DELIVERED')), `a stake lock chosen from the honest move won at an honest seat: ${JSON.stringify(f)}`);
  assert.ok(f.results.honest.slice(0, -1).every((x) => !x.includes('FAILED')), `the honest player lost at an honest seat: ${JSON.stringify(f.results)}`);
});
