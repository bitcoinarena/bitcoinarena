// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEDIMINT ON A RAM DISK (kanban #596, 2026-10-23: "bei mehr als 5 nodes ... RAM disk für fedimint aktivieren? Default ja"), the
// installer's nodes doing what federation A's guardians do since #587 (ops/guardian-ram.sh: "Yes do the RAM disk and sync it every minute",
// the risk accepted): the guardian's RocksDB (database/) and Fedimint's session checkpoints (db_checkpoints/) live in RAM (/dev/shm), the
// data dir keeps symlinks to them, and once a minute ALL the machine's guardians are frozen together (SIGSTOP) only while their databases
// are staged within RAM, then each stage is written to its data dir as a snapshot, one after another (rsync --link-dest: unchanged files
// are hard links of the last one). One moment for all (kanban #718, which replaces the staggered snapshots of 2026-10-23 for that reason:
// staggered, a reboot split federation A's 7 guardians into 7 different moments and its session never closed). A power cut, crash or
// reboot loses at most the minute since the last set; after a reboot the newest snapshot is copied back before fedimintd starts, and a
// guardian that was not shut down properly is checked first (guardian-recover.js). Linux only for now: a macOS or Windows node runs its
// guardian on disk, and says so.
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync, readlinkSync, readdirSync, cpSync, writeFileSync, readFileSync, realpathSync,
  linkSync, copyFileSync, statSync, utimesSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const RAM_BASE = '/dev/shm/arena-node';
export const SNAPS_KEPT = 2;
/** The machine's RAM folder for its guardians: ARENA_FEDIMINT_RAM_DIR (a rehearsal's own), else RAM_BASE. */
export const ramBaseOf = (env = process.env) => env.ARENA_FEDIMINT_RAM_DIR || RAM_BASE;

/** Where a node's guardian lives in RAM: one folder per node and slot (instance '' is the first node). */
export const ramDirOf = ({ instance = '', slot = 'guardian', base = RAM_BASE } = {}) => join(base, `${instance || 'a'}-${slot}`);
/** Whether this machine has the RAM disk the guardian uses. */
export const ramSupported = (platform = process.platform, base = RAM_BASE) => platform === 'linux' && existsSync(dirname(base));
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');

/**
 * BEFORE FEDIMINTD STARTS (never while it runs): a guardian on disk is moved into RAM (its disk copy kept as the first snapshot); a RAM
 * emptied by a reboot gets the newest snapshot back; neither RAM nor a snapshot - refused, since an empty database would be a new guardian.
 * Answers { ok, moved?, restored?, snap?, clean?, why? }.
 *
 * CLEAN OR NOT (kanban #718): a guardian stopped by its node leaves a last snapshot taken after fedimintd exited (ramFinal) and names it
 * in ram-snaps/clean. A restore of exactly that snapshot is `clean: true` - nothing was lost. Any other restore is a guardian that was
 * not shut down properly (kill -9, power cut, reboot with fedimintd running): up to a minute of its database is gone, and that is what
 * guardian-recover.js checks before fedimintd starts. The marker is removed at every start, so the next crash is never taken as clean.
 */
export function ramRestore(dataDir, ram, { nowMs = Date.now(), log = () => {} } = {}) {
  const db = join(dataDir, 'database'), cp = join(dataDir, 'db_checkpoints'), snaps = join(dataDir, 'ram-snaps');
  mkdirSync(ram, { recursive: true, mode: 0o700 });
  const cleanName = takeClean(snaps);
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
  const name = readlinkSync(snap), clean = cleanName === name;
  log(`[guardian-ram] restored into RAM from ${name}${clean ? ' (its clean stop: nothing lost)' : ' - NOT SHUT DOWN PROPERLY: up to a minute lost, checked before it starts'}`);
  return { ok: true, restored: true, snap: name, clean };
}
/** The clean-stop marker read and removed (a guardian about to run is no longer cleanly stopped). */
function takeClean(snaps) {
  const f = join(snaps, 'clean');
  let name = null;
  try { name = readFileSync(f, 'utf8').trim() || null; } catch { return null; }
  rmSync(f, { force: true });
  return name;
}
function setCurrent(snaps, name) {
  const tmp = join(snaps, 'current.new');
  rmSync(tmp, { force: true }); symlinkSync(name, tmp); renameSync(tmp, join(snaps, 'current'));
}

