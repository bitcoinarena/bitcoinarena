// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A GUARDIAN BACK FROM A RAM SNAPSHOT AFTER AN UNCLEAN STOP (kanban #718), the decision on fixtures: federation A's case (all 7 restored
// from different moments, the same 28 accepted items) repaired - units and accepted items deleted on all, each kept on disk first, all
// started; accepted items or sessions that differ refused with the reason and nothing deleted; one snapshot set started as is; a clean
// stop not checked at all; a lone guardian held until its peers closed its session (and started anyway when they never do); more than
// f but not all refused; a latecomer to a repaired group repaired alike. And fedimint-dbtool's output read as fedimint writes its keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { decideGroup, faultsTolerated, bigSize, fedimintDb, ramRecover, federationOf, loneWait, digestOf } from '../src/guardian-recover.js';
import { ramAnnounce } from '../src/guardian-ram.js';

const ITEMS = Array.from({ length: 28 }, (_, i) => `01${i.toString(16).padStart(2, '0')} 00aa${i}`);

test('decideGroup: one set, agreeing, differing items, differing sessions, unreadable, lone, too many but not all', () => {
  const all = (n, f) => Array.from({ length: n }, (_, i) => ({ id: i, snap: `snap-${i}`, finished: 7753, accepted: ITEMS, ...f(i) }));
  assert.equal(faultsTolerated(7), 2); assert.equal(faultsTolerated(4), 1); assert.equal(faultsTolerated(10), 3);
  assert.equal(decideGroup({ n: 7, members: all(7, () => ({ snap: 'snap-20261028T000100' })) }).action, 'consistent');
  const rep = decideGroup({ n: 7, members: all(7, () => ({})) });
  assert.equal(rep.action, 'repair'); assert.equal(rep.finished, 7753); assert.equal(rep.items, 28); assert.match(rep.why, /same 28 accepted items/);
  const dif = decideGroup({ n: 7, members: all(7, (i) => (i === 3 ? { accepted: ITEMS.slice(0, 27) } : {})) });
  assert.equal(dif.action, 'refuse'); assert.match(dif.why, /accepted items of session 7753 differ.*guardian 3: 27 items/);
  const ses = decideGroup({ n: 7, members: all(7, (i) => (i === 0 ? { finished: 7754, accepted: [] } : {})) });
  assert.equal(ses.action, 'refuse'); assert.match(ses.why, /different sessions.*guardian 0: 7754 finished/);
  assert.equal(decideGroup({ n: 7, members: all(7, () => ({ finished: null, accepted: null })) }).action, 'unchecked');
  assert.equal(decideGroup({ n: 7, members: all(2, () => ({})) }).action, 'lone', '2 of 7: within f = 2');
  assert.equal(decideGroup({ n: 4, members: all(1, () => ({})) }).action, 'lone', 'one installer node of a 4');
  const many = decideGroup({ n: 7, members: all(3, () => ({ snap: 'same' })) });
  assert.equal(many.action, 'refuse', '3 of 7, even of one set: their peers elsewhere hold units made after it'); assert.match(many.why, /more than the 2 out of step/);
});

test('fedimint-dbtool output: keys as fedimint encodes them (prefix + BigSize), lines split across reads, delete-prefix per prefix', async () => {
  assert.equal(bigSize(Buffer.from('fc', 'hex')), 252);
  assert.equal(bigSize(Buffer.from('fd1e49', 'hex')), 7753);
  assert.equal(bigSize(Buffer.from('fe00010000', 'hex')), 65536);
  const calls = [];
  const spawnFn = (bin, args) => {
    calls.push(args.join(' '));
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter();
    setImmediate(() => {
      if (args.includes('04')) { p.stdout.emit('data', '0400 aabb\n04fd1e'); p.stdout.emit('data', '48 ccdd\n'); }
      if (args.includes('01') && args[2] === 'list') p.stdout.emit('data', ITEMS.join('\n') + '\n');
      p.emit('close', 0);
    });
    return p;
  };
  const d = fedimintDb('/x/fedimint-dbtool', { spawnFn });
  assert.equal(await d.finished('/shm/1/database'), 7753, 'sessions 0..7752 finished');
  assert.deepEqual(await d.accepted('/shm/1/database'), ITEMS);
  await d.drop('/shm/1/database', ['05', '01']);
  assert.deepEqual(calls.slice(2), ['--database-dir /shm/1/database delete-prefix --prefix 05', '--database-dir /shm/1/database delete-prefix --prefix 01']);
  const failing = fedimintDb('/x', { spawnFn: () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); setImmediate(() => { p.stderr.emit('data', 'IO error: lock hold by current process'); p.emit('close', 1); }); return p; } });
  await assert.rejects(failing.accepted('/d'), /exit 1 IO error: lock/);
});

