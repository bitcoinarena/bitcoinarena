// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3085 (feedback #367): a tree core (Next Block v8's 7d197042: 26 .js files) is carried in a package as { entry, files } and
// checked by its tree hash - the hash core-hash.js coreTree computes from disk, recomputed here from the bytes in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeManifest } from '../../arena-protocol/src/manifest.js';
import { checkPackage, treeHashHex, TREE_LIMITS } from '../src/plugin-check.js';
import { coreTree } from '../src/core-hash.js';
import { verifyEd25519 } from '../src/ed25519.js';
import { testGame, testDonationSet } from './plugins/sign.js';

const ROOT = join(import.meta.dirname, '..', '..', '..', '.apps', 'arena-app-next-block', 'frozen', '7d197042');
const { hash: TREE, files } = coreTree(ROOT);
const CFG = 'bb'.repeat(32);
const asFiles = () => [...files].map(([path, bytes]) => ({ path, body: Buffer.from(bytes).toString('base64') }));

function pkgWith(core) {
  const g = testGame({ name: 'tree-game', cores: new Map([[TREE, { name: 'truck', hash: TREE, configs: new Map([[CFG, {}]]) }]]), runTicksMax: 100, dev: 'tree-dev' });
  const donationSet = testDonationSet('tree-dev').map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: r.shareBps, label: r.label }));
  const pkg = { format: 'arena-plugin/v1', name: 'tree-game', manifest: toHex(encodeManifest(g.manifest)), ancestors: [], donationSet,
    cores: [{ hash: TREE, name: 'truck', configs: [CFG], ...core }], clients: [] };
  return checkPackage(pkg, { verify: verifyEd25519, want: toHex(g.gameId) });
}

test('#3085: the tree hash from memory is coreTree\'s hash of the v8 core (26 files)', () => {
  assert.equal(TREE.slice(0, 8), '7d197042');
  assert.equal(files.size, 26);
  assert.equal(treeHashHex([...files].map(([path, bytes]) => ({ path, bytes: new Uint8Array(bytes) }))), TREE);
});

test('#3085: a package carrying the v8 tree passes the tree checks; a changed byte, a "../" path, a missing entry are refused', () => {
  const good = pkgWith({ entry: 'adapter.js', files: asFiles() });
  const tree = good.checks.find((c) => /is the tree its manifest names/.test(c.check));
  console.log('  MEASURED #3085:', JSON.stringify({ ok: good.ok, why: good.why, tree: tree && tree.ok, scan: good.checks.find((c) => /passes the scan/.test(c.check)) }).slice(0, 600));
  assert.equal(tree && tree.ok, true, good.why);
  const bent = asFiles(); const b = Buffer.from(bent[0].body, 'base64'); b[0] ^= 1; bent[0].body = b.toString('base64');
  assert.match(pkgWith({ entry: 'adapter.js', files: bent }).why, /not the tree its manifest names/);
  assert.match(pkgWith({ entry: 'adapter.js', files: [...asFiles(), { path: '../x.js', body: '' }] }).why, /segment/);
  assert.match(pkgWith({ entry: 'nope.js', files: asFiles() }).why, /entry is not one of its files/);
  assert.match(pkgWith({ entry: 'adapter.js', files: asFiles(), source: 'eA==' }).why, /not a list of files/);
  assert.ok(TREE_LIMITS.files >= files.size);
});

// the tree scan (kanban #3085): a comment is not code, a relative import inside the tree is allowed - and nothing else is
test('#3085: the tree scan still finds every real reach: import(), require, a bare or leaving import, process in code or in ${} of a template', async () => {
  const { scanTree, blankComments } = await import('../src/plugin-check.js');
  const T = (path, text) => ({ path, bytes: new TextEncoder().encode(text) });
  const ok = [T('a.js', "import { x } from './b.js';\n// the window's global process\n/* process */ export const y = x / 2; // done\n"), T('b.js', "export const x = 1;\nconst r = /\\/\\/ not a comment/; export { r };\n")];
  assert.deepEqual(scanTree(ok), [], 'comments and an in-tree import pass');
  const bad = {
    dynamicImport: [T('a.js', "export const f = () => import('./b.js');\n"), T('b.js', 'export const x = 1;\n')],
    require: [T('a.js', "const fs = require('fs');\n")],
    bare: [T('a.js', "import fs from 'fs';\n")],
    leaves: [T('r/a.js', "import { x } from '../../out.js';\n")],
    missing: [T('a.js', "import { x } from './nope.js';\n")],
    process: [T('a.js', 'export const f = () => process.exit(1);\n')],
    template: [T('a.js', 'export const t = `// ${process.exit(1)}`;\n')],
    templateLine: [T('a.js', 'export const t = `\n// `; process.exit(1); `\n`;\n')],
  };
  const left = Object.fromEntries(Object.entries(bad).map(([k, f]) => [k, scanTree(f).length]));
  console.log('  MEASURED #3085 tree scan findings:', JSON.stringify(left));
  for (const [k, n] of Object.entries(left)) assert.ok(n > 0, `${k} must be found`);
  assert.equal(blankComments('a // b\nc').split('\n').length, 2, 'line numbers kept');
});

