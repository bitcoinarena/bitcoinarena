// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// The AST guard. Runs in CI and as a pre-commit hook.
//
// Stronger than lint on purpose: it cannot be silenced with an inline comment,
// because rules that depend on a reviewer's attention eventually fail. It
// exists in stage 0 rather than stage 5 because it has to be in place BEFORE
// the core grows around a violation.
//
// What it refuses, in the core's source:
//   - a numeric literal containing '.' or an exponent
//   - '/', '*' or '%' outside the whitelisted arithmetic files
//   - any Math member outside the whitelist
//   - Date, performance, Math.random
//   - any import from outside the package
//   - regenerating tables.js in a build step (checked by the caller)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'acorn';

// THE GUARD AS A FUNCTION: `checkCoreTree(root)` answers every hit in one core's tree - its file, line,
// rule and the core's own source text - so the test suite can run it over every core a seat installs (core/src and
// core/frozen/*) against each core's recorded baseline. The command line below is unchanged: it checks core/src.
const ROOT = new URL('../src', import.meta.url).pathname;

// The files allowed to divide and multiply. Everything else must go
// through fixed.js, which is the point: one place to audit.
const ARITHMETIC = new Set(['fixed.js', 'sha256.js', 'trig.js', 'rng.js']);

const MATH_OK = new Set(['imul', 'abs', 'min', 'max', 'floor', 'trunc', 'sign', 'round']);
// round is allowed only in fixed.js, checked separately below
const MATH_OK_STRICT = new Set(['imul', 'abs', 'min', 'max', 'floor', 'trunc', 'sign']);

const BANNED_GLOBALS = new Set(['Date', 'performance']);

/**
 * Every hit in the core tree at `root`: [{ file, line, rule, text, message }]. `file` is relative to `root`, `rule` one
 * of 'float literal', 'operator', 'Math', 'global', 'import', and `text` the source the hit stands on, exactly as written.
 */
export function checkCoreTree(root) {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js')) files.push(p);
    }
  })(root);

  const hits = [];
  for (const file of files) {
    const name = file.split('/').pop();
    const src = readFileSync(file, 'utf8');
    const ast = parse(src, { ecmaVersion: 2023, sourceType: 'module', locations: true });
    const mathOk = name === 'fixed.js' ? MATH_OK : MATH_OK_STRICT;
    const mayDivide = ARITHMETIC.has(name);
    const hit = (node, rule, message) => hits.push({ file: relative(root, file), line: node.loc.start.line, rule,
      text: src.slice(node.start, node.end), message });

    (function visit(node) {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const n of node) visit(n); return; }
      if (typeof node.type !== 'string') return;

      if (node.type === 'Literal' && typeof node.value === 'number') {
        const raw = node.raw || '';
        if (raw.includes('.') || /[eE]/.test(raw.replace(/^0[xX].*/, '')))
          hit(node, 'float literal', `float literal ${raw}`);
      }

      if (node.type === 'BinaryExpression' && '/*%'.includes(node.operator) && !mayDivide)
        hit(node, 'operator', `operator '${node.operator}' outside an arithmetic file`);

      if (node.type === 'MemberExpression' && node.object.type === 'Identifier') {
        if (node.object.name === 'Math' && node.property.type === 'Identifier'
            && !mathOk.has(node.property.name))
          hit(node, 'Math', `Math.${node.property.name}`);
        if (BANNED_GLOBALS.has(node.object.name))
          hit(node, 'global', `${node.object.name} is not available to the core`);
      }

      if (node.type === 'ImportDeclaration') {
        const from = node.source.value;
        if (!from.startsWith('./') && !from.startsWith('../'))
          hit(node, 'import', `import from outside the package: ${from}`);
      }

      for (const key of Object.keys(node)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        visit(node[key]);
      }
    })(ast);
  }
  return { files: files.length, hits };
}

// THE COMMAND LINE, as before: core/src, every hit printed, exit 1 on any.
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const { files, hits } = checkCoreTree(ROOT);
  if (hits.length) {
    console.error('determinism guard: ' + hits.length + ' problem(s)\n');
    for (const h of hits) console.error(`  ${h.file}:${h.line} ${h.message}`);
    process.exit(1);
  }
  console.log('determinism guard: ' + files + ' files clean');
}
