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
import { sandboxChecked } from './core-sandbox.js';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { coreTree, coreRelPath } from './core-hash.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { decodeManifest, encodeManifest, gameIdOf } from '../../arena-protocol/src/manifest.js';
import { gameInfoJson } from '../../arena-protocol/src/game-info.js';
import { checkPackage, packageWindow, TREE_ENTRY } from './plugin-check.js';
import { trialRun, TRIAL_MS, trialThreadsLingering } from './plugin-trial.js';
/** THE FIRST LOAD OF EACH OF AN ADOPTED PACKAGE'S CORES (kanban #2058, #2078): no longer than the trial that passed it, load and meta ask together. */
export const REGISTER_MS = TRIAL_MS;
/** The file an installed core is kept in (kanban #2058; 2.0's trial loads it under the seat's own entry name already, #1694). */
const coreFileOf = (hash) => `core-${hash}.mjs`;
/** The directory a tree core is kept in (kanban #3085). */
const coreDirOf = (hash) => `core-${hash}`;

const sha = (b) => createHash('sha256').update(b).digest('hex');
const b64 = (b) => Buffer.from(b).toString('base64');

/** A hosted game as a package (JSON-able), from its registration's files. Null when it names no source to give. */
// `ancestors` are manifests this seat checked, oldest first; `cut` is the hex marker kept below them (packageWindow), sent first
export function packageOf(game, { ancestors = [], cut = null } = {}) {
  const cores = [];
  for (const [hash, core] of game.cores || []) {
    if (!core || !core.url || !String(core.url).startsWith('file:')) return null;
    if (core.root) {
      // A TREE CORE (kanban #3085, feedback #367): every file below its root and its entry, so a peer checks it by its tree hash
      const root = String(core.root).startsWith('file:') ? fileURLToPath(core.root) : String(core.root);
      const { files } = coreTree(root);
      // kanban #3097, #3099: a tree core is packaged only when it runs from TREE_ENTRY (the one entry checkPackage takes, so the tree hash signs it)
      const entry = coreRelPath(root, fileURLToPath(core.url));
      if (entry !== TREE_ENTRY) return null;
      cores.push({ hash, name: core.name || '', configs: [...(core.configs ? core.configs.keys() : [])], entry,
        files: [...files].map(([path, bytes]) => ({ path, body: b64(bytes) })) });
      continue;
    }
    cores.push({ hash, name: core.name || '', configs: [...(core.configs ? core.configs.keys() : [])], source: b64(readFileSync(new URL(core.url))) });
  }
  const clients = (game.clientUrls || []).map((u) => { const body = readFileSync(new URL(u)); return { hash: sha(body), body: b64(body) }; });
  // ITS ANCESTORS' SIGNED MANIFESTS, oldest first (an update stands only on its parent, §0A.3): the package stands on its own
  return { format: 'arena-plugin/v1', name: game.name, title: game.title || game.name, manifest: toHex(encodeManifest(game.manifest)),
    ancestors: [...(typeof cut === 'string' ? [cut] : []), ...ancestors.map((m) => toHex(encodeManifest(m)))],
    donationSet: (game.donationSet || []).map((r) => ({ recipientPk: toHex(r.recipientPk), shareBps: Number(r.shareBps), label: r.label || '' })),
    cores, clients, ...(game.info ? { info: gameInfoJson(game.info) } : {}) };
}

