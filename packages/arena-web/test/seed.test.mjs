// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SEED PHRASE IN REACT (kanban #564): the 24 words numbered, why they matter, Verify; the quiz one word at a time out of four from
// the phrase, a wrong tap not advancing, the backup recorded by the page's rule after the last word, then done; no wallet yet says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SeedModal } from '../dist/test/seed.mjs';

const WORDS = Array.from({ length: 24 }, (_, i) => `w${String(i + 1).padStart(2, '0')}`);
let seq = 0; const random = (n) => (seq++ * 7) % n;

test('the words, numbered, with why; no wallet says so without Verify', () => {
  const h = renderToStaticMarkup(React.createElement(SeedModal, { words: WORDS, random, onRecord: () => ({ ok: true }), onClose() {} }));
  assert.match(h, /<h3>Your seed phrase<\/h3><div class="seed-why"><b>These 24 words are your wallet\.<\/b>/);
  assert.match(h, /<div class="seed-cell"><span class="n">1<\/span><span>w01<\/span><\/div>/);
  assert.equal((h.match(/class="seed-cell"/g) || []).length, 24);
  assert.match(h, />Verify seed phrase<\/button><button type="button">Close<\/button>/);
  const none = renderToStaticMarkup(React.createElement(SeedModal, { words: [], notReady: 'no wallet yet', random, onRecord() {}, onClose() {} }));
  assert.match(none, /<div class="seed-grid">no wallet yet<\/div>/); assert.doesNotMatch(none, /Verify seed phrase/);
});

test('the check: three of the 24 words, four choices each, a wrong tap stays, three right taps record the backup, then done (kanban #1033)', () => {
  const quiz = [], recorded = [];
  const m = new SeedModal({ words: WORDS, random, onRecord: (w) => { recorded.push(w.length); return { ok: true }; }, onQuiz: (q) => quiz.push(q), onClose() {} });
  m.setState = (u) => Object.assign(m.state, typeof u === 'function' ? u(m.state) : u);
  m.start();
  const picks = [...m.state.picks];
  assert.equal(picks.length, 3); assert.equal(new Set(picks).size, 3); assert.deepEqual(picks, [...picks].sort((a, b) => a - b));
  assert.equal(m.state.pane, 'verify'); assert.equal(m.state.options.length, 4); assert.ok(m.state.options.includes(WORDS[picks[0]]));
  assert.deepEqual([quiz[0].word, quiz[0].right], [picks[0] + 1, WORDS[picks[0]]]);
  m.pick(m.state.options.find((w) => w !== WORDS[picks[0]]));
  assert.deepEqual([m.state.step, m.state.why], [0, `Not word ${picks[0] + 1}. Try again.`]);
  assert.match(renderToStaticMarkup(React.createElement(React.Fragment, null, m.render())), /\(1 of 3 to check\)/);
  for (const at of picks) m.pick(WORDS[at]);
  assert.deepEqual([m.state.pane, recorded, quiz.at(-1)], ['done', [24], { done: true }]);
  assert.match(renderToStaticMarkup(React.createElement(React.Fragment, null, m.render())), /Seed phrase verified/);
});
