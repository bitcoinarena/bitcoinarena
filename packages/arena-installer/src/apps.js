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
 */
export async function hostedGameIdsOf(release, chosenIds, apps = appsIn(release)) {
  const { pathToFileURL } = await import('node:url');
  const { hostedPlugins } = await import('../../arena-node/src/plugins.js');
  const files = appsEnvValue(release, chosenIds, apps).split(',').filter(Boolean);
  const regs = [];
  for (const f of files) { try { const m = await import(pathToFileURL(f).href); if (m.GAME) regs.push(m.GAME); } catch { /* not hosted either */ } }
  if (!regs.length) return [];
  return [...hostedPlugins(regs, { log: () => {} }).keys()].sort();
}
