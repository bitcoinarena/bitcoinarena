// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NODE AS A SERVICE ON MACOS AND WINDOWS: a launchd agent (and one for the tunnel) bootstrapped into the
// user's GUI domain; on Windows, launchers beside the node's home and scheduled tasks at logon - or, when the user does not want the
// node started after a reboot, started once and no task. The commands are recorded here (no launchctl or schtasks on this machine);
// the plist was read back by Python's plistlib on 2026-10-18 (Label, RunAtLoad, KeepAlive, ProgramArguments as written).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installService, LAUNCHD_LABEL, WINDOWS_TASK } from '../src/service.js';
import { tunnelArgsOf } from '../src/reach.js';

const healthy = async () => new Response(Buffer.from('ab'.repeat(32), 'hex'), { status: 200 });

test('macOS: the node and its tunnel as launchd agents, replaced on a second run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-mac-'));
  try {
    const calls = [];
    const sh = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true, out: '', err: '' }; };
    const tunnelArgs = tunnelArgsOf({ bin: '/r/runtime/cloudflared', mode: 'quick', port: 8470 });
    const r = await installService({ platform: 'darwin', node: '/r/runtime/node', release: '/r', home: join(root, 'home'), port: 8470, tunnelArgs, boot: true,
      env: { HOME: root }, sh, fetcher: healthy, waitMs: 2000 });
    assert.equal(r.ok, true, r.why);
    const plist = readFileSync(join(root, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`), 'utf8');
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(plist, /<array><string>\/r\/runtime\/node<\/string><string>src\/run\.js<\/string><string>[^<]+\/arena\.conf<\/string><\/array>/);
    const t = readFileSync(join(root, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.tunnel.plist`), 'utf8');
    assert.match(t, /<string>io.bitcoin-arena.node.tunnel<\/string>/);
    assert.match(t, /<string>\/r\/runtime\/cloudflared<\/string><string>tunnel<\/string>/);
    assert.match(t, /tunnel\.log/);
    assert.equal(calls.filter((c) => c.startsWith('launchctl bootout')).length, 2, 'each agent unloaded first');
    assert.equal(calls.filter((c) => c.startsWith('launchctl bootstrap gui/')).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows: launchers and logon tasks; without "start after reboot" started once, no task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-win-'));
  try {
    const calls = [];
    const sh = async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, out: '', err: '' }; };
    const home = root;
    const r = await installService({ platform: 'win32', node: 'C:\\r\\runtime\\node.exe', release: 'C:\\r', home, port: 8470, boot: true, sh, fetcher: healthy, waitMs: 2000 });
    assert.equal(r.ok, true, r.why);
    const cmd = readFileSync(join(home, 'arena-node.cmd'), 'utf8');
    assert.match(cmd, /^@echo off\r\n/);
    assert.match(cmd, /"C:\\r\\runtime\\node.exe" src\\run\.js "[^"]+\\arena\.conf"/);
    assert.ok(!cmd.includes('node.env'), 'no environment file: the settings are arena.conf');
    const create = calls.find((c) => c[0] === 'schtasks' && c[1] === '/create');
    assert.deepEqual(create.slice(1, 9), ['/create', '/f', '/tn', WINDOWS_TASK, '/sc', 'onlogon', '/rl', 'limited']);
    assert.ok(calls.some((c) => c[0] === 'schtasks' && c[1] === '/run'));
    calls.length = 0;
    await installService({ platform: 'win32', node: 'n', release: 'r', home, port: 8470, boot: false, sh, fetcher: healthy, waitMs: 2000 });
    assert.equal(calls.some((c) => c[0] === 'schtasks'), false, 'no task when the node is not to start after a reboot');
    assert.ok(calls.some((c) => c[0] === 'cmd'), 'started once');
    assert.equal(existsSync(join(home, 'arena-tunnel.cmd')), false, 'a direct node has no tunnel');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows without administrator rights: the logon task is refused, the Startup folder starts it (measured in the VM: "Access is denied")', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arena-win-'));
  try {
    const calls = [];
    const sh = async (cmd, args) => { calls.push([cmd, ...args]);
      return cmd === 'schtasks' && args[0] === '/create' ? { ok: false, out: '', err: 'ERROR: Access is denied.' } : { ok: true, out: '', err: '' }; };
    const env = { APPDATA: join(root, 'AppData') };
    const r = await installService({ platform: 'win32', node: 'C:\\r\\node.exe', release: 'C:\\r', home: root, port: 8470, boot: true, sh, env, fetcher: healthy, waitMs: 2000 });
    assert.equal(r.ok, true, r.why);
    const startup = join(root, 'AppData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const vbs = join(startup, `${WINDOWS_TASK}.vbs`);
    assert.match(readFileSync(vbs, 'utf8'), /CreateObject\("WScript\.Shell"\)\.Run """.*arena-node\.cmd""", 0, False/, 'a hidden window, at every logon');
    assert.ok(calls.some((c) => c[0] === 'wscript' && c[1] === vbs), 'and started now');
    assert.equal(calls.some((c) => c[0] === 'schtasks' && c[1] === '/run'), false, 'no task to run');
    const { installProgram } = await import('../src/service.js');
    const p = await installProgram({ id: 'bitcoind-testnet4', description: 'Core', args: ['C:\\b\\bitcoind.exe'], home: root, platform: 'win32', env, sh });
    assert.equal(p.ok, true, p.why);
    assert.ok(existsSync(join(startup, 'Arena bitcoind-testnet4.vbs')), 'the same for a program (Bitcoin Core, LND, Tor...)');
    // A BATCH FILE IS CALLED (2026-10-19 22:43Z in the VM: the updater's exit 75 never looped - a .cmd run from a .cmd without `call` never returns)
    const u = await installProgram({ id: 'updater', description: 'update', args: ['C:\\h\\bin\\arenanode.cmd', 'auto-update'], home: root, platform: 'win32', env, sh, againOn: 75 });
    assert.equal(u.ok, true, u.why);
    const text = readFileSync(join(root, 'arena-updater.cmd'), 'utf8');
    assert.match(text, /:again\r\ncall "C:\\h\\bin\\arenanode\.cmd" "auto-update" >> /);
    assert.match(text, /if %errorlevel%==75 goto again/);
    assert.match(readFileSync(join(root, 'arena-bitcoind-testnet4.cmd'), 'utf8'), /^"C:\\b\\bitcoind\.exe" >> /m, 'a program (.exe) is not called');
    const { updaterLauncherStale } = await import('../src/launchers.js');
    assert.equal(updaterLauncherStale(join(root, 'arena-updater.cmd'), 'win32'), false);
    writeFileSync(join(root, 'old-updater.cmd'), text.replace('call "', '"'));
    assert.equal(updaterLauncherStale(join(root, 'old-updater.cmd'), 'win32'), true, 'a launcher written before is written again by the next update');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Electrum mode on macOS and Windows: the chain bridge is its own service, set up before the node', async () => {
  for (const platform of ['darwin', 'win32']) {
    const root = mkdtempSync(join(tmpdir(), 'arena-bridge-svc-'));
    try {
      const calls = [];
      const sh = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true, out: '', err: '' }; };
      const r = await installService({ platform, node: '/r/runtime/node', release: '/r', home: root, port: 8470, bridgePort: 8471, boot: true,
        env: { HOME: root }, sh, fetcher: healthy, waitMs: 2000 });
      assert.equal(r.ok, true, r.why);
      const bridgeAt = calls.findIndex((c) => /chain-bridge/.test(c));
      const nodeAt = calls.findIndex((c) => (platform === 'darwin' ? /bootstrap .*io\.bitcoin-arena\.node\.plist/ : /\/tn Arena node \/sc/).test(c));
      assert.ok(bridgeAt >= 0 && nodeAt > bridgeAt, `${platform}: the bridge before the node (${bridgeAt}, ${nodeAt})`);
      if (platform === 'darwin') assert.match(readFileSync(join(root, 'Library/LaunchAgents/io.bitcoin-arena.node.chain-bridge.plist'), 'utf8'), /chain-bridge\.mjs<\/string><string>8471<\/string>/);
      else assert.match(readFileSync(join(root, 'arena-chain-bridge.cmd'), 'utf8'), /chain-bridge\.mjs" "8471"/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('the quick tunnel\'s name on macOS and Windows: the newest in <home>/tunnel.log (measured on the test host: the journal does not exist there)', async () => {
  const { quickTunnelUrl } = await import('../src/reach.js');
  const log = 'INF Requesting new quick Tunnel\n|  https://old-name-one.trycloudflare.com  |\nINF restarted\n|  https://new-name-two.trycloudflare.com  |\n';
  assert.equal(await quickTunnelUrl({ home: '/h', platform: 'darwin', readLog: (f) => { assert.equal(f, '/h/tunnel.log'); return log; }, waitMs: 1 }), 'https://new-name-two.trycloudflare.com');
  assert.equal(await quickTunnelUrl({ home: '/h', platform: 'win32', readLog: () => log, waitMs: 1 }), 'https://new-name-two.trycloudflare.com');
  assert.equal(await quickTunnelUrl({ home: '/h', platform: 'darwin', readLog: () => 'nothing yet', waitMs: 1 }), null);
});

test('after a restart only a name logged since the install counts (measured in the Linux VM: the reinstall tested the old name, HTTP 530)', async () => {
  const { quickTunnelUrl } = await import('../src/reach.js');
  // the VM's journal (journalctl -o cat), 2026-10-18: the first run's name, then the restart at 14:10:58
  const journal = '2026-10-18T14:08:11Z INF Requesting new quick Tunnel on trycloudflare.com...\n2026-10-18T14:08:18Z INF |  https://sends-editing-calculated-workshop.trycloudflare.com    |\n2026-10-18T14:10:58Z INF Requesting new quick Tunnel on trycloudflare.com...\n';
  const later = journal + '2026-10-18T14:11:03Z INF |  https://size-erp-modular-durham.trycloudflare.com    |\n';
  const since = Date.parse('2026-10-18T14:10:57.500Z');
  let reads = 0;
  const sh = async () => ({ ok: true, out: ++reads < 3 ? journal : later });
  assert.equal(await quickTunnelUrl({ platform: 'linux', sh, sinceMs: since, waitMs: 10000 }), 'https://size-erp-modular-durham.trycloudflare.com', 'it waits for the new name');
  assert.ok(reads >= 3);
  assert.equal(await quickTunnelUrl({ platform: 'linux', sh: async () => ({ ok: true, out: journal }), sinceMs: since, waitMs: 1 }), null, 'the old name alone is no answer');
  assert.equal(await quickTunnelUrl({ platform: 'darwin', home: '/h', readLog: () => later, sinceMs: since, waitMs: 1 }), 'https://size-erp-modular-durham.trycloudflare.com');
});
