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
const FROM = { 'manifest-sign': '../../arena-donor/src/manifest-sign.js', ed25519: '../../arena-node/src/ed25519.js', host: '../../arena-node/src/plugins.js',
  'core-hash': '../../arena-node/src/core-hash.js' };

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
  // the import and export statements and import() calls, as pack.mjs reads them - not a "from '" inside a string or a comment's prose
  return filesOf(join(base, sub)).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1] || m[2])
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

// NEXT BLOCK'S CORE HASH IS THE NODE'S RULE (kanban #691, 2026-10-26: "All apps should reference the SDK and not use local copies"): its
// tools/hash-core.js wrote the tree rule out a second time beside the sandbox's; it now takes arena-sdk/core-hash, and every core it
// keeps still hashes to its name. A core's own files (src/, frozen/<hash>/) import only each other - a core runs in the sandbox, where
// no package resolves - so its sha256.js stays the core's own copy, held to the engine's digests by its engine-shared test.
test('next block imports only itself, arena-sdk and its npm packages (acorn, React); its cores hash by the node\'s rule, to their names', async () => {
  const npm = /: (acorn|react|react-dom)(\/|$)/;
  for (const d of ['plugin', 'tools', 'test', 'page', 'config', 'view']) assert.deepEqual(outside('nextblock', d).filter((s) => !npm.test(s)), [], d);
  assert.deepEqual(outside('nextblock', 'src'), [], 'src: the core imports only itself');
  const { coreHashHex } = await import('../../nextblock/tools/hash-core.js');
  const { coreTreeHashHex } = await import('arena-sdk/core-hash');
  const src = fileURLToPath(new URL('../../nextblock/src', import.meta.url));
  assert.equal(coreHashHex(), coreTreeHashHex(src));
  assert.ok(coreHashHex().startsWith('a5c5766a'), 'core/src is a5c5766a');
  const frozen = fileURLToPath(new URL('../../nextblock/frozen', import.meta.url));
  for (const h of readdirSync(frozen)) assert.ok(coreHashHex(join(frozen, h)).startsWith(h), `frozen/${h}`);
});
