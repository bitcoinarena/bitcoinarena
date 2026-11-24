// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3606 (state audit, node lifecycle): a service the owner STOPPED (owner page /owner/service stop + boot-off: the liquidity
// provider, the gateway) is started again by the next update. moveNode stops every unit that names the old release and then starts all
// of them (svc.start(moving)), whether it ran before or not - plus every unit PartOf one of them (#3272). The owner's "off" does not
// survive an auto update (every 30 min check finding a release).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateNode, releaseOfUnit } from '../src/update.js';
import { seatUnit, UNIT, unitName } from '../src/service.js';

const KEY = Buffer.alloc(32, 7);
const fast = (ms) => new Promise((ok) => setTimeout(ok, Math.min(ms, 20)));
const LIQ = unitName('liquidity'), TOR = unitName('tor'), LND = unitName('lnd');

function linuxNode() {
  const root = mkdtempSync(join(tmpdir(), 'wf1489-sm1-node-1-'));
  const home = join(root, 'home'), cfg = join(root, 'cfg');
  mkdirSync(home, { recursive: true });
  const env = { HOME: root, XDG_CONFIG_HOME: cfg, PATH: process.env.PATH };
  const units = join(cfg, 'systemd', 'user'); mkdirSync(units, { recursive: true });
  const port = 19000 + Math.floor(Math.random() * 1000);
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
    if (verb === 'is-active') return { ok: names.every((u) => running.has(u)), out: names.map((u) => (running.has(u) ? 'active' : 'inactive')).join('\n'), err: '' };
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
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify', 'liquidity'], done: { service: 1 }, release: { path: v1 } }));
    writeFileSync(join(home, 'arena.conf'), `network=testnet4\nport=${port}\n`);
    writeFileSync(join(home, 'node.db'), 'the database of the node\n');
    writeFileSync(join(units, UNIT), seatUnit({ node: process.execPath, release: v1, home, port }));
    // the liquidity provider runs from the release (as the installer writes it): its unit names v1
    writeFileSync(join(units, LIQ), `[Unit]\nDescription=Liquidity provider\n\n[Service]\nExecStart=${process.execPath} ${join(v1, 'packages', 'arena-node', 'tools', 'liquidity-provider.mjs')}\n\n[Install]\nWantedBy=default.target\n`);
    writeFileSync(join(units, TOR), `[Unit]\nDescription=Tor\n\n[Service]\nExecStart=${join(home, 'tor', 'run-tor.sh')} ${join(v1, 'runtime', 'tor', 'tor')}\n\n[Install]\nWantedBy=default.target\n`);
    writeFileSync(join(units, LND), `[Unit]\nDescription=LND\nAfter=network-online.target ${TOR}\nPartOf=${TOR}\n\n[Service]\nExecStart=${join(home, 'lnd-bin', 'lnd-linux-amd64-v0.21.5-beta.rc1', 'lnd')} --lnddir=${join(home, 'lnd')}\n\n[Install]\nWantedBy=default.target\n`);
    for (const u of [UNIT, LIQ, TOR, LND]) running.add(u);
    n.seat = v1;
  };
  n.update = (to) => updateNode({ home, newRelease: to, port, env, sh: n.sh, fetcher: n.fetcher, platform: 'linux', arch: 'x64', nowMs: () => 0, sleep: fast,
    waitMs: 1500, fetchApps: async () => ({ ok: true }), refreshGames: null });
  return n;
}

test('wf1489-sm1-node-1 (#3606): a service the owner stopped stays stopped across an update', async () => {
  const n = linuxNode();
  const v1 = n.release('2026.1.9.29'), v2 = n.release('2026.1.9.30');
  n.install(v1);
  // the owner page: Liquidity provider -> Stop (and boot-off), LND -> Stop (its channels closed by hand, say) - systemctl --user stop
  await n.sh('systemctl', ['--user', 'stop', LIQ]);
  await n.sh('systemctl', ['--user', 'stop', LND]);
  assert.ok(!n.running.has(LIQ) && !n.running.has(LND), 'stopped by the owner');
  const r = await n.update(v2);
  assert.equal(r.ok, true, r.why);
  assert.ok(n.running.has(UNIT), 'the seat runs the new release');
  assert.equal(n.running.has(LIQ), false, `the liquidity provider the owner stopped was started by the update (calls: ${n.calls.join(' | ')})`);
  assert.equal(n.running.has(LND), false, 'the LND the owner stopped was started by the update (PartOf companion)');
});
