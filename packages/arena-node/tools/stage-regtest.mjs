#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A STAGED UPDATE, MEASURED ON A DEVNET (kanban #1093 part 3, the owner 2026-11-03: "An update reaches at most f guardians of one federation at
// a time ... A release with a fault then never reaches the threshold before it shows"). Private regtest only: a devnet that is `up`.
//
// Every guardian's updater asks its own seat, as the installer's does (auto-update.js stageOf -> GET /update-stage?version=V), all of them in
// the same minute - the hardest case, since two that ask at once must never both take the last free place. Each one told `go` is restarted
// on V (devnet.mjs restart with ARENA_RELEASE_VERSION, which a seat honours on regtest only). Once a minute every seat's GET /release is read;
// a guardian on V for less than an hour (STAGE_HEALTHY_MS), or not healthy, is on trial. The answer: the most guardians on trial at any read
// (it must be at most f), and how long the whole federation took.
//
//   DEVNET_DIR=... [DEVNET_BASE_PORT=24000] [STAGE_VERSION=2.0.0-stage] [STAGE_MAX_H=6] node tools/stage-regtest.mjs
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devnetPorts } from './devnet-plan.mjs';
import { stageOf } from '../../arena-installer/src/auto-update.js';
import { STAGE_HEALTHY_MS, faultsOf } from '../src/update-stage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const V = process.env.STAGE_VERSION || '2.0.0-stage';
const MAX_MS = Number(process.env.STAGE_MAX_H || 6) * 3600_000;
const PLAN = devnetPorts(Number(process.env.DEVNET_BASE_PORT || 24000));
const say = (o) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const release = async (port) => { try { return await (await fetch(`http://127.0.0.1:${port}/release`, { signal: AbortSignal.timeout(8000) })).json(); } catch { return null; } };

const f = faultsOf(PLAN.nodes.length);
const t0 = Date.now();
let maxOnTrial = 0, restarts = 0, wrong = 0;
const timeline = [];
for (;;) {
  const now = Date.now();
  const rel = await Promise.all(PLAN.nodes.map(release));
  const onV = rel.map((r) => !!r && r.version === V);
  const trial = rel.map((r) => !!r && r.version === V && (!(now - Number(r.startedAtMs) >= STAGE_HEALTHY_MS) || r.healthy === false));
  const onTrial = trial.filter(Boolean).length;
  if (onTrial > maxOnTrial) maxOnTrial = onTrial;
  if (onTrial > f) { wrong++; say({ wrong: `${onTrial} guardians on trial, more than f = ${f}` }); }
  if (onV.every(Boolean)) break;
  if (now - t0 > MAX_MS) { say({ gaveUp: `not all on ${V} after ${MAX_MS / 3600_000} h`, onV: onV.filter(Boolean).length }); process.exit(1); }
  // every updater asks in the same minute, then those told go update
  const asked = await Promise.all(PLAN.nodes.map((port, k) => (onV[k] ? null : stageOf({ port }, V))));
  const go = asked.map((a, k) => (a && a.go ? k : -1)).filter((k) => k >= 0);
  for (const k of go) {
    const r = spawnSync(process.execPath, [join(HERE, 'devnet.mjs'), 'restart', String(k + 1)], { encoding: 'utf8', env: { ...process.env, ARENA_RELEASE_VERSION: V }, timeout: 300000 });
    restarts++;
    timeline.push({ node: k + 1, atMin: Math.round((Date.now() - t0) / 60000), ok: r.status === 0 });
    say({ updated: k + 1, ok: r.status === 0, why: asked[k].why, ...(r.status === 0 ? {} : { err: String(r.stderr || '').trim().split('\n').pop() }) });
  }
  say({ onV: onV.filter(Boolean).length, onTrial, f, asked: asked.filter(Boolean).length, go: go.map((k) => k + 1), waitWhy: (asked.find((a) => a && !a.go) || {}).why || null });
  await wait(60_000);
}
say({ done: true, version: V, guardians: PLAN.nodes.length, f, maxOnTrial, restarts, wrong, minutes: Math.round((Date.now() - t0) / 60000), timeline });
process.exit(wrong || maxOnTrial > f ? 1 : 0);
