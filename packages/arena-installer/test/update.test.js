// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// AN EXISTING NODE UPDATED IN PLACE (F.1): a node installed from one release is updated to another - settings,
// database, key and owner kept, the same node answering after - and to a broken one, which is rolled back by itself to the old
// release and its backup. systemd is played by a fake `systemctl` that starts the seat from the unit file's own command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateNode, releaseOfUnit, inSeatingWindow, backupNode, envForRelease, restoreNode } from '../src/update.js';
import { unitDir, UNIT, waitHealthy } from '../src/service.js';

const REPO = resolve(fileURLToPath(import.meta.url), '../../../..');
// THE SERVICES AN INSTALLER BEFORE KANBAN WROTE: the settings in node.env, the seat started as main.js <port> <database> - what an
// update finds on every node installed before arena.conf, and moves to it
const legacySeatUnit = ({ node, release, home, port }) => `[Unit]\nDescription=Arena node (testnet4) on port ${port}\n\n[Service]\nWorkingDirectory=${join(release, 'packages/arena-node')}\n`
  + `EnvironmentFile=${join(home, 'node.env')}\nExecStart=${node} src/main.js ${port} ${join(home, 'node.db')}\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
const legacyPlist = ({ node, release, home, port }) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>io.bitcoin-arena.node</string>\n`
  + `  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>set -a; . &apos;${home}/node.env&apos;; set +a; exec &apos;${node}&apos; src/main.js ${port} &apos;${home}/node.db&apos;</string></array>\n`
  + `  <key>WorkingDirectory</key><string>${release}/packages/arena-node</string>\n  <key>RunAtLoad</key><true/>\n</dict>\n</plist>\n`;
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

/** A release tree from the repo at HEAD (what build-linux.sh archives), its npm dependencies linked. With arena-sdk and its link (kanban
 *  #569): the apps' registrations import arena-sdk/<name> - without it the seat did not start ("Cannot find package 'arena-sdk'"). */
function releaseFrom(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', `git -C "${REPO}" archive HEAD packages/arena-node/src packages/arena-node/pages packages/arena-node/package.json packages/arena-protocol packages/arena-client/src packages/arena-sdk packages/node_modules/arena-sdk | tar -x -C "${dir}"`]);
  // and Next Block as a node has it once fetched (kanban #575: no app is tracked here; tools/fetch-apps.mjs placed it at its pin)
  cpSync(join(REPO, 'packages/nextblock'), join(dir, 'packages/nextblock'), { recursive: true });
  symlinkSync(join(REPO, 'packages/arena-node/node_modules'), join(dir, 'packages/arena-node/node_modules'));
  return dir;
}

/** systemctl --user, played: start runs the unit's ExecStart in its WorkingDirectory (with its EnvironmentFile, an older unit's); stop kills it. */
function fakeSystemd(env) {
  const running = new Map();
  const unitFile = (u) => readFileSync(join(unitDir(env), u), 'utf8');
  const sh = async (cmd, args) => {
    if (cmd !== 'systemctl') return { ok: true, out: '', err: '' };
    const [, verb, ...units] = args;
    for (const u of units) {
      if (verb === 'stop' && running.has(u)) {
        const c = running.get(u); running.delete(u);
        if (c.exitCode === null && c.signalCode === null) { const gone = new Promise((ok) => c.once('exit', ok)); c.kill('SIGTERM'); await gone; }
      }
      if (verb === 'start') {
        const text = unitFile(u);
        const exec = /ExecStart=(.*)/.exec(text)[1].split(' ');
        const cwd = /WorkingDirectory=(.*)/.exec(text)[1];
        const envFile = (/EnvironmentFile=(.*)/.exec(text) || [])[1];
        const e = { PATH: process.env.PATH };
        if (envFile) for (const l of readFileSync(envFile, 'utf8').split('\n')) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l); if (m) e[m[1]] = m[2]; }
        const c = spawn(exec[0], exec.slice(1), { cwd, env: e, stdio: 'ignore' });
        running.set(u, c);
      }
    }
    return { ok: true, out: '', err: '' };
  };
  return { sh, stopAll: () => { for (const c of running.values()) c.kill('SIGKILL'); } };
}

