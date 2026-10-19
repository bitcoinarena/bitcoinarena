// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THRESHOLD_LN CUT (2026-10-03: "Cut lnd-port.js and lnd-settings.js"): the two files are gone, nothing imports
// either path again, and what their callers still use - lndPort, lightningFromEnv, LND_SETTINGS - lives in node-start.js,
// the module both main.js and tools/round-2of2.mjs already import. No shim re-exports the old paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgs = join(here, '..', '..');
const files = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (n === 'node_modules' || n.startsWith('.')) return [];
  return statSync(p).isDirectory() ? files(p) : /\.(m?js)$/.test(n) ? [p] : [];
});

test('lnd-port.js and lnd-settings.js are gone, and no source, tool or test imports either path', () => {
  assert.equal(existsSync(join(here, '..', 'src', 'lnd-port.js')), false, 'lnd-port.js came back');
  assert.equal(existsSync(join(here, '..', 'src', 'lnd-settings.js')), false, 'lnd-settings.js came back');
  const importing = [];
  for (const pkg of ['arena-node', 'arena-protocol', 'arena-client']) {
    for (const sub of ['src', 'tools', 'test']) {
      const dir = join(pkgs, pkg, sub);
      if (!existsSync(dir)) continue;
      for (const f of files(dir))
        if (/(import|export)[^;]*from\s+['"][^'"]*lnd-(port|settings)\.js['"]|import\(\s*['"][^'"]*lnd-(port|settings)\.js/.test(readFileSync(f, 'utf8'))) importing.push(f);
    }
  }
  assert.deepEqual(importing, [], 'a file imports a deleted path');
});

test('the moved helpers are where their callers import them, and satisfy them', async () => {
  const ns = await import('../src/node-start.js');
  for (const name of ['lndPort', 'lightningFromEnv', 'LND_SETTINGS']) assert.ok(ns[name], `node-start.js has no ${name}`);
  // main.js and tools/round-2of2.mjs import lightningFromEnv from node-start.js and use .given / .lightning
  for (const caller of [join(here, '..', 'src', 'main.js'), join(here, '..', 'tools', 'round-2of2.mjs')]) {
    const src = readFileSync(caller, 'utf8');
    const m = /import \{([^}]*)\} from '(?:\.\.\/src|\.)\/node-start\.js'/.exec(src);
    assert.ok(m, `${caller} does not import from node-start.js`);
    for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) assert.ok(n in ns, `${caller} imports ${n}, which node-start.js lacks`);
  }
  const off = ns.lightningFromEnv({});
  assert.deepEqual(off, { ok: true, given: false });
  const on = ns.lightningFromEnv({ ARENA_LNCLI: 'lncli', ARENA_LND_DIR: '/d', ARENA_LND_RPC: '127.0.0.1:1', ARENA_LND_NETWORK: 'testnet4' });
  assert.equal(on.ok && on.given, true);
  assert.equal(typeof on.lightning.invoice, 'function');
  assert.equal(typeof on.lightning.decode, 'function');
  // stake-lock-port.js and server.js named lnd-port.js only in comments: they load with it gone
  await import('../src/stake-lock-port.js');
  await import('../src/server.js');
});
