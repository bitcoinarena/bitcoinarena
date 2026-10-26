// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// BITCOINARENA, NOT ARENANODE (kanban #688, 2026-10-26: "Rename the directories and binaries to bitcoinarena, not arenanode everywhere in
// the installer, the packages etc."): a new node lives in ~/.bitcoinarena and is run with bitcoinarena; a node installed by 2026.1.9.7 or
// older is found in ~/.arena-node and stays there, its update to this release leaves every file of it in place, its arenanode keeps
// working (a small script that runs bitcoinarena), and the first run of this release's command writes bitcoinarena for it. The app helpers
// call the new name and fall back to the old.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, symlinkSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { homeDefault, HOME_DIR, LEGACY_HOME_DIR } from '../src/instance.js';
import { updateNode } from '../src/update.js';
import { seatUnit, unitDir, UNIT } from '../src/service.js';
import { SHIM_MARK } from '../src/launchers.js';

const REPO = resolve(fileURLToPath(import.meta.url), '../../../..');
const scratch = (p) => mkdtempSync(join(tmpdir(), p));

test('the node\'s home by default: ~/.bitcoinarena for a new node, ~/.arena-node where a node from before 2026.1.9.8 lives', () => {
  assert.deepEqual([HOME_DIR, LEGACY_HOME_DIR], ['.bitcoinarena', '.arena-node']);
  const at = (files) => homeDefault({}, { home: '/h', exists: (f) => files.includes(f) });
  assert.equal(at([]), '/h/.bitcoinarena', 'nothing installed: the new name');
  assert.equal(at(['/h/.arena-node/state.json']), '/h/.arena-node', 'a 1.9.7 node, its wizard state');
  assert.equal(at(['/h/.arena-node/arena.conf']), '/h/.arena-node', 'a 1.9.7 node, its settings');
  assert.equal(at(['/h/.arena-node/arena.conf', '/h/.bitcoinarena/state.json']), '/h/.bitcoinarena', 'both: the new one');
  assert.equal(at(['/h/.arena-node/releases']), '/h/.bitcoinarena', 'a folder that holds no node is not one');
  assert.equal(homeDefault({ ARENA_HOME: '/x/node' }, { home: '/h', exists: () => true }), '/x/node', 'ARENA_HOME names it outright');
});

test('a 1.9.7 node found by this release\'s code: its home, its instance from its arena.conf, the command names with it', () => {
  const H = scratch('rename688-home-');
  try {
    mkdirSync(join(H, '.arena-node'));
    writeFileSync(join(H, '.arena-node', 'arena.conf'), 'network=testnet4\ninstance=q\nport_offset=300\n');
    const probe = `const s = await import(${JSON.stringify(join(REPO, 'packages/arena-installer/src/state.js'))}); const l = await import(${JSON.stringify(join(REPO, 'packages/arena-installer/src/launchers.js'))}); const i = await import(${JSON.stringify(join(REPO, 'packages/arena-installer/src/instance.js'))});
      console.log(JSON.stringify({ home: s.defaultHome(), name: l.commandName(), old: l.legacyCommandName(), instance: i.INSTANCE, offset: i.PORT_OFFSET }));`;
    const run = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe], { env: { PATH: process.env.PATH, HOME: H }, encoding: 'utf8' }));
    assert.deepEqual(run(), { home: join(H, '.arena-node'), name: 'bitcoinarena-q', old: 'arenanode-q', instance: 'q', offset: 300 });
    rmSync(join(H, '.arena-node'), { recursive: true });
    assert.deepEqual(run(), { home: join(H, '.bitcoinarena'), name: 'bitcoinarena', old: 'arenanode', instance: '', offset: 0 }, 'a new machine: the new folder');
  } finally { rmSync(H, { recursive: true, force: true }); }
});

