// kanban #1489 refute of #1472 (hexbox #005): a seed pasted as a JSON array, as quoted words, split by full stops, underscores or "+" still goes through.
// The tree's own second seed masker (log-level.js redact) already joins quotes, dots and brackets - the feedback scrub does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubKeys } from '../src/feedback-store.js';
import { redact } from '../src/log-level.js';

const W = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const forms = {
  jsonArray: JSON.stringify(W),
  quoted: W.map((w) => `"${w}"`).join(', '),
  sentences: W.join('. ') + '.',
  dotted: W.join('.'),
  underscores: W.join('_'),
  plus: W.join(' + '),
};
test('#1472 refute: a seed as JSON, quoted, or split by dots/underscores/plus is removed', () => {
  const left = [];
  for (const [name, v] of Object.entries(forms)) {
    const out = scrubKeys(`wallet export ${v} end`);
    if (W.filter((w) => out.toLowerCase().includes(w)).length >= 12) left.push(`${name}: ${out.slice(0, 70)}`);
  }
  // the sibling masker in the same tree takes the JSON array; the report scrub should be at least as strict
  assert.ok(!redact(`x ${forms.jsonArray}`).includes('abandon'), 'log-level redact masks the JSON array');
  assert.deepEqual(left, []);
});
