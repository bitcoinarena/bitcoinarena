// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Everything the core is allowed to touch, and why.
//
// The cross-version measurement is the reason this file exists. Three engines
// agreeing today says nothing about one engine agreeing with itself next year,
// and on 31 August 2026 V8 changed Math.pow between 12.4 and 13.6 - which
// would have desynced every player who updated Chrome, silently, and only for
// some inputs.
//
// The core survives that by using only operations ECMAScript specifies
// exactly. This test enumerates them, poisons everything else, and fails if
// anything outside the list is reachable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'acorn';

const SRC = new URL('../src/', import.meta.url).pathname;

/**
 * The whitelist, with the clause that pins each one.
 *
 * Every entry here is defined by ECMAScript to produce one specific result,
 * not an "implementation-approximated" one. That is the whole distinction:
 * Math.imul has a specification, Math.pow has a permission.
 */
const ALLOWED = {
  imul: 'ES 21.3.2.19 - exact 32-bit multiply',
  abs: 'ES 21.3.2.1 - exact for the integers the core holds',
  min: 'ES 21.3.2.24',
  max: 'ES 21.3.2.23',
  floor: 'ES 21.3.2.16',
  trunc: 'ES 21.3.2.35',
  sign: 'ES 21.3.2.32',
  round: 'ES 21.3.2.28 - source constants only, never runtime data',
};

/** Named because they are the ones that actually moved under measurement. */
const FORBIDDEN = [
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'exp', 'expm1', 'log', 'log2', 'log10', 'log1p',
  'pow', 'sqrt', 'cbrt', 'hypot', 'random', 'fround',
];

const files = [];
(function walk(dir) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith('.js')) files.push(p);
  }
})(SRC);

test('the core calls no Math member outside the specified list', () => {
  // Parsed, not matched. A regex sees fixed.js explaining why it does NOT use
  // Math.sqrt and trig.js promising that Math.sin is never called, and reports
  // both as violations - the comments that document the rule would fail it.
  for (const f of files) {
    const ast = parse(readFileSync(f, 'utf8'),
      { ecmaVersion: 2023, sourceType: 'module', locations: true });
    (function visit(node) {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const n of node) visit(n); return; }
      if (typeof node.type !== 'string') return;
      if (node.type === 'MemberExpression'
          && node.object.type === 'Identifier' && node.object.name === 'Math'
          && node.property.type === 'Identifier') {
        assert.ok(ALLOWED[node.property.name],
          `${f.split('/').pop()}:${node.loc.start.line} calls Math.${node.property.name}, ` +
          'which ECMAScript does not pin down');
      }
      for (const k of Object.keys(node)) {
        if (k === 'loc' || k === 'start' || k === 'end') continue;
        visit(node[k]);
      }
    })(ast);
  }
});

test('nothing locale-dependent, time-dependent or random is reachable', async () => {
  const saved = [];
  const poison = (obj, key) => {
    saved.push([obj, key, obj[key]]);
    obj[key] = () => { throw new Error('poisoned ' + key); };
  };

  for (const name of FORBIDDEN) if (Math[name]) poison(Math, name);
  poison(Date, 'now');
  // locale output is the quiet one: it depends on the host's ICU data, so two
  // machines with the same engine can differ
  poison(Number.prototype, 'toLocaleString');
  poison(String.prototype, 'localeCompare');
  poison(Array.prototype, 'toLocaleString');

  try {
    const { init, step } = await import('../src/sim.js?specified');
    const { hash } = await import('../src/state.js?specified');
    const st = init(0x51ec);
    for (let t = 0; t < 3000; t++) step(st, 60000, ((t * 811) % 65536) - 32768, 0, 0, 0);
    assert.equal(hash(st).length, 64);
  } finally {
    for (const [obj, key, fn] of saved) obj[key] = fn;
  }
});

test('every allowed member carries the clause that pins it', () => {
  for (const [name, why] of Object.entries(ALLOWED))
    assert.match(why, /^ES \d/, name + ' has no citation');
});
