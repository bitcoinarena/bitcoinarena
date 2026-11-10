// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE BITCOINARENA COMMAND (arenanode until kanban #688): the services of an installed node found from the files the installer wrote, their states, the
// guardian inside the seat, start/stop/restart in order (one or all), a restarted quick tunnel's name followed into every file of the
// node (macOS node B's gateway still announced a name two restarts old), the doctor's checks with their fixes, `config set`, and the
// command written onto the PATH. systemctl / launchctl / ps are played by a fake `sh`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installedServices, overview, control, bootOf, setBoot, followTunnelNow, doctor, servicesNamed, serviceId } from '../src/node-services.js';
import { main } from '../src/bitcoinarena.js';
import { writeCommand, legacyShim, commandBehind, ensureCommand, SHIM_MARK } from '../src/launchers.js';
import { formatConf, parseConf } from '../../arena-node/src/arena-conf.js';

const OLD = 'event-shows-dealing-appreciated.trycloudflare.com', NOW = 'muslim-charges-marble-invoice.trycloudflare.com', NEW = 'fresh-name-after-restart.trycloudflare.com';

/** A node as the installer leaves it on Linux: arena.conf, state.json, units for tor, LND, the gateway (announcing an old tunnel name), the seat, its tunnel. */
function linuxNode({ port }) {
  const root = mkdtempSync(join(tmpdir(), 'bitcoinarena-'));
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

// A GUARDIAN KEPT BEYOND THE SEAT (2026-10-26, the owner's services card on 2026.1.9.9: "Guardian (fedimintd) - the node runs without it" while
// it waited in setup): started apart so a restart does not end it, its parent is not the seat - its pid file names it
test('a guardian waiting in setup runs beside the seat: found by its pid file, and only that one', async () => {
  const n = linuxNode({ port: 8471 });
  try {
    const ps = (out) => async (cmd, args) => (cmd === 'ps' ? { ok: true, out, err: '' } : fakeSh({}).sh(cmd, args));
    const kept = '  104     1 node\n  888     1 /r/runtime/custody/fedimintd\n  999     1 fedimintd\n';
    const before = Object.fromEntries((await overview({ home: n.home, platform: 'linux', env: n.env, sh: ps(kept), probes: false })).services.map((s) => [s.id, s]));
    assert.deepEqual([before.guardian.running, before.guardian.detail], [false, 'the node runs without it'], 'no pid file: as before');
    mkdirSync(join(n.home, 'node.db.guardian'), { recursive: true });
    writeFileSync(join(n.home, 'node.db.guardian', 'fedimintd.pid'), '888\n');
    const by = Object.fromEntries((await overview({ home: n.home, platform: 'linux', env: n.env, sh: ps(kept), probes: false })).services.map((s) => [s.id, s]));
    assert.deepEqual([by.guardian.running, by.guardian.pid, by.guardian.detail], [true, 888, 'runs beside the node, kept through its restarts']);
    writeFileSync(join(n.home, 'node.db.guardian', 'fedimintd.pid'), '555\n');
    const gone = Object.fromEntries((await overview({ home: n.home, platform: 'linux', env: n.env, sh: ps(kept), probes: false })).services.map((s) => [s.id, s]));
    assert.equal(gone.guardian.running, false, 'a pid file naming no running fedimintd: not running');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

// ANOTHER NODE'S GUARDIAN ON THIS NODE'S PORT (the 2026.1.9.11 install test: the owner's card said "Running - its API answers" while this node's
// fedimintd had ended at its start, "Address already in use"): the status and the doctor ask with the node's own password, and say the log's reason
test('the guardian is this node\'s only when it takes this node\'s password; not running says its log\'s last error, in status and doctor alike', async () => {
  const n = linuxNode({ port: 8472 });
  try {
    mkdirSync(join(n.home, 'node.db.guardian'), { recursive: true });
    writeFileSync(join(n.home, 'node.db.guardian', 'fedimintd.log'), 'INFO starting\nERROR fedimintd: Bind address: 127.0.0.1:9472 ... Address already in use\n');
    const asked = [];
    const other = async (a) => { asked.push(a); return { ok: false, ours: false, says: `another guardian answers on its API port ${a.apiPort} and refuses this node's password` }; };
    const { sh } = fakeSh({});
    const by = Object.fromEntries((await overview({ home: n.home, platform: 'linux', env: n.env, sh, fetcher: async () => { throw new Error('ECONNREFUSED'); }, dnsPauseMs: 1, guardianCheck: other })).services.map((s) => [s.id, s]));
    assert.deepEqual(asked, [{ apiPort: 9472, dataDir: join(n.home, 'node.db.guardian') }], 'the seat\'s port + 1000, its own data dir');
    assert.equal(by.guardian.running, false, 'a fedimintd under the seat, but not the guardian on its port: not running');
    assert.match(by.guardian.detail, /another guardian answers on its API port 9472/);
    const checks = await doctor({ home: n.home, platform: 'linux', env: n.env, sh, fetcher: async () => { throw new Error('ECONNREFUSED'); }, guardianCheck: other });
    const g = checks.find((c) => c.check === 'Guardian (fedimintd)');
    assert.equal(g.ok, false); assert.match(g.says, /another guardian answers/);
    // no fedimintd at all: the log's last error is the reason
    const ps = async (cmd, args) => (cmd === 'ps' ? { ok: true, out: '  104     1 node\n', err: '' } : sh(cmd, args));
    const none = Object.fromEntries((await overview({ home: n.home, platform: 'linux', env: n.env, sh: ps, probes: false })).services.map((s) => [s.id, s]));
    assert.equal(none.guardian.detail, 'the node runs without it; its log: ERROR fedimintd: Bind address: 127.0.0.1:9472 ... Address already in use');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

// THE CHAIN BRIDGE TAKEN AWAY (the owner on 2026.1.9.9: "Do I need electrum when I have bitcoin core installed and running?")
test('removeProgram: the bridge\'s unit stopped and removed; nothing to do when there is none', async () => {
  const { removeProgram, unitName } = await import('../src/service.js');
  const n = linuxNode({ port: 8472 });
  try {
    const f = join(n.units, unitName('chain-bridge'));
    writeFileSync(f, '[Service]\nExecStart=/r/bridge\n');
    const calls = []; const sh = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true, out: '', err: '' }; };
    assert.deepEqual(await removeProgram({ id: 'chain-bridge', home: n.home, env: n.env, sh, platform: 'linux' }), { ok: true, removed: true });
    assert.ok(!existsSync(f));
    assert.deepEqual(calls, [`systemctl --user disable --now ${unitName('chain-bridge')}`, 'systemctl --user daemon-reload']);
    assert.deepEqual(await removeProgram({ id: 'chain-bridge', home: n.home, env: n.env, sh, platform: 'linux' }), { ok: true, removed: false });
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

// ANOTHER NODE'S BRIDGE OF THE SAME MACHINE (kanban #719: arena-chain-bridge--2.service restarted 840 times after the update): removed by its own name
test('removeProgram: a second node\'s bridge unit, named outright, is the one removed', async () => {
  const { removeProgram, unitName } = await import('../src/service.js');
  const n = linuxNode({ port: 8472 });
  try {
    const mine = join(n.units, unitName('chain-bridge')), second = join(n.units, 'arena-chain-bridge--2.service');
    writeFileSync(mine, '[Service]\nExecStart=/r/bridge\n'); writeFileSync(second, '[Service]\nExecStart=/r/bridge 2\n');
    const calls = []; const sh = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true, out: '', err: '' }; };
    assert.deepEqual(await removeProgram({ id: 'chain-bridge', home: n.home, env: n.env, sh, platform: 'linux', unit: 'arena-chain-bridge--2.service' }), { ok: true, removed: true });
    assert.deepEqual([existsSync(second), existsSync(mine)], [false, true], 'the second node\'s, not this one\'s');
    assert.equal(calls[0], 'systemctl --user disable --now arena-chain-bridge--2.service');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

// THE UPDATE SIGNS THE OWNER PAGE IN (2026-10-26, the owner on 2026.1.9.9: "The updater MUST fix my credentials in the browser so it works.
// This is very important" - "It works via owner page but not Open Dashboard"): once, until the key was handed over
test('sign-in-once and the dashboard: the one-time sign-in page opened while the key was never handed over, never after', async () => {
  const n = linuxNode({ port: 8773 });
  try {
    const st = join(n.home, 'state.json');
    writeFileSync(st, JSON.stringify({ ...JSON.parse(readFileSync(st, 'utf8')), owner: { mode: 'seed' }, service: { identity: 'ab'.repeat(32) } }));
    writeFileSync(join(n.home, 'seed.hex'), '11'.repeat(32));
    const opened = [], handoffs = [];
    const run = async (args) => {
      const out = [];
      const code = await main(args, { home: n.home, io: { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) },
        deps: { platform: 'linux', env: n.env, sh: fakeSh({}).sh, openUrl: async (u) => { opened.push(u); },
          handoff: async ({ target }) => { handoffs.push(target); return 'http://127.0.0.1:41000/tok'; } } });
      return [code, out.join('\n')];
    };
    const [c1, t1] = await run(['sign-in-once']);
    assert.equal(c1, 0); assert.match(t1, /Signing you in on your owner page once: http:\/\/127\.0\.0\.1:41000\/tok/);
    assert.deepEqual(handoffs, [`https://testnet.bitcoinarena.io/owner/#node=${'ab'.repeat(32)}&local=http%3A%2F%2F127.0.0.1%3A8773&owner-handoff`]);
    const [c2, t2] = await run(['dashboard']);
    assert.equal(c2, 0); assert.match(t2, /Signing you in[\s\S]*\nhttp:\/\/127\.0\.0\.1:8773\/dashboard$/, 'the dashboard: signed in first, then opened');
    assert.deepEqual(opened, ['http://127.0.0.1:41000/tok', 'http://127.0.0.1:41000/tok', 'http://127.0.0.1:8773/dashboard']);
    // handed over (owner-handoff.json): nothing more opens
    writeFileSync(join(n.home, 'owner-handoff.json'), JSON.stringify({ atMs: 1 }));
    opened.length = 0; handoffs.length = 0;
    const [, t3] = await run(['sign-in-once']);
    assert.match(t3, /has your key already/);
    await run(['dashboard']);
    assert.deepEqual([handoffs, opened], [[], ['http://127.0.0.1:8773/dashboard']]);
    // the update calls the same once it moved the node (bitcoinarena.js case 'update')
    assert.match(readFileSync(new URL('../src/bitcoinarena.js', import.meta.url), 'utf8'), /if \(r\.ok && !r\.upToDate\) await signInOnce\(home, deps, io\);/);
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
  const root = mkdtempSync(join(tmpdir(), 'bitcoinarena-mac-'));
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
    assert.deepEqual([by['Lightning (LND)'].ok, by['Lightning (LND)'].fix], [false, 'bitcoinarena start lnd   (then: bitcoinarena logs lnd)']);
    assert.match(by['Bitcoin Arena node (seat)'].says, new RegExp(`answers on port ${s.port} as abababab`));
    assert.equal(by['Tunnel (cloudflared)'].ok, true, by['Tunnel (cloudflared)'].says);
    assert.equal(by['Guardian (fedimintd)'].ok, false, 'nothing on its API port');
    assert.equal(by['Quick tunnel name'].ok, false, 'the tunnel logs another name than the node names');
    assert.match(by['Lightning gateway address'].says, new RegExp(`announces ${OLD.replace(/\./g, '\\.')}`));
    assert.equal(by['Lightning gateway address'].fix.startsWith('bitcoinarena restart tunnel'), true);
    assert.deepEqual([by.Bond.ok, by.Bond.fix], [null, 'the Bond section of the owner area (bitcoinarena open)'], 'set up in the owner area (kanban #728)');
    assert.equal(by.Release.ok, null);
    // the command prints them and says how many
    const out = [];
    const code = await main(['doctor'], { home: n.home, io: { out: (l) => out.push(l), err: (l) => out.push(l) }, deps: { platform: 'linux', env: n.env, sh, fetcher } });
    assert.equal(code, 1);
    assert.match(out.join('\n'), /✗ Lightning \(LND\)\s+inactive \(dead\)\n\s+fix: bitcoinarena start lnd/);
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

test('bitcoinarena status / config / help: a table of every service, settings read and changed in arena.conf', async () => {
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
    await main(['help'], { home: n.home, io, deps, name: 'bitcoinarena-b' });
    assert.match(out.join('\n'), /bitcoinarena-b restart <service>/);
    // the name it is called by, unless told another (kanban #688: "bitcoinarena, not arenanode")
    out.length = 0;
    await main(['help'], { home: n.home, io, deps });
    assert.match(out.join('\n'), /^bitcoinarena: your Bitcoin Arena node on this machine$/m);
    assert.match(out.join('\n'), /^ {2}bitcoinarena doctor {20}find problems/m);
    assert.ok(!/arenanode/.test(out.join('\n')), 'the help names only the new command');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('the command on the PATH: bitcoinarena with the node\'s home in it, arenanode beside it running it, both linked into ~/.local/bin; Windows: two .cmd and the user PATH (kanban #688)', () => {
  const root = mkdtempSync(join(tmpdir(), 'bitcoinarena-cmd-'));
  try {
    const home = join(root, 'home'), H = join(root, 'user');
    const c = writeCommand({ home, release: '/r', node: '/r/runtime/node', platform: 'linux', env: { HOME: H, PATH: '/usr/bin' } });
    assert.equal(c.name, 'bitcoinarena');
    assert.equal(readFileSync(join(home, 'bin', 'bitcoinarena'), 'utf8').split('\n')[2], `exec '/r/runtime/node' '/r/packages/arena-installer/bin/bitcoinarena.mjs' --home '${home}' --name bitcoinarena "$@"`);
    assert.equal(realpathSync(join(H, '.local', 'bin', 'bitcoinarena')), realpathSync(join(home, 'bin', 'bitcoinarena')), 'macOS: /var is /private/var - both sides real');
    // THE OLD NAME: a small script that runs the new command, linked beside it
    assert.deepEqual([c.legacy.name, c.legacy.file], ['arenanode', join(home, 'bin', 'arenanode')]);
    assert.equal(readFileSync(join(home, 'bin', 'arenanode'), 'utf8'), `#!/bin/sh\n# arenanode: the old name of this node's command, ${SHIM_MARK}\nexec '${join(home, 'bin', 'bitcoinarena')}' "$@"\n`);
    assert.equal(lstatSync(join(home, 'bin', 'arenanode')).mode & 0o777, 0o755);
    assert.equal(realpathSync(join(H, '.local', 'bin', 'arenanode')), realpathSync(join(home, 'bin', 'arenanode')));
    assert.match(readFileSync(join(H, '.profile'), 'utf8'), /# the bitcoinarena command \(Bitcoin Arena node\)\nexport PATH=".*\/\.local\/bin:\$PATH"/, '~/.local/bin was not on the PATH: the login profile puts it there');
    assert.match(c.note, /new terminal/);
    // a file of either name that is not ours stays
    mkdirSync(join(root, 'taken'));
    writeFileSync(join(root, 'taken', 'bitcoinarena'), '#!/bin/sh\necho someone else\n');
    const d = writeCommand({ home, release: '/r', node: '/r/runtime/node', platform: 'linux', env: { HOME: H, PATH: join(root, 'taken') }, pathDirs: [join(root, 'taken')] });
    assert.equal(d.link, null);
    assert.equal(lstatSync(join(root, 'taken', 'bitcoinarena')).isSymbolicLink(), false);
    mkdirSync(join(root, 'taken2'));
    writeFileSync(join(root, 'taken2', 'arenanode'), '#!/bin/sh\necho another arenanode\n');
    const e = writeCommand({ home, release: '/r', node: '/r/runtime/node', platform: 'linux', env: { HOME: H, PATH: join(root, 'taken2') }, pathDirs: [join(root, 'taken2')] });
    assert.deepEqual([e.link, e.legacy.link], [join(root, 'taken2', 'bitcoinarena'), null], 'the new name linked, the stranger\'s arenanode kept');
    assert.equal(readFileSync(join(root, 'taken2', 'arenanode'), 'utf8'), '#!/bin/sh\necho another arenanode\n');
    const ran = [];
    const w = writeCommand({ home, release: 'C:\\r', node: 'C:\\r\\runtime\\node.exe', platform: 'win32', env: { HOME: H }, run: (cmd, args) => ran.push([cmd, ...args]) });
    assert.match(readFileSync(w.file, 'utf8'), /^@echo off\r\nrem .*\r\n"C:\\r\\runtime\\node\.exe" "C:\\r[\\/]packages[\\/]arena-installer[\\/]bin[\\/]bitcoinarena\.mjs" --home ".*" --name bitcoinarena %\* & exit \/b\r\n$/);
    assert.equal(w.file.split(/[\\/]/).pop(), 'bitcoinarena.cmd');
    assert.equal(readFileSync(w.legacy.file, 'utf8'), `@echo off\r\nrem arenanode: the old name, ${SHIM_MARK}\r\ncall "%~dp0bitcoinarena.cmd" %*\r\nexit /b %errorlevel%\r\n`);
    assert.match(ran[0].at(-1), /SetEnvironmentVariable\('Path'/);
    assert.ok(w.pathSet instanceof Promise, 'the PATH change is handed back to be awaited (an update would end before it)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the old name runs the new command: every argument and the exit code through (75 is the auto update\'s "again")', () => {
  const root = mkdtempSync(join(tmpdir(), 'bitcoinarena-shim-'));
  try {
    const file = join(root, 'bitcoinarena');
    writeFileSync(file, '#!/bin/sh\necho "ran: $*"\nexit 75\n', { mode: 0o755 });
    writeFileSync(join(root, 'arenanode'), legacyShim({ name: 'arenanode', file, platform: 'linux' }), { mode: 0o755 });
    const r = spawnSync(join(root, 'arenanode'), ['restart', 'lnd', 'with space'], { encoding: 'utf8' });
    assert.deepEqual([r.status, r.stdout], [75, 'ran: restart lnd with space\n']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows: the old name\'s script is shorter than the full command an update rewrites while it runs, so cmd ends it after the node\'s line', () => {
  // cmd.exe reads a running batch file at its place: the auto update service runs through <home>\bin\arenanode.cmd (the full command of
  // 2026.1.9.7) and the update writes the shim over it - the place after the line that ran must be past the shim's end
  const home = 'C:\\Users\\a\\.arena-node';
  const full = ['@echo off', 'rem The arenanode command, written by the installer: arenanode status, arenanode restart lnd, arenanode doctor, arenanode help',
    `"${home}\\releases\\bitcoin-arena-node-2026.1.9.8-windows-x64\\runtime\\node.exe" "${home}\\releases\\bitcoin-arena-node-2026.1.9.8-windows-x64\\packages\\arena-installer\\bin\\arenanode.mjs" --home "${home}" --name arenanode %*`].join('\r\n') + '\r\n';
  for (const name of ['arenanode', 'arenanode-abcdefghijkl']) {
    const shim = legacyShim({ name, file: `${home}\\bin\\${name.replace('arenanode', 'bitcoinarena')}.cmd`, platform: 'win32' });
    assert.ok(shim.length < full.length, `${shim.length} < ${full.length}`);
  }
});

test('a node the update of 2026.1.9.7 moved: its arenanode names this release, bitcoinarena is missing - the first run writes both, once (kanban #688)', () => {
  const root = mkdtempSync(join(tmpdir(), 'bitcoinarena-behind-'));
  try {
    const home = join(root, '.arena-node'), H = join(root, 'user');
    const release = join(home, 'releases', 'bitcoin-arena-node-2026.1.9.8-linux-x64'), older = join(home, 'releases', 'bitcoin-arena-node-2026.1.9.7-linux-x64');
    mkdirSync(join(home, 'bin'), { recursive: true });
    // what the 2026.1.9.7 writeCommand writes
    const old197 = (rel) => `#!/bin/sh\n# The arenanode command, written by the installer: arenanode status, arenanode restart lnd, arenanode doctor, arenanode help\nexec '${rel}/runtime/node' '${rel}/packages/arena-installer/bin/arenanode.mjs' --home '${home}' --name arenanode "$@"\n`;
    writeFileSync(join(home, 'bin', 'arenanode'), old197(older), { mode: 0o755 });
    assert.equal(commandBehind({ home, release, platform: 'linux' }), false, 'it names another release (this code is not the node\'s): nothing is written');
    assert.equal(ensureCommand({ home, release, platform: 'linux', env: { HOME: H } }), null);
    writeFileSync(join(home, 'bin', 'arenanode'), old197(release), { mode: 0o755 });
    assert.equal(commandBehind({ home, release, platform: 'linux' }), true);
    const c = ensureCommand({ home, release, node: `${release}/runtime/node`, platform: 'linux', env: { HOME: H, PATH: join(H, '.local', 'bin') } });
    assert.equal(c.written.name, 'bitcoinarena');
    assert.match(readFileSync(join(home, 'bin', 'bitcoinarena'), 'utf8'), new RegExp(`exec '${release}/runtime/node' '${release}/packages/arena-installer/bin/bitcoinarena\\.mjs' --home '${home}' --name bitcoinarena "\\$@"`));
    assert.ok(readFileSync(join(home, 'bin', 'arenanode'), 'utf8').includes(SHIM_MARK));
    assert.equal(realpathSync(join(H, '.local', 'bin', 'bitcoinarena')), realpathSync(join(home, 'bin', 'bitcoinarena')));
    assert.equal(commandBehind({ home, release, platform: 'linux' }), false, 'once: the old name is the small script now');
    assert.equal(ensureCommand({ home, release, platform: 'linux', env: { HOME: H } }), null);
    // Windows: the same, by the release's folder whatever the slashes
    const wh = join(root, 'win');
    mkdirSync(join(wh, 'bin'), { recursive: true });
    writeFileSync(join(wh, 'bin', 'arenanode.cmd'), '@echo off\r\nrem The arenanode command\r\n"C:\\h\\releases\\bitcoin-arena-node-2026.1.9.8-windows-x64\\runtime\\node.exe" "C:\\h\\releases\\bitcoin-arena-node-2026.1.9.8-windows-x64\\packages\\arena-installer\\bin\\arenanode.mjs" --home "C:\\h" --name arenanode %*\r\n');
    assert.equal(commandBehind({ home: wh, release: 'C:/h/releases/bitcoin-arena-node-2026.1.9.8-windows-x64', platform: 'win32' }), true);
    assert.equal(commandBehind({ home: wh, release: 'C:\\h\\releases\\bitcoin-arena-node-2026.1.9.9-windows-x64', platform: 'win32' }), false);
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
  const root = mkdtempSync(join(tmpdir(), 'bitcoinarena-win-'));
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
test('bitcoinarena state: running, running with a service down, stopped; bitcoinarena dashboard: the node\'s dashboard', async () => {
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

// THE OWNER PAGE BUTTON (kanban #687, 2026-10-26 on 1.9.7: "the owner page still points to http://127.0.0.1:8770/dashboard/owner which
// doesn't have my secret"): the Arena site's owner page for this node's key, where the installer handed the key over; local= beside it
test('bitcoinarena open: the site\'s owner page for the node\'s key, from state.json or the node\'s /identity; the local page only with no key', async () => {
  const n = linuxNode({ port: 8770 });
  const key = 'ab'.repeat(32);
  try {
    const run = async (args, fetch) => {
      const out = [];
      const code = await main(args, { home: n.home, io: { out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) }, deps: { platform: 'linux', env: n.env, sh: fakeSh({}).sh, noOpen: true, fetch } });
      return [code, out.join('\n')];
    };
    const down = async () => { throw new Error('ECONNREFUSED'); };
    assert.deepEqual(await run(['open'], down), [0, 'http://127.0.0.1:8770/dashboard/owner'], 'no key known: the local page');
    const asked = [];
    const ident = async (u) => { asked.push(String(u)); return new Response(Buffer.from(key, 'hex')); };
    assert.deepEqual(await run(['open'], ident), [0, `https://testnet.bitcoinarena.io/owner/#node=${key}&local=http%3A%2F%2F127.0.0.1%3A8770`]);
    assert.deepEqual(asked, ['http://127.0.0.1:8770/identity']);
    const st = join(n.home, 'state.json');
    let j = {}; try { j = JSON.parse(readFileSync(st, 'utf8')); } catch { j = {}; }
    writeFileSync(st, JSON.stringify({ ...j, service: { ...(j.service || {}), identity: 'cd'.repeat(32) } }));
    assert.deepEqual(await run(['open'], down), [0, `https://testnet.bitcoinarena.io/owner/#node=${'cd'.repeat(32)}&local=http%3A%2F%2F127.0.0.1%3A8770`], 'the key the installer kept');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});