test('an update keeps the node, its settings and data; a broken release is rolled back by itself', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arena-update-'));
  const env = { XDG_CONFIG_HOME: join(root, 'config'), USER: 'test' };
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const port = await freePort();
  const sys = fakeSystemd(env);
  t.after(() => { sys.stopAll(); rmSync(root, { recursive: true, force: true }); });
  const v1 = releaseFrom(join(root, 'releases/0.1.0'));
  const v2 = releaseFrom(join(root, 'releases/0.1.1'));
  const broken = releaseFrom(join(root, 'releases/0.1.2-broken'));
  writeFileSync(join(broken, 'packages/arena-node/src/main.js'), "throw new Error('this release does not start');\n");

  // the node as an installer before arena.conf left it: node.env, state, an owner, its unit on release 0.1.0, running
  const settings = `ARENA_BIND=127.0.0.1\nARENA_DONATION_NETWORK=testnet4\nARENA_APPS=${join(v1, 'packages/nextblock/plugin/nextblock.js')}\nARENA_ROLES=verify\n`;
  writeFileSync(join(home, 'node.env'), settings);
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 } }));
  writeFileSync(join(home, 'node.db.owner.json'), JSON.stringify({ pubkey: 'ab'.repeat(32), claimedAtMs: 1 }) + '\n');
  mkdirSync(unitDir(env), { recursive: true });
  writeFileSync(join(unitDir(env), UNIT), legacySeatUnit({ node: process.execPath, release: v1, home, port }));
  await sys.sh('systemctl', ['--user', 'start', UNIT]);
  const first = await waitHealthy({ port, waitMs: 60000, everyMs: 300 });
  assert.equal(first.ok, true, first.why);
  assert.equal(releaseOfUnit(readFileSync(join(unitDir(env), UNIT), 'utf8')), v1);

  // to 0.1.1: the same node, the same settings - moved into arena.conf - its database and owner kept, a backup taken
  const up = await updateNode({ home, newRelease: v2, port, env, sh: sys.sh, nowMs: () => 0 });
  assert.equal(up.ok, true, up.why);
  assert.deepEqual([up.from, up.to, up.identity], [v1, v2, first.identity], 'the same node answers from the new release');
  assert.equal(up.migrated, true);
  const { parseConf } = await import('../../arena-node/src/arena-conf.js');
  assert.deepEqual(parseConf(readFileSync(join(home, 'arena.conf'), 'utf8')).values, { network: 'testnet4', port: String(port), database: join(home, 'node.db'), bind: '127.0.0.1',
    donation_network: 'testnet4', apps: join(v1, 'packages/nextblock/plugin/nextblock.js'), roles: 'verify' }, 'the same settings (a release folder not named arena-node-<version> is not moved: envForRelease)');
  assert.equal(readFileSync(join(home, 'node.env.migrated'), 'utf8'), settings, 'node.env kept aside as it was');
  assert.ok(!existsSync(join(home, 'node.env')), 'and nothing reads it any more');
  assert.match(readFileSync(join(unitDir(env), UNIT), 'utf8'), /^ExecStart=\S+ src\/run\.js \S+\/arena\.conf$/m, 'the unit starts from arena.conf');
  assert.ok(!/EnvironmentFile/.test(readFileSync(join(unitDir(env), UNIT), 'utf8')));
  assert.equal(JSON.parse(readFileSync(join(home, 'node.db.owner.json'), 'utf8')).pubkey, 'ab'.repeat(32), 'the owner kept');
  assert.ok(existsSync(join(up.backup, 'node.db')) && existsSync(join(up.backup, 'node.env')), 'the backup holds the database and settings');
  assert.equal(releaseOfUnit(readFileSync(join(unitDir(env), UNIT), 'utf8')), v2);
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).release.path, v2);

  // to a release that does not start: rolled back to 0.1.1 by itself, and said why
  const bad = await updateNode({ home, newRelease: broken, port, env, sh: sys.sh, nowMs: () => 0, waitMs: 8000 });
  assert.deepEqual([bad.ok, bad.rolledBack, bad.restored], [false, true, true]);
  assert.match(bad.why, /did not come up/);
  assert.equal(releaseOfUnit(readFileSync(join(unitDir(env), UNIT), 'utf8')), v2, 'the unit names the old release again');
  const after = await waitHealthy({ port, waitMs: 30000, everyMs: 300 });
  assert.deepEqual([after.ok, after.identity], [true, first.identity], 'and the same node answers from it');

  assert.equal((await updateNode({ home, newRelease: v2, port, env, sh: sys.sh })).why, 'that release is the one running');
  assert.match((await updateNode({ home: join(root, 'nothing'), newRelease: v1, port, env, sh: sys.sh })).why, /no node is installed/);
});

