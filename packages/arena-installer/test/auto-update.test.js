// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AUTO UPDATE: a newer signed release found, this system's asset fetched in pieces from the unlisted path, joined, its
// SHA-256 and SHA256SUMS checked before anything is unpacked, the node moved by update.js; off in arena.conf it only reports; the service
// ends with 75 after an update; its launchers start it again (systemd, launchd, the Windows loop).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkOnce, runAutoUpdate, assetNameFor, autoUpdateOn } from '../src/auto-update.js';
import { installUpdater } from '../src/launchers.js';
import { installProgram } from '../src/service.js';

function nodeAt({ version = '0.1.0', conf = 'port=8470\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'auto-update-'));
  const home = join(root, 'home'); const rel = join(home, 'releases', `arena-node-${version}-linux-x64`);
  mkdirSync(rel, { recursive: true });
  writeFileSync(join(rel, 'VERSION'), `${version}\n`);
  writeFileSync(join(home, 'arena.conf'), conf);
  writeFileSync(join(home, 'state.json'), JSON.stringify({ release: { path: rel } }));
  return { root, home };
}
// a "release" 0.1.1 for linux-x64: the asset's bytes in 3 pieces, served from an unlisted base
function served(bytes, { tamper = false } = {}) {
  const name = assetNameFor('0.1.1', 'linux', 'x64');
  const pieces = [bytes.subarray(0, 10), bytes.subarray(10, 25), bytes.subarray(25)];
  const files = new Map(pieces.map((p, i) => [`${name}.part0${i}`, tamper && i === 1 ? Buffer.from('x'.repeat(p.length)) : p]));
  files.set('SHA256SUMS', Buffer.from(`${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`));
  files.set('SHA256SUMS.sig', Buffer.from('sig'));
  const base = 'https://testnet.bitcoin-arena.io/release/u/folder123/v0.1.1/';
  const asked = [];
  const fetcher = async (url) => { asked.push(url); const f = files.get(url.slice(base.length)); return f ? { status: 200, arrayBuffer: async () => f } : { status: 404, arrayBuffer: async () => Buffer.alloc(0) }; };
  const latest = async (own) => ({ latest: { version: '0.1.1', assets: { [name]: createHash('sha256').update(bytes).digest('hex') },
    download: { base, sums: 'SHA256SUMS', sig: 'SHA256SUMS.sig', parts: { [name]: [...files.keys()].filter((k) => k.includes('.part')) } } }, newer: own !== '0.1.1' });
  return { name, fetcher, latest, asked };
}

test('a newer signed release: this system\'s pieces fetched, joined and checked, then unpacked and the node moved', async () => {
  const { root, home } = nodeAt();
  try {
    const bytes = Buffer.from('the whole release asset, exactly these bytes, nothing else'.repeat(3));
    const s = served(bytes);
    const applied = [], unpacked = [];
    const r = await checkOnce({ home, latest: s.latest, fetcher: s.fetcher, platform: 'linux', arch: 'x64', verifyAsset: ({ sums }) => ({ ok: String(sums).includes(s.name) }),
      unpack: (archive, dir) => { unpacked.push([archive, dir]); mkdirSync(join(dir, 'arena-node-0.1.1-linux-x64'), { recursive: true }); },
      apply: async (o) => { applied.push(o); return { ok: true, backup: '/b' }; } });
    assert.deepEqual([r.ok, r.from, r.to], [true, '0.1.0', '0.1.1']);
    const file = join(home, 'releases', 'downloads', '0.1.1', s.name);
    assert.deepEqual(readFileSync(file), bytes, 'the pieces joined are the asset');
    assert.equal(unpacked.length, 1);
    assert.equal(applied[0].newRelease, join(home, 'releases', 'arena-node-0.1.1-linux-x64'));
    assert.equal(applied[0].node, join(home, 'releases', 'arena-node-0.1.1-linux-x64', 'runtime', 'node'));
    assert.equal(applied[0].port, 8470);
    assert.equal(typeof applied[0].installUpdaterFn, 'function', 'the update brings the auto update service where it is missing');
    assert.equal(JSON.parse(readFileSync(join(home, 'auto-update.json'), 'utf8')).to, '0.1.1', 'recorded for status and the owner page');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a piece not as signed: nothing unpacked, nothing moved; a refused SHA256SUMS too; off: only reported; up to date: nothing', async () => {
  const { root, home } = nodeAt();
  try {
    const bytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'.repeat(4));
    const bad = served(bytes, { tamper: true });
    let applied = 0;
    const apply = async () => { applied++; return { ok: true }; };
    const r = await checkOnce({ home, latest: bad.latest, fetcher: bad.fetcher, platform: 'linux', arch: 'x64', verifyAsset: () => ({ ok: true }), unpack: () => { throw new Error('unpacked'); }, apply });
    assert.equal(r.ok, false); assert.match(r.why, /not the .* the signed latest\.json names: not used/);
    assert.equal(existsSync(join(home, 'releases', 'downloads', '0.1.1', bad.name)), false, 'the bad download is gone');
    const good = served(bytes);
    const refused = await checkOnce({ home, latest: good.latest, fetcher: good.fetcher, platform: 'linux', arch: 'x64', verifyAsset: () => ({ ok: false, why: 'SHA256SUMS is not signed by the Arena release key' }), unpack: () => { throw new Error('unpacked'); }, apply });
    assert.match(refused.why, /^refused: SHA256SUMS is not signed/);
    assert.equal(applied, 0);
    writeFileSync(join(home, 'arena.conf'), 'port=8470\nauto_update=0\n');
    assert.deepEqual(await checkOnce({ home, latest: good.latest, fetcher: good.fetcher, apply }), { ok: true, skipped: 'auto_update is off in arena.conf' });
    assert.equal(applied, 0);
    const { root: r2, home: h2 } = nodeAt({ version: '0.1.1' });
    assert.equal((await checkOnce({ home: h2, latest: good.latest, fetcher: good.fetcher, apply })).upToDate, true);
    rmSync(r2, { recursive: true, force: true });
    assert.deepEqual([autoUpdateOn({}), autoUpdateOn({ auto_update: 'off' }), autoUpdateOn({ auto_update: '1' })], [true, false, true]);
    assert.equal(assetNameFor('0.1.1', 'win32', 'x64'), 'arena-node-0.1.1-windows-x64.zip');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the service: it ends with 75 after an update (to come back from the new release), and keeps checking otherwise', async () => {
  const exits = [], slept = [];
  const results = [{ ok: true, upToDate: true, version: '0.1.0' }, { ok: false, why: 'offline' }, { ok: true, from: '0.1.0', to: '0.1.1' }];
  const code = await runAutoUpdate({ home: '/h', latest: null, log: () => {}, sleep: async (ms) => { slept.push(ms); }, exit: (c) => { exits.push(c); return c; },
    once: async () => results.shift(), rounds: 5, everyMs: 1000, firstMs: 10 });
  assert.equal(code, 75);
  assert.deepEqual(exits, [75]);
  assert.deepEqual(slept, [10, 1000, 1000], 'first wait, then a check each period until the update');
});

test('the updater as a service: it names the node\'s own arenanode (no release), and starts again after an update on every system', async () => {
  const root = mkdtempSync(join(tmpdir(), 'updater-svc-'));
  try {
    const home = join(root, 'home'); mkdirSync(home, { recursive: true });
    const env = { XDG_CONFIG_HOME: join(root, 'cfg'), HOME: join(root, 'user') };
    const sh = async () => ({ ok: true, out: '', err: '' });
    await installUpdater({ home, installProgram, platform: 'linux', env, sh });
    const unit = readFileSync(join(root, 'cfg', 'systemd', 'user', 'arena-updater.service'), 'utf8');
    assert.match(unit, new RegExp(`^ExecStart=${join(home, 'bin', 'arenanode').replace(/[/.]/g, '\\$&')} auto-update$`, 'm'));
    assert.match(unit, /^Restart=on-failure$/m, 'ending with 75 starts it again');
    await installUpdater({ home, installProgram, platform: 'win32', env: { APPDATA: join(root, 'appdata') }, sh });
    const cmd = readFileSync(join(home, 'arena-updater.cmd'), 'utf8');
    assert.match(cmd, /:again\r\n".*arenanode\.cmd" "auto-update" >> ".*updater\.log" 2>&1\r\nif %errorlevel%==75 goto again\r\n$/);
    const { readFileSync: rf } = await import('node:fs');
    assert.match(rf(new URL('../src/update.js', import.meta.url), 'utf8'), /-notlike '\*arenanode\.mjs\*auto-update\*'/, 'a Windows update does not end the auto update that runs it');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
