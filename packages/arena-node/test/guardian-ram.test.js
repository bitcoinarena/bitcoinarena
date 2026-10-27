// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEDIMINT ON A RAM DISK (kanban #596): moved into RAM before fedimintd starts (the disk copy the first snapshot), a snapshot with the
// guardian frozen only while its database is copied within RAM, the last two kept, back from the newest after a reboot, refused when
// there is neither RAM nor a snapshot - never started empty - and a guardian never set up starting in RAM.
// ONE SET FOR THE MACHINE (kanban #718): every guardian frozen before any is staged and thawed before any is written, all named alike; a
// set with one failed stage not written at all; table files hard-linked, not copied; a clean stop's last snapshot known as clean at the
// next restore, and only once; the machine's set taken by one node a minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, readdirSync, existsSync, utimesSync, statSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ramRestore, ramSnapshot, ramDirOf, ramGroupSnapshot, ramFinal, stageCopy, ramTick, ramAnnounce, ramMembers, ramTakeLock, ramDropLock } from '../src/guardian-ram.js';

const fresh = () => { const root = mkdtempSync(join(tmpdir(), 'gram-')); return { root, data: join(root, 'node.db.guardian'), ram: join(root, 'shm', '8470-guardian') }; };
const db = (dir, v) => { mkdirSync(join(dir, 'database'), { recursive: true }); writeFileSync(join(dir, 'database', 'CURRENT'), 'MANIFEST-1\n'); writeFileSync(join(dir, 'database', '000001.sst'), v); };

