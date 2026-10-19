// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SCRIPTS A PAGE SERVES THAT DECIDE MONEY ARE THE BUILD OF THIS SOURCE.
//
// Measured (TASKBOOK, e625085): src/nwc.js was fixed at 967cf30 and the page
// did not get it - dist/arena-client.js and the WebGL template's copy still let
// 15 of 4096 stranger keys open a NIP-04 envelope, and the known-good list
// pinned exactly that bundle. The bundle had been stale since the DKG-agreement
// slice: the suites were run without tools/bundle.js, and the template and pin
// checks compare the two stale copies with each other, so no test could see it.
//
// This builds each of the three pinned scripts from the source in this tree
// into a scratch directory (the tools' ARENA_BUNDLE_OUT) and requires the
// committed dist file AND the template's copy to be those bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('../../../', import.meta.url).pathname;
const TEMPLATE = ROOT + 'unity-proto/Assets/WebGLTemplates/NextBlock/';
const BUILDS = [
  ['arena-client.js', 'packages/arena-client/tools/bundle.js', 'packages/arena-client/dist/arena-client.js'],
  ['blwp-curve.js', 'packages/arena-client/tools/bundle-curve.js', 'packages/arena-client/dist/blwp-curve.js'],
  ['blwp-core.js', 'packages/nextblock/tools/bundle.js', 'packages/nextblock/dist/blwp-core.js'],
];

test('each script a page serves that decides money is the build of the source in this tree - in dist and in the WebGL template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'blwp-fresh-'));
  try {
    const stale = [];
    for (const [name, tool, built] of BUILDS) {
      execFileSync(process.execPath, [ROOT + tool], { env: { ...process.env, ARENA_BUNDLE_OUT: dir }, stdio: 'pipe' });
      const fresh = readFileSync(join(dir, name));
      if (Buffer.compare(fresh, readFileSync(ROOT + built))) stale.push(`${name}: dist is not the build of this source`);
      if (Buffer.compare(fresh, readFileSync(TEMPLATE + name))) stale.push(`${name}: the WebGL template is not the build of this source`);
    }
    console.log(`  FACTS (freshness): ${stale.length ? stale.join('; ') : 'all three fresh in dist and the template'}`);
    assert.deepEqual(stale, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// THE LOCK CLIENT (W1b) IS NOT BUILT BY A NODE TOOL: it is the stock fedimint
// crates compiled to wasm with a Rust toolchain that is not on the shipping
// path (lock-client/Cargo.toml says how). So this cannot rebuild it from the
// source; what it holds is that the template serves exactly what dist
// commits, and that both are on the known-good list.
test('the WebGL template carries the lock client dist commits, byte for byte, and the list pins it', () => {
  const pins = JSON.parse(readFileSync(ROOT + 'packages/arena-client/known-good-clients.json', 'utf8')).pinned;
  const off = [];
  for (const name of ['blwp_lock_client.js', 'blwp_lock_client_bg.wasm']) {
    const committed = readFileSync(ROOT + 'packages/arena-client/dist/' + name);
    if (Buffer.compare(committed, readFileSync(TEMPLATE + name))) off.push(`${name}: the template is not dist's`);
    const sha = createHash('sha256').update(committed).digest('hex');
    if (!(pins[name] || []).includes(sha)) off.push(`${name}: dist's is not on the known-good list`);
  }
  assert.deepEqual(off, []);
});
