// THE NODE AS A SERVICE (kanban #471 step C.9; Linux in slice 1 - launchd and Windows in slice 4): a systemd user unit that starts the
// seat from the installed release with the settings the wizard wrote, restarts it when it falls over, and is checked healthy by the
// installer before the wizard goes on. The user needs no root: `loginctl enable-linger` keeps a user unit running with nobody logged
// in, and the wizard says so when linger is off.
import { named } from './instance.js';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

// a second node on the machine names its services apart (instance.js)
export const unitName = (id) => `${named(`arena-${id}`)}.service`;
export const UNIT = unitName('node');
export const BRIDGE_UNIT = unitName('chain-bridge');
export const TUNNEL_UNIT = unitName('tunnel');

/** The unit's directory: $XDG_CONFIG_HOME/systemd/user. */
export const unitDir = (env = process.env) => join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');

/** The seat's unit text. `node` is the runtime the release ships (process.execPath when run from it). */
export function seatUnit({ node, release, home, port }) {
  return `# The Arena node (kanban #471), written by the installer. An update rewrites this file; the settings live in ${join(home, 'arena.conf')} (arenanode config).
[Unit]
Description=Arena node (testnet4) on port ${port}
After=network-online.target ${BRIDGE_UNIT}
Wants=network-online.target

[Service]
WorkingDirectory=${join(release, 'packages/arena-node')}
ExecStart=${node} src/run.js ${join(home, 'arena.conf')}
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
export async function installService({ node = process.execPath, release, home, port, bridgePort = null, tunnel = null, tunnelArgs = null, boot = true,
  env = process.env, sh = run, fetcher = fetch, waitMs = 90000, platform = process.platform }) {
  if (platform === 'darwin' || platform === 'win32') {
    // THE CHAIN BRIDGE FIRST (Electrum mode): its own service, so the node finds its chain when it starts - on Linux it is the
    // arena-chain-bridge unit below, which the node's unit starts after
    if (bridgePort) {
      const b = await installProgram({ id: 'chain-bridge', description: 'The Arena node\'s chain bridge (Electrum + Esplora, testnet4)',
        args: [node, join(release, 'packages', 'arena-installer', 'bin', 'chain-bridge.mjs'), String(bridgePort), home], home, boot, env, sh, platform });
      if (!b.ok) return b;
    }
    if (platform === 'darwin') return installLaunchd({ node, release, home, port, tunnelArgs, boot, env, sh, fetcher, waitMs });
    return installWindows({ node, release, home, port, tunnelArgs, boot, sh, fetcher, waitMs, env });
  }
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

// MACOS: A LAUNCHD AGENT (kanban #471 slice 4) - ~/Library/LaunchAgents/io.bitcoin-arena.node.plist, the seat from the release with
// its settings file (src/run.js <home>/arena.conf, kanban #499), kept alive, logged beside the node's home.
export const LAUNCHD_LABEL = named('io.bitcoin-arena.node');
const xml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function launchdPlist({ node, release, home, port, boot = true }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- The Arena node (kanban #471), written by the installer. An update rewrites this file; the settings live in ${xml(home)}/arena.conf (arenanode config). -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>src/run.js</string><string>${xml(home)}/arena.conf</string></array>
  <key>WorkingDirectory</key><string>${xml(release)}/packages/arena-node</string>
  <key>RunAtLoad</key><${boot ? 'true' : 'false'}/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(home)}/node.log</string>
  <key>StandardErrorPath</key><string>${xml(home)}/node.log</string>
</dict>
</plist>
`;
}

// WINDOWS: A SCHEDULED TASK (kanban #471 slice 4; ruling 2: no custody on Windows - fedimint does not build there) - "Arena node",
// at logon (or at start-up with the user's password), restarted on failure, running a .cmd that starts the seat from arena.conf.
export const WINDOWS_TASK = named('Arena node', ' ');
export function windowsLauncher({ node, release, home, port }) {
  return ['@echo off', 'rem The Arena node (kanban #471), written by the installer: the seat started from its settings, arena.conf (arenanode config).',
    `cd /d "${release}\\packages\\arena-node"`,
    `"${node}" src\\run.js "${home}\\arena.conf" >> "${home}\\node.log" 2>&1`].join('\r\n') + '\r\n';
}
/**
 * START A PROGRAM AT EVERY LOGON, AND NOW, ON WINDOWS. A scheduled task at logon first; Windows refuses that to a user without
 * administrator rights ("ERROR: Access is denied", measured in the Windows VM 2026-10-18, rc.10: the Bitcoin Core step stopped
 * there), so then the user's own Startup folder: a hidden-window script that starts the launcher - at every logon, and now.
 * Answers { ok, mode: 'task' | 'startup', startup?, why }.
 */
