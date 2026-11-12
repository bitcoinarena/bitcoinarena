// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2564 (feedback #019, measured 2026-11-12 on the RPS table a46fcbb3 of federation 337ae01a): every seat draws the table 965da6c8, ef11d099, d5faf294,
// 32efc70d, 58bc28e8, c6d5d34b today, but the check-in seatings it held were signed in other orders (264: 58bc c6d5 ef11 32ef d5fa 965d; 297: c6d5 58bc 32ef
// 965d d5fa) - verifySeating "not in score order" - and still seated every later round. A held check-in seating is now checked against the seat's draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seatedInDrawOrder } from '../src/seating-agent.js';

const k = (p) => p.padEnd(64, '0');
const draw = ['965da6c8', 'ef11d099', 'd5faf294', '32efc70d', '58bc28e8', 'c6d5d34b'].map(k);

test('#2564 the measured seatings against the draw every seat holds today', () => {
  assert.equal(seatedInDrawOrder(draw, draw), true, 'the table\'s first seating (index 0) stands');
  assert.equal(seatedInDrawOrder(['58bc28e8', 'c6d5d34b', 'ef11d099', '32efc70d', 'd5faf294', '965da6c8'].map(k), draw), false, 'check-in 264 does not');
  assert.equal(seatedInDrawOrder(['c6d5d34b', '58bc28e8', '32efc70d', '965da6c8', 'd5faf294'].map(k), draw), false, 'check-in 297 does not');
  assert.equal(seatedInDrawOrder(['965da6c8', 'd5faf294', '32efc70d', '58bc28e8', 'c6d5d34b'].map(k), draw), true, 'the same five in draw order would');
  assert.equal(seatedInDrawOrder(['965da6c8', 'aa000001'].map(k), draw), false, 'a node outside the draw does not');
});

test('#2564 the agent skips a stale check-in seating where a round is seated, and keeps it for a round with entries', () => {
  const src = readFileSync(new URL('../src/seating-agent.js', import.meta.url), 'utf8');
  assert.ok(src.includes('(keepStale || !staleReseats.has(`${toHex(later[i].rid)}:${role}`))'), 'tableSeatingAt skips a stale one');
  assert.ok(src.includes('later[i].index <= index && !staleReseats.has(`${toHex(later[i].rid)}:${role}`)) return later[i].rid;'), 'seatRoundOf skips it too');
  assert.ok(src.includes('return tableSeatingAt(a, role, index, { keepStale: withEntries });'), 'a round with entries keeps its seats');
  assert.ok(src.includes('const stands = isCheckIn && seatedInDrawOrder(x.seated, drawn);') && src.includes('isCheckIn = checkInOf(c, tableAnchorOf(c));'), 'a seating at a round that is no check-in by today\'s rule is not used either (round 283 of a46fcbb3)');
  assert.ok(src.includes("if (process.env.ARENA_CHECKIN_DRAW_CHECK === '1') { try { checkReseats(); }"), 'the check runs only when switched on (it would move every table back while check-ins are drawn wrong)');
  assert.ok(/RESEAT_CHECK_MS = 60000, RESEAT_DRAWS = 8;/.test(src) && src.includes('let drawn = tableDraws.get(key);'), 'one draw per table, kept; at most 8 new draws a pass (fed2-1 held 46,728 seatings)');
});
