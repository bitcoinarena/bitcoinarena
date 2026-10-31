// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NEXT BLOCK VERSION 5'S CORES ON THE PAGE (kanban #523): core-a5c5766a.js and core-0847c99f.js, the cores with their comments
// cleaned of names, ticket numbers and blwp - each the bundle version 5 pins (games.nextblock.pinnedV5), byte for byte the app's
// dist file, loaded only when a round names it, checked, run apart from the page's BLWP and kept by its core hash; the truck that
// knows the larger truck plays it exactly as f0cc7b7b does. A file that is not the pinned bytes is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';

const T = new URL('../../../src/arena-ui/', import.meta.url);
const html = readFileSync(new URL('index.html', T), 'utf8');
const LIST = JSON.parse(readFileSync(new URL('../known-good-clients.json', import.meta.url), 'utf8'));
const CORES = {
  a5c5766a: 'a5c5766a7902b6703ebe9382cea9154adc777af3e5cafa766265e971efa52c5a',
  '0847c99f': '0847c99f60e694e106fce0a79ac252b3e6170a343db52a95e3b5052a7e00a5f1',
};
const F0CC = 'f0cc7b7b2e75e350149ff8a6e58a1cc861a3ab4969d1c81b2206564b57ffb7a8';
const LARGE_TRUCK = '10dec674eb2f698400bb775c508e727d9c15734a6e7056889d12bb0ebab54d69';
const sha = (b) => createHash('sha256').update(b).digest('hex');

function loader(bytesFor) {
  const i = html.indexOf('    window.ARENA_CORE_FILES = '), j = html.indexOf('  </script>', i);
  const window = { ARENA_CORES: {}, BLWP: 'the page\'s own core' };
  const ctx = vm.createContext({ window, crypto: webcrypto, TextDecoder, console: { log() {}, error() {} },
    fetch: async (f) => ({ ok: true, status: 200, arrayBuffer: async () => { const b = bytesFor(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } }) });
  vm.runInContext(html.slice(i, j), ctx);
  return window;
}
const fileOf = (f) => readFileSync(new URL(f, T));

test('each version-5 core file is the bundle pinned for it, the app\'s own bytes, with no name, ticket number or blwp', () => {
  for (const [short, hex] of Object.entries(CORES)) {
    const name = `core-${short}.js`, file = fileOf(name);
    assert.deepEqual(LIST.games.nextblock.pinnedV5[name], [sha(file)], `${name} pinned for version 5`);
    assert.equal(sha(file), sha(readFileSync(new URL(`../../nextblock/dist/${name}`, import.meta.url))), `${name} is the app's dist bundle`);
    assert.doesNotMatch(file.toString('utf8'), /blwp|kanban|owner/i);
    assert.ok(!html.includes(`<script src="${name}"`), 'not a script tag every page load pays for');
    assert.match(html, new RegExp(`'${hex}':\\s*\\{ file: '${name.replace('.', '\\.')}', sha256: '${sha(file)}' \\}`));
  }
});

test('the page loads each only by name, checked and kept apart; 0847c99f plays the larger truck as f0cc7b7b does', async () => {
  const w = loader((f) => fileOf(f));
  for (const hex of Object.values(CORES)) {
    assert.deepEqual({ ...(await w.ARENA_LOAD_CORE(hex)) }, { ok: true, hex });
    assert.equal(typeof w.ARENA_CORES[hex].init, 'function');
  }
  assert.equal(w.BLWP, 'the page\'s own core', 'loading them does not replace the page\'s BLWP');
  await w.ARENA_LOAD_CORE(F0CC);
  const large = (hex) => JSON.stringify(w.ARENA_CORES[hex].init(0x5eed1234, { items: [LARGE_TRUCK] }).truck);
  assert.equal(large(CORES['0847c99f']), large(F0CC), 'the larger truck, as f0cc7b7b plays it');
  assert.equal(w.ARENA_CORES[CORES['0847c99f']].init(0x5eed1234, {}).truck, null);
  const bad = loader((f) => Buffer.concat([fileOf(f), Buffer.from('\n// tampered')]));
  const no = await bad.ARENA_LOAD_CORE(CORES.a5c5766a);
  assert.equal(no.ok, false);
  assert.match(no.why, /hashes to .*, not the pinned 85a94c656db4bdb7/);
});

// VERSION 7'S CORE (kanban #828): as version 5's, loaded only when a round names it. It reaches a round once version 7 is signed.
test('core-8cbc74b2.js is the bundle pinned for version 7, the app\'s own bytes, and the page loads it by its hash', async () => {
  const name = 'core-8cbc74b2.js', file = fileOf(name), hex = '8cbc74b27bee78727fa395fcc5e5181beb4072f837adbee0e9ea278ff427d387';
  assert.deepEqual(LIST.games.nextblock.pinnedV7[name], [sha(file)]);
  assert.equal(sha(file), sha(readFileSync(new URL(`../../nextblock/dist/${name}`, import.meta.url))), 'the app\'s dist bundle');
  assert.doesNotMatch(file.toString('utf8'), /blwp|kanban|owner/i);
  const window = loader((f) => fileOf(f));
  const loaded = await window.ARENA_LOAD_CORE(hex);
  assert.equal(loaded.ok, true, loaded.why);
  const at = (slot) => window.ARENA_CORES[hex].hash(window.ARENA_CORES[hex].init(0x4242, { slot }));
  assert.notEqual(at(5), at(6), 'the slot reaches the loaded core');
});