// THE CHECKS ARE plugin-check.js's (the page runs them too); THE SEAT ADDS THE TRIAL RUN (plugin-trial.js) on every core
export { scanSource, SCAN_RULES } from './plugin-check.js';
/** The page's report plus the seat's trial run: { ok, why, checks, findings, gameId, name, version, devKey, parent }. */
// A CORE'S NAME IS NOBODY'S SIGNATURE (kanban #2990, audit hosting r2-1): a relaying seat that served the genuine package with
// cores[0].name = {"toString":1} made loadCore throw, the trial answered a plain refusal, and the seat kept the GENUINE version as refused
// by its trial for 24 h (autoUpdateSweep) - every honest source after it skipped. Only a short string is a core's name; else its hash's start.
export const coreNameOf = (c) => (typeof c.name === 'string' && c.name ? c.name.slice(0, 80) : String(c.hash).slice(0, 16));
// THE TRIAL'S VERDICT IS KEPT, PER VERSION (kanban #3679, #1489 r1-hosting-1, gap in #2688/#2824): every start ran the whole plugin trial
// for every installed version, and autoUpdateSweep takes a developer's next signed version each sweep with none ever dropped - so a game's
// developer grew every start of every seat hosting it, for good (measured 16 versions 2091 ms against 108 ms for one). A version whose
// trial passed at a start keeps TRIAL_MARK_FILE, written by this seat only, naming exactly what the trial ran: the trial's own code
// (TRIAL_CODE: a new build with another trial tries every version again), the signed manifest, and each core's hash, name, entry and
// configs. A later start still checks everything else (signatures, every file's hash, the scan) and loads each core within REGISTER_MS;
// only the trial of the same bytes under the same trial is not run again.
// THE MARK NAMES THE WHOLE REALM THE TRIAL RAN IN (kanban #3731, audit hosting a8-1-1, gap in #3679): TRIAL_CODE was the bytes of
// plugin-trial.js, core-sandbox.js and plugin-check.js only, but the trial's verdict is decided as much by the realm the core runs in -
// core-host.js (the LOCKDOWN), core-driver.js, core-depth.js (and the acorn it parses with), core-intrinsics.js, core-compile-apart.js,
// core-supervisor.js, core-runner.js - and the sandbox fixes (#3316, #3358, #3242, #2808, #3065) each changed only those. So a release that
// closed a hole kept every older mark, and a seat hosted, untried, a version its own trial refuses, failing at every h2h close of it. It is
// now every core-*.js of this folder (read when the module loads, so a realm file added later - core-nest.js, #3540 - counts without being
// listed), vendor/acorn.mjs, the trial and the check, each by name and bytes, and the Node build that runs them (its V8 decides too).
export const TRIAL_MARK_FILE = 'trial-passed.json';
export const TRIAL_CODE_FILES = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const realm = readdirSync(here).filter((f) => /^core-[\w-]+\.js$/.test(f)).sort();
    return Object.freeze(['plugin-trial.js', 'plugin-check.js', 'vendor/acorn.mjs', ...realm]);
  } catch { return null; }
})();
const TRIAL_CODE = (() => {
  if (TRIAL_CODE_FILES === null || !TRIAL_CODE_FILES.includes('core-sandbox.js') || !TRIAL_CODE_FILES.includes('core-host.js')) return null;
  try {
    const h = createHash('sha256').update(`arena trial code v2\0${process.version}\0`);
    for (const f of TRIAL_CODE_FILES) {
      const bytes = readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)));
      h.update(`${f}\0${bytes.length}\0`).update(bytes);
    }
    return h.digest('hex');
  } catch { return null; }   // never a mark when the trial's code cannot be read
})();
const trialKeyOf = (pkg) => (TRIAL_CODE === null ? null : sha(JSON.stringify([TRIAL_CODE, String(pkg.manifest),
  pkg.cores.map((c) => [String(c.hash), coreNameOf(c), Array.isArray(c.files) ? String(c.entry) : null, Array.isArray(c.configs) ? c.configs.map(String) : []])])));
