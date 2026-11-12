// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// wf1489 bypass of #1472: common seed spellings the new scrubber still keeps (JSON array, wallet grid copy "1\nword", "1 word", "word. word")
// 2.0 (kanban #1489, ported from 1.9 52ec0fa179): scrubKeys lives in src/faucet.js; 2.0 has no feedback store, so only the scrubber and the chat post are checked
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubKeys, feedbackDecide } from '../src/faucet.js';
const W = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
test('wf1489-1 a seed copied as a JSON array, from a numbered grid, numbered without a dot or period-separated is removed', () => {
  const forms = { json: JSON.stringify(W), grid: W.map((w, i) => `${i + 1}\n${w}`).join('\n'), numSpace: W.map((w, i) => `${i + 1} ${w}`).join(' '), dots: W.join('. ') };
  for (const [name, v] of Object.entries(forms)) {
    assert.ok(!scrubKeys(`my seed: ${v} lost`).includes('abstract absurd') && !/absorb\W+abstract\W+absurd/.test(scrubKeys(`my seed: ${v} lost`)), `scrubKeys kept the ${name} seed: ${scrubKeys(v).slice(0, 80)}`);
    const d = feedbackDecide({ text: `my seed: ${v} lost` }, []);
    assert.ok(!/absorb\W+abstract\W+absurd/.test(d.text), `the chat post kept the ${name} seed`);
  }
});