/** A release tree of this checkout (its working files, not HEAD): the installer and the node's sources, their dependencies linked, a VERSION. */
function releaseHere(dir, version) {
  for (const p of ['packages/arena-installer/src', 'packages/arena-installer/bin', 'packages/arena-installer/package.json', 'packages/arena-node/src', 'packages/arena-node/package.json',
    'packages/arena-protocol', 'packages/arena-sdk', 'packages/arena-client/src']) if (existsSync(join(REPO, p))) cpSync(join(REPO, p), join(dir, p), { recursive: true, dereference: false, filter: (f) => !/node_modules/.test(f.slice(REPO.length)) });
  symlinkSync(realpathSync(join(REPO, 'packages/arena-node/node_modules')), join(dir, 'packages/arena-node/node_modules'));
  symlinkSync(realpathSync(join(REPO, 'packages/arena-node/node_modules')), join(dir, 'packages/arena-installer/node_modules'));
  writeFileSync(join(dir, 'VERSION'), `${version}\n`);
  return dir;
}

test('after the update by 2026.1.9.7: its arenanode runs this release, writes bitcoinarena and becomes the small script that runs it (kanban #688)', () => {
  const root = scratch('rename688-run-');
  try {
    const H = join(root, 'user'), home = join(H, '.arena-node');
    const rel = releaseHere(join(home, 'releases', 'bitcoin-arena-node-2026.1.9.8-linux-x64'), '2026.1.9.8');
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'arena.conf'), 'network=testnet4\nport=8470\n');
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', release: { path: rel } }));
    // <home>/bin/arenanode as the update code of 2026.1.9.7 writes it: the full command, naming the new release's bin/arenanode.mjs
    writeFileSync(join(home, 'bin', 'arenanode'), `#!/bin/sh\n# The arenanode command, written by the installer: arenanode status, arenanode restart lnd, arenanode doctor, arenanode help\nexec '${process.execPath}' '${rel}/packages/arena-installer/bin/arenanode.mjs' --home '${home}' --name arenanode "$@"\n`, { mode: 0o755 });
    const env = { PATH: process.env.PATH, HOME: H, ARENA_LATEST_URL: '' };
    const first = spawnSync(join(home, 'bin', 'arenanode'), ['help'], { env, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^arenanode: your Bitcoin Arena node on this machine$/m, 'this run still says the name it was called by');
    // written: bitcoinarena for this release, arenanode the small script, both on the PATH
    assert.match(readFileSync(join(home, 'bin', 'bitcoinarena'), 'utf8'), new RegExp(`'${rel}/packages/arena-installer/bin/bitcoinarena\\.mjs' --home '${home}' --name bitcoinarena "\\$@"`));
    assert.ok(readFileSync(join(home, 'bin', 'arenanode'), 'utf8').includes(SHIM_MARK));
    assert.equal(realpathSync(join(H, '.local', 'bin', 'bitcoinarena')), realpathSync(join(home, 'bin', 'bitcoinarena')));
    assert.equal(realpathSync(join(H, '.local', 'bin', 'arenanode')), realpathSync(join(home, 'bin', 'arenanode')));
    // from now on both names are the new command
    for (const name of ['arenanode', 'bitcoinarena']) {
      const r = spawnSync(join(H, '.local', 'bin', name), ['help'], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^bitcoinarena: your Bitcoin Arena node on this machine$/m, name);
    }
    const v = spawnSync(join(home, 'bin', 'arenanode'), ['version'], { env, encoding: 'utf8' });
    assert.equal(v.stdout.split(/\s/)[0], '2026.1.9.8');
    assert.deepEqual(readdirSync(home).sort(), ['arena.conf', 'bin', 'releases', 'state.json'], 'the node\'s folder: nothing moved, nothing new beside bin');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const digest = (dir) => {
  const out = {};
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out[p.slice(dir.length + 1)] = createHash('sha256').update(readFileSync(p)).digest('hex'); } };
  walk(dir);
  return out;
};

