// kanban #3338 (feedback #388): the emergency grid's wait per rank was min(rank, rankCap) x 20 min, so every node ranked 3 or lower in
// the day's duty order was due in the same minute - on 2026-11-22 the nodes ranked 7, 20 and 30 posted three nextblock emergency
// grids in one block (162694), past DUTY_EMERGENCY_MAX. Past the cap each rank takes its own step, as the day's own posting does (#788).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as guard from '../src/duty-guard.js';

test('#3338 every rank waits its own time for an emergency grid, none past the cap shares a minute', () => {
  const cap = guard.DUTY_DAY_RANK_CAP;
  const min = (r) => guard.emergencyWaitMs(r, cap) / 60000;
  // inside the cap: the duty node at once, the next ranks 20 min apart (as before)
  assert.deepEqual([0, 1, 2].map(min), [0, 20, 40]);
  // past it: one step each, so the first that posts is in the mempool before the next is due
  const ranks = [3, 4, 6, 7, 20, 30, 60];
  const waits = ranks.map(min);
  assert.equal(new Set(waits).size, ranks.length, `waits ${waits}`);
  for (let i = 1; i < waits.length; i++) assert.ok(waits[i] - waits[i - 1] >= guard.DUTY_PAST_CAP_STEP_MS / 60000, `rank ${ranks[i]}`);
  assert.equal(min(3), 40 + guard.DUTY_PAST_CAP_STEP_MS / 60000);
  assert.equal(min(-1), 0);
});
