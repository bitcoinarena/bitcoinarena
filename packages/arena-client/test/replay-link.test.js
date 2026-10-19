// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// COPY GAME REPLAY (2026-09-25 18:39): one https link, a random committee node of the round from its
// advertisement endpoints (ws becomes https), the same path on every node: /replay?round=<hex>&entry=<hex>.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { replayLinkFor, httpsOfEndpoint } from '../src/replay-link.js';

const R = 'ab'.repeat(32), E = 'cd'.repeat(32);
const ENDPOINTS = ['ws://127.0.0.1:18571', 'wss://node-b.example:443/', 'https://node-c.example'];

test('ws and wss become https; anything that is not an endpoint is none', () => {
  assert.deepEqual(ENDPOINTS.map(httpsOfEndpoint), ['https://127.0.0.1:18571', 'https://node-b.example:443', 'https://node-c.example']);
  assert.equal(httpsOfEndpoint('not an endpoint'), null);
});

test('the host is a random committee endpoint, and the path is the same on every one', () => {
  const seen = new Set();
  for (const r of [0, 0.34, 0.5, 0.67, 0.999]) {
    const link = replayLinkFor({ endpoints: ENDPOINTS, roundHex: R, entryHex: E, random: () => r });
    assert.equal(link.ok, true);
    assert.equal(new URL(link.url).protocol, 'https:');
    assert.equal(`${new URL(link.url).pathname}${new URL(link.url).search}`, `/replay?round=${R}&entry=${E}`);
    seen.add(link.host);
  }
  assert.deepEqual([...seen].sort(), ENDPOINTS.map(httpsOfEndpoint).sort(), 'the random pick does not reach every endpoint');
});

test('no endpoint, or ids that are not 32-byte hex, is no link, said by name', () => {
  assert.match(replayLinkFor({ endpoints: [], roundHex: R, entryHex: E }).why, /names no committee endpoint/);
  assert.match(replayLinkFor({ endpoints: ENDPOINTS, roundHex: 'zz', entryHex: E }).why, /names a round and an entry/);
});

test('the page copies the link the bundle builds: its hook, and the bundle carrying replayLinkFor and decodeEntryContract', () => {
  const page = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
  assert.match(page, /window\.BLWP_COPY_REPLAY = async \(roundHex, entryHex, nodes\)/);
  assert.match(page, /BLWPCLIENT\.replayLinkFor\(/);
  assert.match(page, /navigator\.clipboard\.writeText\(link\.url\)/);
  const bundle = createRequire(import.meta.url)('../dist/arena-client.js');
  assert.equal(typeof bundle.replayLinkFor, 'function');
  assert.equal(typeof bundle.decodeEntryContract, 'function');
  assert.equal(bundle.replayLinkFor({ endpoints: ['ws://h:1'], roundHex: R, entryHex: E }).url, `https://h:1/replay?round=${R}&entry=${E}`);
});
