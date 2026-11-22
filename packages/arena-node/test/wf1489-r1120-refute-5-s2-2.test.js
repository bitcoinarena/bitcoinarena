// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3100 (#1489 r1120-refute-5-s2): a game developer hides code from the tree scan with a private name spelled like a keyword.
// blankComments reads `this.#in` / `this.#if (...)` as the keyword (the word's bw is '#', not '.'), takes the regex reading only, and
// drops the true one (division); its regex then swallows a quote, and a '/*' inside a later string opens a fake comment over real code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTree, blankComments } from '../src/plugin-check.js';

const enc = (s) => new TextEncoder().encode(s);
const G = 'reaches the global scope';
const cases = {
  'this.#in / ...': "class A { #in = 4; m() { const a = this.#in / 2; const b = \"/'\"; const c = '/*'; const g = globalThis; const d = '*/'; return [a, b, c, d, g]; } }\nexport const DECIDE = () => new A().m();\n",
  'this.#if (...) / ...': "class A { #if(x) { return x; } m() { const a = this.#if(4) / 2; const b = \"/'\"; const c = '/*'; const g = globalThis; const d = '*/'; return [a, b, c, d, g]; } }\nexport const DECIDE = () => new A().m();\n",
  'this.#return / ...': "class A { #return = 4; m() { const a = this.#return / 2; const b = \"/'\"; const c = '/*'; const g = globalThis; const d = '*/'; return [a, b, c, d, g]; } }\nexport const DECIDE = () => new A().m();\n",
};
for (const [name, src] of Object.entries(cases)) {
  test(`#3100: the tree scan finds globalThis after ${name}`, () => {
    new Function(src.replace('export const', 'const'));   // it is valid JS
    const r = scanTree([{ path: 'adapter.js', bytes: enc(src) }]).map((x) => x.rule);
    assert.ok(r.includes(G), `${name}: ${JSON.stringify(r)} blanked: ${JSON.stringify(blankComments(src))}`);
  });
}
