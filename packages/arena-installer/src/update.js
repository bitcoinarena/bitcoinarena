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
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, uptime } from 'node:os';
import { execFile } from 'node:child_process';
import { checkAsset } from './release-verify.js';
import { seatUnit, bridgeUnit, unitDir, UNIT, BRIDGE_UNIT, TUNNEL_UNIT, waitHealthy, launchdPlist, LAUNCHD_LABEL, interactivePlist, windowsLauncher, withWindowsRestart, removeProgram, unitName, waitPortLine } from './service.js';
import { adhocSign } from './tor.js';
import { INSTANCE, PORT_OFFSET } from './instance.js';
import { envToConfValues, formatConf, renameKeys, renameValues, setInConf } from '../../arena-node/src/arena-conf.js';
import { stakeLockSetupOf, nodeState, atomicWrite, appsSetting } from './state.js';
import { ensureApps } from '../../arena-node/src/app-fetch.js';
import { writeCommand } from './launchers.js';
import { control } from './node-services.js';

// THE CHAIN BRIDGE ON THE PORT THE NODE CALLS (kanban #734, measured 2026-10-29 in the Linux VM: the third node of the machine, port_offset
// 200, updated 2026.1.9.12 -> 2026.1.9.13 - its bridge unit was written for 127.0.0.1:8471 while arena.conf still sent the node to
// 127.0.0.1:8671, so nothing answered the node's chain calls): the port of arena.conf's bitcoind_url when it is this machine's loopback,
// else the state's, else the installer's own choice, 8471 plus this node's port offset
export function bridgePortOf(home, state = {}, { read = (f) => readFileSync(f, 'utf8'), offset = PORT_OFFSET } = {}) {
  try {
    const m = /^bitcoind_url=http:\/\/127\.0\.0\.1:(\d+)\/?\s*$/m.exec(read(join(home, 'arena.conf')));
    if (m) return Number(m[1]);
  } catch { /* no settings: the defaults below */ }
  return Number(state.bridgePort) || 8471 + (Number(offset) || 0);
}
import { quickTunnelUrl } from './reach.js';
import { gatewayMetricsOwn } from './gateway.js';
import { installLnd, LND_FILES } from './lnd.js';
import { QUIET } from '../../arena-node/src/log-level.js';
import { newerVersion } from '../../arena-node/src/release-latest.js';

/** Files that are the node: kept across an update, backed up before it. */
export const NODE_FILES = Object.freeze(['node.db', 'node.db-wal', 'node.db-shm', 'arena.conf', 'node.env', 'state.json', 'seed.hex', 'node.db.owner.json',
  'node.db.operator-tokens.json', 'bitcoind.auth', 'cloudflared.yml']);

/** Is it inside a market seating window now (minutes 11-14 of a quarter hour)? The update waits it out. */
export const inSeatingWindow = (nowMs = Date.now()) => { const q = Math.floor(nowMs / 1000) % 900; return q >= 660 && q < 840; };

/**
 * THE NODE'S LND, WHEN IT IS NOT THE ONE THIS RELEASE PINS (kanban #584, 2026-10-22: "tu die releases und unsere Implementierung
 * updaten" - LND built with Go 1.27.3, CVE-2026-111943): LND lives beside the releases (<home>/lnd-bin/<its release file>), so moving a
 * service's release paths never moved it. `texts` the service files' texts. Answers { index, from, to, swap(text) } or null.
 */
export function staleLnd(texts, { platform = process.platform, arch = process.arch } = {}) {
  const pin = LND_FILES[`${platform}-${arch}`];
  if (!pin) return null;
  const want = pin.file.replace(/\.(tar\.gz|zip)$/, '');
  const re = /lnd-bin([\\/])(lnd-[A-Za-z0-9.-]+?)[\\/]lnd(?:\.exe)?(?![A-Za-z0-9.-])/;
  for (let i = 0; i < texts.length; i++) {
    const m = re.exec(texts[i]);
    if (!m || m[2] === want) continue;
    const [from, to] = [`lnd-bin${m[1]}${m[2]}${m[1]}`, `lnd-bin${m[1]}${want}${m[1]}`];
    return { index: i, from: m[2], to: want, swap: (t) => t.split(from).join(to) };
  }
  return null;
}

/** The release a unit file runs: its WorkingDirectory less packages/arena-node. */
export function releaseOfUnit(text) {
  const m = /^WorkingDirectory=(.+)\/packages\/arena-node$/m.exec(String(text || ''));
  return m ? m[1] : null;
}

const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 120000 }, (e, out, err) => resolve({ ok: !e, out: String(out), err: String(err) })));

/** arena.conf with the release's stake lock tool (kanban #824), for a node installed before the release carried it; a node that names its own keeps it. */
export function withStakeLocks(text, locks) {
  if (!locks || /^\s*stake_lock_bin\s*=/m.test(text)) return text;
  return setInConf(setInConf(text, 'stake_lock_bin', locks.bin), 'federation_client_dir', locks.clientDir);
}

/**
 * THE NEW RELEASE'S VERSIONS OF THE APPS THE NODE RUNS (kanban #1415, Daniel 2026-11-10: Update of Tick Tock v7 failed on his node - 2026.1.9.26 ships
 * nextblock-v7.js, and his arena.conf, moved from the release it was installed with, named v1 to v6 only, so v7 was on disk and never loaded; the owner
 * page then offered it from the store, where a source-tree core can not pass): every registration `release` holds for an app whose folder apps= already
 * names is added after the ones listed. An app the owner left out stays out; a listed path is never taken away.
 */
export function withNewAppVersions(text, release, want) {
  const lines = String(text).split('\n');
  const i = lines.findIndex((l) => /^apps=/.test(l)); if (i < 0) return text;
  const cr = lines[i].endsWith('\r') ? '\r' : '', have = lines[i].slice(5, cr ? -1 : undefined).split(',').filter(Boolean);
  const dir = (f) => f.replace(/[\\/][^\\/]*$/, ''), dirs = new Set(have.map(dir));
  const add = String(want || '').split(',').filter((f) => f && !have.includes(f) && dirs.has(dir(f)));
  if (!add.length) return text;
  lines[i] = 'apps=' + [...have, ...add].join(',') + cr;
  return lines.join('\n');
}

/**
 * THE OLD HOMES A SERVICE FILE STILL NAMES (kanban #818): every `<old home>/releases/(bitcoin-)arena-node-*` in `text` whose release is gone,
 * the old home's path each. A QUOTED PATH MAY HOLD SPACES (kanban #1441, audit 8 O8-2: a Windows profile "C:\Users\John Doe" - the rule
 * read "\.bitcoinarena" after the space as a gone home and rewrote the tunnel and chain bridge launchers into paths that do not exist): a
 * path inside "..." or <string>...</string> is read whole; outside them a path ends at a space. A path that is this home, or the tail of
 * it (the text before it completes it to this home), is never an old home.
 */
