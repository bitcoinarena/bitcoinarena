// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A WINDOWS PROGRAM THAT ENDS IS STARTED AGAIN (kanban #1443, audit 8 O8-4): on Windows nothing restarted the seat, the tunnel or the
// chain bridge when it ended (systemd Restart=on-failure, launchd KeepAlive elsewhere) - the node was down until the next logon. Every
// launcher now loops on an error exit; the update's stop ends the launchers' own cmd.exe first, so the loop cannot start the old
// release again mid-update. Checked on the written text and on the commands the update gives (no Windows here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { windowsLauncher, installService, installProgram } from '../src/service.js';
import { updateNode, releaseOfLauncher } from '../src/update.js';

const LOOP = /\r\n:again\r\n(?:call )?"[^\r\n]+\r\nif %errorlevel% neq 0 \(ping -n (\d+) 127\.0\.0\.1 >nul & goto again\)\r\n$/;
const healthy = async () => ({ status: 200, arrayBuffer: async () => new Uint8Array(33).fill(0xab).buffer });

test('the seat\'s launcher starts the seat again 10 s after an error exit, and is still read as its release', () => {
  const t = windowsLauncher({ node: 'C:\\r\\runtime\\node.exe', release: 'C:\\r', home: 'C:\\Users\\John Doe\\.bitcoinarena', port: 8470 });
  assert.match(t, LOOP);
  assert.equal(LOOP.exec(t)[1], '11', 'ping -n 11: ten seconds, as RestartSec=10');
  assert.equal(releaseOfLauncher(t), 'C:\\r');
});