test('updates wait out a market seating window; a backup copies only the node\'s files', () => {
  assert.equal(inSeatingWindow(Date.parse('2026-10-18T07:11:30Z')), true, 'minute 11 of the quarter');
  assert.equal(inSeatingWindow(Date.parse('2026-10-18T07:14:00Z')), false, 'minute 14 (840 s) is out');
  assert.equal(inSeatingWindow(Date.parse('2026-10-18T07:05:00Z')), false);
  const home = mkdtempSync(join(tmpdir(), 'arena-backup-'));
  try {
    writeFileSync(join(home, 'node.env'), 'A=1\n'); writeFileSync(join(home, 'other.txt'), 'x');
    const b = backupNode(home, 'stamp');
    assert.deepEqual(b.files, ['node.env']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/** launchctl, played: bootstrap runs a plist's ProgramArguments in its WorkingDirectory; bootout kills it. codesign answers "not signed". */
function fakeLaunchd() {
  const running = new Map(); const calls = []; let torRefused = 0;
  const sh = async (cmd, args) => {
    calls.push([cmd, ...args]);
    // launchd refuses the first bootstrap of tor, as it did on the test host right after the bootout
    if (cmd === 'launchctl' && args[0] === 'bootstrap' && /\.tor\.plist$/.test(args[2]) && torRefused++ === 0) return { ok: false, out: '', err: 'Bootstrap failed: 5: Input/output error' };
    if (cmd === '/usr/bin/codesign') return { ok: args[0] !== '-v', out: '', err: '' };
    if (cmd !== 'launchctl') return { ok: true, out: '', err: '' };
    if (args[0] === 'bootout') {
      const label = args[1].split('/').pop(); const c = running.get(label); running.delete(label);
      if (c && c.exitCode === null && c.signalCode === null) { const gone = new Promise((ok) => c.once('exit', ok)); c.kill('SIGTERM'); await gone; }
    }
    if (args[0] === 'bootstrap') {
      const text = readFileSync(args[2], 'utf8');
      const label = /<key>Label<\/key><string>(.+?)<\/string>/.exec(text)[1];
      const argv = [...(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/s.exec(text)[1].matchAll(/<string>(.*?)<\/string>/g))].map((m) => m[1].replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
      const cwd = (/<key>WorkingDirectory<\/key><string>(.+?)<\/string>/.exec(text) || [])[1];
      if (argv[0] === '/bin/sh' || argv[0] === process.execPath) running.set(label, spawn(argv[0], argv.slice(1), { cwd, env: { PATH: process.env.PATH }, stdio: 'ignore' }));
    }
    return { ok: true, out: '', err: '' };
  };
  return { sh, calls, stopAll: () => { for (const c of running.values()) c.kill('SIGKILL'); } };
}

test('macOS: the launchd agents that run the old release move to the new one, its tor is signed, a broken one is rolled back (rc.12 -> rc.13 on the test host said "no arena-node unit")', async (t) => {
  const { launchdPlist, LAUNCHD_LABEL } = await import('../src/service.js');
  const { releaseOfPlist } = await import('../src/update.js');
  const root = mkdtempSync(join(tmpdir(), 'arena-update-mac-'));
  const env = { HOME: join(root, 'user') };
  const agents = join(env.HOME, 'Library', 'LaunchAgents'); mkdirSync(agents, { recursive: true });
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const port = await freePort();
  const sys = fakeLaunchd();
  t.after(() => { sys.stopAll(); rmSync(root, { recursive: true, force: true }); });
  const v1 = releaseFrom(join(root, 'releases/0.1.0-rc.12')), v2 = releaseFrom(join(root, 'releases/0.1.0-rc.13'));
  const broken = releaseFrom(join(root, 'releases/broken'));
  writeFileSync(join(broken, 'packages/arena-node/src/main.js'), "throw new Error('this release does not start');\n");
  for (const r of [v1, v2, broken]) { mkdirSync(join(r, 'runtime/tor'), { recursive: true }); writeFileSync(join(r, 'runtime/tor/tor'), ''); writeFileSync(join(r, 'runtime/tor/libevent-2.1.7.dylib'), ''); }
  writeFileSync(join(home, 'node.env'), 'ARENA_BIND=127.0.0.1\nARENA_DONATION_NETWORK=testnet4\nARENA_ROLES=verify\n');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 } }));
  const seat = join(agents, `${LAUNCHD_LABEL}.plist`), tor = join(agents, `${LAUNCHD_LABEL}.tor.plist`), lnd = join(agents, `${LAUNCHD_LABEL}.lnd.plist`);
  writeFileSync(seat, legacyPlist({ node: process.execPath, release: v1, home, port }));
  const agent = (label, prog) => `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${prog}</string></array></dict></plist>\n`;
  writeFileSync(tor, agent(`${LAUNCHD_LABEL}.tor`, join(v1, 'runtime/tor/tor')));
  writeFileSync(lnd, agent(`${LAUNCHD_LABEL}.lnd`, join(home, 'lnd-bin/lnd')));
  await sys.sh('launchctl', ['bootstrap', 'gui/501', seat]);
  const first = await waitHealthy({ port, waitMs: 60000, everyMs: 300 });
  assert.equal(first.ok, true, first.why);

  const up = await updateNode({ home, newRelease: v2, port, env, sh: sys.sh, nowMs: () => 0, platform: 'darwin' });
  assert.equal(up.ok, true, up.why);
  assert.deepEqual([up.from, up.to, up.identity], [v1, v2, first.identity], 'the same node answers from rc.13');
  assert.match(readFileSync(seat, 'utf8'), /<string>src\/run\.js<\/string><string>[^<]+\/arena\.conf<\/string>/, 'the agent starts from arena.conf');
  assert.match(readFileSync(join(home, 'arena.conf'), 'utf8'), /^roles=verify$/m);
  assert.equal(releaseOfPlist(readFileSync(seat, 'utf8')), v2);
  assert.match(readFileSync(tor, 'utf8'), new RegExp(`${v2}/runtime/tor/tor`), 'tor moved to the new release');
  assert.match(readFileSync(lnd, 'utf8'), /lnd-bin\/lnd/, 'LND, which names no release, untouched');
  assert.deepEqual(up.moved.sort(), [`${LAUNCHD_LABEL}.plist`, `${LAUNCHD_LABEL}.tor.plist`]);
  assert.equal(up.notStarted, undefined, 'tor refused once, then started: nothing left down');
  assert.equal(sys.calls.filter((c) => c[0] === 'launchctl' && c[1] === 'bootstrap' && /\.tor\.plist$/.test(c[3])).length, 2, 'tor bootstrapped again after the refusal');
  assert.deepEqual(sys.calls.filter((c) => c[0] === '/usr/bin/codesign' && c[1] === '--force').map((c) => c.at(-1)).sort(),
    [join(v2, 'runtime/tor/libevent-2.1.7.dylib'), join(v2, 'runtime/tor/tor')], 'the new release\'s tor signed before it runs');

  const bad = await updateNode({ home, newRelease: broken, port, env, sh: sys.sh, nowMs: () => 0, waitMs: 8000, platform: 'darwin' });
  assert.deepEqual([bad.ok, bad.rolledBack, bad.restored], [false, true, true]);
  assert.equal(releaseOfPlist(readFileSync(seat, 'utf8')), v2, 'the agent names rc.13 again');
  assert.match(readFileSync(tor, 'utf8'), new RegExp(`${v2}/runtime/tor/tor`));
  assert.equal((await waitHealthy({ port, waitMs: 30000, everyMs: 300 })).identity, first.identity);
});

test('Windows: the launchers that run the old release move to the new one; stopping ends only that release\'s processes; a failed start is rolled back', async () => {
  const { windowsLauncher } = await import('../src/service.js');
  const { releaseOfLauncher } = await import('../src/update.js');
  const root = mkdtempSync(join(tmpdir(), 'arena-update-win-'));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const v1 = 'C:\\Users\\owner\\arena\\arena-node-0.1.0-rc.12-windows-x64', v2 = 'C:\\Users\\owner\\arena\\home\\releases\\arena-node-0.1.0-rc.13-windows-x64';
  writeFileSync(join(home, 'node.env'), 'ARENA_ROLES=verify\r\n');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 } }));
  writeFileSync(join(home, 'arena-node.cmd'), windowsLauncher({ node: `${v1}\\runtime\\node.exe`, release: v1, home, port: 8470 }));
  writeFileSync(join(home, 'arena-tor.cmd'), `@echo off\r\n"${v1}\\runtime\\tor\\tor.exe" "-f" "${home}\\tor\\torrc"\r\n`);
  writeFileSync(join(home, 'arena-lnd.cmd'), `@echo off\r\n"${home}\\lnd-bin\\lnd.exe"\r\n`);
  assert.equal(releaseOfLauncher(readFileSync(join(home, 'arena-node.cmd'), 'utf8')), v1);
  const calls = []; let up = true;
  const sh = async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, out: '', err: '' }; };
  // GET /identity answers the node's 32-byte key; down, a 502
  const fetcher = async () => (up ? { status: 200, arrayBuffer: async () => new Uint8Array(32).fill(0xab).buffer } : { status: 502, arrayBuffer: async () => new ArrayBuffer(0) });
  const r = await updateNode({ home, newRelease: v2, port: 8470, node: `${v2}\\runtime\\node.exe`, sh, fetcher, nowMs: () => 0, platform: 'win32', waitMs: 2000 });
  assert.equal(r.ok, true, r.why);
  assert.equal(releaseOfLauncher(readFileSync(join(home, 'arena-node.cmd'), 'utf8')), v2);
  assert.match(readFileSync(join(home, 'arena-tor.cmd'), 'utf8'), /rc\.13-windows-x64\\runtime\\tor\\tor\.exe/, 'tor moved');
  assert.match(readFileSync(join(home, 'arena-lnd.cmd'), 'utf8'), /lnd-bin\\lnd\.exe/, 'LND untouched');
  assert.deepEqual(r.moved.map((f) => f.split(/[\\/]/).pop()).sort(), ['arena-node.cmd', 'arena-tor.cmd']);
  assert.match(readFileSync(join(home, 'arena.conf'), 'utf8'), /\r\nroles=verify\r\n/, 'the settings moved into arena.conf, in CRLF');
  assert.match(readFileSync(join(home, 'arena-node.cmd'), 'utf8'), /src\\run\.js "[^"]+\\arena\.conf"/);
  const kill = calls.find((c) => c[0] === 'powershell' && /Stop-Process/.test(c.at(-1)));
  assert.ok(kill && kill.at(-1).includes("-like '*\\arena-node-0.1.0-rc.12-windows-x64\\*'") && kill.at(-1).includes(".Replace('/', '\\')"),
    'the processes of rc.12 are ended by its folder, whatever slashes their command line uses (2026-10-19: a node started with "/" survived)');
  assert.deepEqual(calls.filter((c) => c[0] === 'schtasks').map((c) => c.at(-1)).sort(), ['Arena node', 'Arena tor']);
  assert.equal(calls.filter((c) => c[0] === 'powershell' && /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/.test(c.at(-1))).length, 2, 'both started through WMI, outside the session that runs the update');
  // a release that does not come up: the rc.13 launchers put back
  up = false;
  const bad = await updateNode({ home, newRelease: 'C:\\broken', port: 8470, sh, fetcher, nowMs: () => 0, platform: 'win32', waitMs: 1500 });
  assert.deepEqual([bad.ok, bad.rolledBack], [false, true]);
  assert.equal(releaseOfLauncher(readFileSync(join(home, 'arena-node.cmd'), 'utf8')), v2);
  rmSync(root, { recursive: true, force: true });
});

