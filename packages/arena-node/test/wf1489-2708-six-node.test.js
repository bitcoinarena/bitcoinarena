// kanban #2708 follow-up: a committee size receiptsNeeded does not know (6 nodes are live, feedback #019) must not throw in the
// h2h verdict path - on audit90 it crashed every seat at start (2026-11-14 12:15Z, verify.js "no committee threshold for 6 slots").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';

test('receiptsNeeded still throws for 6 slots, so the verdict path must guard it', () => {
  assert.throws(() => receiptsNeeded(6), /no committee threshold for 6 slots/);
});
test('the #2708 quorum line in verify.js never calls receiptsNeeded unguarded', () => {
  const src = readFileSync(new URL('../src/verify.js', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.includes('receiptsNeeded(Math.max(1, (contract.nodes'));
  assert.ok(line, 'the quorum line is there');
  assert.match(line, /try \{ need = receiptsNeeded/, 'wrapped in try');
});