const trialMarked = (at, pkg) => {
  if (!at) return false;
  try { const key = trialKeyOf(pkg); return key !== null && JSON.parse(readFileSync(join(at, TRIAL_MARK_FILE), 'utf8')).key === key; } catch { return false; }
};
/** Kept beside an installed version whose trial just passed (loadInstalled); a write that fails only means the next start trials it again. */
export function markTrialPassed(at, pkg) {
  const key = trialKeyOf(pkg);
  if (key === null) return false;
  try { writeFileSync(join(at, TRIAL_MARK_FILE), JSON.stringify({ key })); return true; } catch { return false; }
}
// `trialedAt` (kanban #3679): the installed directory whose kept mark may stand for the trial; any other caller always runs it
export function verifyPackage(pkg, { verify, want = null, parentOf, trialedAt = null } = {}) {
  const r = checkPackage(pkg, { verify, want, parentOf });
  if (!r.ok) return r;
  const manifest = decodeManifest(fromHex(String(pkg.manifest)));
  if (trialMarked(trialedAt, pkg)) {
    for (const c of pkg.cores) r.checks.push({ check: `core ${c.hash.slice(0, 12)}… runs in the sandbox`, ok: true, detail: 'its trial passed at an earlier start of this seat, under the same trial' });
    return { ...r, trialKept: true };
  }
  for (const c of pkg.cores) {
    // kanban #3085: a tree core runs from its entry with all its files
    const core = Array.isArray(c.files) ? { files: new Map(c.files.map((f) => [f.path, Buffer.from(f.body, 'base64').toString('utf8')])), entry: c.entry }
      : Buffer.from(c.source, 'base64').toString('utf8');
    const t = trialRun(core, manifest, { name: coreNameOf(c), configs: Array.isArray(c.configs) ? c.configs : [] });
    r.checks.push({ check: `core ${c.hash.slice(0, 12)}… runs in the sandbox`, ok: t.ok, detail: t.ok ? `${t.cases} move combinations, each answered the same twice` : t.why });
    // `trial` (kanban #1880, #1913): the verdict on these signed bytes, which a seat may remember; `retry`: none yet (try again)
    if (!t.ok) return { ...r, ok: false, trial: !t.retry, retry: !!t.retry, why: `the trial run refuses it: ${t.why}` };
  }
  return r;
}

// THE TITLE THIS SEAT GAVE A GAME IS KEPT APART FROM THE PACKAGE (kanban #1716, #1780, after #1541): package.json is the package
// as a serving seat handed it, and a build before #1541 kept it as fetched - so its `title` (and any mark inside it) may be a
// relaying seat's. Only SEAT_TITLE_FILE, which only this seat writes (adoptPackage through installPackage's `title`), names
// the title; a game kept without one is shown under its manifest's signed gameName.
export const SEAT_TITLE_FILE = 'seat-title.json';
/** The title this seat wrote for the game kept at `at`, or null (none written, or unreadable). */
export function seatTitleAt(at) {
  try { const j = JSON.parse(readFileSync(join(at, SEAT_TITLE_FILE), 'utf8')); return typeof j.title === 'string' && j.title ? j.title.slice(0, 80) : null; } catch { return null; }
}

/** Kept on disk, one directory per game id: the package as fetched and its files; `title`, when given, as this seat's title. */
export function installPackage(dir, pkg, gameId, { title = null } = {}) {
  const at = join(dir, gameId);
  mkdirSync(at, { recursive: true });
  for (const c of pkg.cores) {
    if (Array.isArray(c.files)) {
      // kanban #3085: each file below core-<hash>/ at its checked path (checkPackage refused any path leaving the tree)
      const base = join(at, coreDirOf(c.hash));
      for (const f of c.files) { const to = join(base, ...f.path.split('/')); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, Buffer.from(f.body, 'base64')); }
      continue;
    }
    writeFileSync(join(at, coreFileOf(c.hash)), Buffer.from(c.source, 'base64'));
  }
  for (const k of pkg.clients || []) writeFileSync(join(at, `client-${k.hash}.html`), Buffer.from(k.body, 'base64'));
  writeFileSync(join(at, 'package.json'), JSON.stringify(pkg));
  if (typeof title === 'string' && title) writeFileSync(join(at, SEAT_TITLE_FILE), JSON.stringify({ title: title.slice(0, 80) }));
  return at;
}

