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
// THE ARENA PAGE'S ONE BUNDLE: the market's pick sheet and the games screen's tiles, React once - into src/arena-ui, the page's own
// folder (tools/sync-arena-ui.mjs copies it into the Unity template with the rest)
await build({ entryPoints: [join(root, 'src/arena/main.jsx')], bundle: true, format: 'esm', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'dist/arena.js'), legalComments: 'none' });
copyFileSync(join(root, 'dist/arena.js'), join(root, '../../src/arena-ui/arena-react.js'));
// THE INSTALLER'S STEPS: one plain script (the wizard page loads it before its own), its stylesheet inside; beside the wizard's page,
// which the installer serves from its www/ (the release carries packages/arena-installer whole)
await build({ entryPoints: [join(root, 'src/installer/main.jsx')], bundle: true, format: 'iife', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'dist/wizard.js'), legalComments: 'none' });
copyFileSync(join(root, 'dist/wizard.js'), join(root, '../arena-installer/www/wizard.js'));
// THE NODE DASHBOARD (kanban #566): served by the node at /dashboard/react.js beside its page
await build({ entryPoints: [join(root, 'src/dashboard/main.jsx')], bundle: true, format: 'esm', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'dist/dashboard.js'), legalComments: 'none' });
// THE NODE'S ROUNDS PAGE (kanban #564): served by the node at /rounds/react.js beside pages/rounds.html
await build({ entryPoints: [join(root, 'src/rounds/main.jsx')], bundle: true, format: 'esm', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'dist/rounds.js'), legalComments: 'none' });
// "MY NODE IS OFFLINE" (kanban #564): served by the node at /emergency/react.js beside pages/emergency.html
await build({ entryPoints: [join(root, 'src/emergency/main.jsx')], bundle: true, format: 'esm', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'dist/emergency.js'), legalComments: 'none' });
// ROCK PAPER SCISSORS' TABLE: one plain script, inlined into its version-4 client by packages/rock-paper-scissors/tools/build-client-v4.mjs
await build({ entryPoints: [join(root, 'src/rps/main.jsx')], bundle: true, format: 'iife', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(root, 'dist/rps.js'), legalComments: 'none' });
copyFileSync(join(root, 'src/design/arena.css'), join(root, 'dist/arena.css'));
for (const [name, entry] of [['roles', 'src/owner/RolesPanel.jsx'], ['services', 'src/owner/ServicesPanel.jsx'], ['address', 'src/owner/AddressPanel.jsx'], ['bond', 'src/owner/BondPanel.jsx'], ['custody', 'src/owner/CustodyPanels.jsx'], ['standing', 'src/owner/StandingPanel.jsx'], ['release', 'src/owner/ReleasePanel.jsx'], ['apps', 'src/owner/AppsPanel.jsx'], ['network-apps', 'src/owner/NetworkAppsPanel.jsx'], ['network', 'src/owner/NetworkPanel.jsx'], ['needs', 'src/owner/NeedsPanel.jsx'], ['market', 'src/market/MarketViews.jsx'], ['games', 'src/arena/GameTiles.jsx'], ['rps', 'src/rps/RpsView.jsx'], ['dashboard', 'src/dashboard/DashboardPage.jsx'], ['rounds', 'src/rounds/RoundsPage.jsx'], ['emergency', 'src/emergency/EmergencyPage.jsx'], ['wizard', 'src/installer/WizardSteps.jsx'], ['setup', 'src/installer/SetupSteps.jsx'], ['finish', 'src/installer/FinishSteps.jsx'], ['components', 'src/design/components.jsx']])
  await build({ entryPoints: [join(root, entry)], bundle: true, format: 'esm', jsx: 'automatic', platform: 'node', external: ['react', 'react-dom', 'react/jsx-runtime'],
    outfile: join(root, `dist/test/${name}.mjs`) });
console.log('built dist/owner.js, dist/arena.js, dist/wizard.js, dist/dashboard.js, dist/rounds.js, dist/emergency.js, dist/arena.css, dist/test/');
