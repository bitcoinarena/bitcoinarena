// kanban #1489 refute of #1529: the page runs dist/arena-client.js, not src. The fix must be in the bundle the page loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the page bundle carries the #1529 agreedChain fix', () => {
  const src = readFileSync(new URL('../dist/arena-client.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function agreedChain(');
  assert.ok(start >= 0);
  const body = src.slice(start, src.indexOf('\nfunction headerSources', start));
  assert.match(body, /forked\.push/, 'dist agreedChain still refuses the whole read on one forking source (no `forked` set)');
  assert.doesNotMatch(body, /agreed: good\.length,/);
});