/** ONE INSTALLED PACKAGE AS A REGISTRATION (activated at once,: no restart): its cores imported from disk. */
// THE NAME AND TITLE ARE NOT THE SERVING SEAT'S (kanban #1541): a package's `name` and `title` are signed by nobody, so a seat
// relaying a genuine signed version could rename the game it hands over. The hosted name is the manifest's signed gameName; the
// title is the one this seat keeps (`title`: its installed version's, or the one it wrote to disk), else that gameName.
// ITS FIRST LOAD IS BOUNDED LIKE THE TRIAL (kanban #2058, #2078): adoptPackage (an owner's install, autoUpdate unattended) and
// loadInstalled (every start) load the same untrusted bytes a second time, and that load ran with an installed core's limits -
// LOAD_MS 10 s, then the ask, then EXIT_WAIT - on the seat's thread: a core that passed the trial held it 10 s here. Each core's
// first load (its meta ask and, refused, its thread's end included) now has the trial's deadline, REGISTER_MS (`within`); one
// not loaded by then is refused. The trial now shows the core the same module name, so a core honest in the trial loads the same way here.
// `load: false` (kanban #3679, #3706): a superseded version a start leaves unloaded - every file still checked against its hash, its cores
// not loaded here (plugins.js loadKept loads them when a round, replay, re-run or re-verify first reaches it)
export async function registrationFromPackage(at, pkg, { title = null, within = REGISTER_MS, load = true } = {}) {
  const manifest = decodeManifest(fromHex(pkg.manifest));
  const cores = new Map();
  for (const c of pkg.cores) {
    const tree = Array.isArray(c.files);
    // kanban #3097, #3099: a tree core loads from TREE_ENTRY only (checkPackage refused any other entry; a package.json kept on disk is not trusted)
    if (tree && c.entry !== TREE_ENTRY) throw new Error(`core ${c.hash.slice(0, 16)} runs from its ${TREE_ENTRY}, not ${String(c.entry).slice(0, 64)}`);
    const file = tree ? join(at, coreDirOf(c.hash), TREE_ENTRY) : join(at, coreFileOf(c.hash));
    if (tree) { if (coreTree(join(at, coreDirOf(c.hash))).hash !== c.hash) throw new Error(`core ${c.hash.slice(0, 16)} changed on disk`); }
    else if (sha(readFileSync(file)) !== c.hash) throw new Error(`core ${c.hash.slice(0, 16)} changed on disk`);
    // NEVER IMPORTED INTO THIS THREAD (§0A.6): loaded into its sandbox from the bytes just checked
    // THE CONFIGS ARE THE SIGNED MANIFEST'S (kanban #1814): a package's cores[].configs are signed by nobody, so a relaying seat
    // could empty them (every round of the version refused) or add one the manifest does not list (hostedPlugins throws)
    const signed = manifest.cores.find((m) => toHex(m.hash) === c.hash);
    const core = { name: coreNameOf(c), hash: c.hash, url: pathToFileURL(file).href, ...(tree ? { root: pathToFileURL(join(at, coreDirOf(c.hash)) + '/').href } : {}),
      configs: new Map((signed ? signed.configs : []).map((h) => [toHex(h), {}])) };
    // THE INSTALL LOAD IS HELD TO THE TRIAL'S BOUND (kanban #1694): a core that passed the trial loaded within TRIAL_MS, so the
    // seat waits no longer for it here (was LOAD_MS, 10 s of the node's thread per version, on install and every restart)
    // kanban #2058, #2078: the load AND its meta ask in one deadline, as the trial's (`within`, REGISTER_MS); kanban #2688: the check keeps no thread
    // kanban #3085: a decide adapter (DECIDE) or a game core (CORE, a tick game such as Next Block); kanban #3679: not loaded when `load` is false
    if (load) {
      const meta = sandboxChecked(core, { loadMs: TRIAL_MS, loadUntil: Date.now() + within }).meta;
      if (!meta.decide && !meta.core) throw new Error(`core ${c.hash.slice(0, 16)} exports neither DECIDE nor CORE`);
    }
    cores.set(c.hash, core);
  }
  // ONLY THE EARLIER VERSIONS THE CHECK READ (kanban #2332, #2346): the newest MAX_PACKAGE_ANCESTORS, which checkPackage decoded
  // and checked before this; the entry below them is kept as the opaque cut marker, never decoded (a forged version there must
  // not reach chainOf's sort or the chain this seat serves), and everything further below is dropped - also from a package.json
  // an older build kept with every entry it was handed.
  const w = packageWindow(pkg.ancestors);
  return { name: manifest.gameName, title: typeof title === 'string' && title ? title.slice(0, 80) : manifest.gameName, manifest, gameId: gameIdOf(manifest), cores, info: pkg.info || null,
    ancestors: w.window.map((h) => decodeManifest(fromHex(h))), ancestorCut: typeof w.cut === 'string' ? w.cut : null,
    donationSet: pkg.donationSet.map((r) => ({ recipientPk: fromHex(r.recipientPk), shareBps: r.shareBps, label: String(r.label || '') })),
    clientUrls: (pkg.clients || []).map((k) => pathToFileURL(join(at, `client-${k.hash}.html`)).href), ...(load ? {} : { unloaded: true }) };
}

