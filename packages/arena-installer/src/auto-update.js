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
// `bitcoinarena update` does it once, now; `bitcoinarena auto-update` is the service that checks every 30 minutes. That service names the
// node's own command (<home>/bin/bitcoinarena; <home>/bin/arenanode on a node installed before 2026.1.9.8, which runs it since), not a release, so an update never stops it mid-way; after an update it ends and its service starts it
// again from the new release.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkAsset } from './release-verify.js';
import { updateNode } from './update.js';
import { nodeOf } from './node-services.js';
import { QUIET } from '../../arena-node/src/log-level.js';
import { within, mbOf, progressBar } from './update-progress.js';

/** The release files' name (kanban #635, 2026-10-25: "Es muss bitcoin-arena-node heissen"); before 2026.1.8, arena-node. */
export const ASSET_PREFIX = 'bitcoin-arena-node';
export const LEGACY_ASSET_PREFIX = 'arena-node';
/** This system's asset of a release: bitcoin-arena-node-<v>-<linux|darwin|windows>-<x64|arm64>.tar.gz (.zip on Windows). */
export const assetNameFor = (version, platform = process.platform, arch = process.arch, prefix = ASSET_PREFIX) =>
  `${prefix}-${version}-${platform === 'win32' ? 'windows' : platform}-${arch}${platform === 'win32' ? '.zip' : '.tar.gz'}`;

/** auto_update in arena.conf: on unless 0 / off / no / false. */
export const autoUpdateOn = (values) => !['0', 'off', 'no', 'false'].includes(String(values.auto_update ?? '1').trim().toLowerCase());

const record = (home, r) => { try { writeFileSync(join(home, 'auto-update.json'), JSON.stringify({ atMs: Date.now(), ...r }, null, 2) + '\n', { mode: 0o600 }); } catch { /* the log has it */ } };

/**
 * One check, and an update when a newer release is out. `latest(ownVersion)` the release reader's read; `force` updates even when
 * auto_update is off (`bitcoinarena update`). Answers { ok, upToDate?, skipped?, from?, to?, why? }.
 * THE UPDATE'S PROGRESS (kanban #706): once a newer release is found, `progress` takes { pct, step, detail } - the download 0-50 % by its
 * bytes, the signature, unpacking, then the node's move (update.js) 60-100 % - and at the end { done } or { failed, step, why }. A check
 * that finds nothing to do reports nothing (the service's log stays quiet).
 */
export async function checkOnce({ progress = () => {}, ...o }) {
  let at = null, ended = false;
  const tell = (p) => { if (p.done || p.failed) ended = true; else at = p; try { progress(p); } catch { /* a reporter never stops the update */ } };
  const say = (pct, step, detail = '') => tell({ pct: pct ?? (at ? at.pct : 0), step, detail });
  let r;
  try { r = await updateOnce({ ...o, say, moved: within(tell, 60, 100) }); } catch (e) { if (at && !ended) tell({ failed: true, pct: at.pct, step: at.step, why: e.message }); throw e; }
  if (at && !ended) tell(r.ok ? { done: true, pct: 100 } : { failed: true, pct: at.pct, step: at.step, why: r.why });
  return r;
}

