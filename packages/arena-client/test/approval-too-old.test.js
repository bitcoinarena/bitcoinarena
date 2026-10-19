// kanban #349 scope 3: "The page shows 'node X: protocol too old' in the approval facts (#317)"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalWords } from '../src/lobby.js';

test('the approval facts name each node left out for its protocol version, with what it speaks', () => {
  const f = { pending: false, operators: ['aa'.repeat(32)], both: 5, of: 7, operatorsPlaying: [], censusKnown: true };
  const words = approvalWords(f, [{ node: 'ab'.repeat(32), speaks: [1] }, { node: 'cd'.repeat(32), speaks: [] }]);
  console.log('  WORDS:', words);
  assert.match(words, /left out, protocol too old: abababab \(speaks 1\), cdcdcdcd \(speaks none\)$/);
  assert.doesNotMatch(approvalWords(f, []), /too old/);
  assert.match(approvalWords({ pending: true }, [{ node: 'ef'.repeat(32), speaks: [1] }]), /pending \(§5A\.5\) · left out, protocol too old: efefefef/);
});
