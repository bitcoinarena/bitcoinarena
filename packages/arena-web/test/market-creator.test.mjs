// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// CREATE A MARKET (kanban #920): the templates, what each step lacks, the address rule, reading an answer and the outcome it gives; the form opens on the templates
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarketCreator } from '../dist/test/market-creator.mjs';
import { TEMPLATES, fieldsOf, fromTemplate, problemsOf, urlProblem, readAnswer, outcomeOf } from '../dist/test/market-draft.mjs';

test('every template starts a draft of its own, and they share no list', () => {
  for (const t of TEMPLATES) assert.equal(fromTemplate(t.id).template, t.id);
  const a = fromTemplate('blank'), b = fromTemplate('blank');
  a.outcomes.push('x'); a.source.url = 'y';
  assert.deepEqual(b.outcomes, ['Yes', 'No']); assert.equal(b.source.url, '');
});

test('a node reads public https only', () => {
  for (const bad of ['http://a.example/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.1.2.3/', 'https://192.0.2.1/', 'https://172.16.0.1/', 'https://169.254.169.254/latest', 'https://[::1]/', 'https://u:p@a.example/', 'https://printer.local/', 'nonsense'])
    assert.ok(urlProblem(bad), bad);
  assert.equal(urlProblem('https://api.coinbase.com/v2/prices/BTC-USD/spot'), null);
  assert.equal(urlProblem('https://172.32.0.1/'), null);
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

test('the form opens on the templates', () => {
  const html = renderToStaticMarkup(React.createElement(MarketCreator));
  for (const t of TEMPLATES) assert.ok(html.includes(t.name), t.name);
  assert.match(html, /aria-current="step"/);
});
