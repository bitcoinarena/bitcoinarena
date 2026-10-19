// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STARTING THE NODE AFTER THE INSTALLER (the owner 2026-10-18: "When the installer is done it should be easy to start the node by providing info
// And help in the ui but also manual scripts, on windows a start menu item, on mac a /Application link"). Written when the node is installed,
// for exactly the services this node has (the node, its tunnel, its chain bridge, its Bitcoin Core, LND, the gateway, the custody agent):
//
//   Linux    <home>/bin/arena-node-{start,stop,status,open}   + ~/.local/share/applications/arena-node.desktop (the desktop's menu)
//   macOS    <home>/bin/Arena Node {Start,Stop,Status,Open}.command   + "Arena Node.app" in /Applications (else ~/Applications):
//            opening it starts the node's services and opens its owner page
//   Windows  <home>\bin\Arena node {start,stop,owner page}.cmd   + Start menu > Arena Node: the same three as shortcuts
//
// Every script names the services it acts on, so a user can read what it does. A node without custody also gets "add custody": it opens
// the installer's custody screens again (arena-install --add-custody, wizard.js beginAddCustody).
import { mkdirSync, writeFileSync, chmodSync, accessSync, constants, existsSync, lstatSync, readFileSync, rmSync, symlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { UNIT, BRIDGE_UNIT, TUNNEL_UNIT, LAUNCHD_LABEL, WINDOWS_TASK, startupDir, unitName } from './service.js';
import { named, INSTANCE } from './instance.js';

/** The services of a node from its state: { linux: units, darwin: launchd labels, win32: task names }. */
export function servicesOf(s) {
  const ids = [];
  for (const n of ['testnet4', 'mainnet']) if (s.core && s.core.networks && s.core.networks[n]) ids.push(`bitcoind-${n}`);
  if (s.chain && s.chain.kind === 'electrum') ids.push('chain-bridge');
  if (s.tor && s.tor.bin) ids.push('tor');                                // before LND: LND makes its onion through it
  if (s.lightning && s.lightning.mode === 'own') ids.push('lnd');
  if (s.gateway) ids.push('gateway');
  if (s.custodyAgent && s.custodyAgent.installedMs) ids.push('custody');
  const tunnel = s.reach && ['permanent', 'quick', 'workers'].includes(s.reach.mode);   // Tailscale Funnel runs in tailscaled
  if (s.reach && s.reach.mode === 'workers') ids.push('workers');                       // the keeper of the workers.dev address
  return {
    // the node last when starting (its chain first), first when stopping
    linux: [...ids.map((id) => (id === 'chain-bridge' ? BRIDGE_UNIT : unitName(id))), UNIT, ...(tunnel ? [TUNNEL_UNIT] : [])],
    darwin: [...ids.map((id) => `${LAUNCHD_LABEL}.${id}`), LAUNCHD_LABEL, ...(tunnel ? [`${LAUNCHD_LABEL}.tunnel`] : [])],
    win32: [...ids.map((id) => named(`Arena ${id}`, ' ')), WINDOWS_TASK, ...(tunnel ? [`${WINDOWS_TASK} tunnel`] : [])],
  };
}

const writable = (dir) => { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } };
const sh = (lines) => ['#!/bin/sh', ...lines, ''].join('\n');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Write the launchers. `ownerUrl` the owner page (the public address when the node has one). Answers { files: [paths], app, menu } -
 * what was written, for the Done page and the installer's last lines.
 */