/** A machine with `ids` of an n-guardian federation restored from snapshots, and a fake dbtool over them. */
function fixture(n, ids, { snap = (id) => `snap-2026102613310${id}`, finished = () => 7753, accepted = () => ITEMS } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'grec-'));
  const keys = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), `02${String(i).repeat(64).slice(0, 64)}`]));
  const api = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), { url: `wss://m/guardian-${i}/guardian`, name: `node-${i}` }]));
  const state = {}, guardians = [];
  for (const id of ids) {
    const dataDir = join(root, `node-${id}.db.guardian`), ram = join(root, 'shm', `${id}-guardian`);
    mkdirSync(join(dataDir, 'ram-snaps', snap(id)), { recursive: true }); writeFileSync(join(dataDir, 'ram-snaps', snap(id), 'CURRENT'), 'M\n');
    symlinkSync(snap(id), join(dataDir, 'ram-snaps', 'current'));
    mkdirSync(join(ram, 'database'), { recursive: true });
    writeFileSync(join(dataDir, 'consensus.json'), JSON.stringify({ broadcast_public_keys: keys, api_endpoints: api }));
    writeFileSync(join(dataDir, 'local.json'), JSON.stringify({ identity: id }));
    state[join(ram, 'database')] = { finished: finished(id), accepted: accepted(id), units: 50000 + id, dropped: [] };
    guardians.push({ id, dataDir, ram, restored: { ok: true, restored: true, snap: snap(id), clean: false } });
  }
  const reads = [];
  const db = {
    finished: async (d) => { reads.push(d); return state[d].finished; },
    accepted: async (d) => state[d].accepted.slice(),
    count: async (d, p) => (p === '05' ? state[d].units : state[d].accepted.length),
    drop: async (d, ps) => { state[d].dropped.push(...ps); if (ps.includes('05')) state[d].units = 0; if (ps.includes('01')) state[d].accepted = []; },
  };
  return { root, base: join(root, 'shm'), guardians, state, db, reads, done: () => rmSync(root, { recursive: true, force: true }) };
}
const fast = { gatherMs: 400, verdictWaitMs: 5000, pollMs: 10 };
const all = (fx, extra = {}) => Promise.all(fx.guardians.map((g) => ramRecover({ base: fx.base, dataDir: g.dataDir, ram: g.ram, restored: g.restored, db: fx.db, ...fast, ...extra })));

test('federation A\'s case: all 7 restored from different moments, the same 28 accepted items - repaired on all, each kept first, all started', async () => {
  const fx = fixture(7, [0, 1, 2, 3, 4, 5, 6]);
  try {
    const lines = [];
    const out = await all(fx, { log: (l) => lines.push(l) });
    assert.deepEqual(out.map((o) => [o.start, o.action]), Array(7).fill([true, 'repair']));
    for (const g of fx.guardians) {
      const s = fx.state[join(g.ram, 'database')];
      assert.deepEqual(s.dropped, ['05', '01'], 'the AlephBFT units and the session\'s accepted items');
      assert.equal(s.units, 0);
      assert.ok(readdirSync(join(g.dataDir, 'ram-snaps')).some((x) => x.startsWith('pre-repair-')), 'the database before the repair kept on disk');
    }
    assert.ok(lines.some((l) => /same 28 accepted items on all/.test(l)));
    assert.equal(lines.filter((l) => /federation [0-9a-f]+: repair for guardians/.test(l)).length, 1, 'one decider');
  } finally { fx.done(); }
});

test('accepted items that differ: refused on all, the reason in the log, nothing deleted', async () => {
  const fx = fixture(7, [0, 1, 2, 3, 4, 5, 6], { accepted: (id) => (id === 5 ? ITEMS.slice(0, 25) : ITEMS) });
  try {
    const lines = [];
    const out = await all(fx, { log: (l) => lines.push(l) });
    assert.ok(out.every((o) => !o.start && o.action === 'refuse'));
    assert.match(out[0].why, /guardian 5: 25 items/);
    assert.ok(Object.values(fx.state).every((s) => s.dropped.length === 0 && s.units > 0), 'the databases untouched');
    assert.ok(lines.some((l) => /REFUSED: the accepted items of session 7753 differ/.test(l)));
  } finally { fx.done(); }
});