async function updateOnce({ home, latest, fetcher = fetch, platform = process.platform, arch = process.arch, apply = updateNode, force = false, log = () => {},
  verifyAsset = checkAsset, trace: given = QUIET, say = () => {}, moved = () => {},
  unpack = (archive, dir) => execFileSync('tar', [archive.endsWith('.zip') ? '-xf' : '-xzf', archive, '-C', dir]) }) {
  // EACH STEP OF THE UPDATE SAID AT --verbose (kanban #693): what is read, fetched and checked, with its time; the decisions at --debug
  const trace = given.tag('update');
  const node = nodeOf(home);
  trace.verbose(`this node: ${home}, release ${node.release || '(none)'} (${node.version || 'no VERSION'}), seat port ${node.port || '-'}`);
  trace.debug(`auto_update in arena.conf: ${node.conf.values.auto_update ?? '(not set: on)'}${force ? '; this update was asked for by hand, so it runs either way' : ''}`);
  if (!force && !autoUpdateOn(node.conf.values)) return { ok: true, skipped: 'auto_update is off in arena.conf' };
  if (!node.version) return { ok: false, why: 'this node does not know the release it runs (no VERSION in its release)' };
  let t0 = performance.now();
  trace.verbose('reading the newest signed release (latest.json and its signature)');
  const l = await latest(node.version);
  trace.verbose(l.latest ? `the newest release is ${l.latest.version}${l.latest.commit ? ` (${l.latest.commit.slice(0, 12)})` : ''}; this node runs ${node.version}: ${l.newer ? 'newer' : 'not newer'} (${trace.since(t0)})` : `the newest release could not be read: ${l.why} (${trace.since(t0)})`);
  if (!l.latest) return { ok: false, why: l.why || 'the newest release could not be read' };
  if (!l.newer) return { ok: true, upToDate: true, version: node.version, latest: l.latest.version };
  const v = l.latest.version;
  // the new name first; a release that still carries the old one (its update channel, for nodes before 2026.1.8) under that
  const name = [assetNameFor(v, platform, arch), assetNameFor(v, platform, arch, LEGACY_ASSET_PREFIX)].find((n) => (l.latest.assets || {})[n]) || assetNameFor(v, platform, arch);
  trace.debug(`this system's asset: ${name} (${platform}-${arch}; ${name.startsWith(`${ASSET_PREFIX}-`) ? 'the new name' : 'the release carries only the name before 2026.1.8'}); the release names ${Object.keys(l.latest.assets || {}).length} asset(s)`);
  const want = (l.latest.assets || {})[name];
  const d = l.latest.download;
  if (!want || !d || !d.base || !d.parts || !Array.isArray(d.parts[name]) || !d.parts[name].length) return { ok: false, why: `release ${v} names no download of ${name} for this system` };
  log(`release ${v} is out (this node runs ${node.version}): fetching ${name} in ${d.parts[name].length} piece(s)`);
  const dir = join(home, 'releases', 'downloads', v);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  // each piece read as it arrives, its bytes counted (`onBytes`) for the progress
  const get = async (piece, onBytes = () => {}) => {
    const at = performance.now();
    const r = await fetcher(new URL(piece, d.base).href, { signal: AbortSignal.timeout(300000), cache: 'no-store' });
    if (r.status !== 200) throw new Error(`${piece} answered ${r.status}`);
    let b;
    if (r.body && typeof r.body.getReader === 'function') {
      const reader = r.body.getReader(), chunks = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); onBytes(value.length); }
      b = Buffer.concat(chunks);
    } else { b = Buffer.from(await r.arrayBuffer()); onBytes(b.length); }
    trace.verbose(`got ${new URL(piece, d.base).href}: ${b.length} bytes in ${trace.since(at)}`);
    return b;
  };
  // THE WHOLE SIZE FIRST: each piece's Content-Length from a HEAD; where one does not say it, the bar counts pieces instead of bytes
  const sizeOf = async (piece) => {
    try {
      const r = await fetcher(new URL(piece, d.base).href, { method: 'HEAD', signal: AbortSignal.timeout(30000), cache: 'no-store' });
      const n = r.status === 200 && r.headers && typeof r.headers.get === 'function' ? Number(r.headers.get('content-length')) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
  };
  trace.debug(`the download: ${d.base}, ${d.parts[name].length} piece(s) into ${file}${existsSync(file) ? ' (a file is there from before: used when its SHA-256 is the one named)' : ''}`);
  // THE PIECES JOINED, THE WHOLE CHECKED: nothing is unpacked unless its SHA-256 is the one the signed latest.json names
  if (!existsSync(file) || createHash('sha256').update(readFileSync(file)).digest('hex') !== want) {
    const part = `${file}.download`;
    rmSync(part, { force: true });
    const hash = createHash('sha256');
    const pieces = d.parts[name];
    say(0, `Downloading ${v}`);
    const sizes = await Promise.all(pieces.map(sizeOf));
    const total = sizes.every((n) => n) ? sizes.reduce((a, n) => a + n, 0) : null;
    trace.debug(`the download's size: ${total ? `${total} bytes in ${pieces.length} piece(s)` : 'not said by every piece: counted in pieces'}`);
    let have = 0;
    try {
      for (let i = 0; i < pieces.length; i++) {
        let inPiece = 0;
        const b = await get(pieces[i], (n) => {
          have += n; inPiece += n;
          if (total) say(Math.min(50, (have / total) * 50), `Downloading ${v}`, mbOf(have, total));
          else say(((i + (sizes[i] ? Math.min(1, inPiece / sizes[i]) : 0)) / pieces.length) * 50, `Downloading ${v}`, `piece ${i + 1} of ${pieces.length}`);
        });
        hash.update(b); appendFileSync(part, b);
        if (!total) say(((i + 1) / pieces.length) * 50, `Downloading ${v}`, `piece ${i + 1} of ${pieces.length}`);
      }
    } catch (e) { trace.fail('the download', e); rmSync(part, { force: true }); return { ok: false, why: `the download stopped: ${e.message}` }; }
    const got = hash.digest('hex');
    trace.verbose(`${name}: SHA-256 ${got.slice(0, 16)}... ${got === want ? 'is' : 'is NOT'} the one the signed latest.json names`);
    if (got !== want) { rmSync(part, { force: true }); return { ok: false, why: `${name} downloaded with SHA-256 ${got.slice(0, 16)}..., not the ${want.slice(0, 16)}... the signed latest.json names: not used` }; }
    renameSync(part, file);
  } else say(50, `Downloading ${v}`, 'downloaded before');
  say(50, 'Checking the signature');
  let sums, sig;
  try { sums = await get(d.sums || 'SHA256SUMS'); sig = (await get(d.sig || 'SHA256SUMS.sig')).toString('utf8'); } catch (e) { return { ok: false, why: `SHA256SUMS could not be read: ${e.message}` }; }
  writeFileSync(join(dir, 'SHA256SUMS'), sums); writeFileSync(join(dir, 'SHA256SUMS.sig'), sig);
  const c = verifyAsset({ file, sums, sig });
  trace.verbose(`SHA256SUMS and its signature against the Arena release key: ${c.ok ? 'ok' : `refused (${c.why})`}`);
  if (!c.ok) return { ok: false, why: `refused: ${c.why}` };
  const base = name.replace(/\.(tar\.gz|zip)$/, '');
  const releases = join(home, 'releases');
  t0 = performance.now();
  say(53, `Unpacking ${v}`);
  if (!existsSync(join(releases, base))) { unpack(file, releases); trace.verbose(`unpacked into ${join(releases, base)} (${trace.since(t0)})`); }
  else trace.verbose(`${join(releases, base)} is there already: not unpacked again`);
  const newRelease = join(releases, base);
  log(`${name} checked and unpacked: updating the node ${node.version} -> ${v}`);
  // the auto update service comes with the update where the node has none yet (a node updated by `bitcoinarena update` keeps updating itself)
  const installUpdaterFn = async (o) => {
    const [{ installUpdater, updaterLauncherStale }, { installProgram }, { serviceFile }] = await Promise.all([import('./launchers.js'), import('./service.js'), import('./node-services.js')]);
    const file = serviceFile('updater', { home, platform, env: process.env });
    return existsSync(file) && !updaterLauncherStale(file, platform) ? { ok: true, already: true } : installUpdater({ ...o, installProgram });
  };
  t0 = performance.now();
  say(60, `Updating your node to ${v}`);
  const r = await apply({ home, newRelease, port: node.port, node: join(newRelease, 'runtime', platform === 'win32' ? 'node.exe' : 'node'), installUpdaterFn, trace: given, progress: moved });
  trace.verbose(`the node moved: ${r.ok ? 'ok' : r.rolledBack ? 'rolled back' : 'not updated'} (${trace.since(t0)})`);
  const out = r.ok ? { ok: true, from: node.version, to: v, backup: r.backup } : { ok: false, from: node.version, to: v, why: r.why, rolledBack: !!r.rolledBack };
  record(home, out);
  return out;
}