export function staleHomesOf(text, { home, releasesDir, exists = existsSync }) {
  const slashes = (p) => String(p).replace(/\\/g, '/');
  const homeN = slashes(home);
  const found = [];
  const scan = (part, spaces) => {
    const re = spaces ? /((?:[A-Za-z]:)?[\\/][^"'<>=\r\n]*?)[\\/]releases[\\/](?:bitcoin-)?arena-node-[^\\/"'\s<>]+/g
      : /((?:[A-Za-z]:)?[\\/][^\s"'<>=]*?)[\\/]releases[\\/](?:bitcoin-)?arena-node-[^\\/"'\s<>]+/g;
    for (const m of part.matchAll(re)) {
      if (slashes(part.slice(0, m.index + m[1].length)).endsWith(homeN) || homeN.endsWith(slashes(m[1]))) continue;
      if (m[0].startsWith(releasesDir) || exists(m[0])) continue;
      found.push(m[1]);
    }
  };
  const bare = String(text || '').replace(/"([^"\r\n]*)"|<string>([^<]*)<\/string>/g, (_, a, b) => { scan(a ?? b, true); return ' '; });
  scan(bare, false);
  return [...new Set(found)];
}

/** node.env's paths into a release - the games, the custody binaries - moved to the new release, from EVERY older one, not only the
 *  release the seat ran (macOS node A at rc.16 still read its games and fedimintd from the rc.12 folder it was installed from); a path
 *  the new release does not hold is kept. */
export function envForRelease(text, newRelease, exists = existsSync) {
  // ONE PATH OR A LIST (kanban #569: apps= names every registration of every app, comma-joined): each path of a value moved on its own -
  // the whole line read as one path kept only the part after its last release folder (measured: 22 registrations became 1)
  // AN ADDRESS IS NO PATH (kanban #688, measured 2026-10-26: a workers.dev node's public_url=https://arena-node-3fa9c1.me.workers.dev,
  // its name starting with a digit, read as a release folder and became the new release's path - the node lost its public address)
  const moveOne = (v) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
    // a release folder of either name (measured with kanban #688: since 2026.1.8 the folders are bitcoin-arena-node-<v>-..., and their
    // paths in arena.conf stayed on the release updated from - pruned by the next update)
    const m = /^(.*[\\/](?:bitcoin-)?arena-node-\d[^\\/\s,]*)([\\/].*)?$/.exec(v);
    if (!m || m[1] === newRelease) return v;
    const moved = newRelease + (m[2] || '');
    return exists(moved) ? moved : v;
  };
  return String(text).split('\n').map((line) => {
    const cr = line.endsWith('\r') ? '\r' : '';   // a Windows node's settings end their lines in CRLF
    const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(cr ? line.slice(0, -1) : line);
    if (!m) return line;
    const value = m[2].split(',').map(moveOne).join(',');
    return value === m[2] ? line : `${m[1]}=${value}${cr}`;
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

/**
 * LND WAITS FOR ITS TOR, AND TOR COMES BACK (kanban #720, the owner's LND log 2026-10-27: "dial proxy failed (connection refused)",
 * "host unreachable"): on Linux a node installed before 2026.1.9.11 has an LND unit that only starts after the Tor unit - not once Tor's
 * SOCKS port answers - and a Tor unit that is not started again after a clean exit. The two units are given the lines a new install
 * writes (service.js waitPortLine, Restart=always). Answers the units changed (a daemon-reload takes them; nothing is restarted).
 */
export function lndWaitsForTor(home, { env = process.env } = {}) {
  let socks = null;
  try { socks = Number(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).tor.ports.socks) || null; } catch { socks = null; }
  if (!socks) return [];
  const dir = unitDir(env), changed = [];
  const lnd = join(dir, unitName('lnd')), tor = join(dir, unitName('tor'));
  if (existsSync(lnd)) {
    const t = readFileSync(lnd, 'utf8');
    if (/^PartOf=.*tor/m.test(t) && !/^ExecStartPre=/m.test(t) && /^ExecStart=/m.test(t)) {
      writeFileSync(lnd, t.replace(/^ExecStart=/m, () => `${waitPortLine(socks)}\nExecStart=`));
      changed.push(unitName('lnd'));
    }
  }
  if (existsSync(tor)) {
    const t = readFileSync(tor, 'utf8');
    if (/^Restart=on-failure$/m.test(t)) { writeFileSync(tor, t.replace(/^Restart=on-failure$/m, 'Restart=always')); changed.push(unitName('tor')); }
  }
  return changed;
}

/**
 * THE DATABASE AS THE BACKUP TOOK IT (kanban #1227, audit 3 #1210 FIXES-37): node.db and its WAL, size and mtime. A rollback puts the backup back
 * only while the database is still this one - a release that ran since (its updater died before it noted `served`, or the old units were
 * started by hand after a failed move) wrote nonces, entries and locks there, and the backup over it would lose them.
 */
export function dbPrintOf(home) {
  const out = {};
  for (const f of ['node.db', 'node.db-wal']) { try { const st = statSync(join(home, f)); out[f] = `${st.size}:${Math.floor(st.mtimeMs)}`; } catch { out[f] = null; } }
  return out;
}
// A BACKUP WITH NO PRINT (kanban #1286, audit 4 #1257 CLIENT-4: a journal an updater from before #1227 wrote): the backup's own copy of node.db
// was made after the seat stopped, so a node.db or WAL newer than that copy was written since
export function dbChangedSince(home, backup) {
  if (!backup) return false;
  if (backup.print) return JSON.stringify(dbPrintOf(home)) !== JSON.stringify(backup.print);
  let copied = null;
  try { copied = statSync(join(backup.dir, 'node.db')).mtimeMs; } catch { return false; }
  for (const f of ['node.db', 'node.db-wal']) { try { if (statSync(join(home, f)).mtimeMs > copied) return true; } catch { /* not there */ } }
  return false;
}
/** Copy the node's files into backups/<stamp>/: { dir, files, print }. */
export function backupNode(home, stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  const dir = join(home, 'backups', stamp);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = [];
  const print = dbPrintOf(home);
  for (const f of NODE_FILES) if (existsSync(join(home, f))) { copyFileSync(join(home, f), join(dir, f)); files.push(f); }
  return { dir, files, print };
}
// ROOM FOR THE BACKUP BEFORE ANYTHING STOPS (kanban #1440, audit 8 O8-1): a full disk while node.db was copied threw after the node was stopped.
// The update is refused, the node running, unless the disk holds a copy of the node's files (node.db, about 1 GB on a seat, and its WAL) plus
// a margin - and `extra` (the auto updater: the new release's archive and its unpacked tree). A system that cannot say its free space is not refused.
export const BACKUP_MARGIN_BYTES = 64 * 2 ** 20;
export const freeBytesAt = (dir) => { const s = statfsSync(dir); return Number(s.bavail) * Number(s.bsize); };
const mbText = (n) => `${Math.round(n / 2 ** 20)} MB`;
export function roomForUpdate(home, { extra = 0, freeBytes = freeBytesAt } = {}) {
  let need = BACKUP_MARGIN_BYTES + extra;
  for (const f of NODE_FILES) { try { need += statSync(join(home, f)).size; } catch { /* not there */ } }
  let free;
  try { free = freeBytes(home); } catch { return { ok: true, need, free: null }; }
  if (!Number.isFinite(free) || free >= need) return { ok: true, need, free };
  return { ok: false, need, free, why: `not enough free disk space at ${home}: ${mbText(free)} free, the update needs ${mbText(need)} (a backup of your node${extra ? ' and the new release' : ''}) - nothing was stopped` };
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

// THE UPDATE'S JOURNAL (kanban #1166, the state machine audit 2026-11-06): the move went running old -> stopped -> backed up -> new units ->
// started -> verified -> kept or rolled back, with the old unit texts and the backup's path in memory only. An updater that died after
// writing the units left the node on unverified units, and the next run saw the new release "running" and never verified or rolled back.
// Now <home>/update-journal.json (atomic) holds them before the first unit is written, and every move of its one enum is compare-and-set:
//
//   STOPPING -> BACKED_UP -> UNITS_WRITTEN -> STARTED -> KEPT
//       \-----------\-------------\-------------\-----> ROLLING_BACK -> ROLLED_BACK     (KEPT and ROLLED_BACK never change)
//
// A journal left in any other phase is finished by the next update or the auto-updater's start (resumeUpdate): units not all written ->
// the old ones back; written -> kept only if the new release answers as the same node with its version, else rolled back.
// THE DATABASE IS NOT ROLLED BACK ONCE THE NEW RELEASE ANSWERED (`served`): from then it could sign (nonces, locks, entries), and a node.db
// put back from before would forget it - nonce reuse. Only the settings go back then; the old release opens the database as the new one
// left it (its migrations add, they do not take away). A release that never answered gets the whole backup back, its own WAL dropped.
export const UPDATE_PHASE = Object.freeze({ STOPPING: 'stopping', BACKED_UP: 'backed-up', UNITS_WRITTEN: 'units-written', STARTED: 'started', KEPT: 'kept', ROLLING_BACK: 'rolling-back', ROLLED_BACK: 'rolled-back' });
const U = UPDATE_PHASE;
const UPDATE_MOVES = Object.freeze({ [U.STOPPING]: [U.BACKED_UP, U.ROLLING_BACK], [U.BACKED_UP]: [U.UNITS_WRITTEN, U.ROLLING_BACK], [U.UNITS_WRITTEN]: [U.STARTED, U.ROLLING_BACK], [U.STARTED]: [U.KEPT, U.ROLLING_BACK],
  [U.ROLLING_BACK]: [U.ROLLED_BACK], [U.KEPT]: [], [U.ROLLED_BACK]: [] });
export const journalFile = (home) => join(home, 'update-journal.json');
/** The journal as it is on disk, or null (none; a node that never updated with this release). */
export function readJournal(home) { try { return JSON.parse(readFileSync(journalFile(home), 'utf8')); } catch { return null; } }
/** A journal not in KEPT or ROLLED_BACK: an update that did not finish. */
export const openJournal = (j) => !!j && !(j.phase === U.KEPT || j.phase === U.ROLLED_BACK);
/** THE ONE TRANSITION: journal `id` from the phase it is in to `to`, with `extra` - refused (throws) when it is not that journal, or not a move there is. */
export function journalStep(home, id, to, extra = {}, { nowMs = Date.now() } = {}) {
  const now = readJournal(home);
  if (!now || now.id !== id || !(UPDATE_MOVES[now.phase] || []).includes(to)) throw new Error(`update journal: ${now ? `${now.phase}` : 'none'} -> ${to} is no move of update ${id}`);
  const next = { ...now, ...extra, phase: to, at: { ...(now.at || {}), [to]: nowMs } };
  atomicWrite(journalFile(home), JSON.stringify(next, null, 2) + '\n');
  return next;
}
/** A field noted on the open journal (no move): the new release answered (`served`). */
function journalNote(home, id, extra) {
  const now = readJournal(home);
  if (now && now.id === id && openJournal(now)) atomicWrite(journalFile(home), JSON.stringify({ ...now, ...extra }, null, 2) + '\n');
}
/** A new journal, STOPPING (written before anything stops) - only over none, or one that ended (an open one is resumed first, never written over). */
export function beginJournal(home, j, { nowMs = Date.now() } = {}) {
  const was = readJournal(home);
  if (openJournal(was)) throw new Error(`an update of this node did not finish (${was.from} -> ${was.to}, ${was.phase}): it is finished first`);
  const next = { id: `${nowMs}-${process.pid}`, ...j, phase: U.STOPPING, at: { [U.STOPPING]: nowMs } };
  atomicWrite(journalFile(home), JSON.stringify(next, null, 2) + '\n');
  return next;
}
/** The files of the backup that hold what a running seat writes (its signing state): not put back once the new release answered. */
export const SEAT_DATA_FILES = Object.freeze(['node.db', 'node.db-wal', 'node.db-shm', 'node.db.owner.json', 'node.db.operator-tokens.json']);
/** Never put back by a rollback: the update does not change them, and the state may hold what another process recorded meanwhile (kanban #1165). */
const NEVER_RESTORED = new Set(['state.json', 'seed.hex']);

/** THE ROLLBACK: the old service files, the backup (as `keepDb` says), the old release started. { put, back, dbKept } */
async function rollBack({ svc, home, moving, oldTexts, migrating, confFile, backup, keepDb, to, port, fetcher, waitMs, sleep }) {
  // started whatever the restore says (measured in the Windows VM: copying the backup back threw while the stopped seat still held its
  // database, and the node was left with nothing running)
  try { await svc.stop(moving, to); } catch { /* the start below is what matters */ }
  // and nothing here throws before that start (kanban #1440): a service file or arena.conf that cannot be written is named, not fatal
  const notPut = [];
  for (const [f, t] of Object.entries(oldTexts)) { try { writeFileSync(f, t); } catch (e) { notPut.push(`${String(f).split(/[\\/]/).pop()}: ${e.code || e.message}`); } }
  if (migrating && backup) { try { rmSync(confFile, { force: true }); } catch (e) { notPut.push(`arena.conf: ${e.code || e.message}`); } }
  // stopped before its backup (STOPPING): nothing was changed yet - the old services start again
  const files = backup ? backup.files.filter((f) => !NEVER_RESTORED.has(f) && !(keepDb && SEAT_DATA_FILES.includes(f))) : [];
  let put = backup ? { ok: false, failed: ['not tried'] } : { ok: true, failed: [] };
  if (backup) try {
    put = await restoreNode(home, { ...backup, files }, { pause: sleep });
    // the database put back: a WAL the new release left beside it belongs to the newer file - replayed on the old one it would corrupt it
    if (!keepDb && files.includes('node.db')) for (const f of ['node.db-wal', 'node.db-shm']) if (!backup.files.includes(f)) rmSync(join(home, f), { force: true });
  } catch (e) { put = { ok: false, failed: [e.message] }; }
  if (notPut.length) put = { ok: false, failed: [...(put.ok ? [] : put.failed), ...notPut] };
  try { await svc.start(moving); } catch { /* the answer below says whether it runs */ }
  const back = await waitHealthy({ port, fetcher, waitMs });
  return { put, back, dbKept: !!keepDb };
}

/**
 * AN UPDATE THAT DID NOT FINISH, FINISHED (kanban #1166): the journal's update - its updater gone (this one holds the update lock) -
 * kept if its new release answers as the same node with its version, else rolled back. Answers null (nothing open) or
 * { resumed: 'kept' | 'rolled-back', from, to, ... }.
 */
export async function resumeUpdate({ home, env = process.env, sh = run, fetcher = fetch, platform = process.platform, node = process.execPath, waitMs = null,
  sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), log = () => {} }) {
  waitMs = waitMs ?? 300000;
  const j = readJournal(home);
  if (!openJournal(j)) return null;
  const svc = servicesOf({ platform, env, sh, home, port: j.port, node });
  const moving = Object.keys(j.oldTexts || {});
  let served = !!j.served, keep = false, why = `the update stopped at ${j.phase}`;
  if (j.phase === U.UNITS_WRITTEN || j.phase === U.STARTED) {
    // the new units are written: the new release may run, or may not have been started
    if (j.phase === U.UNITS_WRITTEN) { await svc.start(moving).catch(() => null); journalStep(home, j.id, U.STARTED); }
    const after = await waitHealthy({ port: j.port, fetcher, waitMs });
    const same = after.ok && (!j.identityBefore || after.identity === j.identityBefore);
    if (same) served = true;
    const want = releaseIdOf(j.to);
    const answered = same && want.version ? await versionAnswers({ port: j.port, fetcher, want, waitMs: Math.min(waitMs, 120000) }) : { ok: same };
    keep = !!answered.ok;
    why = !after.ok ? `the new release does not answer (${after.why})` : !same ? 'the new release answers as another node' : answered.ok ? 'the new release answers as the same node' : answered.why;
  }
  log(`#1166 an unfinished update ${j.from} -> ${j.to} (${j.phase}): ${why} - ${keep ? 'kept' : 'rolled back'}`);
  if (keep) {
    nodeState(home).update((n) => ({ ...(j.reachUrl ? { reach: { ...n.reach, url: j.reachUrl } } : {}), release: { path: j.to, from: j.from, atMs: Date.now(), resumed: true } }));
    const envFile = join(home, 'node.env');
    if (j.migrating && existsSync(envFile)) renameSync(envFile, `${envFile}.migrated`);
    try { writeCommand({ home, release: j.to, node, platform, env, run: sh }); } catch { /* the next update writes it */ }
    journalStep(home, j.id, U.KEPT);
    return { resumed: 'kept', from: j.from, to: j.to, why };
  }
  // a database written since the backup is kept whatever `served` says (kanban #1227) - asked only BEFORE the rollback began: a journal already
  // at ROLLING_BACK holds the decision (`served`), made before any file was copied back (kanban #2630, state audit 2026-11-12 SM-I3: an
  // updater killed while restoreNode copied the backup over node.db left a half copy whose size and mtime differ from the print, and the
  // resume read its own torn copy as "changed since the backup: kept" and started the old release on it). The copy is done again from the start.
  if (j.phase !== U.ROLLING_BACK && !served && dbChangedSince(home, j.backup)) { served = true; why += '; node.db changed since the backup: kept'; }
  if (j.phase !== U.ROLLING_BACK) journalStep(home, j.id, U.ROLLING_BACK, { served, why });
  const r = await rollBack({ svc, home, moving, oldTexts: j.oldTexts || {}, migrating: j.migrating, confFile: join(home, 'arena.conf'), backup: j.backup, keepDb: served,
    to: j.to, port: j.port, fetcher, waitMs, sleep });
  journalStep(home, j.id, U.ROLLED_BACK, { restored: r.back.ok, dbKept: r.dbKept });
  // A ROLLBACK THE RESUME MADE IS RECORDED AS THE AUTO UPDATER RECORDS ITS OWN (kanban #1581, audit #1489 sm1-node-2): without it the #1369
  // day's wait never applied to a release whose updater died, and the first check after the service's restart (or the move right after this
  // resume inside updateNode) stopped the node again for the same broken release - every ~10 min for good when it kills the updater each time
  const id = releaseIdOf(j.to);
  if (id.version) {
    try { writeFileSync(join(home, 'auto-update.json'), JSON.stringify({ atMs: Date.now(), ok: false, from: releaseIdOf(j.from).version, to: id.version, why, rolledBack: true, resumed: true, ...(id.commit ? { commit: id.commit } : {}) }, null, 2) + '\n', { mode: 0o600 }); }
    catch { /* the log has it */ }
  }
  return { resumed: 'rolled-back', from: j.from, to: j.to, why, restored: r.back.ok, dbKept: r.dbKept, ...(r.put.ok ? {} : { notRestored: r.put.failed }) };
}

/** The release a launchd agent runs: its WorkingDirectory less packages/arena-node. */
export function releaseOfPlist(text) {
  // whitespace between key and value allowed: an agent saved again by plutil or PlistBuddy puts each on its own line (kanban #574,
  // 2026-10-22: the three test installers' agents, re-saved when a variable was added by hand, read as "no service names a release")
  const m = /<key>WorkingDirectory<\/key>\s*<string>(.+?)\/packages\/arena-node<\/string>/.exec(String(text || ''));
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null;
}

/** The variables a launchd agent sets: its EnvironmentVariables dict, { name: value } ({} when it has none). */
export function envOfPlist(text) {
  const d = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(String(text || ''));
  const out = {};
  if (d) for (const m of d[1].matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) out[unxml(m[1])] = unxml(m[2]);
  return out;
}
const unxml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

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
      seatFor: (release, old) => launchdPlist({ node, release, home, port, boot: !/<key>RunAtLoad<\/key>\s*<false\/>/.test(old), env: envOfPlist(old) }), seatFile,
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
        // FIRST THE LAUNCHERS' OWN cmd.exe (kanban #1443): a launcher starts its program again when it ends with an error, so ending the
        // program alone would let the loop start the old release again mid-update. Each cmd.exe running one of these files is ended (not
        // its tree: a program it started is ended by its folder below, and this update's own process is never one of them)
        const mine = fs.map((f) => String(f).replace(/\//g, '\\').toLowerCase());
        const launchers = mine.length ? `$files = @(${mine.map((f) => `'${q(f)}'`).join(', ')}); Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.ProcessId -ne $PID } | Where-Object { $c = $_.CommandLine.Replace('/', '\\').ToLower(); @($files | Where-Object { $c.Contains($_) }).Count -gt 0 } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; ` : '';
        const r = await ps(`${launchers}Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\\') -like '*\\${q(folder)}\\*' -and $_.ProcessId -ne ${Number(selfPid)} -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
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
    bridgeFor: (release, state) => bridgeUnit({ node, release, home, bridgePort: bridgePortOf(home, state) }),
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
/** The seat's last log lines: the user unit's journal on Linux, node.log in the node's home elsewhere (at most `n` lines, 300 characters each). */
export async function seatLogTail({ home, platform = process.platform, sh = run, n = 12, unit = UNIT }) {
  let text = '';
  if (platform === 'linux') {
    const r = await sh('journalctl', ['--user', '-u', unit, '-n', String(n), '--no-pager', '-o', 'cat']);
    text = r && r.ok ? r.out || '' : '';
  } else {
    try { text = readFileSync(join(home, 'node.log'), 'utf8'); } catch { text = ''; }
  }
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).map((l) => l.slice(0, 300));
}

/**
 * THE MOVE REPORTED, 0 TO 100 % (kanban #706): `progress` takes { pct, step, detail } at each step (update-progress.js), then { done } -
 * or { failed, step, why }: the step it failed at, and why.
 */
/**
 * ONE UPDATE OF A NODE AT A TIME (kanban #809, 2026-10-30: "Node doesn't start", exit 78 after 2026.1.9.19): the desktop app's update
 * and the auto-updater moved the same node to 2026.1.9.19 at once - two backups 2 s apart - and the one that finished second removed, as an
 * older release, the folder the other had already moved the services to; launchd could not even enter it. `<home>/update.lock` names the
 * update that holds the node ({ pid, atMs }); another waits for it (up to `waitLockMs`), and one whose holder has ended or is older than
 * `staleMs` is taken over.
 */
// THE MACHINE'S START, IN MINUTES (kanban #1166): a lock taken before the machine last started is no lock - its pid may be any process now
// (a reboot reused it, and the lock blocked updates for up to 45 min). Read from the uptime, the same on every system; a minute either way
export const bootMinute = (now = Date.now(), up = uptime()) => Math.round((now - up * 1000) / 60000);
export async function takeUpdateLock(home, { pid = process.pid, now = Date.now, alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
  waitLockMs = 20 * 60000, staleMs = 45 * 60000, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), onWait = () => {}, boot = bootMinute() } = {}) {
  // no node home, nothing to hold: the update says itself why it cannot move it
  if (!home || !existsSync(home)) return { file: null, waited: false, release: () => {} };
  const file = join(home, 'update.lock');
  const t0 = now();
  let waited = false;
  for (;;) {
    try { writeFileSync(file, JSON.stringify({ pid, atMs: now(), boot }), { flag: 'wx' }); return { file, waited, release: () => { try { const h = JSON.parse(readFileSync(file, 'utf8')); if (h.pid === pid) rmSync(file, { force: true }); } catch { /* gone */ } } }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    let held = null; try { held = JSON.parse(readFileSync(file, 'utf8')); } catch { /* half written or gone: read again */ }
    // left over: from before the machine started (a lock an older updater wrote names no boot: its pid and age decide, as before), its process gone, or too old
    const beforeBoot = held && Number.isFinite(held.boot) && Math.abs(held.boot - boot) > 2;
    if (held && (beforeBoot || !alive(held.pid) || now() - held.atMs > staleMs)) { rmSync(file, { force: true }); continue; }
    if (now() - t0 > waitLockMs) throw new Error(`another update of this node is still running (pid ${held ? held.pid : '?'}); try again when it has ended`);
    if (!waited) onWait(held); waited = true;
    await sleep(2000);
  }
}

export async function updateNode({ progress = () => {}, lock = takeUpdateLock, ...o }) {
  let at = { pct: 0, step: 'Checking the new release' };
  const say = (pct, step, detail = '') => { at = { pct: pct ?? at.pct, step, detail }; try { progress(at); } catch { /* a reporter never stops the update */ } };
  const end = (p) => { try { progress(p); } catch { /* the same */ } };
  let held;
  try { held = await lock(o.home, { onWait: () => say(at.pct, 'Waiting for the other update of this node to finish') }); }
  catch (e) { end({ failed: true, pct: at.pct, step: at.step, why: e.message }); throw e; }
  let r;
  try {
    // AN UPDATE THAT DID NOT FINISH (its updater died) is finished first - kept or rolled back - before this one reads what runs (kanban #1166)
    let resumed = null;
    try { resumed = await resumeUpdate({ ...o }); } catch (e) { end({ failed: true, pct: at.pct, step: 'Finishing the update before', why: e.message }); throw e; }
    // THE RELEASE THE RESUME JUST ROLLED BACK is not moved to again in the same call (kanban #1581): the auto updater says so
    // (retryRolledBack false); `bitcoinarena update` (force) and a release given by hand move as before
    if (resumed && resumed.resumed === 'rolled-back' && resumed.to === o.newRelease && o.retryRolledBack === false)
      r = { ok: false, rolledBack: true, why: `the unfinished update to this release was rolled back just now: ${resumed.why}`, restored: resumed.restored };
    else try { r = await moveNode({ ...o, say, failedAt: () => at.step }); } catch (e) { end({ failed: true, pct: at.pct, step: at.step, why: e.message }); throw e; }
    // the unfinished update was this one, and its release is kept now: done
    if (resumed && resumed.resumed === 'kept' && resumed.to === o.newRelease && !r.ok && r.why === 'that release is the one running') r = { ok: true, already: true, to: o.newRelease, from: resumed.from };
    if (resumed) r = { ...r, resumed };
    // the other update moved the node to this very release while this one waited: done, nothing to move
    if (!r.ok && held.waited && r.why === 'that release is the one running') r = { ok: true, already: true, to: o.newRelease };
  } finally { held.release(); }
  if (r.ok) end({ done: true, pct: 100 });
  else end({ failed: true, pct: at.pct, step: r.failedAt || at.step, why: r.rolledBack ? `${r.why}. ${r.restored ? 'The old release runs again.' : 'The old release was started again but does not answer.'}` : r.why });
  return r;
}

async function moveNode({ home, newRelease, port, node = process.execPath, asset = null, sums = null, sig = null, env = process.env, sh = run,
  fetcher = fetch, nowMs = () => Date.now(), waitMs = null, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), platform = process.platform,
  quickUrl = quickTunnelUrl, restartService = (id, o) => control('restart', id, o), installUpdaterFn = null, fetchApps = ensureApps, arch = process.arch,
  lndKit = { installLnd }, refreshGames = async (o) => (await import('./change-roles.js')).refreshHostedGames(o), trace: given = QUIET,
  say = () => {}, failedAt = () => null, freeBytes = freeBytesAt, allowOlder = false }) {
  // EVERY STEP SAID AT --verbose, WITH ITS TIME; THE DECISIONS AT --debug (kanban #693, 2026-10-26: "shows more info on what its doing, what
  // is going wrong etc")
  const trace = given.tag('update');
  const t00 = performance.now();
  const step = (text) => trace.verbose(`${text} (+${Math.round(performance.now() - t00)} ms)`);
  // A WINDOWS SEAT STARTS SLOWER (measured in the Windows VM 2026-10-18, rc.14 -> rc.20: the seat logged "[games] hosting nextblock",
  // its last start-up line, at 23:24:36 - the 90 s wait had ended at 23:24:41 and rolled a sound release back): five minutes there
  // 300 s everywhere (kanban #663, Linux 2026-10-25: "the node did not answer on port 8470 within 90 s" updating to 2026.1.8 and 1.9 - a
  // node that loads every version of its games, with their cores, can take longer than 90 s to answer on a small machine)
  waitMs = waitMs ?? 300000;
  // the version said in the steps: the release's VERSION, else its folder
  const label = releaseIdOf(newRelease).version || String(newRelease).split(/[\\/]/).filter(Boolean).pop();
  say(0, 'Checking the new release', label);
  if (asset) {
    const c = checkAsset({ file: asset, sums, sig });
    if (!c.ok) return { ok: false, why: c.why };
  }
  if (!existsSync(join(home, 'state.json')) || !(existsSync(join(home, 'arena.conf')) || existsSync(join(home, 'node.env')))) return { ok: false, why: `no node is installed at ${home}` };
  // THE STATE READ BEFORE ANYTHING STOPS (kanban #1178): a state.json that does not read refuses the update here, with the node running -
  // it was read after the stop, and a parse error left the node stopped. Read through state.js: locked, atomic, its .bak if torn
  const nodeSt = nodeState(home);
  let state;
  try { state = nodeSt.read(); } catch (e) { return { ok: false, why: e.message }; }
  const svc = servicesOf({ platform, env, sh, home, port, node });
  const oldSeat = svc.seatText();
  const from = svc.releaseOf(oldSeat);
  step(`the seat's service ${svc.where} ${oldSeat === null ? 'is missing' : `runs ${from || '(no release named)'}`}; moving to ${newRelease}, seat port ${port}`);
  if (!from) return { ok: false, why: `no Bitcoin Arena service names a release (${svc.where})` };
  if (from === newRelease) return { ok: false, why: 'that release is the one running' };
  // NEVER BACK TO AN OLDER RELEASE UNASKED (kanban #2601, update audit): a signed asset is not a NEWER one - whoever serves the download (a mirror,
  // the website, the network path) could hand `--update` an old release's asset, SHA256SUMS and signature, all genuine, and the node went back to
  // a release with known holes. Both releases name their VERSION (inside the signed archive): the new one must not be older, unless the owner
  // says so (allowOlder: arena-install --update ... --allow-older)
  const [fromV, toV] = [releaseIdOf(from).version, releaseIdOf(newRelease).version];
  if (!allowOlder && fromV && toV && newerVersion(fromV, toV)) return { ok: false, why: `release ${toV} is older than the release this node runs (${fromV}): not moved back (--allow-older to mean it)` };
  // THE NEW RELEASE'S APPS (kanban #575): downloaded and checked before anything is stopped - an app that cannot be fetched leaves the
  // node running as it is
  say(2, `Getting the apps of ${label}`);
  const apps = await fetchApps({ release: newRelease, home, fetcher });
  step(`the new release's apps: ${apps.ok ? 'fetched and checked' : apps.why}`);
  if (!apps.ok) return { ok: false, why: `the new release's apps: ${apps.why}` };
  // and the LND this release pins, fetched and checked before anything is stopped (staleLnd): its service then names it
  const svcFiles = svc.files();
  const lnd = staleLnd(svcFiles.map((f) => readFileSync(f, 'utf8')), { platform, arch });
  const lndFile = lnd ? svcFiles[lnd.index] : null;
  trace.debug(`LND: ${lnd ? `${lnd.from} runs, this release pins ${lnd.to} (${lndFile})` : 'the pinned one runs, or none'}`);
  if (lnd) {
    say(12, `Getting Lightning (LND ${lnd.to})`);
    const got = await lndKit.installLnd({ home, platform, arch, fetcher });
    step(`the pinned LND ${lnd.to}: ${got.ok ? 'installed' : got.why}`);
    if (!got.ok) return { ok: false, why: `the pinned LND (${lnd.to}): ${got.why}` };
  }
  say(20, 'Checking your node before it stops');
  const before = await waitHealthy({ port, fetcher, waitMs: 10000, everyMs: 500 });
  step(`before: the seat on port ${port} ${before.ok ? `answers as ${before.identity.slice(0, 16)}…` : `does not answer (${before.why}): any key will do after`}`);
  // the node's services that run from the old release: the seat, and every other one naming it - or naming an OLDER release beside it
  // (measured 2026-10-19 in the Windows VM: arena-custody.cmd still named rc.25 after updates to 0.1.1, 2026.1.0 and 2026.1.1 - each update
  // moved only the launchers naming the release it updated from, so the custody agent, its guardian and gateway stayed on rc.25)
  const releasesDir = from.replace(/[\\/][^\\/]+[\\/]?$/, '');
  // a release of either name (kanban #688: since 2026.1.8 the folders are bitcoin-arena-node-<v>-..., and this matched none of them)
  const olderRe = new RegExp(`${releasesDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/](?:bitcoin-)?arena-node-[^\\\\/"'\\s]+`, 'g');
  const oldersIn = (t) => [...new Set(t.match(olderRe) || [])].filter((x) => x !== from && x !== newRelease && !String(newRelease).startsWith(x));
  // A SERVICE LEFT ON A PATH THAT IS GONE (kanban #818, a friend's gateway 2026-10-30: "die Pfad Struktur [hat] sich geändert ... das wurde nicht
  // migriert"): a release under another home - the layout before this one - is in none of the above, so that file was never moved and kept
  // starting a program that no longer exists. It names the old home, so its data paths move with it. A path that still exists is left alone.
  const staleHomesIn = (t) => staleHomesOf(t, { home, releasesDir });
  const moving = svcFiles.filter((f) => { const t = readFileSync(f, 'utf8'); return f === svc.seatFile || f === lndFile || t.includes(from) || oldersIn(t).length > 0 || staleHomesIn(t).length > 0; });
  const oldTexts = new Map(moving.map((f) => [f, readFileSync(f, 'utf8')]));
  step(`${moving.length} of ${svcFiles.length} service file(s) move: ${moving.map((f) => f.split(/[\\/]/).pop()).join(', ')}`);
  trace.debug(`not moved (they name neither ${from} nor an older release): ${svcFiles.filter((f) => !moving.includes(f)).map((f) => f.split(/[\\/]/).pop()).join(', ') || 'none'}`);

  if (inSeatingWindow(nowMs())) { step('inside a market seating window (minutes 11-14 of a quarter hour): waiting it out before anything stops'); say(22, 'Waiting until this round\'s committee is seated, so the restart does not cost your node its seat', 'up to 3 minutes'); }
  while (inSeatingWindow(nowMs())) await sleep(5000);
  // THE JOURNAL BEFORE ANYTHING STOPS (kanban #1166): the old service files, the way back, written where an updater that dies finds it
  const envFile = join(home, 'node.env');
  const confFile = join(home, 'arena.conf');
  const migrating = !existsSync(confFile);
  const room = roomForUpdate(home, { freeBytes });
  step(`free disk space: ${room.free === null ? 'not said by this system' : `${mbText(room.free)}, the backup needs ${mbText(room.need)}`}`);
  if (!room.ok) return { ok: false, why: room.why };
  let journal = beginJournal(home, { from, to: newRelease, port, platform, migrating, identityBefore: before.ok ? before.identity : null, oldTexts: Object.fromEntries(oldTexts) });
  let backup = null;
  // ANY FAILURE AFTER THE JOURNAL BEGAN IS ROLLED BACK (kanban #1440, audit 8 O8-1: a backup that threw on a full disk left the node stopped, its
  // journal at `stopping`; the next check 30 min later started the old release and stopped it again, for good): the old service files, the
  // backup if one was made, the old release started, the journal ended ROLLED_BACK, and the update answered rolled back - so the auto updater
  // records it and waits a day (#1369). A failure after KEPT is no failure of the move: the new release runs, and it is thrown as before.
  const failedAfterStop = async (e) => {
    const j = readJournal(home);
    if (!j || j.id !== journal.id || !openJournal(j)) throw e;
    const failedStep = failedAt();
    step(`failed after the node was stopped (${failedStep || j.phase}): ${e.message}; rolling back`);
    say(null, `Going back to ${releaseIdOf(from).version || 'the release it ran'}`);
    const bk = backup || j.backup || null;
    // the decision of a rollback already begun stands (kanban #2630): its own partial copy is no write of the seat
    const keepDb = !!j.served || (j.phase !== U.ROLLING_BACK && dbChangedSince(home, bk));
    try { if (j.phase !== U.ROLLING_BACK) journalStep(home, j.id, U.ROLLING_BACK, { served: keepDb, why: e.message }); } catch { /* the resume finishes it */ }
    const { put, back, dbKept } = await rollBack({ svc, home, moving, oldTexts: Object.fromEntries(oldTexts), migrating, confFile, backup: bk, keepDb, to: newRelease, port, fetcher, waitMs, sleep });
    try { journalStep(home, j.id, U.ROLLED_BACK, { restored: back.ok, dbKept }); } catch { /* the resume finishes it */ }
    step(`rolled back after the failure: the old release ${back.ok ? 'answers' : `does not answer (${back.why})`}${put.ok ? '' : `; not put back: ${put.failed.join(', ')}`}`);
    return { ok: false, rolledBack: true, from, to: newRelease, backup: bk ? bk.dir : null, failedAt: failedStep, dbKept,
      why: `the update failed after your node was stopped: ${e.message}`, restored: back.ok, ...(put.ok ? {} : { notRestored: put.failed }) };
  };
  try {
    say(24, 'Stopping your node');
    await svc.prepare(newRelease);
    const stop = await svc.stop(moving, from);
    step(`stopped: ${stop.ok ? 'ok' : stop.why}`);
    if (!stop.ok) {
      // the old services start again: nothing was changed
      journal = journalStep(home, journal.id, U.ROLLING_BACK, { why: stop.why });
      await svc.start(moving).catch(() => null);
      journalStep(home, journal.id, U.ROLLED_BACK);
      return { ok: false, why: stop.why };
    }
    // and the processes of those older releases (Windows ends a release's processes by its folder; elsewhere the units above stop them)
    const olders = [...new Set(moving.flatMap((f) => oldersIn(oldTexts.get(f))))];
    if (platform === 'win32') for (const o of olders) await svc.stop([], o);
    // NOTHING OF AN OLDER RELEASE STILL RUNS (kanban #546): after the stop the process list is asked; a leftover is ended and named. Every
    // release beside the new one counts, named by a launcher or not (measured 2026-10-20 04:41Z in the Windows VM, .901 -> .902 by hand:
    // the updater's child still ran 2026.1.1, which no launcher named any more, so a check of the release updated from missed it)
    const newFolder = String(newRelease).split(/[\\/]/).filter(Boolean).pop();
    const besides = (() => { try { return readdirSync(releasesDir).filter((d) => /^(bitcoin-)?arena-node-/.test(d) && d !== newFolder).map((d) => join(releasesDir, d)); } catch { return []; } })();
    const oldFolders = [...new Set([from, ...olders, ...besides])];
    const leftAfterStop = svc.leftovers ? await svc.leftovers(oldFolders) : [];
    if (leftAfterStop.length && svc.end) await svc.end(leftAfterStop.map((x) => x.pid));
    if (leftAfterStop.length) step(`still running from an older release after the stop, ended: ${leftAfterStop.map((x) => `${x.name} ${x.pid}`).join(', ')}`);
    say(32, 'Backing up your node');
    backup = backupNode(home);
    step(`backed up ${backup.files.length} file(s) into ${backup.dir}: ${backup.files.join(', ')}`);
    journal = journalStep(home, journal.id, U.BACKED_UP, { backup });
    say(36, `Writing the settings for ${label}`);
    // THE SETTINGS: arena.conf, its paths into an older release moved to the new one. A node from before it ran from
    // node.env: its settings are moved into arena.conf here, once (node.env stays until the new release answers, then is kept as
    // node.env.migrated; a rollback takes arena.conf away again and the old release reads node.env as before)
    const locks = stakeLockSetupOf({ home, release: newRelease, platform });   // kanban #824: an installed node has none of these yet
    trace.debug(migrating ? 'arena.conf is missing: the settings move from node.env into it (once)' : 'arena.conf: its paths into an older release move to the new one, renamed keys take their new names');
    if (migrating) {
      const values = { network: state.network || 'testnet4', ...renameValues(envToConfValues(envForRelease(readFileSync(envFile, 'utf8'), newRelease), { port, database: join(home, 'node.db') })) };
      if (INSTANCE && !values.instance) values.instance = INSTANCE;
      if (PORT_OFFSET && !values.port_offset) values.port_offset = String(PORT_OFFSET);
      if (locks && !values.stake_lock_bin) { values.stake_lock_bin = locks.bin; values.federation_client_dir = locks.clientDir; }
      writeFileSync(confFile, formatConf(values, { eol: platform === 'win32' ? '\r\n' : '\n', header: 'moved from node.env by an update' }), { mode: 0o600 });
    } else {
      const confText = readFileSync(confFile, 'utf8');
      // and a key that took a new name under it, once (kanban #569: games= is apps=)
      let want = ''; try { want = appsSetting(state, newRelease); } catch { want = ''; }
      const confNew = withNewAppVersions(withStakeLocks(renameKeys(envForRelease(confText, newRelease)), locks), newRelease, want);
      if (confNew !== confText) writeFileSync(confFile, confNew, { mode: 0o600 });
    }
    // A CHAIN BRIDGE THE NODE NO LONGER READS (the owner's services card on 2026.1.9.9: "Do I need electrum when I have bitcoin core installed
    // and running?"): a node on its own Core keeps no bridge of its interim Electrum chain - it is taken away, not moved (removeProgram)
    const noBridge = !!(state.chain && state.chain.kind === 'core');
    // ANY NODE'S BRIDGE OF THIS MACHINE, by its own name (kanban #719: the update of the owner's second node looked for arena-chain-bridge.service,
    // the name of the process's own node, and left arena-chain-bridge--2.service restarting 840 times) - `moving` holds this node's files only
    const isBridge = (f) => { const b = f.split(/[\\/]/).pop(); return b === BRIDGE_UNIT || /^arena-chain-bridge(--[a-z0-9]+)?\.service$/.test(b) || b === `${LAUNCHD_LABEL}.chain-bridge.plist` || /^arena-chain-bridge(--[a-z0-9]+)?\.cmd$/.test(b); };
    if (noBridge && moving.some(isBridge)) {
      const bridgeUnit = moving.map((f) => f.split(/[\\/]/).pop()).find((b) => /\.service$/.test(b) && isBridge(b)) || null;
      await removeProgram({ id: 'chain-bridge', home, env, sh, platform, unit: bridgeUnit });
      step('the chain bridge of the interim Electrum chain was taken away: this node reads its own Bitcoin Core');
    }
    for (const f of moving) {
      if (noBridge && isBridge(f)) continue;
      const moved = f === svc.seatFile ? svc.seatFor(newRelease, oldTexts.get(f))
        : svc.bridgeFor && f.endsWith(BRIDGE_UNIT) ? svc.bridgeFor(newRelease, state)
          : staleHomesIn(oldTexts.get(f)).reduce((t, h) => t.replace(new RegExp(`${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]releases[\\\\/](?:bitcoin-)?arena-node-[^\\\\/"'\\s<>]+`, 'g'), newRelease).split(h).join(home),
            oldersIn(oldTexts.get(f)).reduce((t, o) => t.split(o).join(newRelease), oldTexts.get(f).split(from).join(newRelease)));
      // an agent an older installer wrote runs throttled at priority 20 (kanban #1122): it moves as Interactive
      const swapped = f === lndFile ? lnd.swap(moved) : moved;
      // a Windows launcher written before the restart loop gets it (kanban #1443); the seat's is written whole above
      const looped = platform === 'win32' && f.endsWith('.cmd') && f !== svc.seatFile ? withWindowsRestart(swapped, /arena-tunnel(--[a-z0-9]+)?\.cmd$/.test(f) ? 10 : 30) : swapped;
      const text = f.endsWith('.plist') ? interactivePlist(looped) : looped;
      // the gateway of an older install gets its own metrics port (gateway.js: by itself it took the liquidity provider's)
      writeFileSync(f, /gateway/.test(f.split(/[\\/]/).pop()) ? gatewayMetricsOwn(text) : text);
    }
    step(`wrote the service files for the new release${lnd ? ` (and LND ${lnd.to})` : ''}`);
    journal = journalStep(home, journal.id, U.UNITS_WRITTEN);
    // A QUICK TUNNEL COMES BACK UNDER A NEW NAME (measured on the test host, node A rc.16 -> rc.18: the tunnel restarted as
    // cult-turns-….trycloudflare.com while node.env still named conventional-cube-…, so the node's public address, its guardian endpoint
    // and the advert its bond posts named a host that no longer answers). The tunnel starts first, its new name is read from its log,
    // the settings take the new host, and only then the seat starts - no second restart (on Windows stopping one launcher ends them all).
    const isTunnel = (f) => { const b = f.split(/[\\/]/).pop(); return b === TUNNEL_UNIT || b === `${LAUNCHD_LABEL}.tunnel.plist` || b === 'arena-tunnel.cmd'; };
    const tunnels = state.reach && state.reach.mode === 'quick' && state.reach.url ? moving.filter(isTunnel) : [];
    let reachUrl = null, tunnelStarted = { ok: true };
    if (tunnels.length) {
      say(40, 'Starting the tunnel');
      const startAt = Date.now();
      tunnelStarted = await svc.start(tunnels);
      const url = await quickUrl({ unit: TUNNEL_UNIT, home, platform, sh, sinceMs: startAt });
      step(`the quick tunnel started first: ${url ? `it answers as ${url}${url !== state.reach.url ? `, not ${state.reach.url}: the files follow it` : ''}` : 'its new name was not read'}`);
      if (url && url !== state.reach.url) {
        const oldHost = new URL(state.reach.url).host, newHost = new URL(url).host;
        writeFileSync(confFile, readFileSync(confFile, 'utf8').split(oldHost).join(newHost), { mode: 0o600 });
        // and every service started after it that names the host - the gateway's --api-addr above all (measured in the Windows VM, 0.1.0 ->
        // 0.1.1: arena.conf took the new name, arena-gateway.cmd kept the old one, and the gateway announced a host that no longer answers)
        for (const f of moving) {
          if (tunnels.includes(f) || (noBridge && isBridge(f))) continue;
          const t = readFileSync(f, 'utf8');
          if (t.includes(oldHost)) writeFileSync(f, t.split(oldHost).join(newHost));
        }
        reachUrl = url;
      }
    }
    say(42, 'Starting your node');
    const rest = await svc.start(moving.filter((f) => !tunnels.includes(f) && !(noBridge && isBridge(f))));
    const started = !tunnelStarted.ok ? tunnelStarted : rest;
    journal = journalStep(home, journal.id, U.STARTED, reachUrl ? { reachUrl } : {});
    step(`started: ${started.ok ? 'ok' : started.why}; waiting up to ${Math.round(waitMs / 1000)} s for the seat to answer on port ${port}`);
    // THE FIRST ANSWER: nobody knows how long a node takes to load its games; the bar moves with each ask, 45 % towards 85 %, closer
    // the longer it takes (most answer within a minute), and the seconds are said
    const waitFrom = Date.now();
    say(45, "Waiting for your node's first answer");
    const asking = (url, o) => { const s = (Date.now() - waitFrom) / 1000; if (s >= 1) say(45 + 40 * (1 - Math.exp(-s / 60)), "Waiting for your node's first answer", `${Math.round(s)} s`); return fetcher(url, o); };
    const after = await waitHealthy({ port, fetcher: asking, waitMs });
    const sameKey = after.ok && (!before.ok || after.identity === before.identity);
    // from its first answer as this node the new release may sign: its database is never put back from before (kanban #1166)
    if (sameKey) journalNote(home, journal.id, { served: true, servedMs: nowMs() });
    step(`after: ${after.ok ? `the seat answers as ${after.identity.slice(0, 16)}…, ${sameKey ? 'the same node' : 'ANOTHER node'}` : `the seat did not answer: ${after.why}`}`);
    // THE NEW RELEASE, NOT THE OLD PROCESS (kanban #546): a release that names its version must answer with it and its commit
    const want = releaseIdOf(newRelease);
    if (sameKey && want.version) say(86, `Checking it runs ${label}`);
    const answered = sameKey && want.version ? await versionAnswers({ port, fetcher, want, waitMs: Math.min(waitMs, 120000) }) : { ok: sameKey };
    if (sameKey && want.version) step(`GET /owner/version: ${answered.ok ? `${answered.version} (${String(answered.commit).slice(0, 12)}), the new release` : answered.why}`);
    // and no process of an older release left after the start: ended and named, and if one will not end, no update
    let leftAfterStart = sameKey && answered.ok && svc.leftovers ? await svc.leftovers(oldFolders) : [];
    if (leftAfterStart.length && svc.end) { await svc.end(leftAfterStart.map((x) => x.pid)); await sleep(3000); }
    const stillLeft = leftAfterStart.length && svc.leftovers ? await svc.leftovers(oldFolders) : [];
    const same = sameKey && answered.ok && !stillLeft.length;
    if (leftAfterStart.length) step(`still running from an older release after the start, ended: ${leftAfterStart.map((x) => `${x.name} ${x.pid}`).join(', ')}${stillLeft.length ? `; would not end: ${stillLeft.map((x) => `${x.name} ${x.pid}`).join(', ')}` : ''}`);
    if (same) {
      say(92, 'Finishing up');
      // THE STATE AS IT STANDS NOW, NOT AS IT WAS READ MINUTES AGO (kanban #1178): what the seat, the owner page or the custody agent saved
      // while the update ran (an on-chain action, custody.pegIn) is kept; only the release and a quick tunnel's new name are set
      nodeSt.update((n) => ({ ...(reachUrl ? { reach: { ...n.reach, url: reachUrl } } : {}), release: { path: newRelease, from, atMs: nowMs() } }));
      if (migrating && existsSync(envFile)) renameSync(envFile, `${envFile}.migrated`);
      journal = journalStep(home, journal.id, U.KEPT);
      // the peer ports on this machine only, for a node installed before that was the default; those services restarted to take it
      let local = [];
      try {
        local = peerPortsLocal(home);
        for (const id of local) await restartService(id, { home, platform, env, sh });
      } catch (e) { local = [`not changed: ${e.message}`]; }
      // AND ON LINUX, LND STARTED ONCE ITS TOR ANSWERS (kanban #720): the two units' lines, then a daemon-reload
      if (platform === 'linux') {
        try {
          const units = lndWaitsForTor(home, { env });
          if (units.length) { await sh('systemctl', ['--user', 'daemon-reload']); local.push(...units); }
        } catch (e) { local.push(`LND/Tor units not changed: ${e.message}`); }
      }
      // THE AUTO UPDATE SERVICE for a node installed before it, once
      let updater = null;
      if (installUpdaterFn) {
        try { updater = await installUpdaterFn({ home, platform, env, sh }); } catch (e) { updater = { ok: false, why: e.message }; }
      }
      // the bitcoinarena command (and arenanode, the small script that runs it) runs the new release from now on
      let command = null;
      try {
        command = writeCommand({ home, release: newRelease, node, platform, env, run: sh });
        if (command.pathSet) { const r = await command.pathSet; delete command.pathSet; if (r && r.ok === false) command.why = `the user PATH was not changed: ${(r.err || r.out || '').trim().slice(0, 160)}`; }
      } catch (e) { command = { why: e.message }; }
      // and on Windows the updater running again - after the bitcoinarena command names the new release, which its loop CALLs (kanban #546)
      let updaterBack = null;
      if (svc.updater) { try { updaterBack = await svc.updater(); } catch (e) { updaterBack = { ok: false, why: e.message }; } }
      // THE OLDER RELEASES REMOVED (kanban #576, measured 2026-10-22: an installed node kept every release it ever ran - 12 folders, 5 GB
      // on one): once the new release answers as the same node, only it and the release it updated from (the way back) stay
      const fromFolder = String(from).split(/[\\/]/).filter(Boolean).pop();
      const pruned = [];
      for (const d of besides) {
        const name = d.split(/[\\/]/).filter(Boolean).pop();
        if (name === fromFolder || name === newFolder) continue;
        try { rmSync(d, { recursive: true, force: true }); pruned.push(name); } catch { /* a file still open (Windows): kept, the next update tries again */ }
      }
      // AND THE DOWNLOADED ARCHIVES (kanban #1444, audit 8 O8-5: releases/downloads/<version>/ kept every auto update's archive, about 200 MB
      // each, for good): only the new release's and the one it came from stay
      const keepDl = new Set([want.version, releaseIdOf(from).version].filter(Boolean));
      const downloads = join(home, 'releases', 'downloads');
      const prunedDownloads = [];
      for (const d of (() => { try { return readdirSync(downloads); } catch { return []; } })()) {
        if (keepDl.has(d)) continue;
        try { rmSync(join(downloads, d), { recursive: true, force: true }); prunedDownloads.push(d); } catch { /* the next update tries again */ }
      }
      // THE NEWEST GAMES IN THE ADVERTISEMENT (2026-10-25: "Make sure the installer and the nodes use the newest versions"): the new
      // release's app versions named in an advertisement update when the bond's advertisement does not name them yet - never fatal: the node
      // runs, and is drawn for the new versions once the update counts
      let games = null;
      if (refreshGames) { try { games = await refreshGames({ home, release: newRelease, post: true }); } catch (e) { trace.fail('the advertisement\'s app versions', e); games = { ok: false, why: e.message }; } }
      step(`done: ${from} -> ${newRelease}${pruned.length ? `; removed the older release(s) ${pruned.join(', ')}` : ''}${prunedDownloads.length ? `; removed the downloads of ${prunedDownloads.join(', ')}` : ''}${updater ? `; auto update ${updater.already ? 'was there' : updater.ok ? 'installed' : `not installed (${updater.why})`}` : ''}`);
      return { ok: true, from, to: newRelease, backup: backup.dir, identity: after.identity, moved: moving.map((f) => f.split('/').pop()), lnd: lnd ? lnd.to : null, command, migrated: migrating, peerPortsLocal: local, updater, pruned, prunedDownloads, games,
        ...(want.version ? { answered: { version: answered.version, commit: answered.commit } } : {}), ...(updaterBack ? { updaterBack } : {}),
        ...(leftAfterStop.length ? { endedAfterStop: leftAfterStop } : {}), ...(leftAfterStart.length ? { endedAfterStart: leftAfterStart } : {}),
        ...(reachUrl ? { reach: reachUrl } : {}), ...(started.ok ? {} : { notStarted: started.why }) };
    }
    // WHY IT DID NOT COME UP, SAID WITH IT (kanban #663: the rollback said only "did not answer on port 8470"): the new release's last log
    // lines - the journal of the seat's unit on Linux, node.log elsewhere - read before the old release starts again
    const seatLog = !after.ok ? await seatLogTail({ home, platform, sh, unit: svc.seatFile ? String(svc.seatFile).split(/[\\/]/).pop() : UNIT }).catch(() => []) : [];
    step('rolling back: the old service files, the backup and the old release');
    const failedStep = failedAt();
    say(null, `Going back to ${releaseIdOf(from).version || 'the release it ran'}`);
    if (seatLog.length) trace.debug(`the new release's last log lines:\n  ${seatLog.join('\n  ')}`);
    // ROLLED BACK: the old services, the backup, the old release started (rollBack) - the database kept when the new release answered as
    // this node (kanban #1166: it may have signed since)
    // AND WHEN IT WROTE ITS DATABASE (kanban #1286, audit 4 #1257 CLIENT-4: #1227 kept a changed database on the resume only): a release that reached
    // serve() as the wait ran out answered peers and wrote nonces, entries and locks without ever answering here - the backup over them would
    // lose them, and a nonce put back after its use could sign twice
    const written = !sameKey && dbChangedSince(home, backup);
    journal = journalStep(home, journal.id, U.ROLLING_BACK, { served: sameKey || written });
    const { put, back, dbKept } = await rollBack({ svc, home, moving, oldTexts: Object.fromEntries(oldTexts), migrating, confFile, backup, keepDb: sameKey || written, to: newRelease, port, fetcher, waitMs, sleep });
    journalStep(home, journal.id, U.ROLLED_BACK, { restored: back.ok, dbKept });
    step(`rolled back: the backup ${put.ok ? 'put back' : `not all put back (${put.failed.join(', ')})`}${dbKept ? (sameKey ? ' (its database kept: the new release had answered as this node)' : ' (its database kept: the new release wrote it since the backup)') : ''}; the old release ${back.ok ? 'answers' : `does not answer (${back.why})`}`);
    return { ok: false, rolledBack: true, from, to: newRelease, backup: backup.dir, failedAt: failedStep, dbKept,
      why: !after.ok ? `the new release did not come up: ${after.why}${seatLog.length ? `. Its last log lines: ${seatLog.join(' | ')}` : ''}`
        : !sameKey ? `the new release answered as another node (${after.identity.slice(0, 16)}), not ${before.identity.slice(0, 16)}`
          : !answered.ok ? (answered.version && answered.version === releaseIdOf(from).version ? `the old release still answers (${answered.version}): ${answered.why}` : answered.why)
            : `processes of an older release would not end: ${stillLeft.map((x) => `${x.name} ${x.pid}`).join(', ')}`,
      restored: back.ok, ...(put.ok ? {} : { notRestored: put.failed }) };
  } catch (e) { return await failedAfterStop(e); }
}