test('node.env paths into an older release follow to the new one - from every older release; a path the new one lacks is kept (macOS node A at rc.16 still ran games and fedimintd from rc.12)', () => {
  const rel = '/h/home/releases/arena-node-0.1.0-rc.16-darwin-arm64';
  const has = new Set([`${rel}/packages/nextblock/plugin/nextblock`, `${rel}/runtime/custody/fedimintd`]);
  const text = ['ARENA_BIND=127.0.0.1',
    'ARENA_APPS=/h/arena-node-0.1.0-rc.12-darwin-arm64/packages/nextblock/plugin/nextblock',
    'ARENA_FEDIMINTD=/h/home/releases/arena-node-0.1.0-rc.14-darwin-arm64/runtime/custody/fedimintd',
    'ARENA_FEDIMINT_CLI=/h/arena-node-0.1.0-rc.12-darwin-arm64/runtime/custody/fedimint-cli',
    'ARENA_PLUGINS_DIR=/h/home/node.db.plugins', ''].join('\n');
  assert.deepEqual(envForRelease(text, rel, (p) => has.has(p)).split('\n'), ['ARENA_BIND=127.0.0.1',
    `ARENA_APPS=${rel}/packages/nextblock/plugin/nextblock`, `ARENA_FEDIMINTD=${rel}/runtime/custody/fedimintd`,
    'ARENA_FEDIMINT_CLI=/h/arena-node-0.1.0-rc.12-darwin-arm64/runtime/custody/fedimint-cli', 'ARENA_PLUGINS_DIR=/h/home/node.db.plugins', '']);
  const win = 'C:\\a\\releases\\arena-node-0.1.0-rc.16-windows-x64';
  assert.equal(envForRelease('ARENA_APPS=C:\\a\\arena-node-0.1.0-rc.14-windows-x64\\packages\\nextblock\r\nX=1\r\n', win, () => true),
    `ARENA_APPS=${win}\\packages\\nextblock\r\nX=1\r\n`, 'CRLF and backslashes on Windows');
  assert.equal(envForRelease(text, rel, () => true), envForRelease(envForRelease(text, rel, () => true), rel, () => true), 'a second update moves nothing more');
});

