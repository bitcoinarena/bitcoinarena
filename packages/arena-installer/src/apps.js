// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE APPS A NODE HOSTS (kanban #569, 2026-10-21: "The node still comes with the 3 apps pre installed, that is a step in the
// installer where all apps are automatically selected"). Each app the release carries says what a node hosts of it in its own
// packages/<app>/app.json: { id, title, short, registrations } - the registration modules (every version still played), relative to the
// app's folder. The apps step lists them, all chosen; the seat loads the chosen ones' registrations (ARENA_APPS, arena.conf apps=).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** The app every node has hosted from the start: listed first. */
export const FIRST_APP = 'nextblock';

/** The apps of the release at `release`: [{ id, title, short, registrations: absolute paths }], Next Block first, then by title. */
export function appsIn(release) {
  const dir = join(release, 'packages');
  const apps = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return apps; }
  for (const name of names) {
    const file = join(dir, name, 'app.json');
    if (!existsSync(file)) continue;
    const a = JSON.parse(readFileSync(file, 'utf8'));
    if (!a.id || !Array.isArray(a.registrations) || !a.registrations.length) throw new Error(`${file}: no id or no registrations`);
    apps.push({ id: String(a.id), title: String(a.title || a.id), short: String(a.short || a.title || a.id),
      registrations: a.registrations.map((r) => join(dir, name, r)) });
  }
  return apps.sort((x, y) => (x.id === FIRST_APP ? -1 : y.id === FIRST_APP ? 1 : x.title.localeCompare(y.title)));
}

/** The apps the wizard shows: id, titles and how many versions (registrations) each brings. */
export const appsView = (apps) => apps.map((a) => ({ id: a.id, title: a.title, short: a.short, versions: a.registrations.length }));

/** The ids chosen: a saved choice as saved, with none (a state from before the apps step) every app of the release. */
export const chosenApps = (s, apps) => (Array.isArray(s && s.apps) && s.apps.length ? s.apps : apps.map((a) => a.id));

/** ARENA_APPS for the chosen apps: their registrations, absolute, comma-joined. An id the release does not carry is refused by name. */
export function appsEnvValue(release, chosenIds, apps = appsIn(release)) {
  const unknown = chosenIds.filter((id) => !apps.some((a) => a.id === id));
  if (unknown.length) throw new Error(`no app ${unknown.join(', ')} in this release`);
  return apps.filter((a) => chosenIds.includes(a.id)).flatMap((a) => a.registrations).join(',');
}

/**
 * THE GAME IDS A NODE HOSTS, FOR ITS ADVERTISEMENT (2026-10-25: "Make sure the installer and the nodes use the newest versions of
 * games and protocols"): the census draws a node for a round only when its advertisement names the round's game (census.js hostsGame),
 * and the installer's advertisement named Next Block's first version alone - an installed node was never drawn for Up/Down, Rock Paper
 * Scissors or a newer Next Block. These are the chosen apps' registrations as the seat hosts them (arena-node plugins.js hostedPlugins:
 * a version that does not stand is left out, so the node never names a game it would refuse), as hex, sorted.
 *
 * AND THE GAMES THE NODE INSTALLED ITSELF (kanban #3068 follow-up, measured 2026-11-22 on a live installer node on 2026.1.9.29: it served
 * 43 games and advertised 37 - rock-paper-scissors v6 to v11, the live RPS game among them, came to it from the network as installed
 * packages in <home>/node.db.plugins, not with the release, so no advertisement named them and the node was never drawn for an RPS round).
 * `pluginsDir` given: its packages as the seat loads them at start (main.js, plugin-package.js loadInstalled: each checked again, a refused
 * one left out), after the chosen apps' registrations and once per game. `refused` collects the packages left out, for a caller that must
 * not read a check that failed this once as a game the node stopped hosting.
 */
export async function hostedGameIdsOf(release, chosenIds, apps = appsIn(release), { pluginsDir = null, refused = null } = {}) {
  const { pathToFileURL } = await import('node:url');
  const { hostedPlugins } = await import('../../arena-node/src/plugins.js');
  const files = appsEnvValue(release, chosenIds, apps).split(',').filter(Boolean);
  const regs = [];
  for (const f of files) { try { const m = await import(pathToFileURL(f).href); if (m.GAME) regs.push(m.GAME); } catch { /* not hosted either */ } }
  // as main.js: an installed game the release's apps already host is not added twice
  if (pluginsDir) regs.push(...await installedRegistrationsOf(pluginsDir, regs, refused));
  if (!regs.length) return [];
  return [...hostedPlugins(regs, { log: () => {} }).keys()].sort();
}

/** The node's own plugins directory, as the seat reads it (main.js: ARENA_PLUGINS_DIR, else `<database>.plugins`; the installer's is node.db). */
export const pluginsDirOf = (st) => (st && typeof st.path === 'function' ? st.path('node.db.plugins') : null);

