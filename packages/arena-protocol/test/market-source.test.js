// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHERE A MARKET'S RESULT COMES FROM (kanban #920): in the manifest's bytes behind its own marker, read back the same; a manifest without it keeps its bytes; what does not fit is refused
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeManifestBody, manifestBodyId, MARKET_SOURCE_MARKER, RESULT_TYPE, PAYOUT_RULE, NO_PARENT, MARKET_SOURCE_KIND, MARKET_READ, MARKET_RULE, decodeManifest, encodeManifest } from '../src/manifest.js';
import { codeOfSource, outcomeIndex } from '../src/market-rule.js';
import { MARKET_HOSTS, decodeHostList, encodeSourceList, hostListProblem, marketHostProblem } from '../src/market-check.js';
import { SOURCES_GENESIS } from '../src/ballot-chain.js';
import { CLASS, isHostRemoval } from '../src/ballot.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const BODY = { gameName: 'btc-100k', gameDevPubkey: b32(1), version: 1, parentManifestId: NO_PARENT, resultType: RESULT_TYPE.ATTESTED, cores: [], runTicksMax: 0, roundPeriodMs: 0n,
  payoutRule: PAYOUT_RULE.PARI_MUTUEL, rankNumerator: 0, rankDenominator: 0, minScore: 0, clients: [], gameDonationSetId: b32(0xd0), outcomes: ['Yes', 'No'], attestors: [], attestThreshold: 0,
  attestDraw: { count: 7, threshold: 5 }, requiredProtocolVersion: 2 };
const read = { id: 'page', socket: false, url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', subscribe: '' };
const URL_SOURCE = { kind: MARKET_SOURCE_KIND.URL, reads: [read], read: MARKET_READ.JSON, path: 'data.amount', rule: MARKET_RULE.ABOVE, level: '100000' };
const CODE_SOURCE = { kind: MARKET_SOURCE_KIND.CODE, reads: [{ ...read, id: 'btc' }, { id: 'feed', socket: true, url: 'wss://ws-feed.exchange.coinbase.com', subscribe: '{"type":"subscribe"}' }], code: 'function decide() {\n  return 0;\n}', checkVersion: 1 };

test('each source comes back as written, and only after its marker', () => {
  for (const source of [URL_SOURCE, CODE_SOURCE]) {
    const m = { ...BODY, source, signature: new Uint8Array(64) };
    const back = decodeManifest(encodeManifest(m));
    assert.deepEqual(back.source, source);
    assert.deepEqual(encodeManifest(back), encodeManifest(m));
  }
  assert.ok(encodeManifestBody({ ...BODY, source: URL_SOURCE }).includes(MARKET_SOURCE_MARKER));
  assert.notDeepEqual(manifestBodyId(BODY), manifestBodyId({ ...BODY, source: URL_SOURCE }));
});

test('what does not fit is refused by name', () => {
  const body = (source, more = {}) => ({ ...BODY, ...more, source });
  for (const [m, why] of [
    [body(URL_SOURCE, { attestDraw: undefined, attestors: [b32(2)], attestThreshold: 1 }), /drawn per round/],
    [body({ ...URL_SOURCE, kind: 9 }), /URL or code/],
    [body({ ...URL_SOURCE, reads: [{ ...read, url: 'http://a.example/' }] }), /Only https/],
    [body({ ...URL_SOURCE, reads: [{ ...read, url: 'https://127.0.0.1/' }] }), /public host/],
    [body({ ...URL_SOURCE, reads: [read, { ...read, id: 'b' }] }), /one address/],
    [body({ ...CODE_SOURCE, reads: [read, read] }), /of its own/],
    [body({ ...CODE_SOURCE, reads: [1, 2, 3, 4].map((n) => ({ ...read, id: `a${n}` })) }), /at most 3/],
    [body({ ...CODE_SOURCE, code: 'x'.repeat(40000) }), /KB/],
    [body({ ...CODE_SOURCE, checkVersion: 99 }), /check this node knows/],
  ]) assert.throws(() => encodeManifestBody(m), why);
});

test('a URL source is code like any other: a fixed function, the market only its values', () => {
  const code = codeOfSource({ ...URL_SOURCE, path: '"; process.exit(); "' });
  assert.match(code, /^const SOURCE = \{/);
  assert.ok(!code.includes('\n"; process'));
  assert.equal(codeOfSource(CODE_SOURCE), CODE_SOURCE.code);
  assert.equal(outcomeIndex('No', ['Yes', 'No']), 1); assert.equal(outcomeIndex(0, ['Yes', 'No']), 0); assert.equal(outcomeIndex('Maybe', ['Yes', 'No']), null); assert.equal(outcomeIndex(5, ['Yes', 'No']), null);
});

const entry = (host, more = {}) => ({ host, url: `https://${host}/x`, read: 'text', path: '', docs: `https://${host}/docs`, ...more });
test('a list is one canonical thing, public names only, each host with an example and its docs; dropping a host is fast, adding one is not', () => {
  const list = encodeSourceList([entry('b.example.org'), entry('a.example.org'), entry('a.example.org')]);
  assert.deepEqual(decodeHostList(list), ['a.example.org', 'b.example.org']);
  assert.equal(hostListProblem(list), null);
  assert.equal(hostListProblem(SOURCES_GENESIS.config), null);
  assert.deepEqual([...decodeHostList(SOURCES_GENESIS.config)].sort(), [...MARKET_HOSTS].sort());
  const bytes = (s) => new TextEncoder().encode(s);
  for (const bad of ['', 'localhost\thttps://localhost/\ttext\t\thttps://d.example/', 'a.ts.net\thttps://a.ts.net/\ttext\t\thttps://d.example/']) assert.ok(hostListProblem(bytes(bad)), bad);
  assert.match(hostListProblem(encodeSourceList([entry('a.example.org', { url: 'https://b.example.org/x' })])), /example address on that host/);
  assert.match(hostListProblem(encodeSourceList([entry('a.example.org', { url: '' })])), /example address/);
  assert.match(hostListProblem(encodeSourceList([entry('a.example.org', { read: 'json' })])), /what it reads/);
  assert.match(hostListProblem(encodeSourceList([entry('a.example.org', { docs: '' })])), /documentation/);
  const history = [{ config: encodeSourceList([entry('a.example.org'), entry('b.example.org')]) }];
  assert.equal(isHostRemoval({ class: CLASS.SOURCES, config: encodeSourceList([entry('a.example.org')]) }, history), true);
  assert.equal(isHostRemoval({ class: CLASS.SOURCES, config: encodeSourceList([entry('a.example.org'), entry('c.example.org')]) }, history), false);
  assert.equal(marketHostProblem('https://b.example.org/x', ['b.example.org']), null);
  assert.match(marketHostProblem('https://attacker.example/x'), /not a listed source/);
});
