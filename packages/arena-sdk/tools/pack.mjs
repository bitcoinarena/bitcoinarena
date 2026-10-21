// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SDK AS ITS OWN REPOSITORY (kanban #568, the owner 2026-10-21: "The external apps ... reference arena through an import in package.json with
// the github url"): npm installs a whole repository, never a folder of this one, so a tester/arena-sdk holds the SDK standalone - each
// subpath's Arena module and every module it imports, copied with their paths kept under arena/ (packages/arena-protocol/src/hash.js ->
// arena/arena-protocol/src/hash.js), the subpath files pointing there, and the npm packages they use pinned.
//
//     node packages/arena-sdk/tools/pack.mjs <out dir> <version>
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = resolve(sdk, '..');
const repo = resolve(packages, '..');
const [out, version] = process.argv.slice(2);
if (!out || !version) { console.error('usage: pack.mjs <out dir> <version>'); process.exit(2); }

const pkg = JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8'));
// the npm packages the copied modules may import, at the versions the Arena's seats run
const PINNED = { '@noble/curves': '2.4.0', '@noble/hashes': '2.4.0' };
const specs = (text) => [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1] || m[2]);

const seen = new Set(); const npm = new Set();
const walk = (file) => {
  if (seen.has(file)) return;
  seen.add(file);
  for (const s of specs(readFileSync(file, 'utf8'))) {
    if (s.startsWith('node:')) continue;
    if (s.startsWith('.')) { const f = resolve(dirname(file), s); if (!existsSync(f)) throw new Error(`${relative(repo, file)} imports ${s}, which is not there`); walk(f); continue; }
    const name = s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0];
    if (!PINNED[name]) throw new Error(`${relative(repo, file)} imports ${s}: no pinned version for ${name}`);
    npm.add(name);
  }
};
// each subpath's own file re-exports one Arena module: start the walk from that module
for (const sub of Object.values(pkg.exports)) {
  for (const s of specs(readFileSync(join(sdk, sub), 'utf8'))) walk(resolve(dirname(join(sdk, sub)), s));
}

mkdirSync(out, { recursive: true });
for (const file of seen) {
  const to = join(out, 'arena', relative(packages, file));
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(file, to);
}
for (const [sub, file] of Object.entries(pkg.exports)) {
  const text = readFileSync(join(sdk, file), 'utf8');
  const target = specs(text)[0];
  const abs = resolve(dirname(join(sdk, file)), target);
  const to = join(out, file);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, text.replace(`'${target}'`, `'${relative(dirname(to), join(out, 'arena', relative(packages, abs))).replace(/^(?!\.)/, './')}'`));
  void sub;
}
const standalone = { ...pkg, version, private: undefined,
  description: pkg.description + ' Packed from a tester/bitcoin-arena by packages/arena-sdk/tools/pack.mjs: do not edit here.',
  dependencies: Object.fromEntries([...npm].sort().map((n) => [n, PINNED[n]])) };
writeFileSync(join(out, 'package.json'), JSON.stringify(standalone, null, 2) + '\n');
copyFileSync(join(repo, 'LICENSE'), join(out, 'LICENSE'));
writeFileSync(join(out, 'README.md'), `# arena-sdk ${version}\n\nWhat an external app imports from the Bitcoin Arena: ${Object.keys(pkg.exports).map((s) => '`arena-sdk/' + s.slice(2) + '`').join(', ')}.\n\nIn the app's package.json:\n\n    "dependencies": { "arena-sdk": "github:a tester/arena-sdk#v${version}" }\n\nPacked from a tester/bitcoin-arena (packages/arena-sdk, tools/pack.mjs). Change it there, not here.\n`);
console.log(`packed ${seen.size} Arena modules, ${Object.keys(pkg.exports).length} subpaths, npm: ${[...npm].join(', ') || 'none'} -> ${out}`);
