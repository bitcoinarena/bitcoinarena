// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SMALLEST BUNDLER'S WALK AND TRANSFORM, IN ONE PLACE: topologically sorted imports, import and export lines
// stripped, concatenated. Used by tools/bundle.js (the page's core, dist/blwp-core.js) and tools/bundle-replay.js (the
// replay page's core, dist/blwp-replay-core.js) - one transform, so the two bundles cannot be two different bundlers.
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

export function concatBundle(SRC, entries, banner) {
  const seen = new Set();
  const order = [];

  function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    // Multi-line imports too: sim.js pulls twenty names out of state.js across
    // eight lines, and a line-anchored pattern misses every one of them - which
    // left the import statement in the bundle and produced a syntax error.
    for (const m of text.matchAll(/import\s[\s\S]*?from\s+'([^']+)';/g)) {
      walk(resolve(dirname(file), m[1]));
    }
    order.push(file);
  }
  for (const e of entries) walk(SRC + e);

  // Flat concatenation means one scope, so two modules exporting the same name
  // would silently shadow each other - and the survivor would depend on file
  // order. Better to refuse than to ship a bundle that is quietly a different
  // program from the modules.
  const declared = new Map();
  for (const file of order) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^export\s+(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      const name = m[1];
      if (declared.has(name) && declared.get(name) !== file) {
        console.error('bundle: ' + name + ' is exported by both ' +
                      relative(SRC, declared.get(name)) + ' and ' + relative(SRC, file));
        process.exit(1);
      }
      declared.set(name, file);
    }
  }

  let out = banner;
  for (const file of order) {
    const body = readFileSync(file, 'utf8')
      // AN IMPORT UNDER ANOTHER NAME KEEPS THAT NAME. `import { heat as
      // heatForLoad }` was stripped like any import, so the flat bundle had `heat`
      // and no `heatForLoad`, and the page threw "heatForLoad is not defined" on
      // every ROLL OUT (two-Chrome look, 2026-09-10) - the modules and every
      // suite that loads them were fine. The alias becomes a declaration where
      // the import stood; the module it names is earlier in `order`.
      .replace(/^import\s*\{([^{}]*)\}\s*from\s+'[^']+';\s*$/gm, (all, names) => names
        .split(',').map((n) => n.trim().match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/))
        .filter(Boolean).map(([, from, to]) => `var ${to} = ${from};`).join('\n'))
      // whole import statements, however many lines they span
      .replace(/^import\s[\s\S]*?;\s*$/gm, '')
      // re-exports carry no declaration of their own
      .replace(/^export\s+\*\s+from\s+[^;]*;\s*$/gm, '')
      // A LIST OF NAMES ON ONE LINE, and not a lazy match that crosses them.
      //
      // These two used to read `\{[\s\S]*?\}`, which spans lines: with an
      // `export { A, B };` early in a file and an `export { C } from './x.js';`
      // later, the match started at the first and ran to the second, DELETING
      // every declaration in between. Measured on `core/src/sim.js`: line 51's
      // `export { UNITS, ARMOUR_MASK };` and line 106's `export { TICK_DT } from
      // './tick.js';` swallowed 55 lines, including `export const HALF_X` - and
      // the bundle still carried nine USES of it, so the page threw
      // "HALF_X is not defined" on the first step. The committed bundle predated
      // that re-export, which is the only reason anybody had a working one.
      .replace(/^export\s*\{[^{}]*\}\s*from\s+[^;]*;\s*$/gm, '')
      .replace(/^export\s*\{[^{}]*\}\s*;\s*$/gm, '')
      // and declarations simply lose the keyword
      .replace(/^export\s+(const|function|class|let|var)\s/gm, '$1 ');
    out += '\n// ---- ' + relative(SRC, file) + '\n' + body;
  }

  return { out, order };
}
