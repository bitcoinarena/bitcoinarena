// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ONE DOOR A GAME IMPORTS THE ARENA THROUGH (kanban #568, 2026-10-21: "Make the games in a way that they are stand alone and can be
// outsourced to its own GitHub repository. Arena loads them"): every arena-sdk subpath is the protocol's own module - the same bindings,
// so a game and the seat that hosts it share one manifest codec and one hash - and a game moved onto it imports nothing else of the Arena,
// its id unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// the two that are not the protocol's: manifest signing (the developer's tools) and its ed25519
const FROM = { 'manifest-sign': '../../arena-donor/src/manifest-sign.js', ed25519: '../../arena-node/src/ed25519.js', host: '../../arena-node/src/plugins.js' };

test('every subpath is the Arena module itself', async () => {
  for (const sub of Object.keys(pkg.exports)) {
    const name = sub.slice(2);
    const viaSdk = await import(`arena-sdk/${name}`);
    const own = await import(FROM[name] || `../../arena-protocol/src/${name}.js`);
    assert.deepEqual(Object.keys(viaSdk).sort(), Object.keys(own).sort(), name);
    for (const k of Object.keys(own)) assert.equal(viaSdk[k], own[k], `${name}.${k} is the same binding`);
  }
});

// every import of a game's files: its own (./ or ../ inside it) or arena-sdk - nothing else of the Arena
const filesOf = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); if (f === 'node_modules') return [];
  return statSync(p).isDirectory() ? filesOf(p) : /\.(m?js|jsx)$/.test(f) ? [p] : []; });
const outside = (game, sub = '') => {
  const base = join(root, '..', game);
  return filesOf(join(base, sub)).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/(?:from|import\()\s*'([^']+)'/g)].map((m) => m[1])
    .filter((s) => (s.startsWith('.') ? !join(f, '..', s).startsWith(base + '/') : !s.startsWith('arena-sdk/') && !s.startsWith('node:')))
    .map((s) => `${f.slice(base.length + 1)}: ${s}`));
};

test('hello-world imports only itself and arena-sdk, and its game id is what the network knows', async () => {
  assert.deepEqual(outside('hello-world'), []);
  const { GAME } = await import('../../hello-world/plugin/hello-world.js');
  assert.equal(Buffer.from(GAME.gameId).toString('hex'), '32ee1aa45e485eb2bc6b35d118a79f9724ab8019a0ceeb71eda45a84200c130f');
});

test('rock-paper-scissors imports only itself and arena-sdk (plugin, tools, tests, its view); its four ids are the network\'s and its cores the hashed bytes', async () => {
  for (const d of ['plugin', 'tools', 'test']) assert.deepEqual(outside('rock-paper-scissors', d), [], d);
  assert.deepEqual(outside('rock-paper-scissors', 'view').filter((s) => !/: react/.test(s)), [], 'view: React and itself only');
  const ids = {};
  for (const v of ['', '-v2', '-v3', '-v4']) ids[v || 'v1'] = Buffer.from((await import(`../../rock-paper-scissors/plugin/rock-paper-scissors${v}.js`)).GAME.gameId).toString('hex').slice(0, 16);
  assert.deepEqual(ids, { v1: '1e9ab4b7d402d51f', '-v2': 'a75f54fd4f978a29', '-v3': '90f462c823bdd382', '-v4': '13699356aae534ee' });
});

test('bitcoin up or down imports only itself and arena-sdk (plugin, tools, tests, page); the frozen testnet4 market\'s id is the network\'s', async () => {
  assert.deepEqual(outside('btc-updown', 'plugin'), []);
  assert.deepEqual(outside('btc-updown', 'tools'), []);
  assert.deepEqual(outside('btc-updown', 'test'), []);
  assert.deepEqual(outside('btc-updown', 'page'), []);
  const { GAME } = await import('../../btc-updown/plugin/btc-updown.js');
  assert.equal(Buffer.from(GAME.gameId).toString('hex').slice(0, 16), '672415c814e61b47', 'the frozen testnet4 market');
});
