// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S AGENTS MOVED TO INTERACTIVE BY THE NEW RELEASE ITSELF (kanban #1128, measured 2026-11-04 18:48Z on an installer node, macOS): the
// update 2026.1.9.24 -> 2026.1.9.25 is run by the OLD updater, which rewrites the node's agents without ProcessType - so the #1122 fix
// (service.js interactivePlist) would take effect only at the update after. Until then the seat runs at launchd priority 20 and stops for
// seconds on a busy machine; Interactive runs it at 31.
//
// So the updater service, when it starts from the new release (auto-update.js runAutoUpdate), looks at this node's own agents once:
//   - every agent of this node (~/Library/LaunchAgents/<label>.plist and <label>.<id>.plist) without a ProcessType gets Interactive,
//     written to a file beside it and renamed over it;
//   - each one changed and loaded is reloaded (bootout, then bootstrap - as node-services.js act() restarts one), in start order, the
//     seat last and outside a market seating window;
//   - never the tunnel (a quick tunnel would come back under a new name) and never the updater itself (its bootout would end this very
//     process): their files say Interactive and take it at their next start;
//   - done once: state.json launchdInteractive. Linux and Windows: nothing.
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LAUNCHD_LABEL, interactivePlist, bootstrapAgent } from './service.js';
import { SERVICES } from './node-services.js';
import { inSeatingWindow } from './update.js';

/** This node's agents in a LaunchAgents folder: [{ id, label, file }] - the seat is 'node', <label>.<id> is <id>. Another instance's are not. */
export function ownAgents(dir, label = LAUNCHD_LABEL) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f === `${label}.plist` || (f.startsWith(`${label}.`) && f.endsWith('.plist')))
    .map((f) => { const l = f.slice(0, -'.plist'.length); return { id: l === label ? 'node' : l.slice(label.length + 1), label: l, file: join(dir, f) }; });
}

const NOT_RELOADED = Object.freeze({ tunnel: 'a quick tunnel would come back under a new name', updater: 'it is this process' });
const order = (id) => { const i = SERVICES.findIndex((s) => s.id === id); return id === 'node' ? Infinity : i < 0 ? SERVICES.length : i; };

/**
 * Once per node, on macOS: this node's agents without a ProcessType say Interactive, and the loaded ones among them are reloaded (not the
 * tunnel, not the updater; the seat last). Answers { skipped } | { already } | { ok, set: [id], reloaded: [id], kept: [id], failed: [{ id, why }] }.
 * `sh` runs launchctl; `uid`, `nowMs`, `sleep`, `pauseMs` and `dir` are for the tests.
 */
export async function moveAgentsInteractive({ home, sh, platform = process.platform, env = process.env, uid = typeof process.getuid === 'function' ? process.getuid() : 501,
  dir = join(env.HOME || homedir(), 'Library', 'LaunchAgents'), label = LAUNCHD_LABEL, log = () => {},
  nowMs = Date.now, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), pauseMs = 1000 }) {
  if (platform !== 'darwin') return { skipped: `not macOS (${platform})` };
  const stateFile = join(home, 'state.json');
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { state = {}; }
  if (state.launchdInteractive) return { already: true };
  const set = [], reloaded = [], kept = [], failed = [];
  const agents = ownAgents(dir, label).sort((a, b) => order(a.id) - order(b.id));
  for (const a of agents) {
    const text = readFileSync(a.file, 'utf8');
    const moved = interactivePlist(text);
    if (moved === text) continue;
    // beside it, then renamed over it: launchd or a crash never reads half a file
    writeFileSync(`${a.file}.tmp`, moved, { mode: statSync(a.file).mode & 0o777 });
    renameSync(`${a.file}.tmp`, a.file);
    set.push(a.id);
  }
  const dom = `gui/${uid}`;
  for (const a of agents.filter((x) => set.includes(x.id))) {
    if (NOT_RELOADED[a.id]) { kept.push(a.id); log(`#1128 ${a.label}: Interactive at its next start (not reloaded: ${NOT_RELOADED[a.id]})`); continue; }
    if (!(await sh('launchctl', ['print', `${dom}/${a.label}`])).ok) { kept.push(a.id); log(`#1128 ${a.label}: not loaded, Interactive at its next start`); continue; }
    // the seat's restart never costs it a seat: outside minutes 11-14 of a quarter hour, as an update waits
    if (a.id === 'node') while (inSeatingWindow(nowMs())) await sleep(5000);
    await sh('launchctl', ['bootout', `${dom}/${a.label}`]);
    const r = await bootstrapAgent(sh, uid, a.file, { pauseMs });
    if (r.ok) { reloaded.push(a.id); log(`#1128 ${a.label}: reloaded as Interactive`); }
    else { failed.push({ id: a.id, why: String(r.err || r.out || '').trim().slice(0, 200) }); log(`#1128 ${a.label}: bootstrap failed: ${failed.at(-1).why}`); }
  }
  // marked once whatever the reloads said: every file says Interactive now, and a failed one takes it at its next start (a home without
  // state.json gets none made up: a second look there finds nothing to change)
  if (!existsSync(stateFile)) return { ok: failed.length === 0, set, reloaded, kept, failed };
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* the one read above */ }
  const next = { ...state, launchdInteractive: { atMs: nowMs(), set, reloaded, kept, failed } };
  writeFileSync(`${stateFile}.tmp`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${stateFile}.tmp`, stateFile);
  return { ok: failed.length === 0, set, reloaded, kept, failed };
}
