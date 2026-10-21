// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SMALL PARTS OF THE ARENA PAGE IN REACT (kanban #564): the refund key's line with its seed folded away, and the way back to the Arena.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RefundKey, BackToArena } from '../dist/test/bits.mjs';

test('the refund key line: fingerprint, where the seed came from, how to check it, the seed folded away', () => {
  const made = renderToStaticMarkup(React.createElement(RefundKey, { fingerprint: 'ab12cd34', imported: false, roundIdHex: 'ee'.repeat(32), seedHex: '11'.repeat(32) }));
  assert.equal(made, 'refund key fingerprint ab12cd34 (from a seed this page made: back it up, or restore your own in Settings) - check it: refund-key.mjs &lt;your seed&gt; ' + 'ee'.repeat(32)
    + '<details><summary>seed backup</summary><code>' + '11'.repeat(32) + '</code></details>');
  assert.match(renderToStaticMarkup(React.createElement(RefundKey, { fingerprint: 'x', imported: true, roundIdHex: 'r', seedHex: 's' })), /\(from the seed you imported\)/);
});

test('the way back says Arena and hands the press to the page', () => {
  let back = 0;
  assert.equal(renderToStaticMarkup(React.createElement(BackToArena, { onBack() {} })), '<button type="button" class="game">← Arena</button>');
  new BackToArena({ onBack: () => back++ }).render().props.onClick();
  assert.equal(back, 1);
});