/**
 * THE COPY WITHIN RAM, WHILE THE GUARDIAN IS FROZEN: RocksDB never changes a table file once written (*.sst, *.blob: written whole,
 * later only deleted), so those are hard links - instant, no second copy in RAM - and only the files it appends to or replaces (the WAL
 * *.log, MANIFEST-*, CURRENT, OPTIONS-*) are copied. A link keeps a table file's content even after RocksDB deletes the name.
 */
export function stageCopy(src, dst) {
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const a = join(src, e.name), b = join(dst, e.name);
    if (e.isDirectory()) { stageCopy(a, b); continue; }
    if (!e.isFile()) continue;
    if (/\.(sst|blob)$/.test(e.name)) { try { linkSync(a, b); continue; } catch { /* another file system: copied */ } }
    copyFileSync(a, b);
    try { const st = statSync(a); utimesSync(b, st.atime, st.mtime); } catch { /* only times */ }
  }
}

/** The staged copy written to the data dir as snapshot `name` (rsync --link-dest: unchanged files are hard links of the last one), made `current`, the last SNAPS_KEPT kept. */
async function writeSnap(dataDir, ram, name, { rsync = 'rsync', clean = false } = {}) {
  const stage = join(ram, 'stage'), snaps = join(dataDir, 'ram-snaps');
  mkdirSync(snaps, { recursive: true, mode: 0o700 });
  const part = join(snaps, `${name}.partial`);
  const prev = existsSync(join(snaps, 'current')) ? [`--link-dest=${realpathSync(join(snaps, 'current'))}`] : [];
  try { await run(rsync, ['-a', '--delete', ...prev, `${stage}/`, `${part}/`]); } catch (e) { rmSync(stage, { recursive: true, force: true }); return { ok: false, why: `snapshot write: ${e.message}` }; }
  rmSync(join(snaps, name), { recursive: true, force: true });
  renameSync(part, join(snaps, name)); setCurrent(snaps, name);
  rmSync(stage, { recursive: true, force: true });
  if (clean) writeFileSync(join(snaps, 'clean'), `${name}\n`);
  const old = readdirSync(snaps).filter((x) => /^snap-/.test(x)).sort();
  for (const x of old.filter((x) => x.endsWith('.partial'))) rmSync(join(snaps, x), { recursive: true, force: true });
  const done = old.filter((x) => !x.endsWith('.partial'));
  for (const x of done.slice(0, Math.max(0, done.length - SNAPS_KEPT))) rmSync(join(snaps, x), { recursive: true, force: true });
  return { ok: true, name };
}
const inRam = (dataDir, ram) => isLink(join(dataDir, 'database')) && existsSync(join(ram, 'database'));

/**
 * ONE SNAPSHOT SET FOR ALL THE MACHINE'S GUARDIANS (kanban #718: the test host rebooted at 13:31Z inside federation A's session 7753; its 7
 * guardians came back from snapshots taken one after another over the minute, so each had lost a different stretch of its own AlephBFT
 * units, they re-made those rounds differently - forks - and the session never closed, ~7 h). Now every guardian is frozen (SIGSTOP)
 * first, then each one's database is staged within RAM, then all are thawed - so the set is ONE MOMENT of all of them: no guardian holds a
 * unit another one of the set has not saved first (AlephBFT saves a unit before it sends it). Only after the thaw are the stages written
 * to disk, one after another (the cheap disk write the staggered snapshots were for, ruling 2026-10-23, kept). All carry the same name,
 * which is how a restore knows they belong together. `members`: [{ dataDir, ram, pid }]. Answers { ok, heldMs, name, results }.
 */
