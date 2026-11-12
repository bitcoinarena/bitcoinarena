// kanban #1489 refute of #1472 (hexbox #005): a seed numbered WITHOUT punctuation ("1 abandon"), as a tab table, "(1)", "#1" or "1-" still goes through,
// both in the store's scrubKeys and in the faucet's chat post (feedbackDecide)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubKeys } from '../src/feedback-store.js';
import { feedbackDecide } from '../src/faucet.js';

const W = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const forms = {
  plainNumbers: W.map((w, i) => `${i + 1} ${w}`).join(' '),
  tabTable: W.map((w, i) => `${i + 1}\t${w}`).join('\n'),
  parenNumbers: W.map((w, i) => `(${i + 1}) ${w}`).join(' '),
  hashNumbers: W.map((w, i) => `#${i + 1} ${w}`).join(' '),
  dashNumbers: W.map((w, i) => `${i + 1}- ${w}`).join(' '),
};
test('#1472 refute: a numbered seed in common wallet layouts is removed', () => {
  const left = [];
  for (const [name, v] of Object.entries(forms)) {
    const out = scrubKeys(`my seed: ${v} - lost`);
    if (W.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(out)).length >= 12) left.push(`store ${name}: ${JSON.stringify(out).slice(0, 80)}`);
    const d = feedbackDecide({ text: `my seed: ${v} - lost`, ip: '1.2.3.4', nowMs: 1 }, []);
    const said = JSON.stringify(d);
    if (W.filter((w) => new RegExp(`\\b${w}\\b`, 'i').test(said)).length >= 12) left.push(`faucet ${name}`);
  }
  assert.deepEqual(left, []);
});
