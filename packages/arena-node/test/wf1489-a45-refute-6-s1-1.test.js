// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #1814 (a relaying seat chooses what an installed game runs): #1814 takes each core's configs from the
// signed manifest, but the SET of cores is still the package's. checkPackage only counts them (pkg.cores.length === named.size)
// and checks each is named - so a relaying seat that lists one signed core twice and drops the other passes every check, and the
// installing seat hosts the signed game without that core: every round on it refused, the version kept on disk that way.
// Safe behaviour: a package carrying a core twice (or missing one its manifest names) is refused, or every signed core is hosted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageOf, verifyPackage, installPackage, registrationFromPackage } from '../src/plugin-package.js';
import { hostedPlugins, coreOfGame } from '../src/plugins.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testDonationSet, testGame } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'a45r6-1-'));
const src = (tag) => `export const DECIDE = { name: 'duo ${tag}', decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };\n`;
function duoGame() {
  const cores = new Map();
  for (const [tag, cfg] of [['a', '22'.repeat(32)], ['b', '33'.repeat(32)]]) {
    const s = src(tag), file = join(srcDir, `decide-${tag}.mjs`); writeFileSync(file, s);
    const hash = sha(Buffer.from(s));
    cores.set(hash, { name: `duo ${tag}`, hash, url: pathToFileURL(file).href, configs: new Map([[cfg, {}]]) });
  }
  const g = testGame({ name: 'duo', cores, runTicksMax: 10, dev: 'duo dev', donationSet: testDonationSet('duo') });
  return { ...g, clientUrls: [] };
}

test('#1489 a45 refute #1814-1: a package that lists one signed core twice and drops the other is not hosted without it', async () => {
  const g = duoGame(), id = toHex(g.gameId), honest = packageOf(g);
  assert.equal(honest.cores.length, 2);
  const relayed = { ...honest, cores: [honest.cores[0], honest.cores[0]] };
  const v = verifyPackage(relayed, { verify: verifyEd25519, want: id });
  if (!v.ok) return; // refused: the fix holds
  const at = installPackage(mkdtempSync(join(tmpdir(), 'a45r6-1d-')), relayed, id);
  let h = null;
  try { h = hostedPlugins([await registrationFromPackage(at, relayed)], { log: () => {} }).get(id); } catch { return; /* refused: holds */ }
  for (const c of g.manifest.cores) {
    const r = coreOfGame({ simCoreHash: c.hash, configHash: c.configs[0] }, h);
    assert.equal(r.ok, true, `the package passed every check and is hosted, but a round on signed core ${toHex(c.hash).slice(0, 16)} is refused: ${r.why}`);
  }
});
