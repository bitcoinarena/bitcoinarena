#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE UPDATE AND ROLLBACK DRIVEN FOR THE E2E SUITE (kanban #2642, e2e/flows/installer.mjs): this tree's update.js (updateNode) and
// auto-update.js (checkOnce) move a node in a TEMP HOME between real release folders, with real seats of each release answering on
// 127.0.0.1 - only the service manager is stood in for. On the MacBook the node's own services are launchd agents in the user's real
// gui domain (where a live node runs), so the update is run with platform 'linux' and this file's systemctl/journalctl: it reads each
// unit file the update writes (WorkingDirectory, ExecStart) and starts / stops that process itself. Everything else - the checks, the
// journal, the backup, the unit rewrite, the health and version checks, the rollback - is the product's own code.
//
//   node e2e/lib/installer-update.mjs <job.json>      (HOME and XDG_CONFIG_HOME set to the temp home by the caller)
//   job: { root, op: 'seat-up'|'stop-all'|'update'|'auto', home, port, release?, newRelease?, allowOlder?, waitMs?, latest?, platform?, arch? }
// Prints one JSON line: the result (or { threw }).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** A systemctl --user / journalctl stand-in over the unit files in `unitDir`; started processes kept in <home>/e2e-units.json. */
export function systemdShim({ home, unitDir, env = process.env }) {
  const pidsFile = join(home, 'e2e-units.json');
  const pids = () => { try { return JSON.parse(readFileSync(pidsFile, 'utf8')); } catch { return {}; } };
  const keep = (m) => writeFileSync(pidsFile, JSON.stringify(m, null, 1));
  const calls = [];
  const unitPath = (u) => (u.includes('/') ? u : join(unitDir, u));
  const parse = (text) => {
    const get = (k) => { const m = new RegExp(`^${k}=(.*)$`, 'm').exec(text); return m ? m[1].trim() : null; };
    return { cwd: get('WorkingDirectory'), exec: (get('ExecStart') || '').split(/\s+/).filter(Boolean) };
  };
  const stopOne = async (unit) => {
    const m = pids(); const pid = m[unit];
    if (pid && alive(pid)) {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
      for (let i = 0; i < 40 && alive(pid); i++) await wait(250);
      if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } await wait(300); }
    }
    delete m[unit]; keep(m);
  };
  const startOne = async (unit) => {
    const f = unitPath(unit);
    if (!existsSync(f)) return `${unit}: no unit file`;
    const { cwd, exec } = parse(readFileSync(f, 'utf8'));
    if (!exec.length) return `${unit}: no ExecStart`;
    const m = pids();
    if (m[unit] && alive(m[unit])) return null;   // active already, as systemctl start leaves it
    const log = openSync(join(home, `${unit.split('/').pop()}.log`), 'a');
    const c = spawn(exec[0], exec.slice(1), { cwd: cwd || home, env, detached: true, stdio: ['ignore', log, log] });
    c.unref();
    m[unit] = c.pid; keep(m);
    return null;
  };
  const sh = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'systemctl') {
      const a = args.filter((x) => x !== '--user');
      const [verb, ...units] = a;
      if (verb === 'stop') { for (const u of units) await stopOne(u.split('/').pop()); return { ok: true, out: '', err: '' }; }
      if (verb === 'start' || verb === 'restart') {
        const bad = [];
        for (const u of units) { if (verb === 'restart') await stopOne(u.split('/').pop()); const why = await startOne(u.split('/').pop()); if (why) bad.push(why); }
        return bad.length ? { ok: false, out: '', err: bad.join('; ') } : { ok: true, out: '', err: '' };
      }
      if (verb === 'is-active') { const m = pids(); const on = units.every((u) => m[u] && alive(m[u])); return { ok: on, out: on ? 'active\n' : 'inactive\n', err: '' }; }
      return { ok: true, out: '', err: '' };   // daemon-reload, enable, ...
    }
    if (cmd === 'journalctl') {
      const i = args.indexOf('-u'); const u = i >= 0 ? args[i + 1] : 'arena-node.service';
      const n = Number(args[args.indexOf('-n') + 1]) || 12;
      let t = ''; try { t = readFileSync(join(home, `${u}.log`), 'utf8'); } catch { t = ''; }
      return { ok: true, out: t.split('\n').filter(Boolean).slice(-n).join('\n'), err: '' };
    }
    return { ok: false, out: '', err: `${cmd}: not on this test machine (e2e shim)` };
  };
  const stopAll = async () => { for (const u of Object.keys(pids())) await stopOne(u); };
  return { sh, calls, pids, stopAll };
}

async function main() {
  const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const src = (p) => import(pathToFileURL(join(job.root, 'packages/arena-installer/src', p)).href);
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME, '.config'), 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  const shim = systemdShim({ home: job.home, unitDir });
  const env = { ...process.env };
  const out = (o) => process.stdout.write(`${JSON.stringify({ ...o, shimCalls: shim.calls })}\n`);
  if (job.op === 'stop-all') { await shim.stopAll(); return out({ ok: true, stopped: true }); }
  if (job.op === 'seat-up') {
    // THE NODE AS AN INSTALL LEAVES IT: its seat's unit for `release`, started
    const { seatUnit, waitHealthy } = await src('service.js');
    writeFileSync(join(unitDir, 'arena-node.service'), seatUnit({ node: join(job.release, 'runtime', 'node'), release: job.release, home: job.home, port: job.port }));
    const s = await shim.sh('systemctl', ['--user', 'start', 'arena-node.service']);
    const h = await waitHealthy({ port: job.port, waitMs: job.waitMs || 120000 });
    return out({ ok: s.ok && h.ok, started: s, health: h });
  }
  const { updateNode } = await src('update.js');
  const common = { platform: 'linux', env, sh: shim.sh, waitMs: job.waitMs || 120000, installUpdaterFn: null };
  if (job.op === 'update') {
    const r = await updateNode({ home: job.home, newRelease: job.newRelease, port: job.port, node: join(job.newRelease, 'runtime', 'node'), allowOlder: !!job.allowOlder, ...common });
    return out(r);
  }
  if (job.op === 'auto') {
    // THE AUTO UPDATE'S OWN PATH (download in pieces, SHA-256 against the release list, SHA256SUMS + signature, unpack, move): the release
    // list given here (`latest`) instead of the signed latest.json on the Arena site, its download served on 127.0.0.1 by the caller
    const { checkOnce } = await src('auto-update.js');
    const latest = async () => job.latest;
    const r = await checkOnce({ home: job.home, latest, force: true, platform: job.platform || process.platform, arch: job.arch || process.arch,
      apply: (o) => updateNode({ ...o, ...common }) });
    return out(r);
  }
  throw new Error(`no op ${job.op}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => setTimeout(() => process.exit(0), 200), (e) => { process.stdout.write(`${JSON.stringify({ threw: String(e && e.stack || e) })}\n`); setTimeout(() => process.exit(1), 200); });
}
