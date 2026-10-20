// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN EXISTING NODE UPDATED IN PLACE (slice 3; 2026-10-18: "also supports updating an existing node that
// applies, updates and supports existing settings and doesn't break it").
//
//   1. the install is found (its home: state.json, node.env, node.db) and the running release read from its unit;
//   2. the new asset is checked: SHA256SUMS signed by the Arena release key, the asset's line in it (release-verify.js);
//   3. it is unpacked beside the old release (releases/<version>), never over it;
//   4. never inside a market seating window (minutes 11-14 of a quarter hour), the node is stopped and BACKED UP - its database
//      (and WAL), settings, state, seed and owner binding - into backups/<time>/;
//   5. the units are written for the new release with the SAME settings file (nothing the user set changes; only its paths into an
//      older release - games, custody binaries - follow to the new one, envForRelease), and started;
//   6. it must answer healthy as the same node (GET /identity, the same key) - else the old units and the backup are put back,
//      the old release started, and the update said refused, with why.
// A data migration is the seat's own: openStore migrates its database on start (store.js), and the backup is what a failed one
// is rolled back from.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { checkAsset } from './release-verify.js';
import { seatUnit, bridgeUnit, unitDir, UNIT, BRIDGE_UNIT, TUNNEL_UNIT, waitHealthy, launchdPlist, LAUNCHD_LABEL, windowsLauncher } from './service.js';
import { adhocSign } from './tor.js';
import { INSTANCE, PORT_OFFSET } from './instance.js';
import { envToConfValues, formatConf } from '../../arena-node/src/arena-conf.js';
import { writeCommand } from './launchers.js';
import { control } from './node-services.js';
import { quickTunnelUrl } from './reach.js';
import { gatewayMetricsOwn } from './gateway.js';

/** Files that are the node: kept across an update, backed up before it. */
export const NODE_FILES = Object.freeze(['node.db', 'node.db-wal', 'node.db-shm', 'arena.conf', 'node.env', 'state.json', 'seed.hex', 'node.db.owner.json',
  'node.db.operator-tokens.json', 'bitcoind.auth', 'cloudflared.yml']);

/** Is it inside a market seating window now (minutes 11-14 of a quarter hour)? The update waits it out. */
export const inSeatingWindow = (nowMs = Date.now()) => { const q = Math.floor(nowMs / 1000) % 900; return q >= 660 && q < 840; };

/** The release a unit file runs: its WorkingDirectory less packages/arena-node. */
export function releaseOfUnit(text) {
  const m = /^WorkingDirectory=(.+)\/packages\/arena-node$/m.exec(String(text || ''));
  return m ? m[1] : null;
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 120000 }, (e, out, err) => resolve({ ok: !e, out: String(out), err: String(err) })));

/** node.env's paths into a release - the games, the custody binaries - moved to the new release, from EVERY older one, not only the
 *  release the seat ran (macOS node A at rc.16 still read its games and fedimintd from the rc.12 folder it was installed from); a path
 *  the new release does not hold is kept. */
export function envForRelease(text, newRelease, exists = existsSync) {
  return String(text).split('\n').map((line) => {
    const cr = line.endsWith('\r') ? '\r' : '';   // a Windows node's settings end their lines in CRLF
    const m = /^([A-Za-z0-9_]+)=(.*[\\/]arena-node-\d[^\\/\s]*)([\\/].*)?$/.exec(cr ? line.slice(0, -1) : line);
    if (!m || m[2] === newRelease) return line;
    const moved = newRelease + (m[3] || '');
    return exists(moved) ? `${m[1]}=${moved}${cr}` : line;
  }).join('\n');
}

