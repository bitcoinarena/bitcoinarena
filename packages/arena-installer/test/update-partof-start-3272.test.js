// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// LND STARTS AGAIN AFTER AN UPDATE (kanban #3272, a local seat 2026.1.9.28 -> .29, 2026-11-21): LND is PartOf its Tor. The update stops the
// units that name the old release - Tor among them, LND not (it runs from lnd-bin/) - and systemd stops LND with Tor. Starting those units
// again started Tor but not LND (PartOf= passes on no start), so LND stayed dead and the gateway Disconnected until started by hand.
// A Linux node played with no process, as in #1440: systemctl's stop takes the PartOf units along, its start starts only the units named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateNode, releaseOfUnit, partOfCompanions } from '../src/update.js';
import { seatUnit, UNIT, unitName } from '../src/service.js';

const KEY = Buffer.alloc(32, 7);
const fast = (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 20)));
const TOR = unitName('tor'), LND = unitName('lnd');

function linuxNode() {
  const root = mkdtempSync(join(tmpdir(), 'update-3272-'));
  const home = join(root, 'home'), cfg = join(root, 'cfg');
  mkdirSync(home, { recursive: true });
  const env = { HOME: root, XDG_CONFIG_HOME: cfg, PATH: process.env.PATH };
  const units = join(cfg, 'systemd', 'user'); mkdirSync(units, { recursive: true });
  const port = 18000 + Math.floor(Math.random() * 1000);
  const release = (v) => {
    const dir = join(root, 'releases', `bitcoin-arena-node-${v}-linux-x64`);
    mkdirSync(join(dir, 'packages', 'arena-node'), { recursive: true });
    writeFileSync(join(dir, 'VERSION'), `${v}\n`); writeFileSync(join(dir, 'COMMIT'), `${createHash('sha256').update(v).digest('hex')}\n`);
    return dir;
  };
  const running = new Set();
  const n = { root, home, units, running, release, calls: [], seat: null };
  const partOf = (u) => { try { return (readFileSync(join(units, u), 'utf8').match(/^PartOf=(.*)$/m) || [, ''])[1].trim().split(/\s+/); } catch { return []; } };
  n.sh = async (cmd, args) => {
    if (cmd !== 'systemctl') return { ok: true, out: '', err: '' };
    const [, verb, ...names] = args;
    n.calls.push(`${verb} ${names.join(' ')}`);
    if (verb === 'stop') for (const u of [...running]) if (names.includes(u) || partOf(u).some((p) => names.includes(p))) running.delete(u);
    if (verb === 'start') for (const u of names) running.add(u);
    n.seat = running.has(UNIT) ? releaseOfUnit(readFileSync(join(units, UNIT), 'utf8')) : null;
    return { ok: true, out: '', err: '' };
  };
  n.fetcher = async (url) => {
    if (!n.seat) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const path = new URL(url).pathname;
    if (path === '/identity') return new Response(KEY, { status: 200 });
    if (path === '/owner/version') return new Response(JSON.stringify({ version: readFileSync(join(n.seat, 'VERSION'), 'utf8').trim(), commit: readFileSync(join(n.seat, 'COMMIT'), 'utf8').trim() }), { status: 200 });
    return new Response('', { status: 404 });
  };
  n.install = (v1) => {
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 }, release: { path: v1 } }));
    writeFileSync(join(home, 'arena.conf'), `network=testnet4\nport=${port}\n`);
    writeFileSync(join(home, 'node.db'), 'the database of the node\n');
    writeFileSync(join(units, UNIT), seatUnit({ node: process.execPath, release: v1, home, port }));
    writeFileSync(join(units, TOR), `[Unit]\nDescription=Tor\n\n[Service]\nExecStart=${join(home, 'tor', 'run-tor.sh')} ${join(v1, 'runtime', 'tor', 'tor')}\n\n[Install]\nWantedBy=default.target\n`);
    // the pinned LND: it names no release, so the update does not move its file
    writeFileSync(join(units, LND), `[Unit]\nDescription=LND\nAfter=network-online.target ${TOR}\nPartOf=${TOR}\n\n[Service]\nExecStart=${join(home, 'lnd-bin', 'lnd-linux-amd64-v0.21.5-beta.rc1', 'lnd')} --lnddir=${join(home, 'lnd')}\n\n[Install]\nWantedBy=default.target\n`);
    for (const u of [UNIT, TOR, LND]) running.add(u);
    n.seat = v1;
  };
  n.update = (to) => updateNode({ home, newRelease: to, port, env, sh: n.sh, fetcher: n.fetcher, platform: 'linux', arch: 'x64', nowMs: () => 0, sleep: fast,
    waitMs: 1500, fetchApps: async () => ({ ok: true }), refreshGames: null });
  return n;
}

test('#3272 an update that stops Tor starts its LND again: LND is PartOf Tor and names no release', async () => {
  const n = linuxNode();
  try {
    const v1 = n.release('2026.1.9.28'), v2 = n.release('2026.1.9.29');
    n.install(v1);
    const r = await n.update(v2);
    assert.equal(r.ok, true, r.why);
    assert.ok(n.calls.some((c) => c.startsWith('stop ') && c.split(' ').includes(TOR)), 'Tor was stopped (it names the old release)');
    assert.ok(!n.calls.some((c) => c.startsWith('stop ') && c.split(' ').includes(LND)), 'LND was not named in the stop: systemd took it along');
    assert.ok(n.running.has(TOR), 'Tor runs again');
    assert.ok(n.running.has(LND), 'LND runs again');
    assert.match(readFileSync(join(n.units, LND), 'utf8'), /lnd-bin/, 'the LND unit is unchanged');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('#3272 partOfCompanions: the units PartOf a started one, not those already started, not those PartOf another', () => {
  const dir = mkdtempSync(join(tmpdir(), 'partof-3272-'));
  try {
    const f = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
    const tor = f('arena-tor.service', '[Unit]\n'), lnd = f('arena-lnd.service', '[Unit]\nPartOf=arena-tor.service\n');
    const both = f('arena-x.service', '[Unit]\nPartOf=arena-other.service arena-tor.service\n'), other = f('arena-y.service', '[Unit]\nPartOf=arena-other.service\n');
    const all = [tor, lnd, both, other, join(dir, 'arena-gone.service')];
    assert.deepEqual(partOfCompanions([tor], all), [lnd, both]);
    assert.deepEqual(partOfCompanions([tor, lnd], all), [both]);
    assert.deepEqual(partOfCompanions([other], all), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
