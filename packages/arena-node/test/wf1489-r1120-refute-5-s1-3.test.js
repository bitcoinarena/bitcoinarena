// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3100 (#1489 r1120-refute-5-s1): the tree scan's comment blanking hides no code - variants of the misread regex and of other ways a
// lexer's state can drift from JS's; and what honest code puts in comments is still blanked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTree, blankComments, checkPackage, TREE_ENTRY } from '../src/plugin-check.js';

const enc = (s) => new TextEncoder().encode(s);
const finds = (src) => scanTree([{ path: 'adapter.js', bytes: enc(src) }]).map((x) => x.rule);
const G = 'reaches the global scope';
const hidden = {
  'regex after if (...)': "if (1) /[/*]/.test('');\nconst g = globalThis;\nconst z = /[*/]/;\n",
  'regex after while (...)': "while (0) /[/*]/.test('');\nconst g = globalThis;\nconst z = /[*/]/;\n",
  'regex after }': "{ }\n/[/*]/.test('');\nconst g = globalThis;\nconst z = /[*/]/;\n",
  'regex after `export default`': "export default /[/*]/;\nconst g = globalThis;\nconst z = /[*/]/;\n",
  'regex after `break label` and a newline (ASI)': "a: for (;;) { break a\n/[/*]/.test('') }\nconst g = globalThis;\nconst z = /[*/]/;\n",
  'regex after ++ (prefix)': "let q = 1; q\n++/[/*]/.lastIndex;\nconst g = globalThis;\nconst z = /[*/]/;\n",
  'regex holding a backtick after if': "if (1) /`/.test('');\nconst s = `/*`;\nconst g = globalThis;\nconst z = /[*/]/;\n",
  'line comment ended by a CR': "// note\rconst g = globalThis;\n",
  'line comment ended by U+2028': "// note const g = globalThis;\n",
  'string with U+2028 holding /*': "const s = \"  /*\"; const g = globalThis; // */\n",
  'string continued over CR LF holding /*': "const s = \"\\\r\n/* \"; const g = globalThis; // */\n",
  'template ${} holding a regex with /*': "const s = `${/[/*]/.source}`; const g = globalThis; // */\n",
};
for (const [name, src] of Object.entries(hidden)) {
  test(`#3100: the tree scan finds code after: ${name}`, () => {
    const r = finds(src);
    assert.ok(r.includes(G), `${name}: ${JSON.stringify(r)} - blanked: ${JSON.stringify(blankComments(src))}`);
  });
}

test('#3100: honest comments are still blanked - after a division, a regex, a string, a template, in a block, at the end', () => {
  const honest = [
    "const half = (a + b) / 2; // the window's middle\n",
    "const r = /x/g; /* reaches the global scope? no: window */ export const DECIDE = 1;\n",
    "const s = 'a'; // globalThis is not used\n",
    "const t = `x${1 / 2}y`; // process\n",
    "/**\n * a global: window, document, process\n */\nexport const x = 1;\n",
    "if (a) { b(); } // window\nconst c = a[0] / 2; // self.x\n",
    "for (const x of y) z(x / 2); // window\n",
    "return2 / 2; // window\n",
  ];
  for (const src of honest) assert.deepEqual(finds(src), [], src);
});

test('#3097, #3099: a tree core runs from adapter.js only', () => {
  assert.equal(TREE_ENTRY, 'adapter.js');
  // checkPackage reaches the entry rule only for a stood manifest; treeFilesOf refuses before the hash otherwise - see refute-5-s1-1 for the full package
  assert.equal(typeof checkPackage, 'function');
});

test('#3100: the blanking stays linear on a hostile 2 MB file (forks, deep parens, a long word, deep templates)', () => {
  const parts = ['}/x/;\n'.repeat(20000), '('.repeat(200000), 'a'.repeat(200000), '}/'.repeat(100000), ')'.repeat(200000), '`${'.repeat(1000)];
  for (const p of parts) {
    const src = p + '\nconst g = globalThis;\n';
    const t0 = Date.now(); const r = finds(src); const ms = Date.now() - t0;
    console.log('  MEASURED', JSON.stringify(p.slice(0, 6)), p.length, 'chars:', ms, 'ms');
    assert.ok(ms < 5000, `${ms} ms`);
    assert.ok(r.includes(G));
  }
});
