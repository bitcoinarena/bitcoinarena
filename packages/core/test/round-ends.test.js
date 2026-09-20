// THE ROUND ENDS WHEN THE TIMER DOES (the owner 2026-09-20 16:21).
//
// "When the round timer hits 0, the game must end and return to the lobby by itself. It used to. It no longer
// does." This is the CORE half of that: whatever the client then chooses to draw, the core must stop calling the
// run live once the block's ticks are spent. `gate.js` returns RUN_MISSED as soon as `tickInBlock >= BLOCK_TICKS`
// and `sim.js` feeds it `S_ELAPSED`, which only counts while the run is live.
//
// The client half is pinned in Unity by SplashScreen's ShouldReturnToLobby, because a core word nobody acts on is
// how this broke: the hold clock asked "core OR client", the lobby gate asked only "client".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init, step } from '../src/sim.js';
import { O_SCORE, S_STATE, S_ELAPSED } from '../src/state.js';
import { BLOCK_TICKS, RUN_LIVE, RUN_MISSED } from '../src/rules/gate.js';

test('a run that never delivers is MISSED the moment the block is spent, not left live (§round timer)', () => {
  const st = init(1), s = st.i32;
  let endedAt = -1;
  // Brake held from the first tick: this truck never reaches the gate and never wrecks, so the ONLY thing that
  // can end it is the timer. If the core leaves it live the round sits in the world for ever, which is the fault.
  for (let t = 0; t < BLOCK_TICKS + 600; t++) {
    step(st, 0, 0, 65536, 0, 0);
    if (s[O_SCORE + S_STATE] !== RUN_LIVE) { endedAt = t; break; }
  }
  assert.notEqual(endedAt, -1, `the run was still LIVE ${BLOCK_TICKS + 600} ticks in - the timer never ended it`);
  assert.equal(s[O_SCORE + S_STATE], RUN_MISSED,
    'a truck that never arrived and was never wrecked has MISSED the block');
  assert.equal(s[O_SCORE + S_ELAPSED], BLOCK_TICKS,
    `the run ended on the block's own length, not early or late: elapsed ${s[O_SCORE + S_ELAPSED]} against ${BLOCK_TICKS}`);
});

test('the elapsed clock stops once the run is over, so a finished round cannot creep past the block (§round timer)', () => {
  const st = init(2), s = st.i32;
  for (let t = 0; t < BLOCK_TICKS + 1; t++) step(st, 0, 0, 65536, 0, 0);
  const atEnd = s[O_SCORE + S_ELAPSED];
  for (let t = 0; t < 300; t++) step(st, 0, 0, 65536, 0, 0);
  assert.equal(s[O_SCORE + S_ELAPSED], atEnd,
    'S_ELAPSED kept counting after the run ended - the outcome would be re-decided every tick');
  assert.equal(s[O_SCORE + S_STATE], RUN_MISSED, 'and the outcome stays MISSED once named');
});