/**
 * The service: a check now (after `firstMs`) and every `everyMs`; after an update it ends with `exitAfterUpdate` (75) so its service
 * starts it again from the new release. `sleep` and `exit` injectable for the tests.
 */
export async function runAutoUpdate({ home, latest, everyMs = 30 * 60_000, firstMs = 10 * 60_000, log = (l) => console.log(`${new Date().toISOString()} ${l}`),
  sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), exit = (code) => process.exit(code), once = checkOnce, rounds = Infinity, trace = QUIET }) {
  log(`auto update: on for ${home}; first check in ${Math.round(firstMs / 60000)} min, then every ${Math.round(everyMs / 60000)} min`);
  await sleep(firstMs);
  for (let i = 0; i < rounds; i++) {
    let r;
    // the progress in the service's log: one line per step (update-progress.js)
    try { r = await once({ home, latest, log, trace, progress: progressBar({ line: log }).report }); } catch (e) { trace.tag('update').fail('the check', e); r = { ok: false, why: e.message }; }
    log(r.upToDate ? `up to date (${r.version})` : r.skipped ? r.skipped : r.ok ? `updated ${r.from} -> ${r.to}` : `no update: ${r.why}`);
    if (r.ok && r.to) { log('ending: this service starts again from the new release'); return exit(75); }
    await sleep(everyMs);
  }
  return null;
}
