// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENANODE COMMAND: the services of an installed node found from the files the installer wrote, their states, the
// guardian inside the seat, start/stop/restart in order (one or all), a restarted quick tunnel's name followed into every file of the
// node (macOS node B's gateway still announced a name two restarts old), the doctor's checks with their fixes, `config set`, and the
// command written onto the PATH. systemctl / launchctl / ps are played by a fake `sh`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installedServices, overview, control, bootOf, setBoot, followTunnelNow, doctor, servicesNamed, serviceId } from '../src/node-services.js';
import { main } from '../src/arenanode.js';
import { writeCommand } from '../src/launchers.js';
import { formatConf, parseConf } from '../../arena-node/src/arena-conf.js';

const OLD = 'event-shows-dealing-appreciated.trycloudflare.com', NOW = 'muslim-charges-marble-invoice.trycloudflare.com', NEW = 'fresh-name-after-restart.trycloudflare.com';

/** A node as the installer leaves it on Linux: arena.conf, state.json, units for tor, LND, the gateway (announcing an old tunnel name), the seat, its tunnel. */
function linuxNode({ port }) {
  const root = mkdtempSync(join(tmpdir(), 'arenanode-'));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const env = { XDG_CONFIG_HOME: join(root, 'config'), HOME: join(root, 'user') };
  const units = join(env.XDG_CONFIG_HOME, 'systemd', 'user'); mkdirSync(units, { recursive: true });
  writeFileSync(join(home, 'arena.conf'), formatConf({ network: 'testnet4', port: String(port), database: join(home, 'node.db'), bind: '127.0.0.1',
    public_url: `https://${NOW}`, roles: 'verify,settlement,custody', fedimintd: '/r/runtime/custody/fedimintd', guardian_endpoint: `wss://${NOW}/guardian` }));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', reach: { mode: 'quick', port, url: `https://${NOW}` }, release: { path: '/r' } }));
  for (const id of ['tor', 'lnd', 'node', 'tunnel']) writeFileSync(join(units, `arena-${id}.service`), `[Service]\nExecStart=/r/${id}\n`);
  writeFileSync(join(units, 'arena-gateway.service'), `[Service]\nExecStart=/r/gatewayd --api-addr=https://${OLD}/gateway/\n`);
  writeFileSync(join(units, 'arena-node--b.service'), '[Service]\nExecStart=/other/node\n');   // another node's: not this one's
  writeFileSync(join(units, 'arena-nostr-relay.service'), '[Service]\nExecStart=/x\n');      // not an installer service at all
  return { root, home, env, units };
}

/** systemctl and ps, played: every unit active with a pid; the seat's child is fedimintd. Records each call. */
function fakeSh({ stopped = [] } = {}) {
  const calls = [];
  const pids = { 'arena-tor.service': 101, 'arena-lnd.service': 102, 'arena-gateway.service': 103, 'arena-node.service': 104, 'arena-tunnel.service': 105 };
  const sh = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'systemctl' && args[1] === 'show') {
      const u = args[2]; const up = !stopped.includes(u);
      return { ok: true, out: `ActiveState=${up ? 'active' : 'inactive'}\nSubState=${up ? 'running' : 'dead'}\nMainPID=${up ? pids[u] || 0 : 0}\nNRestarts=0\n`, err: '' };
    }
    if (cmd === 'ps') return { ok: true, out: '  104     1 node\n  777   104 /r/runtime/custody/fedimintd\n  888     1 fedimintd\n', err: '' };
    if (cmd === 'journalctl') return { ok: true, out: `2026-10-19T06:00:00Z INF |  https://${NEW}  |\n`, err: '' };
    return { ok: true, out: '', err: '' };
  };
  return { sh, calls };
}

const seat = (identity) => new Promise((ok) => {
  const s = http.createServer((req, res) => { if (req.url === '/identity') { res.writeHead(200); return res.end(Buffer.from(identity, 'hex')); } res.writeHead(404); res.end(); });
  s.listen(0, '127.0.0.1', () => ok({ port: s.address().port, close: () => s.close() }));
});

