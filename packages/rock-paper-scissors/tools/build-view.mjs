// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ROCK PAPER SCISSORS' TABLE, BUILT BY ITS OWN PACKAGE (kanban #568; it was packages/arena-web/src/rps): view/ bundled with React into one
// plain script, dist/rps-view.js, which tools/build-client-v4.mjs inlines into the version-4 client (whose hash its manifest pins - the
// same options as before, so the same bytes). esbuild and React are this package's devDependencies; inside the Arena's tree, where this
// package has none installed, they are taken from packages/arena-web.
//
//     node packages/rock-paper-scissors/tools/build-view.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const own = createRequire(join(root, 'package.json'));
const from = (() => { try { own.resolve('esbuild'); own.resolve('react'); return root; } catch { return join(root, '../arena-web'); } })();
const { build } = await import(createRequire(join(from, 'package.json')).resolve('esbuild'));
await build({ entryPoints: [join(root, 'view/main.jsx')], bundle: true, format: 'iife', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'dist/rps-view.js'), legalComments: 'none', nodePaths: [join(from, 'node_modules')] });
console.log(`built dist/rps-view.js (esbuild and React from ${from === root ? 'this package' : 'packages/arena-web'})`);
