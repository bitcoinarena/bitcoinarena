// kanban #1489 round 4 (hosting): a core tree's hash (core-hash.js, the rule arena-sdk/core-hash gives every app) is the
// Round Contract's sim hash - what pins the code that decides a paying round. It hashes `rel \0 bytes \0` per file with
// nothing that says where one file's bytes end: a NUL is legal inside a JS comment or string, so one file whose bytes carry
// "\0b.js\0..." hashes the same as that file cut there plus a second file b.js. Two different trees, two different programs,
// one sim hash: the tree a reviewer or a reproducible build checks is not the only tree that hash admits.
// Safe behaviour: two different trees never hash the same (each file's length, or another unambiguous framing, is hashed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coreTree } from '../src/core-hash.js';

test('a one-file tree and a two-file tree with different code have different hashes', () => {
  const one = mkdtempSync(join(tmpdir(), 'wf1489-r4-hosting-4a-'));
  const two = mkdtempSync(join(tmpdir(), 'wf1489-r4-hosting-4b-'));
  // tree A: a.js alone; the second file's text sits after a line comment, so it is never run
  writeFileSync(join(one, 'a.js'), 'export const CORE = { honest: true }; //\0b.js\0 export const CORE2 = 1;');
  // tree B: a.js cut at the NUL, and b.js
  writeFileSync(join(two, 'a.js'), 'export const CORE = { honest: true }; //');
  writeFileSync(join(two, 'b.js'), ' export const CORE2 = 1;');
  const a = coreTree(one), b = coreTree(two);
  assert.notDeepEqual([...a.files.keys()], [...b.files.keys()], 'the trees differ');
  assert.notEqual(a.hash, b.hash, `two different trees hash to the same sim hash ${a.hash.slice(0, 16)}`);
});
