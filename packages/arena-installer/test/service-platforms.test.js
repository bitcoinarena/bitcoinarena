// THE NODE AS A SERVICE ON MACOS AND WINDOWS (kanban #471 slice 4): a launchd agent (and one for the tunnel) bootstrapped into the
// user's GUI domain; on Windows, launchers beside the node's home and scheduled tasks at logon - or, when the user does not want the
// node started after a reboot, started once and no task. The commands are recorded here (no launchctl or schtasks on this machine);
// the plist was read back by Python's plistlib on 2026-10-18 (Label, RunAtLoad, KeepAlive, ProgramArguments as written).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
    assert.match(plist, /exec '\/r\/runtime\/node' src\/main.js 8470/);
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
    assert.match(cmd, /for \/f "usebackq eol=# tokens=1,\* delims==" %%a in/);
    assert.match(cmd, /"C:\\r\\runtime\\node.exe" src\\main.js 8470/);
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
