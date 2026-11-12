// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute (skeptic 2) of #1535 / a816b48a0. Variant: a neighbour, not a stranger. Behind one IPv4 (a cafe's Wi-Fi, a mobile
// carrier's CGNAT, a campus) every page is the same caller (ipKey), so a second device there posting two made-up rounds drops the real
// player's row from its callers and deletes it - and again each time the page re-posts (its reload/retry path). The real table is gone from
// GET /opponent, not just pushed down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opponentWant, opponentWants, ipKey } from '../src/faucet.js';

test('#1489 refute-42-s2-3: a device behind the same IPv4 deletes the real player\'s table', () => {
  const W = new Map(), shared = ipKey('100.64.7.9');   // one CGNAT address
  const real = 'ab'.repeat(32), j1 = '1'.repeat(64), j2 = '2'.repeat(64);
  let t = 1_000_000, gone = 0;
  for (let s = 0; s < 5; s++) {   // the page re-posts every second; the neighbour answers each time
    opponentWant(W, real, t, true, shared); t += 1;
    opponentWant(W, j1, t, true, shared); t += 1;
    opponentWant(W, j2, t, true, shared); t += 997;
    if (!opponentWants(W, t).some((w) => w.round === real)) gone++;
  }
  console.log('  MEASURED:', JSON.stringify({ listed: opponentWants(W, t).map((w) => w.round.slice(0, 4)), passesRealGone: gone }));
  assert.equal(gone, 0, `the real player's table stays listed: ${JSON.stringify(opponentWants(W, t).map((w) => w.round.slice(0, 4)))}`);
});
