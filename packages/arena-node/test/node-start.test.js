// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A NODE RUNS A GUARDIAN ONLY IF IT HOLDS A GUARDIAN KEY (spec §23A.2; 2026-09-27: "Starting a node is not
// enough. Holding that node's guardian key is the test"). The key is <store>.guardian/private.json and consensus.json,
// what a completed ceremony leaves. A launcher starts nodes only; a node that holds a key starts its own guardian and
// says so on GET /guardian, and a node that does not starts none, makes no directory, and is advertised as none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.js';
import { startNode, holdsGuardianKey } from '../src/node-start.js';
import { standUpRound } from '../tools/round-2of2.mjs';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
// A LAUNCHER HANDS ITS NODES THE GAMES THEY HOST (§0A.4): nextblock, as src/main.js does.
const launchNode = (store, options, chain) => startNode(store, { plugins: [NEXTBLOCK], ...options }, chain);


// a port the guardian's own ports (node + 1000 .. + 4000) also fit after
const port = (from) => new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(port(from + 7)));
  s.listen(from, '127.0.0.1', () => s.close(() => resolve(from)));
});
const getGuardian = async (p) => (await fetch(`http://127.0.0.1:${p}/guardian`, { headers: { connection: 'close' } })).json();

// A STAND-IN fedimintd on the PATH, as guardian.test does: it notes that it was started, and waits to be stopped.
function standIn(dir) {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const started = join(dir, 'fedimintd-started');
  writeFileSync(join(bin, 'fedimintd'), `#!/bin/sh\necho "$FM_API_URL" >> ${started}\nexec sleep 60\n`);
  chmodSync(join(bin, 'fedimintd'), 0o755);
  const cookie = join(dir, '.cookie'); writeFileSync(cookie, '__cookie__:sekrit');
  const chain = { bitcoindUrl: 'http://127.0.0.1:48332', cookiePath: cookie, call: async () => ({ chain: 'testnet4' }),
    env: { PATH: `${bin}:/usr/bin:/bin` }, tailscale: null, log: () => {} };
  return { chain, started };
}
// A FOUNDED GUARDIAN'S DIRECTORY: the two files a completed ceremony writes
function founded(storePath) {
  mkdirSync(`${storePath}.guardian`, { recursive: true });
  writeFileSync(`${storePath}.guardian/private.json`, JSON.stringify({ broadcast_sk: 'x' }));
  writeFileSync(`${storePath}.guardian/consensus.json`, JSON.stringify({ broadcast_public_keys: {} }));
}

test('a launcher-started node that holds a guardian key starts its own guardian and is advertised as one; its peer without a key is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-start-'));
  const { chain, started } = standIn(dir);
  const store = join(dir, 'store'); mkdirSync(store);
  founded(join(store, 'a.db'));
  const [portA, portB] = [await port(22611), await port(22711)];
  const r = await standUpRound({ portA, portB, store, guardianChain: chain });
  try {
    const endpoint = `ws://127.0.0.1:${portA}/guardian`;
    assert.deepEqual(await getGuardian(portA), { guardian: true, endpoint }, 'node A holds a key: its GET /guardian says so');
    assert.deepEqual(await getGuardian(portB), { guardian: false }, 'node B holds none');
    assert.deepEqual([r.adverts[0].guardianCapable, r.adverts[0].guardianEndpoint], [true, endpoint], "A's advert is its own answer");
    assert.deepEqual([r.adverts[1].guardianCapable, r.adverts[1].guardianEndpoint], [false, ''], "B's advert says not a guardian");
    assert.equal(existsSync(join(store, 'b.db.guardian')), false, 'no guardian directory is made for a node without a key');
    // THE STAND-IN IS SPAWNED, NOT AWAITED: its first line lands when the child shell runs - measured red under a loaded machine
    // when read at once, so it is waited for (5 s at most), as the launcher itself never waits on it
    for (let t = 0; t < 50 && !existsSync(started); t++) await new Promise((ok) => setTimeout(ok, 100));
    assert.ok(existsSync(started), 'A started its fedimintd');
  } finally { for (const d of r.daemons) await d.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a node with no key, or a guardian directory without private.json, starts no fedimintd, makes no directory, and answers {guardian: false}', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-start-none-'));
  const { chain, started } = standIn(dir);
  try {
    const bare = join(dir, 'bare.db');
    assert.equal(holdsGuardianKey(bare), false);
    const p1 = await port(22811);
    const n1 = await launchNode({ db: openStore(bare), path: bare }, { port: p1 }, chain);
    try {
      assert.deepEqual(await getGuardian(p1), { guardian: false });
      assert.equal(existsSync(`${bare}.guardian`), false, 'no directory is made');
    } finally { await n1.close(); }

    const half = join(dir, 'half.db');
    mkdirSync(`${half}.guardian`);
    writeFileSync(`${half}.guardian/consensus.json`, '{}');   // a setup left behind, no private.json: no key
    assert.equal(holdsGuardianKey(half), false);
    const p2 = await port(22911);
    const n2 = await launchNode({ db: openStore(half), path: half }, { port: p2 }, chain);
    try { assert.deepEqual(await getGuardian(p2), { guardian: false }); } finally { await n2.close(); }

    assert.equal(existsSync(started), false, 'no fedimintd was started for a node without a key');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// KANBAN: WHICH GUARDIANS A NODE STARTS. With ARENA_FOUNDING=1 a node with no ceremony files starts its guardian in SETUP MODE (so it
// can be drawn); a keyed guardian seated first in a successor runs a second, the guardian-next, with ARENA_FOUNDING_NEXT=1 - or whenever
// the guardian-next's own files are held. Neither flag: as before.
import { readFileSync } from 'node:fs';
import { guardiansToStart } from '../src/node-start.js';

function standInSeen(dir) {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  const seen = join(dir, 'fedimintd-seen');
  writeFileSync(join(bin, 'fedimintd'), `#!/bin/sh\necho "$FM_DATA_DIR $FM_BIND_API $FM_BIND_P2P $FM_BIND_METRICS $FM_API_URL" >> ${seen}\nexec sleep 60\n`);
  chmodSync(join(bin, 'fedimintd'), 0o755);
  const cookie = join(dir, '.cookie'); writeFileSync(cookie, '__cookie__:sekrit');
  return { seen, chain: (extra) => ({ bitcoindUrl: 'http://127.0.0.1:48332', cookiePath: cookie, call: async () => ({ chain: 'regtest' }),
    env: { PATH: `${bin}:/usr/bin:/bin`, ...extra }, tailscale: null, log: () => {} }) };
}
const lines = async (f, n) => { for (let t = 0; t < 50; t++) { if (existsSync(f) && readFileSync(f, 'utf8').trim().split('\n').length >= n) break; await new Promise((ok) => setTimeout(ok, 100)); }
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => l.split(' ')) : []; };

