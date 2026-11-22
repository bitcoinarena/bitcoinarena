#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ANNOUNCE PLANNED DOWNTIME to the health watcher (kanban #2773, see tools/health-watcher-planned.mjs for what each target covers).
//   node tools/planned-downtime.mjs add "seat 3" 15 "roll #2986"    a window from now for 15 min
//   node tools/planned-downtime.mjs add seats 40 "roll 2026.1.9.28"  every seat and what the seats answer
//   node tools/planned-downtime.mjs end "seat 3"                     ends the open windows of that target now (kept, not removed)
//   node tools/planned-downtime.mjs list                             the open windows
// The file: HW_PLANNED_DOWNTIME, default ~/blwp-testnet4/ops/planned-downtime.json. Windows ended over 7 days ago are dropped on write.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const plannedPath = (env = process.env) => env.HW_PLANNED_DOWNTIME || `${env.HOME || '/home/arena'}/blwp-testnet4/ops/planned-downtime.json`;
const load = (path) => { try { const j = JSON.parse(readFileSync(path, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } };
const save = (path, list, nowMs) => {
  mkdirSync(dirname(path), { recursive: true });
  const kept = list.filter((w) => !(Number(w.untilMs) < nowMs - 7 * 86400000));
  writeFileSync(path + '.tmp', JSON.stringify(kept, null, 1) + '\n'); renameSync(path + '.tmp', path);
  return kept;
};

/** One command: answers the text to print. */
export function command(argv, { env = process.env, nowMs = Date.now() } = {}) {
  const path = plannedPath(env), [cmd, what, minutes, ...why] = argv;
  if (cmd === 'add') {
    const m = Number(minutes);
    if (!what || !(m > 0) || m > 24 * 60) throw new Error('usage: planned-downtime.mjs add <what> <minutes 1-1440> <why>');
    const w = { what: String(what).trim(), fromMs: nowMs, untilMs: nowMs + Math.round(m * 60000), why: why.join(' ') || '', by: env.USER || '' };
    save(path, [...load(path), w], nowMs);
    return `planned: ${w.what} until ${new Date(w.untilMs).toISOString()}${w.why ? ` (${w.why})` : ''} -> ${path}`;
  }
  if (cmd === 'end') {
    if (!what) throw new Error('usage: planned-downtime.mjs end <what>');
    let n = 0;
    const list = load(path).map((w) => (String(w.what).toLowerCase() === String(what).toLowerCase() && Number(w.untilMs) > nowMs ? (n++, { ...w, untilMs: nowMs, endedMs: nowMs }) : w));
    save(path, list, nowMs);
    return `ended ${n} window(s) of ${what}`;
  }
  if (cmd === 'list' || !cmd) {
    const open = load(path).filter((w) => Number(w.untilMs) >= nowMs);
    return open.length ? open.map((w) => `${w.what} until ${new Date(Number(w.untilMs)).toISOString()}${w.why ? ` (${w.why})` : ''}`).join('\n') : 'no planned downtime open';
  }
  throw new Error('usage: planned-downtime.mjs add <what> <minutes> <why> | end <what> | list');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { console.log(command(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(2); }
}
