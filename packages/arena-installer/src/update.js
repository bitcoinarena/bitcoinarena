// AN EXISTING NODE UPDATED IN PLACE (kanban #471 part E, slice 3; the owner 2026-10-18: "also supports updating an existing node that
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
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { checkAsset } from './release-verify.js';
import { seatUnit, bridgeUnit, unitDir, UNIT, BRIDGE_UNIT, TUNNEL_UNIT, waitHealthy, launchdPlist, LAUNCHD_LABEL, windowsLauncher } from './service.js';
import { adhocSign } from './tor.js';
import { INSTANCE } from './instance.js';

/** Files that are the node: kept across an update, backed up before it. */
export const NODE_FILES = Object.freeze(['node.db', 'node.db-wal', 'node.db-shm', 'node.env', 'state.json', 'seed.hex', 'node.db.owner.json',
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

/** Copy the node's files into backups/<stamp>/: { dir, files }. */
export function backupNode(home, stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  const dir = join(home, 'backups', stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = [];
  for (const f of NODE_FILES) if (existsSync(join(home, f))) { copyFileSync(join(home, f), join(dir, f)); files.push(f); }
  return { dir, files };
}
/** Put a backup's files back (the database first). */
export function restoreNode(home, backup) {
  for (const f of backup.files) copyFileSync(join(backup.dir, f), join(home, f));
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
function servicesOf({ platform, env, sh, home, port, node, pause = (ms) => new Promise((ok) => setTimeout(ok, ms)) }) {
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
        const r = await ps(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${q(release)}*' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
        return r.ok ? { ok: true } : { ok: false, why: `the node did not stop: ${(r.err || '').trim().slice(0, 200)}` };
      },
      start: async (fs) => {
        const failed = [];
        for (const f of fs) { const r = await ps(`Start-Process -WindowStyle Hidden -FilePath '${q(f)}'`); if (!r.ok) failed.push(`${task(f)}: ${(r.err || '').trim().slice(0, 120)}`); }
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

/**
 * Update the node at `home` to the release unpacked at `newRelease`. `asset` / `sums` / `sig` are checked first when given (an
 * unpacked tree from a test is passed without them). Injectables: `sh` (systemctl / launchctl), `fetcher`, `nowMs`, `wait` (the
 * seating-window wait), `platform`. Answers { ok, from, to, backup, why, rolledBack, moved }.
 */
export async function updateNode({ home, newRelease, port, node = process.execPath, asset = null, sums = null, sig = null, env = process.env, sh = run,
  fetcher = fetch, nowMs = () => Date.now(), waitMs = 90000, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), platform = process.platform }) {
  if (asset) {
    const c = checkAsset({ file: asset, sums, sig });
    if (!c.ok) return { ok: false, why: c.why };
  }
  if (!existsSync(join(home, 'state.json')) || !existsSync(join(home, 'node.env'))) return { ok: false, why: `no node is installed at ${home}` };
  const svc = servicesOf({ platform, env, sh, home, port, node });
  const oldSeat = svc.seatText();
  const from = svc.releaseOf(oldSeat);
  if (!from) return { ok: false, why: `no arena-node service names a release (${svc.where})` };
  if (from === newRelease) return { ok: false, why: 'that release is the one running' };
  const before = await waitHealthy({ port, fetcher, waitMs: 10000, everyMs: 500 });
  // the node's services that run from the old release: the seat, and every other one naming it
  const moving = svc.files().filter((f) => f === svc.seatFile || readFileSync(f, 'utf8').includes(from));
  const oldTexts = new Map(moving.map((f) => [f, readFileSync(f, 'utf8')]));

  while (inSeatingWindow(nowMs())) await sleep(5000);
  await svc.prepare(newRelease);
  const stop = await svc.stop(moving, from);
  if (!stop.ok) return { ok: false, why: stop.why };
  const backup = backupNode(home);
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
  const envFile = join(home, 'node.env');
  const envText = readFileSync(envFile, 'utf8');
  const envNew = envForRelease(envText, newRelease);
  if (envNew !== envText) writeFileSync(envFile, envNew, { mode: 0o600 });
  for (const f of moving) {
    const text = f === svc.seatFile ? svc.seatFor(newRelease, oldTexts.get(f))
      : svc.bridgeFor && f.endsWith(BRIDGE_UNIT) ? svc.bridgeFor(newRelease, state)
        : oldTexts.get(f).split(from).join(newRelease);
    writeFileSync(f, text);
  }
  const started = await svc.start(moving);
  const after = await waitHealthy({ port, fetcher, waitMs });
  const same = after.ok && (!before.ok || after.identity === before.identity);
  if (same) {
    writeFileSync(join(home, 'state.json'), JSON.stringify({ ...state, release: { path: newRelease, from, atMs: nowMs() } }, null, 2) + '\n', { mode: 0o600 });
    return { ok: true, from, to: newRelease, backup: backup.dir, identity: after.identity, moved: moving.map((f) => f.split('/').pop()), ...(started.ok ? {} : { notStarted: started.why }) };
  }
  // ROLLED BACK: the old services, the backup, the old release started
  await svc.stop(moving, newRelease);
  for (const [f, t] of oldTexts) writeFileSync(f, t);
  restoreNode(home, backup);
  await svc.start(moving);
  const back = await waitHealthy({ port, fetcher, waitMs });
  return { ok: false, rolledBack: true, from, to: newRelease, backup: backup.dir,
    why: after.ok ? `the new release answered as another node (${after.identity.slice(0, 16)}), not ${before.identity.slice(0, 16)}` : `the new release did not come up: ${after.why}`,
    restored: back.ok };
}
