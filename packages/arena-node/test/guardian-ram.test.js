// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// FEDIMINT ON A RAM DISK (kanban #596): moved into RAM before fedimintd starts (the disk copy the first snapshot), a snapshot with the
// guardian frozen only while its database is copied within RAM, the last two kept, back from the newest after a reboot, refused when
// there is neither RAM nor a snapshot - never started empty - and a guardian never set up starting in RAM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, readdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ramRestore, ramSnapshot, ramDirOf } from '../src/guardian-ram.js';

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
      // written a minute apart, as the snapshots are (rsync --link-dest links a file of the same size and time)
      writeFileSync(join(ram, 'database', '000001.sst'), v); const t = new Date(Date.UTC(2026, 9, 23, 18, 1 + i)); utimesSync(join(ram, 'database', '000001.sst'), t, t);
      const s = await ramSnapshot(data, ram, child.pid, { nowMs: Date.UTC(2026, 9, 23, 18, 1 + i), kill });
      assert.equal(s.ok, true, JSON.stringify(s)); assert.ok(s.heldMs < 2000, `frozen ${s.heldMs} ms`);
    }
    assert.deepEqual(stopped, ['SIGSTOP', 'SIGCONT', 'SIGSTOP', 'SIGCONT', 'SIGSTOP', 'SIGCONT'], 'frozen and thawed around each copy');
    assert.equal(readFileSync(join(data, 'ram-snaps', 'current', '000001.sst'), 'utf8'), 'v4');
    assert.equal(readdirSync(join(data, 'ram-snaps')).filter((x) => /^snap-/.test(x)).length, 2, 'the last two kept');
    // A REBOOT: RAM empty - the newest snapshot back
    rmSync(ram, { recursive: true, force: true });
    assert.deepEqual(ramRestore(data, ram), { ok: true, restored: true });
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