async function installedRegistrationsOf(dir, have, refused) {
  if (!existsSync(dir)) return [];
  const [{ loadInstalled }, { verifyEd25519 }, { toHex }] = await Promise.all([import('../../arena-node/src/plugin-package.js'),
    import('../../arena-node/src/ed25519.js'), import('../../arena-protocol/src/hash.js')]);
  let got;
  try { got = await loadInstalled(dir, { verify: verifyEd25519 }); } catch (e) { if (refused) refused.push({ dir, why: e.message }); return []; }
  if (refused) refused.push(...got.refused);
  const ids = new Set(have.map((g) => { try { return toHex(g.gameId); } catch { return ''; } }));
  return got.registrations.filter((g) => { const k = toHex(g.gameId); if (ids.has(k)) return false; ids.add(k); return true; });
}

/**
 * THE RELEASE'S GAMES WRITTEN DOWN BEFORE A NODE'S FIRST BOND (kanban #3068, #3089): a node with no bond yet has nothing on chain to
 * correct, so its state.hostedGames is simply set to what `release` hosts for its chosen apps - the bond, when it is built, names
 * these. Called by the updater (change-roles.js refreshHostedGames) AND where the first bond is built (add-bond.js firstBondOnNode):
 * the updater that moves a node into a release is the PREVIOUS release's code, so a node updated by an older updater (whose refresh
 * returned "no bond yet" without writing anything) would otherwise bond with the install-time list. A bonded node is left alone: its
 * list is what its advertisement names on chain, and refreshHostedGames posts the update. Answers the release's game ids ([] when it
 * hosts none of the node's apps or the node is bonded).
 */
export async function releaseGamesBeforeBond(st, release) {
  const s = st.read();
  if (s.bond && s.bond.txid) return [];
  const apps = appsIn(release);
  const now = await hostedGameIdsOf(release, chosenApps(s, apps), apps, { pluginsDir: pluginsDirOf(st) });
  if (now.length && JSON.stringify([...new Set(s.hostedGames || [])].sort()) !== JSON.stringify([...new Set(now)].sort())) st.save({ hostedGames: now });
  return now;
}

/**
 * THE GAMES A NEW FIRST BOND NAMES (kanban #3114, #3115 - refute of #3068/#3089/#3101): ONE build rule for every door that posts a first
 * bond - the owner page (add-bond.js firstBond) and the installer wizard (wizard.js 'POST /api/bond/post') - so no copy of the build can
 * drift again. Read inside the bond's build, where no live bond is left: the games of the release the node RUNS (`s.release.path`, which
 * an updater writes when it moves the node; else `release`, the code building the bond) for its chosen apps. Never state.hostedGames
 * alone: an updater of 1.9.28 or older moved the node without writing them, and over a withdrawn bond (kanban #2098) they are the old
 * bond's list. Answers the list ([] / an unreadable release: s.hostedGames as before, so a bond is never built with no game).
 */
//
// WHICH RELEASE RUNS, IN THE WINDOW OF AN UPDATE (kanban #3128, refute of #3068/#3114): update.js starts the new release's units (STARTED)
// minutes before it records state.release.path (KEPT); an updater killed in between (a reboot) or still checking leaves state.release naming
// the OLD release while the new one runs. Read first, s.release.path named the old release's games (3 of 10) and even overwrote the list
// releaseGamesBeforeBond had just written. So the order is: (1) an open update journal (<home>/update-journal.json, `home` given) - its
// units run `to` once written (UNITS_WRITTEN, STARTED), `from` before that and while rolling back; (2) `runs`, the release the door knows
// is running because it IS that code (the owner page: server.js passes its own folder); (3) s.release.path; (4) `release`.
export async function runningReleaseOf(home) {
  if (!home) return null;
  try {
    const { readJournal, openJournal, UPDATE_PHASE: U } = await import('./update.js');
    const j = readJournal(home);
    if (!openJournal(j)) return null;
    return (j.phase === U.UNITS_WRITTEN || j.phase === U.STARTED ? j.to : j.from) || null;
  } catch { return null; }
}
export async function bondGamesOf(s, release, { home = null, runs = null } = {}) {
  const journaled = await runningReleaseOf(home);
  for (const rel of [...new Set([journaled, runs, s && s.release && s.release.path, release].filter(Boolean))]) {
    try {
      const apps = appsIn(rel);
      const now = await hostedGameIdsOf(rel, chosenApps(s, apps), apps, { pluginsDir: home ? join(home, 'node.db.plugins') : null });
      if (now.length) return now;
    } catch { /* the next release, then the list in state */ }
  }
  return (s && s.hostedGames) || [];
}
