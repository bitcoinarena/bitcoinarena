// THE NODE AS A SERVICE (kanban #471 step C.9; Linux in slice 1 - launchd and Windows in slice 4): a systemd user unit that starts the
// seat from the installed release with the settings the wizard wrote, restarts it when it falls over, and is checked healthy by the
// installer before the wizard goes on. The user needs no root: `loginctl enable-linger` keeps a user unit running with nobody logged
// in, and the wizard says so when linger is off.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

export const UNIT = 'arena-node.service';
export const BRIDGE_UNIT = 'arena-chain-bridge.service';
export const TUNNEL_UNIT = 'arena-tunnel.service';

/** The unit's directory: $XDG_CONFIG_HOME/systemd/user. */
export const unitDir = (env = process.env) => join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');

/** The seat's unit text. `node` is the runtime the release ships (process.execPath when run from it). */
export function seatUnit({ node, release, home, port }) {
  return `# The Arena node (kanban #471), written by the installer. An update rewrites this file; the settings live in ${home}/node.env.
[Unit]
Description=Arena node (testnet4) on port ${port}
After=network-online.target ${BRIDGE_UNIT}
Wants=network-online.target

[Service]
WorkingDirectory=${join(release, 'packages/arena-node')}
EnvironmentFile=${join(home, 'node.env')}
ExecStart=${node} src/main.js ${port} ${join(home, 'node.db')}
Restart=on-failure
RestartSec=10
TimeoutStopSec=60
Nice=5

[Install]
WantedBy=default.target
`;
}

/** The chain bridge's unit (Electrum mode only): answers the seat's bitcoind calls on 127.0.0.1:bridgePort. */
export function bridgeUnit({ node, release, home, bridgePort }) {
  return `# The Arena node's chain bridge (kanban #471, Electrum mode), written by the installer.
[Unit]
Description=Arena chain bridge (Electrum + Esplora, testnet4) on 127.0.0.1:${bridgePort}
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=${join(release, 'packages/arena-installer')}
ExecStart=${node} bin/chain-bridge.mjs ${bridgePort} ${home}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 60000 }, (e, stdout, stderr) =>
  resolve({ ok: !e, code: e ? e.code : 0, out: String(stdout), err: String(stderr) })));

/**
 * Write the units, reload, (re)start them, then wait until the seat answers GET /identity. `tunnel` is the reach tunnel's unit text
 * (reach.js tunnelUnit), or none for a direct node. `boot` (the wizard asks, ruling 7): enabled to start at boot, and linger turned
 * on so a user unit runs with nobody logged in; without it the units run now and not after a reboot. `sh` runs a command
 * (injectable: the tests start the seat without systemd). Answers { ok, why, ms, boot, linger }.
 */
export async function installService({ node = process.execPath, release, home, port, bridgePort = null, tunnel = null, boot = true,
  env = process.env, sh = run, fetcher = fetch, waitMs = 90000 }) {
  const dir = unitDir(env);
  mkdirSync(dir, { recursive: true });
  const units = [UNIT];
  writeFileSync(join(dir, UNIT), seatUnit({ node, release, home, port }));
  if (bridgePort) { writeFileSync(join(dir, BRIDGE_UNIT), bridgeUnit({ node, release, home, bridgePort })); units.unshift(BRIDGE_UNIT); }
  if (tunnel) { writeFileSync(join(dir, TUNNEL_UNIT), tunnel); units.push(TUNNEL_UNIT); }
  const t0 = Date.now();
  for (const args of [['--user', 'daemon-reload'], ['--user', boot ? 'enable' : 'disable', ...units], ['--user', 'restart', ...units]]) {
    const r = await sh('systemctl', args);
    if (!r.ok) return { ok: false, why: `systemctl ${args.join(' ')} failed: ${(r.err || r.out).trim().slice(0, 300)}` };
  }
  const health = await waitHealthy({ port, fetcher, waitMs });
  if (boot) await sh('loginctl', ['enable-linger', env.USER || '']);
  const linger = await sh('loginctl', ['show-user', env.USER || '', '-p', 'Linger', '--value']);
  return { ...health, ms: Date.now() - t0, boot, linger: linger.ok ? linger.out.trim() === 'yes' : null };
}

/** Wait until the seat at 127.0.0.1:port answers its identity (33 bytes): { ok, identity (hex), why }. */
export async function waitHealthy({ port, fetcher = fetch, waitMs = 90000, everyMs = 1000 }) {
  const until = Date.now() + waitMs;
  let last = 'no answer yet';
  while (Date.now() < until) {
    try {
      const r = await fetcher(`http://127.0.0.1:${port}/identity`, { signal: AbortSignal.timeout(5000) });
      const b = Buffer.from(await r.arrayBuffer());
      if (r.status === 200 && b.length >= 32) return { ok: true, identity: b.toString('hex') };
      last = `GET /identity answered ${r.status}`;
    } catch (e) { last = e.cause ? e.cause.code || e.message : e.message; }
    await new Promise((ok) => setTimeout(ok, everyMs));
  }
  return { ok: false, why: `the node did not answer on port ${port} within ${Math.round(waitMs / 1000)} s (${last})` };
}
