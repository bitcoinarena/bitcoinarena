// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GEAR AS LARGE AS EVERYWHERE ELSE (2026-10-16: the gear over the games and over Up/Down "super tiny").
// Measured on live UI 169: the wallet bar's gear 34x29 at 13 px, the strip's over Unity 40x34 at 20 px. On the page's own CSS:
// the wallet bar's gear has the strip gear's font size, line height and padding.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HTML = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const decl = (rule, prop) => { const m = rule.match(new RegExp('(?:^|[;{\\s])' + prop + ': ([^;]+);')); return m ? m[1].trim() : null; };

test('the wallet bar\'s gear is the size of the strip\'s gear', () => {
  const strip = HTML.match(/\n\s*#arena-settings-go \{([^}]*)\}/)[1];
  const m = HTML.match(/\n\s*#arena-wallet-bar #arena-wb-gear \{([^}]*)\}/);
  assert.ok(m, 'the wallet bar\'s gear has its own rule');
  for (const prop of ['font-size', 'line-height', 'padding']) assert.equal(decl(m[1], prop), decl(strip, prop), prop);
});
