// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLUGIN STORE'S PACKAGE (2026-10-09: "Choose supported games and markets, as a plugin store.
// See what other nodes host. Install it. Always scan for malicious code before install"; 2026-10-10: "some sort of plugin
// system where games can be downloaded from other nodes"). A seat serves each game it hosts as one package: its signed
// manifest, its developer's donation set, its cores' sources and its clients - and an installing seat takes it only when
//   - the manifest stands (its developer's signature over its body, as every seat checks a game),
//   - the donation set is the one the manifest names,
//   - every core and client is byte for byte the file the manifest names by hash,
//   - and every core's source passes the scan: no module loading, no network, no file system, no process, no eval.
// A decide adapter is pure: it takes the revealed moves and answers verdicts. Replayed games' wasm cores are not packaged
// here (their cores are installed with their engine); attested markets have no core and package their manifest and client.
import { sandboxFor } from './core-sandbox.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeManifest, encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { gameInfoJson } from '../../arena-protocol/src/game-info.js';
import { checkPackage } from './plugin-check.js';
import { trialRun } from './plugin-trial.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const b64 = (b) => Buffer.from(b).toString('base64');

/** A hosted game as a package (JSON-able), from its registration's files. Null when it names no source to give. */
export function packageOf(game, { ancestors = [] } = {}) {
  const cores = [];
  for (const [hash, core] of game.cores || []) {
    if (!core || !core.url || !String(core.url).startsWith('file:')) return null;
    cores.push({ hash, name: core.name || '', configs: [...(core.configs ? core.configs.keys() : [])], source: b64(readFileSync(new URL(core.url))) });
  }
  const clients = (game.clientUrls || []).map((u) => { const body = readFileSync(new URL(u)); return { hash: sha(body), body: b64(body) }; });
  // ITS ANCESTORS' SIGNED MANIFESTS, oldest first (an update stands only on its parent, §0A.3): the package stands on its own
  return { format: 'arena-plugin/v1', name: game.name, title: game.title || game.name, manifest: toHex(encodeManifest(game.manifest)),
    ancestors: ancestors.map((m) => toHex(encodeManifest(m))),
    donationSet: (game.donationSet || []).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: Number(r.shareBps), label: r.label || '' })),
    cores, clients, ...(game.info ? { info: gameInfoJson(game.info) } : {}) };
}

// THE CHECKS ARE plugin-check.js's (the page runs them too); THE SEAT ADDS THE TRIAL RUN (plugin-trial.js) on every core
export { scanSource, SCAN_RULES } from './plugin-check.js';
/** The page's report plus the seat's trial run: { ok, why, checks, findings, gameId, name, version, devKey, parent }. */
export function verifyPackage(pkg, { verify, want = null, parentOf } = {}) {
  const r = checkPackage(pkg, { verify, want, parentOf });
  if (!r.ok) return r;
  const manifest = decodeManifest(fromHex(String(pkg.manifest)));
  for (const c of pkg.cores) {
    const t = trialRun(Buffer.from(c.source, 'base64').toString('utf8'), manifest);
    r.checks.push({ check: `core ${c.hash.slice(0, 12)}… runs in the sandbox`, ok: t.ok, detail: t.ok ? `${t.cases} move combinations, each answered the same twice` : t.why });
    if (!t.ok) return { ...r, ok: false, why: `the trial run refuses it: ${t.why}` };
  }
  return r;
}

/** Kept on disk, one directory per game id: the package as fetched and its files. */
export function installPackage(dir, pkg, gameId) {
  const at = join(dir, gameId);
  mkdirSync(at, { recursive: true });
  for (const c of pkg.cores) writeFileSync(join(at, `core-${c.hash}.mjs`), Buffer.from(c.source, 'base64'));
  for (const k of pkg.clients || []) writeFileSync(join(at, `client-${k.hash}.html`), Buffer.from(k.body, 'base64'));
  writeFileSync(join(at, 'package.json'), JSON.stringify(pkg));
  return at;
}

/** ONE INSTALLED PACKAGE AS A REGISTRATION (activated at once,: no restart): its cores imported from disk. */
export async function registrationFromPackage(at, pkg) {
  const manifest = decodeManifest(fromHex(pkg.manifest));
  const cores = new Map();
  for (const c of pkg.cores) {
    const file = join(at, `core-${c.hash}.mjs`);
    if (sha(readFileSync(file)) !== c.hash) throw new Error(`core ${c.hash.slice(0, 16)} changed on disk`);
    // NEVER IMPORTED INTO THIS THREAD (§0A.6): loaded into its sandbox from the bytes just checked
    const core = { name: c.name, hash: c.hash, url: pathToFileURL(file).href, configs: new Map((c.configs || []).map((h) => [h, {}])) };
    if (!sandboxFor(core).meta.decide) throw new Error(`core ${c.hash.slice(0, 16)} exports no DECIDE`);
    cores.set(c.hash, core);
  }
  return { name: pkg.name, title: pkg.title, manifest, gameId: gameIdOf(manifest), cores, info: pkg.info || null,
    ancestors: (pkg.ancestors || []).map((h) => decodeManifest(fromHex(h))),
    donationSet: pkg.donationSet.map((r) => ({ recipientPk: fromHex(r.recipientPk), shareBps: r.shareBps, label: r.label })),
    clientUrls: (pkg.clients || []).map((k) => pathToFileURL(join(at, `client-${k.hash}.html`)).href) };
}

/**
 * THE INSTALLED GAMES AS REGISTRATIONS (main.js at start): each package checked again before it is loaded; a removed one
 * (its directory renamed .removed-…) is not. Answers { registrations, refused: [{ dir, why }] }.
 */
export async function loadInstalled(dir, { verify }) {
  const registrations = [], refused = [];
  if (!dir || !existsSync(dir)) return { registrations, refused };
  for (const id of readdirSync(dir)) {
    if (!/^[0-9a-f]{64}$/.test(id)) continue;
    const at = join(dir, id);
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')); } catch (e) { refused.push({ dir: at, why: e.message }); continue; }
    const v = verifyPackage(pkg, { verify, want: id });
    if (!v.ok) { refused.push({ dir: at, why: v.why }); continue; }
    try { registrations.push(await registrationFromPackage(at, pkg)); } catch (e) { refused.push({ dir: at, why: e.message }); }
  }
  return { registrations, refused };
}
