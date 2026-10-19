// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WIZARD FROM ANOTHER MACHINE (2026-10-18: "No tunnelling account is needed", ruling 5: Cloudflare).
// A Cloudflare quick tunnel - `cloudflared tunnel --url`, no account, a random *.trycloudflare.com name - opened only when the user
// asks for it (--tunnel), closed when the wizard ends. The setup token still guards every page: the tunnel only makes the wizard
// reachable, not open.
import { spawn } from 'node:child_process';

// A QUICK TUNNEL'S NAME, and nothing else that looks like one (deploy/daily/keeper.sh, measured 2026-09-27: cloudflared logs
// https://api.trycloudflare.com - the address it asks - before it has a name, and never logs a name when that fails).
export const quickTunnelName = (text) => {
  const all = String(text).match(/https:\/\/[a-z0-9]+(-[a-z0-9]+)+\.trycloudflare\.com/g) || [];
  return all.filter((u) => !u.startsWith('https://api.')).pop() || null;
};

/**
 * Open a quick tunnel to 127.0.0.1:port. Answers { ok, url, close() } or { ok: false, why }. `bin` is the cloudflared to run (the
 * release ships one; PATH otherwise).
 */
export function openQuickTunnel({ port, bin = 'cloudflared', waitMs = 45000, spawner = spawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawner(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { resolve({ ok: false, why: `cannot start ${bin}: ${e.message}` }); return; }
    let log = '', done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const close = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
    const timer = setTimeout(() => { close(); finish({ ok: false, why: `cloudflared gave no tunnel name in ${waitMs / 1000} s: ${log.trim().split('\n').pop()}` }); }, waitMs);
    const read = (d) => { log += d; const url = quickTunnelName(log); if (url) finish({ ok: true, url, close }); };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (e) => finish({ ok: false, why: e.code === 'ENOENT' ? `${bin} is not installed` : e.message }));
    child.on('exit', (code) => finish({ ok: false, why: `cloudflared exited (${code}) before it had a tunnel` }));
  });
}