export async function ramGroupSnapshot(members, { nowMs = Date.now(), kill = process.kill.bind(process), rsync = 'rsync', stage = stageCopy } = {}) {
  const live = members.filter((m) => m.pid && inRam(m.dataDir, m.ram));
  if (!live.length) return { ok: false, why: 'no guardian running from RAM' };
  for (const m of live) rmSync(join(m.ram, 'stage'), { recursive: true, force: true });
  const t0 = Date.now(), frozen = [];
  let failed = null;
  try {
    for (const m of live) { try { kill(m.pid, 'SIGSTOP'); frozen.push(m); } catch (e) { m.why = `not frozen: ${e.message}`; } }
    for (const m of frozen) { try { stage(join(m.ram, 'database'), join(m.ram, 'stage')); } catch (e) { m.why = `copy in RAM: ${e.message}`; failed = m; break; } }
  } finally {
    for (const m of frozen) { try { kill(m.pid, 'SIGCONT'); } catch { /* gone */ } }
  }
  const heldMs = Date.now() - t0;
  // A SET IS WHOLE OR NOT AT ALL: one stage that failed would leave the others a newer moment than it - none is written this minute
  if (failed || frozen.length !== live.length) {
    for (const m of live) rmSync(join(m.ram, 'stage'), { recursive: true, force: true });
    return { ok: false, heldMs, why: (failed || live.find((m) => m.why)).why };
  }
  const name = `snap-${stamp(nowMs)}`, results = [];
  for (const m of live) {
    const r = await writeSnap(m.dataDir, m.ram, name, { rsync });
    try { writeFileSync(join(m.ram, 'last-hold-ms'), `${heldMs}\n`); } catch { /* only a note */ }
    results.push({ dataDir: m.dataDir, ...r });
  }
  return { ok: results.every((r) => r.ok), heldMs, name, results };
}

/** ONE GUARDIAN'S SNAPSHOT (a set of one): as ramGroupSnapshot. Answers { ok, heldMs, name } or { ok: false, why }. */
export async function ramSnapshot(dataDir, ram, pid, opts = {}) {
  if (!inRam(dataDir, ram)) return { ok: false, why: 'not in RAM' };
  if (!pid) return { ok: false, why: 'no fedimintd running' };
  const r = await ramGroupSnapshot([{ dataDir, ram, pid }], opts);
  return r.ok ? { ok: true, heldMs: r.heldMs, name: r.name } : { ok: false, why: r.why || (r.results && r.results[0] && r.results[0].why) };
}

/**
 * THE LAST SNAPSHOT AT A CLEAN STOP: after fedimintd exited (nothing to freeze), the database written once more and named in
 * ram-snaps/clean - a restore of it knows nothing was lost (ramRestore `clean`). Answers as writeSnap.
 */
export async function ramFinal(dataDir, ram, { nowMs = Date.now(), rsync = 'rsync' } = {}) {
  if (!inRam(dataDir, ram)) return { ok: false, why: 'not in RAM' };
  rmSync(join(ram, 'stage'), { recursive: true, force: true });
  try { stageCopy(join(ram, 'database'), join(ram, 'stage')); } catch (e) { return { ok: false, why: `copy in RAM: ${e.message}` }; }
  return writeSnap(dataDir, ram, `snap-${stamp(nowMs)}-stop`, { rsync, clean: true });
}

