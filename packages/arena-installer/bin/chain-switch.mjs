#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE MOVES TO ITS OWN BITCOIN CORE ONCE IT IS SYNCED (kanban #635, 2026-10-25: "Auch der Bitcoin core nicht im Vordergrund
// machen lassen während der synced ... der Status und completion ist dann im Dashboards"). The installer started Bitcoin Core and went
// on with the node reading the chain through a public Electrum server. This keeper, a service of its own, reads the sync every minute
// and writes it to <home>/chain-switch.json { state: syncing | switching | done, sync: { blocks, headers, progress,
// etaMs }, why, atMs } - the node's dashboards show it. Once testnet4 is synced and passes the installer's chain test, the node's chain
// becomes that Core and the service step runs again (its settings rewritten, the node restarted). Then it only waits. A custody node's
// LND was set up on this Core during the install and waited for the sync by itself (measured 2026-10-25: LND answers getinfo on a Core at
// block 0 after 6 s; its gateway says Syncing until LND is synced, then connects).
//
//     chain-switch --home <home>
import { writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { nodeState, defaultHome } from '../src/state.js';
import { createWizard, repairCorePorts } from '../src/wizard.js';
import { syncStatus } from '../src/bitcoind.js';
import { testConnection } from '../src/chain-test.js';

const args = process.argv.slice(2);
const i = args.indexOf('--home');
const home = resolve(i >= 0 ? args[i + 1] : defaultHome());
const release = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const statusFile = join(home, 'chain-switch.json');
const EVERY_MS = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (o) => { writeFileSync(statusFile, JSON.stringify({ ...o, atMs: Date.now() }) + '\n', { mode: 0o644 }); console.log(`${new Date().toISOString()} ${o.state} ${o.why || ''}`); };
const state = nodeState(home);
const wizardOf = () => {
  const s = state.read();
  const own = join(release, 'runtime', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  return createWizard({ state, release, seatPort: (s.reach && s.reach.port) || (s.service && s.service.port), bridgePort: s.bridgePort || null,
    cloudflared: process.env.ARENA_CLOUDFLARED || (existsSync(own) ? own : 'cloudflared'), log: (l) => console.log(l) });
};

let samples = [];
for (;;) {
  const s = state.read();
  const t4 = s.core && s.core.networks && s.core.networks.testnet4;
  if (!t4) { say({ state: 'done', why: 'no Bitcoin Core was installed by the installer' }); break; }
  if (s.chain && s.chain.kind === 'core') { say({ state: 'done', switchedAtMs: (s.core || {}).switchedAtMs || null }); break; }
  {
    const r = await syncStatus({ ...t4, samples, nowMs: Date.now() });
    samples = r.samples || [];
    // a port another program holds: moved to free ones, the Core started again (kanban #635)
    if (r.portTaken) { const f = await repairCorePorts({ state, network: 'testnet4' }); say({ state: 'syncing', why: f.ok ? `${r.why}: moved to port ${f.ports.rpc} and started again` : `${r.why}; ${f.why}` }); await sleep(EVERY_MS); continue; }
    const sync = r.ok ? { blocks: r.blocks, headers: r.headers, progress: r.progress, etaMs: r.etaMs, synced: r.synced } : null;
    if (!r.ok || !r.synced) { say({ state: 'syncing', sync, why: r.ok ? null : r.why }); await sleep(EVERY_MS); continue; }
    // SYNCED: tested as the chain step tests it, then saved and the node restarted on it
    const conn = { kind: 'core', url: t4.rpcUrl, cookiePath: t4.cookiePath };
    const t = await testConnection(conn);
    if (!t.ok) { say({ state: 'syncing', sync, why: `synced, but the chain test did not pass yet: ${t.why}` }); await sleep(EVERY_MS); continue; }
    say({ state: 'switching', sync });
    state.save({ chain: conn, chainTest: { atMs: Date.now(), why: t.why, latencyMs: t.source.latencyMs, height: t.source.height }, core: { ...s.core, interim: false, switchedAtMs: Date.now() } });
    const sv = await wizardOf()['POST /api/service']({ boot: !(s.service && s.service.boot === false) });
    if (!sv.ok) console.log(`the service step after the switch: ${sv.why}`);
  }
}
// NOTHING LEFT TO DO: the keeper waits, so its service manager does not start it again and again
setInterval(() => {}, 2 ** 31 - 1);