test('a node on a quick tunnel: the tunnel starts first, its new name goes into the settings, then the seat starts (macOS node A rc.16 -> rc.18 kept the dead name)', async (t) => {
  const { launchdPlist, LAUNCHD_LABEL } = await import('../src/service.js');
  const root = mkdtempSync(join(tmpdir(), 'arena-update-quick-'));
  const env = { HOME: join(root, 'user') };
  const agents = join(env.HOME, 'Library', 'LaunchAgents'); mkdirSync(agents, { recursive: true });
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const port = await freePort();
  const sys = fakeLaunchd();
  t.after(() => { sys.stopAll(); rmSync(root, { recursive: true, force: true }); });
  const v1 = releaseFrom(join(root, 'releases/arena-node-0.1.0-rc.16-darwin-arm64')), v2 = releaseFrom(join(root, 'releases/arena-node-0.1.0-rc.18-darwin-arm64'));
  const old = 'https://conventional-cube-iron-caused.trycloudflare.com', fresh = 'https://cult-turns-subscriptions-monitors.trycloudflare.com';
  writeFileSync(join(home, 'node.env'), `ARENA_BIND=127.0.0.1\nARENA_WSS_${port}=${old}\nARENA_GUARDIAN_ENDPOINT_${port}=${old.replace('https:', 'wss:')}/guardian\n`);
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 }, reach: { mode: 'quick', port, url: old } }));
  const seat = join(agents, `${LAUNCHD_LABEL}.plist`), tunnel = join(agents, `${LAUNCHD_LABEL}.tunnel.plist`);
  writeFileSync(seat, legacyPlist({ node: process.execPath, release: v1, home, port }));
  writeFileSync(tunnel, `<plist><dict><key>Label</key><string>${LAUNCHD_LABEL}.tunnel</string><key>ProgramArguments</key><array><string>${join(v1, 'runtime/cloudflared')}</string></array></dict></plist>\n`);
  // the gateway as an older install wrote it: the tunnel's host in --api-addr, no metrics port of its own
  const gateway = join(agents, `${LAUNCHD_LABEL}.gateway.plist`);
  writeFileSync(gateway, `<plist><dict><key>Label</key><string>${LAUNCHD_LABEL}.gateway</string><key>ProgramArguments</key><array><string>${join(v1, 'runtime/custody/gatewayd')}</string><string>--listen=127.0.0.1:8476</string><string>--api-addr=${old}/gateway/</string></array></dict></plist>\n`);
  await sys.sh('launchctl', ['bootstrap', 'gui/501', seat]);
  const first = await waitHealthy({ port, waitMs: 60000, everyMs: 300 });
  assert.equal(first.ok, true, first.why);

  const order = [];
  const quickUrl = async (o) => { order.push(['read the name', o.sinceMs > 0]); return fresh; };
  const at = sys.calls.length;
  const up = await updateNode({ home, newRelease: v2, port, env, sh: sys.sh, nowMs: () => 0, platform: 'darwin', quickUrl });
  assert.equal(up.ok, true, up.why);
  assert.equal(up.reach, fresh);
  const boots = sys.calls.slice(at).filter((c) => c[0] === 'launchctl' && c[1] === 'bootstrap').map((c) => c[3].split('/').pop());
  assert.deepEqual(boots.slice(0, 1), [`${LAUNCHD_LABEL}.tunnel.plist`], 'the tunnel first');
  assert.deepEqual(boots.slice(1).sort(), [`${LAUNCHD_LABEL}.gateway.plist`, `${LAUNCHD_LABEL}.plist`], 'the seat and the gateway after the settings changed');
  const gw = readFileSync(gateway, 'utf8');
  assert.ok(gw.includes(`--api-addr=${fresh}/gateway/`) && !gw.includes('conventional-cube'), `the gateway announces the tunnel's new name (Windows VM 0.1.0 -> 0.1.1 kept the old one): ${gw}`);
  assert.ok(gw.includes(`<string>--metrics-listen=127.0.0.1:8478</string>`) && gw.includes(join(v2, 'runtime/custody/gatewayd')), gw);
  assert.deepEqual(order, [['read the name', true]], 'the name logged after the tunnel started');
  const confNow = readFileSync(join(home, 'arena.conf'), 'utf8');
  assert.ok(!confNow.includes('conventional-cube') && confNow.includes(`public_url=${fresh}`) && confNow.includes('guardian_endpoint=wss://cult-turns-subscriptions-monitors.trycloudflare.com/guardian'), confNow);
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).reach.url, fresh);
  assert.equal(up.identity, first.identity);
});

