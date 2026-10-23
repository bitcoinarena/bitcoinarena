// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEDIMINT ON A RAM DISK (kanban #596, the owner 2026-10-23: "bei mehr als 5 nodes ... RAM disk für fedimint aktivieren? Default ja"), the
// installer's nodes doing what federation A's guardians do since #587 (ops/guardian-ram.sh: "Yes do the RAM disk and sync it every minute",
// "zeitlich versetzt", the risk accepted): the guardian's RocksDB (database/) and Fedimint's session checkpoints (db_checkpoints/) live in
// RAM (/dev/shm), the data dir keeps symlinks to them, and once a minute - at this node's own second of it, so the nodes of one machine
// write one after another - the guardian is frozen (SIGSTOP) only while its database is copied within RAM, and that copy is written to
// the data dir as a snapshot (rsync --link-dest: unchanged files are hard links of the last one). A power cut, crash or reboot loses at
// most the minute since the last snapshot; after a reboot the newest snapshot is copied back before fedimintd starts. Linux only for
// now: a macOS or Windows node runs its guardian on disk, and says so.
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, readlinkSync, readdirSync, cpSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const RAM_BASE = '/dev/shm/arena-node';
export const SNAPS_KEPT = 2;

/** Where a node's guardian lives in RAM: one folder per node and slot (instance '' is the first node). */
export const ramDirOf = ({ instance = '', slot = 'guardian', base = RAM_BASE } = {}) => join(base, `${instance || 'a'}-${slot}`);
/** Whether this machine has the RAM disk the guardian uses. */
export const ramSupported = (platform = process.platform, base = RAM_BASE) => platform === 'linux' && existsSync(dirname(base));
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');

/**
 * BEFORE FEDIMINTD STARTS (never while it runs): a guardian on disk is moved into RAM (its disk copy kept as the first snapshot); a RAM
 * emptied by a reboot gets the newest snapshot back; neither RAM nor a snapshot - refused, since an empty database would be a new guardian.
 * Answers { ok, moved?, restored?, why? }.
 */
export function ramRestore(dataDir, ram, { nowMs = Date.now(), log = () => {} } = {}) {
  const db = join(dataDir, 'database'), cp = join(dataDir, 'db_checkpoints'), snaps = join(dataDir, 'ram-snaps');
  mkdirSync(ram, { recursive: true, mode: 0o700 });
  if (!isLink(db)) {
    if (!existsSync(db)) {   // a guardian not set up yet: its database starts in RAM
      mkdirSync(join(ram, 'database'), { recursive: true, mode: 0o700 }); mkdirSync(join(ram, 'db_checkpoints'), { recursive: true, mode: 0o700 });
      symlinkSync(join(ram, 'database'), db); if (!existsSync(cp)) symlinkSync(join(ram, 'db_checkpoints'), cp);
      return { ok: true, moved: true, fresh: true };
    }
    rmSync(join(ram, 'database.partial'), { recursive: true, force: true });
    cpSync(db, join(ram, 'database.partial'), { recursive: true, preserveTimestamps: true });
    renameSync(join(ram, 'database.partial'), join(ram, 'database'));
    if (existsSync(cp) && !isLink(cp)) cpSync(cp, join(ram, 'db_checkpoints'), { recursive: true, preserveTimestamps: true }); else mkdirSync(join(ram, 'db_checkpoints'), { recursive: true });
    mkdirSync(snaps, { recursive: true, mode: 0o700 });
    const first = `snap-${stamp(nowMs)}-initial`;
    renameSync(db, join(snaps, first)); setCurrent(snaps, first);
    if (existsSync(cp) && !isLink(cp)) renameSync(cp, join(snaps, 'db_checkpoints.on-disk'));
    symlinkSync(join(ram, 'database'), db); if (!existsSync(cp)) symlinkSync(join(ram, 'db_checkpoints'), cp);
    log(`[guardian-ram] moved into RAM (${ram}); the disk copy is the first snapshot ${first}`);
    return { ok: true, moved: true };
  }
  if (existsSync(join(ram, 'database', 'CURRENT')) || (existsSync(join(ram, 'database')) && !existsSync(join(snaps, 'current')))) {
    mkdirSync(join(ram, 'db_checkpoints'), { recursive: true }); return { ok: true };
  }
  // NEVER SNAPSHOTTED: a guardian that started in RAM and lost it within its first minute (no snapshot folder at all) starts fresh again
  if (!existsSync(snaps)) {
    mkdirSync(join(ram, 'database'), { recursive: true, mode: 0o700 }); mkdirSync(join(ram, 'db_checkpoints'), { recursive: true, mode: 0o700 });
    log('[guardian-ram] RAM empty and never snapshotted: a fresh guardian database');
    return { ok: true, fresh: true };
  }
  const snap = join(snaps, 'current');
  if (!existsSync(join(snap, 'CURRENT'))) return { ok: false, why: `no database in RAM and no snapshot at ${snap}: not started empty` };
  rmSync(join(ram, 'database.partial'), { recursive: true, force: true });
  cpSync(realpathSync(snap), join(ram, 'database.partial'), { recursive: true, preserveTimestamps: true });
  renameSync(join(ram, 'database.partial'), join(ram, 'database'));
  mkdirSync(join(ram, 'db_checkpoints'), { recursive: true });
  log(`[guardian-ram] restored into RAM from ${readlinkSync(snap)}`);
  return { ok: true, restored: true };
}
function setCurrent(snaps, name) {
  const tmp = join(snaps, 'current.new');
  rmSync(tmp, { force: true }); symlinkSync(name, tmp); renameSync(tmp, join(snaps, 'current'));
}