test('moved into RAM, snapshots with the guardian frozen briefly, the last two kept, back after a reboot; refused with nothing', async () => {
  const { root, data, ram } = fresh();
  const child = spawn('sleep', ['30']);
  try {
    db(data, 'v1'); mkdirSync(join(data, 'db_checkpoints'));
    const moved = ramRestore(data, ram, { nowMs: Date.UTC(2026, 9, 23, 18, 0) });
    assert.deepEqual(moved, { ok: true, moved: true });
    assert.equal(lstatSync(join(data, 'database')).isSymbolicLink(), true, 'the data dir points into RAM');
    assert.equal(readFileSync(join(ram, 'database', '000001.sst'), 'utf8'), 'v1');
    assert.equal(readFileSync(join(data, 'ram-snaps', 'current', '000001.sst'), 'utf8'), 'v1', 'the disk copy is the first snapshot');
    assert.deepEqual(ramRestore(data, ram), { ok: true }, 'already in RAM: nothing to do');
    const stopped = [];
    const kill = (pid, sig) => { stopped.push(sig); process.kill(pid, sig); };
    for (const [i, v] of ['v2', 'v3', 'v4'].entries()) {
      // a new table file each minute, as RocksDB writes them (never rewritten in place: the stage hard-links them)
      rmSync(join(ram, 'database', '000001.sst')); writeFileSync(join(ram, 'database', '000001.sst'), v); const t = new Date(Date.UTC(2026, 9, 23, 18, 1 + i)); utimesSync(join(ram, 'database', '000001.sst'), t, t);
      const s = await ramSnapshot(data, ram, child.pid, { nowMs: Date.UTC(2026, 9, 23, 18, 1 + i), kill });
      assert.equal(s.ok, true, JSON.stringify(s)); assert.ok(s.heldMs < 2000, `frozen ${s.heldMs} ms`);
    }
    assert.deepEqual(stopped, ['SIGSTOP', 'SIGCONT', 'SIGSTOP', 'SIGCONT', 'SIGSTOP', 'SIGCONT'], 'frozen and thawed around each copy');
    assert.equal(readFileSync(join(data, 'ram-snaps', 'current', '000001.sst'), 'utf8'), 'v4');
    assert.equal(readdirSync(join(data, 'ram-snaps')).filter((x) => /^snap-/.test(x)).length, 2, 'the last two kept');
    // A REBOOT: RAM empty - the newest snapshot back, and it is no clean stop
    rmSync(ram, { recursive: true, force: true });
    assert.deepEqual(ramRestore(data, ram), { ok: true, restored: true, snap: 'snap-20261023T180300', clean: false });
    assert.equal(readFileSync(join(ram, 'database', '000001.sst'), 'utf8'), 'v4');
    // neither RAM nor a snapshot: refused, never started empty
    rmSync(ram, { recursive: true, force: true }); rmSync(join(data, 'ram-snaps', 'current'), { force: true });
    const no = ramRestore(data, ram);
    assert.equal(no.ok, false); assert.match(no.why, /not started empty/);
    assert.equal((await ramSnapshot(data, ram, null)).ok, false, 'nothing in RAM: no snapshot');
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('a guardian not set up yet starts in RAM; one that lost RAM before its first snapshot starts fresh again', () => {
  const { root, data, ram } = fresh();
  try {
    mkdirSync(data, { recursive: true });
    assert.deepEqual(ramRestore(data, ram), { ok: true, moved: true, fresh: true });
    assert.equal(lstatSync(join(data, 'database')).isSymbolicLink(), true);
    rmSync(ram, { recursive: true, force: true });
    assert.deepEqual(ramRestore(data, ram), { ok: true, fresh: true });
    assert.ok(existsSync(join(ram, 'database')));
    assert.equal(ramDirOf({ instance: '8570', slot: 'next', base: '/dev/shm/x' }), '/dev/shm/x/8570-next');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the stage hard-links table files and copies the WAL, MANIFEST and CURRENT', () => {
  const { root } = fresh();
  try {
    const a = join(root, 'a'); mkdirSync(a);
    for (const [f, v] of [['000007.sst', 't'], ['000008.log', 'w'], ['MANIFEST-000005', 'm'], ['CURRENT', 'c']]) writeFileSync(join(a, f), v);
    stageCopy(a, join(root, 'b'));
    assert.equal(statSync(join(root, 'b', '000007.sst')).ino, statSync(join(a, '000007.sst')).ino, 'a table file is a link');
    for (const f of ['000008.log', 'MANIFEST-000005', 'CURRENT']) assert.notEqual(statSync(join(root, 'b', f)).ino, statSync(join(a, f)).ino, `${f} is a copy`);
    writeFileSync(join(a, '000008.log'), 'w+more');
    assert.equal(readFileSync(join(root, 'b', '000008.log'), 'utf8'), 'w', 'a WAL appended after the stage leaves the stage as it was');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** Three guardians of one machine, each in RAM with its own process. */
function machine(root, k = 3) {
  const out = [];
  for (let i = 1; i <= k; i++) {
    const dataDir = join(root, `node-${i}.db.guardian`), ram = join(root, 'shm', `${i}-guardian`);
    db(dataDir, `g${i}`);
    assert.equal(ramRestore(dataDir, ram, { nowMs: Date.UTC(2026, 9, 28, 0, 0) }).moved, true);
    out.push({ dataDir, ram, child: spawn('sleep', ['30']) });
  }
  return out.map((m) => ({ ...m, pid: m.child.pid }));
}

test('one set for the machine: all frozen before any stage, all thawed before any disk write, one name on all', async () => {
  const { root } = fresh();
  const ms = machine(root);
  try {
    const order = [];
    const kill = (pid, sig) => { order.push(`${sig} ${ms.findIndex((m) => m.pid === pid) + 1}`); process.kill(pid, sig); };
    const stage = (src, dst) => { order.push(`stage ${ms.findIndex((m) => src.startsWith(m.ram)) + 1}`); stageCopy(src, dst); };
    const r = await ramGroupSnapshot(ms, { nowMs: Date.UTC(2026, 9, 28, 0, 1), kill, stage });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(order, ['SIGSTOP 1', 'SIGSTOP 2', 'SIGSTOP 3', 'stage 1', 'stage 2', 'stage 3', 'SIGCONT 1', 'SIGCONT 2', 'SIGCONT 3']);
    for (const [i, m] of ms.entries()) {
      assert.equal(readlinkSync(join(m.dataDir, 'ram-snaps', 'current')), 'snap-20261028T000100', 'one name for the set');
      assert.equal(readFileSync(join(m.dataDir, 'ram-snaps', 'current', '000001.sst'), 'utf8'), `g${i + 1}`);
      assert.equal(existsSync(join(m.ram, 'stage')), false, 'the stage gone once written');
    }
    // ONE STAGE FAILS: the set is not written at all (the others would be a newer moment than it), and every guardian is thawed
    const order2 = [];
    const bad = (src, dst) => { if (src.startsWith(ms[1].ram)) throw new Error('no space'); stageCopy(src, dst); };
    const r2 = await ramGroupSnapshot(ms, { nowMs: Date.UTC(2026, 9, 28, 0, 2), kill: (pid, sig) => { order2.push(sig); process.kill(pid, sig); }, stage: bad });
    assert.equal(r2.ok, false); assert.match(r2.why, /no space/);
    assert.deepEqual(order2.filter((s) => s === 'SIGCONT').length, 3, 'all thawed');
    for (const m of ms) assert.equal(readlinkSync(join(m.dataDir, 'ram-snaps', 'current')), 'snap-20261028T000100', 'the last whole set stays current');
  } finally { for (const m of ms) m.child.kill(); rmSync(root, { recursive: true, force: true }); }
});

test('a clean stop leaves a snapshot the next restore knows as clean - once; a crash after it is not clean', async () => {
  const { root, data, ram } = fresh();
  try {
    db(data, 'v1'); ramRestore(data, ram, { nowMs: Date.UTC(2026, 9, 28, 1, 0) });
    writeFileSync(join(ram, 'database', '000002.sst'), 'after');
    const f = await ramFinal(data, ram, { nowMs: Date.UTC(2026, 9, 28, 1, 5) });
    assert.equal(f.ok, true, JSON.stringify(f));
    assert.equal(readFileSync(join(data, 'ram-snaps', 'clean'), 'utf8').trim(), 'snap-20261028T010500-stop');
    rmSync(ram, { recursive: true, force: true });
    assert.deepEqual(ramRestore(data, ram), { ok: true, restored: true, snap: 'snap-20261028T010500-stop', clean: true });
    assert.equal(readFileSync(join(ram, 'database', '000002.sst'), 'utf8'), 'after', 'nothing lost');
    assert.equal(existsSync(join(data, 'ram-snaps', 'clean')), false, 'the marker taken at the start');
    rmSync(ram, { recursive: true, force: true });
    assert.equal(ramRestore(data, ram).clean, false, 'the guardian ran since: a second loss is no clean stop');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the machine\'s set is taken by the first node to tick in a minute, for every announced guardian; a dead holder\'s lock is broken', async () => {
  const { root } = fresh();
  const ms = machine(root, 2);
  const base = join(root, 'shm');
  try {
    const t = Date.UTC(2026, 9, 28, 2, 0);
    ramAnnounce(base, 'b', { dataDir: ms[1].dataDir, ram: ms[1].ram, pid: ms[1].pid, nowMs: t });
    const sets = [];
    const group = async (members) => { sets.push(members.map((m) => m.key)); return { ok: true }; };
    assert.deepEqual(await ramTick(base, 'a', { dataDir: ms[0].dataDir, ram: ms[0].ram, pid: ms[0].pid, nowMs: t + 5000, group }), { ok: true, taken: true, set: { ok: true } });
    assert.deepEqual(sets, [['a', 'b']], 'both guardians in the one set');
    assert.equal((await ramTick(base, 'b', { ...ms[1], nowMs: t + 10000, group })).taken, false, 'the same minute: already taken');
    assert.equal((await ramTick(base, 'b', { ...ms[1], nowMs: t + 65000, group })).taken, true, 'the next minute: b ticks first and takes it');
    assert.deepEqual(ramMembers(base, { nowMs: t + 65000 + 181000 }), [], 'members not heard from in 3 min are not frozen');
    // a lock whose holder is gone
    assert.equal(ramTakeLock(base, { nowMs: t }), true);
    assert.equal(ramTakeLock(base, { nowMs: t + 1000 }), false, 'held');
    assert.equal(ramTakeLock(base, { nowMs: t + 1000, alive: () => false }), true, 'its holder died: broken and taken');
    ramDropLock(base);
  } finally { for (const m of ms) m.child.kill(); rmSync(root, { recursive: true, force: true }); }
});
