// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ENGINE IMPORTS NO GAME (§0A.2: "the dependency runs one way: the engine never imports a game's code").
//
// nextblock may depend on the engine - protocol, arena-node, arena-client, arena-donor - and no engine file may depend on
// nextblock. This reads every file the engine runs (src and bin of the four packages), comments taken out, and fails on
// any static import or re-export, dynamic import() or new URL() whose path reaches packages/nextblock or the Unity
// project; and it builds the page's client bundle into a scratch directory and fails if any module in it is the game's.
// Engine TESTS and operator TOOLS may still use nextblock as a fixture or a game to play: they are not the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE = ['arena-protocol', 'arena-node', 'arena-client', 'arena-donor'];
const GAME = [resolve(PACKAGES, 'nextblock')];   // its Unity project included (packages/nextblock/unity, kanban #569)

const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (f === 'node_modules') return [];
  return statSync(p).isDirectory() ? filesUnder(p) : (/\.(m?js|cjs)$/.test(f) ? [p] : []);
}) : []);

/** Every path a file names to load or read code: import/export from, import(), new URL(). */
function pathsNamed(src) {
  const code = codeOf(src);
  const out = [];
  for (const re of [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g, /\bimport\s+['"]([^'"]+)['"]/g,
    /new\s+URL\(\s*['"`]([^'"`]+)['"`]\s*,\s*import\.meta\.url/g])
    for (const m of code.matchAll(re)) out.push(m[1]);
  return out;
}

test('no file the engine runs imports, loads or reads the game: protocol, arena-node, arena-client and arena-donor src and bin', () => {
  const reaching = [];
  let read = 0;
  for (const pkg of ENGINE) for (const part of ['src', 'bin']) for (const file of filesUnder(join(PACKAGES, pkg, part))) {
    read++;
    for (const p of pathsNamed(readFileSync(file, 'utf8'))) {
      if (!p.startsWith('.')) continue;
      const to = resolve(dirname(file), p);
      if (GAME.some((g) => to === g || to.startsWith(g + '/'))) reaching.push(`${relative(PACKAGES, file)} -> ${p}`);
    }
  }
  console.log(`  FACTS (engine imports): ${read} engine files read, ${reaching.length} reach the game`);
  assert.ok(read > 100, `only ${read} engine files were read - the walk is not looking at the engine`);
  assert.deepEqual(reaching, [], 'an engine file reaches the game');
});

test('the page\'s client bundle, built from this tree, holds no module of the game', () => {
  const out = mkdtempSync(join(tmpdir(), 'engine-bundle-'));
  execFileSync(process.execPath, [join(PACKAGES, 'arena-client/tools/bundle.js')], { env: { ...process.env, ARENA_BUNDLE_OUT: out }, stdio: 'pipe' });
  const modules = [...readFileSync(join(out, 'arena-client.js'), 'utf8').matchAll(/^\/\/ ---- (\S+)$/gm)].map((m) => m[1]);
  const game = modules.filter((m) => /^(nextblock|core)\//.test(m));
  console.log(`  FACTS (client bundle): ${modules.length} modules, ${game.length} of the game`);
  assert.ok(modules.length > 20, `the bundle names only ${modules.length} modules`);
  assert.deepEqual(game, [], 'the client bundle carries the game');
});