// ---- THE MACHINE'S GUARDIANS: each node (its own process) says where its guardian is; one of them takes the minute's set ----
const membersDir = (base) => join(base, 'members');
const lockDir = (base) => join(base, 'snap.lock');
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** This node's guardian announced to the machine: { dataDir, ram, pid, at } in <base>/members/<key>.json (RAM: gone with a reboot). */
export function ramAnnounce(base, key, { dataDir, ram, pid, nowMs = Date.now() }) {
  mkdirSync(membersDir(base), { recursive: true, mode: 0o700 });
  const f = join(membersDir(base), `${key}.json`), tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ key, dataDir, ram, pid: pid || null, at: nowMs, node: process.pid }));
  renameSync(tmp, f);
}
export function ramWithdraw(base, key) { rmSync(join(membersDir(base), `${key}.json`), { force: true }); }
/** The machine's guardians that announced themselves in the last `freshMs`. */
export function ramMembers(base, { nowMs = Date.now(), freshMs = 180000 } = {}) {
  let names = [];
  try { names = readdirSync(membersDir(base)).filter((x) => x.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const x of names) { try { const m = JSON.parse(readFileSync(join(membersDir(base), x), 'utf8')); if (nowMs - m.at <= freshMs) out.push(m); } catch { /* half written */ } }
  return out.sort((a, b) => String(a.key).localeCompare(String(b.key)));
}
/** The machine's snapshot lock (mkdir is atomic): taken, or broken when its holder died or held it over `staleMs`. */
export function ramTakeLock(base, { nowMs = Date.now(), staleMs = 120000, alive = pidAlive } = {}) {
  mkdirSync(base, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try { mkdirSync(lockDir(base)); writeFileSync(join(lockDir(base), 'owner'), JSON.stringify({ pid: process.pid, at: nowMs })); return true; } catch { /* held */ }
    let o = null; try { o = JSON.parse(readFileSync(join(lockDir(base), 'owner'), 'utf8')); } catch { /* being written */ }
    if (o && (nowMs - o.at > staleMs || !alive(o.pid))) { rmSync(lockDir(base), { recursive: true, force: true }); continue; }
    return false;
  }
  return false;
}
export function ramDropLock(base) { rmSync(join(lockDir(base), 'owner'), { force: true }); try { rmdirSync(lockDir(base)); } catch { /* gone */ } }
const lastSetAt = (base) => { try { return Number(readFileSync(join(base, 'last-set'), 'utf8')) || 0; } catch { return 0; } };

/**
 * ONE MINUTE'S TICK FOR THIS NODE: its guardian announced; then, if no set was taken this minute and the lock is free, this node takes
 * the set for every guardian of the machine (ramGroupSnapshot). Whichever node ticks first in a minute takes it; the others find it done.
 */
export async function ramTick(base, key, { dataDir, ram, pid, nowMs = Date.now(), everyMs = 60000, group = ramGroupSnapshot, log = () => {} } = {}) {
  ramAnnounce(base, key, { dataDir, ram, pid, nowMs });
  if (nowMs - lastSetAt(base) < everyMs * 0.8) return { ok: true, taken: false };
  if (!ramTakeLock(base, { nowMs })) return { ok: true, taken: false };
  try {
    if (nowMs - lastSetAt(base) < everyMs * 0.8) return { ok: true, taken: false };
    const members = ramMembers(base, { nowMs, freshMs: everyMs * 3 }).filter((m) => m.pid && pidAlive(m.pid));
    const r = await group(members, { nowMs });
    writeFileSync(join(base, 'last-set'), String(nowMs));
    if (!r.ok) log(`[guardian-ram] no snapshot set this minute: ${r.why || (r.results || []).filter((x) => !x.ok).map((x) => `${x.dataDir}: ${x.why}`).join('; ')}`);
    return { ok: r.ok, taken: true, set: r };
  } finally { ramDropLock(base); }
}

/**
 * EVERY MINUTE AT THIS NODE'S SECOND (`offsetMs` into the minute): this node's tick - the machine's set, whoever is first. `group: false`
 * (ARENA_FEDIMINT_RAM_SET=0, only for a rehearsal of the old way) snapshots this guardian alone. `stop()` ends it and withdraws it.
 */
export function ramLoop({ dataDir, ram, pidOf, offsetMs = 0, everyMs = 60000, log = () => {}, snapshot = ramSnapshot, base = RAM_BASE, key = null, group = true } = {}) {
  let timer = null, stopped = false;
  const k = key || String(ram).split('/').pop();
  const next = () => { const now = Date.now(), due = Math.floor(now / everyMs) * everyMs + (offsetMs % everyMs); return due > now ? due - now : due + everyMs - now; };
  const tick = async () => {
    if (stopped) return;
    try {
      if (group) await ramTick(base, k, { dataDir, ram, pid: pidOf(), everyMs, log });
      else { const r = await snapshot(dataDir, ram, pidOf()); if (!r.ok && r.why !== 'no fedimintd running') log(`[guardian-ram] no snapshot this minute: ${r.why}`); }
    } catch (e) { log(`[guardian-ram] no snapshot this minute: ${e.message}`); }
    if (!stopped) timer = setTimeout(tick, next());
  };
  timer = setTimeout(tick, next());
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); if (group) { try { ramWithdraw(base, k); } catch { /* gone */ } } } };
}
