// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE APPS ARE DOWNLOADED, NOT BUNDLED (kanban #575, 2026-10-21: "We said the installer downloads the 3 apps automatically, no
// longer built in"). The release carries apps.lock.json (each app's repository and commit) and apps.files.json (every file a node takes
// of the app at that commit, with its SHA-256 - tools/pin-apps.mjs writes it from the copies, which apps-pinned holds to the pins). Each
// app missing from the release is fetched file by file from its public repository at the pinned commit (raw.githubusercontent.com: no
// GitHub API, no token, no git, no tar), each file checked against its SHA-256 before anything is placed, and put where the release
// would have carried it (<release>/<copy>), so ARENA_APPS and arena-sdk's link resolve as before.
//
//   cache   <home>/apps/<app>@<commit>: the checked files, kept - an update to a release with the same pin downloads nothing
//   marker  <release>/<copy>/.arena-app.json { repo, commit, files }: an app placed by this; a pin that moved is fetched again.
//           A folder without it (a checkout, an older release that bundled its apps) is the release's own and left alone.
//
// Run by the installer before its wizard, by an update before the node is moved, and by the seat's start (run.js) - so a node updated by
// an older updater, which knows nothing of this, gets its apps at the first start of the new release.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, cpSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const MARKER = '.arena-app.json';

/** The raw file of `repo` at `commit`: each path segment encoded. */
export const rawUrl = (repo, commit, path) => `https://raw.githubusercontent.com/${repo}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`;

/**
 * The apps the release at `release` takes from their repositories: [{ name, repo, commit, copy, files: { path: sha256 }, exec: [path] }],
 * from apps.lock.json + apps.files.json. A release without apps.files.json (from before #575) fetches nothing: [].
 */
export function appPins(release) {
  const filesAt = join(release, 'apps.files.json');
  if (!existsSync(filesAt)) return [];
  const lock = JSON.parse(readFileSync(join(release, 'apps.lock.json'), 'utf8'));
  const files = JSON.parse(readFileSync(filesAt, 'utf8'));
  return Object.entries(files.apps).map(([name, f]) => {
    const l = lock.apps[name];
    if (!l) throw new Error(`apps.files.json names ${name}, apps.lock.json does not`);
    if (l.commit !== f.commit) throw new Error(`${name}: apps.files.json is for ${f.commit.slice(0, 12)}, apps.lock.json pins ${l.commit.slice(0, 12)}`);
    return { name, repo: l.repo, commit: l.commit, copy: l.copy, files: f.files, exec: f.exec || [] };
  });
}

// a path the manifest may name: relative, no '..', no absolute, no backslash
const safePath = (p) => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((s) => s === '' || s === '.' || s === '..');

async function pool(items, n, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k]); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

/** One app into the cache: every file present there with its SHA-256, the missing or wrong ones downloaded. Throws on a mismatch. */
async function fill(app, cache, { fetcher, concurrency, timeoutMs, log }) {
  const paths = Object.keys(app.files).sort();
  for (const p of paths) if (!safePath(p) || !/^[0-9a-f]{64}$/.test(app.files[p])) throw new Error(`${app.name}: the manifest names ${JSON.stringify(p)}, not a file of the app`);
  const missing = paths.filter((p) => { try { return sha256(readFileSync(join(cache, p))) !== app.files[p]; } catch { return true; } });
  if (!missing.length) return 0;
  log(`${app.name}: downloading ${missing.length} of ${paths.length} files at ${app.commit.slice(0, 12)}`);
  await pool(missing, concurrency, async (p) => {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetcher(rawUrl(app.repo, app.commit, p), { signal: AbortSignal.timeout(timeoutMs) });
        if (r.status !== 200) throw new Error(`${p} answered ${r.status}`);
        const b = Buffer.from(await r.arrayBuffer());
        // NOTHING UNCHECKED IS KEPT: a file that is not the pinned one is refused, never written
        const got = sha256(b);
        if (got !== app.files[p]) throw Object.assign(new Error(`${p} has SHA-256 ${got.slice(0, 16)}..., not the pinned ${app.files[p].slice(0, 16)}...: refused`), { final: true });
        mkdirSync(dirname(join(cache, p)), { recursive: true });
        writeFileSync(join(cache, p), b);
        return;
      } catch (e) { last = e; if (e.final) break; }
    }
    throw new Error(`${app.name}: ${last.message}`);
  });
  return missing.length;
}

/**
 * Every app of the release at `release` in place. Answers { ok, fetched: [names], kept: [names], why }. `home` holds the cache; `fetcher`
 * is fetch (a test passes its own).
 */
export async function ensureApps({ release, home, fetcher = fetch, concurrency = 8, timeoutMs = 60000, log = () => {} }) {
  let apps;
  try { apps = appPins(release); } catch (e) { return { ok: false, fetched: [], kept: [], why: `the release's app pins do not read: ${e.message}` }; }
  const fetched = [], kept = [];
  for (const app of apps) {
    const target = join(release, app.copy);
    const want = { repo: app.repo, commit: app.commit, files: Object.keys(app.files).length };
    if (existsSync(target)) {
      let marker = null;
      try { marker = JSON.parse(readFileSync(join(target, MARKER), 'utf8')); } catch { /* none */ }
      if (!marker) { kept.push(app.name); continue; }                       // the release's own copy (a checkout, an older bundle)
      if (marker.repo === want.repo && marker.commit === want.commit) { kept.push(app.name); continue; }
      rmSync(target, { recursive: true, force: true });                     // a pin that moved: fetched again below
    }
    const cache = join(home, 'apps', `${app.name}@${app.commit}`);
    try {
      mkdirSync(cache, { recursive: true });
      const n = await fill(app, cache, { fetcher, concurrency, timeoutMs, log });
      // placed whole or not at all: a staging folder beside the target, renamed once complete
      const stage = `${target}.fetching`;
      rmSync(stage, { recursive: true, force: true });
      for (const p of Object.keys(app.files)) {
        mkdirSync(dirname(join(stage, p)), { recursive: true });
        cpSync(join(cache, p), join(stage, p));
        if (app.exec.includes(p)) chmodSync(join(stage, p), 0o755);
      }
      writeFileSync(join(stage, MARKER), JSON.stringify(want, null, 2) + '\n');
      mkdirSync(dirname(target), { recursive: true });
      renameSync(stage, target);
      log(`${app.name}: ${n ? `${n} files downloaded` : 'from the cache'}, checked, in ${app.copy}`);
      fetched.push(app.name);
    } catch (e) {
      rmSync(`${target}.fetching`, { recursive: true, force: true });
      return { ok: false, fetched, kept, why: `${e.message} (from github.com/${app.repo})` };
    }
  }
  return { ok: true, fetched, kept };
}

// node src/app-fetch.js <release> <home>: the apps fetched by hand (the release smoke in CI runs it before it starts a seat)
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [release, home] = process.argv.slice(2).map((p) => resolve(p));
  if (!release || !home) { console.error('usage: node app-fetch.js <release> <home>'); process.exit(2); }
  const r = await ensureApps({ release, home, log: (l) => console.log(l) });
  if (!r.ok) { console.error(`the apps could not be fetched: ${r.why}`); process.exit(1); }
  console.log(`apps: ${r.fetched.length} placed, ${r.kept.length} already there`);
}