/**
 * ONE SNAPSHOT: the guardian (`pid`) frozen only while its database is copied within RAM, then that copy written to the data dir and made
 * `current`; the last SNAPS_KEPT kept. Answers { ok, heldMs, name } or { ok: false, why }.
 */
export async function ramSnapshot(dataDir, ram, pid, { nowMs = Date.now(), kill = process.kill.bind(process), rsync = 'rsync' } = {}) {
  const db = join(ram, 'database'), stage = join(ram, 'stage'), snaps = join(dataDir, 'ram-snaps');
  if (!isLink(join(dataDir, 'database')) || !existsSync(db)) return { ok: false, why: 'not in RAM' };
  if (!pid) return { ok: false, why: 'no fedimintd running' };
  rmSync(stage, { recursive: true, force: true });
  const t0 = Date.now();
  kill(pid, 'SIGSTOP');
  try { cpSync(db, stage, { recursive: true, preserveTimestamps: true }); } catch (e) { kill(pid, 'SIGCONT'); rmSync(stage, { recursive: true, force: true }); return { ok: false, why: `copy in RAM: ${e.message}` }; }
  kill(pid, 'SIGCONT');
  const heldMs = Date.now() - t0;
  mkdirSync(snaps, { recursive: true, mode: 0o700 });
  const name = `snap-${stamp(nowMs)}`, part = join(snaps, `${name}.partial`);
  const prev = existsSync(join(snaps, 'current')) ? [`--link-dest=${realpathSync(join(snaps, 'current'))}`] : [];
  try { await run(rsync, ['-a', '--delete', ...prev, `${stage}/`, `${part}/`]); } catch (e) { rmSync(stage, { recursive: true, force: true }); return { ok: false, why: `snapshot write: ${e.message}` }; }
  renameSync(part, join(snaps, name)); setCurrent(snaps, name);
  rmSync(stage, { recursive: true, force: true });
  const old = readdirSync(snaps).filter((x) => /^snap-/.test(x)).sort();
  for (const x of old.filter((x) => x.endsWith('.partial'))) rmSync(join(snaps, x), { recursive: true, force: true });
  const done = old.filter((x) => !x.endsWith('.partial'));
  for (const x of done.slice(0, Math.max(0, done.length - SNAPS_KEPT))) rmSync(join(snaps, x), { recursive: true, force: true });
  try { writeFileSync(join(ram, 'last-hold-ms'), `${heldMs}\n`); } catch { /* only a note */ }
  return { ok: true, heldMs, name };
}

/** EVERY MINUTE AT THIS NODE'S SECOND (`offsetMs` into the minute): one snapshot; `stop()` ends it. */
export function ramLoop({ dataDir, ram, pidOf, offsetMs = 0, everyMs = 60000, log = () => {}, snapshot = ramSnapshot } = {}) {
  let timer = null, stopped = false;
  const next = () => { const now = Date.now(), due = Math.floor(now / everyMs) * everyMs + (offsetMs % everyMs); return due > now ? due - now : due + everyMs - now; };
  const tick = async () => {
    if (stopped) return;
    try { const r = await snapshot(dataDir, ram, pidOf()); if (!r.ok && r.why !== 'no fedimintd running') log(`[guardian-ram] no snapshot this minute: ${r.why}`); }
    catch (e) { log(`[guardian-ram] no snapshot this minute: ${e.message}`); }
    if (!stopped) timer = setTimeout(tick, next());
  };
  timer = setTimeout(tick, next());
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