test('all from one snapshot set: started as they are, no database read', async () => {
  const fx = fixture(4, [0, 1, 2, 3], { snap: () => 'snap-20261028T000100' });
  try {
    const out = await all(fx);
    assert.ok(out.every((o) => o.start && o.action === 'consistent'));
    assert.deepEqual(fx.reads, [], 'nothing read'); assert.ok(Object.values(fx.state).every((s) => !s.dropped.length));
  } finally { fx.done(); }
});

test('a clean stop and a guardian not restored are not checked; a guardian in setup has nothing to recover', async () => {
  const fx = fixture(4, [0]);
  try {
    const g = fx.guardians[0];
    assert.equal((await ramRecover({ base: fx.base, dataDir: g.dataDir, ram: g.ram, restored: { ok: true, restored: true, snap: 's-stop', clean: true }, db: fx.db })).action, 'clean');
    assert.equal((await ramRecover({ base: fx.base, dataDir: g.dataDir, ram: g.ram, restored: { ok: true }, db: fx.db })).action, 'none');
    rmSync(join(g.dataDir, 'consensus.json'));
    assert.equal((await ramRecover({ base: fx.base, dataDir: g.dataDir, ram: g.ram, restored: g.restored, db: fx.db })).action, 'setup');
    assert.equal(existsSync(join(fx.base, 'recover')), false, 'no registration');
  } finally { fx.done(); }
});

test('a lone guardian (1 of 4, peers elsewhere) waits until a peer is past its session, deletes nothing; started anyway when none gets there', async () => {
  const fx = fixture(4, [2], { finished: () => 120 });
  try {
    const g = fx.guardians[0];
    assert.deepEqual(federationOf(g.dataDir).peers.map((p) => p.id), [0, 1, 3]);
    let asked = 0;
    const sessionCountOf = async (p) => { asked++; if (p.id === 0) throw new Error('down'); return asked > 9 ? 121 : 120; };
    const r = await ramRecover({ base: fx.base, dataDir: g.dataDir, ram: g.ram, restored: g.restored, db: fx.db, sessionCountOf, ...fast, loneWaitMs: 5000 });
    assert.deepEqual([r.start, r.action], [true, 'lone']); assert.match(r.why, /session 121, past session 120/);
    assert.ok(asked > 9, 'asked until a peer was past it');
    assert.deepEqual(fx.state[join(g.ram, 'database')].dropped, [], 'its units kept: the session they belong to is closed');
    let t = 0;
    const w = await loneWait({ finished: 120, peers: [{ id: 0 }], sessionCountOf: async () => 120, waitMs: 1000, now: () => t, sleep: async () => { t += 300; } });
    assert.deepEqual(w, { passed: false, seen: 120 });
  } finally { fx.done(); }
  const fx2 = fixture(4, [1], { finished: () => 120 });
  try {
    const g = fx2.guardians[0];
    const r = await ramRecover({ base: fx2.base, dataDir: g.dataDir, ram: g.ram, restored: g.restored, db: fx2.db, sessionCountOf: async () => 120, ...fast, loneWaitMs: 150 });
    assert.deepEqual([r.start, r.action], [true, 'lone-timeout']); assert.match(r.why, /may fork in that session/);
  } finally { fx2.done(); }
});

test('3 of 7 restored here, peers elsewhere: refused, with what to do', async () => {
  const fx = fixture(7, [0, 1, 2]);
  try {
    const out = await all(fx);
    assert.ok(out.every((o) => !o.start)); assert.match(out[0].why, /3 of 7 .* Stop all 7 guardians/);
  } finally { fx.done(); }
});

test('a latecomer to a repaired group: repaired alike when its state is the group\'s, refused when not', async () => {
  const fx2 = fixture(4, [0, 1, 2, 3]);
  try {
    const out = await all(fx2);
    assert.ok(out.every((o) => o.action === 'repair'));
    // the node of guardian 3 is started again later in the same boot with a database restored once more (its RAM lost again)
    const g = fx2.guardians[3];
    fx2.state[join(g.ram, 'database')] = { finished: 7753, accepted: ITEMS, units: 9, dropped: [] };
    const again = await ramRecover({ base: fx2.base, dataDir: g.dataDir, ram: g.ram, restored: { ...g.restored, snap: 'snap-later' }, db: fx2.db, ...fast, gatherMs: 50 });
    assert.deepEqual([again.start, again.action], [true, 'repair']); assert.match(again.why, new RegExp(digestOf(ITEMS)));
    assert.deepEqual(fx2.state[join(g.ram, 'database')].dropped, ['05', '01']);
    fx2.state[join(g.ram, 'database')] = { finished: 7754, accepted: [], units: 9, dropped: [] };
    const off = await ramRecover({ base: fx2.base, dataDir: g.dataDir, ram: g.ram, restored: { ...g.restored, snap: 'snap-later2' }, db: fx2.db, ...fast, gatherMs: 50 });
    assert.equal(off.start, false); assert.match(off.why, /repair it by hand/);
  } finally { fx2.done(); }
});