test('guardiansToStart: setup mode only with ARENA_FOUNDING=1; the guardian-next only beside a keyed guardian, by flag or by its own files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-start-plan-'));
  try {
    const bare = join(dir, 'bare.db'), keyed = join(dir, 'keyed.db'), both = join(dir, 'both.db');
    founded(keyed); founded(both);
    mkdirSync(`${both}.guardian-next`); writeFileSync(`${both}.guardian-next/private.json`, '{}'); writeFileSync(`${both}.guardian-next/consensus.json`, '{}');
    const F = { ARENA_FOUNDING: '1' }, FN = { ARENA_FOUNDING: '1', ARENA_FOUNDING_NEXT: '1' };
    assert.deepEqual(guardiansToStart(bare, {}), { own: null, next: null });
    assert.deepEqual(guardiansToStart(bare, F), { own: 'setup', next: null });
    assert.deepEqual(guardiansToStart(bare, FN), { own: 'setup', next: null }, 'no guardian-next beside a setup-mode guardian');
    assert.deepEqual(guardiansToStart(':memory:', F), { own: null, next: null });
    assert.deepEqual(guardiansToStart(keyed, {}), { own: 'keyed', next: null });
    assert.deepEqual(guardiansToStart(keyed, F), { own: 'keyed', next: null });
    assert.deepEqual(guardiansToStart(keyed, { ARENA_FOUNDING_NEXT: '1' }), { own: 'keyed', next: null }, 'the flag alone is not enough');
    assert.deepEqual(guardiansToStart(keyed, FN), { own: 'keyed', next: 'setup' });
    assert.deepEqual(guardiansToStart(both, {}), { own: 'keyed', next: 'keyed' }, 'a founded successor runs on every start');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ARENA_FOUNDING=1, no ceremony files: the node starts its guardian in setup mode on its own data dir and ports, and serves it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-start-setup-'));
  const { seen, chain } = standInSeen(dir);
  try {
    const path = join(dir, 'n.db');
    const p = await port(23011);
    const n = await launchNode({ db: openStore(path), path }, { port: p }, chain({ ARENA_FOUNDING: '1' }));
    try {
      assert.deepEqual([n.guardianRunning, n.guardianSetup, n.guardianNextRunning], [true, true, false]);
      assert.deepEqual(await getGuardian(p), { guardian: true, endpoint: `ws://127.0.0.1:${p}/guardian` });
      const got = await lines(seen, 1);
      assert.equal(got.length, 1, 'one fedimintd');
      assert.deepEqual(got[0], [`${path}.guardian`, `127.0.0.1:${p + 1000}`, `127.0.0.1:${p + 2000}`, `127.0.0.1:${p + 4000}`, `ws://127.0.0.1:${p}/guardian`]);
      assert.ok(existsSync(`${path}.guardian/admin-password`), 'its admin password, for the founding\'s setup calls');
    } finally { await n.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a keyed guardian with ARENA_FOUNDING=1 and ARENA_FOUNDING_NEXT=1 runs a guardian-next beside it: its own dir, ports +5000..+8000, /guardian-next', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-start-next-'));
  const { seen, chain } = standInSeen(dir);
  try {
    const path = join(dir, 'g.db');
    founded(path);
    const p = await port(23111);
    const n = await launchNode({ db: openStore(path), path }, { port: p }, chain({ ARENA_FOUNDING: '1', ARENA_FOUNDING_NEXT: '1' }));
    try {
      assert.deepEqual([n.guardianRunning, n.guardianSetup, n.guardianNextRunning], [true, false, true]);
      assert.deepEqual(await getGuardian(p), { guardian: true, endpoint: `ws://127.0.0.1:${p}/guardian`, next: `ws://127.0.0.1:${p}/guardian-next` });
      const got = (await lines(seen, 2)).sort((a, b) => a[0].localeCompare(b[0]));
      assert.equal(got.length, 2, 'two fedimintd');
      assert.deepEqual(got[0], [`${path}.guardian`, `127.0.0.1:${p + 1000}`, `127.0.0.1:${p + 2000}`, `127.0.0.1:${p + 4000}`, `ws://127.0.0.1:${p}/guardian`]);
      assert.deepEqual(got[1], [`${path}.guardian-next`, `127.0.0.1:${p + 5000}`, `127.0.0.1:${p + 6000}`, `127.0.0.1:${p + 8000}`, `ws://127.0.0.1:${p}/guardian-next`]);
      assert.ok(existsSync(`${path}.guardian-next/admin-password`));
    } finally { await n.close(); }
    // without ARENA_FOUNDING_NEXT: the keyed guardian alone, as before
    const p2 = await port(23211);
    const before = (await lines(seen, 2)).length;
    const m = await launchNode({ db: openStore(path), path }, { port: p2 }, chain({ ARENA_FOUNDING: '1' }));
    try {
      assert.deepEqual([m.guardianRunning, m.guardianNextRunning], [true, false]);
      assert.deepEqual(await getGuardian(p2), { guardian: true, endpoint: `ws://127.0.0.1:${p2}/guardian` });
      assert.equal((await lines(seen, before + 1)).length, before + 1);
    } finally { await m.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// THE GUARDIAN WIRINGS (2026-10-15 "allow it"): a seat with a keyed guardian hands serve its dataDir - the absence
// producer starts (and the spent-set producer where ARENA_SPENT_SET_CLIENT_DIR names a client); the founding runs only with ARENA_FOUNDING=1.
test('a keyed guardian\'s seat starts the absence and spent-set producers; the founding only with ARENA_FOUNDING=1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-start-wiring-'));
  const { chain } = standInSeen(dir);
  const was = { f: process.env.ARENA_FOUNDING, s: process.env.ARENA_SPENT_SET_CLIENT_DIR };
  const put = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  try {
    const path = join(dir, 'k.db');
    founded(path);
    put('ARENA_SPENT_SET_CLIENT_DIR', join(dir, 'client'));
    put('ARENA_FOUNDING', undefined);
    const p = await port(23311);
    const a = await launchNode({ db: openStore(path), path }, { port: p, chainTip: async () => 1000 }, chain({}));
    try {
      assert.equal(a.guardians.own.dataDir, `${path}.guardian`);
      assert.deepEqual(a.guardianWiring(), { founding: false, absences: true, spentSet: true }, 'no ARENA_FOUNDING: no founding');
    } finally { await a.close(); }
    put('ARENA_FOUNDING', '1');
    const p2 = await port(23411);
    const b = await launchNode({ db: openStore(path), path }, { port: p2, chainTip: async () => 1000 }, chain({ ARENA_FOUNDING: '1' }));
    try { assert.deepEqual(b.guardianWiring(), { founding: true, absences: true, spentSet: true }); } finally { await b.close(); }
    // a seat without a guardian: none of them
    put('ARENA_FOUNDING', undefined);
    const bare = join(dir, 'bare.db');
    const p3 = await port(23511);
    const c = await launchNode({ db: openStore(bare), path: bare }, { port: p3, chainTip: async () => 1000 }, chain({}));
    try { assert.deepEqual(c.guardianWiring(), { founding: false, absences: false, spentSet: false }); } finally { await c.close(); }
  } finally { put('ARENA_FOUNDING', was.f); put('ARENA_SPENT_SET_CLIENT_DIR', was.s); rmSync(dir, { recursive: true, force: true }); }
});