test('a rollback puts the backup back even while Windows still holds a file: busy ones are tried again, one that never frees is named, the rest go back (rc.14 -> rc.20 in the Windows VM threw and started nothing)', async () => {
  const backup = { dir: 'B', files: ['node.db', 'node.db-wal', 'node.db-shm', 'node.env'] };
  const busy = (code) => Object.assign(new Error(`${code}: resource busy or locked`), { code });
  const copied = [], left = { 'node.db': 2, 'node.db-shm': 99 };
  const copy = (from, to) => { const f = from.split(/[\\/]/).pop(); if ((left[f] || 0) > 0) { left[f]--; throw busy(f === 'node.db' ? 'EBUSY' : 'EPERM'); } copied.push(f); };
  let pauses = 0;
  const r = await restoreNode('H', backup, { tries: 5, pause: async () => { pauses++; }, copy });
  assert.deepEqual(copied, ['node.db', 'node.db-wal', 'node.env'], 'node.db after two busy tries; the others too');
  assert.deepEqual([r.ok, r.failed], [false, ['node.db-shm: EPERM']]);
  assert.equal(pauses, 2 + 4, 'a pause between tries, none after the last');
  const other = await restoreNode('H', { dir: 'B', files: ['x'] }, { copy: () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }, pause: async () => { throw new Error('no retry'); } });
  assert.deepEqual(other.failed, ['x: ENOENT'], 'only a busy file is tried again');
});