// the trial runs a tree from its entry (kanban #3085): a decide adapter whose rule sits in another file of the tree
test('#3085: the trial runs a tree core from its entry; a tree whose entry imports a file it does not carry does not load', async () => {
  const { trialRun } = await import('../src/plugin-trial.js');
  const { ROCK_PAPER_SCISSORS } = await import('../../rock-paper-scissors/plugin/rock-paper-scissors.js');
  const m = ROCK_PAPER_SCISSORS.manifest;
  const rule = "export const beats = (a, b) => (a - b + 3) % 3 === 1;\n";
  const adapter = "import { beats } from './rules/rps.js';\nexport const DECIDE = { name: 'tree rps', decide(moves) { const out = {};\n"
    + "  for (const x of moves) { const w = moves.some((y) => y !== x && beats(x.move, y.move)), l = moves.some((y) => y !== x && beats(y.move, x.move));\n"
    + "    out[x.key] = w && !l ? 'WIN' : l && !w ? 'LOSS' : 'DRAW'; } return out; } };\n";
  const good = trialRun({ files: new Map([['adapter.js', adapter], ['rules/rps.js', rule]]), entry: 'adapter.js' }, m);
  console.log('  MEASURED #3085 tree trial:', JSON.stringify({ ok: good.ok, cases: good.cases, why: good.why }));
  assert.equal(good.ok, true, good.why);
  const lacking = trialRun({ files: new Map([['adapter.js', adapter]]), entry: 'adapter.js' }, m);
  assert.equal(lacking.ok, false);
});

// the round trip (kanban #3085): a hosted tree core -> packageOf -> verifyPackage -> installPackage -> registrationFromPackage, which
// loads the installed tree in the sandbox after checking its tree hash on disk
test('#3085: a hosted tree core goes out as its tree, is checked, installed under core-<hash>/ and loads from there', async () => {
  const { packageOf, verifyPackage, installPackage, registrationFromPackage } = await import('../src/plugin-package.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const g = testGame({ name: 'tree-game', cores: new Map([[TREE, { name: 'truck', hash: TREE, configs: new Map([[CFG, {}]]) }]]), runTicksMax: 100, dev: 'tree-dev' });
  const hosted = { ...g, name: 'tree-game', title: 'tree-game', donationSet: testDonationSet('tree-dev'), clientUrls: [],
    cores: new Map([[TREE, { name: 'truck', hash: TREE, root: pathToFileURL(ROOT + '/').href, url: pathToFileURL(join(ROOT, 'adapter.js')).href, configs: new Map([[CFG, {}]]) }]]) };
  const pkg = packageOf(hosted);
  assert.equal(pkg.cores[0].entry, 'adapter.js'); assert.equal(pkg.cores[0].files.length, 26); assert.equal(pkg.cores[0].source, undefined);
  const v = verifyPackage(JSON.parse(JSON.stringify(pkg)), { verify: verifyEd25519, want: toHex(g.gameId) });
  assert.equal(v.ok, true, v.why);
  const at = installPackage(mkdtempSync(join(tmpdir(), 'tree-3085-')), pkg, toHex(g.gameId));
  const reg = await registrationFromPackage(at, pkg);
  const core = reg.cores.get(TREE);
  console.log('  MEASURED #3085 round trip:', JSON.stringify({ files: pkg.cores[0].files.length, bytes: JSON.stringify(pkg).length, verified: v.ok, root: !!core.root }));
  assert.ok(core.root && core.url.endsWith('/adapter.js'));
});
