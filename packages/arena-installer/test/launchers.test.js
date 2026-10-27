// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// STARTING THE NODE AFTER THE INSTALLER (2026-10-18: "manual scripts, on windows a start menu item, on mac a /Application link"):
// per system the scripts name exactly this node's services, the menu entry / app / Start menu shortcuts are written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
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
  const stop = readFileSync(join(home, 'bin', 'bitcoin-arena-stop'), 'utf8');
  assert.match(stop, /systemctl --user stop arena-updater\.service 2>\/dev\/null\nsystemctl --user stop arena-tunnel\.service 2>\/dev\/null\nsystemctl --user stop arena-node\.service/, 'the auto update first, then last first');
  assert.match(stop, /stop arena-liquidity\.service/, 'every service of the node, also one its state does not list (the 2026.1.9.11 install test)');
  assert.equal(statSync(l.start).mode & 0o111, 0o111, 'executable');
  assert.match(readFileSync(join(data, 'applications', 'bitcoin-arena.desktop'), 'utf8'), /Name=Bitcoin Arena[\s\S]*Exec=.*bitcoin-arena-start.*xdg-open https:\/\/x\.trycloudflare\.com\/Dashboard\/owner/);
  assert.equal(existsSync(join(home, 'bin', 'bitcoin-arena-add-custody')), false, 'no "add custody" unless asked for');
  writeLaunchers({ home, s, ownerUrl: owner, platform: 'linux', env: { XDG_DATA_HOME: data }, addCustody: ['/r/node', '/r/arena-install.mjs', '--add-custody', '--home', home] });
  assert.match(readFileSync(join(home, 'bin', 'bitcoin-arena-add-custody'), 'utf8'), /'\/r\/node' '\/r\/arena-install\.mjs' '--add-custody' '--home'/, 'a node without custody can add it: the installer\'s custody screens');
});

test('macOS: the .command scripts and Bitcoin Arena.app - it starts the node\'s launchd services and opens the owner page', () => {
  const home = mkdtempSync(join(tmpdir(), 'm-')), apps = mkdtempSync(join(tmpdir(), 'a-'));
  const l = writeLaunchers({ home, s, ownerUrl: owner, platform: 'darwin', env: { HOME: home }, applicationsDir: apps });
  assert.equal(l.app, join(apps, 'Bitcoin Arena.app'));
  assert.match(readFileSync(join(l.app, 'Contents', 'Info.plist'), 'utf8'), /<key>CFBundleExecutable<\/key><string>bitcoin-arena<\/string>/);
  const exe = readFileSync(join(l.app, 'Contents', 'MacOS', 'bitcoin-arena'), 'utf8');
  assert.match(exe, /launchctl kickstart gui\/\$uid\/io\.bitcoin-arena\.node\n/);
  assert.match(exe, /launchctl bootstrap gui\/\$uid '.*LaunchAgents\/io\.bitcoin-arena\.node\.tunnel\.plist'/);
  assert.match(exe, /open 'https:\/\/x\.trycloudflare\.com\/Dashboard\/owner'/);
  // EVERY AGENT OF THE NODE STOPPED (the 2026.1.9.11 install test, kanban #704: the .updater agent kept running)
  const stop = readFileSync(join(home, 'bin', 'Bitcoin Arena Stop.command'), 'utf8').split('\n').map((x) => /^launchctl bootout gui\/\$uid\/(\S+) 2>\/dev\/null$/.exec(x)).filter(Boolean).map((m) => m[1]);
  assert.deepEqual(stop.slice(0, 3), ['io.bitcoin-arena.node.updater', 'io.bitcoin-arena.node.tunnel', 'io.bitcoin-arena.node']);
  for (const id of ['custody', 'gateway', 'lnd', 'tor', 'liquidity', 'workers', 'chain-bridge', 'bitcoind-testnet4']) assert.ok(stop.includes(`io.bitcoin-arena.node.${id}`), id);
  assert.equal(new Set(stop).size, stop.length, 'each once');
});

test('Windows: start, stop and owner-page scripts, and three Start menu shortcuts made by PowerShell', () => {
  const home = mkdtempSync(join(tmpdir(), 'w-')), appdata = mkdtempSync(join(tmpdir(), 'r-'));
  const ran = [];
  const l = writeLaunchers({ home, s, ownerUrl: owner, platform: 'win32', env: { APPDATA: appdata }, run: (c, a) => ran.push([c, a]) });
  assert.match(readFileSync(l.start, 'utf8'), /schtasks \/run \/tn "Arena node"[\s\S]*start "" "https:\/\/x\.trycloudflare\.com\/Dashboard\/owner"/);
  assert.equal(l.menu, join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Bitcoin Arena'));
  assert.equal(ran[0][0], 'powershell');
  const ps = ran[0][1].at(-1);
  for (const n of ['Start Bitcoin Arena.lnk', 'Stop Bitcoin Arena.lnk', 'Bitcoin Arena owner page.lnk']) assert.ok(ps.includes(n), n);
});

// THE NAME PEOPLE SEE (kanban #635, 2026-10-25: "die Plattform sollte immer bitcoin-arena sein, nicht Arena-node"): an install of the
// old name gets the new launchers, and its old app and scripts are removed
test('the old "Arena Node" app and scripts give way to "Bitcoin Arena" (kanban #635)', () => {
  const home = mkdtempSync(join(tmpdir(), 'm-')), apps = mkdtempSync(join(tmpdir(), 'a-'));
  mkdirSync(join(apps, 'Arena Node.app', 'Contents'), { recursive: true }); mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'Arena Node Start.command'), 'old');
  writeLaunchers({ home, s, ownerUrl: owner, platform: 'darwin', env: { HOME: home }, applicationsDir: apps });
  assert.equal(existsSync(join(apps, 'Arena Node.app')), false); assert.equal(existsSync(join(home, 'bin', 'Arena Node Start.command')), false);
  assert.match(readFileSync(join(apps, 'Bitcoin Arena.app', 'Contents', 'Info.plist'), 'utf8'), /<key>CFBundleDisplayName<\/key><string>Bitcoin Arena<\/string>/);
});

// THE DMG'S OWN APP IS LEFT ALONE (kanban #669, 2026-10-26): the native app at the same path keeps its Info.plist and program
test('macOS: with the native Bitcoin Arena.app installed, the launcher does not write over it; the .command scripts still come', () => {
  const home = mkdtempSync(join(tmpdir(), 'm-')), apps = mkdtempSync(join(tmpdir(), 'a-'));
  const app = join(apps, 'Bitcoin Arena.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  const plist = '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Bitcoin Arena</string>\n  <key>CFBundleIdentifier</key><string>io.bitcoin-arena.node.setup</string></dict></plist>\n';
  writeFileSync(join(app, 'Contents', 'Info.plist'), plist);
  writeFileSync(join(app, 'Contents', 'MacOS', 'Bitcoin Arena'), 'native');
  const l = writeLaunchers({ home, s, ownerUrl: owner, platform: 'darwin', env: { HOME: home }, applicationsDir: apps });
  assert.equal(l.nativeApp, true);
  assert.equal(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8'), plist, 'its Info.plist untouched');
  assert.equal(existsSync(join(app, 'Contents', 'MacOS', 'bitcoin-arena')), false, 'no launcher program put beside it');
  assert.ok(existsSync(join(home, 'bin', 'Bitcoin Arena Open.command')));
});