test('a 1.9.7 node updated by this release\'s update.js: its home stays ~/.arena-node with every file, its units keep their names, both commands are written (kanban #688)', async () => {
  const root = scratch('rename688-update-');
  try {
    const H = join(root, 'user'), home = join(H, '.arena-node');
    const env = { HOME: H, XDG_CONFIG_HOME: join(H, '.config'), PATH: '/usr/bin' };
    const v1 = join(home, 'releases', 'bitcoin-arena-node-2026.1.9.7-linux-x64'), v2 = join(home, 'releases', 'bitcoin-arena-node-2026.1.9.8-linux-x64');
    mkdirSync(join(v1, 'packages', 'arena-node'), { recursive: true }); mkdirSync(join(v2, 'packages', 'arena-node'), { recursive: true });
    // the node as 2026.1.9.7 leaves it: settings, state, seed, database, owner, LND, the guardian's data, its command and its units
    writeFileSync(join(home, 'arena.conf'), `network=testnet4\nport=8470\ndatabase=${home}/node.db\npublic_url=https://arena-node-3fa9c1.me.workers.dev\napps=${v1}/apps/nextblock.js\n`);
    writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', release: { path: v1 }, reach: { mode: 'workers', workerName: 'arena-node-3fa9c1' } }));
    for (const [f, t] of [['seed.hex', 'ab'.repeat(32)], ['node.db', 'db'], ['node.db.owner.json', '{"pubkey":"cd"}'], ['lnd/data/chain/bitcoin/testnet4/wallet.db', 'w'],
      ['lnd/lnd.conf', 'listen=127.0.0.1:9735\n'], ['fedimint/guardian/database', 'g'], ['bitcoind.auth', 'u:p']]) { mkdirSync(join(home, f, '..'), { recursive: true }); writeFileSync(join(home, f), t); }
    mkdirSync(join(v2, 'apps'), { recursive: true }); writeFileSync(join(v2, 'apps', 'nextblock.js'), '');
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'arenanode'), `#!/bin/sh\nexec '${v1}/runtime/node' '${v1}/packages/arena-installer/bin/arenanode.mjs' --home '${home}' --name arenanode "$@"\n`, { mode: 0o755 });
    const units = unitDir(env);
    mkdirSync(units, { recursive: true });
    writeFileSync(join(units, UNIT), seatUnit({ node: `${v1}/runtime/node`, release: v1, home, port: 8470 }));
    const updater = `[Service]\nExecStart=${home}/bin/arenanode auto-update\nRestart=on-failure\n`;
    writeFileSync(join(units, 'arena-updater.service'), updater);
    const before = digest(home);

    const calls = [];
    const sh = async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, out: '', err: '' }; };
    const fetcher = async () => new Response(Buffer.alloc(32, 7), { status: 200 });
    const r = await updateNode({ home, newRelease: v2, port: 8470, node: `${v2}/runtime/node`, env, sh, fetcher, platform: 'linux', nowMs: () => 0,
      fetchApps: async () => ({ ok: true }), refreshGames: null, lndKit: { installLnd: async () => ({ ok: true }) }, waitMs: 2000 });
    assert.equal(r.ok, true, r.why);
    assert.deepEqual([r.from, r.to], [v1, v2]);

    // the home: where it was, every file of the node as it was (the settings' release paths follow the new release, as always)
    const after = digest(home);
    for (const f of Object.keys(before).filter((x) => !['arena.conf', 'state.json', 'bin/arenanode'].includes(x))) assert.equal(after[f], before[f], `${f} kept`);
    assert.ok(!existsSync(join(H, '.bitcoinarena')), 'no new folder beside it');
    const conf = readFileSync(join(home, 'arena.conf'), 'utf8');
    assert.match(conf, /^public_url=https:\/\/arena-node-3fa9c1\.me\.workers\.dev$/m, 'the workers.dev address is an address, not a release folder');
    assert.match(conf, new RegExp(`^apps=${v2}/apps/nextblock\\.js$`, 'm'));
    // the services: the same names, the seat moved, the updater untouched - it runs <home>/bin/arenanode, which runs bitcoinarena now
    assert.deepEqual(readdirSync(units).sort(), ['arena-node.service', 'arena-updater.service']);
    assert.match(readFileSync(join(units, UNIT), 'utf8'), new RegExp(`WorkingDirectory=${v2}/packages/arena-node`));
    assert.equal(readFileSync(join(units, 'arena-updater.service'), 'utf8'), updater);
    // the commands
    assert.deepEqual([r.command.name, r.command.legacy.name], ['bitcoinarena', 'arenanode']);
    assert.match(readFileSync(join(home, 'bin', 'bitcoinarena'), 'utf8'), new RegExp(`exec '${v2}/runtime/node' '${v2}/packages/arena-installer/bin/bitcoinarena\\.mjs' --home '${home}' --name bitcoinarena`));
    assert.equal(readFileSync(join(home, 'bin', 'arenanode'), 'utf8'), `#!/bin/sh\n# arenanode: the old name of this node's command, ${SHIM_MARK}\nexec '${home}/bin/bitcoinarena' "$@"\n`);
    assert.equal(realpathSync(join(H, '.local', 'bin', 'arenanode')), realpathSync(join(home, 'bin', 'arenanode')));
    assert.ok(calls.some((c) => c.join(' ') === 'systemctl --user stop arena-node.service') && calls.some((c) => c.join(' ') === 'systemctl --user start arena-node.service'), 'the seat restarted under its own name');
    // and a node backed up before it moved
    assert.ok(existsSync(join(r.backup, 'seed.hex')) && existsSync(join(r.backup, 'node.db')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A fake command that says how it was called. */
const fakeCommand = (file, word) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, `#!/bin/sh\necho "${word} $*"\n`, { mode: 0o755 }); };

