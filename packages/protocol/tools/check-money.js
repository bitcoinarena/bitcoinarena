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
// `slash.js` is on it because a bond is money: what that file decides is
// whether an output the node owns may be spent away from it.
// `blwp-node/src/custody.js` is the first money path this guard has had to
// reach outside the protocol package: it is what actually runs 23.2's table
// against a Lightning node, and a float msat there would settle a hold for an
// amount the player never signed.
const MONEY = ['payout.js', 'sortition.js', 'census.js', 'contracts.js', 'encode.js',
               'batch.js', 'transcript.js', 'chain.js', 'tx.js', 'slash.js', 'fee.js',
               'donation.js', '../../blwp-node/src/custody.js',
               // `frost.js` and `frost-bip340.js` are on it for `slash.js`'s
               // reason rather than for a stake's: what they decide is whether
               // an output may be spent away from the pool. A float in a
               // scalar there is a signature that does not verify at best and
               // a leaked share at worst.
               'frost.js', 'frost-bip340.js',
               // `pool.js` decides which output the committee's key pays to
               // and which scalar signs for it. A float there is a wallet
               // nobody can spend, holding every settled stake.
               'pool.js'];
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