test('a launcher left on an OLDER release moves too, and that release\'s processes end (Windows VM, 2026-10-19: custody stayed on rc.25)', async () => {
  const { windowsLauncher } = await import('../src/service.js');
  const root = mkdtempSync(join(tmpdir(), 'arena-update-older-'));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const rel = 'C:\\Users\\arena\\.arena-node\\releases';
  const rc25 = `${rel}\\arena-node-0.1.0-rc.25-windows-x64`, v1 = `${rel}\\arena-node-2026.1.0-windows-x64`, v2 = `${rel}\\arena-node-2026.1.1-windows-x64`;
  writeFileSync(join(home, 'arena.conf'), 'network=testnet4\r\nroles=verify\r\n');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 } }));
  writeFileSync(join(home, 'arena-node.cmd'), windowsLauncher({ node: `${v1}\\runtime\\node.exe`, release: v1, home, port: 8470 }));
  writeFileSync(join(home, 'arena-custody.cmd'), `@echo off\r\n"${rc25}\\runtime\\node.exe" "${rc25}\\packages\\arena-installer\\bin\\arena-custody.mjs"\r\n`);
  writeFileSync(join(home, 'arena-lnd.cmd'), `@echo off\r\n"${home}\\lnd-bin\\lnd.exe"\r\n`);
  const calls = [];
  const sh = async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, out: '', err: '' }; };
  const fetcher = async () => ({ status: 200, arrayBuffer: async () => new Uint8Array(32).fill(0xab).buffer });
  try {
    const r = await updateNode({ home, newRelease: v2, port: 8470, node: `${v2}\\runtime\\node.exe`, sh, fetcher, nowMs: () => 0, platform: 'win32', waitMs: 2000 });
    assert.equal(r.ok, true, r.why);
    const custody = readFileSync(join(home, 'arena-custody.cmd'), 'utf8');
    assert.match(custody, /2026\.1\.1-windows-x64\\runtime\\node\.exe/, 'custody moved to the new release');
    assert.doesNotMatch(custody, /rc\.25/);
    assert.match(readFileSync(join(home, 'arena-lnd.cmd'), 'utf8'), /lnd-bin\\lnd\.exe/, 'a launcher naming no release is untouched');
    assert.deepEqual(r.moved.map((f) => f.split(/[\\/]/).pop()).sort(), ['arena-custody.cmd', 'arena-node.cmd']);
    const kills = calls.filter((c) => c[0] === 'powershell' && /Stop-Process/.test(c.at(-1))).map((c) => c.at(-1));
    assert.ok(kills.some((k) => k.includes("'*\\arena-node-2026.1.0-windows-x64\\*'")), 'the release it updates from ends');
    assert.ok(kills.some((k) => k.includes("'*\\arena-node-0.1.0-rc.25-windows-x64\\*'")), 'and the older one custody still ran');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE NEW RELEASE MUST ANSWER AS ITSELF, AND NOTHING OF AN OLDER ONE MAY RUN (kanban #546, measured 2026-10-19 in the Windows VM: the old node
// kept running, answered GET /identity with the same key, and the update said ok; two node.exe of rc.25 ran through three updates)
test('Windows: the update counts only when /owner/version names the new release; the old one answering is rolled back by name; a leftover old process is ended, one that will not end is no update', async () => {
  const { windowsLauncher } = await import('../src/service.js');
  const { releaseOfLauncher, releaseIdOf } = await import('../src/update.js');
  const root = mkdtempSync(join(tmpdir(), 'arena-update-546-'));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const rel = join(root, 'releases');
  const v1 = join(rel, 'arena-node-2026.1.1-windows-x64'), v2 = join(rel, 'arena-node-2026.1.2-windows-x64');
  for (const [d, v, c] of [[v1, '2026.1.1', 'aa'.repeat(20)], [v2, '2026.1.2', 'bb'.repeat(20)]]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'VERSION'), `${v}\n`); writeFileSync(join(d, 'COMMIT'), `${c}\n`); }
  assert.deepEqual(releaseIdOf(v2), { version: '2026.1.2', commit: 'bb'.repeat(20) });
  const fresh = () => {
    writeFileSync(join(home, 'arena.conf'), 'network=testnet4\r\nroles=verify\r\n');
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 } }));
    writeFileSync(join(home, 'arena-node.cmd'), windowsLauncher({ node: `${v1}\\runtime\\node.exe`, release: v1, home, port: 8470 }));
  };
  // the node answering: its key always the same; its version the release `answering` names
  let answering = v2;
  const fetcher = async (url) => (String(url).endsWith('/owner/version')
    ? { status: 200, json: async () => ({ version: releaseIdOf(answering).version, commit: releaseIdOf(answering).commit }) }
    : { status: 200, arrayBuffer: async () => new Uint8Array(32).fill(0xab).buffer });
  // the process list: `listed` answers the leftovers query; Stop-Process -Id ends the pid unless `stubborn`
  let listed = [], stubborn = false;
  const sh = async (cmd, args) => {
    const script = args.at(-1);
    if (cmd === 'powershell' && /ConvertTo-Json/.test(script)) return { ok: true, out: JSON.stringify(listed), err: '' };
    if (cmd === 'powershell' && /Stop-Process -Id (\d+)/.test(script) && !stubborn) { const pid = Number(/Stop-Process -Id (\d+)/.exec(script)[1]); listed = listed.filter((x) => x.pid !== pid); }
    return { ok: true, out: '', err: '' };
  };
  const run = () => updateNode({ home, newRelease: v2, port: 8470, node: `${v2}\\runtime\\node.exe`, sh, fetcher, nowMs: () => 0, platform: 'win32', waitMs: 2500 });
  try {
    // 1. the new release answers with its version and commit, nothing old left: ok
    fresh();
    let r = await run();
    assert.equal(r.ok, true, r.why);
    assert.deepEqual(r.answered, { version: '2026.1.2', commit: 'bb'.repeat(20) });
    assert.equal(releaseOfLauncher(readFileSync(join(home, 'arena-node.cmd'), 'utf8')), v2);
    // 2. the OLD release still answers (same key, its own version): no update, rolled back, the reason named
    fresh(); answering = v1;
    r = await run();
    assert.deepEqual([r.ok, r.rolledBack], [false, true]);
    assert.match(r.why, /^the old release still answers \(2026\.1\.1\): the node answering runs 2026\.1\.1 \(aaaaaaaaaaaa\), not 2026\.1\.2 \(bbbbbbbbbbbb\)/);
    assert.equal(releaseOfLauncher(readFileSync(join(home, 'arena-node.cmd'), 'utf8')), v1, 'the old launcher put back');
    // 3. a process of the old release still runs after the start: ended and named, the update stands
    fresh(); answering = v2;
    listed = [{ pid: 4242, name: 'node.exe', commandLine: `${v1.replace(/\\/g, '/')}/runtime/node.exe custody` }];
    r = await run();
    assert.equal(r.ok, true, r.why);
    assert.deepEqual((r.endedAfterStop || []).map((x) => x.pid), [4242], 'found after the stop and ended');
    // 4. one that will not end: no update, named
    fresh(); stubborn = true;
    listed = [{ pid: 4343, name: 'fedimintd.exe', commandLine: `${v1}\\runtime\\fedimintd.exe` }];
    r = await run();
    assert.deepEqual([r.ok, r.rolledBack], [false, true]);
    assert.match(r.why, /^processes of an older release would not end: fedimintd\.exe 4343/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// THE UPDATER COMES BACK FROM THE NEW RELEASE (kanban #546, measured 2026-10-20 04:30Z in the Windows VM: after T1 by hand the updater's child
// still ran 2026.1.1): the stop and the leftover check exclude only this update's own process; after the update the task runs again when
// no auto update runs, and not while one does (an auto update exits 75 and its loop starts the new release's)
test('Windows: an old updater beside a manual update is ended with its release, and the task "Arena updater" is run again after the arenanode command names the new release', async () => {
  const { windowsLauncher } = await import('../src/service.js');
  const root = mkdtempSync(join(tmpdir(), 'arena-update-546u-'));
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const rel = join(root, 'releases'), v1 = join(rel, 'arena-node-2026.1.1-windows-x64'), v2 = join(rel, 'arena-node-2026.1.1.901-windows-x64');
  for (const d of [v1, v2]) mkdirSync(d, { recursive: true });
  const fresh = () => {
    writeFileSync(join(home, 'arena.conf'), 'network=testnet4\r\nroles=verify\r\n');
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 } }));
    writeFileSync(join(home, 'arena-node.cmd'), windowsLauncher({ node: `${v1}\\runtime\\node.exe`, release: v1, home, port: 8470 }));
    writeFileSync(join(home, 'arena-updater.cmd'), `@echo off\r\n:again\r\ncall "${home}\\bin\\arenanode.cmd" "auto-update" >> "${home}\\updater.log" 2>&1\r\nif %errorlevel%==75 goto again\r\n`);
  };
  let updaters = 0; const calls = [];
  const sh = async (cmd, args) => { calls.push([cmd, ...args]); const script = args.at(-1);
    if (cmd === 'powershell' && /auto-update\*'.*\.Count/.test(script)) return { ok: true, out: String(updaters), err: '' };
    return { ok: true, out: '', err: '' }; };
  const fetcher = async () => ({ status: 200, arrayBuffer: async () => new Uint8Array(32).fill(0xab).buffer });
  // a release no launcher names any more, whose updater still runs (measured 2026-10-20 04:41Z: .901 -> .902 left 2026.1.1's updater)
  const v0 = join(rel, 'arena-node-2026.1.0-windows-x64'); mkdirSync(v0, { recursive: true });
  try {
    fresh();
    const r = await updateNode({ home, newRelease: v2, port: 8470, node: `${v2}\\runtime\\node.exe`, sh, fetcher, nowMs: () => 0, platform: 'win32', waitMs: 2000 });
    assert.equal(r.ok, true, r.why);
    const asked = calls.filter((c) => c[0] === 'powershell' && /ConvertTo-Json/.test(c.at(-1))).map((c) => c.at(-1));
    assert.ok(asked.length >= 2 && asked.every((a) => a.includes("'*\\arena-node-2026.1.0-windows-x64\\*'") && a.includes("'*\\arena-node-2026.1.1-windows-x64\\*'") && !a.includes("2026.1.1.901-windows-x64\\*'")),
      'every release beside the new one is looked for, after the stop and after the start - one no launcher names too');
    const kill = calls.find((c) => c[0] === 'powershell' && /Stop-Process/.test(c.at(-1)) && c.at(-1).includes('2026.1.1-windows-x64'));
    assert.ok(kill && kill.at(-1).includes(`$_.ProcessId -ne ${process.pid}`) && !kill.at(-1).includes('notlike'), 'only its own process is spared: an old updater ends with its release');
    assert.deepEqual(r.updaterBack, { ok: true, started: 'task', task: 'Arena updater' });
    const runAt = calls.findIndex((c) => c[0] === 'schtasks' && c[1] === '/run'), cmdAt = calls.findIndex((c) => c.some((a) => /arenanode/.test(String(a)) && /setx|Path/i.test(String(a))));
    assert.ok(runAt > 0, 'the task runs again');
    // an auto update runs (this update's own process among them): no second loop
    fresh(); updaters = 1; calls.length = 0;
    const r2 = await updateNode({ home, newRelease: v2, port: 8470, node: `${v2}\\runtime\\node.exe`, sh, fetcher, nowMs: () => 0, platform: 'win32', waitMs: 2000 });
    // (v2 is running already after the first: put the launcher back to v1 above, so this is an update again)
    assert.equal(r2.ok, true, r2.why);
    assert.deepEqual(r2.updaterBack, { ok: true, running: true });
    assert.equal(calls.filter((c) => c[0] === 'schtasks' && c[1] === '/run').length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// kanban #575: a release carries only its apps' pins; the update fetches them before it stops anything
test('the new release\'s apps are fetched first: one that cannot be fetched leaves the node running, nothing stopped', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arena-update-apps-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: join(root, 'config'), USER: 'test' };
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const v1 = join(root, 'releases/arena-node-2026.1.1-linux-x64'), v2 = join(root, 'releases/arena-node-2026.1.2-linux-x64');
  writeFileSync(join(home, 'node.env'), 'ARENA_BIND=127.0.0.1\n');
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4' }));
  mkdirSync(unitDir(env), { recursive: true });
  writeFileSync(join(unitDir(env), UNIT), legacySeatUnit({ node: process.execPath, release: v1, home, port: 1 }));
  const calls = [], asked = [];
  const sh = async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { ok: true, out: '', err: '' }; };
  const r = await updateNode({ home, newRelease: v2, port: 1, env, sh, nowMs: () => 0, platform: 'linux',
    fetchApps: async (o) => { asked.push(o.release); return { ok: false, why: 'plugin/x.js answered 404 (from github.com/a tester/arena-app-up-or-down)' }; } });
  assert.deepEqual(r, { ok: false, why: 'the new release\'s apps: plugin/x.js answered 404 (from github.com/a tester/arena-app-up-or-down)' });
  assert.deepEqual(asked, [v2], 'the new release\'s apps, into the new release');
  assert.ok(!calls.some((c) => / stop /.test(c)), 'nothing stopped');
});