/**
 * THE PEER PORTS OF AN OLDER INSTALL ON THIS MACHINE ONLY (the Windows VM 2026-10-19: Windows Firewall asked to open bitcoind
 * and lnd to public networks). What a new install writes (bitcoind.js, lnd.js), applied to the node's own files when they still have the
 * old default: the node's Bitcoin Core gets bind=127.0.0.1:<its port> when it names no bind; LND behind Tor (and no outside address)
 * listens on 127.0.0.1 instead of 0.0.0.0. Answers the services whose settings changed ('bitcoind-<network>', 'lnd'), to restart.
 */
export function peerPortsLocal(home) {
  const changed = [];
  for (const net of ['testnet4', 'mainnet']) {
    const f = join(home, `bitcoin-${net}`, 'bitcoin.conf');
    if (!existsSync(f)) continue;
    const t = readFileSync(f, 'utf8');
    if (/^bind=/m.test(t) || !/^port=\d+\r?$/m.test(t)) continue;
    writeFileSync(f, t.replace(/^port=(\d+)(\r?)$/m, 'port=$1$2\nbind=127.0.0.1:$1$2'));
    changed.push(`bitcoind-${net}`);
  }
  const l = join(home, 'lnd', 'lnd.conf');
  if (existsSync(l)) {
    const t = readFileSync(l, 'utf8');
    if (/^tor\.active=true\r?$/m.test(t) && !/^externalip=/m.test(t) && /^listen=0\.0\.0\.0:/m.test(t)) {
      writeFileSync(l, t.replace(/^listen=0\.0\.0\.0:/m, 'listen=127.0.0.1:'), { mode: 0o600 });
      changed.push('lnd');
    }
  }
  return changed;
}

/** Copy the node's files into backups/<stamp>/: { dir, files }. */
export function backupNode(home, stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  const dir = join(home, 'backups', stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const f of NODE_FILES) if (existsSync(join(home, f))) { copyFileSync(join(home, f), join(dir, f)); files.push(f); }
  return { dir, files };
}
/** Put a backup's files back (the database first). A file Windows still holds (EBUSY / EPERM / EACCES: the stopped seat's handle not
 *  closed yet) is tried again each second for a while; one that never frees is named, and the others still go back. { ok, failed } */
