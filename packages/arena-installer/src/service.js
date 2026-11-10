// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE AS A SERVICE (Linux in slice 1 - launchd and Windows in slice 4): a systemd user unit that starts the
// seat from the installed release with the settings the wizard wrote, restarts it when it falls over, and is checked healthy by the
// installer before the wizard goes on. The user needs no root: `loginctl enable-linger` keeps a user unit running with nobody logged
// in, and the wizard says so when linger is off.
import { named } from './instance.js';
import { writeFileSync, mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

// a second node on the machine names its services apart (instance.js)
export const unitName = (id) => `${named(`arena-${id}`)}.service`;
export const UNIT = unitName('node');
export const BRIDGE_UNIT = unitName('chain-bridge');
export const TUNNEL_UNIT = unitName('tunnel');

// STARTED ONCE THE PORT IT DIALS ANSWERS (kanban #720, the owner's LND log 2026-10-27: "dial proxy failed (connection refused)"): After=
// orders the start only - LND came up before Tor's SOCKS port listened and dialled into nothing. The unit waits up to 90 s for the port,
// else fails and is started again 30 s later (Restart). `$$` is a `$` to the shell: systemd expands a single one itself.
export const waitPortLine = (port) => `ExecStartPre=/bin/bash -c 'for i in $$(seq 1 90); do (echo > /dev/tcp/127.0.0.1/${Number(port)}) 2>/dev/null && exit 0; sleep 1; done; echo "nothing listens on 127.0.0.1:${Number(port)}"; exit 1'`;

/** The unit's directory: $XDG_CONFIG_HOME/systemd/user. */
export const unitDir = (env = process.env) => join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user');

/** The seat's unit text. `node` is the runtime the release ships (process.execPath when run from it). */
export function seatUnit({ node, release, home, port }) {
  return `# The Arena node, written by the installer. An update rewrites this file; the settings live in ${join(home, 'arena.conf')} (bitcoinarena config).
[Unit]
Description=Bitcoin Arena node (testnet4) on port ${port}
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
  return `# The Arena node's chain bridge (Electrum mode), written by the installer.
[Unit]
Description=Bitcoin Arena chain bridge (Electrum + Esplora, testnet4) on 127.0.0.1:${bridgePort}
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
 * (injectable: the tests start the seat without systemd). `onStage('start')` once the services are in and the wait for the seat
 * begins (the wizard's progress, kanban #651). Answers { ok, why, ms, boot, linger }.
 */
export async function installService({ node = process.execPath, release, home, port, bridgePort = null, tunnel = null, tunnelArgs = null, boot = true,
  env = process.env, sh = run, fetcher = fetch, waitMs = 90000, platform = process.platform, onStage = () => {} }) {
  if (platform === 'darwin' || platform === 'win32') {
    // THE CHAIN BRIDGE FIRST (Electrum mode): its own service, so the node finds its chain when it starts - on Linux it is the
    // arena-chain-bridge unit below, which the node's unit starts after
    // a node that reads its own Core needs no bridge: one left from the interim Electrum chain is taken away (removeProgram)
    if (!bridgePort) await removeProgram({ id: 'chain-bridge', home, env, sh, platform });
    // A WAY TO BE REACHED THAT RUNS NO TUNNEL TAKES THE OLD ONE AWAY (kanban #734, measured 2026-10-29 on the VM's arena-vm-734: reach moved
    // from a quick tunnel to Tailscale Funnel, and arena-tunnel--3 - cloudflared to the node's port - kept running beside it, the node still
    // reachable at its old random trycloudflare address): Funnel and direct run no tunnel, so one left from before is removed
    if (!tunnel && !tunnelArgs) await removeProgram({ id: 'tunnel', home, env, sh, platform });
    if (bridgePort) {
      const b = await installProgram({ id: 'chain-bridge', description: 'Bitcoin Arena: chain bridge (Electrum + Esplora, testnet4)',
        args: [node, join(release, 'packages', 'arena-installer', 'bin', 'chain-bridge.mjs'), String(bridgePort), home], home, boot, env, sh, platform });
      if (!b.ok) return b;
    }
    if (platform === 'darwin') return installLaunchd({ node, release, home, port, tunnelArgs, boot, env, sh, fetcher, waitMs, onStage });
    return installWindows({ node, release, home, port, tunnelArgs, boot, sh, fetcher, waitMs, env, onStage });
  }
  const dir = unitDir(env);
  mkdirSync(dir, { recursive: true });
  const units = [UNIT];
  writeFileSync(join(dir, UNIT), seatUnit({ node, release, home, port }));
  if (bridgePort) { writeFileSync(join(dir, BRIDGE_UNIT), bridgeUnit({ node, release, home, bridgePort })); units.unshift(BRIDGE_UNIT); }
  else await removeProgram({ id: 'chain-bridge', home, env, sh, platform });
  if (tunnel) { writeFileSync(join(dir, TUNNEL_UNIT), tunnel); units.push(TUNNEL_UNIT); }
  else await removeProgram({ id: 'tunnel', home, env, sh, platform });   // Funnel and direct run no tunnel: one left from before goes (kanban #734)
  const t0 = Date.now();
  for (const args of [['--user', 'daemon-reload'], ['--user', boot ? 'enable' : 'disable', ...units], ['--user', 'restart', ...units]]) {
    const r = await sh('systemctl', args);
    if (!r.ok) return { ok: false, why: `systemctl ${args.join(' ')} failed: ${(r.err || r.out).trim().slice(0, 300)}` };
  }
  onStage('start');                                               // the services are in: the wizard's progress shows the wait
  const health = await waitHealthy({ port, fetcher, waitMs });
  if (boot) await sh('loginctl', ['enable-linger', env.USER || '']);
  const linger = await sh('loginctl', ['show-user', env.USER || '', '-p', 'Linger', '--value']);
  return { ...health, ms: Date.now() - t0, boot, linger: linger.ok ? linger.out.trim() === 'yes' : null };
}

// MACOS: A LAUNCHD AGENT - ~/Library/LaunchAgents/io.bitcoin-arena.node.plist, the seat from the release with
// its settings file (src/run.js <home>/arena.conf), kept alive, logged beside the node's home.
// RUN AS AN APP RUNS, NOT THROTTLED (kanban #1122, measured 2026-11-04 on the main test host): an agent with no ProcessType gets
// launchd's light resource limits - its threads run at priority 20 (spawn type daemon), a program started from a shell at 31. On a busy
// machine the installer node's loop was held up to 16 s while its thread used under 1 s of processor ("[lag] ... waiting for the machine,
// not for itself"), GET /identity went unanswered for 5-15 s, and seats on the same machine started from a shell answered in 2 ms.
// ProcessType Interactive runs it at 31 (measured: three test agents, none / Standard 20, Interactive 31). Every agent the installer
// writes says so - the seat, its tunnel and its programs (bitcoind, lnd, the guardian, the gateway) alike.
export const LAUNCHD_PROCESS_TYPE = '<key>ProcessType</key><string>Interactive</string>';
/** An agent written before (no ProcessType) says Interactive too; one that names its own keeps it. Not a plist: unchanged. */
export function interactivePlist(text) {
  const t = String(text);
  if (/<key>ProcessType<\/key>/.test(t) || !/<\/dict>\s*<\/plist>\s*$/.test(t)) return t;
  return t.replace(/\n?(\s*)<\/dict>(\s*<\/plist>\s*)$/, (m, sp, tail) => `\n  ${LAUNCHD_PROCESS_TYPE}\n</dict>${tail}`);
}
export const LAUNCHD_LABEL = named('io.bitcoin-arena.node');
const xml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function launchdPlist({ node, release, home, port, boot = true, env = {} }) {
  // AN AGENT'S OWN ENVIRONMENT KEPT (kanban #574, 2026-10-22: the three test installers' agents carried FM_BLWP_FINALITY_DELAY=12, added
  // by hand; an update rewrote them from this template and dropped it): the variables an older agent set are written again
  const envXml = Object.keys(env).length ? `\n  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('')}</dict>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- The Arena node, written by the installer. An update rewrites this file; the settings live in ${xml(home)}/arena.conf (bitcoinarena config). -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>src/run.js</string><string>${xml(home)}/arena.conf</string></array>
  <key>WorkingDirectory</key><string>${xml(release)}/packages/arena-node</string>
  <key>RunAtLoad</key><${boot ? 'true' : 'false'}/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  ${LAUNCHD_PROCESS_TYPE}
  <key>StandardOutPath</key><string>${xml(home)}/node.log</string>
  <key>StandardErrorPath</key><string>${xml(home)}/node.log</string>${envXml}
</dict>
</plist>
`;
}

// WINDOWS: A SCHEDULED TASK (ruling 2: no custody on Windows - fedimint does not build there) - "Arena node",
// at logon (or at start-up with the user's password), running a .cmd that starts the seat from arena.conf - and starts it again when it
// ends with an error (the launcher's own loop, windowsRestart: the task itself restarts nothing).
export const WINDOWS_TASK = named('Arena node', ' ');
/**
 * THE NODE'S SERVICE, AS THE OWNER FINDS IT ON THIS SYSTEM (the 2026.1.9.11 install test, kanban #704: the installer's last words said "the user
 * service arena-node" on a macOS whose agent is io.bitcoin-arena.node--mt19911): its name with this node's instance, in that system's word.
 */
export const nodeServiceWords = (platform = process.platform) => (platform === 'darwin' ? `the launch agent ${LAUNCHD_LABEL}`
  : platform === 'win32' ? `the scheduled task "${WINDOWS_TASK}"` : `the user service ${UNIT}`);
export function windowsLauncher({ node, release, home, port }) {
  return ['@echo off', 'rem The Arena node, written by the installer: the seat started from its settings, arena.conf (bitcoinarena config).',
    `cd /d "${release}\\packages\\arena-node"`, ':again',
    `"${node}" src\\run.js "${home}\\arena.conf" >> "${home}\\node.log" 2>&1`, windowsRestart(10)].join('\r\n') + '\r\n';
}
/**
 * A WINDOWS LAUNCHER STARTS ITS PROGRAM AGAIN (kanban #1443, audit 8 O8-4): nothing restarted a seat, tunnel or chain bridge that ended
 * on Windows (an uncaught error, "the apps could not be fetched" at a boot without network) until the next logon - systemd does it
 * after 10 s (Restart=on-failure), launchd too (KeepAlive). The line after the program: on an error exit, wait `seconds` (ping: `timeout`
 * refuses a window without input) and go back to `:again`; `always` also after a clean exit (systemd Restart=always). A stop must end
 * the launcher's cmd.exe with its program, or this loop starts the program again: the owner page's stop ends the process tree, the
 * update's ends the launchers it moves (update.js).
 */
export const windowsRestart = (seconds, always = false) => (always ? `ping -n ${seconds + 1} 127.0.0.1 >nul & goto again`
  : `if %errorlevel% neq 0 (ping -n ${seconds + 1} 127.0.0.1 >nul & goto again)`);
/** A launcher written before the loop (a tunnel, a chain bridge, a program): the loop put around its program line. Written with one: unchanged. */
export function withWindowsRestart(text, seconds = 30) {
  if (/^:again\r?$/m.test(text)) return text;
  const lines = String(text).split('\r\n');
  const i = lines.findLastIndex((l) => /^(call )?"/.test(l));
  if (i < 0) return text;
  lines.splice(i, 1, ':again', lines[i], windowsRestart(seconds));
  return lines.join('\r\n');
}
/**
 * START A PROGRAM AT EVERY LOGON, AND NOW, ON WINDOWS. A scheduled task at logon first; Windows refuses that to a user without
 * administrator rights ("ERROR: Access is denied", measured in the Windows VM 2026-10-18, rc.10: the Bitcoin Core step stopped
 * there), so then the user's own Startup folder: a hidden-window script that starts the launcher - at every logon, and now.
 * Answers { ok, mode: 'task' | 'startup', startup?, why }.
 */
export const startupDir = (env = process.env) => join(env.APPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
export const startupScript = (name, file) => `' ${name}, written by the installer: the launcher in a hidden window, at every logon\r\n`
  + `CreateObject("WScript.Shell").Run """${file.replace(/"/g, '""')}""", 0, False\r\n`;
export async function windowsAutostart({ name, file, sh, env = process.env }) {
  const c = await sh('schtasks', windowsTaskArgs({ launcher: file }).map((x) => (x === WINDOWS_TASK ? name : x)));
  if (c.ok) {
    // A TASK THAT WOULD NOT START IS STARTED BY HAND (kanban #964): the task is Interactive only, and a run refused here used to pass in silence
    const r = await sh('schtasks', ['/run', '/tn', name]);
    if (!r.ok) await sh('cmd', ['/c', 'start', '""', '/b', file]);
    return { ok: true, mode: 'task', started: r.ok ? 'task' : 'direct' };
  }
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

/**
 * A LAUNCH AGENT BOOTSTRAPPED RIGHT AFTER ITS BOOTOUT, tried up to 5 times a second apart (as update.js and node-services.js do):
 * launchd refuses a bootstrap while the agent it just booted out still unloads - measured 2026-10-22 on the second machine (kanban
 * #577): the install's finish step reloaded the updater, `Bootstrap failed: 5: Input/output error`, and the node was left with none.
 * `pauseMs` is for tests.
 */
export async function bootstrapAgent(sh, uid, file, { tries = 5, pauseMs = 1000 } = {}) {
  let r = { ok: false, out: '', err: '' };
  for (let i = 0; i < tries && !r.ok; i++) { if (i) await new Promise((ok) => setTimeout(ok, pauseMs)); r = await sh('launchctl', ['bootstrap', `gui/${uid}`, file]); }
  return r;
}

/** macOS: the agents written to ~/Library/LaunchAgents and loaded (bootout first: an update or a second run replaces them). */
async function installLaunchd({ node, release, home, port, tunnelArgs, boot, env, sh, fetcher, waitMs, onStage = () => {} }) {
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
    const r = await bootstrapAgent(sh, uid, file);
    if (!r.ok) return { ok: false, why: `launchctl bootstrap ${a.label} failed: ${(r.err || r.out).trim().slice(0, 300)}` };
  }
  onStage('start');                                               // the services are in: the wizard's progress shows the wait
  const health = await waitHealthy({ port, fetcher, waitMs });
  return { ...health, ms: Date.now() - t0, boot, linger: true };
}

/** Windows: the launchers written beside the node's home, the scheduled tasks created and run (at logon), or started once. */
async function installWindows({ node, release, home, port, tunnelArgs, boot, sh, fetcher, waitMs, env = process.env, onStage = () => {} }) {
  const t0 = Date.now();
  const tasks = [{ name: WINDOWS_TASK, file: join(home, 'arena-node.cmd'), text: windowsLauncher({ node, release, home, port }) }];
  if (tunnelArgs) tasks.push({ name: `${WINDOWS_TASK} tunnel`, file: join(home, 'arena-tunnel.cmd'),
    text: ['@echo off', 'rem The Arena node tunnel, written by the installer.', ':again', `${tunnelArgs.map((a) => `"${a}"`).join(' ')} >> "${home}\\tunnel.log" 2>&1`, windowsRestart(10)].join('\r\n') + '\r\n' });
  for (const t of tasks) {
    writeFileSync(t.file, t.text);
    if (boot) {
      const a = await windowsAutostart({ name: t.name, file: t.file, sh, env });
      if (!a.ok) return { ok: false, why: a.why };
    } else {
      await sh('cmd', ['/c', 'start', '""', '/b', t.file]);
    }
  }
  onStage('start');                                               // the services are in: the wizard's progress shows the wait
  const health = await waitHealthy({ port, fetcher, waitMs });
  return { ...health, ms: Date.now() - t0, boot, linger: true };
}

/**
 * A PROGRAM'S SERVICE TAKEN AWAY (the owner's services card on 2026.1.9.9, 2026-10-26: "Do I need electrum when I have bitcoin core installed
 * and running? That is confusing" - the chain bridge of the interim Electrum chain stayed after the switch to the node's own Core, its agent
 * started again and again, "spawn scheduled, last exit 2"): stopped and its file removed - the launch agent, the unit, or the launcher with its
 * logon task or Startup script. Nothing to do when it is not there. Answers { ok, removed }.
 */
export async function removeProgram({ id, home, env = process.env, sh = run, platform = process.platform, unit: unitGiven = null }) {
  if (platform === 'darwin') {
    const label = `${LAUNCHD_LABEL}.${id}`;
    const file = join(env.HOME || homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (!existsSync(file)) return { ok: true, removed: false };
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    await sh('launchctl', ['bootout', `gui/${uid}/${label}`]);
    rmSync(file, { force: true });
    return { ok: true, removed: true };
  }
  if (platform === 'win32') {
    const file = join(home, `arena-${id}.cmd`), name = named(`Arena ${id}`, ' ');
    const vbs = join(startupDir(env), `${name}.vbs`);
    if (!existsSync(file) && !existsSync(vbs)) return { ok: true, removed: false };
    await sh('schtasks', ['/end', '/tn', name]);
    await sh('schtasks', ['/delete', '/f', '/tn', name]);
    rmSync(vbs, { force: true }); rmSync(file, { force: true });
    return { ok: true, removed: true };
  }
  // `unit` names the file outright: another node of this machine updated from this process has its own (instance) name (kanban #719)
  const unit = unitGiven || unitName(id), file = join(unitDir(env), unit);
  if (!existsSync(file)) return { ok: true, removed: false };
  await sh('systemctl', ['--user', 'disable', '--now', unit]);
  rmSync(file, { force: true });
  await sh('systemctl', ['--user', 'daemon-reload']);
  return { ok: true, removed: true };
}

/**
 * ANY OTHER PROGRAM OF THE NODE AS A SERVICE (ruling 8: the node's own Bitcoin Core): `id` names it (arena-<id>.service,
 * io.bitcoin-arena.<id>, the task "Arena <id>"), `args` is its command line, `log` where its output goes. Started now; at boot too
 * when `boot`. `vars`: environment the program needs (secrets too - kept only in files of this user, 0600). Answers { ok, why }.
 */
export async function installProgram({ id, description, args, home, boot = true, vars = null, partOf = null, env = process.env, sh = run, platform = process.platform, againOn = null,
  waitPort = null, restart = 'on-failure' }) {
  const varLines = Object.entries(vars || {}).map(([k, v]) => { if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /[\r\n]/.test(String(v))) throw new Error(`bad variable ${k}`); return [k, String(v)]; });
  if (platform === 'darwin') {
    const dir = join(env.HOME || homedir(), 'Library', 'LaunchAgents');
    mkdirSync(dir, { recursive: true });
    const label = `${LAUNCHD_LABEL}.${id}`;
    const file = join(dir, `${label}.plist`);
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ${xml(description)}, written by the installer. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${args.map((a) => `<string>${xml(a)}</string>`).join('')}</array>${varLines.length ? `
  <key>EnvironmentVariables</key><dict>${varLines.map(([k, v]) => `<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>` : ''}
  <key>RunAtLoad</key><${boot ? 'true' : 'false'}/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  ${LAUNCHD_PROCESS_TYPE}
  <key>StandardOutPath</key><string>${xml(home)}/${id}.log</string>
  <key>StandardErrorPath</key><string>${xml(home)}/${id}.log</string>
</dict>
</plist>
`);
    chmodSync(file, 0o600);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    await sh('launchctl', ['bootout', `gui/${uid}/${label}`]);
    const r = await bootstrapAgent(sh, uid, file);
    return r.ok ? { ok: true } : { ok: false, why: `launchctl bootstrap ${label} failed: ${(r.err || r.out).trim().slice(0, 300)}` };
  }
  if (platform === 'win32') {
    const file = join(home, `arena-${id}.cmd`);
    // `againOn`: an exit code on which the program is started again at once (the auto update ends with 75 to come back from the new
    // release); any other error exit starts it again after 30 s, as systemd's RestartSec (kanban #1443: no service manager restarts a
    // launcher on Windows), and `restart: 'always'` a clean exit too
    writeFileSync(file, ['@echo off', `rem ${description}, written by the installer.`, ...varLines.map(([k, v]) => `set "${k}=${v}"`),
      ':again',
      // CALL a batch file (measured 2026-10-19 22:43Z in the Windows VM: "ending: this service starts again from the new release", exit 75,
      // and nothing started it - a .cmd run from a .cmd without `call` never returns to the caller, so `goto again` never ran)
      `${/\.(cmd|bat)$/i.test(String(args[0])) ? 'call ' : ''}${args.map((a) => `"${a}"`).join(' ')} >> "${home}\\${id}.log" 2>&1`,
      ...(againOn ? [`if %errorlevel%==${againOn} goto again`] : []), windowsRestart(30, restart === 'always')].join('\r\n') + '\r\n', { mode: 0o600 });
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
  writeFileSync(join(dir, unit), `# ${description}, written by the installer.
[Unit]
Description=${description}
After=network-online.target${partOf ? ` ${unitName(partOf)}` : ''}
Wants=network-online.target
${partOf ? `# restarted with arena-${partOf}: LND's onion service lives in that Tor and is gone when it restarts (measured 2026-10-18 on the test host)\nPartOf=${unitName(partOf)}\n` : ''}
[Service]
${varLines.length ? `EnvironmentFile=${envFile}\n` : ''}${waitPort ? `${waitPortLine(waitPort)}\n` : ''}ExecStart=${args.join(' ')}
Restart=${restart}
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
