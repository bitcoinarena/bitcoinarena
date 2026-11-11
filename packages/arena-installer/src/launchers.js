// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STARTING THE NODE AFTER THE INSTALLER (2026-10-18: "When the installer is done it should be easy to start the node by providing info
// And help in the ui but also manual scripts, on windows a start menu item, on mac a /Application link"). Written when the node is installed,
// for exactly the services this node has (the node, its tunnel, its chain bridge, its Bitcoin Core, LND, the gateway, the custody agent):
//
//   Linux    <home>/bin/bitcoin-arena-{start,stop,status,open}   + ~/.local/share/applications/bitcoin-arena.desktop (the desktop's menu)
//   macOS    <home>/bin/Bitcoin Arena {Start,Stop,Status,Open}.command   + "Bitcoin Arena.app" in /Applications (else ~/Applications):
//            opening it starts the node's services and opens its owner page
//   Windows  <home>\bin\Bitcoin Arena {start,stop,owner page}.cmd   + Start menu > Bitcoin Arena: the same three as shortcuts
//
// THE NAME PEOPLE SEE IS "Bitcoin Arena" (kanban #635, 2026-10-25: "die Plattform sollte immer bitcoin-arena sein, nicht
// Arena-node" - what users see only; the services, the command and the release files keep their names). The files of the old name are
// removed when these are written (an update writes them again). AND THE FILES TOO (kanban #688, 2026-10-26: "Rename the directories and
// binaries to bitcoinarena, not arenanode everywhere in the installer, the packages etc."): the Linux scripts were arena-node-*, the menu
// entry arena-node.desktop, the fallback app's program arena-node - written under the new names, the old ones removed. The services keep
// their names (arena-node.service, io.bitcoin-arena.node, "Arena node"): a running node's units are not renamed under it.
//
// Every script names the services it acts on, so a user can read what it does. A node without custody also gets "add custody": it opens
// the installer's custody screens again (arena-install --add-custody, wizard.js beginAddCustody).
import { mkdirSync, writeFileSync, chmodSync, accessSync, constants, existsSync, lstatSync, readFileSync, rmSync, symlinkSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { UNIT, BRIDGE_UNIT, TUNNEL_UNIT, LAUNCHD_LABEL, WINDOWS_TASK, startupDir, unitName } from './service.js';
import { named, INSTANCE } from './instance.js';
import { SERVICES } from './node-services.js';

/**
 * STOP STOPS EVERY SERVICE OF THE NODE (the 2026.1.9.11 install test, kanban #704: "Bitcoin Arena Stop.command" left the .updater agent running -
 * the scripts named only the services the state lists, and the auto update, the liquidity provider or an agent added later are not among
 * them): the auto update first, so it starts nothing again, then the node's services last first, then every other service the installer can
 * write for this node (node-services.js SERVICES) - one that is not there is passed over quietly. `nameOf(id)` the service's name.
 */
export function stopOrder(svc, nameOf) {
  const rest = SERVICES.filter((x) => !x.inside && x.id !== 'node').map((x) => nameOf(x.id)).reverse();
  return [...new Set([nameOf('updater'), ...[...svc].reverse(), ...rest])];
}

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
  // the bitcoinarena command first: what the scripts below are the clickable form of
  let command = null;
  if (release) { try { command = writeCommand({ home, release, node, platform, env, run, pathDirs }); } catch (e) { command = { why: e.message }; } }
  const svc = servicesOf(s)[platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'win32' : 'linux'];
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const files = [];
  const put = (path, text, mode = 0o755) => { writeFileSync(path, text, { mode }); try { chmodSync(path, mode); } catch { /* Windows */ } files.push(path); return path; };
  if (platform === 'linux') {
    for (const old of ['start', 'stop', 'status', 'open', 'add-custody']) rmSync(join(bin, `arena-node-${old}`), { force: true });
    const start = put(join(bin, 'bitcoin-arena-start'), sh([`# Start Bitcoin Arena's services: ${svc.join(', ')}`, `systemctl --user start ${svc.join(' ')}`, `echo "Started. Owner page: ${ownerUrl}"`]));
    put(join(bin, 'bitcoin-arena-stop'), sh([`# Stop Bitcoin Arena's services, every one of this node`, ...stopOrder(svc, (id) => (id === 'chain-bridge' ? BRIDGE_UNIT : unitName(id))).map((u) => `systemctl --user stop ${u} 2>/dev/null`), 'echo Stopped.']));
    put(join(bin, 'bitcoin-arena-status'), sh([`systemctl --user --no-pager status ${svc.join(' ')}`]));
    put(join(bin, 'bitcoin-arena-open'), sh([`xdg-open ${q(ownerUrl)}`]));
    if (addCustody) put(join(bin, 'bitcoin-arena-add-custody'), sh(['# Add custody to this node: the installer\'s custody screens open in the browser', addCustody.map(q).join(' ')]));
    const apps = join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share'), 'applications');
    mkdirSync(apps, { recursive: true });
    rmSync(join(apps, 'arena-node.desktop'), { force: true });
    const menu = put(join(apps, 'bitcoin-arena.desktop'), ['[Desktop Entry]', 'Type=Application', 'Name=Bitcoin Arena', 'Comment=Start your Bitcoin Arena node and open its owner page',
      `Exec=sh -c '${start} && xdg-open ${ownerUrl}'`, 'Terminal=false', 'Categories=Network;', ''].join('\n'), 0o644);
    return { files, menu, app: null, start, command };
  }
  if (platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const agents = join(env.HOME || homedir(), 'Library', 'LaunchAgents');
    const startLines = [`# Start Bitcoin Arena's services: ${svc.join(', ')}`, `uid=${uid}`,
      ...svc.map((l) => `launchctl print gui/$uid/${l} >/dev/null 2>&1 || launchctl bootstrap gui/$uid ${q(join(agents, `${l}.plist`))}; launchctl kickstart gui/$uid/${l}`)];
    for (const old of ['Start', 'Stop', 'Status', 'Open', 'Add Custody']) rmSync(join(bin, `Arena Node ${old}.command`), { force: true });
    const start = put(join(bin, 'Bitcoin Arena Start.command'), sh([...startLines, `echo "Started. Owner page: ${ownerUrl}"`]));
    put(join(bin, 'Bitcoin Arena Stop.command'), sh([`# Stop Bitcoin Arena's services, every agent of this node`, `uid=${uid}`,
      ...stopOrder(svc, (id) => `${LAUNCHD_LABEL}.${id}`).map((l) => `launchctl bootout gui/$uid/${l} 2>/dev/null`), 'echo Stopped.']));
    put(join(bin, 'Bitcoin Arena Status.command'), sh([`uid=${uid}`, ...svc.map((l) => `launchctl print gui/$uid/${l} 2>/dev/null | grep -E '^\\s*(state|pid) =' | sed "s/^/${l}: /" || echo "${l}: not loaded"`)]));
    put(join(bin, 'Bitcoin Arena Open.command'), sh([`open ${q(ownerUrl)}`]));
    if (addCustody) put(join(bin, 'Bitcoin Arena Add Custody.command'), sh(['# Add custody to this node: the installer\'s custody screens open in the browser', addCustody.map(q).join(' ')]));
    // THE APP: /Applications when the user may write there (an admin's macOS), else ~/Applications - Launchpad and Spotlight find both
    const appsDir = applicationsDir || (writable('/Applications') ? '/Applications' : join(env.HOME || homedir(), 'Applications'));
    rmSync(join(appsDir, 'Arena Node.app'), { recursive: true, force: true });
    const app = join(appsDir, 'Bitcoin Arena.app');
    // THE DMG'S OWN APP IS LEFT ALONE (kanban #669, found 2026-10-26 by the #688 work): the native app (package-mac.sh, bundle
    // io.bitcoin-arena.node.setup) lives at the same path, and writing this launcher's Info.plist over it broke that app - its Close, its
    // update on open. With it there, the .command files above are the launchers and the app is not touched
    let native = false;
    try { native = /<string>io\.bitcoin-arena\.node\.setup<\/string>/.test(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8')); } catch { native = false; }
    if (native) return { files, menu: null, app, start, command, nativeApp: true };
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Bitcoin Arena</string><key>CFBundleDisplayName</key><string>Bitcoin Arena</string>
  <key>CFBundleIdentifier</key><string>io.bitcoin-arena.node.app</string><key>CFBundleExecutable</key><string>bitcoin-arena</string>
  <key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/>
</dict></plist>
`);
    rmSync(join(app, 'Contents', 'MacOS', 'arena-node'), { force: true });
    put(join(app, 'Contents', 'MacOS', 'bitcoin-arena'), sh([...startLines, `open ${q(ownerUrl)}`]));
    return { files, menu: null, app, start, command };
  }
  // WINDOWS: the tasks the installer made (schtasks), and the Start menu's own folder of shortcuts to these scripts
  const cmd = (lines) => ['@echo off', ...lines, ''].join('\r\n');
  // each service is a logon task, or - without administrator rights - a script in the Startup folder (service.js windowsAutostart)
  const sd = startupDir(env);
  for (const old of ['start', 'stop', 'owner page', 'add custody']) rmSync(join(bin, `Arena node ${old}.cmd`), { force: true });
  const start = put(join(bin, 'Bitcoin Arena start.cmd'), cmd([`rem Start Bitcoin Arena's services: ${svc.join(', ')}`,
    ...svc.map((t) => `schtasks /run /tn "${t}" >nul 2>&1 || if exist "${join(sd, `${t}.vbs`)}" wscript "${join(sd, `${t}.vbs`)}"`), `echo Started. Owner page: ${ownerUrl}`, `start "" "${ownerUrl}"`]));
  // stopped: the tasks ended, and every process of this node - each names its home in its command line (node.db, lnd, tor, ...)
  const stop = put(join(bin, 'Bitcoin Arena stop.cmd'), cmd([`rem Stop Bitcoin Arena's services`, ...[...svc].reverse().map((t) => `schtasks /end /tn "${t}" >nul 2>&1`),
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${home.replace(/'/g, "''")}*' -and $_.CommandLine -notlike '*\\bin\\Bitcoin Arena*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
    'echo Stopped.', 'pause']));
  const open = put(join(bin, 'Bitcoin Arena owner page.cmd'), cmd([`start "" "${ownerUrl}"`]));
  const custody = addCustody ? put(join(bin, 'Bitcoin Arena add custody.cmd'), cmd(['rem Add custody to this node: the installer\'s custody screens open in the browser', addCustody.map((a) => `"${a}"`).join(' ')])) : null;
  const programs = join(env.APPDATA || join(env.USERPROFILE || homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  rmSync(join(programs, 'Arena Node'), { recursive: true, force: true });
  const menu = join(programs, 'Bitcoin Arena');
  mkdirSync(menu, { recursive: true });
  const ps = [[start, 'Start Bitcoin Arena'], [stop, 'Stop Bitcoin Arena'], [open, 'Bitcoin Arena owner page'], ...(custody ? [[custody, 'Add custody to Bitcoin Arena']] : [])]
    .map(([target, name]) => `$s = $w.CreateShortcut('${join(menu, `${name}.lnk`).replace(/'/g, "''")}'); $s.TargetPath = '${target.replace(/'/g, "''")}'; $s.WorkingDirectory = '${bin.replace(/'/g, "''")}'; $s.Save()`);
  if (run) run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ['$w = New-Object -ComObject WScript.Shell', ...ps].join('; ')]);
  return { files, menu, app: null, start, command };
}

// THE BITCOINARENA COMMAND ON THE PATH (2026-10-19: "Make a command arenanode that can stop start the service, status
// and diagnosis commands"; its name since kanban #688, 2026-10-26: "Rename the directories and binaries to bitcoinarena, not arenanode
// everywhere"): <home>/bin/bitcoinarena runs this release's bin/bitcoinarena.mjs with the node's home in it, so the user types no flags; a
// second node on the machine (instance.js) has bitcoinarena-<instance>. Put on the PATH:
//   Linux    a link in ~/.local/bin (Ubuntu's ~/.profile puts it on the PATH once it exists; else a line is added there)
//   macOS    a link in /opt/homebrew/bin or /usr/local/bin when the user may write there, else ~/.local/bin and a line in ~/.zprofile
//   Windows  <home>\bin\bitcoinarena.cmd, and <home>\bin added to the user's PATH (a new console window finds it)
// THE OLD NAME STAYS: <home>/bin/arenanode (arenanode-<instance>, arenanode.cmd) is written beside it as a small script that runs
// bitcoinarena, and linked the same way - the owner's habit, the app helpers of older releases and the auto update service of a node
// installed before 2026.1.9.8 (its service names <home>/bin/arenanode) all keep working.
// An update writes both again for the new release (update.js). A file of either name that is not ours is never replaced.
export const COMMAND = 'bitcoinarena';
export const LEGACY_COMMAND = 'arenanode';
export const commandName = () => (INSTANCE ? `${COMMAND}-${INSTANCE}` : COMMAND);
export const legacyCommandName = () => (INSTANCE ? `${LEGACY_COMMAND}-${INSTANCE}` : LEGACY_COMMAND);
/** The words every old-name script holds, so it is told from the full command (commandBehind) and known as ours. */
export const SHIM_MARK = 'it runs bitcoinarena';
/** The old name's script: it runs the new command in the same folder, with every argument and its exit code (75 for the auto update's loop). */
export function legacyShim({ name, file, platform = process.platform }) {
  // Windows reads a running batch file by its place in the file: an update rewrites this one while the auto update service runs through
  // it (the old, longer full command first). Kept SHORT, the place after the line that ran is past its end, and the batch ends there.
  if (platform === 'win32') return ['@echo off', `rem ${name}: the old name, ${SHIM_MARK}`, `call "%~dp0${file.split(/[\\/]/).pop()}" %*`, 'exit /b %errorlevel%', ''].join('\r\n');
  return sh([`# ${name}: the old name of this node's command, ${SHIM_MARK}`, `exec ${q(file)} "$@"`]);
}
/** A file of the command's names is ours to replace: missing, a link, or a script that runs one of our commands. */
const ours = (path) => {
  try { if (lstatSync(path).isSymbolicLink()) return true; const t = readFileSync(path, 'utf8'); return /(?:arenanode|bitcoinarena)\.mjs/.test(t) || t.includes(SHIM_MARK); } catch { return true; }
};
export function writeCommand({ home, release, node, platform = process.platform, env = process.env, run = null, pathDirs = null }) {
  const name = commandName(), oldName = legacyCommandName();
  const bin = join(home, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = join(release, 'packages', 'arena-installer', 'bin', 'bitcoinarena.mjs');
  const what = `The ${name} command, written by the installer: ${name} status, ${name} restart lnd, ${name} doctor, ${name} help`;
  if (platform === 'win32') {
    const file = join(bin, `${name}.cmd`);
    // REWRITTEN WHILE IT RUNS (kanban #1445, audit 8 O8-6): the auto update runs inside this file (the updater's loop CALLs it) and writes
    // it again here. cmd.exe reads a batch file by its place in the file: after node.exe returns it reads on from the old file's length in
    // the new one, and ran what was left there ("%*", "arena %*" after a longer release name) as a command - errorlevel 9009, and the
    // updater's loop ended. So the node line ends the batch itself (`& exit /b`: no number keeps node.exe's exit code, 75 for the loop) -
    // cmd.exe never reads the file again after it. A running command written before that (2026.1.9.27 and older) has no such end: while it
    // runs, the new text is kept no longer than it by a shorter comment, so the place after its last line is the new file's end.
    const nodeLine = `"${node}" "${script}" --home "${home}" --name ${name} %* & exit /b`;
    let rem = `rem ${what}`;
    let running = null; try { running = readFileSync(file); } catch { running = null; }
    if (running && !/ & exit \/b\r?\n?$/.test(running.toString('utf8'))) {
      const over = Buffer.byteLength(['@echo off', rem, nodeLine].join('\r\n') + '\r\n') - running.length;
      if (over > 0) rem = rem.slice(0, Math.max(3, rem.length - over));
    }
    writeFileSync(file, ['@echo off', rem, nodeLine].join('\r\n') + '\r\n');
    const oldFile = join(bin, `${oldName}.cmd`);
    if (ours(oldFile)) writeFileSync(oldFile, legacyShim({ name: oldName, file, platform }));
    const d = bin.replace(/'/g, "''");
    // `pathSet`: the PATH change, for the caller to await - measured in the Windows VM (rc.25 --update over ssh): not awaited, the
    // update's process ended first and Windows ended the PowerShell with its session, so the user PATH never got the folder
    const pathSet = run ? Promise.resolve(run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not (($p -split ';') -contains '${d}')) { [Environment]::SetEnvironmentVariable('Path', $(if ($p) { $p + ';${d}' } else { '${d}' }), 'User') }`])) : null;
    return { name, file, link: null, dir: bin, note: 'open a new console window to use it', pathSet, legacy: { name: oldName, file: oldFile, link: null } };
  }
  const file = join(bin, name);
  writeFileSync(file, sh([`# ${what}`, `exec ${q(node)} ${q(script)} --home ${q(home)} --name ${name} "$@"`]), { mode: 0o755 });
  chmodSync(file, 0o755);
  const oldFile = join(bin, oldName);
  const legacy = { name: oldName, file: oldFile, link: null };
  if (ours(oldFile)) { writeFileSync(oldFile, legacyShim({ name: oldName, file, platform }), { mode: 0o755 }); chmodSync(oldFile, 0o755); }
  // a link only into this user's own folders and, on a macOS, the PATH folders the user may write - never anywhere when the environment
  // names no home (a test's)
  const H = env.HOME;
  if (!H && !pathDirs) return { name, file, link: null, dir: null, note: `run it as ${file}`, legacy };
  const local = join(H || homedir(), '.local', 'bin');
  const dirs = pathDirs || (platform === 'darwin' && process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', local] : [local]);
  const linkTo = (d, n, f) => { const link = join(d, n); if (!ours(link)) return null; rmSync(link, { force: true }); symlinkSync(f, link); return link; };
  for (const d of dirs) {
    if (d === local) mkdirSync(d, { recursive: true });
    if (!existsSync(d) || !writable(d)) continue;
    const link = linkTo(d, name, file);
    if (!link) continue;
    // the old name beside it, in the same folder (a 1.9.7 node's link there points at <home>/bin/arenanode, which is the small script now)
    legacy.link = linkTo(d, oldName, oldFile);
    let note = null;
    if (!String(env.PATH || '').split(':').includes(d)) {
      const profile = join(H || homedir(), platform === 'darwin' ? '.zprofile' : '.profile');
      let text = ''; try { text = readFileSync(profile, 'utf8'); } catch { text = ''; }
      if (!text.includes(d) && !(platform === 'linux' && text.includes('$HOME/.local/bin'))) appendFileSync(profile, `\n# the bitcoinarena command (Bitcoin Arena node)\nexport PATH="${d}:$PATH"\n`);
      note = `open a new terminal to use it (${d} goes on the PATH at login)`;
    }
    return { name, file, link, dir: d, note, legacy };
  }
  return { name, file, link: null, dir: null, note: `run it as ${file}`, legacy };
}

/**
 * A NODE MOVED HERE BY THE UPDATE CODE OF 2026.1.9.7 OR OLDER (kanban #688): that code wrote only <home>/bin/arenanode, as the full command
 * naming this release's bin/arenanode.mjs - so bitcoinarena is not there yet. Is the old name's file such a command, of `release`? The
 * first run of this release's command then writes both (bin/bitcoinarena.mjs, ensureCommand) - the auto update service, which runs
 * through <home>/bin/arenanode, starts again within seconds of the update and does it.
 */
export function commandBehind({ home, release, platform = process.platform }) {
  const ext = platform === 'win32' ? '.cmd' : '';
  let t;
  try { t = readFileSync(join(home, 'bin', `${legacyCommandName()}${ext}`), 'utf8'); } catch { return false; }
  if (t.includes(SHIM_MARK)) return false;
  const slashes = (x) => String(x).replace(/\\/g, '/');
  return /arenanode\.mjs/.test(t) && slashes(t).includes(slashes(release));
}
/** The command written when commandBehind says so: { written: writeCommand's answer }, { why } or null. Never throws: the command runs either way. */
export function ensureCommand({ home, release, node = process.execPath, platform = process.platform, env = process.env }) {
  try { return commandBehind({ home, release, platform }) ? { written: writeCommand({ home, release, node, platform, env, run: null }) } : null; } catch (e) { return { why: e.message }; }
}

/**
 * THE AUTO UPDATE SERVICE: `<home>/bin/bitcoinarena auto-update` as a service of this node (a node installed before 2026.1.9.8: its
 * <home>/bin/arenanode, which runs bitcoinarena since) - its command names the node's own command, not a release, so an update moves everything else and never stops it mid-way; it ends with 75 after an update and comes
 * back from the new release (systemd Restart=on-failure, launchd KeepAlive, the Windows launcher's loop). Answers installProgram's answer.
 */
/** A Windows updater launcher written before it CALLed its batch file (2026-10-19): its exit-75 loop never ran - written again. */
export function updaterLauncherStale(file, platform = process.platform) {
  if (platform !== 'win32') return false;
  try { const t = readFileSync(file, 'utf8'); return /\.cmd" "auto-update"/.test(t) && !/^call "/m.test(t); } catch { return false; }
}
export function installUpdater({ home, installProgram, platform = process.platform, env = process.env, sh = undefined, boot = true }) {
  const cmd = join(home, 'bin', platform === 'win32' ? `${commandName()}.cmd` : commandName());
  return installProgram({ id: 'updater', description: 'Bitcoin Arena: automatic updates', args: [cmd, 'auto-update'], home, boot, platform, env, againOn: 75, ...(sh ? { sh } : {}) });
}
