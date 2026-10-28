// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN BACK FROM A RAM SNAPSHOT AFTER AN UNCLEAN STOP, CHECKED BEFORE IT STARTS (kanban #718, 2026-10-26: "this recovery process must
// be hardened and run whenever fedimints in RAM disk are not properly shut down and runs automatically on startup to recover").
//
// MEASURED: the test host rebooted at 13:31Z inside federation A's session 7753. Its 7 guardians (all of the federation, one machine) came
// back from snapshots taken one after another over the minute; each had lost a different stretch of its own AlephBFT units, re-made those
// rounds differently, and the session never closed (~7 h). The manual repair (ops/fedA-repair-7753.sh): session_status equal on all 7
// (the same 28 accepted items), all 7 stopped, their RAM databases backed up, the AlephBFT units (RocksDB key prefix 0x05) AND the unfinished
// session's accepted items (0x01) deleted, all 7 started together. Without 0x01 deleted the fresh ordering processed 0 of the 28 and the
// session end asserted processed == stored (engine.rs:600, "left: 0, right: 28", a panic).
//
// FEDIMINT 0.12 (fedimint-server src/db.rs, consensus/db.rs, consensus/engine.rs of v0.12.1/0.12.2 and the fork, read for this):
//   0x01 AcceptedItemKey(item index)       this session's accepted items; written in the same transaction as the item's effect
//   0x04 SignedSessionOutcomeKey(session)  one per finished session; the count = the highest index + 1 (get_finished_session_count)
//   0x05 AlephUnitsKey(n)                  this session's AlephBFT backup; any present = a recovery (is_recovery)
//   complete_session drops 0x05 and 0x01 together and writes 0x04. Keys are the prefix byte + the index as a BigSize (fedimint encoding).
//   A guardian behind its federation takes a closed session's signed outcome from its peers and asserts that its own accepted items are
//   that outcome's first items (engine.rs "pending accepted items disagree with federation consensus").
//   AlephBFT (fedimint-aleph-bft 0.36, default features off): no initial unit collection - a restarted member creates units from the round
//   after its own last saved one. A member that lost saved units therefore re-makes rounds its peers already hold: a FORK. AlephBFT
//   tolerates f = floor((n-1)/3) forkers; more, and the session cannot close - what federation A saw (7 forkers of 7).
//
// SO, FOR THE GUARDIANS OF ONE FEDERATION RESTORED UNCLEANLY IN THE SAME BOOT OF THIS MACHINE (k of its n):
//   clean stop            restored from the snapshot written after fedimintd exited (ramFinal): nothing lost, started as is
//   k = n, one set        all from the same snapshot set (guardian-ram.js: frozen together) - one moment of the whole federation, no
//                         unit any of them lacks: started as is
//   k = n, mixed          the accepted items (0x01) and finished sessions (0x04) compared on all k: equal - each RAM database kept on disk
//                         (ram-snaps/pre-repair-*), 0x05 and 0x01 deleted on all, all started together (the federation A repair, now
//                         automatic); different - REFUSED, none started, the reason in the log (the states are not one; no automatic
//                         choice of whose state wins)
//   k <= f                a LONE guardian (or a few) whose peers elsewhere ran on: it waits, before fedimintd starts, until a peer's
//                         session count is past the session it was in. That session is then closed - its saved units are of a session no
//                         peer runs any more, so nothing it makes can fork - and fedimint's own catch-up takes the signed outcome, its
//                         accepted items (all from before the snapshot, so the outcome's first items) asserted to agree. Nothing deleted.
//                         No peer past it within the wait (the federation stalled): started anyway, as stock fedimint would, and said so
//   f < k < n             REFUSED: more guardians out of step than the federation tolerates, and not all of them, so no repair on this
//                         machine alone makes them one; the log says to stop all n and repair them together
// The nodes of one machine are separate processes: each restored guardian registers in <RAM base>/recover/<federation>/, waits up to
// `gatherMs` for the others, and the first to take the decide lock decides for all registered and writes the verdict; each reads its own.
// A VERDICT BELONGS TO ONE CRASH (rehearsal 2026-10-28, phase C): a guardian restored again minutes after its group's verdict, while that
// group runs, is not part of that group. Only the guardians that are down and restoring NOW form a group. A late guardian joins the old
// verdict only when its database is the group's moment (the same set, or the repaired group's session and items). Otherwise, when its
// peers run (one announced on this machine since the verdict with a live fedimintd, or answering its API), it is decided afresh among
// the guardians restoring now; alone, that is the lone path. When the whole old group restores again (a second crash), it is decided afresh.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, renameSync, realpathSync, accessSync, constants } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stageCopy, ramMembers } from './guardian-ram.js';

