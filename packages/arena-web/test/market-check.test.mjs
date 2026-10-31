// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET'S CODE MUST BE READABLE (kanban #920): plain code passes; every way of hiding it is refused, by name and line
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { checkMarketCode } from '../../arena-protocol/src/market-check.js';

const rules = (code) => checkMarketCode(code, parse).problems.map((p) => p.rule);
const plain = `const LEVEL = 100000;
function decide(reads, market) {
  const price = Number(reads.btc.data.amount);
  return price >= LEVEL ? market.outcomes[0] : market.outcomes[1];
}`;

test('plain code passes', () => { assert.deepEqual(checkMarketCode(plain, parse).problems, []); });

test('what is refused, and why', () => {
  const cases = {
    forbidden: ['function decide(){ return eval("1"); }', 'function decide(){ return fetch("x"); }', 'function decide(r){ return r.constructor; }', 'function decide(r){ return r["constructor"]; }',
      'function decide(){ return Math.random(); }', 'function decide(){ return Date.now(); }', 'function decide(){ return this; }', 'function decide(){ return import("x"); }', 'async function decide(){ }', 'function decide(){ debugger; }'],
    hidden: ['function decide(r){ return r["con"+"structor"]; }', 'function decide(){ return "\\x65val"; }', 'function d\\u0065cide(){ }', 'function decide(){ return "​x"; }', 'function decide(r){ return r[`a${1}`]; }'],
    packed: [`function decide(){ return "${'aGVsbG8gd29ybGQ'.repeat(4)}"; }`, `function decide(){ return "${'0123456789abcdef'.repeat(4)}"; }`, `function decide(){ return "${'x y '.repeat(60)}"; }`],
    minified: [`function decide(){ ${'var a=1;'.repeat(40)} }`],
    decide: ['function other(){ }'],
    top: ['function decide(){ }\ndecide();'],
    parse: ['function decide( {'],
    size: [`function decide(){ }\n${'// plain\n'.repeat(4000)}`],
  };
  for (const [rule, list] of Object.entries(cases)) for (const c of list) assert.ok(rules(c).includes(rule), `${rule}: ${c.slice(0, 60)}`);
});

test('a refused line is named', () => {
  const p = checkMarketCode('function decide(){\n  return eval("1");\n}', parse).problems[0];
  assert.equal(p.line, 2); assert.match(p.why, /eval/);
});

test('mostly one-letter names read as minified, a few do not', () => {
  assert.ok(rules(`function decide(){ const a=1,b=2,c=3,d=4,e=5,f=6,g=7,h=8,i=9,j=1,k=2,l=3; return a+b+c+d+e+f+g+h+i+j+k+l; }`).includes('minified'));
  assert.deepEqual(rules('function decide(reads){\n  for (let i = 0; i < 3; i++) { }\n  return reads.btc;\n}'), []);
});
