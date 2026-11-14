// feedback #064/#065/#068 (2026-11-14): the per-seat games cap (kanban #2558) was 32 while every live seat listed 41 versions, so the page
// never read RPS v6-v10 / the newest Up or Down and refused their clients ("not named by the manifest"). The cap must hold the live list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAMES_PER_SEAT } from '../src/games.js';

test('the per-seat games cap holds every version a live seat lists (41 on 2026-11-14) with room to grow', () => {
  assert.ok(GAMES_PER_SEAT >= 41 * 4, `GAMES_PER_SEAT ${GAMES_PER_SEAT}`);
  assert.ok(GAMES_PER_SEAT <= 1000, 'still bounded against a flood (#2558)');
});
