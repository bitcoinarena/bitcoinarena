// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// NEXT BLOCK PUBLISHES ITS OWN WEBGL CLIENT (kanban #569, the owner 2026-10-21: "The app builds and publishes its own WebGL build. The Arena
// page loads that build like any other app client, hash-pinned"). From the two Unity outputs of one commit - DXT for desktops, ASTC for
// phones - one client folder: Build/ (the loader, the framework, the wasm, the DXT data and the ASTC data beside it as <name>-astc.data),
// ServerData/WebGL (the streamed models of both), StreamingAssets and StreamingAssets-astc (each one's Addressables catalog), textures.json
// (which the page reads on an ASTC GPU) and build.txt. The code files of the two outputs must be byte-identical (one commit), or nothing
// is published. Then webgl.json: every file with its size and SHA-256 - and for a brotli .unityweb also the SHA-256 of its unpacked bytes,
// what a browser hands the page (the files are served with Content-Encoding: br) and what the Arena pins.
//
//     node tools/publish-webgl.mjs <DXT output> <ASTC output> <out dir> [--release]
//
// --release attaches the folder to a GitHub release of a tester/arena-app-next-block, tagged webgl-nextblock-<version> (gh; one asset per
// file, its path in the name with "/" as "__", and webgl.json).
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliDecompressSync } from 'node:zlib';
import { join, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const [dxt, astc, out, ...flags] = process.argv.slice(2);
if (!dxt || !astc || !out) { console.error('usage: publish-webgl.mjs <DXT output> <ASTC output> <out dir> [--release]'); process.exit(2); }
const REPO = 'a tester/arena-app-next-block';
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); };

const builds = readdirSync(join(dxt, 'Build'));
// Unity names the files after its output folder; the client's name is the app's and its version, so every release has its own
const dxtName = builds.find((f) => f.endsWith('.loader.js'))?.replace(/\.loader\.js$/, '');
if (!dxtName) throw new Error(`${dxt}/Build holds no loader`);
const version = readFileSync(join(dxt, 'build.txt'), 'utf8').trim();
const name = `nextblock-${version}`;
// ONE COMMIT: the ASTC output's code is the DXT output's, byte for byte
const astcName = readdirSync(join(astc, 'Build')).find((f) => f.endsWith('.loader.js')).replace(/\.loader\.js$/, '');
for (const k of ['loader.js', 'framework.js.unityweb', 'wasm.unityweb']) {
  if (!readFileSync(join(dxt, 'Build', `${dxtName}.${k}`)).equals(readFileSync(join(astc, 'Build', `${astcName}.${k}`))))
    throw new Error(`the ASTC output's ${k} differs from the DXT output's: not one commit - nothing is published`);
}

if (existsSync(out)) rmSync(out, { recursive: true });
for (const k of ['loader.js', 'framework.js.unityweb', 'wasm.unityweb', 'data.unityweb']) copy(join(dxt, 'Build', `${dxtName}.${k}`), join(out, 'Build', `${name}.${k}`));
copy(join(astc, 'Build', `${astcName}.data.unityweb`), join(out, 'Build', `${name}-astc.data.unityweb`));
for (const p of walk(join(dxt, 'StreamingAssets'))) copy(p, join(out, 'StreamingAssets', relative(join(dxt, 'StreamingAssets'), p)));
for (const p of walk(join(astc, 'StreamingAssets'))) copy(p, join(out, 'StreamingAssets-astc', relative(join(astc, 'StreamingAssets'), p)));
for (const src of [dxt, astc]) for (const p of walk(join(src, 'ServerData'))) { const to = join(out, 'ServerData', relative(join(src, 'ServerData'), p)); if (!existsSync(to)) copy(p, to); }
writeFileSync(join(out, 'textures.json'), JSON.stringify({ astc: { data: `Build/${name}-astc.data.unityweb`, streamingAssets: 'StreamingAssets-astc' } }) + '\n');
writeFileSync(join(out, 'build.txt'), version);

const files = {};
for (const p of walk(out).sort()) {
  const rel = relative(out, p); if (rel === 'webgl.json') continue;
  const b = readFileSync(p);
  const f = { bytes: b.length, sha256: sha(b) };
  if (rel.endsWith('.unityweb')) { const u = brotliDecompressSync(b); f.unpacked = u.length; f.unpackedSha256 = sha(u); }
  files[rel] = f;
}
const manifest = { app: 'nextblock', title: 'Tick Tock, Next Block', build: name, productVersion: version, files };
writeFileSync(join(out, 'webgl.json'), JSON.stringify(manifest, null, 1) + '\n');
console.log(`${name} (${version}): ${Object.keys(files).length} files, ${(Object.values(files).reduce((t, f) => t + f.bytes, 0) / 1048576).toFixed(1)} MB -> ${out}`);

if (flags.includes('--release')) {
  const tag = `webgl-${name}`;
  const staged = join(out, '..', `${tag}-assets`);
  if (existsSync(staged)) rmSync(staged, { recursive: true });
  mkdirSync(staged);
  for (const rel of [...Object.keys(files), 'webgl.json']) copyFileSync(join(out, rel), join(staged, rel.replaceAll('/', '__')));
  execFileSync('gh', ['release', 'create', tag, '--repo', REPO, '--title', `Next Block WebGL ${name} (${version})`,
    '--notes', `Tick Tock, Next Block's WebGL client ${name}, product version ${version}: ${Object.keys(files).length} files. webgl.json lists each file's SHA-256 (and for each brotli .unityweb the SHA-256 of its unpacked bytes, what the Arena pins). An asset's name is its path with "/" as "__".`,
    ...readdirSync(staged).map((f) => join(staged, f))], { stdio: 'inherit' });
  console.log(`released ${tag} on ${REPO}`);
}
