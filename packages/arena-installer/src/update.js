// AN EXISTING NODE UPDATED IN PLACE (kanban #471 part E, slice 3; the owner 2026-10-18: "also supports updating an existing node that
// applies, updates and supports existing settings and doesn't break it").
//
//   1. the install is found (its home: state.json, node.env, node.db) and the running release read from its unit;
//   2. the new asset is checked: SHA256SUMS signed by the Arena release key, the asset's line in it (release-verify.js);
//   3. it is unpacked beside the old release (releases/<version>), never over it;
//   4. never inside a market seating window (minutes 11-14 of a quarter hour), the node is stopped and BACKED UP - its database
//      (and WAL), settings, state, seed and owner binding - into backups/<time>/;
//   5. the units are written for the new release with the SAME settings file (nothing the user set changes), and started;
//   6. it must answer healthy as the same node (GET /identity, the same key) - else the old units and the backup are put back,
//      the old release started, and the update said refused, with why.
// A data migration is the seat's own: openStore migrates its database on start (store.js), and the backup is what a failed one
// is rolled back from.
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { checkAsset } from './release-verify.js';
import { seatUnit, bridgeUnit, unitDir, UNIT, BRIDGE_UNIT, TUNNEL_UNIT, waitHealthy } from './service.js';

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

/**
 * Update the node at `home` to the release unpacked at `newRelease`. `asset` / `sums` / `sig` are checked first when given (an
 * unpacked tree from a test is passed without them). Injectables: `sh` (systemctl), `fetcher`, `nowMs`, `wait` (the seating-window
 * wait). Answers { ok, from, to, backup, why, rolledBack }.
 */
export async function updateNode({ home, newRelease, port, node = process.execPath, asset = null, sums = null, sig = null, env = process.env, sh = run,
  fetcher = fetch, nowMs = () => Date.now(), waitMs = 90000, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)) }) {
  if (asset) {
    const c = checkAsset({ file: asset, sums, sig });
    if (!c.ok) return { ok: false, why: c.why };
  }
  if (!existsSync(join(home, 'state.json')) || !existsSync(join(home, 'node.env'))) return { ok: false, why: `no node is installed at ${home}` };
  const dir = unitDir(env);
  const unitPath = join(dir, UNIT);
  const oldUnit = existsSync(unitPath) ? readFileSync(unitPath, 'utf8') : null;
  const from = releaseOfUnit(oldUnit);
  if (!from) return { ok: false, why: `no arena-node unit names a release (${unitPath})` };
  if (from === newRelease) return { ok: false, why: 'that release is the one running' };
  const before = await waitHealthy({ port, fetcher, waitMs: 10000, everyMs: 500 });
  const units = [UNIT, ...(existsSync(join(dir, BRIDGE_UNIT)) ? [BRIDGE_UNIT] : []), ...(existsSync(join(dir, TUNNEL_UNIT)) ? [TUNNEL_UNIT] : [])];
  const oldBridge = existsSync(join(dir, BRIDGE_UNIT)) ? readFileSync(join(dir, BRIDGE_UNIT), 'utf8') : null;

  while (inSeatingWindow(nowMs())) await sleep(5000);
  const stop = await sh('systemctl', ['--user', 'stop', ...units]);
  if (!stop.ok) return { ok: false, why: `the node did not stop: ${stop.err.trim().slice(0, 200)}` };
  const backup = backupNode(home);
  const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
  writeFileSync(unitPath, seatUnit({ node, release: newRelease, home, port }));
  if (oldBridge) writeFileSync(join(dir, BRIDGE_UNIT), bridgeUnit({ node, release: newRelease, home, bridgePort: state.bridgePort || 8471 }));
  await sh('systemctl', ['--user', 'daemon-reload']);
  await sh('systemctl', ['--user', 'start', ...units]);
  const after = await waitHealthy({ port, fetcher, waitMs });
  const same = after.ok && (!before.ok || after.identity === before.identity);
  if (same) {
    writeFileSync(join(home, 'state.json'), JSON.stringify({ ...state, release: { path: newRelease, from, atMs: nowMs() } }, null, 2) + '\n', { mode: 0o600 });
    return { ok: true, from, to: newRelease, backup: backup.dir, identity: after.identity };
  }
  // ROLLED BACK: the old units, the backup, the old release started
  await sh('systemctl', ['--user', 'stop', ...units]);
  writeFileSync(unitPath, oldUnit);
  if (oldBridge) writeFileSync(join(dir, BRIDGE_UNIT), oldBridge);
  restoreNode(home, backup);
  await sh('systemctl', ['--user', 'daemon-reload']);
  await sh('systemctl', ['--user', 'start', ...units]);
  const back = await waitHealthy({ port, fetcher, waitMs });
  return { ok: false, rolledBack: true, from, to: newRelease, backup: backup.dir,
    why: after.ok ? `the new release answered as another node (${after.identity.slice(0, 16)}), not ${before.identity.slice(0, 16)}` : `the new release did not come up: ${after.why}`,
    restored: back.ok };
}