test('the macOS app\'s helper: bitcoinarena in ~/.bitcoinarena, else the 1.9.7 node in ~/.arena-node and its arenanode until it has bitcoinarena', () => {
  const helper = join(REPO, 'tools/release/pkg/macos/bitcoin-arena-app');
  const H = scratch('rename688-mac-');
  try {
    const run = (...a) => spawnSync('bash', [helper, ...a], { env: { PATH: process.env.PATH, HOME: H }, encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(H, 'x'), '');
    mkdirSync(join(H, '.arena-node')); writeFileSync(join(H, '.arena-node', 'arena.conf'), 'network=testnet4\ninstance=4\n');
    fakeCommand(join(H, '.arena-node', 'bin', 'arenanode-4'), 'OLD');
    assert.equal(run('node'), 'OLD state', 'a 1.9.7 node: its own command');
    fakeCommand(join(H, '.arena-node', 'bin', 'bitcoinarena-4'), 'NEW');
    assert.equal(run('status'), 'NEW status', 'updated: the new name');
    mkdirSync(join(H, '.bitcoinarena')); writeFileSync(join(H, '.bitcoinarena', 'arena.conf'), 'network=testnet4\n');
    fakeCommand(join(H, '.bitcoinarena', 'bin', 'bitcoinarena'), 'HOME2');
    assert.equal(run('doctor'), 'HOME2 doctor', 'a node in the new folder is the one');
    assert.match(spawnSync('bash', [helper, 'nonsense'], { env: { PATH: process.env.PATH, HOME: H }, encoding: 'utf8' }).stderr, /^usage: bitcoin-arena-app /);
    // its folder: ~/Library/ArenaNode kept where an older app made it, else the new one
    const t = readFileSync(helper, 'utf8');
    assert.match(t, /^BASE="\$HOME\/Library\/BitcoinArena"\n\[ -d "\$BASE" \] \|\| \[ ! -d "\$HOME\/Library\/ArenaNode" \] \|\| BASE="\$HOME\/Library\/ArenaNode"$/m);
    assert.match(readFileSync(join(REPO, 'tools/release/pkg/macos/App.swift'), 'utf8'), /\+ "\/bitcoin-arena-app"/, 'the app asks the helper by its new name');
    assert.match(readFileSync(join(REPO, 'tools/release/package-mac.sh'), 'utf8'), /install -m 0755 "\$HERE\/pkg\/macos\/bitcoin-arena-app" "\$APP\/Contents\/Resources\/bitcoin-arena-app"/);
  } finally { rmSync(H, { recursive: true, force: true }); }
});

test('the Linux setup: the installed node\'s status from bitcoinarena, else arenanode; it needs no release for that', () => {
  const setup = join(REPO, 'tools/release/pkg/linux/bitcoin-arena-node-setup');
  const H = scratch('rename688-linux-');
  try {
    const run = () => spawnSync('sh', [setup], { env: { PATH: process.env.PATH, HOME: H }, encoding: 'utf8' });
    mkdirSync(join(H, '.arena-node')); writeFileSync(join(H, '.arena-node', 'arena.conf'), 'network=testnet4\n');
    fakeCommand(join(H, '.arena-node', 'bin', 'arenanode'), 'OLD');
    let r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^OLD status\n\nManage it with: arenanode help\n/);
    fakeCommand(join(H, '.arena-node', 'bin', 'bitcoinarena'), 'NEW');
    r = run();
    assert.match(r.stdout, /^NEW status\n\nManage it with: bitcoinarena help\n/);
    assert.match(readFileSync(join(REPO, 'tools/release/package.sh'), 'utf8'), /install -m 0755 "\$HERE\/pkg\/linux\/bitcoin-arena-node-setup" "\$P\/usr\/bin\/bitcoin-arena-node-setup"/);
  } finally { rmSync(H, { recursive: true, force: true }); }
});

