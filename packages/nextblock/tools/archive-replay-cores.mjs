// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY CORE A STORED ROUND NAMES, KEPT FOR ITS REPLAY (2026-09-26 13:28: "the copied replay link must keep working.
// Always ... Keep every core a stored round names, and serve it. Do not drop it when HEAD moves").
//
// A signer node installs one core, the one its tree builds. A replay of a round that named an earlier core was refused
// with 409 ("this signer node holds no core ...") the moment the tree moved, although the round and its ticks were still
// stored. This tool finds, in this repository's history, the commit whose core/src hashes (tools/hash-core.js's rule: the
// .js files under src, sorted, each as its relative path, a NUL, its bytes, a NUL) to each wanted core, and bundles that
// commit's core for the replay page (tools/bundle-replay.js, ARENA_REPLAY_SRC) into <out>/<hash>.js. The node serves a
// round's core from that directory when it is not the one installed (server.js, replayCoresDir).
//
//   node tools/archive-replay-cores.mjs <out dir> <core hash hex>...
//   node tools/archive-replay-cores.mjs <out dir> --stores a.db b.db     (every core the stored rounds name)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const TOP = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE }).toString().trim();
const git = (...a) => execFileSync('git', a, { cwd: TOP, maxBuffer: 1 << 30 });   // pathspecs from the repository's root
const [out, ...rest] = process.argv.slice(2);
if (!out || !rest.length) { console.error('usage: archive-replay-cores.mjs <out dir> <hash>... | --stores <db>...'); process.exit(2); }
mkdirSync(out, { recursive: true });

let wanted = rest;
if (rest[0] === '--stores') {
  const { DatabaseSync } = await import('node:sqlite');
  const { decodeRoundContract } = await import('../../arena-protocol/src/contracts.js');
  const set = new Set();
  for (const f of rest.slice(1)) {
    const db = new DatabaseSync(f, { readOnly: true });
    for (const r of db.prepare('select contract from rounds').all()) {
      try { set.add(Buffer.from(decodeRoundContract(new Uint8Array(r.contract)).simCoreHash).toString('hex')); } catch { /* not a round */ }
    }
  }
  wanted = [...set];
}
const need = new Set(wanted.filter((h) => !existsSync(join(out, `${h}.js`))));
console.log(`${wanted.length} core(s) named, ${need.size} not yet in ${out}`);

// THE HASH OF A COMMIT'S core/src, from git's own objects - no checkout
const root = git('rev-parse', '--show-toplevel').toString().trim();
const blobs = new Map();
const blob = (sha) => { if (!blobs.has(sha)) blobs.set(sha, git('cat-file', 'blob', sha)); return blobs.get(sha); };
const hashOf = (commit) => {
  const list = git('ls-tree', '-r', commit, '--', 'packages/nextblock/src').toString().trim().split('\n').filter(Boolean)
    .map((l) => { const [meta, path] = l.split('\t'); return { sha: meta.split(' ')[2], rel: path.slice('packages/nextblock/src/'.length) }; })
    .filter((f) => f.rel.endsWith('.js'))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = createHash('sha256');
  for (const f of list) { h.update(f.rel); h.update('\0'); h.update(blob(f.sha)); h.update('\0'); }
  return h.digest('hex');
};

const found = new Map();
if (need.size) {
  const seenTrees = new Set();
  const commits = git('rev-list', '--all', '--', 'packages/nextblock/src').toString().trim().split('\n').filter(Boolean);
  for (const c of commits) {
    let tree;
    try { tree = execFileSync('git', ['rev-parse', `${c}:packages/nextblock/src`], { cwd: TOP, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { continue; }
    if (seenTrees.has(tree)) continue;
    seenTrees.add(tree);
    const h = hashOf(c);
    if (need.has(h) && !found.has(h)) found.set(h, c);
    if (found.size === need.size) break;
  }
}

for (const h of need) {
  const c = found.get(h);
  if (!c) { console.log(`${h.slice(0, 16)}  NOT FOUND in this repository's history`); continue; }
  const tmp = mkdtempSync(join(tmpdir(), 'replay-core-'));
  try {
    execFileSync('bash', ['-c', `git -C '${root}' archive ${c} packages/nextblock/src | tar -x -C '${tmp}'`]);
    execFileSync(process.execPath, [join(HERE, 'bundle-replay.js')], {
      env: { ...process.env, ARENA_REPLAY_SRC: join(tmp, 'packages/nextblock/src'), ARENA_BUNDLE_OUT: tmp } });
    const js = execFileSync('cat', [join(tmp, 'blwp-replay-core.js')]);
    writeFileSync(join(out, `${h}.js`), js);
    console.log(`${h.slice(0, 16)}  from ${c.slice(0, 8)}  ${(js.length / 1024).toFixed(1)} KB`);
  } catch (e) {
    console.log(`${h.slice(0, 16)}  from ${c.slice(0, 8)}  DID NOT BUNDLE: ${String(e.message).split('\n')[0].slice(0, 160)}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