/** The forkers a federation of `n` tolerates: f = floor((n-1)/3). */
export const faultsTolerated = (n) => Math.floor((Number(n) - 1) / 3);

/**
 * THE FEDERATION A GUARDIAN BELONGS TO, from its data dir: { fed (sha256 of its peers' broadcast keys), n, id (its own peer id), peers
 * [{ id, url }] } - or null for a guardian with no finished ceremony (nothing to recover: it has no consensus).
 */
export function federationOf(dataDir) {
  try {
    const c = JSON.parse(readFileSync(join(dataDir, 'consensus.json'), 'utf8'));
    const l = JSON.parse(readFileSync(join(dataDir, 'local.json'), 'utf8'));
    const keys = Object.entries(c.broadcast_public_keys || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
    if (!keys.length || !Number.isInteger(Number(l.identity))) return null;
    const fed = createHash('sha256').update(keys.map(([i, k]) => `${i}:${k}`).join('\n')).digest('hex').slice(0, 16);
    const peers = Object.entries(c.api_endpoints || {}).map(([i, e]) => ({ id: Number(i), url: e && e.url })).filter((p) => p.id !== Number(l.identity));
    return { fed, n: keys.length, id: Number(l.identity), peers };
  } catch { return null; }
}

/** fedimint-dbtool: ARENA_FEDIMINT_DBTOOL, beside the fedimintd in use (the release's runtime/custody), else on PATH. */
export function findDbtool(env = process.env, fedimintd = null, platform = process.platform) {
  const exe = platform === 'win32' ? 'fedimint-dbtool.exe' : 'fedimint-dbtool';
  const ok = (f) => { try { accessSync(f, constants.X_OK); return true; } catch { return false; } };
  if (env.ARENA_FEDIMINT_DBTOOL && ok(env.ARENA_FEDIMINT_DBTOOL)) return env.ARENA_FEDIMINT_DBTOOL;
  if (fedimintd && ok(join(dirname(fedimintd), exe))) return join(dirname(fedimintd), exe);
  for (const d of String(env.PATH || '').split(delimiter)) if (d && ok(join(d, exe))) return join(d, exe);
  return null;
}

/** A BigSize (fedimint's u64 encoding) at the start of `buf`: <0xfd one byte, 0xfd/0xfe/0xff then 2/4/8 bytes big-endian. */
export function bigSize(buf) {
  const b = buf[0];
  if (b < 0xfd) return b;
  if (b === 0xfd) return buf.readUInt16BE(1);
  if (b === 0xfe) return buf.readUInt32BE(1);
  return Number(buf.readBigUInt64BE(1));
}

/**
 * A STOPPED GUARDIAN'S ROCKSDB THROUGH fedimint-dbtool (stock: `list --prefix`, `delete-prefix --prefix`, lines "<key hex> <value hex>").
 * Only ever on a database no fedimintd has open. `spawnFn` is the tests' fake.
 */
export function fedimintDb(bin, { spawnFn = spawn } = {}) {
  const lines = (dir, args, onLine) => new Promise((ok, no) => {
    const p = spawnFn(bin, ['--database-dir', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let rest = '', err = '';
    p.stdout.on('data', (d) => { const s = rest + d; const parts = s.split('\n'); rest = parts.pop(); for (const l of parts) if (l.trim()) onLine(l.trim()); });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', no);
    p.on('close', (code) => { if (rest.trim()) onLine(rest.trim()); code === 0 ? ok() : no(new Error(`fedimint-dbtool ${args.join(' ')}: exit ${code} ${err.trim().split('\n').pop() || ''}`)); });
  });
  return {
    /** This session's accepted items, "<key> <value>" in key order. */
    accepted: async (dir) => { const out = []; await lines(dir, ['list', '--prefix', '01'], (l) => out.push(l)); return out; },
    /** The finished session count: the highest SignedSessionOutcome index + 1 (values are not kept: they can be tens of MB). */
    finished: async (dir) => {
      let max = -1;
      await lines(dir, ['list', '--prefix', '04'], (l) => { const k = Buffer.from(l.slice(0, l.indexOf(' ') < 0 ? l.length : l.indexOf(' ')), 'hex'); if (k[0] === 0x04 && k.length > 1) max = Math.max(max, bigSize(k.subarray(1))); });
      return max + 1;
    },
    /** How many keys under a prefix (one byte, hex). */
    count: async (dir, prefix) => { let n = 0; await lines(dir, ['list', '--prefix', prefix], () => { n++; }); return n; },
    /** Every key under each prefix deleted (one transaction per prefix). */
    drop: async (dir, prefixes) => { for (const p of prefixes) await lines(dir, ['delete-prefix', '--prefix', p], () => {}); },
  };
}

const digestOf = (items) => createHash('sha256').update(items.join('\n')).digest('hex').slice(0, 16);

/**
 * THE DECISION FOR THE GUARDIANS OF ONE FEDERATION RESTORED HERE IN ONE BOOT (pure): `n` the federation's size, `members` [{ id, snap,
 * finished?, accepted? }] (finished/accepted read only when needed - null when they could not be). Answers { action, why, ... }:
 * 'consistent' (start all as they are), 'repair' (drop 0x05 + 0x01 on all, start all), 'lone' (each waits for its peers to pass its
 * session), 'unchecked' (could not read the databases: started as before, said so), 'refuse' (none started).
 */
export function decideGroup({ n, members }) {
  const k = members.length, f = faultsTolerated(n);
  const ids = members.map((m) => m.id).join(', ');
  if (k >= n) {
    const set = members[0].snap;
    if (set && members.every((m) => m.snap === set)) return { action: 'consistent', set, why: `all ${n} guardians restored from one snapshot set (${set}): one moment of the whole federation, started as they are` };
    if (members.some((m) => !Number.isInteger(m.finished) || !Array.isArray(m.accepted))) return { action: 'unchecked', why: `all ${n} guardians restored from different moments, but their databases could not be read (no fedimint-dbtool): started as before, a stuck session needs the repair by hand` };
    const fin = new Set(members.map((m) => m.finished));
    if (fin.size > 1) return { action: 'refuse', why: `REFUSED: the ${n} guardians restored from different moments are in different sessions (${members.map((m) => `guardian ${m.id}: ${m.finished} finished`).join(', ')}) - none started; repair by hand` };
    const dig = members.map((m) => ({ id: m.id, count: m.accepted.length, digest: digestOf(m.accepted) }));
    if (new Set(dig.map((d) => d.digest)).size > 1) return { action: 'refuse', why: `REFUSED: the accepted items of session ${members[0].finished} differ (${dig.map((d) => `guardian ${d.id}: ${d.count} items ${d.digest}`).join(', ')}) - deleting the AlephBFT units would split the federation's state; none started, the databases untouched` };
    return { action: 'repair', finished: members[0].finished, digest: dig[0].digest, items: dig[0].count,
      why: `all ${n} guardians restored from different moments, session ${members[0].finished} with the same ${dig[0].count} accepted items on all (${dig[0].digest}): their AlephBFT units and the session's accepted items deleted on all, started together - the session is ordered afresh` };
  }
  if (k <= f) return { action: 'lone', why: `${k} of ${n} guardians (${ids}) restored here, within the ${f} out of step the federation tolerates: each waits until its peers have closed the session it was in, then starts` };
  return { action: 'refuse', why: `REFUSED: ${k} of ${n} guardians (${ids}) restored here - more than the ${f} out of step the federation tolerates, and not all of them, so no repair on this machine alone makes them one. Stop all ${n} guardians, compare their accepted items and delete the AlephBFT units (0x05) and accepted items (0x01) on every one, then start all together (tools/guardian-recover.mjs on each machine)` };
}

/**
 * A LONE GUARDIAN'S WAIT: its peers asked for their session count until one is past `finished` (the session it was in is closed), at
 * most `waitMs`. Answers { passed, seen } - `seen` the highest count a peer answered.
 */
export async function loneWait({ finished, peers, sessionCountOf, waitMs = 1200000, pollMs = 5000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const until = now() + waitMs;
  let seen = null, said = 0;
  for (;;) {
    const got = await Promise.allSettled(peers.map((p) => sessionCountOf(p)));
    for (const g of got) if (g.status === 'fulfilled' && Number.isInteger(g.value)) seen = Math.max(seen ?? -1, g.value);
    if (seen !== null && seen > finished) return { passed: true, seen };
    if (now() >= until) return { passed: false, seen };
    if (now() - said > 60000) { said = now(); log(`[guardian-recover] waiting for the federation to close session ${finished} (peers at ${seen ?? 'no answer'}) before this guardian starts`); }
    await sleep(pollMs);
  }
}

/** Before deleting anything: the restored database kept on disk, beside the snapshots (ram-snaps/pre-repair-<when>; not pruned). */
function keepBeforeRepair(dataDir, nowMs) {
  const snaps = join(dataDir, 'ram-snaps'), at = `pre-repair-${new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '')}`;
  let name = at;
  for (let i = 2; existsSync(join(snaps, name)); i++) name = `${at}-${i}`;
  const cur = join(snaps, 'current');
  stageCopy(realpathSync(cur), join(snaps, `${name}.partial`));
  renameSync(join(snaps, `${name}.partial`), join(snaps, name));
  return name;
}

/** One member's facts for the decision: its finished sessions and accepted items, or nulls when the database cannot be read. */
async function factsOf(db, m) {
  if (!db) return { ...m, finished: null, accepted: null };
  try { return { ...m, finished: await db.finished(m.db), accepted: await db.accepted(m.db) }; } catch (e) { return { ...m, finished: null, accepted: null, readError: e.message }; }
}

/** The repair on every member: all kept on disk first, then 0x05 and 0x01 deleted on each, checked empty. Throws on the first that fails. */
export async function repairAll(db, members, { nowMs = Date.now(), log = () => {} } = {}) {
  const kept = new Map(members.map((m) => [m, keepBeforeRepair(m.dataDir, nowMs)]));
  for (const m of members) {
    await db.drop(m.db, ['05', '01']);
    const left = (await db.count(m.db, '05')) + (await db.count(m.db, '01'));
    if (left) throw new Error(`guardian ${m.id}: ${left} keys left after the delete`);
    log(`[guardian-recover] guardian ${m.id}: AlephBFT units and accepted items deleted (the database before: ${join(m.dataDir, 'ram-snaps', kept.get(m))})`);
  }
}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { const t = `${f}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v)); renameSync(t, f); };

/**
 * THE RECOVERY STEP AT GUARDIAN START (after ramRestore, before fedimintd): `restored` is ramRestore's answer. Answers { start, action, why }.
 * `db` a fedimintDb (or null), `sessionCountOf(peer)` a peer's public session count. `gatherMs` how long the machine's other restored
 * guardians are waited for; `verdictWaitMs` how long a member waits for the decider; `loneWaitMs` how long a lone guardian waits for
 * its federation to pass its session. `now`/`sleep` are the tests' clock.
 */
export async function ramRecover({ base, dataDir, ram, restored, db = null, sessionCountOf = async () => { throw new Error('no peer asked'); },
  gatherMs = 120000, verdictWaitMs = 900000, loneWaitMs = 1200000, pollMs = 1000, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {},
  alive = pidAlive }) {
  if (!restored || !restored.restored) return { start: true, action: 'none', why: 'not restored from a snapshot' };
  if (restored.clean) return { start: true, action: 'clean', why: `restored from its clean stop (${restored.snap})` };
  const fed = federationOf(dataDir);
  if (!fed) return { start: true, action: 'setup', why: 'no federation yet: nothing to recover' };
  const dir = join(base, 'recover', fed.fed);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const me = { id: fed.id, dataDir, ram, db: join(ram, 'database'), snap: restored.snap || null, at: now() };
  writeJson(join(dir, `peer-${fed.id}.json`), me);
  log(`[guardian-recover] guardian ${fed.id} of ${fed.n} (federation ${fed.fed}) restored from ${me.snap} after an unclean stop: waiting up to ${Math.round(gatherMs / 1000)} s for the machine's other restored guardians of it`);
  const pending = () => readdirSync(dir).filter((x) => /^peer-\d+\.json$/.test(x)).map((x) => readJson(join(dir, x))).filter(Boolean);
  const verdictFile = join(dir, 'verdict.json');
  const fresh = (v) => v && now() - v.at < verdictWaitMs + gatherMs;
  const mine = (v) => v && v.members && v.members.find((m) => m.id === fed.id && m.at === me.at);
  // GATHER: until all n registered, the window is over, or a decider already answered for this guardian
  while (pending().length < fed.n && now() - me.at < gatherMs && !mine(readJson(verdictFile))) await sleep(pollMs);
  let verdict = readJson(verdictFile);
  if (!mine(verdict)) {
    const lock = join(dir, 'decide.lock');
    let decider = false;
    try { mkdirSync(lock); decider = true; } catch {
      const o = readJson(join(lock, 'owner'));
      if (o && now() - o.at > verdictWaitMs) { rmSync(lock, { recursive: true, force: true }); try { mkdirSync(lock); decider = true; } catch { /* another took it */ } }
    }
    if (decider) {
      writeJson(join(lock, 'owner'), { pid: process.pid, at: now() });
      const old = verdict;
      const peersRunning = (downIds) => peersUp({ base, fed, downIds, since: old && old.at, sessionCountOf, alive, now });
      try { verdict = await decide({ dir, fed, me, pending: pending(), verdictFile, verdict, fresh, db, now, log, peersRunning }); } finally { rmSync(lock, { recursive: true, force: true }); }
    } else {
      while (!mine(verdict) && now() - me.at < gatherMs + verdictWaitMs) { await sleep(pollMs); verdict = readJson(verdictFile); }
      if (!mine(verdict)) return { start: false, action: 'refuse', why: `REFUSED: no verdict for guardian ${fed.id} in ${Math.round((gatherMs + verdictWaitMs) / 1000)} s (the deciding node stopped?) - start the node again` };
    }
  }
  const my = mine(verdict);
  log(`[guardian-recover] guardian ${fed.id}: ${my.action} - ${my.why}`);
  if (my.action === 'refuse') return { start: false, action: 'refuse', why: my.why };
  if (my.action !== 'lone') return { start: true, action: my.action, why: my.why };
  if (!Number.isInteger(my.finished)) return { start: true, action: 'lone-unchecked', why: `${my.why}; its own session could not be read (no fedimint-dbtool): started at once, as before` };
  const w = await loneWait({ finished: my.finished, peers: fed.peers, sessionCountOf, waitMs: loneWaitMs, pollMs: pollMs * 5, now, sleep, log });
  if (w.passed) return { start: true, action: 'lone', why: `the federation is at session ${w.seen}, past session ${my.finished} this guardian was in: started, it takes the closed session from its peers` };
  return { start: true, action: 'lone-timeout', why: `no peer past session ${my.finished} in ${Math.round(loneWaitMs / 60000)} min (peers at ${w.seen ?? 'no answer'}): started anyway, as before - it may fork in that session, which the federation tolerates for up to ${faultsTolerated(fed.n)} guardians` };
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * WHETHER A GUARDIAN'S PEERS RUN NOW, from facts only (no timer): a guardian of the same federation on this machine announced since
 * `since` with a live fedimintd (guardian-ram.js ramAnnounce, every minute while it runs), or any peer not in `downIds` answering its
 * session count over its API.
 */
async function peersUp({ base, fed, downIds, since, sessionCountOf, alive, now }) {
  const down = new Set(downIds);
  for (const m of ramMembers(base, { nowMs: now() })) {
    if (!m.pid || !(m.at >= (since || 0)) || !alive(m.pid)) continue;
    const f = federationOf(m.dataDir);
    if (f && f.fed === fed.fed && !down.has(f.id)) return true;
  }
  const asked = await Promise.allSettled(fed.peers.filter((p) => !down.has(p.id)).map((p) => sessionCountOf(p)));
  return asked.some((a) => a.status === 'fulfilled' && Number.isInteger(a.value));
}

/** A group decided afresh, repaired when that is the verdict. Answers { d, entries } (the verdict's member entries). */
async function decideNow(fed, members, db, now, log) {
  const needFacts = !(members.length >= fed.n && members.every((m) => m.snap && m.snap === members[0].snap));
  const facts = [];
  for (const m of members) facts.push(needFacts && m.finished === undefined ? await factsOf(db, m) : m);
  for (const f of facts) if (f.readError) log(`[guardian-recover] guardian ${f.id}: database not read: ${f.readError}`);
  let d = decideGroup({ n: fed.n, members: facts });
  if (d.action === 'repair') {
    try { await repairAll(db, facts, { nowMs: now(), log }); } catch (e) { d = { action: 'refuse', why: `REFUSED: the repair failed (${e.message}) - none started; each database before it is in ram-snaps/pre-repair-*` }; }
  }
  return { d, entries: facts.map((f) => ({ id: f.id, at: f.at, action: d.action, why: d.why, finished: Number.isInteger(f.finished) ? f.finished : null })) };
}

/** The decider: the registered members' facts read, the group decided (and repaired), the verdict written for every member. */
async function decide({ dir, fed, pending, verdictFile, verdict: old, fresh, db, now, log, peersRunning = async () => false }) {
  const members = pending.filter((m) => now() - m.at < 2 * 3600000).sort((a, b) => a.id - b.id);
  const ids = members.map((m) => m.id);
  let out;
  // THE WHOLE OLD GROUP RESTORING AGAIN (a second crash of all of it): that verdict is over, they are one group of now
  const again = fresh(old) && old.fed === fed.fed && old.members.every((x) => members.some((m) => m.id === x.id && m.at !== x.at));
  // LATECOMERS to a verdict already given (their nodes started after the others had been decided): each judged against it - and one whose
  // database is not that group's moment while its peers run is not of that group: decided afresh with the guardians restoring now
  if (fresh(old) && old.fed === fed.fed && !again) {
    out = old;
    const later = [];
    let running = null;
    for (const m of members) {
      if (out.members.some((x) => x.id === m.id && x.at === m.at)) continue;
      const r = await latecomer({ old: out, me: m, db, now, log });
      if (!r.ofGroup && (running ??= await peersRunning(ids))) later.push(r.facts);
      else out = r.out;
    }
    if (later.length) {
      const { d, entries } = await decideNow(fed, later, db, now, log);
      log(`[guardian-recover] guardian${later.length > 1 ? 's' : ''} ${later.map((m) => m.id).join(', ')} restored while ${later.length > 1 ? 'their' : 'its'} peers run: not of the group decided at ${new Date(old.at).toISOString()} (${old.action}) - decided afresh: ${d.action}`);
      out = { ...out, members: [...out.members.filter((x) => !later.some((m) => m.id === x.id)), ...entries] };
    }
  } else {
    const { d, entries } = await decideNow(fed, members, db, now, log);
    out = { at: now(), fed: fed.fed, n: fed.n, action: d.action, why: d.why, set: d.set || null, finished: d.finished ?? null, digest: d.digest || null, members: entries };
  }
  writeJson(verdictFile, out);
  for (const m of members) rmSync(join(dir, `peer-${m.id}.json`), { force: true });
  log(`[guardian-recover] federation ${fed.fed}: ${out.action} for guardians ${out.members.map((m) => `${m.id} (${m.action})`).join(', ')}`);
  return out;
}

/**
 * A guardian decided after its group: the same repair when its state is the group's, the same start when it is of the same set, refused
 * with a refused group, lone after a lone one - all `ofGroup` (the group's verdict holds for it). Its database at another moment than a
 * consistent or repaired group's: not `ofGroup`, refused or lone only while its peers do not run. Answers { out, ofGroup, facts }.
 */
async function latecomer({ old, me, db, now, log }) {
  const add = (action, why, finished = null) => ({ ...old, members: [...old.members.filter((x) => x.id !== me.id), { id: me.id, at: me.at, action, why, finished }] });
  if (old.action === 'consistent' && me.snap === old.set) return { ofGroup: true, facts: me, out: add('consistent', `restored from the same snapshot set as its group (${old.set})`) };
  const f = await factsOf(db, me);
  if (old.action === 'repair') {
    if (Number.isInteger(f.finished) && f.finished === old.finished && digestOf(f.accepted) === old.digest) {
      try { await repairAll(db, [f], { nowMs: now(), log }); return { ofGroup: true, facts: f, out: add('repair', `its group was repaired; its session ${f.finished} and accepted items are the group's (${old.digest}): repaired the same way`) }; } catch (e) { return { ofGroup: true, facts: f, out: add('refuse', `REFUSED: the repair failed (${e.message})`) }; }
    }
    return { ofGroup: false, facts: f, out: add('refuse', `REFUSED: its group was repaired (session ${old.finished}, items ${old.digest}), but this guardian is at ${f.finished ?? '?'} with items ${Array.isArray(f.accepted) ? digestOf(f.accepted) : '?'} - repair it by hand`) };
  }
  if (old.action === 'refuse') return { ofGroup: true, facts: f, out: add('refuse', `REFUSED: its group was refused (${old.why})`) };
  const out = add('lone', `restored after its group was decided: waits until its peers have closed the session it was in`, Number.isInteger(f.finished) ? f.finished : null);
  return { ofGroup: old.action !== 'consistent', facts: f, out };
}

export { digestOf };
