// kanban #745 (measured on testnet4 seat 7, 2026-10-28): right after a start every round that closed asked for its census
// view while that view's read was still in flight; chainFor answered undefined, the roster said "no chain view for that
// round", and the game and settlement peer lookups logged one line per round - 408 in the minutes after the 07:02Z restart,
// 104 in the 30 min after the 06:10Z one - although each view arrived seconds later. A view not read yet is asked again at the
// next pass and is not a fault; a read that fails is said once a minute by main.js ("[chain] view ... did not read").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NO_CHAIN_VIEW_WHY } from '../src/roster.js';

const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('the peer lookups do not report a view that is not read yet', () => {
  const NOT_YET = new RegExp(server.match(/const VIEW_NOT_YET = \/(.+)\/;/)[1]);
  assert.ok(NOT_YET.test(NO_CHAIN_VIEW_WHY));
  assert.ok(NOT_YET.test('this node is still reading its chain view for that round'));
  assert.match(server, /if \(!VIEW_NOT_YET\.test\(picked\.why \|\| ''\)\) console\.error\(`\[verify\]/);
  assert.match(server, /if \(!VIEW_NOT_YET\.test\(picked\.why \|\| ''\)\)\s*console\.error\(`\[custody\]/);
});

test('a failed view read is still said, once a minute, by main.js', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /if \(!failed \|\| failed\.why !== why\) console\.error\(`\[chain\] view \$\{key\} did not read: \$\{why\}`\)/);
  assert.match(main, /if \(failed && Date\.now\(\) - failed\.atMs < 60000\) return undefined;/);
});
