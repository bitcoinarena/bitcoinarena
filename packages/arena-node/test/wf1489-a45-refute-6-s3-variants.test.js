// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute (skeptic 3) of #1814, #2240, #2307: variants a relaying seat may try on the seat's own checks
// (these are expected to HOLD on abb6925b4; they are the skeptic's record of what was tried).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageOf, verifyPackage, installPackage, registrationFromPackage, loadInstalled } from '../src/plugin-package.js';
import { hostedPlugins, coreOfGame } from '../src/plugins.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testDonationSet, testGame } from './plugins/sign.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const srcDir = mkdtempSync(join(tmpdir(), 'a45r6s3-'));
const src = (tag) => `export const DECIDE = { name: 'trio ${tag}', decide(moves) { const out = {}; for (const m of moves) out[m.key] = 'DRAW'; return out; } };\n`;
function trioGame() {
  const cores = new Map();
  for (const [tag, cfg] of [['a', '22'.repeat(32)], ['b', '33'.repeat(32)]]) {
    const s = src(tag), file = join(srcDir, `decide-${tag}.mjs`); writeFileSync(file, s);
    const hash = sha(Buffer.from(s));
    cores.set(hash, { name: `trio ${tag}`, hash, url: pathToFileURL(file).href, configs: new Map([[cfg, {}]]) });
  }
  const g = testGame({ name: 'trio', cores, runTicksMax: 10, dev: 'trio dev', donationSet: testDonationSet('trio') });
  return { ...g, clientUrls: [] };
}
const allRoundsServed = (g, h) => { for (const c of g.manifest.cores) for (const cfg of c.configs) { const r = coreOfGame({ simCoreHash: c.hash, configHash: cfg }, h); if (!r.ok) return r.why; } return null; };

test('s3 variants: relayed configs in any shape are ignored - the hosted configs are the manifest\'s', async () => {
  const g = trioGame(), id = toHex(g.gameId), honest = packageOf(g);
  const shapes = [[], ['44'.repeat(32)], 'zz', {}, null, [123], ['22'.repeat(32).toUpperCase()]];
  for (const configs of shapes) {
    const relayed = { ...honest, cores: honest.cores.map((c) => ({ ...c, configs })) };
    let v; try { v = verifyPackage(relayed, { verify: verifyEd25519, want: id }); } catch (e) { assert.fail(`verify throws on configs ${JSON.stringify(configs)}: ${e.message}`); }
    if (!v.ok) continue;
    const at = installPackage(mkdtempSync(join(tmpdir(), 'a45r6s3d-')), relayed, id);
    const h = hostedPlugins([await registrationFromPackage(at, relayed)], { log: () => {} }).get(id);
    assert.ok(h, `configs ${JSON.stringify(configs)}: not hosted`);
    assert.equal(allRoundsServed(g, h), null, `configs ${JSON.stringify(configs)}`);
  }
});

test('s3 variants: one core twice under another spelling of its hash, or a core not named, is refused', async () => {
  const g = trioGame(), id = toHex(g.gameId), honest = packageOf(g);
  const [a, b] = honest.cores;
  for (const cores of [[a, { ...a, hash: a.hash.toUpperCase() }], [a, { ...a, hash: ' ' + a.hash }], [a, { ...b, source: a.source }], [b, a, a]]) {
    const v = verifyPackage({ ...honest, cores }, { verify: verifyEd25519, want: id });
    assert.equal(v.ok, false, `cores ${cores.map((c) => c.hash.slice(0, 6)).join(',')} passed`);
  }
});

test('s3 variants: a package.json emptied on disk (an older build kept the relay\'s configs) still hosts the manifest\'s configs at the next start', async () => {
  const g = trioGame(), id = toHex(g.gameId), honest = packageOf(g);
  const dir = mkdtempSync(join(tmpdir(), 'a45r6s3l-'));
  const at = installPackage(dir, honest, id);
  const kept = JSON.parse(readFileSync(join(at, 'package.json'), 'utf8'));
  writeFileSync(join(at, 'package.json'), JSON.stringify({ ...kept, cores: kept.cores.map((c) => ({ ...c, configs: [] })) }));
  const { registrations, refused } = await loadInstalled(dir, { verify: verifyEd25519 });
  assert.equal(refused.length, 0, JSON.stringify(refused));
  const h = hostedPlugins(registrations, { log: () => {} }).get(id);
  assert.equal(allRoundsServed(g, h), null);
});

test('s3 variants: the honest package still installs, hosts every round, and re-serves the manifest configs', async () => {
  const g = trioGame(), id = toHex(g.gameId), honest = packageOf(g);
  const v = verifyPackage(honest, { verify: verifyEd25519, want: id });
  assert.equal(v.ok, true, v.why);
  const at = installPackage(mkdtempSync(join(tmpdir(), 'a45r6s3h-')), honest, id);
  const h = hostedPlugins([await registrationFromPackage(at, honest)], { log: () => {} }).get(id);
  assert.equal(allRoundsServed(g, h), null);
  const again = packageOf(h);
  assert.deepEqual(again.cores.map((c) => c.configs), honest.cores.map((c) => c.configs));
});
