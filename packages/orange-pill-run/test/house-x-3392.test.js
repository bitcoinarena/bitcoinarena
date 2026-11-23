// kanban #3392 (owner 2026-11-23): "@bitcoinarena_io ... das darf nicht sein, das ist ja unser Account" - the game refuses our own X account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('#3392 saveX refuses the house X handle before any lookup, and xOf never places it', () => {
  const src = readFileSync(new URL('../server/opr-service.mjs', import.meta.url), 'utf8');
  assert.match(src, /OPR_HOUSE_X \|\| 'bitcoinarena_io'/);
  const save = src.slice(src.indexOf('async function saveX'), src.indexOf('async function saveX') + 3000);
  assert.ok(save.indexOf('houseX()') > 0 && save.indexOf('houseX()') < save.indexOf('xLookup(name)'), 'house check before the X lookup');
  const xof = src.slice(src.indexOf('function xOf'), src.indexOf('function xOf') + 1500);
  assert.match(xof, /houseX\(\)\.has/);
});
