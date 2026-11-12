// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute of #1535 (variant: the 64-row cap). 32 /64s (one /59 of IPv6) at 2 rows each fill OPPONENT_WANTS_MOST, and a real page's
// POST /opponent is then refused 'too many tables just now': its table is never listed at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opponentWant, opponentWants, ipKey } from '../src/faucet.js';

test('#1489 refute-42-s1-2: 32 IPv6 /64s fill the table list and the real table is refused', () => {
  const W = new Map(), now = 1_000_000;
  for (let c = 0; c < 32; c++) for (let j = 0; j < 2; j++) {
    const round = (c * 2 + j + 1).toString(16).padStart(64, '0');
    opponentWant(W, round, now, true, ipKey(`2001:db8:66:${c.toString(16)}::1`));
  }
  const real = 'ab'.repeat(32);
  const got = opponentWant(W, real, now + 10, true, ipKey('198.51.100.20'));
  const listed = opponentWants(W, now + 20).map((w) => w.round);
  console.log('  MEASURED:', JSON.stringify({ rows: W.size, realPost: got, realListed: listed.includes(real) }));
  assert.ok(got.ok && listed.slice(0, 4).includes(real), 'the real player\'s table is listed and read');
});
