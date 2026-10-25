// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BUILD (kanban #564): the owner dashboard's React screens bundled for the browser (dist/owner.js, React included, minified) and the
// stylesheet beside it; and the components compiled to plain modules for the tests (dist/test/), which import React from node_modules.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// THE RELEASE'S CHECK (kanban #564, 2026-10-21: "pack the release"): ARENA_WEB_OUT builds every bundle into that folder and
// nothing else - no copies into the pages' folders, no test modules - so a test can compare them with the dist/ a release ships
const ALONE = process.env.ARENA_WEB_OUT || null;
const dist = ALONE || join(root, 'dist');
const copy = (from, to) => { if (!ALONE) copyFileSync(from, to); };
mkdirSync(ALONE ? dist : join(dist, 'test'), { recursive: true });
await build({ entryPoints: [join(root, 'src/owner/main.jsx')], bundle: true, format: 'esm', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(dist, 'owner.js'), legalComments: 'none' });
// THE ARENA PAGE'S ONE BUNDLE: the market's pick sheet and the games screen's tiles, React once - into src/arena-ui, the page's own
// folder (tools/build-arena-page.mjs takes it into the page with the rest)
// a CLASSIC script, loaded before the page's main script (kanban #564, 2026-10-21: "Delete the old html code of those components
// you have ported, no fall backs"): every React view is there when the page's first line runs
await build({ entryPoints: [join(root, 'src/arena/main.jsx')], bundle: true, format: 'iife', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(dist, 'arena.js'), legalComments: 'none' });
copy(join(dist, 'arena.js'), join(root, '../../src/arena-ui/arena-react.js'));
// THE EXPLORER (kanban #624, explorer.bitcoin-arena.io): one classic script beside its page in src/website/explorer/www
await build({ entryPoints: [join(root, 'src/explorer/main.jsx')], bundle: true, format: 'iife', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(dist, 'explorer.js'), legalComments: 'none' });
copy(join(dist, 'explorer.js'), join(root, '../../src/website/explorer/www/explorer.js'));
// THE ARENA SITE'S SMALL PAGES (kanban #564): one classic script for /dashboard/ and /guardians/, beside them in src/arena-ui
await build({ entryPoints: [join(root, 'src/site/main.jsx')], bundle: true, format: 'iife', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(dist, 'site.js'), legalComments: 'none' });
copy(join(dist, 'site.js'), join(root, '../../src/arena-ui/site-react.js'));
// THE INSTALLER'S STEPS: one plain script (the wizard page loads it before its own), its stylesheet inside; beside the wizard's page,
// which the installer serves from its www/ (the release carries packages/arena-installer whole)
await build({ entryPoints: [join(root, 'src/installer/main.jsx')], bundle: true, format: 'iife', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  loader: { '.css': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(dist, 'wizard.js'), legalComments: 'none' });
copy(join(dist, 'wizard.js'), join(root, '../arena-installer/www/wizard.js'));
// THE NODE DASHBOARD (kanban #566): served by the node at /dashboard/react.js beside its page
await build({ entryPoints: [join(root, 'src/dashboard/main.jsx')], bundle: true, format: 'esm', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(dist, 'dashboard.js'), legalComments: 'none' });
// THE NODE'S ROUNDS PAGE (kanban #564): served by the node at /rounds/react.js beside pages/rounds.html
await build({ entryPoints: [join(root, 'src/rounds/main.jsx')], bundle: true, format: 'esm', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(dist, 'rounds.js'), legalComments: 'none' });
// "MY NODE IS OFFLINE" (kanban #564): served by the node at /emergency/react.js beside pages/emergency.html
await build({ entryPoints: [join(root, 'src/emergency/main.jsx')], bundle: true, format: 'esm', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(dist, 'emergency.js'), legalComments: 'none' });
copy(join(dist, 'emergency.js'), join(root, '../../src/arena-ui/offline/react.js'));   // the Arena site's /offline/ too
// THE NETWORK HEALTH PAGE'S VIEWS (kanban #564): beside its page in src/arena-ui/health (the page's folder ships with the Arena page)
await build({ entryPoints: [join(root, 'src/health/main.jsx')], bundle: true, format: 'esm', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(dist, 'health.js'), legalComments: 'none' });
copy(join(dist, 'health.js'), join(root, '../../src/arena-ui/health/react.js'));
// THE PROPOSALS FORUM'S READING VIEWS (kanban #564): beside forum.js in src/arena-ui/proposals
await build({ entryPoints: [join(root, 'src/proposals/main.jsx')], bundle: true, format: 'esm', minify: true, jsx: 'automatic', target: ['es2020', 'safari15'],
  define: { 'process.env.NODE_ENV': '"production"' }, outfile: join(dist, 'proposals.js'), legalComments: 'none' });
copy(join(dist, 'proposals.js'), join(root, '../../src/arena-ui/proposals/react.js'));
copyFileSync(join(root, 'src/design/arena.css'), join(dist, 'arena.css'));
if (ALONE) { console.log(`built the served bundles into ${ALONE}`); process.exit(0); }
for (const [name, entry] of [['roles', 'src/owner/RolesPanel.jsx'], ['keyswitch', 'src/owner/KeySwitchPanel.jsx'], ['setup-status', 'src/dashboard/SetupStatus.jsx'], ['owner-start', 'src/owner/OwnerStart.jsx'], ['owner-area', 'src/owner/OwnerArea.jsx'], ['bond-offer', 'src/owner/BondOffer.jsx'], ['leave', 'src/owner/LeavePanel.jsx'], ['donations', 'src/owner/DonationsPanels.jsx'], ['ballots', 'src/owner/BallotsPanel.jsx'], ['services', 'src/owner/ServicesPanel.jsx'], ['address', 'src/owner/AddressPanel.jsx'], ['bond', 'src/owner/BondPanel.jsx'], ['custody', 'src/owner/CustodyPanels.jsx'], ['standing', 'src/owner/StandingPanel.jsx'], ['release', 'src/owner/ReleasePanel.jsx'], ['apps', 'src/owner/AppsPanel.jsx'], ['gamedevs', 'src/owner/GameDevsPanel.jsx'], ['network-apps', 'src/owner/NetworkAppsPanel.jsx'], ['network', 'src/owner/NetworkPanel.jsx'], ['needs', 'src/owner/NeedsPanel.jsx'], ['market', 'src/market/MarketViews.jsx'], ['games', 'src/arena/GameTiles.jsx'], ['season', 'src/arena/SeasonRows.jsx'], ['zap', 'src/arena/ZapCard.jsx'], ['chips', 'src/arena/ChipList.jsx'], ['balance', 'src/arena/BalanceSplit.jsx'], ['confirm', 'src/arena/ConfirmCard.jsx'], ['wallet', 'src/arena/WalletHistory.jsx'], ['custody-card', 'src/arena/CustodyCard.jsx'], ['seed', 'src/arena/SeedModal.jsx'], ['walletstart', 'src/arena/WalletStart.jsx'], ['deposit', 'src/arena/DepositModal.jsx'], ['withdraw', 'src/arena/WithdrawPanel.jsx'], ['move', 'src/arena/MovePanel.jsx'], ['shop', 'src/arena/ShopItems.jsx'], ['donate', 'src/arena/DonateBox.jsx'], ['others', 'src/arena/OtherWallets.jsx'], ['bits', 'src/arena/PageBits.jsx'], ['site', 'src/site/SitePages.jsx'], ['settings', 'src/arena/SettingsCards.jsx'], ['rps', '../rock-paper-scissors/view/RpsView.jsx'], ['rps-chrome', '../rock-paper-scissors/view/RpsChrome.jsx'], ['updown', '../btc-updown/view/UpDownView.jsx'], ['nextblock', '../nextblock/view/NextBlockParts.jsx'], ['dashboard', 'src/dashboard/DashboardPage.jsx'], ['rounds', 'src/rounds/RoundsPage.jsx'], ['emergency', 'src/emergency/EmergencyPage.jsx'], ['health', 'src/health/HealthViews.jsx'], ['proposals', 'src/proposals/ForumViews.jsx'], ['wizard', 'src/installer/WizardSteps.jsx'], ['setup', 'src/installer/SetupSteps.jsx'], ['finish', 'src/installer/FinishSteps.jsx'], ['components', 'src/design/components.jsx'], ['explorer', 'src/explorer/main.jsx']])
  await build({ entryPoints: [join(root, entry)], bundle: true, format: 'esm', jsx: 'automatic', platform: 'node', external: ['react', 'react-dom', 'react/jsx-runtime'],
    outfile: join(root, `dist/test/${name}.mjs`) });
console.log('built dist/owner.js, dist/arena.js, dist/wizard.js, dist/dashboard.js, dist/rounds.js, dist/emergency.js, dist/health.js, dist/proposals.js, dist/arena.css, dist/test/');
