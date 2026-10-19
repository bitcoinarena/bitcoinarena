// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LARGER TRUCK'S CORE ON THE PAGE: the template carries blwp-core-f0cc7b7b.js and loads it only for a round
// that names f0cc7b7b - fetched, checked against the pinned sha256, run in its own function (the page's BLWP untouched), kept by
// its core hash; a file that is not the pinned bytes is refused. And the shop and the run's items are wired into the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';

const T = new URL('../../../src/arena-ui/', import.meta.url);
const html = readFileSync(new URL('index.html', T), 'utf8');
const F0CC = 'f0cc7b7b2e75e350149ff8a6e58a1cc861a3ab4969d1c81b2206564b57ffb7a8';
const file = readFileSync(new URL('blwp-core-f0cc7b7b.js', T));
const LIST = JSON.parse(readFileSync(new URL('../known-good-clients.json', import.meta.url), 'utf8'));

function loader(bytesFor) {
  const i = html.indexOf('    window.ARENA_CORE_FILES = '), j = html.indexOf('  </script>', i);
  const window = { ARENA_CORES: {}, BLWP: 'the page\'s own core' };
  const ctx = vm.createContext({ window, crypto: webcrypto, TextDecoder, console: { log() {}, error() {} },
    fetch: async (f) => ({ ok: true, status: 200, arrayBuffer: async () => { const b = bytesFor(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } }) });
  vm.runInContext(html.slice(i, j), ctx);
  return window;
}

test('the core file is the bundle pinned for nextblock, and the page loads it only by name, checked and kept apart', async () => {
  const sha = createHash('sha256').update(file).digest('hex');
  assert.equal(sha, '319763d01161c46becd18219f6134864338db9bf9f30205b73e6eb13f643333a');
  assert.ok(LIST.games.nextblock.pinned['blwp-core.js'].includes(sha), 'pinned in known-good-clients.json');
  assert.equal(sha, createHash('sha256').update(readFileSync(new URL('../../nextblock/dist/blwp-core-f0cc7b7b.js', import.meta.url))).digest('hex'), 'the dist bundle');
  assert.ok(!/<script src="blwp-core-f0cc7b7b\.js"/.test(html), 'not a script tag every page load pays for');
  const w = loader(() => file);
  const t0 = Date.now();
  const got = await w.ARENA_LOAD_CORE(F0CC);
  assert.deepEqual({ ...got }, { ok: true, hex: F0CC });
  assert.equal(typeof w.ARENA_CORES[F0CC].init, 'function');
  assert.equal(w.BLWP, 'the page\'s own core', 'loading it does not replace the page\'s BLWP');
  // the core it loaded plays the larger truck with its unlock
  const st = w.ARENA_CORES[F0CC].init(0x5eed1234, { items: ['10dec674eb2f698400bb775c508e727d9c15734a6e7056889d12bb0ebab54d69'] });
  assert.deepEqual({ ...st.truck }, { bedLength: 255590, topSpeed: 2235175, driveAccel: 327844 });
  assert.equal(w.ARENA_CORES[F0CC].init(0x5eed1234, {}).truck, null);
  console.log(`  FACTS: loaded ${file.length} bytes, sha ${sha.slice(0, 16)}, in ${Date.now() - t0} ms; the larger truck's state: ${JSON.stringify(st.truck)}`);
  // another hash is not this page's, and a tampered file is refused
  assert.equal((await w.ARENA_LOAD_CORE('ab'.repeat(32))).ok, false);
  const bad = loader(() => Buffer.concat([file, Buffer.from('\n// tampered')]));
  const no = await bad.ARENA_LOAD_CORE(F0CC);
  assert.equal(no.ok, false);
  assert.match(no.why, /hashes to .*, not the pinned 319763d01161c46b/);
  assert.equal(bad.ARENA_CORES[F0CC], undefined);
});

test('the shop, the run\'s items and their unlocks are wired into the page', () => {
  assert.match(html, /id="arena-shop-go"/);
  assert.match(html, /id="arena-shop"/);
  assert.match(html, /BLWPCLIENT\.buyItem\(/);
  assert.match(html, /BLWPCLIENT\.entryItemsFor\(/);
  assert.match(html, /frontendPk: pageFrontendPk\(\), items: runItems,/);
  assert.match(html, /window\.BLWP_ITEM_UNLOCKS = roundManifest \? BLWPCLIENT\.entryUnlocks\(window\.BLWP_ENTRY, roundManifest\) : \[\];/);
  assert.match(html, /await window\.ARENA_LOAD_CORE\(BLWPCLIENT\.roundCoreHex\(named\.round\)\)/);
  const jslib = readFileSync(new URL('../../../unity-proto/Assets/Plugins/WebGL/arena.jslib', import.meta.url), 'utf8');
  assert.equal((jslib.match(/b\.core\.init\(net\.seedWord, blwpWithItems\(/g) || []).length, 2, 'both run starts take the unlocks');
  assert.match(jslib, /ArenaTruckBed: function/);
});