export function writeLaunchers({ home, s, ownerUrl, addCustody = null, platform = process.platform, env = process.env, applicationsDir = null, run = null, release = null, node = process.execPath, pathDirs = null }) {
  // the arenanode command first (kanban #499): what the scripts below are the clickable form of
  let command = null;
  if (release) { try { command = writeCommand({ home, release, node, platform, env, run, pathDirs }); } catch (e) { command = { why: e.message }; } }
  const svc = servicesOf(s)[platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux'];
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const files = [];
  const put = (path, text, mode = 0o755) => { writeFileSync(path, text, { mode }); try { chmodSync(path, mode); } catch { /* Windows */ } files.push(path); return path; };
  if (platform === 'linux') {
    const start = put(join(bin, 'arena-node-start'), sh([`# Start the Arena node's services: ${svc.join(', ')}`, `systemctl --user start ${svc.join(' ')}`, `echo "Started. Owner page: ${ownerUrl}"`]));
    put(join(bin, 'arena-node-stop'), sh([`# Stop the Arena node's services`, `systemctl --user stop ${[...svc].reverse().join(' ')}`]));
    put(join(bin, 'arena-node-status'), sh([`systemctl --user --no-pager status ${svc.join(' ')}`]));
    put(join(bin, 'arena-node-open'), sh([`xdg-open ${q(ownerUrl)}`]));
    if (addCustody) put(join(bin, 'arena-node-add-custody'), sh(['# Add custody to this node: the installer\'s custody screens open in the browser', addCustody.map(q).join(' ')]));
    const apps = join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'applications');
    mkdirSync(apps, { recursive: true });
    const menu = put(join(apps, 'arena-node.desktop'), ['[Desktop Entry]', 'Type=Application', 'Name=Arena Node', 'Comment=Start the Arena node and open its owner page',
      `Exec=sh -c '${start} && xdg-open ${ownerUrl}'`, 'Terminal=false', 'Categories=Network;', ''].join('\n'), 0o644);
    return { files, menu, app: null, start, command };
  }
  if (platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const agents = join(env.HOME || homedir(), 'Library', 'LaunchAgents');
    const startLines = [`# Start the Arena node's services: ${svc.join(', ')}`, `uid=${uid}`,
      ...svc.map((l) => `launchctl print gui/$uid/${l} >/dev/null 2>&1 || launchctl bootstrap gui/$uid ${q(join(agents, `${l}.plist`))}; launchctl kickstart gui/$uid/${l}`)];
    const start = put(join(bin, 'Arena Node Start.command'), sh([...startLines, `echo "Started. Owner page: ${ownerUrl}"`]));
    put(join(bin, 'Arena Node Stop.command'), sh([`# Stop the Arena node's services`, `uid=${uid}`, ...[...svc].reverse().map((l) => `launchctl bootout gui/$uid/${l} 2>/dev/null`), 'echo Stopped.']));
    put(join(bin, 'Arena Node Status.command'), sh([`uid=${uid}`, ...svc.map((l) => `launchctl print gui/$uid/${l} 2>/dev/null | grep -E '^\\s*(state|pid) =' | sed "s/^/${l}: /" || echo "${l}: not loaded"`)]));
    put(join(bin, 'Arena Node Open.command'), sh([`open ${q(ownerUrl)}`]));
    if (addCustody) put(join(bin, 'Arena Node Add Custody.command'), sh(['# Add custody to this node: the installer\'s custody screens open in the browser', addCustody.map(q).join(' ')]));
    // THE APP: /Applications when the user may write there (an admin's macOS), else ~/Applications - Launchpad and Spotlight find both
    const appsDir = applicationsDir || (writable('/Applications') ? '/Applications' : join(env.HOME || homedir(), 'Applications'));
    const app = join(appsDir, 'Arena Node.app');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Arena Node</string><key>CFBundleDisplayName</key><string>Arena Node</string>
  <key>CFBundleIdentifier</key><string>io.bitcoin-arena.node.app</string><key>CFBundleExecutable</key><string>arena-node</string>
  <key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/>
</dict></plist>
`);
    put(join(app, 'Contents', 'MacOS', 'arena-node'), sh([...startLines, `open ${q(ownerUrl)}`]));
    return { files, menu: null, app, start, command };
  }
  // WINDOWS: the tasks the installer made (schtasks), and the Start menu's own folder of shortcuts to these scripts
  const cmd = (lines) => ['@echo off', ...lines, ''].join('\r\n');
  // each service is a logon task, or - without administrator rights - a script in the Startup folder (service.js windowsAutostart)
  const sd = startupDir(env);
  const start = put(join(bin, 'Arena node start.cmd'), cmd([`rem Start the Arena node's services: ${svc.join(', ')}`,
    ...svc.map((t) => `schtasks /run /tn "${t}" >nul 2>&1 || if exist "${join(sd, `${t}.vbs`)}" wscript "${join(sd, `${t}.vbs`)}"`), `echo Started. Owner page: ${ownerUrl}`, `start "" "${ownerUrl}"`]));
  // stopped: the tasks ended, and every process of this node - each names its home in its command line (node.db, lnd, tor, ...)
  const stop = put(join(bin, 'Arena node stop.cmd'), cmd([`rem Stop the Arena node's services`, ...[...svc].reverse().map((t) => `schtasks /end /tn "${t}" >nul 2>&1`),
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${home.replace(/'/g, "''")}*' -and $_.CommandLine -notlike '*\\bin\\Arena node*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
    'echo Stopped.', 'pause']));
  const open = put(join(bin, 'Arena node owner page.cmd'), cmd([`start "" "${ownerUrl}"`]));
  const custody = addCustody ? put(join(bin, 'Arena node add custody.cmd'), cmd(['rem Add custody to this node: the installer\'s custody screens open in the browser', addCustody.map((a) => `"${a}"`).join(' ')])) : null;
  const menu = join(env.APPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Arena Node');
  mkdirSync(menu, { recursive: true });
  const ps = [[start, 'Start Arena node'], [stop, 'Stop Arena node'], [open, 'Arena node owner page'], ...(custody ? [[custody, 'Add custody to the Arena node']] : [])]
    .map(([target, name]) => `$s = $w.CreateShortcut('${join(menu, `${name}.lnk`).replace(/'/g, "''")}'); $s.TargetPath = '${target.replace(/'/g, "''")}'; $s.WorkingDirectory = '${bin.replace(/'/g, "''")}'; $s.Save()`);
  if (run) run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ['$w = New-Object -ComObject WScript.Shell', ...ps].join('; ')]);
  return { files, menu, app: null, start, command };
}