test('Windows: the window calls bitcoinarena.cmd, else arenanode.cmd, in .bitcoinarena else .arena-node; the setup keeps an older setup\'s folder', () => {
  const ps = readFileSync(join(REPO, 'tools/release/pkg/windows/BitcoinArena.ps1'), 'utf8');
  assert.match(ps, /\$nodeHome = Join-Path \$env:USERPROFILE '\.bitcoinarena'\r?\n\$oldHome = Join-Path \$env:USERPROFILE '\.arena-node'\r?\nif \(-not \(Test-Node \$nodeHome\) -and \(Test-Node \$oldHome\)\) \{ \$nodeHome = \$oldHome \}/);
  assert.match(ps, /\$command = Join-Path \$nodeHome \("bin\\bitcoinarena" \+ \$inst \+ "\.cmd"\)\r?\n\$oldCommand = Join-Path \$nodeHome \("bin\\arenanode" \+ \$inst \+ "\.cmd"\)\r?\nif \(-not \(Test-Path \$command\) -and \(Test-Path \$oldCommand\)\) \{ \$command = \$oldCommand \}/);
  const nsi = readFileSync(join(REPO, 'tools/release/pkg/windows/bitcoin-arena.nsi'), 'utf8');
  assert.match(nsi, /^InstallDir "\$LOCALAPPDATA\\BitcoinArena"$/m);
  assert.match(nsi, /IfFileExists "\$LOCALAPPDATA\\ArenaNode\\\*\.\*" 0 \+2\n\s+StrCpy \$INSTDIR "\$LOCALAPPDATA\\ArenaNode"/);
  assert.match(nsi, /File "BitcoinArena\.ps1"\n\s+Delete "\$INSTDIR\\ArenaNode\.ps1"/);
  assert.ok(!/-File "\$INSTDIR\\ArenaNode\.ps1"/.test(nsi), 'every shortcut opens the new script');
  const pkg = readFileSync(join(REPO, 'tools/release/package.sh'), 'utf8');
  assert.match(pkg, /cp "\$HERE\/pkg\/windows\/BitcoinArena\.ps1" "\$HERE\/pkg\/windows\/bitcoin-arena\.nsi"/);
  assert.match(pkg, /-DOUT="\$OUT\/\$EXE" bitcoin-arena\.nsi\)/);
});
