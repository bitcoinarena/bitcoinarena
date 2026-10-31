// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A MARKET'S CODE AND READS ON A NODE (kanban #920): the sandbox attacked, the reader's address rules, the whole try
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMarketCode } from '../src/market-sandbox.js';
import { publicLookup, readMarketSources, readPage } from '../src/market-reader.js';
import { testMarket } from '../src/market-test.js';
import { marketUrlProblem, privateAddress } from '../../arena-protocol/src/market-check.js';

const out = (code, reads = { a: 1 }, market = { outcomes: ['Yes', 'No'] }) => runMarketCode({ code, reads, market });

test('plain code answers from what it is handed', async () => {
  assert.deepEqual(await out('function decide(r, m) { return r.a > 0 ? m.outcomes[0] : m.outcomes[1]; }'), { ok: true, out: 'Yes' });
});

test('the sandbox holds', async () => {
  const absent = ['typeof process', 'typeof require', 'typeof fetch', 'typeof Date', 'typeof WebAssembly', 'typeof Function', 'typeof eval', 'typeof Math.random', 'typeof setTimeout', 'typeof console'];
  for (const x of absent) assert.equal((await out(`function decide() { return ${x}; }`)).out, 'undefined', x);
  const made = await out('function decide() { return (() => {}).constructor("return 1")(); }');
  assert.equal(made.ok, false); assert.match(made.why, /Code generation/i);
  const host = await out('function decide() { return [].constructor.constructor("return process")(); }');
  assert.equal(host.ok, false);
});

test('a loop is stopped, memory is bounded, a throw is said', async () => {
  const t = Date.now();
  const loop = await runMarketCode({ code: 'function decide() { while (true) { } }' }, { limitMs: 300 });
  assert.equal(loop.ok, false); assert.match(loop.why, /Stopped/); assert.ok(Date.now() - t < 2000);
  const mem = await runMarketCode({ code: 'function decide() { const a = []; while (true) a.push(new Array(1e6).fill(1)); }' }, { limitMs: 20000 });
  assert.equal(mem.ok, false);
  assert.match((await out('function decide() { throw new Error("no"); }')).why, /no/);
});

test('private and local addresses are refused, before and after DNS', () => {
  for (const ip of ['127.0.0.1', '10.0.0.8', '192.0.2.18', '172.20.1.1', '100.64.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', '224.0.0.1']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['1.1.1.1', '104.21.53.120', '2606:4700::1111', '172.32.0.1', '100.63.0.1']) assert.equal(privateAddress(ip), false, ip);
  for (const u of ['http://a.example/', 'https://localhost/', 'https://127.0.0.1/', 'https://seat.example.com/', 'https://a:b@c.example/', 'https://[::1]/']) assert.ok(marketUrlProblem(u), u);
  assert.equal(marketUrlProblem('https://api.kraken.com/0/public/Ticker?pair=XBTUSD'), null);
  assert.equal(marketUrlProblem('wss://ws-feed.exchange.coinbase.com', true), null);
});

test('a name that resolves private is refused at the connection', async () => {
  await assert.rejects(readPage('https://example.com/', { lookup: (h, o, d) => d(new Error('that host is not public')) }), /not public/);
  await assert.rejects(new Promise((ok, no) => publicLookup('localhost', {}, (e) => (e ? no(e) : ok()))), /not public/);
});

test('reads are limited and named', async () => {
  assert.match((await readMarketSources([{}, {}, {}, {}])).why, /At most 3/);
  assert.match((await readMarketSources([{ id: '1a', url: 'https://a.example/' }])).why, /letters/);
  assert.match((await readMarketSources([{ id: 'a', url: 'http://a.example/' }])).why, /Only https/);
});

test('the whole try: read, check, run; each stage names its failure', async () => {
  const read = async () => ({ reads: { btc: { price: 5 } } });
  const parse = (await import('acorn').catch(() => null))?.parse;
  if (!parse) return;
  const ok = await testMarket({ code: 'function decide(reads, market) {\n  return reads.btc.price;\n}' }, { read, parse });
  assert.equal(ok.out, 5);
  assert.equal((await testMarket({ code: 'function decide() {\n  return eval("1");\n}' }, { read, parse })).stage, 'check');
  assert.equal((await testMarket({ code: 'function decide() {\n  throw new Error("x");\n}' }, { read, parse })).stage, 'run');
  assert.equal((await testMarket({}, { read: async () => ({ why: 'no' }) })).stage, 'read');
});
