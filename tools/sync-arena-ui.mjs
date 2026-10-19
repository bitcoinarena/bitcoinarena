#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA UI LIVES IN src/arena-ui; UNITY'S WEBGL TEMPLATE IS ITS COPY (kanban #521). Unity builds only from a template inside its own
// project (unity-proto/Assets/WebGLTemplates/NextBlock), so that folder is made from src/arena-ui: every file copied byte for byte,
// every file the template holds that src/arena-ui does not removed - except Unity's own .meta files, which stay. Run after any change
// to src/arena-ui; packages/arena-client/test/arena-ui-sync.test.js fails while the two differ.
//     node tools/sync-arena-ui.mjs [--check]
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = join(ROOT, 'src/arena-ui');
export const TEMPLATE = join(ROOT, 'unity-proto/Assets/WebGLTemplates/NextBlock');

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
/** What differs: { copy: [paths in src/arena-ui not equal in the template], remove: [template files src/arena-ui does not have] }. */
export function differences() {
  const src = walk(SOURCE).map((p) => relative(SOURCE, p));
  const tpl = existsSync(TEMPLATE) ? walk(TEMPLATE).map((p) => relative(TEMPLATE, p)).filter((p) => !p.endsWith('.meta')) : [];
  const copy = src.filter((p) => { const t = join(TEMPLATE, p); return !existsSync(t) || !readFileSync(t).equals(readFileSync(join(SOURCE, p))); });
  const remove = tpl.filter((p) => !src.includes(p));
  return { copy, remove };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const d = differences();
  if (process.argv.includes('--check')) {
    console.log(`template vs src/arena-ui: ${d.copy.length} to copy, ${d.remove.length} to remove`); for (const p of [...d.copy, ...d.remove].slice(0, 20)) console.log('  ', p);
    process.exit(d.copy.length || d.remove.length ? 1 : 0);
  }
  for (const p of d.copy) { const t = join(TEMPLATE, p); mkdirSync(dirname(t), { recursive: true }); writeFileSync(t, readFileSync(join(SOURCE, p))); }
  for (const p of d.remove) rmSync(join(TEMPLATE, p));
  console.log(`synced: ${d.copy.length} copied, ${d.remove.length} removed`);
}