export const startupDir = (env = process.env) => join(env.APPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
export const startupScript = (name, file) => `' ${name} (kanban #471), written by the installer: the launcher in a hidden window, at every logon\r\n`
  + `CreateObject("WScript.Shell").Run """${file.replace(/"/g, '""')}""", 0, False\r\n`;
export async function windowsAutostart({ name, file, sh, env = process.env }) {
  const c = await sh('schtasks', windowsTaskArgs({ launcher: file }).map((x) => (x === WINDOWS_TASK ? name : x)));
  if (c.ok) { await sh('schtasks', ['/run', '/tn', name]); return { ok: true, mode: 'task' }; }
  const dir = startupDir(env);
  mkdirSync(dir, { recursive: true });
  const vbs = join(dir, `${name}.vbs`);
  writeFileSync(vbs, startupScript(name, file));
  const r = await sh('wscript', [vbs]);
  return r.ok ? { ok: true, mode: 'startup', startup: vbs }
    : { ok: false, why: `${name}: no logon task (${(c.err || c.out).trim().slice(0, 120)}) and the Startup folder script did not start: ${(r.err || r.out).trim().slice(0, 160)}` };
}

/** The schtasks arguments that create the task (onlogon: no password is kept; /rl limited: no administrator). */
export const windowsTaskArgs = ({ launcher }) => ['/create', '/f', '/tn', WINDOWS_TASK, '/sc', 'onlogon', '/rl', 'limited', '/tr', `"${launcher}"`];

/** macOS: the agents written to ~/Library/LaunchAgents and loaded (bootout first: an update or a second run replaces them). */
async function installLaunchd({ node, release, home, port, tunnelArgs, boot, env, sh, fetcher, waitMs }) {
  const dir = join(env.HOME || homedir(), 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const agents = [{ label: LAUNCHD_LABEL, text: launchdPlist({ node, release, home, port, boot }) }];
  if (tunnelArgs) agents.push({ label: `${LAUNCHD_LABEL}.tunnel`, text: launchdPlist({ node, release, home, port, boot }).replace(`<string>${LAUNCHD_LABEL}</string>`, `<string>${LAUNCHD_LABEL}.tunnel</string>`)
    .replace(/<key>ProgramArguments<\/key><array>.*?<\/array>/s, `<key>ProgramArguments</key><array>${tunnelArgs.map((a) => `<string>${xml(a)}</string>`).join('')}</array>`)
    .replace(/node\.log/g, 'tunnel.log') });
  const t0 = Date.now();
  for (const a of agents) {
    const file = join(dir, `${a.label}.plist`);
    writeFileSync(file, a.text);
    await sh('launchctl', ['bootout', `gui/${uid}/${a.label}`]);
    const r = await sh('launchctl', ['bootstrap', `gui/${uid}`, file]);
    if (!r.ok) return { ok: false, why: `launchctl bootstrap ${a.label} failed: ${(r.err || r.out).trim().slice(0, 300)}` };
  }
  const health = await waitHealthy({ port, fetcher, waitMs });
  return { ...health, ms: Date.now() - t0, boot, linger: true };
}

/** Windows: the launchers written beside the node's home, the scheduled tasks created and run (at logon), or started once. */
async function installWindows({ node, release, home, port, tunnelArgs, boot, sh, fetcher, waitMs, env = process.env }) {
  const t0 = Date.now();
  const tasks = [{ name: WINDOWS_TASK, file: join(home, 'arena-node.cmd'), text: windowsLauncher({ node, release, home, port }) }];
  if (tunnelArgs) tasks.push({ name: `${WINDOWS_TASK} tunnel`, file: join(home, 'arena-tunnel.cmd'),
    text: ['@echo off', 'rem The Arena node tunnel (kanban #471), written by the installer.', `${tunnelArgs.map((a) => `"${a}"`).join(' ')} >> "${home}\\tunnel.log" 2>&1`].join('\r\n') + '\r\n' });
  for (const t of tasks) {
    writeFileSync(t.file, t.text);
    if (boot) {
      const a = await windowsAutostart({ name: t.name, file: t.file, sh, env });
      if (!a.ok) return { ok: false, why: a.why };
    } else {
      await sh('cmd', ['/c', 'start', '""', '/b', t.file]);
    }
  }
  const health = await waitHealthy({ port, fetcher, waitMs });
  return { ...health, ms: Date.now() - t0, boot, linger: true };
}

/**
 * ANY OTHER PROGRAM OF THE NODE AS A SERVICE (kanban #471 ruling 8: the node's own Bitcoin Core): `id` names it (arena-<id>.service,
 * io.bitcoin-arena.<id>, the task "Arena <id>"), `args` is its command line, `log` where its output goes. Started now; at boot too
 * when `boot`. `vars`: environment the program needs (secrets too - kept only in files of this user, 0600). Answers { ok, why }.
 */
export async function installProgram({ id, description, args, home, boot = true, vars = null, partOf = null, env = process.env, sh = run, platform = process.platform, againOn = null }) {
  const varLines = Object.entries(vars || {}).map(([k, v]) => { if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /[\r\n]/.test(String(v))) throw new Error(`bad variable ${k}`); return [k, String(v)]; });
  if (platform === 'darwin') {
    const dir = join(env.HOME || homedir(), 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    const label = `${LAUNCHD_LABEL}.${id}`;
    const file = join(dir, `${label}.plist`);
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${xml(description)} (kanban #471), written by the installer. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>${varLines.length ? `
  <key>EnvironmentVariables</key><dict>${varLines.map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>` : ''}
  <key>RunAtLoad</key><${boot ? 'true' : 'false'}/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(home)}/${id}.log</string>
  <key>StandardErrorPath</key><string>${xml(home)}/${id}.log</string>
</dict>
</plist>
`);
    chmodSync(file, 0o600);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    await sh('launchctl', ['bootout', `gui/${uid}/${label}`]);
    const r = await sh('launchctl', ['bootstrap', `gui/${uid}`, file]);
    return r.ok ? { ok: true } : { ok: false, why: `launchctl bootstrap ${label} failed: ${(r.err || r.out).trim().slice(0, 300)}` };
  }
  if (platform === 'win32') {
    const file = join(home, `arena-${id}.cmd`);
    // `againOn`: an exit code on which the program is started again (no service manager restarts a launcher on Windows; the auto update
    // ends with 75 to come back from the new release, kanban #505)
    writeFileSync(file, ['@echo off', `rem ${description} (kanban #471), written by the installer.`, ...varLines.map(([k, v]) => `set "${k}=${v}"`),
      ...(againOn ? [':again'] : []),
      `${args.map((a) => `"${a}"`).join(' ')} >> "${home}\\${id}.log" 2>&1`,
      ...(againOn ? [`if %errorlevel%==${againOn} goto again`] : [])].join('\r\n') + '\r\n', { mode: 0o600 });
    const name = named(`Arena ${id}`, ' ');
    if (boot) {
      const a = await windowsAutostart({ name, file, sh, env });
      if (!a.ok) return { ok: false, why: a.why };
    } else await sh('cmd', ['/c', 'start', '""', '/b', file]);
    return { ok: true };
  }
  const dir = unitDir(env);
  mkdirSync(dir, { recursive: true });
  const unit = unitName(id);
  const envFile = join(home, `${id}.env`);
  if (varLines.length) writeFileSync(envFile, varLines.map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  writeFileSync(join(dir, unit), `# ${description} (kanban #471), written by the installer.
[Unit]
Description=${description}
After=network-online.target${partOf ? ` ${unitName(partOf)}` : ''}
Wants=network-online.target
${partOf ? `# restarted with arena-${partOf}: LND's onion service lives in that Tor and is gone when it restarts (measured 2026-10-18 on the test host)\nPartOf=${unitName(partOf)}\n` : ''}
[Service]
${varLines.length ? `EnvironmentFile=${envFile}\n` : ''}ExecStart=${args.join(' ')}
Restart=on-failure
RestartSec=30
TimeoutStopSec=600
Nice=10

[Install]
WantedBy=default.target
`);
  for (const a of [['--user', 'daemon-reload'], ['--user', boot ? 'enable' : 'disable', unit], ['--user', 'restart', unit]]) {
    const r = await sh('systemctl', a);
    if (!r.ok) return { ok: false, why: `systemctl ${a.join(' ')} failed: ${(r.err || r.out).trim().slice(0, 300)}` };
  }
  return { ok: true };
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
