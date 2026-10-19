// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// node tools/bundle-owner.mjs [--check]: pages/owner-entry.js -> pages/owner-client.js (kanban #276). --check exits 1 when
// the committed bundle is not what the source builds.
import { build } from '../../arena-client/node_modules/esbuild/lib/main.js';
import { readFileSync, writeFileSync } from 'node:fs';
const out = new URL('../pages/owner-client.js', import.meta.url);
const r = await build({ entryPoints: [new URL('../pages/owner-entry.js', import.meta.url).pathname], bundle: true, format: 'esm', minify: true, write: false, legalComments: 'none' });
const js = r.outputFiles[0].text;
if (process.argv.includes('--check')) { const same = readFileSync(out, 'utf8') === js; console.log(same ? 'owner-client.js is fresh' : 'owner-client.js is stale: run node tools/bundle-owner.mjs'); process.exit(same ? 0 : 1); }
writeFileSync(out, js); console.log('owner-client.js', js.length, 'bytes');
