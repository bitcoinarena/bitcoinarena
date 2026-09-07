// A narrower cousin of the core's determinism guard.
//
// The protocol package is allowed to divide - it is not the simulation - but
// the money paths are not. Everything that touches a stake, a share or a
// remainder must be BigInt, and a float literal in those files is a bug
// waiting for a pool that does not divide evenly.

import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

// `batch.js` is on the list although it moves no money: it carries Q16.16
// words that go straight into the deterministic core, so a float literal there
// would desync a player from the nodes verifying him exactly as one in
// `contracts.js` would misprice him.
const MONEY = ['payout.js', 'sortition.js', 'census.js', 'contracts.js', 'encode.js',
               'batch.js', 'transcript.js', 'chain.js', 'tx.js'];
const ROOT = new URL('../src/', import.meta.url).pathname;
const problems = [];

for (const name of MONEY) {
  const src = readFileSync(ROOT + name, 'utf8');
  const ast = parse(src, { ecmaVersion: 2023, sourceType: 'module', locations: true });

  (function visit(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    if (typeof node.type !== 'string') return;

    if (node.type === 'Literal' && typeof node.value === 'number') {
      const raw = node.raw || '';
      if (raw.includes('.') || /[eE]/.test(raw.replace(/^0[xX].*/, '')))
        problems.push(`${name}:${node.loc.start.line} float literal ${raw}`);
    }
    if (node.type === 'MemberExpression' && node.object.type === 'Identifier'
        && node.object.name === 'Number'
        && ['parseFloat', 'EPSILON'].includes(node.property.name))
      problems.push(`${name}:${node.loc.start.line} Number.${node.property.name}`);

    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end') continue;
      visit(node[k]);
    }
  })(ast);
}

if (problems.length) {
  console.error('money guard: ' + problems.length + ' problem(s)\n');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('money guard: ' + MONEY.length + ' files clean');
