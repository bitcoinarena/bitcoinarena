// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A WINDOWS HOME WITH A SPACE (kanban #1441, audit 8 O8-2): a node under "C:\Users\John Doe\.bitcoinarena". The update's "stale home" rule
// (kanban #818) could not cross the space: it read "\.bitcoinarena" as an old home that is gone and rewrote the tunnel's and the chain
// bridge's launchers into paths that do not exist (the home three times over) - and the seat answered, so the update was kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateNode, staleHomesOf } from '../src/update.js';
import { windowsLauncher, withWindowsRestart } from '../src/service.js';

const program = (text) => /^"([^"]+)"/m.exec(text.split('\r\n').find((l) => l.startsWith('"')))[1];

test('a home with a space: the tunnel and chain bridge launchers move to the new release, and an old home with a space moves too', async () => {
  const root = mkdtempSync(join(tmpdir(), 'win-1441-'));
  try {
    const home = join(root, 'John Doe', '.bitcoinarena');
    const rel = (v) => join(home, 'releases', `bitcoin-arena-node-${v}-windows-x64`);
    const v1 = rel('2026.1.9.26'), v2 = rel('2026.1.9.27');
    for (const [v, d] of [['2026.1.9.26', v1], ['2026.1.9.27', v2]]) { mkdirSync(join(d, 'runtime'), { recursive: true }); writeFileSync(join(d, 'VERSION'), v); writeFileSync(join(d, 'COMMIT'), v === '2026.1.9.27' ? 'c2' : 'c1'); }
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 }, reach: { mode: 'permanent', port: 8470 } }));
    writeFileSync(join(home, 'arena.conf'), 'network=testnet4\r\nport=8470\r\nroles=verify\r\n');
    writeFileSync(join(home, 'arena-node.cmd'), windowsLauncher({ node: `${v1}\\runtime\\node.exe`, release: v1, home, port: 8470 }));
    const tunnel0 = ['@echo off', 'rem The Arena node tunnel, written by the installer.', `"${v1}\\runtime\\cloudflared.exe" "tunnel" "--no-autoupdate" "--config" "${home}\\cloudflared.yml" "run" >> "${home}\\tunnel.log" 2>&1`].join('\r\n') + '\r\n';
    writeFileSync(join(home, 'arena-tunnel.cmd'), tunnel0);
    writeFileSync(join(home, 'arena-chain-bridge.cmd'), ['@echo off', 'rem Bitcoin Arena: chain bridge, written by the installer.', `"${v1}\\runtime\\node.exe" "${v1}\\packages\\arena-installer\\bin\\chain-bridge.mjs" "8471" "${home}" >> "${home}\\chain-bridge.log" 2>&1`].join('\r\n') + '\r\n');
    // a launcher left on the home before this one (kanban #818), that home with a space as well - gone from the disk
    const oldHome = join(root, 'John Doe', '.arena-node');
    writeFileSync(join(home, 'arena-tor.cmd'), ['@echo off', 'rem Tor, written by the installer.', `"${oldHome}\\releases\\arena-node-2026.1.5-windows-x64\\runtime\\tor\\tor.exe" "-f" "${oldHome}\\tor\\torrc" >> "${oldHome}\\tor.log" 2>&1`].join('\r\n') + '\r\n');
    const sh = async () => ({ ok: true, out: '', err: '' });
    const fetcher = async (url) => (/owner\/version/.test(url) ? { status: 200, json: async () => ({ version: '2026.1.9.27', commit: 'c2' }) }
      : { status: 200, arrayBuffer: async () => new Uint8Array(33).fill(0xab).buffer });
    const r = await updateNode({ home, newRelease: v2, port: 8470, node: `${v2}\\runtime\\node.exe`, sh, fetcher, nowMs: () => 0, platform: 'win32', waitMs: 3000,
      fetchApps: async () => ({ ok: true }), refreshGames: null, restartService: async () => ({ ok: true }) });
    assert.equal(r.ok, true, r.why);
    const tunnel = readFileSync(join(home, 'arena-tunnel.cmd'), 'utf8'), bridge = readFileSync(join(home, 'arena-chain-bridge.cmd'), 'utf8');
    assert.equal(program(tunnel), `${v2}\\runtime\\cloudflared.exe`, 'the tunnel runs the new release\'s cloudflared');
    assert.equal(program(bridge), `${v2}\\runtime\\node.exe`, 'the chain bridge runs the new release\'s node.exe');
    assert.ok(tunnel.includes(`"${home}\\cloudflared.yml"`) && bridge.includes(`"${home}" >> "${home}\\chain-bridge.log"`), 'the home\'s own paths are left as they were');
    assert.equal(tunnel, withWindowsRestart(tunnel0.split(v1).join(v2), 10), 'only the release changed, and the restart loop went in (not the home three times over)');
    const tor = readFileSync(join(home, 'arena-tor.cmd'), 'utf8');
    assert.equal(program(tor), `${v2}\\runtime\\tor\\tor.exe`, 'the launcher on the old home (with a space) moves to the new release');
    assert.ok(tor.includes(`"${home}\\tor\\torrc"`) && !tor.includes(oldHome), 'and its data paths to the new home');
    // a second update finds nothing more to change in the tunnel's launcher
    const again = await updateNode({ home, newRelease: v2, port: 8470, node: `${v2}\\runtime\\node.exe`, sh, fetcher, nowMs: () => 0, platform: 'win32', waitMs: 3000,
      fetchApps: async () => ({ ok: true }), refreshGames: null, restartService: async () => ({ ok: true }) }).catch((e) => ({ ok: false, why: e.message }));
    assert.equal(readFileSync(join(home, 'arena-tunnel.cmd'), 'utf8'), tunnel, `an update over it changes nothing (${again.ok ? 'kept' : again.why})`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the rule on Windows paths: "C:\\Users\\John Doe\\.bitcoinarena" is this home, not an old one; a gone old home with a space is found whole', () => {
  const home = 'C:\\Users\\John Doe\\.bitcoinarena', releasesDir = `${home}\\releases`, exists = () => false;
  const v27 = `${releasesDir}\\bitcoin-arena-node-2026.1.9.27-windows-x64`;
  const tunnel = `@echo off\r\n"${v27}\\runtime\\cloudflared.exe" "tunnel" "--config" "${home}\\cloudflared.yml" "run" >> "${home}\\tunnel.log" 2>&1\r\n`;
  assert.deepEqual(staleHomesOf(tunnel, { home, releasesDir, exists }), [], 'a launcher already on this home names no old home');
  const old = 'C:\\Users\\John Doe\\.arena-node';
  const tor = `"${old}\\releases\\arena-node-2026.1.5-windows-x64\\runtime\\tor\\tor.exe" "-f" "${old}\\tor\\torrc"\r\n`;
  assert.deepEqual(staleHomesOf(tor, { home, releasesDir, exists }), [old]);
  assert.deepEqual(staleHomesOf('"C:\\Other Place\\releases\\arena-node-1-windows-x64\\x.exe"', { home, releasesDir, exists: () => true }), [], 'a path that still exists is left alone');
  assert.deepEqual(staleHomesOf('<string>/Users/John Doe/.arena-node/releases/arena-node-1-darwin-arm64/runtime/node</string>', { home: '/Users/John Doe/.bitcoinarena', releasesDir: '/Users/John Doe/.bitcoinarena/releases', exists }),
    ['/Users/John Doe/.arena-node'], 'a plist string is read whole too');
  assert.deepEqual(staleHomesOf('ExecStart=/home/u/.arena-node/releases/arena-node-1-linux-x64/runtime/node x.js', { home: '/home/u/.bitcoinarena', releasesDir: '/home/u/.bitcoinarena/releases', exists }),
    ['/home/u/.arena-node'], 'an unquoted path as before (kanban #818)');
});
