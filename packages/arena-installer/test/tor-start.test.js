// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// TOR ON LINUX (playtest 2026-10-25: "lnd and Tor fails on Linux, works on macOS"; measured in a fresh ubuntu:24.04 container: the
// release's tor stopped with "error while loading shared libraries: libevent-2.1.so.7"): on Linux tor starts through a launcher that
// puts its own folder on the library path; LND is told to use Tor only once Tor's control port answers, else it runs without it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { torCommand, writeTorrc, torLogOf, torCookieOf, torControlInfo, torComplaint, freeTorPorts } from '../src/tor.js';
import { setUpOwnLnd, torUp } from '../src/lnd-setup.js';
import { logsOf } from '../src/node-services.js';
import { nodeState } from '../src/state.js';

test('on Linux tor starts through a launcher with its own libraries; elsewhere tor itself', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-tor-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cmd = torCommand({ home, tor: '/r/runtime/tor/tor', platform: 'linux' });
  assert.deepEqual(cmd, [join(home, 'tor', 'run-tor.sh'), '/r/runtime/tor/tor']);
  const sh = readFileSync(cmd[0], 'utf8');
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.match(sh, /LD_LIBRARY_PATH="\$\(dirname "\$TOR"\)\$\{LD_LIBRARY_PATH:\+:\$LD_LIBRARY_PATH\}" exec "\$TOR" "\$@"/, 'tor\'s own folder, from its path: an update that moves tor moves it too');
  assert.ok(sh.includes(` >> '${join(home, 'tor', 'tor.log')}' 2>&1`), 'its output into tor.log: what it says before its log is open (kanban #670)');
  assert.ok(sh.includes(` >> '${join(home, 'tor', 'tor.log')}' 2>&1`), 'its output into tor.log: what it says before its log is open (kanban #670)');
  assert.equal(statSync(cmd[0]).mode & 0o100, 0o100, 'executable');
  assert.deepEqual(torCommand({ home, tor: '/r/runtime/tor/tor', platform: 'darwin' }), ['/r/runtime/tor/tor']);
});

