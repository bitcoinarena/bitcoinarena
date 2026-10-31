// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CREATE A MARKET (kanban #920): the templates, what each step lacks, the address rule, reading an answer and the outcome it gives; the form opens on the templates
import { test } from 'node:test';
import { SOURCE_ENTRIES } from '../../arena-protocol/src/market-sources.js';
import { decodeHostList, hostListProblem } from '../../arena-protocol/src/market-check.js';
import { entryProblem, proposedList, SourceProposal } from '../dist/test/source-proposal.mjs';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketCreator } from '../dist/test/market-creator.mjs';
import { parse } from 'acorn';
import { SOURCES } from '../dist/test/market-sources.mjs';
import { MARKET_HOSTS } from '../../arena-protocol/src/market-check.js';
import { CATEGORIES, EXAMPLES, TEMPLATES, fieldsOf, fromTemplate, problemsOf, urlProblem, readAnswer, outcomeOf, outcomeOfCode } from '../dist/test/market-draft.mjs';
import { checkMarketCode } from '../../arena-protocol/src/market-check.js';

test('every template starts a draft of its own, and they share no list', () => {
  for (const t of TEMPLATES) { const d = fromTemplate(t.id); assert.equal(d.template, t.id); assert.ok(t.id === 'blank' || CATEGORIES.includes(d.category), t.id); }
  const a = fromTemplate('blank'), b = fromTemplate('blank');
  a.outcomes.push('x'); a.source.url = 'y';
  assert.deepEqual(b.outcomes, ['Yes', 'No']); assert.equal(b.source.url, '');
});

test('a node reads public https only', () => {
  for (const bad of ['http://a.example/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.1.2.3/', 'https://192.0.2.1/', 'https://172.16.0.1/', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://u:p@a.example/', 'https://printer.local/', 'nonsense'])
    assert.ok(urlProblem(bad), bad);
  assert.equal(urlProblem('https://api.coinbase.com/v2/prices/BTC-USD/spot'), null);
  assert.match(urlProblem('https://my-own-site.example/price'), /not a listed source/);
});

test('each step names what it lacks', () => {
  const d = fromTemplate('blank');
  assert.deepEqual(Object.keys(problemsOf(d, 'question')).sort(), ['category', 'title']);
  assert.ok(problemsOf({ ...d, outcomes: ['A', 'A'] }, 'question').outcomes);
  assert.ok(problemsOf({ ...d, kind: 'number', low: '5', high: '1' }, 'question').bounds);
  assert.ok(problemsOf({ ...d, source: { ...d.source, read: 'regex', path: '(' } }, 'result').path);
  assert.ok(problemsOf(d, 'schedule').resolveAt);
  assert.deepEqual(problemsOf({ ...d, schedule: { ...d.schedule, mode: 'repeat' } }, 'schedule'), {});
});

test('an answer read and turned into an outcome', () => {
  const d = fromTemplate('price'); d.source.value = '100';
  const got = readAnswer(d.source, '{"data":{"amount":"120.5"}}');
  assert.equal(got.value, '120.5');
  assert.equal(outcomeOf(d, got.value).outcome, 'Yes');
  assert.equal(outcomeOf(d, '99').outcome, 'No');
  assert.ok(readAnswer(d.source, 'not json').why);
  assert.ok(readAnswer({ ...d.source, path: 'data.none' }, '{"data":{}}').why);
  assert.equal(readAnswer({ read: 'regex', path: 'Price: ([0-9.]+)', rule: 'above' }, 'Price: 42.5 now').value, '42.5');
  const n = fromTemplate('number'); n.low = '0'; n.high = '10';
  assert.equal(outcomeOf(n, '50').outcome, '10');
  const f = fromTemplate('page');
  assert.equal(outcomeOf(f, '').outcome, 'No'); assert.equal(outcomeOf(f, 'x').outcome, 'Yes');
});

test('the answer names its fields to pick from', () => {
  assert.deepEqual(fieldsOf('{"data":{"amount":"120.5","base":"BTC"},"n":[1]}'), [['data.amount', '120.5'], ['data.base', 'BTC'], ['n.0', '1']]);
  assert.deepEqual(fieldsOf('<html>'), []);
});

test('samples and examples are real drafts: public addresses, code that passes the check', () => {
  for (const s of SOURCES) {
    assert.equal(urlProblem(s.url, !!s.socket), null, s.name);
    assert.match(s.docs, /^https:\/\//, s.name);
    if (s.demo) assert.ok(readAnswer(s, s.demo).value, s.name);
  }
  // every listed host has its example, and no example names a host off the list
  assert.deepEqual([...new Set(SOURCES.map((s) => new URL(s.url).hostname))].sort(), [...MARKET_HOSTS].sort());
  for (const e of EXAMPLES) {
    assert.ok(checkMarketCode(e.code, parse).ok, JSON.stringify(checkMarketCode(e.code, parse).problems));
    for (const r of e.reads) assert.equal(urlProblem(r.url, r.kind === 'ws'), null, r.url);
  }
});

test('code in a draft: its check holds the step back; what it returns must be an outcome', () => {
  const d = fromTemplate('blank'); d.source = { ...d.source, kind: 'code', code: 'function decide(){ return eval("1"); }', reads: [{ id: 'a', kind: 'http', url: 'https://api.binance.com/api/v3/time', subscribe: '' }] };
  assert.ok(problemsOf(d, 'result', checkMarketCode(d.source.code, parse)).code);
  d.source.code = 'function decide(reads, market) {\n  return market.outcomes[0];\n}';
  assert.deepEqual(problemsOf(d, 'result', checkMarketCode(d.source.code, parse)), {});
  d.source.reads = [{ id: 'a', kind: 'ws', url: 'https://api.binance.com/', subscribe: '' }];
  assert.ok(problemsOf(d, 'result', null).reads);
  assert.equal(outcomeOfCode(d, 'Yes').outcome, 'Yes'); assert.equal(outcomeOfCode(d, 1).outcome, 'No'); assert.ok(outcomeOfCode(d, 'Maybe').why);
});

test('the form opens on the templates', () => {
  const html = renderToStaticMarkup(React.createElement(MarketCreator));
  for (const t of TEMPLATES) assert.ok(html.includes(t.name), t.name);
  assert.match(html, /aria-current="step"/);
});

test('a proposed source needs an example that answers, and its docs', () => {
  const hosts = SOURCE_ENTRIES.map((e) => e.host), e = { host: 'api.ecb.example.org', url: 'https://api.ecb.example.org/rate', read: 'json', path: 'rate', docs: 'https://api.ecb.example.org/docs' };
  assert.equal(entryProblem(e, hosts), null);
  assert.match(entryProblem({ ...e, host: 'api.coinbase.com', url: 'https://api.coinbase.com/x' }, hosts), /already listed/);
  assert.ok(entryProblem({ ...e, url: 'http://10.0.0.1/x' }, hosts));
  assert.equal(hostListProblem(proposedList(SOURCE_ENTRIES, e)), null);
  assert.deepEqual(decodeHostList(proposedList(SOURCE_ENTRIES, e)).length, hosts.length + 1);
  assert.match(hostListProblem(proposedList([], { ...e, docs: '' })), /documentation/);
});

test('Make the proposal stays closed until the example has answered', () => {
  const page = renderToStaticMarkup(React.createElement(SourceProposal, {}));
  assert.match(page, /<button[^>]*disabled=""[^>]*>Make the proposal/);
  assert.match(page, /opens once this example answers/);
});