export async function restoreNode(home, backup, { tries = 30, pause = (ms) => new Promise((ok) => setTimeout(ok, ms)), copy = copyFileSync } = {}) {
  const failed = [];
  for (const f of backup.files) {
    for (let i = 0; ; i++) {
      try { copy(join(backup.dir, f), join(home, f)); break; } catch (e) {
        if (i + 1 >= tries || !['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) { failed.push(`${f}: ${e.code || e.message}`); break; }
        await pause(1000);
      }
    }
  }
  return { ok: !failed.length, failed };
}

/** The release a launchd agent runs: its WorkingDirectory less packages/arena-node. */
export function releaseOfPlist(text) {
  const m = /<key>WorkingDirectory<\/key><string>(.+?)\/packages\/arena-node<\/string>/.exec(String(text || ''));
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null;
}

/** The release a Windows launcher runs: its `cd /d "<release>\packages\arena-node"`. */
export function releaseOfLauncher(text) {
  const m = /^cd \/d "(.+)\\packages\\arena-node"\r?$/m.exec(String(text || ''));
  return m ? m[1] : null;
}

/**
 * THE NODE'S SERVICES, PER SYSTEM (measured on the test host, rc.12 -> rc.13: "Not updated: no arena-node unit names a release
 * (~/.config/systemd/user/arena-node.service)" - the updater knew only systemd). Linux: the user's systemd units (arena-*.service);
 * macOS: the user's launchd agents (io.bitcoin-arena.node*.plist); Windows: the launchers in the node's home (arena-*.cmd). The seat's definition is written fresh for the new release; every
 * other service of the node that names the old release (the bridge, the tunnel's cloudflared, tor, the gateway, the liquidity
 * provider) is moved to the new one - before, only the seat and the bridge moved and the rest kept running the old release.
 */
function servicesOf({ platform, env, sh, home, port, node, selfPid = process.pid, pause = (ms) => new Promise((ok) => setTimeout(ok, ms)) }) {
  if (platform === 'darwin') {
    const dir = join(env.HOME || homedir(), 'Library', 'LaunchAgents');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const seatFile = join(dir, `${LAUNCHD_LABEL}.plist`);
    const files = () => (existsSync(dir) ? readdirSync(dir) : []).filter((f) => f === `${LAUNCHD_LABEL}.plist` || (f.startsWith(`${LAUNCHD_LABEL}.`) && f.endsWith('.plist'))).map((f) => join(dir, f));
    const label = (f) => f.split('/').pop().replace(/\.plist$/, '');
    return {
      where: seatFile, seatText: () => (existsSync(seatFile) ? readFileSync(seatFile, 'utf8') : null), releaseOf: releaseOfPlist, files,
      seatFor: (release, old) => launchdPlist({ node, release, home, port, boot: !/<key>RunAtLoad<\/key><false\/>/.test(old) }), seatFile,
      stop: async (fs) => { for (const f of fs) await sh('launchctl', ['bootout', `gui/${uid}/${label(f)}`]); return { ok: true }; },
      // every agent, each tried up to 5 times a second apart: launchd refuses a bootstrap while the agent it just booted out is
      // still unloading (measured on the test host, rc.12 -> rc.13: tor's bootstrap failed, the loop stopped, and the tunnel was never
      // started - both came up at once by hand)
      start: async (fs) => {
        const failed = [];
        for (const f of fs) {
          let r = { ok: false };
          for (let i = 0; i < 5 && !r.ok; i++) { if (i) await pause(1000); r = await sh('launchctl', ['bootstrap', `gui/${uid}`, f]); }
          if (!r.ok) failed.push(`${label(f)}: ${(r.err || r.out || '').trim().slice(0, 120)}`);
        }
        return failed.length ? { ok: false, why: `launchctl bootstrap failed for ${failed.join('; ')}` } : { ok: true };
      },
      // the new release's own tor is unsigned until this macOS signs it (tor.js adhocSign; the wizard does it at install)
      prepare: async (release) => { const t = join(release, 'runtime', 'tor'); if (existsSync(t)) await adhocSign(t, { run: async (c, a) => (await sh(c, a)).ok }); },
    };
  }
  if (platform === 'win32') {
    // WINDOWS: the launchers beside the node's home (arena-node.cmd, arena-tunnel.cmd, arena-<id>.cmd), each started at logon by a
    // scheduled task or the Startup folder (service.js windowsAutostart). Every program runs the release's own runtime (node.exe,
    // tor.exe, cloudflared.exe), so stopping a release is ending the processes whose command line names it, and its tasks.
    const seatFile = join(home, 'arena-node.cmd');
    const files = () => readdirSync(home).filter((f) => /^arena-.*\.cmd$/.test(f)).map((f) => join(home, f));
    const task = (f) => { const id = f.split(/[\\/]/).pop().replace(/^arena-|\.cmd$/g, ''); return id === 'node' ? 'Arena node' : id === 'tunnel' ? 'Arena node tunnel' : `Arena ${id}`; };
    const ps = (script) => sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const q = (t) => String(t).replace(/'/g, "''");
    return {
      where: seatFile, seatText: () => (existsSync(seatFile) ? readFileSync(seatFile, 'utf8') : null), releaseOf: releaseOfLauncher, files,
      seatFor: (release) => windowsLauncher({ node, release, home, port }), seatFile,
      stop: async (fs, release) => {
        for (const f of fs) await sh('schtasks', ['/end', '/tn', task(f)]);
        // every process of that release but the auto update that runs this update: it ends by itself when done
        // BY THE RELEASE'S FOLDER, ANY SLASHES (measured 2026-10-19 22:43Z in the Windows VM: the node ran as "...\\.arena-node/releases/
        // arena-node-2026.1.0-windows-x64/runtime/node.exe", the release was named with backslashes, -like matched nothing, the old node
        // kept its port, the new one could not start, and the old one answered the health check - a false "updated")
        const folder = String(release).split(/[\\/]/).filter(Boolean).pop();
        const r = await ps(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\\') -like '*\\${q(folder)}\\*' -and $_.ProcessId -ne ${Number(selfPid)} -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
        return r.ok ? { ok: true } : { ok: false, why: `the node did not stop: ${(r.err || '').trim().slice(0, 200)}` };
      },
      // THE PROCESSES STILL RUNNING FROM `folders` (kanban #546): [{ pid, name, commandLine }] - every one whose command line names one of
      // those release folders (any slashes), but this update's own process (`selfPid`: an auto update exits 75 by itself, and its loop
      // starts the new release's). Asked after the stop and again after the start: no process of an older release may be left - an
      // updater of the old release beside a manual update included (measured 2026-10-20 04:30Z in the Windows VM: after T1 by hand,
      // the updater's child still ran 2026.1.1, and would have updated with the old update.js).
      leftovers: async (folders) => {
        const names = [...new Set((folders || []).map((x) => String(x).split(/[\\/]/).filter(Boolean).pop()).filter(Boolean))];
        if (!names.length) return [];
        const like = names.map((n) => `$c -like '*\\${q(n)}\\*'`).join(' -or ');
        const r = await ps(`@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ProcessId -ne $PID -and $_.ProcessId -ne ${Number(selfPid)} } | ForEach-Object { $c = $_.CommandLine.Replace('/', '\\'); if (${like}) { [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; commandLine = $_.CommandLine } } }) | ConvertTo-Json -Compress`);
        if (!r.ok) return [{ pid: null, name: '?', commandLine: `the process list could not be read: ${(r.err || '').trim().slice(0, 160)}` }];
        const t = String(r.out || '').trim();
        if (!t || t === 'null') return [];
        try { const j = JSON.parse(t); return (Array.isArray(j) ? j : [j]).map((x) => ({ pid: x.pid, name: x.name, commandLine: x.commandLine })); } catch { return []; }
      },
      // THE UPDATER COMES BACK (kanban #546): its child was ended with the old release (a manual update), so its loop ended with it - the
      // task "Arena updater" is run again (schtasks /run; the launcher through WMI where no task exists). Not when an auto update runs
      // (this update's own process among them: it exits 75 and its loop starts the new release's).
      updater: async () => {
        const f = join(home, 'arena-updater.cmd');
        if (!existsSync(f)) return { ok: true, none: true };
        const r = await ps(`@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*auto-update*' -and $_.ProcessId -ne $PID }).Count`);
        if (r.ok && Number(String(r.out || '').trim()) > 0) return { ok: true, running: true };
        const t = await sh('schtasks', ['/run', '/tn', task(f)]);
        if (t.ok) return { ok: true, started: 'task', task: task(f) };
        const w = await ps(`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "${q(f)}"'; CurrentDirectory = '${q(home)}' }; if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create: $($r.ReturnValue)" }`);
        return w.ok ? { ok: true, started: 'launcher' } : { ok: false, why: `the updater was not started again: ${(w.err || t.err || '').trim().slice(0, 160)}` };
      },
      end: async (pids) => { for (const pid of pids.filter((x) => Number.isInteger(x))) await ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`); },
      start: async (fs) => {
        const failed = [];
        // THROUGH WMI (Win32_Process.Create), NOT Start-Process (measured in the Windows VM 2026-10-18): a process the update starts must not
        // belong to the session that runs it - an update over ssh, or from a console window closed afterwards, would end its services with it
        for (const f of fs) {
          const r = await ps(`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c "${q(f)}"'; CurrentDirectory = '${q(home)}' }; if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create: $($r.ReturnValue)" }`);
          if (!r.ok) failed.push(`${task(f)}: ${(r.err || '').trim().slice(0, 120)}`);
        }
        return failed.length ? { ok: false, why: `not started: ${failed.join('; ')}` } : { ok: true };
      },
      prepare: async () => {},
    };
  }
  const dir = unitDir(env);
  const seatFile = join(dir, UNIT);
  // this node's units only: another node on the machine (instance.js) names its own with a --<instance> suffix
  const mine = (f) => /^arena-.*\.service$/.test(f) && (INSTANCE ? f.endsWith(`--${INSTANCE}.service`) : !f.includes('--'));
  const files = () => (existsSync(dir) ? readdirSync(dir) : []).filter(mine).map((f) => join(dir, f));
  const unit = (f) => f.split('/').pop();
  return {
    where: seatFile, seatText: () => (existsSync(seatFile) ? readFileSync(seatFile, 'utf8') : null), releaseOf: releaseOfUnit, files,
    seatFor: (release) => seatUnit({ node, release, home, port }), seatFile,
    bridgeFor: (release, state) => bridgeUnit({ node, release, home, bridgePort: state.bridgePort || 8471 }),
    stop: async (fs) => { const r = await sh('systemctl', ['--user', 'stop', ...fs.map(unit)]); return r.ok ? { ok: true } : { ok: false, why: `the node did not stop: ${r.err.trim().slice(0, 200)}` }; },
    start: async (fs) => { await sh('systemctl', ['--user', 'daemon-reload']); const r = await sh('systemctl', ['--user', 'start', ...fs.map(unit)]); return r.ok ? { ok: true } : { ok: false, why: (r.err || '').trim().slice(0, 200) }; },
    prepare: async () => {},
  };
}

/** A release's own VERSION and COMMIT (tools/release/build-release.sh writes them at its root), or nulls for a tree without them. */
export function releaseIdOf(dir) {
  const read = (f) => { try { return readFileSync(join(dir, f), 'utf8').trim() || null; } catch { return null; } };
  return { version: read('VERSION'), commit: read('COMMIT') };
}

/**
 * THE NEW RELEASE ANSWERS AS ITSELF (kanban #546, measured 2026-10-19 in the Windows VM: the old node kept running, answered GET /identity
 * with the same key, and the update reported ok): GET /owner/version must name `want`'s version AND commit. Polled until `waitMs`;
 * answers { ok, version, commit, why }.
 */
export async function versionAnswers({ port, fetcher = fetch, want, waitMs = 90000, everyMs = 2000, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)) }) {
  const until = Date.now() + waitMs;
  let last = { version: null, commit: null, why: 'GET /owner/version did not answer' };
  do {
    try {
      const r = await fetcher(`http://127.0.0.1:${port}/owner/version`, { signal: AbortSignal.timeout(5000) });
      if (r.status === 200) {
        const j = await r.json();
        last = { version: j.version ?? null, commit: j.commit ?? null };
        if (last.version === want.version && last.commit === want.commit) return { ok: true, ...last };
        last.why = `the node answering runs ${last.version || 'no release'} (${String(last.commit || '-').slice(0, 12)}), not ${want.version} (${String(want.commit).slice(0, 12)})`;
      }
    } catch (e) { last.why = `GET /owner/version: ${e.message}`; }
    if (Date.now() >= until) break;
    await sleep(everyMs);
  } while (Date.now() < until);
  return { ok: false, ...last };
}

/**
 * Update the node at `home` to the release unpacked at `newRelease`. `asset` / `sums` / `sig` are checked first when given (an
 * unpacked tree from a test is passed without them). Injectables: `sh` (systemctl / launchctl), `fetcher`, `nowMs`, `wait` (the
 * seating-window wait), `platform`. Answers { ok, from, to, backup, why, rolledBack, moved }.
 */
export async function updateNode({ home, newRelease, port, node = process.execPath, asset = null, sums = null, sig = null, env = process.env, sh = run,
  fetcher = fetch, nowMs = () => Date.now(), waitMs = null, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), platform = process.platform,
  quickUrl = quickTunnelUrl, restartService = (id, o) => control('restart', id, o), installUpdaterFn = null }) {
  // A WINDOWS SEAT STARTS SLOWER (measured in the Windows VM 2026-10-18, rc.14 -> rc.20: the seat logged "[games] hosting nextblock",
  // its last start-up line, at 23:24:36 - the 90 s wait had ended at 23:24:41 and rolled a sound release back): five minutes there
  waitMs = waitMs ?? (platform === 'win32' ? 300000 : 90000);
  if (asset) {
    const c = checkAsset({ file: asset, sums, sig });
    if (!c.ok) return { ok: false, why: c.why };
  }
  if (!existsSync(join(home, 'state.json')) || !(existsSync(join(home, 'arena.conf')) || existsSync(join(home, 'node.env')))) return { ok: false, why: `no node is installed at ${home}` };
  const svc = servicesOf({ platform, env, sh, home, port, node });
  const oldSeat = svc.seatText();
  const from = svc.releaseOf(oldSeat);
  if (!from) return { ok: false, why: `no arena-node service names a release (${svc.where})` };
  if (from === newRelease) return { ok: false, why: 'that release is the one running' };
  const before = await waitHealthy({ port, fetcher, waitMs: 10000, everyMs: 500 });
  // the node's services that run from the old release: the seat, and every other one naming it - or naming an OLDER release beside it
  // (measured 2026-10-19 in the Windows VM: arena-custody.cmd still named rc.25 after updates to 0.1.1, 2026.1.0 and 2026.1.1 - each update
  // moved only the launchers naming the release it updated from, so the custody agent, its guardian and gateway stayed on rc.25)
  const releasesDir = from.replace(/[\\/][^\\/]+[\\/]?$/, '');
  const olderRe = new RegExp(`${releasesDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]arena-node-[^\\\\/"'\\s]+`, 'g');
  const oldersIn = (t) => [...new Set(t.match(olderRe) || [])].filter((x) => x !== from && x !== newRelease && !String(newRelease).startsWith(x));
  const moving = svc.files().filter((f) => { const t = readFileSync(f, 'utf8'); return f === svc.seatFile || t.includes(from) || oldersIn(t).length > 0; });
  const oldTexts = new Map(moving.map((f) => [f, readFileSync(f, 'utf8')]));

  while (inSeatingWindow(nowMs())) await sleep(5000);
  await svc.prepare(newRelease);
  const stop = await svc.stop(moving, from);
  if (!stop.ok) return { ok: false, why: stop.why };
  // and the processes of those older releases (Windows ends a release's processes by its folder; elsewhere the units above stop them)
  const olders = [...new Set(moving.flatMap((f) => oldersIn(oldTexts.get(f))))];
  if (platform === 'win32') for (const o of olders) await svc.stop([], o);
  // NOTHING OF AN OLDER RELEASE STILL RUNS (kanban #546): after the stop the process list is asked; a leftover is ended and named
  const oldFolders = [from, ...olders];
  const leftAfterStop = svc.leftovers ? await svc.leftovers(oldFolders) : [];
  if (leftAfterStop.length && svc.end) await svc.end(leftAfterStop.map((x) => x.pid));
  const backup = backupNode(home);
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
  // THE SETTINGS: arena.conf, its paths into an older release moved to the new one. A node from before it ran from
  // node.env: its settings are moved into arena.conf here, once (node.env stays until the new release answers, then is kept as
  // node.env.migrated; a rollback takes arena.conf away again and the old release reads node.env as before)
  const envFile = join(home, 'node.env');
  const confFile = join(home, 'arena.conf');
  const migrating = !existsSync(confFile);
  if (migrating) {
    const values = { network: state.network || 'testnet4', ...envToConfValues(envForRelease(readFileSync(envFile, 'utf8'), newRelease), { port, database: join(home, 'node.db') }) };
    if (INSTANCE && !values.instance) values.instance = INSTANCE;
    if (PORT_OFFSET && !values.port_offset) values.port_offset = String(PORT_OFFSET);
    writeFileSync(confFile, formatConf(values, { eol: platform === 'win32' ? '\r\n' : '\n', header: 'moved from node.env by an update' }), { mode: 0o600 });
  } else {
    const confText = readFileSync(confFile, 'utf8');
    const confNew = envForRelease(confText, newRelease);
    if (confNew !== confText) writeFileSync(confFile, confNew, { mode: 0o600 });
  }
  for (const f of moving) {
    const text = f === svc.seatFile ? svc.seatFor(newRelease, oldTexts.get(f))
      : svc.bridgeFor && f.endsWith(BRIDGE_UNIT) ? svc.bridgeFor(newRelease, state)
        : oldersIn(oldTexts.get(f)).reduce((t, o) => t.split(o).join(newRelease), oldTexts.get(f).split(from).join(newRelease));
    // the gateway of an older install gets its own metrics port (gateway.js: by itself it took the liquidity provider's)
    writeFileSync(f, /gateway/.test(f.split(/[\\/]/).pop()) ? gatewayMetricsOwn(text) : text);
  }
  // A QUICK TUNNEL COMES BACK UNDER A NEW NAME (measured on the test host, node A rc.16 -> rc.18: the tunnel restarted as
  // cult-turns-….trycloudflare.com while node.env still named conventional-cube-…, so the node's public address, its guardian endpoint
  // and the advert its bond posts named a host that no longer answers). The tunnel starts first, its new name is read from its log,
  // the settings take the new host, and only then the seat starts - no second restart (on Windows stopping one launcher ends them all).
  const isTunnel = (f) => { const b = f.split(/[\\/]/).pop(); return b === TUNNEL_UNIT || b === `${LAUNCHD_LABEL}.tunnel.plist` || b === 'arena-tunnel.cmd'; };
  const tunnels = state.reach && state.reach.mode === 'quick' && state.reach.url ? moving.filter(isTunnel) : [];
  let reachUrl = null, tunnelStarted = { ok: true };
  if (tunnels.length) {
    const startAt = Date.now();
    tunnelStarted = await svc.start(tunnels);
    const url = await quickUrl({ unit: TUNNEL_UNIT, home, platform, sh, sinceMs: startAt });
    if (url && url !== state.reach.url) {
      const oldHost = new URL(state.reach.url).host, newHost = new URL(url).host;
      writeFileSync(confFile, readFileSync(confFile, 'utf8').split(oldHost).join(newHost), { mode: 0o600 });
      // and every service started after it that names the host - the gateway's --api-addr above all (measured in the Windows VM, 0.1.0 ->
      // 0.1.1: arena.conf took the new name, arena-gateway.cmd kept the old one, and the gateway announced a host that no longer answers)
      for (const f of moving) {
        if (tunnels.includes(f)) continue;
        const t = readFileSync(f, 'utf8');
        if (t.includes(oldHost)) writeFileSync(f, t.split(oldHost).join(newHost));
      }
      reachUrl = url;
    }
  }
  const rest = await svc.start(moving.filter((f) => !tunnels.includes(f)));
  const started = !tunnelStarted.ok ? tunnelStarted : rest;
  const after = await waitHealthy({ port, fetcher, waitMs });
  const sameKey = after.ok && (!before.ok || after.identity === before.identity);
  // THE NEW RELEASE, NOT THE OLD PROCESS (kanban #546): a release that names its version must answer with it and its commit
  const want = releaseIdOf(newRelease);
  const answered = sameKey && want.version ? await versionAnswers({ port, fetcher, want, waitMs: Math.min(waitMs, 120000) }) : { ok: sameKey };
  // and no process of an older release left after the start: ended and named, and if one will not end, no update
  let leftAfterStart = sameKey && answered.ok && svc.leftovers ? await svc.leftovers(oldFolders) : [];
  if (leftAfterStart.length && svc.end) { await svc.end(leftAfterStart.map((x) => x.pid)); await sleep(3000); }
  const stillLeft = leftAfterStart.length && svc.leftovers ? await svc.leftovers(oldFolders) : [];
  const same = sameKey && answered.ok && !stillLeft.length;
  if (same) {
    writeFileSync(join(home, 'state.json'), JSON.stringify({ ...state, ...(reachUrl ? { reach: { ...state.reach, url: reachUrl } } : {}),
      release: { path: newRelease, from, atMs: nowMs() } }, null, 2) + '\n', { mode: 0o600 });
    if (migrating && existsSync(envFile)) renameSync(envFile, `${envFile}.migrated`);
    // the peer ports on this machine only, for a node installed before that was the default; those services restarted to take it
    let local = [];
    try {
      local = peerPortsLocal(home);
      for (const id of local) await restartService(id, { home, platform, env, sh });
    } catch (e) { local = [`not changed: ${e.message}`]; }
    // THE AUTO UPDATE SERVICE for a node installed before it, once
    let updater = null;
    if (installUpdaterFn) {
      try { updater = await installUpdaterFn({ home, platform, env, sh }); } catch (e) { updater = { ok: false, why: e.message }; }
    }
    // the arenanode command runs the new release from now on
    let command = null;
    try {
      command = writeCommand({ home, release: newRelease, node, platform, env, run: sh });
      if (command.pathSet) { const r = await command.pathSet; delete command.pathSet; if (r && r.ok === false) command.why = `the user PATH was not changed: ${(r.err || r.out || '').trim().slice(0, 160)}`; }
    } catch (e) { command = { why: e.message }; }
    // and on Windows the updater running again - after the arenanode command names the new release, which its loop CALLs (kanban #546)
    let updaterBack = null;
    if (svc.updater) { try { updaterBack = await svc.updater(); } catch (e) { updaterBack = { ok: false, why: e.message }; } }
    return { ok: true, from, to: newRelease, backup: backup.dir, identity: after.identity, moved: moving.map((f) => f.split('/').pop()), command, migrated: migrating, peerPortsLocal: local, updater,
      ...(want.version ? { answered: { version: answered.version, commit: answered.commit } } : {}), ...(updaterBack ? { updaterBack } : {}),
      ...(leftAfterStop.length ? { endedAfterStop: leftAfterStop } : {}), ...(leftAfterStart.length ? { endedAfterStart: leftAfterStart } : {}),
      ...(reachUrl ? { reach: reachUrl } : {}), ...(started.ok ? {} : { notStarted: started.why }) };
  }
  // ROLLED BACK: the old services, the backup, the old release started - started whatever the restore says (measured in the Windows
  // VM: copying the backup back threw while the stopped seat still held its database, and the node was left with nothing running)
  try { await svc.stop(moving, newRelease); } catch { /* the start below is what matters */ }
  for (const [f, t] of oldTexts) writeFileSync(f, t);
  if (migrating) rmSync(confFile, { force: true });
  let put = { ok: false, failed: ['not tried'] };
  try { put = await restoreNode(home, backup, { pause: sleep }); } catch (e) { put = { ok: false, failed: [e.message] }; }
  await svc.start(moving);
  const back = await waitHealthy({ port, fetcher, waitMs });
  return { ok: false, rolledBack: true, from, to: newRelease, backup: backup.dir,
    why: !after.ok ? `the new release did not come up: ${after.why}`
      : !sameKey ? `the new release answered as another node (${after.identity.slice(0, 16)}), not ${before.identity.slice(0, 16)}`
        : !answered.ok ? (answered.version && answered.version === releaseIdOf(from).version ? `the old release still answers (${answered.version}): ${answered.why}` : answered.why)
          : `processes of an older release would not end: ${stillLeft.map((x) => `${x.name} ${x.pid}`).join(', ')}`,
    restored: back.ok, ...(put.ok ? {} : { notRestored: put.failed }) };
}