test('LND gets Tor only once Tor answers; without it LND runs on clearnet and the node says why', async (t) => {
  const run = async (answers) => {
    const home = mkdtempSync(join(tmpdir(), 'arena-lndtor-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const state = nodeState(home);
    state.save({ chain: { kind: 'core', url: 'http://127.0.0.1:48332/', cookiePath: join(home, 'cookie') } });
    const programs = [], configured = [];
    const r = await setUpOwnLnd({ state, release: '/r', fetcher: async () => ({}),
      reach: { checkDirect: async () => ({ ok: true, reached: false }) },
      lndKit: { installLnd: async () => ({ ok: true, lnd: '/fake/lnd' }), lndArgs: () => ['/fake/lnd'],
        configureLnd: (o) => { configured.push(o); return { lnddir: join(home, 'lnd'), restUrl: 'https://127.0.0.1:8080', tlsCert: 'c', macaroon: 'm', passwordFile: 'p' }; },
        installProgram: async (o) => { programs.push(o); return { ok: true }; } },
      tor: { torBin: async () => '/r/runtime/tor/tor', writeTorrc: () => join(home, 'tor', 'torrc'), torCommand: ({ tor }) => ['/launcher', tor], torUp: async () => answers } });
    return { r, programs, configured, st: state.read() };
  };
  const up = await run(true);
  assert.equal(up.r.ok, true);
  assert.deepEqual(up.programs[0].args, ['/launcher', '/r/runtime/tor/tor', '-f', up.programs[0].args[3]], 'tor through its launcher');
  assert.ok(up.configured[0].tor, 'Tor answered: LND gets its [Tor] section');
  assert.match(up.r.peers, /Tor gives LND an onion address/);
  const down = await run(false);
  assert.equal(down.r.ok, true, 'LND still set up');
  assert.equal(down.configured[0].tor, null, 'Tor did not answer: LND runs without it');
  assert.match(down.st.tor.why, /Tor did not start \(its control port did not answer within 30 s\): LND runs without it/);
});

// TOR THAT IS NOT THIS NODE'S, AND TOR'S OWN WORDS (kanban #670, 2026-10-26: "tor is not starting and could be the reason lnd also doesnt
// start"). Measured the same day with the release's tor 0.4.9.14 (expert bundle 15.0.25) in scratch homes: a control port another program
// held stopped Tor at once - "Could not bind to 127.0.0.1:41051: Address already in use. Is Tor already running?" - and when that program
// was another Tor, the old check ("does the port answer") said Tor was up, so LND was told to use a Tor that was not its own.
const fakeTorControl = async (cookieFile) => {
  const srv = net.createServer((c) => c.on('data', (d) => {
    if (!/^PROTOCOLINFO/.test(String(d))) return;
    c.write(cookieFile ? `250-PROTOCOLINFO 1\r\n250-AUTH METHODS=COOKIE,SAFECOOKIE COOKIEFILE="${cookieFile.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\r\n250-VERSION Tor="0.4.9.14"\r\n250 OK\r\n` : 'HTTP/1.1 400 Bad Request\r\n\r\n');
    if (!cookieFile) c.end();
  }));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  return srv;
};

test('Tor is up only when this node\'s own Tor answers; another Tor, a program that is no Tor, or a Tor that stopped say so', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-torup-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeTorrc({ home, ports: { socks: 41050, control: 41051 } });
  assert.match(readFileSync(join(home, 'tor', 'torrc'), 'utf8'), new RegExp(`\\nLog notice file ${torLogOf(home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`), 'Tor writes its own log');
  const own = await fakeTorControl(torCookieOf(home));
  const other = await fakeTorControl('/home/someone/.tor/control_auth_cookie');
  const noTor = await fakeTorControl(null);
  t.after(() => { own.close(); other.close(); noTor.close(); });
  assert.deepEqual(await torControlInfo(own.address().port), { answers: true, cookieFile: torCookieOf(home) });
  assert.deepEqual(await torUp({ port: own.address().port, home, waitMs: 0 }), { ok: true });
  const theirs = await torUp({ port: other.address().port, home, waitMs: 1500, everyMs: 500 });
  assert.equal(theirs.ok, false, 'another Tor on the port is not this node\'s');
  assert.match(theirs.why, /another program answers on its control port \d+ \(a Tor with \/home\/someone\/\.tor\/control_auth_cookie\)/);
  assert.equal((await torControlInfo(noTor.address().port)).cookieFile, null);
  // the log the launcher and the torrc fill: the warning that says why, not the [err] after it
  writeFileSync(torLogOf(home), 'Oct 26 09:58:35.294 [notice] Tor 0.4.9.14 running on Linux\nOct 26 09:58:35.294 [warn] Could not bind to 127.0.0.1:19051: Address already in use. Is Tor already running?\n'
    + 'Oct 26 09:58:35.294 [warn] Failed to parse/validate config: Failed to bind one of the listener ports.\nOct 26 09:58:35.294 [err] Reading config failed--see warnings above.\n');
  const stopped = await torUp({ port: 1, home, waitMs: 20000 });
  assert.deepEqual(stopped, { ok: false, why: 'Tor stopped: Could not bind to 127.0.0.1:19051: Address already in use. Is Tor already running?' }, 'not waited for: it stopped');
  // the loader's line (2026-10-25, before the launcher): no Tor line at all, Tor never ran
  writeFileSync(torLogOf(home), '/r/runtime/tor/tor: error while loading shared libraries: libevent-2.1.so.7: cannot open shared object file: No such file or directory\n');
  assert.match((await torUp({ port: 1, home, waitMs: 20000 })).why, /^Tor stopped: \/r\/runtime\/tor\/tor: error while loading shared libraries: libevent-2\.1\.so\.7/);
  writeFileSync(torLogOf(home), 'Oct 26 10:00:00.000 [warn] Fixing permissions on directory /x/tor/data\n');
  assert.deepEqual(torComplaint(home), { line: 'Fixing permissions on directory /x/tor/data', stopped: false }, 'a warning alone: still waited for');
});

test('the Tor ports: the node\'s pair when free or held by its own Tor, else the next pair 10 up', async () => {
  const home = '/h';
  const taken = new Set([19050, 19051]);
  assert.deepEqual(await freeTorPorts({ home, base: { socks: 19050, control: 19051 }, free: async (p) => !taken.has(p), info: async () => ({ answers: true, cookieFile: '/other/control_auth_cookie' }) }),
    { socks: 19060, control: 19061 }, 'another program holds them');
  assert.deepEqual(await freeTorPorts({ home, base: { socks: 19050, control: 19051 }, free: async (p) => !taken.has(p), info: async () => ({ answers: true, cookieFile: torCookieOf(home) }) }),
    { socks: 19050, control: 19051 }, 'this node\'s own Tor: an install again restarts it in place');
});

test('a Tor that does not come up: LND runs without it on the ports chosen, and the Lightning step says Tor\'s own line', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-lndtor2-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = async (up) => {
    const state = nodeState(home);
    state.save({ chain: { kind: 'core', url: 'http://127.0.0.1:48332/', cookiePath: join(home, 'cookie') } });
    const configured = [], torrcs = [], asked = [];
    const r = await setUpOwnLnd({ state, release: '/r', fetcher: async () => ({}), reach: { checkDirect: async () => ({ ok: true, reached: false }) },
      lndKit: { installLnd: async () => ({ ok: true, lnd: '/fake/lnd' }), lndArgs: () => ['/fake/lnd'],
        configureLnd: (o) => { configured.push(o); return { lnddir: join(home, 'lnd'), restUrl: 'https://127.0.0.1:8080', tlsCert: 'c', macaroon: 'm', passwordFile: 'p' }; },
        installProgram: async () => ({ ok: true }) },
      tor: { torBin: async () => '/r/runtime/tor/tor', freeTorPorts: async () => ({ socks: 19060, control: 19061 }), writeTorrc: (o) => { torrcs.push(o.ports); return join(home, 'tor', 'torrc'); },
        torCommand: ({ tor }) => [tor], torUp: async (o) => { asked.push(o); return up; } } });
    return { r, configured, torrcs, asked, st: state.read() };
  };
  const down = await run({ ok: false, why: 'Tor stopped: Could not bind to 127.0.0.1:19061: Address already in use. Is Tor already running?' });
  assert.deepEqual(down.torrcs, [{ socks: 19060, control: 19061 }], 'the torrc names the free pair');
  assert.deepEqual(down.asked[0], { port: 19061, home }, 'asked on that pair, for this node\'s own Tor');
  assert.equal(down.configured[0].tor, null, 'LND without Tor: it starts');
  assert.equal(down.st.tor.why, 'Tor did not start (Tor stopped: Could not bind to 127.0.0.1:19061: Address already in use. Is Tor already running?): LND runs without it');
  assert.match(down.r.peers, /only nodes it dials reach it \(Tor did not start \(Tor stopped: Could not bind/, 'the Lightning step says why');
  const up = await run({ ok: true });
  assert.deepEqual(up.configured[0].tor, { socks: 19060, control: 19061 }, 'LND on the pair Tor runs on');
  assert.deepEqual(up.st.tor.ports, { socks: 19060, control: 19061 });
});

test('`arenanode logs tor` reads Tor\'s own log, which the journal no longer holds', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'arena-torlog-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'tor'), { recursive: true });
  writeFileSync(torLogOf(home), 'Oct 26 10:00:00.000 [notice] Bootstrapped 100% (done): Done\n');
  const l = await logsOf('tor', { home, platform: 'linux', sh: async () => ({ ok: true, out: 'journal' }) });
  assert.equal(l.file, torLogOf(home)); assert.match(l.text, /Bootstrapped 100%/);
});
