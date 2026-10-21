// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BUILD (kanban #564): the owner dashboard's React screens bundled for the browser (dist/owner.js, React included, minified) and the
// stylesheet beside it; and the components compiled to plain modules for the tests (dist/test/), which import React from node_modules.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist', 'test'), { recursive: true });
await build({ entryPoints: [join(root, 'src/owner/main.jsx')], bundle: true, format: 'esm', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'dist/owner.js'), legalComments: 'none' });
copyFileSync(join(root, 'src/design/arena.css'), join(root, 'dist/arena.css'));
for (const [name, entry] of [['roles', 'src/owner/RolesPanel.jsx'], ['services', 'src/owner/ServicesPanel.jsx'], ['address', 'src/owner/AddressPanel.jsx'], ['bond', 'src/owner/BondPanel.jsx'], ['custody', 'src/owner/CustodyPanels.jsx'], ['components', 'src/design/components.jsx']])
  await build({ entryPoints: [join(root, entry)], bundle: true, format: 'esm', jsx: 'automatic', platform: 'node', external: ['react', 'react-dom', 'react/jsx-runtime'],
    outfile: join(root, `dist/test/${name}.mjs`) });
console.log('built dist/owner.js, dist/arena.css, dist/test/');
