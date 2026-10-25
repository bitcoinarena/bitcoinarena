#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE'S ADDRESS, SWITCHED FROM THE OWNER PAGE (kanban #563 and #562 2C; 2026-10-21: "1 default, 2 for updates so no
// needed updates", "Fix 1 and 2"): the installer wizard's reach and service steps run again on an installed node - the same code the
// install ran - started by the seat on POST /owner/reach and detached from it, because the service step restarts the seat. The request
// is <home>/reach-switch.req (written by the seat, 0600, deleted once read: it may hold a Cloudflare token); the progress
// <home>/reach-switch.json { state: running | login | done | failed, mode, url, loginUrl, why, atMs }, which the owner page reads.
//
//     reach-switch --home <home>
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeState, defaultHome } from '../src/state.js';
import { createWizard } from '../src/wizard.js';

const args = process.argv.slice(2);
const i = args.indexOf('--home');
const home = resolve(i >= 0 ? args[i + 1] : defaultHome());
const release = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const statusFile = join(home, 'reach-switch.json'), reqFile = join(home, 'reach-switch.req');
const say = (o) => writeFileSync(statusFile, JSON.stringify({ ...o, atMs: Date.now() }) + '\n', { mode: 0o600 });

let req;
try { req = JSON.parse(readFileSync(reqFile, 'utf8')); } catch (e) { say({ state: 'failed', why: `no request: ${e.message}` }); process.exit(1); }
rmSync(reqFile, { force: true });
const mode = String(req.mode || '');
const state = nodeState(home);
const s = state.read();
const seatPort = (s.reach && s.reach.port) || (s.service && s.service.port);
const own = join(release, 'runtime', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const cloudflared = process.env.ARENA_CLOUDFLARED || (existsSync(own) ? own : 'cloudflared');
const wizard = createWizard({ state, release, seatPort, bridgePort: s.bridgePort || null, cloudflared, log: (l) => console.log(l) });
const fail = (why) => { say({ state: 'failed', mode, why }); console.log(`failed: ${why}`); process.exit(1); };

say({ state: 'running', mode });
if (mode === 'direct') {
  const d = await wizard['POST /api/reach/direct']({ port: seatPort });
  if (!d.ok || !(d.result && d.result.reached)) fail(`the seats could not reach this machine directly${d.result && d.result.why ? `: ${d.result.why}` : ''} - open the port it names, or choose a tunnel`);
}
if (mode === 'permanent') {
  // THE CLOUDFLARE LOGIN: its link shown on the owner page; the save waits until the owner logged in (10 minutes at most)
  const l = await wizard['POST /api/reach/login']({});
  if (!l.ok) fail(l.why);
  if (l.url) say({ state: 'login', mode, loginUrl: l.url });
}
let saved = null;
for (let t = 0; t < (mode === 'permanent' ? 120 : 1); t++) {
  saved = await wizard['POST /api/reach/save']({ mode, port: seatPort, cfToken: req.cfToken, cfSubdomain: req.cfSubdomain, hostname: req.hostname });
  if (saved.ok || !/log in to Cloudflare first/.test(saved.why || '')) break;
  await new Promise((r) => setTimeout(r, 5000));
}
if (!saved || !saved.ok) fail(saved ? saved.why : 'not saved');
// THE SERVICE STEP AGAIN: arena.conf with the new address, the units, the seat restarted and tested at its public address
const r = await wizard['POST /api/service']({ boot: !(s.service && s.service.boot === false) });
if (!r.ok) fail(r.why);
const after = state.read();
say({ state: 'done', mode, url: after.reach && after.reach.url });
console.log(`the node is reached at ${after.reach && after.reach.url} (${mode})`);
process.exit(0);
