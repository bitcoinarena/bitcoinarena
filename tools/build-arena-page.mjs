#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA PAGE, BUILT BY THE ARENA (kanban #569, 2026-10-21: "The Arena keeps only its own page"; it was Unity's WebGL template,
// a copy of src/arena-ui inside Next Block's Unity project, filled by Unity or by hand at each deploy). The page is src/arena-ui, each
// app's own page parts at games/<app>/ (packages/<app>/page/*-page.{js,css,html}), and Next Block's WebGL client as the app published it
// (its release, pinned by tools/pin-app-webgl.mjs) at the paths its build names (Build/, ServerData/, StreamingAssets/,
// StreamingAssets-astc/, textures.json, build.txt). Every client file is checked against the pin before it is copied, and the page is
// filled with the build's names and the pin's hashes: it runs no client file whose bytes do not hash to them.
//
//     node tools/build-arena-page.mjs <out dir> --ui <UI number> --client <the pinned release's folder> [--base <the live page's folder>]
//
// --base: what the deployed site holds that is not in git (daily.json, release/, the release key, _headers) is taken from the page
// before; everything this tool writes replaces it.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = join(ROOT, 'src/arena-ui');
export const PIN = join(SOURCE, 'apps/nextblock.webgl-pin.json');
const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const PART = /-page\.(js|css|html)$/;
// what Next Block's WebGL client is made of on the site (everything else there is the Arena's)
export const CLIENT_PATHS = ['Build', 'ServerData', 'StreamingAssets', 'StreamingAssets-astc', 'textures.json', 'build.txt'];
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Every file of the Arena's page, as { 'path on the site': 'its source' }: src/arena-ui's, then each app's page parts. */
export function sources() {
  const out = {};
  for (const p of walk(SOURCE)) out[relative(SOURCE, p)] = p;
  const apps = join(ROOT, 'packages');
  for (const g of readdirSync(apps).sort()) {
    const dir = join(apps, g, 'page');
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir).sort()) if (PART.test(n)) out[join('games', g, n)] = join(dir, n);
  }
  return out;
}

/** The hash the page checks for each client file it fetches: of the unpacked bytes for a brotli .unityweb (the browser unpacks it). */
export function pagePins(pin) {
  return Object.fromEntries(Object.entries(pin.files).map(([rel, f]) => [rel, f.unpackedSha256 || f.sha256]));
}

/** The page's index.html filled: the build's file names, its product and UI version, each file's sizes, the pins. */
export function fill(html, { pin, ui, sizes }) {
  const n = pin.build;
  const v = { CODE_FILENAME: `${n}.wasm.unityweb`, DATA_FILENAME: `${n}.data.unityweb`, FRAMEWORK_FILENAME: `${n}.framework.js.unityweb`,
    LOADER_FILENAME: `${n}.loader.js`, PRODUCT_VERSION: pin.productVersion, PRODUCT_NAME: pin.title, COMPANY_NAME: 'Bitcoin Arena', UI_VERSION: String(ui) };
  let s = html;
  for (const [k, x] of Object.entries(v)) s = s.replaceAll(`{{{ ${k} }}}`, x);
  if (s.includes('{{{')) throw new Error(`an unfilled template token is left: ${s.match(/\{\{\{[^}]*\}\}\}/)[0]}`);
  for (const [token, value] of [["'__BUILD_SIZES__'", sizes], ["'__APP_BUILD_PINS__'", pagePins(pin)]]) {
    if (!s.includes(token)) throw new Error(`index.html has no ${token}`);
    s = s.replace(token, JSON.stringify(JSON.stringify(value)));
  }
  return s;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const out = args[0];
  const opt = (k) => { const i = args.indexOf(`--${k}`); return i > 0 ? args[i + 1] : null; };
  const ui = opt('ui'), client = opt('client'), base = opt('base');
  if (!out || !ui || !client) { console.error('usage: build-arena-page.mjs <out> --ui <n> --client <release folder> [--base <page>]'); process.exit(2); }
  if (existsSync(out)) throw new Error(`${out} exists: a page folder is made once`);
  const pin = JSON.parse(readFileSync(PIN, 'utf8'));
  if (base) { cpSync(base, out, { recursive: true }); for (const p of CLIENT_PATHS) rmSync(join(out, p), { recursive: true, force: true }); }
  mkdirSync(out, { recursive: true });
  // THE CLIENT, AS PINNED: every file the pin names, each checked before it is copied; nothing the pin does not name
  const sizes = {};
  for (const [rel, f] of Object.entries(pin.files)) {
    const b = readFileSync(join(client, rel));
    if (sha(b) !== f.sha256) throw new Error(`${rel} in ${client} is not the pinned file (${pin.release})`);
    if (rel.endsWith('.unityweb')) sizes[rel.split('/').pop()] = [b.length, brotliDecompressSync(b).length];
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    copyFileSync(join(client, rel), join(out, rel));
  }
  // THE ARENA'S PAGE AND THE APPS' PAGE PARTS
  const from = sources();
  for (const [rel, src] of Object.entries(from)) { mkdirSync(dirname(join(out, rel)), { recursive: true }); copyFileSync(src, join(out, rel)); }
  writeFileSync(join(out, 'index.html'), fill(readFileSync(join(SOURCE, 'index.html'), 'utf8'), { pin, ui, sizes }));
  console.log(`page ${out}: UI ${ui}, ${Object.keys(from).length} Arena files, Next Block's client ${pin.build} (${pin.productVersion}, ${pin.release}) - ${Object.keys(pin.files).length} pinned files`);
}
