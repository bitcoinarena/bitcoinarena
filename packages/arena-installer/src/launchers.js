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
import { mkdirSync, writeFileSync, chmodSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { UNIT, BRIDGE_UNIT, TUNNEL_UNIT, LAUNCHD_LABEL, WINDOWS_TASK, startupDir } from './service.js';

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
    linux: [...ids.map((id) => (id === 'chain-bridge' ? BRIDGE_UNIT : `arena-${id}.service`)), UNIT, ...(tunnel ? [TUNNEL_UNIT] : [])],
    darwin: [...ids.map((id) => `io.bitcoin-arena.${id}`), LAUNCHD_LABEL, ...(tunnel ? [`${LAUNCHD_LABEL}.tunnel`] : [])],
    win32: [...ids.map((id) => `Arena ${id}`), WINDOWS_TASK, ...(tunnel ? [`${WINDOWS_TASK} tunnel`] : [])],
  };
}

const writable = (dir) => { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } };
const sh = (lines) => ['#!/bin/sh', ...lines, ''].join('\n');
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Write the launchers. `ownerUrl` the owner page (the public address when the node has one). Answers { files: [paths], app, menu } -
 * what was written, for the Done page and the installer's last lines.
 */
export function writeLaunchers({ home, s, ownerUrl, addCustody = null, platform = process.platform, env = process.env, applicationsDir = null, run = null }) {
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
    return { files, menu, app: null, start };
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
    return { files, menu: null, app, start };
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
  return { files, menu, app: null, start };
}