/**
 * THE INSTALLED GAMES AS REGISTRATIONS (main.js at start): each package checked again before it is loaded; a removed one
 * (its directory renamed .removed-…) is not. Answers { registrations, refused: [{ dir, why }] }.
 */
const INSTALLED_RETRIES = 3, LINGER_WAIT_MS = 15000;   // kanban #2711
// SUPERSEDED VERSIONS LEFT UNLOADED (kanban #3679, ruled in #3706): `keepUnloaded(ids)` answers which of `ids` - installed versions another
// installed version of the same game (name and developer key) supersedes, whose trial passed at an earlier start - may stay unloaded
// (version-idle.js idleVersions: no open round, no series, everything final and settled, 24 h). Those are checked as every version is
// (signatures, chain, every file's hash) and hosted, but their cores are not loaded at start. Nothing on disk is moved or removed.
export async function loadInstalled(dir, { verify, keepUnloaded = null } = {}) {
  const registrations = [], refused = [], unloaded = [];
  if (!dir || !existsSync(dir)) return { registrations, refused, unloaded };
  const found = [];
  for (const id of readdirSync(dir)) {
    if (!/^[0-9a-f]{64}$/.test(id)) continue;
    const at = join(dir, id);
    try { found.push({ id, at, pkg: JSON.parse(readFileSync(join(at, 'package.json'), 'utf8')) }); } catch (e) { refused.push({ dir: at, why: e.message }); }
  }
  let idle = new Set();
  if (typeof keepUnloaded === 'function') {
    const newest = new Map(), seen = [];
    for (const f of found) {
      try { const m = decodeManifest(fromHex(String(f.pkg.manifest))); const k = `${m.gameName}|${toHex(m.gameDevPubkey)}`; seen.push({ f, k, v: m.version }); newest.set(k, Math.max(newest.get(k) ?? -1, m.version)); }
      catch { /* checked, and refused, below */ }
    }
    const candidates = seen.filter(({ f, k, v }) => v < newest.get(k) && trialMarked(f.at, f.pkg)).map(({ f }) => f.id);
    if (candidates.length) { try { idle = new Set(keepUnloaded(candidates) || []); } catch { idle = new Set(); } }
  }
  for (const { id, at, pkg } of found) {
    let v = verifyPackage(pkg, { verify, want: id, trialedAt: at });   // kanban #3679: a kept verdict on the same bytes, same trial
    // "NO VERDICT YET" IS NOT A REFUSAL (kanban #2711, #1489 r4-hosting-7): one package's trial that overran inside an uninterruptible
    // builtin leaves its thread lingering, and every package checked after it got { retry } - refused for the life of the process, so one
    // slow (or ground-to-sort-first) package dropped every installed game after it at each start. Now the start waits for the lingering
    // trial thread to end (bounded) and checks that package again.
    for (let tries = 0; !v.ok && v.retry && tries < INSTALLED_RETRIES; tries++) {
      const until = Date.now() + LINGER_WAIT_MS;
      while (trialThreadsLingering() > 0 && Date.now() < until) await new Promise((ok) => setTimeout(ok, 50));   // 2.0: the trial's own names (#1694)
      v = verifyPackage(pkg, { verify, want: id });
    }
    if (!v.ok) { refused.push({ dir: at, why: v.why }); continue; }
    if (!v.trialKept) markTrialPassed(at, pkg);   // kanban #3679: this version's trial passed here; the next start does not run it again
    // the title this seat wrote itself (kanban #1541, #1716, #1780): never package.json's, which an older build kept as a seat relayed it
    const load = !(idle.has(id) && v.trialKept);   // kanban #3679: only a version whose trial result was kept is left unloaded
    try { registrations.push(await registrationFromPackage(at, pkg, { title: seatTitleAt(at), load })); if (!load) unloaded.push(id); } catch (e) { refused.push({ dir: at, why: e.message }); }
  }
  return { registrations, refused, unloaded };
}