// THE REHEARSAL OF 2026-10-28 (phase B then C): all 7 restored from different moments and repaired; minutes later only guardian 2 is
// killed and restored, its RAM wiped, the other 6 running on. It is not part of B's group: it takes the lone path, nothing deleted.
test('B then C: a guardian restored alone minutes after its group\'s repair, its peers running, takes the lone path', async () => {
  const fx = fixture(7, [0, 1, 2, 3, 4, 5, 6], { finished: () => 7, accepted: () => [] });
  try {
    const b = await all(fx);
    assert.ok(b.every((o) => o.start && o.action === 'repair'), 'B: all 7 repaired');
    // the six run on: each node announces its live fedimintd every minute (guardian-ram.js ramTick)
    for (const g of fx.guardians) if (g.id !== 2) ramAnnounce(fx.base, `${g.id}-guardian`, { dataDir: g.dataDir, ram: g.ram, pid: process.pid });
    const g = fx.guardians[2];
    fx.state[join(g.ram, 'database')] = { finished: 10, accepted: ITEMS.slice(0, 3), units: 77, dropped: [] };
    let asked = 0;
    const sessionCountOf = async () => (++asked > 2 ? 11 : 10);
    const lines = [];
    const c = await ramRecover({ base: fx.base, dataDir: g.dataDir, ram: g.ram, restored: { ...g.restored, snap: 'snap-20261028T081930' }, db: fx.db, sessionCountOf,
      ...fast, gatherMs: 50, loneWaitMs: 5000, log: (l) => lines.push(l) });
    assert.deepEqual([c.start, c.action], [true, 'lone'], c.why);
    assert.match(c.why, /session 11, past session 10/);
    assert.deepEqual(fx.state[join(g.ram, 'database')].dropped, [], 'nothing deleted: not repaired with B\'s group');
    assert.ok(lines.some((l) => /guardian 2 restored while its peers run: not of the group decided .* \(repair\) - decided afresh: lone/.test(l)), lines.join('\n'));
    assert.ok(!lines.some((l) => /REFUSED/.test(l)));
  } finally { fx.done(); }
});

test('B then C with no announcement on this machine: peers answering their API run too; none running and the old verdict holds', async () => {
  const fx = fixture(7, [0, 1, 2, 3, 4, 5, 6], { finished: () => 7, accepted: () => [] });
  try {
    await all(fx);
    const g = fx.guardians[2];
    fx.state[join(g.ram, 'database')] = { finished: 10, accepted: ITEMS.slice(0, 3), units: 77, dropped: [] };
    const c = await ramRecover({ base: fx.base, dataDir: g.dataDir, ram: g.ram, restored: { ...g.restored, snap: 'snap-c' }, db: fx.db, sessionCountOf: async () => 11, ...fast, gatherMs: 50 });
    assert.deepEqual([c.start, c.action], [true, 'lone']);
    fx.state[join(g.ram, 'database')] = { finished: 10, accepted: ITEMS.slice(0, 3), units: 77, dropped: [] };
    // an announcement of a dead fedimintd is not a running peer, and no API answers: B's verdict still holds - refused as before
    ramAnnounce(fx.base, '0-guardian', { dataDir: fx.guardians[0].dataDir, ram: fx.guardians[0].ram, pid: 4190000 });
    const d = await ramRecover({ base: fx.base, dataDir: g.dataDir, ram: g.ram, restored: { ...g.restored, snap: 'snap-d' }, db: fx.db, ...fast, gatherMs: 50, alive: () => false });
    assert.equal(d.start, false); assert.match(d.why, /repair it by hand/);
  } finally { fx.done(); }
});

test('a second crash of the whole group minutes after its repair: decided afresh, not judged against the old verdict', async () => {
  const fx = fixture(4, [0, 1, 2, 3], { finished: () => 7, accepted: () => [] });
  try {
    await all(fx);
    for (const g of fx.guardians) { fx.state[join(g.ram, 'database')] = { finished: 12, accepted: ITEMS.slice(0, 2), units: 5, dropped: [] }; g.restored = { ...g.restored, snap: `snap-again-${g.id}` }; }
    const out = await all(fx);
    assert.deepEqual(out.map((o) => [o.start, o.action]), Array(4).fill([true, 'repair']));
    assert.match(out[0].why, /session 12 with the same 2 accepted items/);
  } finally { fx.done(); }
});
