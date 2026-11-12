// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute (skeptic 2) of #1535 / a816b48a0. Variant: the 64-row cap from IPv4. opponentNet counts an IPv4 address as its own
// network, so 32 addresses (32 Tor exits, a rented /27) at 2 rows each fill OPPONENT_WANTS_MOST; no network holds more than one caller's share,
// opponentEvict makes no room, and a real page's POST /opponent is refused 'too many tables just now'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opponentWant, opponentWants, ipKey } from '../src/faucet.js';

test('#1489 refute-42-s2-2: 32 IPv4 addresses fill the table list and the real table is refused', () => {
  const W = new Map(), now = 1_000_000;
  for (let c = 0; c < 32; c++) for (let j = 0; j < 2; j++) opponentWant(W, (c * 2 + j + 1).toString(16).padStart(64, '0'), now, true, ipKey(`203.0.113.${c + 1}`));
  const real = 'ab'.repeat(32);
  const got = opponentWant(W, real, now + 10, true, ipKey('198.51.100.20'));
  const listed = opponentWants(W, now + 20).map((w) => w.round);
  console.log('  MEASURED:', JSON.stringify({ rows: W.size, realPost: got, realListed: listed.includes(real) }));
  assert.ok(got.ok && listed.includes(real), `the real player's table is listed: ${JSON.stringify({ rows: W.size, realPost: got })}`);
});
