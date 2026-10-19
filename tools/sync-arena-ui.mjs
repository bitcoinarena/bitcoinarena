#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA UI LIVES IN src/arena-ui; UNITY'S WEBGL TEMPLATE IS ITS COPY (kanban #521). Unity builds only from a template inside its own
// project (unity-proto/Assets/WebGLTemplates/NextBlock), so that folder is made from src/arena-ui: every file copied byte for byte,
// every file the template holds that src/arena-ui does not removed - except Unity's own .meta files, which stay. Run after any change
// to src/arena-ui; packages/arena-client/test/arena-ui-sync.test.js fails while the two differ.
// Each game's own page parts live under its plugin (packages/<game>/page/*-page.{js,css,html}); the page loads them from
// games/<game>/, so they are copied there too - the template is src/arena-ui plus those, and nothing else.
//     node tools/sync-arena-ui.mjs [--check]
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = join(ROOT, 'src/arena-ui');
export const TEMPLATE = join(ROOT, 'unity-proto/Assets/WebGLTemplates/NextBlock');

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const PART = /-page\.(js|css|html)$/;
/** Every file the template must hold, as { 'path in the template': 'its source' }: src/arena-ui's, then the games' page parts. */
export function sources() {
  const out = {};
  for (const p of walk(SOURCE)) out[relative(SOURCE, p)] = p;
  const games = join(ROOT, 'packages');
  for (const g of readdirSync(games).sort()) {
    const dir = join(games, g, 'page');
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir).sort()) if (PART.test(n)) out[join('games', g, n)] = join(dir, n);
  }
  return out;
}
/** What differs: { copy: [paths of sources() not equal in the template], remove: [template files src/arena-ui does not have] }. */
export function differences() {
  const from = sources(), src = Object.keys(from);
  const tpl = existsSync(TEMPLATE) ? walk(TEMPLATE).map((p) => relative(TEMPLATE, p)).filter((p) => !p.endsWith('.meta')) : [];
  const copy = src.filter((p) => { const t = join(TEMPLATE, p); return !existsSync(t) || !readFileSync(t).equals(readFileSync(from[p])); });
  const remove = tpl.filter((p) => !(p in from));
  return { copy, remove };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const d = differences();
  if (process.argv.includes('--check')) {
    console.log(`template vs src/arena-ui: ${d.copy.length} to copy, ${d.remove.length} to remove`); for (const p of [...d.copy, ...d.remove].slice(0, 20)) console.log('  ', p);
    process.exit(d.copy.length || d.remove.length ? 1 : 0);
  }
  for (const p of d.copy) { const t = join(TEMPLATE, p); mkdirSync(dirname(t), { recursive: true }); writeFileSync(t, readFileSync(sources()[p])); }
  for (const p of d.remove) rmSync(join(TEMPLATE, p));
  console.log(`synced: ${d.copy.length} copied, ${d.remove.length} removed`);
}
