// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// SEVERAL NODES ON ONE MACHINE: ARENA_INSTANCE names a second node's services apart, ARENA_PORT_OFFSET moves its fixed
// ports; neither set, everything as before. The values are read when the installer starts, so each case runs in its own process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
  const [s, l, g, t, r, st] = await Promise.all(['service', 'lnd', 'gateway', 'tor', 'reach', 'state'].map((m) => import('./src/' + m + '.js')));
  console.log(JSON.stringify({ unit: s.UNIT, bridge: s.BRIDGE_UNIT, tunnel: s.TUNNEL_UNIT, lndUnit: s.unitName('lnd'), label: s.LAUNCHD_LABEL, task: s.WINDOWS_TASK,
    lnd: l.LND_PORTS, gateway: g.GATEWAY_PORT, tor: t.TOR_PORTS, seat: r.DEFAULT_NODE_PORT, liquidity: st.LIQUIDITY_PROVIDER_PORT }));`],
  { cwd: dir, env: { PATH: process.env.PATH, ARENA_HOME: '/nonexistent-arena-home', ...env }, encoding: 'utf8' }));

test('one node: the names and ports as always', () => {
  assert.deepEqual(read({}), { unit: 'arena-node.service', bridge: 'arena-chain-bridge.service', tunnel: 'arena-tunnel.service', lndUnit: 'arena-lnd.service',
    label: 'io.bitcoin-arena.node', task: 'Arena node', lnd: { rpc: 10009, rest: 10080, p2p: 9735 }, gateway: 8476, tor: { socks: 19050, control: 19051 }, seat: 8470, liquidity: 8477 });
});

test('a second node: every service named apart, every fixed port moved; a bad name or offset refused', () => {
  assert.deepEqual(read({ ARENA_INSTANCE: 'b', ARENA_PORT_OFFSET: '100' }), { unit: 'arena-node--b.service', bridge: 'arena-chain-bridge--b.service', tunnel: 'arena-tunnel--b.service',
    lndUnit: 'arena-lnd--b.service', label: 'io.bitcoin-arena.node--b', task: 'Arena node b', lnd: { rpc: 10109, rest: 10180, p2p: 9835 }, gateway: 8576,
    tor: { socks: 19150, control: 19151 }, seat: 8570, liquidity: 8577 });
  assert.throws(() => read({ ARENA_INSTANCE: 'B/x' }), /instance is a-z0-9/);
  assert.throws(() => read({ ARENA_PORT_OFFSET: '-5' }), /port_offset is a whole number/);
});

test('the CLI\'s own port defaults move with the offset too: wizard, seat, bridge (measured on the test host with rc.16: the second node\'s seat took 8470, the first\'s)', async () => {
  const { readFileSync } = await import('node:fs');
  const bin = readFileSync(join(dir, 'bin', 'arena-install.mjs'), 'utf8');
  for (const [flag, p] of [['--port', 7800], ['--seat-port', 8470], ['--bridge-port', 8471]]) assert.match(bin, new RegExp(`opt\\('${flag}', offsetPort\\(${p}\\)\\)`), flag);
});

test('a second node\'s wizard reads its own quick tunnel\'s name, not the first node\'s (2026.1.0 as instance t471 on the test host: "the quick tunnel gave no name")', () => {
  const asked = (env) => execFileSync(process.execPath, ['--input-type=module', '-e', `
    const r = await import('./src/reach.js'); let unit = null;
    const url = await r.quickTunnelUrl({ platform: 'linux', waitMs: 1000, sh: async (c, a) => { unit = a[a.indexOf('-u') + 1];
      return { ok: true, out: 'INF |  https://harris-preventing-experiences-turning.trycloudflare.com   |' }; } });
    console.log(JSON.stringify({ unit, url }));`], { cwd: dir, env: { PATH: process.env.PATH, ARENA_HOME: '/nonexistent-arena-home', ...env }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(asked({ ARENA_INSTANCE: 't471' })), { unit: 'arena-tunnel--t471.service', url: 'https://harris-preventing-experiences-turning.trycloudflare.com' });
  assert.equal(JSON.parse(asked({})).unit, 'arena-tunnel.service', 'one node: as always');
});

// THE DEFAULT SERVICE NAME TAKEN BY ANOTHER NODE (kanban #635, 2026-10-25: a new install in ~/.arena-node wrote io.bitcoin-arena.node over
// the agent of mactest12, another node on that test host): a new node takes the first free name, io.bitcoin-arena.node--2, and its own ports
test('a new node whose default service name belongs to another node folder takes --2 (and ports 100 up); its own name stays its own', async () => {
  const { freeInstance } = await import('../src/instance.js');
  const mine = '/Users/d/.arena-node', other = '<string>/Users/d/blwp-offload/mactest12/home/arena.conf</string>';
  const files = (m) => (f) => (f in m ? m[f] : null);
  const A = '/Users/d/Library/LaunchAgents/io.bitcoin-arena.node.plist', B = '/Users/d/Library/LaunchAgents/io.bitcoin-arena.node--2.plist';
  const opts = (m, inUse = []) => ({ platform: 'darwin', env: { HOME: '/Users/d' }, read: files(m), busy: (ports) => ports.filter((p) => inUse.includes(p)) });
  assert.deepEqual(freeInstance(mine, opts({})), { instance: '', offset: 0 }, 'nothing there: the default name');
  assert.deepEqual(freeInstance(mine, opts({ [A]: other })), { instance: '2', offset: 100 }, 'the default is another node\'s: --2');
  assert.deepEqual(freeInstance(mine, opts({ [A]: other, [B]: other })), { instance: '3', offset: 200 });
  assert.deepEqual(freeInstance(mine, opts({ [A]: `<string>${mine}/arena.conf</string>` })), { instance: '', offset: 0 }, 'its own service: kept');
  // the owner's playtest 2026-10-25: --2's seat port 8570 belonged to mactest16b (its own name): --3; a port of the default in use: --2
  assert.deepEqual(freeInstance(mine, opts({ [A]: other }, [8570])), { instance: '3', offset: 200 }, 'another node on --2\'s seat port: --3');
  assert.deepEqual(freeInstance(mine, opts({}, [10009])), { instance: '2', offset: 100 }, 'the default\'s LND port in use: --2');
  assert.deepEqual(freeInstance(mine, opts({ [A]: `<string>${mine}/arena.conf</string>` }, [8470])), { instance: '', offset: 0 }, 'its own ports are its own');
  assert.deepEqual(freeInstance('/home/d/.arena-node', { platform: 'linux', env: { HOME: '/home/d' }, busy: () => [], read: files({ '/home/d/.config/systemd/user/arena-node.service': 'WorkingDirectory=/opt/other' }) }),
    { instance: '2', offset: 100 }, 'the same on Linux');
  assert.deepEqual(freeInstance(mine, { platform: 'win32', read: () => 'x' }), { instance: '', offset: 0 }, 'Windows keeps the default');
});

test('portsInUse finds a listener on this machine, and only it', async () => {
  const { portsInUse } = await import('../src/instance.js');
  const { createServer } = await import('node:net');
  const s = createServer(); await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const taken = s.address().port, free = await new Promise((ok) => { const t = createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => ok(p)); }); });
  assert.deepEqual(portsInUse([taken, free]), [taken]);
  s.close();
});

test('the installer itself chooses: started as arena-install.mjs on a machine whose default unit is another node\'s, it is --2', { skip: process.platform !== 'linux' && process.platform !== 'darwin' }, async () => {
  const { mkdtempSync: mk, mkdirSync: md, writeFileSync: wf, rmSync: rm } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const home = mk(join(tmpdir(), 'inst-guard-'));
  try {
    const unit = process.platform === 'darwin' ? join(home, 'Library', 'LaunchAgents', 'io.bitcoin-arena.node.plist') : join(home, '.config', 'systemd', 'user', 'arena-node.service');
    md(join(unit, '..'), { recursive: true });
    const script = join(home, 'arena-install.mjs');
    wf(script, `const m = await import(${JSON.stringify(new URL('../src/instance.js', import.meta.url).href)}); console.log(JSON.stringify({ i: m.INSTANCE, o: m.PORT_OFFSET }));`);
    const run = () => JSON.parse(execFileSync(process.execPath, [script], { env: { PATH: process.env.PATH, HOME: home, ARENA_HOME: join(home, '.arena-node') }, encoding: 'utf8' }));
    // (this machine's own listeners count too: on the test host the live LND and Tor hold the default's 10009 and 19050, so expect what
    // freeInstance answers for the same files with this machine's ports)
    const { freeInstance } = await import('../src/instance.js');
    const expect = (f) => { const r = freeInstance(join(home, '.arena-node'), { env: { HOME: home }, read: (x) => (x === unit ? f : null) }); return { i: r.instance, o: r.offset }; };
    assert.deepEqual(run(), expect(null), 'no unit there: the default, or the first name with free ports');
    wf(unit, 'ExecStart=/opt/other/node src/main.js\nWorkingDirectory=/opt/other\n');
    const other = run();
    assert.deepEqual(other, expect('WorkingDirectory=/opt/other'), 'another node\'s unit: --2 or later, ports 100 up per number');
    assert.notEqual(other.i, '', 'never the other node\'s name');
  } finally { rm(home, { recursive: true, force: true }); }
});
