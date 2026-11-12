// kanban #1489 refute of #1472 (hexbox #005): a seed written with the 4-letter BIP39 prefixes (the form steel backups and many wallets use; each
// prefix names exactly one word, so the seed is whole) or split by zero-width spaces is not removed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubKeys } from '../src/feedback-store.js';

const W = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
test('#1472 refute: a 4-letter-prefix seed and a zero-width-split seed are removed', () => {
  const four = W.map((w) => w.slice(0, 4)).join(' ');
  const zw = W.join('​');
  assert.equal(scrubKeys(`my seed: ${four} - lost`), 'my seed: [removed] - lost');
  assert.equal(scrubKeys(`my seed: ${zw} - lost`), 'my seed: [removed] - lost');
});