test('installService and installProgram on Windows: the seat, the tunnel, the chain bridge and every program loop; the updater keeps its 75', async () => {
  const root = mkdtempSync(join(tmpdir(), 'win-1443-'));
  try {
    const sh = async () => ({ ok: true, out: '', err: '' });
    const env = { APPDATA: join(root, 'AppData') };
    const r = await installService({ platform: 'win32', node: 'C:\\r\\runtime\\node.exe', release: 'C:\\r', home: root, port: 8470, bridgePort: 8471,
      tunnelArgs: ['C:\\r\\runtime\\cloudflared.exe', 'tunnel', 'run'], boot: true, sh, env, fetcher: healthy, waitMs: 2000 });
    assert.equal(r.ok, true, r.why);
    for (const f of ['arena-node.cmd', 'arena-tunnel.cmd', 'arena-chain-bridge.cmd']) assert.match(readFileSync(join(root, f), 'utf8'), LOOP, f);
    assert.equal(LOOP.exec(readFileSync(join(root, 'arena-tunnel.cmd'), 'utf8'))[1], '11');
    assert.equal(LOOP.exec(readFileSync(join(root, 'arena-chain-bridge.cmd'), 'utf8'))[1], '31', 'a program as its unit: RestartSec=30');
    await installProgram({ id: 'tor', description: 'Tor', args: ['C:\\r\\tor.exe'], home: root, platform: 'win32', env, sh, restart: 'always' });
    assert.match(readFileSync(join(root, 'arena-tor.cmd'), 'utf8'), /\r\n:again\r\n"C:\\r\\tor\.exe" >> [^\r\n]+\r\nping -n 31 127\.0\.0\.1 >nul & goto again\r\n$/, 'always: after a clean exit too');
    await installProgram({ id: 'updater', description: 'update', args: ['C:\\h\\bin\\bitcoinarena.cmd', 'auto-update'], home: root, platform: 'win32', env, sh, againOn: 75 });
    assert.match(readFileSync(join(root, 'arena-updater.cmd'), 'utf8'), /\r\n:again\r\ncall "C:\\h\\bin\\bitcoinarena\.cmd" "auto-update" >> [^\r\n]+\r\nif %errorlevel%==75 goto again\r\nif %errorlevel% neq 0 \(ping -n 31 127\.0\.0\.1 >nul & goto again\)\r\n$/,
      '75 at once (the new release), any other error after 30 s');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the update: the launchers\' cmd.exe are ended before the old release\'s processes, and a launcher written before the loop gets it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'win-1443-'));
  try {
    const home = join(root, 'home'); mkdirSync(home, { recursive: true });
    const v1 = 'C:\\Users\\arena\\home\\releases\\bitcoin-arena-node-2026.1.9.26-windows-x64', v2 = 'C:\\Users\\arena\\home\\releases\\bitcoin-arena-node-2026.1.9.27-windows-x64';
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 } }));
    writeFileSync(join(home, 'arena.conf'), 'network=testnet4\r\nport=8470\r\nroles=verify\r\n');
    // as 2026.1.9.27 wrote them: no loop
    writeFileSync(join(home, 'arena-node.cmd'), ['@echo off', 'rem seat', `cd /d "${v1}\\packages\\arena-node"`, `"${v1}\\runtime\\node.exe" src\\run.js "${home}\\arena.conf" >> "${home}\\node.log" 2>&1`].join('\r\n') + '\r\n');
    writeFileSync(join(home, 'arena-tunnel.cmd'), ['@echo off', 'rem The Arena node tunnel, written by the installer.', `"${v1}\\runtime\\cloudflared.exe" "tunnel" "run" >> "${home}\\tunnel.log" 2>&1`].join('\r\n') + '\r\n');
    writeFileSync(join(home, 'arena-chain-bridge.cmd'), ['@echo off', 'rem bridge', `"${v1}\\runtime\\node.exe" "${v1}\\packages\\arena-installer\\bin\\chain-bridge.mjs" "8471" "${home}" >> "${home}\\chain-bridge.log" 2>&1`].join('\r\n') + '\r\n');
    writeFileSync(join(home, 'arena-updater.cmd'), ['@echo off', 'rem update', ':again', `call "${home}\\bin\\bitcoinarena.cmd" "auto-update" >> "${home}\\updater.log" 2>&1`, 'if %errorlevel%==75 goto again'].join('\r\n') + '\r\n');
    const calls = [];
    const sh = async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, out: '', err: '' }; };
    const r = await updateNode({ home, newRelease: v2, port: 8470, node: `${v2}\\runtime\\node.exe`, sh, fetcher: healthy, nowMs: () => 0, platform: 'win32', waitMs: 2000,
      fetchApps: async () => ({ ok: true }), refreshGames: null });
    assert.equal(r.ok, true, r.why);
    const kill = calls.find((c) => c[0] === 'powershell' && /Stop-Process/.test(c.at(-1))).at(-1);
    const launchers = kill.indexOf("$_.Name -eq 'cmd.exe'"), release = kill.indexOf("-like '*\\bitcoin-arena-node-2026.1.9.26-windows-x64\\*'");
    assert.ok(launchers >= 0, 'the launchers\' cmd.exe are ended');
    assert.ok(release > launchers, 'before the release\'s own processes');
    for (const f of ['arena-node.cmd', 'arena-tunnel.cmd', 'arena-chain-bridge.cmd']) assert.ok(kill.includes(`'${join(home, f).replace(/\//g, '\\').toLowerCase()}'`), `${f}'s cmd.exe by its full path`);
    assert.ok(!kill.includes('arena-updater.cmd'), 'never the updater\'s: the auto update runs in it');
    assert.match(readFileSync(join(home, 'arena-node.cmd'), 'utf8'), LOOP, 'the seat\'s launcher is written whole, with the loop');
    for (const f of ['arena-tunnel.cmd', 'arena-chain-bridge.cmd']) {
      const t = readFileSync(join(home, f), 'utf8');
      assert.match(t, LOOP, `${f}: the loop put around its program`);
      assert.ok(t.includes(v2) && !t.includes(v1), `${f}: on the new release`);
    }
    assert.equal(LOOP.exec(readFileSync(join(home, 'arena-tunnel.cmd'), 'utf8'))[1], '11');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
