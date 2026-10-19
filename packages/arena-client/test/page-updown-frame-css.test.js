// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAGE'S OWN CSS FOR THE UP/DOWN FRAME (2026-10-17: "pending final breaks the layout"; "Fix the alignment
// so columns have the same width always"): injected into the client's frame on load, for btc-updown-15m only - a past order's status on
// its own line, and one fixed side column so every card's amount and window start at the same x (measured in the harness at 390:
// My orders 118/118, past orders 116/116/116; before, ▼ Down's started 42 px right of ▲ Up's on the owner's phone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const at = HTML.indexOf("frame.addEventListener('load', () => {");
const block = HTML.slice(at, HTML.indexOf('d.head.appendChild(st);', at));

test('the frame CSS is for Up/Down only and keeps its columns one width', () => {
  assert.ok(at > 0, 'the page styles the client frame on load');
  assert.match(block, /game\.name === 'btc-updown-15m' \?/);
  assert.match(block, /\.ord\{grid-template-columns:72px minmax\(0,1fr\) auto!important\}\.ord \.sd\{display:block;text-align:center;/);
  assert.match(block, /\.pastc \.ph \.sd\{width:72px;flex:none;/);
  assert.match(block, /\.pastc \.ph \.fin\{flex:1 0 100%;order:3;text-align:right\}/);
  // ("In einer Zeile auf mobile"): on a phone the History totals take their own line, never wrapped
  assert.match(block, /@media \(max-width:999px\)\{#histhead\{flex-wrap:wrap;row-gap:2px\}#histhead \.tot\{flex:1 0 100%;text-align:left;white-space:nowrap;font-size:11px;/);
});