test('the services of this node, from its files: in start order, another node\'s and foreign units left out, the guardian inside the seat', async () => {
  const n = linuxNode({ port: 8470 });
  try {
    const svcs = installedServices({ home: n.home, platform: 'linux', env: n.env });
    assert.deepEqual(svcs.map((s) => s.id), ['tor', 'lnd', 'gateway', 'node', 'guardian', 'tunnel']);
    assert.deepEqual(servicesNamed('fedimintd', svcs).list.map((s) => s.id), ['node'], 'the guardian is acted on through its node');
    assert.match(servicesNamed('guardian', svcs).note, /inside the node/);
    assert.match(servicesNamed('nope', svcs).why, /no service "nope"/);
    assert.equal(serviceId('bitcoind'), 'bitcoind-testnet4');
    const { sh } = fakeSh({ stopped: ['arena-lnd.service'] });
    const v = await overview({ home: n.home, platform: 'linux', env: n.env, sh, probes: false });
    const by = Object.fromEntries(v.services.map((s) => [s.id, s]));
    assert.deepEqual([by.lnd.running, by.lnd.detail], [false, 'inactive (dead)']);
    assert.deepEqual([by.node.running, by.node.pid], [true, 104]);
    assert.deepEqual([by.guardian.running, by.guardian.pid], [true, 777], 'the fedimintd whose parent is the seat, not another one');
    assert.equal(v.publicUrl, `https://${NOW}`);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('start / stop / restart: all in order, stop in reverse, one by name; a restarted quick tunnel\'s new name goes into arena.conf, state and the gateway, which restart', async () => {
  const n = linuxNode({ port: 8470 });
  try {
    const { sh, calls } = fakeSh();
    const acts = () => calls.filter((c) => c[0] === 'systemctl' && ['start', 'stop', 'restart'].includes(c[2])).map((c) => `${c[2]} ${c[3]}`);
    const quickUrl = async () => `https://${NEW}`;
    const stop = await control('stop', null, { home: n.home, platform: 'linux', env: n.env, sh, quickUrl });
    assert.equal(stop.ok, true);
    assert.deepEqual(acts(), ['stop arena-tunnel.service', 'stop arena-node.service', 'stop arena-gateway.service', 'stop arena-lnd.service', 'stop arena-tor.service']);
    calls.length = 0;
    const one = await control('restart', 'lightning', { home: n.home, platform: 'linux', env: n.env, sh, quickUrl });
    assert.deepEqual([one.ok, acts()], [true, ['restart arena-lnd.service']]);
    calls.length = 0;
    const t = await control('restart', 'tunnel', { home: n.home, platform: 'linux', env: n.env, sh, quickUrl });
    assert.equal(t.ok, true);
    assert.equal(t.tunnel.url, `https://${NEW}`);
    assert.deepEqual(acts(), ['restart arena-tunnel.service', 'restart arena-gateway.service', 'restart arena-node.service'], 'the gateway and the seat take the new name');
    const conf = parseConf(readFileSync(join(n.home, 'arena.conf'), 'utf8')).values;
    assert.deepEqual([conf.public_url, conf.guardian_endpoint], [`https://${NEW}`, `wss://${NEW}/guardian`]);
    assert.equal(JSON.parse(readFileSync(join(n.home, 'state.json'), 'utf8')).reach.url, `https://${NEW}`);
    assert.match(readFileSync(join(n.units, 'arena-gateway.service'), 'utf8'), new RegExp(`--api-addr=https://${NEW}/gateway/`), 'the gateway\'s stale name too');
    assert.match(readFileSync(join(n.units, 'arena-node--b.service'), 'utf8'), /\/other\/node/, 'another node\'s unit untouched');
    assert.match((await control('restart', 'bitcoind', { home: n.home, platform: 'linux', env: n.env, sh })).why, /no bitcoind-testnet4 service/);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('macOS: launchd agents found by label, a stopped one bootstrapped, a loaded one kickstarted, a restart booted out and bootstrapped from its file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arenanode-mac-'));
  try {
    const env = { HOME: join(root, 'user') };
    const agents = join(env.HOME, 'Library', 'LaunchAgents'); mkdirSync(agents, { recursive: true });
    const home = join(root, 'home'); mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'arena.conf'), formatConf({ port: '8470' }));
    writeFileSync(join(home, 'state.json'), '{}');
    for (const l of ['io.bitcoin-arena.node', 'io.bitcoin-arena.node.lnd', 'io.bitcoin-arena.node.tunnel', 'io.bitcoin-arena.node--b']) writeFileSync(join(agents, `${l}.plist`), '<plist/>');
    const calls = [];
    const sh = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'launchctl' && args[0] === 'print') return args[1].endsWith('.lnd') ? { ok: false, out: '', err: 'Could not find service' } : { ok: true, out: '\tstate = running\n\tpid = 4242\n', err: '' };
      return { ok: true, out: '', err: '' };
    };
    const v = await overview({ home, platform: 'darwin', env, sh, probes: false });
    assert.deepEqual(v.services.map((s) => [s.id, s.running, s.pid]), [['lnd', false, null], ['node', true, 4242], ['tunnel', true, 4242]]);
    calls.length = 0;
    await control('start', null, { home, platform: 'darwin', env, sh, quickUrl: async () => null });
    const verbs = calls.filter((c) => c[1] !== 'print').map((c) => `${c[1]} ${c.at(-1).split('/').pop()}`);
    assert.deepEqual(verbs, ['bootstrap io.bitcoin-arena.node.lnd.plist', 'kickstart io.bitcoin-arena.node', 'kickstart io.bitcoin-arena.node.tunnel']);
    calls.length = 0;
    await control('restart', 'node', { home, platform: 'darwin', env, sh });
    assert.deepEqual(calls.filter((c) => c[1] !== 'print').map((c) => `${c[1]} ${c.at(-1).split('/').pop()}`), ['bootout io.bitcoin-arena.node', 'bootstrap io.bitcoin-arena.node.plist'],
      'a restart reloads the agent\'s file (a gateway whose plist took the tunnel\'s new name)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the doctor: a stopped service, a stale announced address and a missing bond each come with the command that fixes them; the seat and its tunnel probed', async () => {
  const id = 'ab'.repeat(32);
  const s = await seat(id);
  const n = linuxNode({ port: s.port });
  try {
    const { sh } = fakeSh({ stopped: ['arena-lnd.service'] });
    const fetcher = async (url, o) => (String(url).startsWith(`https://${NOW}`) ? fetch(`http://127.0.0.1:${s.port}/identity`, o) : fetch(url, o));
    const checks = await doctor({ home: n.home, platform: 'linux', env: n.env, sh, fetcher, latest: async () => ({ latest: { version: '0.1.0-rc.30' }, newer: true }) });
    const by = Object.fromEntries(checks.map((c) => [c.check, c]));
    assert.equal(by['arena.conf'].ok, true);
    assert.deepEqual([by['Lightning (LND)'].ok, by['Lightning (LND)'].fix], [false, 'arenanode start lnd   (then: arenanode logs lnd)']);
    assert.match(by['Bitcoin Arena node (seat)'].says, new RegExp(`answers on port ${s.port} as abababab`));
    assert.equal(by['Tunnel (cloudflared)'].ok, true, by['Tunnel (cloudflared)'].says);
    assert.equal(by['Guardian (fedimintd)'].ok, false, 'nothing on its API port');
    assert.equal(by['Quick tunnel name'].ok, false, 'the tunnel logs another name than the node names');
    assert.match(by['Lightning gateway address'].says, new RegExp(`announces ${OLD.replace(/\./g, '\\.')}`));
    assert.equal(by['Lightning gateway address'].fix.startsWith('arenanode restart tunnel'), true);
    assert.deepEqual([by.Bond.ok, by.Bond.fix], [null, 'arena-install (the installer\'s bond step)']);
    assert.equal(by.Release.ok, null);
    // the command prints them and says how many
    const out = [];
    const code = await main(['doctor'], { home: n.home, io: { out: (l) => out.push(l), err: (l) => out.push(l) }, deps: { platform: 'linux', env: n.env, sh, fetcher } });
    assert.equal(code, 1);
    assert.match(out.join('\n'), /✗ Lightning \(LND\)\s+inactive \(dead\)\n\s+fix: arenanode start lnd/);
    assert.match(out.at(-1), /^\d+ problem\(s\)\.$/);
  } finally { s.close(); rmSync(n.root, { recursive: true, force: true }); }
});

test('the doctor: a bond confirmed too late to count says so, with the way out (measured: seven testnet4 bonds confirmed 23 blocks late)', async () => {
  const n = linuxNode({ port: 8470 });
  try {
    const { sh } = fakeSh();
    const state = JSON.parse(readFileSync(join(n.home, 'state.json'), 'utf8'));
    const st = (h) => async (url) => (String(url).includes('/tx/') ? { json: async () => ({ confirmed: true, block_height: h }) } : (() => { throw new Error('offline'); })());
    writeFileSync(join(n.home, 'state.json'), JSON.stringify({ ...state, bond: { txid: 'e6'.repeat(32), maturity: 157121 } }));
    let by = Object.fromEntries((await doctor({ home: n.home, platform: 'linux', env: n.env, sh, fetcher: st(157000) })).map((c) => [c.check, c]));
    assert.equal(by.Bond.ok, false);
    assert.match(by.Bond.says, /confirmed in block 157000, too late: its maturity 157121 is 23 block\(s\) short of that plus the lock, so the census never counts it/);
    assert.match(by.Bond.fix, /^post a new bond: arena-install \(the bond step\); this one is locked until block 157121$/);
    by = Object.fromEntries((await doctor({ home: n.home, platform: 'linux', env: n.env, sh, fetcher: st(156977) })).map((c) => [c.check, c]));
    assert.equal(by.Bond.ok, true, by.Bond.says);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('arenanode status / config / help: a table of every service, settings read and changed in arena.conf', async () => {
  const n = linuxNode({ port: 8470 });
  try {
    const { sh } = fakeSh();
    const out = [];
    const io = { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) };
    const deps = { platform: 'linux', env: n.env, sh, fetcher: async () => { throw new Error('offline'); } };
    await main(['status'], { home: n.home, io, deps });
    const text = out.join('\n');
    for (const t of ['Tor', 'Lightning (LND)', 'Lightning gateway', 'Arena node (seat)', 'Guardian (fedimintd)', 'Tunnel (cloudflared)']) assert.match(text, new RegExp(t.replace(/[()]/g, '\\$&')));
    assert.match(text, /settings {2}.*arena\.conf/);
    out.length = 0;
    assert.equal(await main(['config', 'get', 'roles'], { home: n.home, io, deps }), 0);
    assert.deepEqual(out, ['verify,settlement,custody']);
    out.length = 0;
    assert.equal(await main(['config', 'set', 'bind', '0.0.0.0'], { home: n.home, io, deps }), 0);
    assert.equal(parseConf(readFileSync(join(n.home, 'arena.conf'), 'utf8')).values.bind, '0.0.0.0');
    assert.equal(await main(['config', 'set', 'port', 'x'], { home: n.home, io, deps }), 2, 'no port');
    assert.equal(await main(['nonsense'], { home: n.home, io, deps }), 2);
    out.length = 0;
    await main(['help'], { home: n.home, io, deps, name: 'arenanode-b' });
    assert.match(out.join('\n'), /arenanode-b restart <service>/);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('the command on the PATH: a script with the node\'s home in it, linked into ~/.local/bin; Windows: a .cmd and the user PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'arenanode-cmd-'));
  try {
    const home = join(root, 'home'), H = join(root, 'user');
    const c = writeCommand({ home, release: '/r', node: '/r/runtime/node', platform: 'linux', env: { HOME: H, PATH: '/usr/bin' } });
    assert.equal(c.name, 'arenanode');
    assert.equal(readFileSync(join(home, 'bin', 'arenanode'), 'utf8').split('\n')[2], `exec '/r/runtime/node' '/r/packages/arena-installer/bin/arenanode.mjs' --home '${home}' --name arenanode "$@"`);
    assert.equal(realpathSync(join(H, '.local', 'bin', 'arenanode')), realpathSync(join(home, 'bin', 'arenanode')), 'macOS: /var is /private/var - both sides real');
    assert.match(readFileSync(join(H, '.profile'), 'utf8'), /export PATH=".*\/\.local\/bin:\$PATH"/, '~/.local/bin was not on the PATH: the login profile puts it there');
    assert.match(c.note, /new terminal/);
    // a file of that name that is not ours stays
    writeFileSync(join(root, 'mine'), 'x');
    mkdirSync(join(root, 'taken'));
    writeFileSync(join(root, 'taken', 'arenanode'), '#!/bin/sh\necho someone else\n');
    const d = writeCommand({ home, release: '/r', node: '/r/runtime/node', platform: 'linux', env: { HOME: H, PATH: join(root, 'taken') }, pathDirs: [join(root, 'taken')] });
    assert.equal(d.link, null);
    assert.equal(lstatSync(join(root, 'taken', 'arenanode')).isSymbolicLink(), false);
    const ran = [];
    const w = writeCommand({ home, release: 'C:\\r', node: 'C:\\r\\runtime\\node.exe', platform: 'win32', env: { HOME: H }, run: (cmd, args) => ran.push([cmd, ...args]) });
    assert.match(readFileSync(w.file, 'utf8'), /^@echo off\r\nrem .*\r\n"C:\\r\\runtime\\node\.exe" "C:\\r[\\/]packages[\\/]arena-installer[\\/]bin[\\/]arenanode\.mjs" --home ".*" --name arenanode %\*\r\n$/);
    assert.match(ran[0].at(-1), /SetEnvironmentVariable\('Path'/);
    assert.ok(w.pathSet instanceof Promise, 'the PATH change is handed back to be awaited (an update would end before it)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a quick tunnel whose new name is not in DNS yet is asked again before it counts (macOS node A: ENOTFOUND 10 s after its update)', async () => {
  const id = 'cd'.repeat(32);
  const s = await seat(id);
  const n = linuxNode({ port: s.port });
  try {
    const { sh } = fakeSh();
    let asked = 0;
    const fetcher = async (url, o) => {
      if (!String(url).startsWith(`https://${NOW}`)) return fetch(url, o);
      if (++asked < 3) { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }
      return fetch(`http://127.0.0.1:${s.port}/identity`, o);
    };
    const v = await overview({ home: n.home, platform: 'linux', env: n.env, sh, fetcher, dnsPauseMs: 10 });
    const t = v.services.find((x) => x.id === 'tunnel');
    assert.deepEqual([t.probe.ok, asked], [true, 3], t.probe.says);
    asked = -10;   // never found: it counts, with the reason
    const w = await overview({ home: n.home, platform: 'linux', env: n.env, sh, fetcher: async (url, o) => { if (String(url).startsWith('https://')) { const e = new TypeError('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; } return fetch(url, o); }, dnsPauseMs: 10 });
    assert.deepEqual([w.services.find((x) => x.id === 'tunnel').probe.ok, w.services.find((x) => x.id === 'tunnel').probe.says], [false, 'ENOTFOUND']);
  } finally { s.close(); rmSync(n.root, { recursive: true, force: true }); }
});

test('Windows, processes this user cannot see into (the Arena Node window in the desktop session): what answers counts as running, the rest unknown, never "stopped"', async () => {
  const id = 'ef'.repeat(32);
  const s = await seat(id);
  const root = mkdtempSync(join(tmpdir(), 'arenanode-win-'));
  try {
    const home = join(root, 'home'); mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'arena.conf'), formatConf({ port: String(s.port) }));
    writeFileSync(join(home, 'state.json'), '{}');
    writeFileSync(join(home, 'arena.conf'), formatConf({ port: String(s.port), fedimintd: 'C:\\r\\fedimintd.exe' }));
    for (const id2 of ['node', 'custody']) writeFileSync(join(home, `arena-${id2}.cmd`), '@echo off\r\n');
    // Win32_Process as a limited user sees other sessions' processes without their command lines
    const sh = async (cmd) => (cmd === 'powershell' ? { ok: true, out: JSON.stringify([{ ProcessId: 10, ParentProcessId: 4, Name: 'cmd.exe', CommandLine: null },
      { ProcessId: 11, ParentProcessId: 10, Name: 'node.exe', CommandLine: null }]), err: '' } : { ok: true, out: '', err: '' });
    const v = await overview({ home, platform: 'win32', env: {}, sh, dnsPauseMs: 10 });
    const by = Object.fromEntries(v.services.map((x) => [x.id, x]));
    assert.deepEqual([by.node.running, by.node.detail], [true, 'answers (its process is not visible to this user)'], 'the seat answers: running');
    assert.deepEqual([by.custody.running, by.custody.detail], [null, 'its process is not visible to this user'], 'nothing to ask: unknown');
    assert.equal(by.guardian.running, null, 'the guardian inside a node this user cannot see: not "stopped"');
    assert.match(by.guardian.detail, /not visible to this user, and nothing listens on its API port/, 'and why it is unknown');
    const out = [];
    const code = await main(['status'], { home, io: { out: (l) => out.push(l), err: (l) => out.push(l) }, deps: { platform: 'win32', env: {}, sh } });
    assert.equal(code, 0, 'unknown is no failure');
    assert.match(out.join('\n'), /• Custody agent\s+unknown/);
    assert.ok(!/stopped/.test(out.join('\n')));
  } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a node installed fresh knows its release: the one this code is part of, when state.json names none (2026.1.0 fresh on the test host: "version unknown", no auto update)', async () => {
  const { nodeOf } = await import('../src/node-services.js');
  const root = mkdtempSync(join(tmpdir(), 'own-release-'));
  try {
    const rel = join(root, 'arena-node-2026.1.0-linux-x64'); mkdirSync(rel, { recursive: true }); writeFileSync(join(rel, 'VERSION'), '2026.1.0\n');
    const home = join(root, 'home'); mkdirSync(home);
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4' }));
    assert.deepEqual([nodeOf(home, { ownRelease: rel }).version, nodeOf(home, { ownRelease: rel }).release], ['2026.1.0', rel]);
    assert.equal(nodeOf(home, { ownRelease: null }).version, null, 'a checkout is no release');
    const other = join(root, 'arena-node-2026.1.1-linux-x64'); mkdirSync(other); writeFileSync(join(other, 'VERSION'), '2026.1.1\n');
    writeFileSync(join(home, 'state.json'), JSON.stringify({ release: { path: other } }));
    assert.equal(nodeOf(home, { ownRelease: rel }).version, '2026.1.1', 'the release state.json records wins');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a quick tunnel that came back by itself (a reboot) is followed without the owner: its newest name into arena.conf, state and the gateway, which restart; then nothing (kanban #562 2A)', async () => {
  const n = linuxNode({ port: 8470 });
  try {
    const { sh, calls } = fakeSh();
    const acts = () => calls.filter((c) => c[0] === 'systemctl' && ['start', 'stop', 'restart'].includes(c[2])).map((c) => `${c[2]} ${c[3]}`);
    writeFileSync(join(n.home, 'arena.conf'), readFileSync(join(n.home, 'arena.conf'), 'utf8').split(NOW).join(OLD));   // the seat still on the old name
    const one = await followTunnelNow({ home: n.home, platform: 'linux', env: n.env, sh });
    assert.equal(one.url, `https://${NEW}`, 'the newest name in the tunnel\'s log');
    assert.deepEqual(acts(), ['restart arena-gateway.service', 'restart arena-node.service'], 'in start order; the tunnel itself is not touched');
    assert.deepEqual(one.restarted, ['gateway', 'node']);
    const conf = parseConf(readFileSync(join(n.home, 'arena.conf'), 'utf8')).values;
    assert.deepEqual([conf.public_url, conf.guardian_endpoint], [`https://${NEW}`, `wss://${NEW}/guardian`]);
    assert.equal(JSON.parse(readFileSync(join(n.home, 'state.json'), 'utf8')).reach.url, `https://${NEW}`);
    calls.length = 0;
    const two = await followTunnelNow({ home: n.home, platform: 'linux', env: n.env, sh });
    assert.deepEqual([two.restarted, acts()], [[], []], 'the same name: nothing changed, nothing restarted');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('start at boot, one service at a time (kanban #563): Linux - the unit enabled or disabled; macOS - the agent\'s RunAtLoad; Windows - said, not per service', async () => {
  const n = linuxNode({ port: 8470 });
  try {
    const calls = [];
    const enabled = new Set(['arena-gateway.service']);
    const sh = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'systemctl' && args[1] === 'is-enabled') return { ok: enabled.has(args[2]), out: enabled.has(args[2]) ? 'enabled\n' : 'disabled\n', err: '' };
      if (cmd === 'systemctl' && (args[1] === 'enable' || args[1] === 'disable')) { args[1] === 'enable' ? enabled.add(args[2]) : enabled.delete(args[2]); return { ok: true, out: '', err: '' }; }
      return { ok: true, out: '', err: '' };
    };
    const svcs = installedServices({ home: n.home, platform: 'linux', env: n.env });
    const gw = svcs.find((x) => x.id === 'gateway'), tunnel = svcs.find((x) => x.id === 'tunnel');
    assert.deepEqual(await bootOf(gw, { platform: 'linux', sh }), { atBoot: true, settable: true });
    assert.deepEqual(await bootOf(tunnel, { platform: 'linux', sh }), { atBoot: false, settable: true });
    assert.deepEqual(await setBoot('tunnel', true, { home: n.home, platform: 'linux', env: n.env, sh }), { ok: true, id: 'tunnel', atBoot: true });
    assert.deepEqual(calls.at(-1), ['systemctl', '--user', 'enable', 'arena-tunnel.service']);
    assert.equal((await setBoot('gateway', false, { home: n.home, platform: 'linux', env: n.env, sh })).atBoot, false);
    assert.ok(!enabled.has('arena-gateway.service'));
    assert.equal(calls.filter((c) => ['start', 'stop', 'restart'].includes(c[2])).length, 0, 'nothing started or stopped by it');
    // macOS: the launch agent's RunAtLoad, read and set with PlistBuddy on the agent's file
    const plist = [];
    const shMac = async (cmd, args) => { plist.push([cmd, ...args]); return { ok: true, out: args[1] === 'Print :RunAtLoad' ? 'true\n' : '', err: '' }; };
    assert.deepEqual(await bootOf({ id: 'gateway', name: 'io.x.gateway', file: '/L/io.x.gateway.plist' }, { platform: 'darwin', sh: shMac }), { atBoot: true, settable: true });
    assert.equal((await bootOf({ id: 'guardian', file: null }, { platform: 'darwin', sh: shMac })).settable, false, 'inside the node: not the installer\'s');
    const win = await bootOf({ id: 'gateway', name: 'arena-gateway.cmd', file: 'C:/x.cmd' }, { platform: 'win32', sh: shMac });
    assert.deepEqual([win.settable, /at login/.test(win.why)], [false, true]);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

// BITCOIN CORE IS ASKED ON ITS OWN PORT (kanban #640, the owner's playtest: "restarting the electrum server, marks also the bitcoin server as
// available and running eventho its not installed or running"): on an Electrum node the bridge answers the seat's chain address, never for Core
test('on an Electrum node the Bitcoin Core row is not answered by the chain bridge', async () => {
  const { probeOf } = await import('../src/node-services.js');
  const { mkdtempSync: mk, writeFileSync: wf, rmSync: rm } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const dir = mk(join(td(), 'probe-')); wf(join(dir, 'bridge.cookie'), '__cookie__:x');
  const asked = [];
  const fetcher = async (url) => { asked.push(String(url)); return new Response(JSON.stringify({ result: { chain: 'testnet4', blocks: 10, headers: 10, initialblockdownload: false }, error: null, id: 1 })); };
  const node = { conf: { values: { bitcoind_url: 'http://127.0.0.1:8571/', bitcoind_cookie: join(dir, 'bridge.cookie') } }, state: { chain: { kind: 'electrum', host: 'e', port: 1 } } };
  try {
    const core = await probeOf({ id: 'bitcoind-testnet4' }, { node, fetcher });
    assert.deepEqual([core.ok, core.says], [false, 'no Bitcoin Core is set up for this node']);
    assert.deepEqual(asked, [], 'the bridge was not asked for Core');
    const bridge = await probeOf({ id: 'chain-bridge' }, { node, fetcher });
    assert.equal(bridge.ok, true, 'the bridge answers for itself');
  } finally { rm(dir, { recursive: true, force: true }); }
});

// THE DESKTOP APP'S LINE AND ITS DASHBOARD BUTTON (kanban #658): `state` says running or stopped in one line, `dashboard` names the page
test('arenanode state: running, running with a service down, stopped; arenanode dashboard: the node\'s dashboard', async () => {
  const n = linuxNode({ port: 8470 });
  try {
    const run = async (args, stopped = []) => {
      const out = [];
      const code = await main(args, { home: n.home, io: { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) }, deps: { platform: 'linux', env: n.env, sh: fakeSh({ stopped }).sh, noOpen: true } });
      return [code, out.join('\n')];
    };
    assert.deepEqual(await run(['state']), [0, 'running']);
    const [c1, t1] = await run(['state'], ['arena-tor.service']);
    assert.equal(c1, 0); assert.match(t1, /^running; not running: Tor/);
    const [c2, t2] = await run(['state'], ['arena-node.service']);
    assert.equal(c2, 1); assert.match(t2, /^stopped/);
    const [c3, t3] = await run(['dashboard']);
    assert.equal(c3, 0); assert.match(t3, /^http:\/\/127\.0\.0\.1:\d+\/dashboard$/, 'the local address: a quick tunnel\'s name changes at a restart, and the login is kept per address');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});
