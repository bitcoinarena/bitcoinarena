// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUTO UPDATE (2026-10-19: "Also include an Auto update for v0.1.1", "Publish it on a but unlisted for now, only nodes
// see it. Later it's going to be on public GitHub"). A node updates itself to a newer release:
//
//   1. the newest release is the signed release/latest.json (release-latest.js: believed only under the Arena release key);
//   2. newer than the release this node runs, and auto_update not off in arena.conf: this node's own asset is fetched - in pieces from the
//      unlisted path latest.json names (tools/release/unlisted.mjs; Cloudflare Pages serves at most 25 MiB a file), joined, its SHA-256
//      checked against latest.json, and SHA256SUMS + SHA256SUMS.sig checked against the release key (release-verify.js) as a manual update does;
//   3. unpacked beside the running release and the node moved to it by update.js - outside a market seating window, backed up, the same
//      node answering after, rolled back by itself if not.
//
// `arenanode update` does it once, now; `arenanode auto-update` is the service that checks every few hours. That service names the
// node's own arenanode command, not a release, so an update never stops it mid-way; after an update it ends and its service starts it
// again from the new release.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkAsset } from './release-verify.js';
import { updateNode } from './update.js';
import { nodeOf } from './node-services.js';

/** This system's asset of a release: arena-node-<v>-<linux|darwin|windows>-<x64|arm64>.tar.gz (.zip on Windows). */
export const assetNameFor = (version, platform = process.platform, arch = process.arch) =>
  `arena-node-${version}-${platform === 'win32' ? 'windows' : platform}-${arch}${platform === 'win32' ? '.zip' : '.tar.gz'}`;

/** auto_update in arena.conf: on unless 0 / off / no / false. */
export const autoUpdateOn = (values) => !['0', 'off', 'no', 'false'].includes(String(values.auto_update ?? '1').trim().toLowerCase());

const record = (home, r) => { try { writeFileSync(join(home, 'auto-update.json'), JSON.stringify({ atMs: Date.now(), ...r }, null, 2) + '\n', { mode: 0o600 }); } catch { /* the log has it */ } };

/**
 * One check, and an update when a newer release is out. `latest(ownVersion)` the release reader's read; `force` updates even when
 * auto_update is off (`arenanode update`). Answers { ok, upToDate?, skipped?, from?, to?, why? }.
 */
export async function checkOnce({ home, latest, fetcher = fetch, platform = process.platform, arch = process.arch, apply = updateNode, force = false, log = () => {},
  verifyAsset = checkAsset,
  unpack = (archive, dir) => execFileSync('tar', [archive.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', dir]) }) {
  const node = nodeOf(home);
  if (!force && !autoUpdateOn(node.conf.values)) return { ok: true, skipped: 'auto_update is off in arena.conf' };
  if (!node.version) return { ok: false, why: 'this node does not know the release it runs (no VERSION in its release)' };
  const l = await latest(node.version);
  if (!l.latest) return { ok: false, why: l.why || 'the newest release could not be read' };
  if (!l.newer) return { ok: true, upToDate: true, version: node.version, latest: l.latest.version };
  const v = l.latest.version;
  const name = assetNameFor(v, platform, arch);
  const want = (l.latest.assets || {})[name];
  const d = l.latest.download;
  if (!want || !d || !d.base || !d.parts || !Array.isArray(d.parts[name]) || !d.parts[name].length) return { ok: false, why: `release ${v} names no download of ${name} for this system` };
  log(`release ${v} is out (this node runs ${node.version}): fetching ${name} in ${d.parts[name].length} piece(s)`);
  const dir = join(home, 'releases', 'downloads', v);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const get = async (piece) => {
    const r = await fetcher(new URL(piece, d.base).href, { signal: AbortSignal.timeout(300000), cache: 'no-store' });
    if (r.status !== 200) throw new Error(`${piece} answered ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
  // THE PIECES JOINED, THE WHOLE CHECKED: nothing is unpacked unless its SHA-256 is the one the signed latest.json names
  if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== want) {
    const part = `${file}.download`;
    rmSync(part, { force: true });
    const hash = createHash('sha256');
    try {
      for (const piece of d.parts[name]) { const b = await get(piece); hash.update(b); appendFileSync(part, b); }
    } catch (e) { rmSync(part, { force: true }); return { ok: false, why: `the download stopped: ${e.message}` }; }
    const got = hash.digest('hex');
    if (got !== want) { rmSync(part, { force: true }); return { ok: false, why: `${name} downloaded with SHA-256 ${got.slice(0, 16)}..., not the ${want.slice(0, 16)}... the signed latest.json names: not used` }; }
    renameSync(part, file);
  }
  let sums, sig;
  try { sums = await get(d.sums || 'SHA256SUMS'); sig = (await get(d.sig || 'SHA256SUMS.sig')).toString('utf8'); } catch (e) { return { ok: false, why: `SHA256SUMS could not be read: ${e.message}` }; }
  writeFileSync(join(dir, 'SHA256SUMS'), sums); writeFileSync(join(dir, 'SHA256SUMS.sig'), sig);
  const c = verifyAsset({ file, sums, sig });
  if (!c.ok) return { ok: false, why: `refused: ${c.why}` };
  const base = name.replace(/\.(tar\.gz|zip)$/, '');
  const releases = join(home, 'releases');
  if (!existsSync(join(releases, base))) unpack(file, releases);
  const newRelease = join(releases, base);
  log(`${name} checked and unpacked: updating the node ${node.version} -> ${v}`);
  // the auto update service comes with the update where the node has none yet (a node updated by `arenanode update` keeps updating itself)
  const installUpdaterFn = async (o) => {
    const [{ installUpdater, updaterLauncherStale }, { installProgram }, { serviceFile }] = await Promise.all([import('./launchers.js'), import('./service.js'), import('./node-services.js')]);
    const file = serviceFile('updater', { home, platform, env: process.env });
    return existsSync(file) && !updaterLauncherStale(file, platform) ? { ok: true, already: true } : installUpdater({ ...o, installProgram });
  };
  const r = await apply({ home, newRelease, port: node.port, node: join(newRelease, 'runtime', platform === 'win32' ? 'node.exe' : 'node'), installUpdaterFn });
  const out = r.ok ? { ok: true, from: node.version, to: v, backup: r.backup } : { ok: false, from: node.version, to: v, why: r.why, rolledBack: !!r.rolledBack };
  record(home, out);
  return out;
}

/**
 * The service: a check now (after `firstMs`) and every `everyMs`; after an update it ends with `exitAfterUpdate` (75) so its service
 * starts it again from the new release. `sleep` and `exit` injectable for the tests.
 */
export async function runAutoUpdate({ home, latest, everyMs = 6 * 3600_000, firstMs = 10 * 60_000, log = (l) => console.log(`${new Date().toISOString()} ${l}`),
  sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), exit = (code) => process.exit(code), once = checkOnce, rounds = Infinity }) {
  log(`auto update: on for ${home}; first check in ${Math.round(firstMs / 60000)} min, then every ${Math.round(everyMs / 3600000)} h`);
  await sleep(firstMs);
  for (let i = 0; i < rounds; i++) {
    let r;
    try { r = await once({ home, latest, log }); } catch (e) { r = { ok: false, why: e.message }; }
    log(r.upToDate ? `up to date (${r.version})` : r.skipped ? r.skipped : r.ok ? `updated ${r.from} -> ${r.to}` : `no update: ${r.why}`);
    if (r.ok && r.to) { log('ending: this service starts again from the new release'); return exit(75); }
    await sleep(everyMs);
  }
  return null;
}
