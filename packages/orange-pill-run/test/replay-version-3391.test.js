// kanban #3391 (owner playtest 2026-11-23): the board's replay button said "wrong game version" for every opr-3 run once the
// page knew opr-4 - the client checked the log against its newest version, not the round's. The client must pass L.version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateLog } from '../src/sim/replay.js';
import { GAME_VERSION } from '../src/sim/constants.js';

test('#3391 an opr-3 log is valid against opr-3 and refused only against another version', () => {
  const log = { v: 'opr-3', presses: [[10, 20]] };
  assert.equal(validateLog(log, 'opr-3'), null);
  if (GAME_VERSION !== 'opr-3') assert.equal(validateLog(log), 'wrong game version');   // the old call without the round's version
});

test('#3391 the client replays a board log on the level version, not the page version', () => {
  const src = readFileSync(new URL('../client/src/main.js', import.meta.url), 'utf8');
  for (const m of src.matchAll(/validateLog\(([^)]*)\)/g)) if (!/^\s*$/.test(m[1])) assert.match(m[1], /,/, 'validateLog called without a version: ' + m[0]);
});
