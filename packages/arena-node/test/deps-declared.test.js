// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY PACKAGE THE NODE AND THE INSTALLER IMPORT IS DECLARED (kanban #570): gateway.js imported bcryptjs and the seat @noble/hashes while
// neither package.json named them - the release workflow installs them by name, so releases had them, but a tree set up from the
// package.json files did not: /owner/services could not load the installer's services and answered its fallback. Each third-party import
// of src/ and bin/ must be in that package's dependencies; the installer's node_modules is the node's (a link), so the node declares
// the installer's too, at the versions release.yml installs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PKG = new URL('../../', import.meta.url).pathname;
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : /\.(m?js)$/.test(n) ? [p] : []; }) : []);
const importsOf = (pkg) => {
  const out = new Set();
  for (const f of [...walk(join(PKG, pkg, 'src')), ...walk(join(PKG, pkg, 'bin'))])
    // a module specifier only: a name after `from ` or `import(`, never a word "from" inside a string
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:\bfrom\s+|\bimport\(\s*)(['"])([@a-z0-9][^'"\s]*)\1/g)) {
      if (/^node:/.test(m[2])) continue;
      out.add(m[2].startsWith('@') ? m[2].split('/').slice(0, 2).join('/') : m[2].split('/')[0]);
    }
  return out;
};
const declared = (pkg) => new Set(Object.keys(JSON.parse(readFileSync(join(PKG, pkg, 'package.json'), 'utf8')).dependencies || {}));
// what the packages import that is no npm package: the monorepo's own packages and the app ids the node resolves itself
const OWN = /^(arena-|blwp-|btc-updown|nextblock|rock-paper-scissors|hello-world|arena:)/;

for (const pkg of ['arena-node', 'arena-installer']) {
  test(`${pkg}: every third-party import is in its package.json`, () => {
    const missing = [...importsOf(pkg)].filter((m) => !OWN.test(m) && !declared(pkg).has(m));
    assert.deepEqual(missing, [], `${pkg} imports ${missing.join(', ')} without declaring it`);
  });
}

test('the node declares what the installer imports (the installer\'s node_modules is the node\'s), at the versions the release installs', () => {
  const node = declared('arena-node');
  for (const m of importsOf('arena-installer')) if (!OWN.test(m)) assert.ok(node.has(m), `arena-node does not declare ${m}, which the installer imports`);
  const release = readFileSync(new URL('../../../.github/workflows/release.yml', import.meta.url), 'utf8');
  const deps = JSON.parse(readFileSync(join(PKG, 'arena-node', 'package.json'), 'utf8')).dependencies;
  for (const [name, range] of Object.entries(deps)) assert.match(release, new RegExp(`${name.replace('/', '\\/')}@${range.replace(/^\^/, '').replace(/\./g, '\\.')}`), `release.yml installs ${name} at ${range}`);
});
