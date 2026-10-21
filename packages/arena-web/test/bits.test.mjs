// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SMALL PARTS OF THE ARENA PAGE IN REACT (kanban #564): the refund key's line with its seed folded away, and the way back to the Arena.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RefundKey, BackToArena, Text, FedChip, BackupBox } from '../dist/test/bits.mjs';

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

test('the page\'s lines of words, its history chip and a popup\'s backup warning, in React (kanban #564)', () => {
  const r = (c, p) => renderToStaticMarkup(React.createElement(c, p));
  assert.equal(r(Text, { text: '1,234 sat' }), '1,234 sat');
  assert.equal(r(Text, { text: null }), '');
  assert.equal(r(Text, { text: 'a <b>' }), 'a &lt;b&gt;');
  const fed = 'ab'.repeat(32);
  assert.equal(r(FedChip, { fed, level: 'ok', label: 'healthy' }), `<span class="fed-chip ok" title="${fed} · healthy - tap to copy">Federation abababab…abab</span>`);
  assert.equal(r(FedChip, { say: 'No federation named by this lobby' }), 'No federation named by this lobby');
  assert.equal(r(BackupBox, { line: 'This wallet has no backup' }), '<span>This wallet has no backup</span><button type="button">Back up now</button>');
});