// THE ARENANODE COMMAND ON THE PATH (kanban #499, the owner 2026-10-19: "Make a command arenanode that can stop start the service, status
// and diagnosis commands"): <home>/bin/arenanode runs this release's bin/arenanode.mjs with the node's home in it, so the user types no
// flags; a second node on the machine (instance.js) has arenanode-<instance>. Put on the PATH:
//   Linux    a link in ~/.local/bin (Ubuntu's ~/.profile puts it on the PATH once it exists; else a line is added there)
//   macOS    a link in /opt/homebrew/bin or /usr/local/bin when the user may write there, else ~/.local/bin and a line in ~/.zprofile
//   Windows  <home>\bin\arenanode.cmd, and <home>\bin added to the user's PATH (a new console window finds it)
// An update writes it again for the new release (update.js). A file of that name that is not ours is never replaced.
export const commandName = () => (INSTANCE ? `arenanode-${INSTANCE}` : 'arenanode');
export function writeCommand({ home, release, node, platform = process.platform, env = process.env, run = null, pathDirs = null }) {
  const name = commandName();
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(release, 'packages', 'arena-installer', 'bin', 'arenanode.mjs');
  const what = `The ${name} command (kanban #499), written by the installer: ${name} status, ${name} restart lnd, ${name} doctor, ${name} help`;
  if (platform === 'win32') {
    const file = join(bin, `${name}.cmd`);
    writeFileSync(file, ['@echo off', `rem ${what}`, `"${node}" "${script}" --home "${home}" --name ${name} %*`].join('\r\n') + '\r\n');
    const d = bin.replace(/'/g, "''");
    // `pathSet`: the PATH change, for the caller to await - measured in the Windows VM (rc.25 --update over ssh): not awaited, the
    // update's process ended first and Windows ended the PowerShell with its session, so the user PATH never got the folder
    const pathSet = run ? Promise.resolve(run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not (($p -split ';') -contains '${d}')) { [Environment]::SetEnvironmentVariable('Path', $(if ($p) { $p + ';${d}' } else { '${d}' }), 'User') }`])) : null;
    return { name, file, link: null, dir: bin, note: 'open a new console window to use it', pathSet };
  }
  const file = join(bin, name);
  writeFileSync(file, sh([`# ${what}`, `exec ${q(node)} ${q(script)} --home ${q(home)} --name ${name} "$@"`]), { mode: 0o755 });
  chmodSync(file, 0o755);
  // a link only into this user's own folders and, on a macOS, the PATH folders the user may write - never anywhere when the environment
  // names no home (a test's)
  const H = env.HOME;
  if (!H && !pathDirs) return { name, file, link: null, dir: null, note: `run it as ${file}` };
  const local = join(H || homedir(), '.local', 'bin');
  const dirs = pathDirs || (platform === 'darwin' && process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', local] : [local]);
  for (const d of dirs) {
    if (d === local) mkdirSync(d, { recursive: true });
    if (!existsSync(d) || !writable(d)) continue;
    const link = join(d, name);
    let mine = true;
    try { const st = lstatSync(link); mine = st.isSymbolicLink() || readFileSync(link, 'utf8').includes('arenanode.mjs'); } catch { mine = true; }
    if (!mine) continue;
    rmSync(link, { force: true });
    symlinkSync(file, link);
    let note = null;
    if (!String(env.PATH || '').split(':').includes(d)) {
      const profile = join(H || homedir(), platform === 'darwin' ? '.zprofile' : '.profile');
      let text = ''; try { text = readFileSync(profile, 'utf8'); } catch { text = ''; }
      if (!text.includes(d) && !(platform === 'linux' && text.includes('$HOME/.local/bin'))) appendFileSync(profile, `\n# the arenanode command (Arena node)\nexport PATH="${d}:$PATH"\n`);
      note = `open a new terminal to use it (${d} goes on the PATH at login)`;
    }
    return { name, file, link, dir: d, note };
  }
  return { name, file, link: null, dir: null, note: `run it as ${file}` };
}

/**
 * THE AUTO UPDATE SERVICE (kanban #505): `<home>/bin/arenanode auto-update` as a service of this node - its command names the node's own
 * arenanode, not a release, so an update moves everything else and never stops it mid-way; it ends with 75 after an update and comes
 * back from the new release (systemd Restart=on-failure, launchd KeepAlive, the Windows launcher's loop). Answers installProgram's answer.
 */
export function installUpdater({ home, installProgram, platform = process.platform, env = process.env, sh = undefined, boot = true }) {
  const cmd = join(home, 'bin', platform === 'win32' ? `${commandName()}.cmd` : commandName());
  return installProgram({ id: 'updater', description: 'The Arena node\'s auto update', args: [cmd, 'auto-update'], home, boot, platform, env, againOn: 75, ...(sh ? { sh } : {}) });
}
