// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STARTING THE NODE AFTER THE INSTALLER (2026-10-18: "manual scripts, on windows a start menu item, on mac a /Application link"):
// per system the scripts name exactly this node's services, the menu entry / app / Start menu shortcuts are written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { servicesOf, writeLaunchers } from '../src/launchers.js';

const s = { reach: { mode: 'quick', url: 'https://x.trycloudflare.com' }, core: { networks: { testnet4: {} } }, lightning: { mode: 'own' }, gateway: {}, custodyAgent: { installedMs: 1 } };
const owner = 'https://x.trycloudflare.com/Dashboard/owner';

test('the services of a node: its chain first, the node, its tunnel - by each system\'s names', () => {
  const v = servicesOf(s);
  assert.deepEqual(v.linux, ['arena-bitcoind-testnet4.service', 'arena-lnd.service', 'arena-gateway.service', 'arena-custody.service', 'arena-node.service', 'arena-tunnel.service']);
  assert.deepEqual(v.darwin.slice(-2), ['io.bitcoin-arena.node', 'io.bitcoin-arena.node.tunnel']);
  assert.deepEqual(v.win32.slice(-2), ['Arena node', 'Arena node tunnel']);
  assert.deepEqual(servicesOf({ reach: { mode: 'direct' }, chain: { kind: 'electrum' } }).linux, ['arena-chain-bridge.service', 'arena-node.service']);
});

test('Linux: start, stop, status and open scripts, and the desktop menu entry', () => {
  const home = mkdtempSync(join(tmpdir(), 'l-')), data = mkdtempSync(join(tmpdir(), 'd-'));
  const l = writeLaunchers({ home, s, ownerUrl: owner, platform: 'linux', env: { XDG_DATA_HOME: data } });
  assert.match(readFileSync(l.start, 'utf8'), /systemctl --user start arena-bitcoind-testnet4.service .* arena-node.service arena-tunnel.service/);
  assert.match(readFileSync(join(home, 'bin', 'arena-node-stop'), 'utf8'), /systemctl --user stop arena-tunnel.service arena-node.service/);
  assert.equal(statSync(l.start).mode & 0o111, 0o111, 'executable');
  assert.match(readFileSync(join(data, 'applications', 'arena-node.desktop'), 'utf8'), /Name=Arena Node[\s\S]*Exec=.*arena-node-start.*xdg-open https:\/\/x\.trycloudflare\.com\/Dashboard\/owner/);
  assert.equal(existsSync(join(home, 'bin', 'arena-node-add-custody')), false, 'no "add custody" unless asked for');
  writeLaunchers({ home, s, ownerUrl: owner, platform: 'linux', env: { XDG_DATA_HOME: data }, addCustody: ['/r/node', '/r/arena-install.mjs', '--add-custody', '--home', home] });
  assert.match(readFileSync(join(home, 'bin', 'arena-node-add-custody'), 'utf8'), /'\/r\/node' '\/r\/arena-install\.mjs' '--add-custody' '--home'/, 'a node without custody can add it: the installer\'s custody screens');
});

test('macOS: the .command scripts and Arena Node.app - it starts the node\'s launchd services and opens the owner page', () => {
  const home = mkdtempSync(join(tmpdir(), 'm-')), apps = mkdtempSync(join(tmpdir(), 'a-'));
  const l = writeLaunchers({ home, s, ownerUrl: owner, platform: 'darwin', env: { HOME: home }, applicationsDir: apps });
  assert.equal(l.app, join(apps, 'Arena Node.app'));
  assert.match(readFileSync(join(l.app, 'Contents', 'Info.plist'), 'utf8'), /<key>CFBundleExecutable<\/key><string>arena-node<\/string>/);
  const exe = readFileSync(join(l.app, 'Contents', 'MacOS', 'arena-node'), 'utf8');
  assert.match(exe, /launchctl kickstart gui\/\$uid\/io\.bitcoin-arena\.node\n/);
  assert.match(exe, /launchctl bootstrap gui\/\$uid '.*LaunchAgents\/io\.bitcoin-arena\.node\.tunnel\.plist'/);
  assert.match(exe, /open 'https:\/\/x\.trycloudflare\.com\/Dashboard\/owner'/);
  assert.ok(existsSync(join(home, 'bin', 'Arena Node Stop.command')));
});

test('Windows: start, stop and owner-page scripts, and three Start menu shortcuts made by PowerShell', () => {
  const home = mkdtempSync(join(tmpdir(), 'w-')), appdata = mkdtempSync(join(tmpdir(), 'r-'));
  const ran = [];
  const l = writeLaunchers({ home, s, ownerUrl: owner, platform: 'win32', env: { APPDATA: appdata }, run: (c, a) => ran.push([c, a]) });
  assert.match(readFileSync(l.start, 'utf8'), /schtasks \/run \/tn "Arena node"[\s\S]*start "" "https:\/\/x\.trycloudflare\.com\/Dashboard\/owner"/);
  assert.equal(l.menu, join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Arena Node'));
  assert.equal(ran[0][0], 'powershell');
  const ps = ran[0][1].at(-1);
  for (const n of ['Start Arena node.lnk', 'Stop Arena node.lnk', 'Arena node owner page.lnk']) assert.ok(ps.includes(n), n);
});
