// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r23-hosting-3: A CORE MAY NAME ANY NUMBER OF CONFIGS (manifest.js: "at least one", a u16 vec - up to 65535 x 32 bytes, a
// 4 MB manifest, inside a 16 MB package), and plugins.js hostedPlugins checks them quadratically: for each installed config it scans the
// manifest's whole list with toHex - C x C hex encodings on the seat's thread. hostedPlugins runs on every adoptPackage (an owner's
// install, or autoUpdate taking the developer's next signed version unattended), at every start for every installed version (server.js
// serve), and a head-to-head game's single decide adapter may carry them too (the trial does not look at configs).
// Safe behaviour: the config check is linear (or the count bounded): a core with 3000 configs is hosted in well under a second.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { hostedPlugins } from '../src/plugins.js';
import { MAX_MANIFEST_BYTES } from '../src/plugin-check.js';   // kanban #3847
import { verifyEd25519 } from '../src/ed25519.js';
import { testGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');

async function hostWith(C) {
  const name = `many-configs-${C}`;
  const src = `export const DECIDE = { name: 'many-configs', decide(moves) { return {}; } };\n`;
  const hash = sha(Buffer.from(src));
  const cfgs = Array.from({ length: C }, (_, i) => sha(`config ${i}`));
  const cores = new Map([[hash, { name, hash, configs: new Map(cfgs.map((h) => [h, {}])) }]]);
  const game = testGame({ name, cores, runTicksMax: 100 });
  const gameId = toHex(gameIdOf(game.manifest));
  const pkg = { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: [{ hash, name, configs: cfgs, source: Buffer.from(src).toString('base64') }], clients: [] };
  const v = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
  // kanban #3847: the count is now bounded - a manifest past MAX_MANIFEST_BYTES (here 1500 or 3000 configs) is refused at once, and
  // hostedPlugins leaves it out without a config check; within the bound (400 configs) the check stays linear
  if (pkg.manifest.length / 2 > MAX_MANIFEST_BYTES) {
    assert.equal(v.ok, false); assert.match(v.why, /its manifest is \d+ bytes, more than/);
    const t0 = Date.now();
    assert.throws(() => hostedPlugins([game], { verify: verifyEd25519, log: () => {} }), /more than the \d+ a seat hosts/);
    return Date.now() - t0;
  }
  assert.ok(v.ok, v.why);
  const at = installPackage(mkdtempSync(join(tmpdir(), 'wf1489-r23-hosting-3-')), pkg, gameId);
  const reg = await registrationFromPackage(at, pkg);
  const t0 = Date.now();
  const hosted = hostedPlugins([reg], { verify: verifyEd25519 });
  const ms = Date.now() - t0;
  console.log(`  FACTS r23-hosting-3: ${C} configs (manifest ${pkg.manifest.length / 2} bytes): hostedPlugins held the thread ${ms} ms, hosted=${hosted.has(gameId)}`);
  return ms;
}

test('#1489 r23-hosting-3: hostedPlugins checks a core\'s configs in C x C', async () => {
  const a = await hostWith(1500);
  const b = await hostWith(3000);
  assert.ok(await hostWith(400) < 1000, 'a core with 400 configs (within MAX_MANIFEST_BYTES) is hosted in under a second');   // kanban #3847
  console.log(`  FACTS r23-hosting-3: doubling the configs took ${(b / Math.max(1, a)).toFixed(1)}x; 65535 configs (a 4 MB manifest) about ${Math.round(b * (65535 / 3000) ** 2 / 60000)} min`);
  assert.ok(b < 1000, `a core with 3000 configs held the seat's thread ${b} ms in hostedPlugins (quadratic)`);
});
