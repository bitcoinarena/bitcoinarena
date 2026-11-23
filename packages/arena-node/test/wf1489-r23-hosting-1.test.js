// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r23-hosting-1: A STORE PACKAGE MAY NAME ANY NUMBER OF CORES (manifest.js: a REPLAY game names "at least one", the vec is
// u16 - up to 65535; checkPackage and plugin-package.js count none). Every core is loaded in its own sandbox thread, synchronously on the
// seat's thread (Atomics.wait): registrationFromPackage loads each (sandboxChecked), and hostedPlugins loads each again - on adoptPackage
// (an owner's install, or autoUpdate taking the developer's next version unattended) and at every start (loadInstalled). The trial's
// one deadline (TRIAL_MS) is per core, never per package. So one developer-signed version with many tiny honest cores holds the seat's
// thread for N x (two thread starts): no round, no HTTP answer meanwhile.
// Safe behaviour: a package's checks and first loads hold the seat's thread for a bound that does not grow with its core count
// (here: at most 3 s for the whole package), or a package with that many cores is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { hostedPlugins } from '../src/plugins.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testGame, testDonationSet } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');

test('#1489 r23-hosting-1: a package with many cores holds the seat thread in proportion to its core count', async () => {
  const name = 'many-cores', N = 150, cfg = '11'.repeat(32);
  const cores = new Map(), files = [];
  for (let i = 0; i < N; i++) {
    const src = `export const DECIDE = { name: 'many-cores', decide(moves) { return {}; } };\n// ${i}\n`;
    const hash = sha(Buffer.from(src));
    cores.set(hash, { name, hash, configs: new Map([[cfg, {}]]) });
    files.push({ hash, name, configs: [cfg], source: Buffer.from(src).toString('base64') });
  }
  const game = testGame({ name, cores, runTicksMax: 100 });
  const gameId = toHex(gameIdOf(game.manifest));
  const pkg = { format: 'arena-plugin/v1', name, manifest: toHex(encodeManifest(game.manifest)),
    donationSet: testDonationSet(name).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    cores: files, clients: [] };
  const bytes = Buffer.byteLength(JSON.stringify(pkg));
  const t0 = Date.now();
  const v = verifyPackage(pkg, { verify: verifyEd25519, want: gameId });
  const t1 = Date.now();
  console.log(`  FACTS r23-hosting-1: ${N} cores, package ${bytes} bytes; verifyPackage ok=${v.ok} ${v.why || ''} in ${t1 - t0} ms`);
  if (!v.ok) return;   // refused: safe
  const at = installPackage(mkdtempSync(join(tmpdir(), 'wf1489-r23-hosting-1-')), pkg, gameId);
  const reg = await registrationFromPackage(at, pkg);
  const t2 = Date.now();
  const hosted = hostedPlugins([reg], { verify: verifyEd25519 });
  const t3 = Date.now();
  const held = t3 - t0;
  console.log(`  FACTS r23-hosting-1: registrationFromPackage ${t2 - t1} ms, hostedPlugins ${t3 - t2} ms (hosted=${hosted.has(gameId)}); `
    + `seat thread held ${held} ms = ${(held / N).toFixed(1)} ms per core -> 65535 cores (u16 vec, ~16 MB package) about ${Math.round(held / N * 65535 / 60000)} min`);
  assert.ok(held < 3000, `a ${N}-core package held the seat's thread ${held} ms; the bound grows with the core count`);
});
