// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHY ONE ROUND'S DEPOSIT IS MORE THAN ITS STAKE, AS THE DEPOSIT BOX SAYS IT: the line under the deposit tabs
// gave "the federation's e-cash comes in notes of 0.512 sat" - false since notes are 1 msat ("1 sat = 1 sat", the owner
// 2026-10-01; page-lock.js NOTE_MSAT). index.html's own depositWhyLine runs under the page's name (page-script.js).
// Measured: a 100 sat stake with a 102 sat round names both and the real reason (the node fee and the donation, rounded up
// to a whole sat); equal amounts say nothing; the page holds the 0.512 sat reason nowhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const at = HTML.indexOf('    function depositWhyLine(');
assert.ok(at > 0, 'index.html says the deposit\'s reason in depositWhyLine');
const SRC = HTML.slice(at, HTML.indexOf('\n    }\n', at) + '\n    }\n'.length);
const why = pageFunction(PAGE, [], SRC, 'return depositWhyLine;')();

test('a 100 sat stake with a 102 sat one-round deposit: both amounts and the real reason', () => {
  assert.equal(why(100000n, 102000n),
    'A round costs 100 sat. You deposit 102 sat per round: the stake, plus the round\'s node fee and donation, rounded up to a whole sat. Whatever a round does not use stays in your wallet.');
});

test('a deposit equal to the stake says nothing (the live 100 sat round stays without the line)', () => {
  assert.equal(why(100000n, 100000n), '');
  assert.equal(why(0n, 102000n), '', 'no stake, no line');
  assert.equal(why(100000n, null), '', 'no one-round tab, no line');
});

test('the page gives the 0.512 sat reason nowhere', () => {
  assert.ok(!HTML.includes('notes of 0.512 sat'), 'the deposit box still says notes of 0.512 sat');
  assert.ok(!HTML.includes('512 msat notes'), 'a comment still sizes deposits in 512 msat notes');
});
